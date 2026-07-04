# 대시보드 분석 기능 (analysis) — 설계

> collector(stage 0~6, v0.6.0) 위에 얹는 **읽기 전용 분석 레이어**. 새 수집은 없다 —
> 이미 쌓이는 이벤트로 집계 SQL + UI만 추가한다. 핫패스(`POST /events`)는 한 줄도 안 건드린다.

관련 문서: 수집기 본체는 `agent-dashboard-collector-design.md`, 구현 함정은
`agent-dashboard-implementation-notes.md`.

---

## 0. 전제 — 데이터는 이미 충분하다

| 분석 | 근거 데이터 (이미 저장 중) |
| --- | --- |
| 툴 호출별 소요시간 | `tool_use_id`로 PreToolUse↔PostToolUse 짝. `idx_dedup UNIQUE(tool_use_id, hook_event_type)`이 조인 양쪽을 커버 |
| 턴(turn) 단위 분석 | 세션 내 `UserPromptSubmit → Stop` 구간 |
| 세션 롤업 | `session_id`, `source_app`, `received_at` + 이벤트 타입 카운트 |
| 에러 | `error` 컬럼 (PostToolUse의 tool_response.error가 승격돼 있음) |
| 서브에이전트 | `agent_id`, `agent_type`, SubagentStop |
| 컨텍스트 압박 | PreCompact 빈도 |

지켜야 하는 기존 원칙: 의존성 0 · 집계 실패는 fail-open(ingest에 영향 없음) ·
집계 쿼리는 **`payload` 컬럼을 SELECT하지 않는다**(가장 큰 컬럼; guards 탭만 예외, §6).

---

## 1. 분석이 답할 질문

1. 어제/오늘 어떤 세션이 뭘 했나? (프로젝트별 세션, 턴 수, 툴 호출, 에러)
2. 어떤 툴이 느린가/자주 실패하나? (p50/p95, 에러율)
3. 지금 떠 있는 세션들은 각자 뭘 하는 중인가? (fleet view — tmux claude 5창)
4. guard(git/bash/tdd)가 뭘 얼마나 막았나? 오탐은 없나? (stage 9)
5. Post 없는 Pre가 얼마나 되나? (= 훅 블록/사용자 거부/크래시)
6. 세션이 컨텍스트 압박(PreCompact)을 얼마나 받나?

## 2. 기능 목록 (우선순위)

### Tier 1 — 범용 분석 (stage 7~8)

- 세션 목록/요약, 툴 통계(빈도·레이턴시·에러율·고아 Pre), 활동 추이(시간대별 버킷), 세션 타임라인 드릴다운(턴 단위), fleet view.

### Tier 2 — claude-hooks 고유 (stage 9)

- GuardDecision 이벤트: guard가 deny할 때 수집기로 emit → 블록률/최다 블록 명령/리포별 분포. guard 튜닝의 피드백 루프.

### Tier 3 — 보류 (stage 10, 별도 결정)

- 토큰/비용: hook payload의 `transcript_path`로 transcript JSONL 파싱. 포맷 실증 연구는
  완료(usage 컨텍스트 계산식, compact_boundary, isSidechain 함정 — 메모리
  `claude-code-transcript-format` 참고). 수집기가 파일시스템을 읽기 시작하는 결정이라 보류.
  하게 되면 **읽기 전용 + fail-open**, isSidechain 제외 규칙 준수.
- 에러 스파이크 알림, 주간 다이제스트.

---

## 3. 데이터 모델 (stage 7)

### 3.1 v_tool_calls 뷰

```sql
PRAGMA user_version = 2;   -- 뷰 추가 마이그레이션

CREATE VIEW IF NOT EXISTS v_tool_calls AS
SELECT
  pre.tool_use_id                        AS tool_use_id,
  pre.session_id                         AS session_id,
  pre.source_app                         AS source_app,
  pre.tool_name                          AS tool_name,
  pre.received_at                        AS started_at,
  post.received_at                       AS ended_at,          -- NULL = 미완(고아 후보)
  post.received_at - pre.received_at     AS duration_ms,
  post.error                             AS error
FROM events pre
LEFT JOIN events post
  ON post.tool_use_id = pre.tool_use_id AND post.hook_event_type = 'PostToolUse'
WHERE pre.hook_event_type = 'PreToolUse' AND pre.tool_use_id IS NOT NULL;
```

