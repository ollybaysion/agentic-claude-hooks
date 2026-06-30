# 이벤트 관측 수집기 서버 (collector) — 상세 설계

> Agent(Claude Code)의 모든 hook 이벤트를 받아 저장하고 실시간으로 보여주는 **관측 대시보드 서버(collector)**. hook이 HTTP POST로 보내는 이벤트를 받는 쪽이다.

---

## 기술 스택

| 영역 | 선택 | 이유 |
|---|---|---|
| 런타임 | Node.js 단일 파일 `server.mjs`, `node:http`, npm 의존성 0 | hook 플러그인과 같은 Node ESM, `node server.mjs` 하나로 실행 |
| 주 저장소 | SQLite(WAL) — 기본 `node:sqlite`(빌트인), `better-sqlite3` 폴백 | 인덱스 조회·재시작 복구가 JSONL보다 훨씬 빠르고 외부 의존성도 없음 |
| 콜드 저장 | JSONL.gz 아카이브 + 스필 | retention으로 밀려난 이벤트의 보관용 / DB 쓰기 실패 시 안전하게 받아두는 곳 |
| 라이브 | SSE (Server-Sent Events) | 한 방향이라 WebSocket이 필요 없고, `curl -N`로 바로 tail, 브라우저 자동 재연결 |
| 대시보드 | 의존성 0 인라인 HTML (`GET /`) | 빌드 단계 없음, collector와 same-origin |

---

## 1. 아키텍처 한눈에

```
                         ┌──────────────────────── collector (node server.mjs, 1 프로세스) ────────────────────────┐
  PreToolUse  ┐          │                                                                                          │
  PostToolUse ┤          │   POST /events                                                                           │
  Stop ───────┤  HTTP    │   ┌──────────────────────────────────────────────────────────────────────────────┐     │
  Notification┼─POST────▶│   │ 1.Host허용목록  2.bearer(상수시간)  3.본문 capped-stream(413/408)             │     │
  …(9 events) ┘  (127.   │   │ 4.JSON.parse + 관대한 normalize  5.dedup(seq 안 씀)  6.seq 부여  7.ACK 202 ──┼──┐  │
                 0.0.1만) │   └──────────────────────────────────────────────────────────────────────────────┘  │  │
                         │                              (응답 끝난 뒤, 응답 경로 밖)                              ▼  │
                         │   ┌───────── post-ack 단일 단계 ─────────┐                                                │
                         │   │ redact ONCE(기본 ON) ─┬─▶ writer ───┼─▶ SQLite(WAL)  events.db  [seq=PK, 시크릿]   │
                         │   │                       └─▶ broadcaster┼─▶ ring(byte-bounded) ─▶ SSE 구독자들          │
                         │   └──────────────────────────────────────┘                                              │
                         │                                                                                          │
  브라우저 대시보드 ◀────│── GET /stream (SSE, Last-Event-ID 재개)   GET /events?filter (keyset)   GET /health     │
  curl -N            ◀───│── GET / (의존성 0 HTML, escape+CSP)        GET /events/:id (full row)                    │
                         └──────────────────────────────────────────────────────────────────────────────────────┘
                              데이터 디렉터리: $XDG_STATE_HOME/claude-observability  (없으면 ~/.claude/observability)
                              dir 0700 / files 0600 / 플러그인 루트 밖
```

**POST /events가 지키는 규칙**: 응답을 돌려주기 전까지 하는 일은 본문 읽기 · 가벼운 검증 · seq 부여 · 202 응답, 이 넷뿐이다. 저장·redact·스트리밍은 모두 응답을 보낸 뒤(`res.end()` 이후)에 한다. 그래서 디스크가 느리거나 잠겨 있어도 훅이 기다리는 일은 없다.

---

## 2. 핵심 설계 결정

여러 부분에 걸쳐 일관되게 지켜야 하는 결정들이다. 코드와 스키마가 모두 여기에 맞춰져 있다.

| 항목 | 결정 |
|---|---|
| **redaction** | redact를 응답 뒤 한 곳에서 한 번만 한다(기본 켜짐, `OBS_REDACT=0`으로 끔). 같은 redact 결과를 저장(writer)과 스트림(broadcaster) 양쪽에 똑같이 넘겨, `/stream`과 `/events/:id`가 같은 이벤트에 같은 내용을 보이게 한다. |
| **idempotency** | 메모리 TTL 게이트로 흔한 중복을 빨리 걸러내고, 저장소의 `UNIQUE(tool_use_id, hook_event_type)`로 재시작을 넘어선 중복까지 막는다. `INSERT … ON CONFLICT DO NOTHING`. |
| **엔드포인트** | 6개: `POST /events`, `GET /events`, `GET /events/:id`, `GET /stream`, `GET /health`, `GET /`. 그 외는 404/405. |
| **durability 기본값** | 기본은 저장 전에 응답(1초 미만 손실 가능, 문서화함). `OBS_DURABLE=1`이면 WAL에 쓰고 나서 응답한다. |

---

## 3. 데이터 디렉터리 · 설정 · 토큰 부트스트랩