- **고아(orphan) 판정은 쿼리 쪽에서**: `ended_at IS NULL AND started_at < now - 10분`.
  방금 시작한 호출(아직 실행 중)을 고아로 세지 않기 위한 임계값이다. 고아 = 훅 deny,
  사용자 거부, 세션 크래시 중 하나 — 이벤트만으로는 셋을 구분 못 한다(stage 9의
  GuardDecision이 "훅 deny" 몫을 분리해준다).
- 뷰는 저장 공간을 안 쓰고, `idx_dedup`(partial unique)이 양쪽 lookup을 커버한다.
  50만 행(retention 상한)에서 window 필터 걸린 집계는 수십 ms — 캐시는 두지 않는다(필요해지면 그때).

### 3.2 파생 정의

- **턴(turn)**: 세션 내 `UserPromptSubmit`부터 다음 `Stop`까지. 서버는 개수만 세고
  (`SUM(hook_event_type='UserPromptSubmit')`), 구간 나누기는 드릴다운 UI가 클라이언트에서 한다(§5.3).
- **활성 세션**: `SessionEnd` 없음 + 마지막 이벤트가 10분 이내.
- **세션 롤업** (참조 SQL — SQLite에서 boolean SUM은 0/1 합산):

```sql
SELECT session_id, source_app,
  MIN(received_at)                                          AS started_at,
  MAX(received_at)                                          AS last_at,
  SUM(hook_event_type='UserPromptSubmit')                   AS turns,
  SUM(hook_event_type='PreToolUse')                         AS tool_calls,
  SUM(hook_event_type='PostToolUse' AND error IS NOT NULL)  AS errors,
  SUM(hook_event_type='PreCompact')                         AS precompacts,
  SUM(hook_event_type='SubagentStop')                       AS subagents,
  MAX(hook_event_type='SessionEnd')                         AS ended
FROM events
WHERE received_at >= ?
GROUP BY session_id
ORDER BY last_at DESC
LIMIT ?;
```

---

## 4. API 명세 (stage 7)

기존 6개 엔드포인트에 3개 추가. 전부 GET, 전부 기존 `hostOk` + `authed` 게이트 뒤,
전부 DB 없으면(degraded) 빈 결과 200.

| Path | 파라미터 | 응답 |
| --- | --- | --- |
| `GET /stats/overview` | `window`(기본 24h) | `{window_ms, bucket_ms, events, errors, sessions, sessions_active, by_event_type:{...}, buckets:[{t,count,errors}…]}` |
| `GET /stats/sessions` | `window`(기본 7d), `limit`(기본 50, ≤200), `source_app` | `{window_ms, count, sessions:[롤업 행…]}` (§3.2 + `active`/`duration_ms` 계산 필드) |
| `GET /stats/tools` | `window`(기본 24h), `source_app` | `{window_ms, count, tools:[{tool_name, calls, errors, orphans, pending, p50_ms, p95_ms, max_ms}…]}` — `pending` = Post가 아직 없지만 임계 이내(실행 중 추정) |

- `window`: `1h | 6h | 24h | 7d` 화이트리스트(자유 파싱 금지 — 검증 단순하게). 모든 쿼리에
  `received_at >= now - window` 필터. `idx_type_time`/`idx_app_time`이 커버.
- **percentile은 JS에서**: SQLite에 백분위 함수가 없다. window 필터를 건
  `SELECT tool_name, duration_ms, error, ended_at FROM v_tool_calls WHERE started_at >= ?`
  를 받아 tool_name별로 정렬-인덱싱한다. 50만 행 상한에서 문제없는 규모.
- 활동 버킷: `GROUP BY received_at / 3600000` (1시간 버킷; window=1h면 60000으로 분 버킷).

## 5. 대시보드 UI (stage 8)

### 5.1 구조

- 탭: **Live**(기존 그대로) | **Sessions** | **Tools** (+ stage 9에서 **Guards**).
  `location.hash` 라우팅(`#live` 등), 탭 활성화 때 fetch + 30초 재갱신.
- 상단 **fleet 스트립**(모든 탭 공통): 활성 세션당 한 줄 —
  `source_app · 세션 앞8자 · 마지막 이벤트 타입/툴 · n초 전`. 폴링이 아니라 **이미 열려 있는
  SSE 피드로 실시간 갱신**하고, `/stats/sessions?window=1h` 시드를 30초마다
  재로드한다(초기 상태와 SSE 누락 보정). "n초 전" 표시는 5초마다 다시 그린다.

### 5.2 렌더링 원칙 (기존 유지)

- CSP `script-src 'self'` 그대로 — 차트 라이브러리 불가. **인라인 SVG 헬퍼 직접 구현**
  (가로 막대 `hbar()`, 스파크라인 `spark()`, 합쳐서 ~60줄). `createElementNS` +
  `textContent`/속성 대입만 — innerHTML 금지 원칙 유지.
- 서빙은 기존 방식대로 server.mjs 내 문자열(`DASHBOARD_HTML`/`DASHBOARD_JS` 확장).

### 5.3 세션 드릴다운

Sessions 탭에서 세션 클릭 → 기존 `GET /events?session_id=&order=asc` 재사용(서버 추가 없음).
클라이언트가 `UserPromptSubmit`/`Stop` 경계로 턴을 나눠 접이식 워터폴로 그린다.
턴 헤더: 프롬프트 미리보기(payload.prompt 앞 120자) · 소요시간 · 툴 호출 수 · 에러 뱃지.

## 6. GuardDecision 이벤트 (stage 9)

guard가 deny/ask/warn 판정을 내릴 때 수집기로 쏘는 커스텀 이벤트.
**서버는 무수정** — normalize가 모르는 타입을 `unknown_event=1`로 이미 보존한다(설계 §4.2).

```jsonc
// guard가 직접 만드는 봉투 (send-event 훅을 거치지 않음)
{ "source_app": "<repo>", "session_id": "<sid>",
  "hook_event_type": "GuardDecision",
  "payload": {
    "guard": "git-guard",             // git-guard | bash-guard | tdd-guard | …
    "rule": "main-protection",
    "decision": "deny",               // deny | ask | warn  (allow는 안 보냄 — 볼륨/노이즈)
    "tool_name": "Bash",
    "command": "git push origin main", // redaction은 서버 몫(기존 경로)
    "reason": "<사용자에게 보여준 사유>"
  } }
```

- 전송 코드는 `send-event.mjs`의 POST 로직을 **`lib/obs-client.mjs`로 추출**해 공유
  (fire-and-forget, 5초 타임아웃, 에러 삼킴). guard의 exit code 규약은 절대 불변 —
  emit 실패가 판정을 못 바꾼다.
- 조회: `GET /stats/guards?window=7d` →
  `json_extract(payload,'$.guard'/'$.rule'/'$.decision')`로 롤업. guards 쿼리만 payload를
  읽는 예외이며, GuardDecision 행은 소수라(하루 수십 건) 문제없다. 느려지면 그때 컬럼 승격.
- UI: Guards 탭 — guard×rule별 카운트, 최다 블록 명령 top N, 리포별 분포.

---

## 7. 빌드 순서 (stage 6에 이어서)

각 단계 = PR 하나. 단계마다 독립 실행·테스트 가능.

1. **stage 7 — 집계 API**: `user_version=2` + `v_tool_calls` + `/stats/overview·sessions·tools`.
   테스트: 합성 이벤트 스크립트(Pre/Post 짝, 고아, 에러, 멀티 세션 시나리오)를 POST →
   curl로 3개 엔드포인트 수치 검증. UI 없음.
2. **stage 8 — 분석 UI**: 탭 + fleet 스트립 + Sessions/Tools 뷰 + SVG 차트 + 세션 드릴다운.
   서버 변경은 HTML/JS 문자열뿐.
3. **stage 9 — Guard 관측**: `lib/obs-client.mjs` 추출 → git-guard/bash-guard/tdd-guard emit →
   `/stats/guards` + Guards 탭. guard exit 규약 불변 확인 테스트 포함.
4. **stage 10 (선택) — 토큰/비용·알림**: transcript 파싱은 착수 전 별도 설계(§2 Tier 3 전제 참고).

## 8. 리스크 · 미해결 질문

- **retention 7일 vs 주간 추이**: 기본 보존이 7일이라 "지난주 대비"가 딱 경계에 걸린다.
  → 옵션: (a) `OBS_MAX_AGE_DAYS=14`로 올리기, (b) 일별 롤업 테이블(`daily_stats`)을
  retention 전에 적재. **stage 7에서는 보류** — 7일 창 안에서 시작하고 필요하면 (b).
- **고아 임계 10분**: 장시간 도는 Bash(빌드 등)가 오탐될 수 있다. `OBS_ACTIVE_MS`(기본
  600000)로 조정 — 활성 세션 판정과 같은 임계를 쓴다.
- **GuardDecision에 allow도 보낼까**: 기본 안 보냄(이벤트 볼륨 대비 정보가 적다).
  "guard 통과율"이 필요해지면 샘플링으로.
- **집계 부하**: 50만 행 상한 + 인덱스로 충분하다는 가정. `/stats`가 느려지면
  60초 메모리 캐시 한 겹(키 = path+query) — 지금은 안 넣는다.