### 3.1 디렉터리 레이아웃 (코드와 상태 분리)

```
~/.claude/observability-server/      # 코드 (git 체크아웃 가능; 자유 교체)
└── server.mjs

$XDG_STATE_HOME/claude-observability  (없으면 ~/.claude/observability)   # 상태, mode 0700
├── server.pid     # {pid,host,port,startedAt,version}  ※토큰은 여기 두지 않음   0600
├── config.json    # {token}  (첫 기동 시 자동 생성)                              0600
├── events.db (+ -wal, -shm)   # SQLite WAL
├── archive/events-YYYY-MM-DD.jsonl.gz   # retention 콜드 아카이브  0600
└── spill.jsonl.gz # DB 쓰기 실패 시 fail-open 스필(회전 있음)  0600
```

> **`${CLAUDE_PLUGIN_ROOT}` 아래에는 절대 두지 않는다**(AGENTS.md 규칙 — 플러그인은 업데이트할 때마다 경로가 바뀐다). 시크릿이 모여 사는 곳이라 디렉터리는 0700, 파일은 0600으로 잠그고, 프로세스 첫 줄에서 `umask(0o077)`.

### 3.2 설정 (환경 변수)

모든 설정은 `OBS_` 접두사 환경 변수로 준다. 적용 우선순위는 **환경 변수 > config.json > 기본값**이라, 아무것도 건드리지 않으면 아래 기본값으로 그냥 돈다. 바꿀 값만 launcher(셸 환경 파일 / systemd `Environment=` / tmux 창)에서 `export` 하면 된다.

| env | 기본값 | 의미 |
|---|---|---|
| `OBS_HOST` | `127.0.0.1` | **localhost만**. `assertLoopback()`이 비-loopback이면 기동 거부(`OBS_ALLOW_NONLOOPBACK=1`로만 해제). |
| `OBS_PORT` | `4090` | 충돌을 피하려고 잡은 높은 포트(OTLP 4317/4318 회피). 정수인지 검증 필수. |
| `OBS_DATA_DIR` | 위 경로 | 상태 디렉터리. |
| `OBS_TOKEN` | 자동생성 → `config.json` | bearer 시크릿. 빈 값이면 인증 끔(= localhost는 믿는다). |
| `OBS_REDACT` | `1`(ON) | 응답 뒤 redaction. `0`이면 끔(디버깅 편함). |
| `OBS_DURABLE` | `0` | `1`이면 WAL에 쓰고 나서 응답. |
| `OBS_MAX_BODY` | `5*1024*1024` | 본문 크기 상한(5 MiB; 큰 파일 write의 tool_input 고려). |
| `OBS_SHUTDOWN_GRACE_MS` | `3000` | 종료할 때 마무리 작업에 주는 시간. |

### 3.3 토큰 부트스트랩 (보내는 쪽이 토큰을 어떻게 아는가)

bearer를 켜면 **send_event 훅도 같은 시크릿**을 헤더에 실어야 한다. 둘이 만나는 지점:

- 토큰은 `config.json`(0600)에 **한 번** 만들어 보관한다. `server.pid`에는 **넣지 않는다**(`status`가 pidfile을 통째로 출력하면 토큰이 새므로 → 토큰은 config.json에만).
- 훅은 기동할 때 `config.json`을 읽어 `Authorization: Bearer <token>`을 붙인다. 못 읽으면 토큰 없이 POST(서버가 인증을 켜뒀으면 401이지만 훅은 어차피 exit 0).
- 단일 사용자 박스에서는 **인증을 기본으로 끄는 게** 합리적이다(아래 §8 위협모델). 토큰은 "공유 박스로 옮길 때" 켜는 스위치다.

---

## 4. API 명세

### 4.1 엔드포인트 목록

| Method | Path | 용도 | 성공 | 에러 |
|---|---|---|---|---|
| POST | `/events` | 이벤트 받기(핫패스). 봉투 1개/콜. | **202** `{status,seq,id}` + `X-Obs-Seq`; **200** `{status:"duplicate"}` | 400/408/413/401/421 |
| GET | `/events` | 이력 조회(keyset). | **200** `{count,events,next_cursor}` | 401 |
| GET | `/events/:id` | 이벤트 하나 전체 행. | **200** row | 401/404 |
| GET | `/stream` | 라이브 SSE. `Last-Event-ID`/`?since`로 재개. | **200** `text/event-stream` | 401 |
| GET | `/health` | 살아있는지 + 카운터. 단일 인스턴스 프로브도 사용. | **200** `{status,uptime,seq,sse,counters}` | — |
| GET | `/` | 의존성 0 HTML 대시보드(escape+CSP). | **200** `text/html` | — |
| * | 그 외 | — | — | 404/405 |

`GET /events` 파라미터: `source_app`, `session_id`, `hook_event_type`(등치 필터); `since=<seq>`(exclusive 커서); `limit`(기본 200, 최대 1000); `order=asc|desc`.

**`POST /events` 요청 본문(봉투)** — send_event hook이 만들어 보내는 형식:

```jsonc
{ "source_app": "...", "session_id": "...", "hook_event_type": "PreToolUse",
  "payload": { /* raw hook json */ }, "timestamp": 1700000000000,
  // 있을 때만 최상위로 승격되는 필드:
  "tool_name": "...", "tool_use_id": "...", "error": "...",
  "agent_id": "...", "agent_type": "...", "source": "...", "reason": "..." }
```

반드시 있어야 하는 건 `hook_event_type`(문자열)뿐이고, 나머지는 관대하게 처리한다(없으면 `"unknown"`으로 채우거나 생략).

### 4.2 POST /events 처리 순서

1. **Host 허용목록** — `Host` 헤더가 `127.0.0.1`/`localhost`/`::1`일 때만 받고, 아니면 `421`. (브라우저 DNS-rebind 방어 — localhost 바인드만으로는 같은 박스의 브라우저를 못 막는다.)
2. **bearer 검사(선택)** — `OBS_TOKEN`이 설정돼 있으면 sha256 + `timingSafeEqual`로 상수시간 비교, 틀리면 401. **본문을 읽기 전에** 한다.
3. **본문 읽기(크기 제한)** — `Content-Length`가 `MAX_BODY`보다 크면 한 바이트도 안 읽고 413, 읽는 도중 넘으면 즉시 중단, 본문이 너무 느리면 2초에 408.
4. **시각은 서버가 찍는다** — `received_at = Date.now()`. 클라이언트가 보낸 `timestamp`는 `client_ts`로 따로 보관할 뿐(시계 차이 분석용), **순서를 정하는 기준으로는 절대 쓰지 않는다**(세션마다 시계가 어긋나니까).
5. **중복 거르기(seq 부여 전)** — `${tool_use_id}|${hook_event_type}`를 키로 메모리 TTL Map(30초/5000개)에서 확인. 이미 본 거면 `200 duplicate`로 응답하고 **seq를 쓰지 않는다**.
6. **seq 부여** — `rec.seq = ++SEQ`(부팅 시 `MAX(seq)+1`로 시작). 이 번호가 이벤트의 유일한 식별자다.
7. **202 즉시 응답** — 응답 경로에서 하는 일은 seq 부여와 202 쓰기뿐. 그다음 `setImmediate`로 응답 뒤 단계(redact → 저장/스트림)를 돌린다.

> **참조 구현** — 핸들러(`readBody`/`handleEvents`/`ingestPostAck`)는 분량이 커서 별도 파일 `agent-dashboard-ingest-handler.mjs`로 뺐다. (구현 시 함정은 `agent-dashboard-implementation-notes.md` 참고.)

덧붙여 `normalize()`는 관대하게 동작한다 — 객체이고 `hook_event_type`이 문자열이면 받아들이고, 빠진 필드는 `"unknown"`으로 채우며, 모르는 이벤트 타입도 `unknown_event`로 저장한다(새 이벤트가 생겨도 조용히 버리지 않으려고).

---

## 5. 저장소

### 5.1 왜 SQLite(WAL)를 주 저장소로 쓰나

모든 이벤트가 **하나의 프로세스, 하나의 이벤트 루프**를 지난다. 그래서 "여러 곳에서 동시에 append할 때 줄이 섞이나" 같은 걱정은 대부분 사라진다(쓰기가 프로세스 안에서 이미 한 줄로 직렬화되니까). 진짜 차이는 **읽기**에서 난다 — "세션 X의 이벤트", "최근 1시간의 PostToolUse", "tool_use_id로 Pre/Post 짝 맞추기", "재시작 후 최근 1000개로 화면 복구" 같은 질의를, JSONL은 매번 파일 전체를 훑고 거꾸로 읽어야 하지만 SQLite는 인덱스로 콕 집어 가져오고 `ORDER BY seq DESC LIMIT N` 한 줄이면 된다.

측정해보니(이 박스) 5000행을 한 트랜잭션(`BEGIN IMMEDIATE`)으로 약 23ms(행당 ~4.5µs)에 동기로 처리했다. 에이전트는 HTTP로 이미 떨어져 있으니(훅이 exit 0), 동기 SQLite여도 "에이전트를 막지 않는다"는 원칙은 깨지지 않는다.

### 5.2 스키마 (seq를 명시적 PK로)

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;     -- 앱 크래시엔 안전, 커밋당 fsync 없음. OBS_DURABLE=1이면 FULL.
PRAGMA busy_timeout = 5000;
PRAGMA auto_vacuum  = INCREMENTAL; -- ★반드시 "새 DB"에서 테이블 생성 전에. 기존 DB는 1회 VACUUM로 마이그레이션.
PRAGMA user_version = 1;           -- ★스키마 마이그레이션 훅("구멍" 봉합)

CREATE TABLE IF NOT EXISTS events (
  seq             INTEGER PRIMARY KEY,   -- ★ingest가 부여한 seq를 그대로 PK로(autoincrement rowid 아님)
  id              TEXT NOT NULL,         -- uuid (보조 식별자)
  source_app      TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  hook_event_type TEXT NOT NULL,
  tool_name TEXT, tool_use_id TEXT, agent_id TEXT, agent_type TEXT,
  source TEXT, reason TEXT, error TEXT,
  unknown_event   INTEGER NOT NULL DEFAULT 0,
  client_ts       INTEGER,
  received_at     INTEGER NOT NULL,
  payload         TEXT NOT NULL          -- redacted JSON 텍스트; json_extract()로 질의
);
CREATE INDEX IF NOT EXISTS idx_session   ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_type_time ON events(hook_event_type, received_at);
CREATE INDEX IF NOT EXISTS idx_app_time  ON events(source_app, received_at);
-- ★진짜 멱등(모순 #6): TTL 게이트를 빠져나온/재시작 후 도착한 중복도 막음
CREATE UNIQUE INDEX IF NOT EXISTS idx_dedup ON events(tool_use_id, hook_event_type)
  WHERE tool_use_id IS NOT NULL;
```

부팅할 때 `SELECT MAX(seq) FROM events`로 메모리의 `SEQ`를 이어받는다 → 재시작해도 seq가 계속 증가하고, SSE `Last-Event-ID`와 질의 커서가 어긋나지 않는다.

### 5.3 쓰기 경로

```js
// 인메모리 큐 → 타이머/크기 트리거로 배치 flush. 응답 경로 밖.
const q = []; let qBytes = 0, timer = null;
const Q_MAX_BYTES = 64 * 1024 * 1024;   // ★count가 아니라 BYTE로 바운드(메모리 상한)
const BATCH_ROWS  = 256;

function enqueueWrite(rec) {
  const line = JSON.stringify(rec);
  q.push(rec); qBytes += line.length;
  while (qBytes > Q_MAX_BYTES) { const d = q.shift(); qBytes -= JSON.stringify(d).length; stats.dropped_queue++; }
  if (q.length >= BATCH_ROWS) flush();
  else if (!timer) timer = setTimeout(flush, 50).unref();
}

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!q.length) return;
  const batch = q.splice(0, BATCH_ROWS);   // ★전체가 아니라 BATCH_ROWS만(거대 문자열/OOM 방지)
  for (const x of batch) qBytes -= JSON.stringify(x).length;
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const r of batch) {
      try { insert.run(toRow(r)); }        // ★row 단위 try: 독성 행 1개가 255개를 롤백시키지 않음
      catch (e) { stats.bad_row++; logSafe("bad row", e); }   // ON CONFLICT DO NOTHING이 dedup도 처리
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    spill(batch, e);                       // fail-open: DB 실패해도 안 죽고 안 잃음
  }
  if (q.length) { if (!timer) timer = setTimeout(flush, 50).unref(); }  // 남은 큐 계속 비움
}
```

`INSERT … ON CONFLICT(tool_use_id,hook_event_type) DO NOTHING`으로 UNIQUE 충돌(= 중복)을 조용히 무시한다.

### 5.4 retention

```js
// 1시간마다. ★전체를 try/catch로 감싸 throw가 setInterval 콜백을 빠져나가 프로세스를 죽이지 않게.
function runRetention() {
  try {
    flush();
    archiveAndDeletePaged("received_at < ?", [Date.now() - MAX_AGE_MS]);     // 나이
    archiveAndDeletePaged("seq <= (SELECT MAX(seq)-? FROM events)", [MAX_ROWS]); // 행 수
    // ★size-cap: dbBytes()는 page_count*page_size인데 DELETE만으론 page_count가 안 줄어든다
    //   (freelist로 갈 뿐). 그래서 슬라이스 삭제 → incremental_vacuum → 재측정을 루프 안에서.
    let guard = 50;
    while (usedBytes() > MAX_BYTES && guard-- > 0) {
      const lo = one("SELECT MIN(seq) m FROM events"), hi = one("SELECT MAX(seq) m FROM events");
      if (lo == null || hi == null || hi <= lo) break;
      archiveAndDeletePaged("seq <= ?", [lo + Math.max(1, Math.floor((hi - lo) * 0.05))]);
      db.exec("PRAGMA incremental_vacuum;");   // ★루프 안에서 실제로 페이지 반환 후 재측정
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (e) { logSafe("retention", e); }
}
// usedBytes = (page_count - freelist_count) * page_size  ← 파일 크기 아니라 "사용 중" 페이지
function usedBytes() {
  return (one("PRAGMA page_count") - one("PRAGMA freelist_count")) * one("PRAGMA page_size");
}
// archiveAndDeletePaged: 한 번에 전부 SELECT→join(거대 문자열 RangeError/OOM) 금지.
//   id 페이지(LIMIT N)로 잘라 gzip 스트림에 append → 그 슬라이스 DELETE → 반복.
```

스필 파일도 **회전시키고 크기 상한을 둔다**(DB 실패가 오래 가면 스필이 끝없이 커져 디스크를 채우는 걸 막으려고).

---

## 6. 라이브 스트리밍 (SSE pub/sub)

### 6.1 왜 WebSocket이 아니라 SSE

흐름이 한 방향(서버 → 대시보드/curl)이라 SSE가 딱 맞는다. 거저 얻는 것: EventSource의 **자동 재연결 + `Last-Event-ID`**(ring 재생 커서와 그대로 1:1로 맞물린다), **`curl -N localhost:4090/stream`** 한 줄로 되는 라이브 tail, 그리고 평범한 HTTP라 ingest와 **똑같은 loopback + bearer** 보호가 그대로 적용된다. `ws` 같은 의존성도 필요 없다.

### 6.2 구성

```
broadcast(redactedRec)
  ├─ seq 기반 record를 ring에 push (★COUNT + BYTE 동시 바운드)
  └─ for sub of subscribers: if sub.matches(rec) sub.enqueue(chunk)
        └─ Subscriber: 바운드된 outbound 큐(drop-oldest + _dropped 마커), drain-aware pump
heartbeat 20s: ': keepalive\n\n' → 반-열림 소켓 감지 + 프록시 idle 방어
```

설계 포인트:
- **ring도 BYTE로 제한** — 슬롯 1000개에 각 5MB면 메모리가 5GB까지 부푼다. `ringBytes` 예산(예: 64–128MB)을 두고, **이벤트당 크기 상한**도 둔다(ring/stream에 들어가는 payload는 잘라서 표시만, 전체는 DB에 보관).
- **`/stream`에도 Host + bearer** — 여기로도 시크릿이 흘러나가므로 ingest와 같은 검사를 `add(sub)` **전에** 건다.
- **부팅 시 seq를 `MAX(seq)`로 이어받기** — 안 그러면 재시작 후 `Last-Event-ID`가 0으로 돌아가, 예전 커서로 재연결한 클라이언트가 아무것도 못 받는다.
- **`Last-Event-ID`를 현재 seq로 클램프** — 위조됐거나 너무 큰 커서가 "영원히 아무것도 안 받는" 상태가 되지 않게.
- **구독자별 write를 try/catch로 감싸기** — 죽은 클라이언트 하나가 전체 내보내기 루프를 깨고 뒤 구독자들을 굶기지 않게. **backpressure**: `res.write()`가 `false`면 drain까지 큐에 쌓고, 큐가 넘치면 **가장 오래된 것부터 버린다**(라이브 tail에는 최신이 중요) + `_dropped` 표시.
- **heartbeat write도 try/catch** — 반쯤 죽은 소켓에서 타이머 콜백이 throw해 프로세스가 죽는 걸 막는다.

```js
class Subscriber {                  // 한 SSE 연결 = 바운드 큐 1개
  enqueue(chunk) {
    if (this.closed) return;
    this.queue.push(chunk); this.bytes += chunk.length;
    while (this.queue.length > MAX_ITEMS || this.bytes > MAX_BYTES) {  // drop-oldest
      this.bytes -= this.queue.shift().length; this.dropped++;
    }
    this._pump();
  }
  _pump() {
    if (this.writing || this.closed) return; this.writing = true;
    if (this.dropped > 0) { /* _dropped 마커를 큐 앞에 */ }
    while (this.queue.length) {
      const c = this.queue.shift(); this.bytes -= c.length;
      let ok; try { ok = this.res.write(c); } catch { return this.close(); }  // ★try
      if (!ok) { this.res.once("drain", () => { this.writing = false; this._pump(); }); return; }
    }
    this.writing = false;
  }
}
```

SSE 프레이밍: `id:`는 **진짜 데이터 이벤트에만** 붙인다(control/heartbeat에는 `id:`를 안 붙여 `Last-Event-ID`를 건드리지 않게). `event: <hook_event_type>`, `data: <json>`(줄바꿈은 `data:` 여러 줄로 나눠 안전하게). control 프레임은 `_ready`/`_gap`/`_dropped`/`_bye`로(언더스코어를 붙여 hook 타입 이름과 안 겹치게).

---

## 7. 신뢰성 · 프로세스 가드 (서버가 박스를 안 죽이게)

모든 부분에 공통으로 깔리는 **'실패해도 멈추지 않기(fail-open)'의 토대**다. 이 가드가 없으면 핸들러 어디서 throw가 나든 프로세스가 통째로 죽는다.

```js
// main() 첫 줄들
process.umask(0o077);
// ★프로세스 레벨 가드: 핸들러 어디서 throw해도 프로세스가 안 죽음. 단, "런타임 에러만" 관용.
process.on("uncaughtException", (e) => logSafe("uncaught", e));
process.on("unhandledRejection", (e) => logSafe("unhandled", e));

// ★EADDRINUSE를 uncaughtException 가드가 삼키면 "안 듣는 좀비"가 됨 → 별도로 명시 처리.
server.on("error", async (err) => {
  if (err.code === "EADDRINUSE") {
    if (await probeHealthIsOurs())  process.exit(0);   // 이미 우리 서버 → 깨끗한 no-op
    logSafe("port held by foreign proc"); process.exit(3);
  }
  logSafe("listen", err); process.exit(1);             // ★기동 실패는 non-zero(systemd 재시작)
});

server.listen(PORT, HOST, () => { /* config.json 토큰 생성/로드, pidfile 쓰기(try/catch) */ });
```

저장소 consumer를 비동기 버전으로 쓸 경우의 자가복구 규칙:
- 배치를 만드는 코드(`splice` + `map(JSON.stringify)` + `join`)를 **try 안에** 넣고, 행마다 stringify를 **개별 try**로 감싼다(BigInt처럼 직렬화 안 되는 값 하나가 consumer를 영영 죽이지 않게).
- 큐를 **BYTE 기준으로 제한**하고, 배치 크기를 **고정값으로 제한**한다(`join` 결과가 Node 최대 문자열 ~536MB를 넘겨 RangeError 나는 걸 방지).
- rotate가 실패하면 `fh`를 null로 비우고, 쓰기 직전에 **필요하면 다시 연다**(닫힌 fd를 계속 들고 있다가 영영 막히는 것 방지).

graceful shutdown(SIGINT/SIGTERM/SIGHUP — SIGHUP은 tmux 창을 닫을 때 온다):
1. `closing` 가드(시그널이 중복으로 와도 한 번만). 2. 강제 종료 타이머(`GRACE_MS`, `.unref()`). 3. `server.close()`(새 연결 안 받고 처리 중인 요청은 기다림). 4. 모든 SSE에 `_bye`를 쓰고 **`res.destroy()`로 직접 닫는다**(keep-alive 반납에 의존하지 않음 — `closeIdleConnections()`는 같은 틱에 그 소켓을 못 잡아 close가 grace까지 멈추기 때문). 5. `flush()` + `wal_checkpoint(TRUNCATE)` + `db.close()` + pidfile 삭제. 6. **시그널로 끝나면 exit 0, 오류로 끝나면 non-zero**(systemd `Restart=on-failure`가 크래시 후 실제로 다시 띄우도록).

`logSafe()`는 거부했거나 너무 큰 페이로드를 **그대로 찍지 않는다**(redaction이 지운 시크릿을 운영 로그가 되살리는 걸 막으려고) — 코드·카운터·이벤트 타입만 남긴다.

---

## 8. 보안 (시크릿이 평문으로 들어오는 서비스)

### 위협모델 (우선순위)
단일 사용자 Linux 박스, tmux 환경. 수집기는 **모든 hook 이벤트의 조회 가능한 사본**을 시크릿째 들고 있다.
1. **로그가 곧 시크릿 저장소가 되는 것**(at-rest, 가장 값나가는 표적) → ingest 시 redaction(기본 켜짐) + 0600/0700 + `umask(0o077)`.
2. **박스 밖에서 닿는 것** → `127.0.0.1`만 바인드, 비-loopback이면 기동 거부, 선택적 bearer(상수시간 비교).
3. **브라우저를 통한 우회(DNS-rebind)** → loopback `Host`만 허용, 아니면 421. (localhost 바인드만으로는 같은 박스의 브라우저를 못 막는다 — 위조한 Host로 127.0.0.1에 닿으면 시크릿을 빼낼 수 있다.)

### redaction (응답 뒤에 한 번)
- **값의 생김새로 찾기**(AWS AKIA/ASIA, GCP AIza, GitHub ghp_, Slack xox, OpenAI/Anthropic `sk-`/`sk-ant-`, JWT, Bearer, PEM 블록, 인라인 `KEY=secret`) + **키 이름으로 찾기**.
- 키 매칭은 **끝(`$`)에 고정하지 말고 키 어디에 있든** 잡는다(`secret_value`/`password_hash`/`access_key_id`/`authorization` 같은 키도 잡으려고). 키가 걸리면 **그 아래 객체·배열 전체를 통째로 가린다**(중첩 객체/배열 속 평문 시크릿까지).
- 깊이 12까지만, 1MB 넘는 문자열은 건너뜀(ReDoS·메모리 보호), 원본은 그대로 두고 새 객체 반환, `hits`는 `/health`로 노출.
- **정보가 지워지므로 끌 수 있게 했다**(`OBS_REDACT=0`). redaction은 **보안 경계가 아니라** 한 겹 더 두는 방어다(진짜 경계는 loopback + 0600). 마커가 시크릿의 *종류*는 남겨서 원인 추적은 가능.
- redaction은 메인 루프에서 동기로 봉투를 통째 복제하므로, 5MB짜리 payload면 그동안 다른 POST의 응답이 밀린다. **이벤트당 작업량을 제한**하거나 worker로 빼서, 거대한 payload 하나가 루프를 독차지하지 못하게 한다.

### auth (상수시간 + anti-rebind)
```js
const EXPECT = TOKEN ? sha256(TOKEN) : null;
export function authed(req) {
  if (!EXPECT) return true;                       // 토큰 없으면 localhost-trust
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  const t = m ? m[1] : (req.headers["x-obs-token"] || "");
  return !!t && timingSafeEqual(sha256(t), EXPECT);   // 32바이트 고정 → 길이 누출/throw 없음
}
export function hostOk(req) {
  const h = (req.headers.host || "").split(":")[0].toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}
```

### 대시보드 XSS (아무도 안 챙기던 구멍)
대시보드는 payload 필드를 화면에 그리는데, payload는 **공격자가 영향을 줄 수 있다**(파일 내용·프롬프트·tool_input에 `<script>`/`onerror=`가 들어갈 수 있음). 그래서:
- 화면에 그리는 값은 **전부 HTML escape**, 엄격한 **CSP**(`default-src 'none'; script-src 'self'; connect-src 'self'`), `Access-Control-Allow-Origin`은 **절대 내보내지 않는다**(same-origin만).
- 브라우저 EventSource는 커스텀 헤더를 못 보내므로, 대시보드를 **수집기에서 same-origin으로** 서빙한다(loopback이라 토큰 없이; 켤 거면 httpOnly 쿠키나 1회용 `?token=`을 쓰고 로그엔 안 남긴다).

---

## 9. 런타임 · 기동 (tmux 박스에서 살려두기)

단일 인스턴스 보장: **듣고 있는 소켓 자체가 잠금** 역할을 한다. `EADDRINUSE`가 나면 `/health`를 찔러봐서 — 우리 서버면 exit 0(두 번째 `node server.mjs`는 그냥 조용히 빠진다), 남의 프로세스면 exit 3. pidfile은 **잠금이 아니라 위치 안내용**이다(진실은 포트를 찔러봐서 확인).

살려두는 방법 셋 — **(c) 레이지 + (a) tmux 창**을 기본으로, **(b) systemd**는 한 단계 위:
- **(c) SessionStart 레이지 스타트 훅**: 포트가 닫혀 있으면 `spawn(detached + unref)`로 띄운다 → 그 세션이 죽어도 서버는 살아남는다. "항상 떠 있음"을 보장. (훅이 `openSync(log)`보다 먼저 **데이터 디렉터리를 mkdir** 해야 한다 — 없으면 ENOENT를 삼키고 영영 안 뜬다.)
- **(a) `obs` tmux 창**: restore 스크립트에 멱등 블록 하나 추가. 단, (c)가 먼저 포트를 잡으면 이 창은 `EADDRINUSE`로 그냥 빠져 빈 프롬프트만 남으니, 창에서는 서버를 또 띄우지 말고 `tail -f server.log`를 돌린다.
- **(b) `systemd --user`**: `Restart=on-failure` + `loginctl enable-linger renoir`(이 박스는 Linger=no라, 안 켜면 로그아웃 때 멈춘다). 로그아웃·재부팅 후에도 무인으로 살려둘 때.

`status`/`stop` 동작: `status`는 **토큰을 절대 출력하지 않는다**. `stop`은 pidfile의 pid로 곧장 SIGTERM 하지 말고 **`/health`로 우리 서버가 맞는지 확인한 뒤** 죽인다(PID가 재사용돼 엉뚱한 프로세스를 죽이는 것 방지).

레이지 스타트 훅은 AGENTS.md 계약을 따른다: `core/obs-lazy-start/`에 자리잡고, `lib/hook-io.mjs` 스타일로, 항상 exit 0(관측은 best-effort라 세션을 절대 막지 않는다), `hooks/hooks.json`의 `SessionStart`에 한 줄.

---

## 10. 빌드 순서 (단계별)

> 각 단계는 그 자체로 돌리고 테스트할 수 있다. "읽기 전용 / 안 막는" 것부터 깔고 하나씩 더한다.

0. **뼈대 + 라이프사이클 기반** — `127.0.0.1` 바인드, 설정 로더(환경변수 > config.json > 기본값), 데이터 디렉터리 0700 생성 + 권한 확인, `GET /health`, EADDRINUSE 가드(`/health` 프로브), `status`/`stop` CLI. 비-loopback 바인드를 거부하는지 확인.
1. **에이전트를 안 막는 받기 코어** — `POST /events`의 크기 제한 본문 읽기(413/408), 관대한 normalize, `received_at` + `seq` 부여, **202 즉시 응답**, BYTE 제한 메모리 큐(가장 오래된 것부터 버림). 아직 DB 없음 — 훅이 절대 안 막히는지부터 확인.
2. **주 저장소** — `openBackend()`로 SQLite WAL(`node:sqlite` 기본), `seq` PK + 인덱스 + `UNIQUE(tool_use_id, event)`, 행 단위 try 배치 writer, `user_version` 마이그레이션, 페이지 단위 retention(나이/행수/크기 + `usedBytes()` 루프), 부팅 시 `MAX(seq)` 이어받기.
3. **보안·일관성 다지기** — redaction을 응답 뒤 한 곳으로 모으기(같은 결과를 writer + broadcaster에), 상수시간 bearer + Host 허용목록, 0600 권한, 토큰 부트스트랩 파일, 시크릿 안 새는 운영 로그.
4. **라이브 스트리밍** — `GET /stream` SSE(응답 뒤 redact된 경로에서), Broadcaster + 구독자별 BYTE 제한 큐(가장 오래된 것부터 버림, `_dropped`), BYTE 제한 ring + 이벤트당 상한, `Last-Event-ID` 재개(seq 이어받기), heartbeat.
5. **조회 API + 대시보드** — keyset `GET /events`, `GET /events/:id`, escape + CSP HTML 대시보드(`/stream` 연결, 느슨한 CORS 금지).
6. **운영·승격** — SessionStart 레이지 훅, `obs` tmux 창, systemd 유닛 + enable-linger, `restart`, **`purge`/일시정지 스위치**(시크릿 일괄 삭제), 워치독 여부 결정, retention 수치를 실제 디스크 예산에 맞추기.

---

## 11. 위험과 미해결 질문

**가장 큰 위험**
- **시크릿 노출이 가장 크다**: payload가 `events.db`·gz 아카이브·spill에 평문으로 남고, `/events/:id`는 그대로 내주고, 대시보드는 화면에 그린다. redaction은 정규식이라 완벽하지 않다(base64 덩어리·접두사 없는 40자 AWS secret 키·커스텀 토큰을 놓침). **진짜 경계는 loopback 바인드 + 0600/0700이다.** 데이터 디렉터리 전체를 민감 정보로 취급하고, redact할지 그냥 둘지를 받기/저장/스트림/조회 전반에 걸쳐 **한 번에** 정해야 한다(이 설계는 "응답 뒤 한 번 redact, 양쪽 동일"로 정함).
- **식별자가 갈라지는 문제**: 받기 seq·저장 PK·SSE Last-Event-ID·조회 커서를 **하나의 seq**로 모으지(부팅 시 `MAX(seq)` 이어받기) 않으면 재시작 후 재생·페이징이 어긋난다. → 이 설계에서 해결.
- **작지만 실재하는 손실 구간**: 저장 전에 응답 + 50ms/256행 배치라 `kill -9` 시 1초 미만의 이벤트가 사라진다. fail-open 전제에선 허용하되 **문서화**하고 `OBS_DURABLE=1`을 제공.
- **`node:sqlite`는 Node 24에서 아직 실험 단계**(경고를 세 기동 경로 모두에서 `--disable-warning=ExperimentalWarning`로 끔). `openBackend()` 어댑터 + Node 버전 고정 + `better-sqlite3` 폴백으로 완화. `auto_vacuum=INCREMENTAL`은 새 DB에서만 적용된다.
- **기동·단일 인스턴스가 깨지기 쉬움**: `/health`로 이름을 통일해 오인을 막고, tmux 5창이 동시에 SessionStart를 쏘는 경쟁(4개는 무해하게 빠짐), systemd Linger=no 주의.
- **backpressure 없을 때 메모리 증가**: 폭주하는 서브에이전트가 writer보다 빨리 POST하면 → 메모리 큐를 BYTE로 제한하고 가장 오래된 것부터 버려 OOM을 막는다.

**미해결 질문 (사용자 결정 필요)**
- 기본 포트 4090 괜찮은가? 인증은 기본 끔(localhost 신뢰) vs 토큰 강제?
- retention 수치(7일 / 50만 행 / 1GB)를 실제 디스크 예산에 맞출까? 콜드 아카이브도 일정 기간 뒤 지울까(예: 90일)?
- 시크릿이 0600 뒤에 평문으로 사는 걸 허용? 아니면 필드 redaction을 넘어 **저장 자체를 암호화**(age/libsodium)?
- 본문이 너무 클 때: 하드하게 413 vs `truncated:true`로 잘라서 저장?
- redaction 기본값 ON(안전) vs OFF(디버깅 편함) — "관측·디버깅이 목적"이라는 점과 부딪힌다.
- `_gap`을 필터별로 따져서 보낼까(거짓 양성 제거) vs 보수적으로 동작하고 문서화?

---

## 부록 A. 보내는 쪽(send_event)이 맞춰야 하는 계약

받는 쪽이 보내는 쪽에 요구하는 것(보내는 쪽을 다시 설계하진 않고, 이것만 지키면 된다):
- POST 대상: `http://127.0.0.1:4090/events`(또는 `config.json`이 가리키는 host/port).
- `OBS_TOKEN`이 켜져 있으면 `Authorization: Bearer <config.json의 token>`을 붙인다.
- `Host` 헤더는 `127.0.0.1`(기본값 그대로면 OK, 커스텀 호스트명이면 421).
- 봉투 형식은 §4.1 참고. `hook_event_type`(문자열)만 반드시 필요하고 나머지는 관대하게 처리된다.
- 항상 exit 0, 5초 타임아웃, 연결 오류는 삼킨다(서버가 꺼져 있어도 에이전트는 안 막힘 — loopback ECONNREFUSED는 ~7ms).

## 부록 B. 구현 시 주의사항

검증에서 잡은 치명 버그와 수정은 설계가 아니라 구현 디테일이라 별도 문서로 분리했다 → `agent-dashboard-implementation-notes.md`.
---

*코드 조각은 참조 구현이며, 0→6단계로 만들 때 각 단계마다 `node --check`와 합성 이벤트로 로컬 테스트하길 권한다.*
