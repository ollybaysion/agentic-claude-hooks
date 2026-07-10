# Turn Inspector — 턴 단위 도구 호출 검증 화면 설계

> agent-dashboard(observability collector)의 다음 기능. 상태: **설계 v2 —
> 적대적 검증 반영** (2026-07-10; v1 초안 2026-07-09).
> 검증 3방향: ① 라이브 수집기 실데이터 대조(12,351 이벤트/46세션/usage 5,183행)
> ② server.mjs 코드 정합성 ③ 턴 모델 논리 공격 — 실측 수치는 부록 A.
> 코드 기준: claude-hooks `core/observability/server.mjs` v0.12.1 (schema v5).
> 관련 설계: `claude-hooks/docs/agent-dashboard-collector-design.md`,
> `agent-dashboard-analysis-design.md`.

## 1. 요구사항 (rephrasing)

원문: "유저가 대화를 보내고 응답이 오기 전까지 PreToolUse랑 PostToolUse가 반복되는데,
그걸 묶어서 보고 싶다. 특정 질문에 어떤 식으로 도구를 호출했고 그 속에 비효율이
있는지, 제대로 접근하고 있는지 검증하고 싶다."

재정의:

**유저 프롬프트 제출(UserPromptSubmit)부터 응답 완료(Stop)까지를 "턴(turn)" 하나로
묶고, 그 턴 안에서 벌어진 도구 호출 시퀀스를 검사할 수 있는 드릴다운 화면을
만든다.** 목적은 단순 관측이 아니라 **검증(audit)**이다 — 화면을 보는 사람이 다음
세 질문에 빠르게 답할 수 있어야 한다:

1. **접근이 맞았나** — 이 질문에 대해 에이전트가 어떤 도구를 어떤 순서로 썼는가?
   (탐색 → 읽기 → 수정 → 검증 같은 합리적 흐름인가, 아니면 헤매고 있는가)
2. **낭비가 있었나** — 같은 호출 반복, 에러 후 무의미한 재시도, Read 없이 Grep만
   수십 번 도는 탐색 폭주, 하나의 느린 호출이 턴을 지배하는 롱테일이 있었는가?
3. **시간·비용이 어디로 갔나** — 턴의 벽시계 시간이 도구 실행 / 모델·미분류 시간 /
   사람 대기(권한 프롬프트) 중 어디에 쓰였고, 이 턴이 토큰으로 얼마짜리였나?

즉 기존 Tools 탭이 "도구별 평균"이라면, Turn Inspector는 **"질문 하나의 실행
궤적"**을 보여준다.

### 1.1 정직한 한계 (이 화면이 답하지 **못하는** 것)

- **"왜 그렇게 불렀는가"는 안 보인다.** 훅은 assistant 텍스트/thinking을 수집하지
  않는다. 이 화면은 궤적의 **형태**만 보여주고, 같은 시퀀스라도 "계획 후 실행"과
  "맹목적 더듬기"의 구별(의도 확인)은 transcript의 몫이다.
- **백그라운드 Bash의 실제 작업 시간은 관측 불가.** `run_in_background` 호출은
  Post가 즉시 떠서 duration이 수백 ms로 기록되고, 실작업(10분 빌드)은 사각지대다.
  시간 귀속은 포기하고 `bg` 배지로 표시만 한다(§6.3).
- **gap은 "모델 생성"이 아니라 "미분류 전부"다.** 자동 승인된 권한 대기, API
  재시도/지연, extended thinking, 관측 못한 대기가 전부 gap에 쌓인다 — 단정
  라벨을 쓰지 않는다(§4.3).

## 2. 현재 상태 — 이미 있는 것과 한계

이미 있는 것 (재사용한다):

| 자산 | 위치 | 내용 |
| --- | --- | --- |
| `tool_use_id` 컬럼 + `idx_dedup` | events 테이블 | Pre↔Post를 잇는 키. 실측 PreToolUse의 100%가 보유 (서브에이전트 포함) |
| `v_tool_calls` 뷰 | schema v2 | Pre/Post 한 쌍 = 한 행, `duration_ms`/`error`/`ended_at IS NULL`(고아·진행중) 이미 계산 |
| `payload` = 원시 훅 JSON | events 테이블 | `tool_input`(Pre), `tool_response`(Post), `prompt`(UserPromptSubmit) 전문 저장 (ingest 시 redaction; 5MiB 초과 봉투는 413으로 통째 드롭 — 절단이 아니라 유실) |
| `agent_id`/`agent_type` 승격 컬럼 | events 테이블 | 서브에이전트 구분. 실측 서브 Pre 1,345행 전부 agent_id 보유; agent_type은 일부 결측 → 레인 라벨은 agent_id 기준 |
| `usage` 테이블 (10a) | schema v3 | API 메시지당 1행 + `emitted_tool_ids`/`follows_tool_ids` — 턴별 비용 귀속의 재료 (단 §7의 제약) |
| 클라이언트 턴 그룹핑 | DASHBOARD_JS `drill()` (§5.3) | Sessions 드릴다운이 이미 UserPromptSubmit 경계로 이벤트를 접어서 보여줌 |

현재 드릴다운(`drill()` + `fetchSession()`)의 한계 — 이번 작업이 대체할 대상:

- **원시 이벤트 테이블**이다. Pre와 Post가 별개 행이라 호출당 소요시간이 안 보이고,
  payload는 `JSON.stringify` 앞 200자 프리뷰라 무슨 호출인지 읽기 어렵다.
- **분석이 없다.** 중복·재시도·고아·갭 어느 것도 계산하지 않는다. "비효율 검증"이
  사람의 육안 스캔에 100% 의존한다.
- **무겁다.** `/events?session_id=…&limit=1000`을 최대 5페이지, **payload 전문
  포함**으로 끌어온다 (실측 최대 세션 2,626 이벤트 / payload 11.3MB).
- 턴 경계가 부정확하다. Stop을 안 보므로 "응답 완료"와 "다음 질문 사이 유휴"가
  구분되지 않고, 서브에이전트 이벤트가 섞여 도구 수가 부풀 수 있다.
- `fetchSession()`의 소비자는 drill() 한 곳뿐 — 제거해도 파급 없음 (검증 ②).

## 3. 설계 원칙 (collector 원칙 상속)

- **읽기 전용, 스키마 무변경.** 턴은 저장하지 않고 조회 시 파생한다(derive-on-read).
  세션당 이벤트는 retention(7d/500k행/1GB)으로 유계이고 `idx_session`으로 세션
  스캔이 싸므로 물질화가 필요 없다. 마이그레이션 없음 — schema v5 유지.
- **payload 읽기 예외 #4.** "집계는 payload를 읽지 않는다" 원칙의 예외는 실제로는
  이미 **셋**이다: `/stats/guards`, `/stats/nudges`, 그리고 `/stats/sessions`의
  first_prompt 서브쿼리(#66에서 추가 — 코드 주석 S:802-804·S:1388과 README가
  "둘"이라고 낡게 서술 중). `/stats/turns`는 **네 번째** 예외가 되고, 구현 PR에서
  낡은 주석·README를 함께 정정한다. 예외 정당화 기준도 "행 희소성"만이 아니라
  "**스캔 범위 유계**(한 세션)"로 확장해 명문화.
- **fail-open / empty-but-200.** DB degraded면 빈 응답, 절대 ingest 경로에 영향
  없음. 판정 휴리스틱은 진단 신호이지 정확한 재판이 아니다 — anatomy·what-if처럼
  **근사임을 문서와 툴팁에 명시**한다.
- **의존성 없음, CSP 불변.** UI는 기존 inline-SVG + vanilla JS 컨벤션 유지.

## 4. 턴 모델

### 4.1 경계 규칙

세션의 이벤트를 `seq` 오름차순으로 훑으며:

- **턴 시작** = `UserPromptSubmit`. (턴 키는 이 이벤트의 `seq` — 인덱스 번호는
  retention으로 앞이 잘리면 흔들리므로 시작 seq를 안정 식별자로 쓴다.)
- **턴 끝(메인 체인)** = 다음 `UserPromptSubmit` 직전의 **마지막 `Stop`**. stop-hook이
  멈춤을 block하면 Stop이 여러 번 뜬다 — 실측 4/439턴(0.9%), 마지막 것이 종료.
- **경계 레이스**: Stop 훅과 큐잉된 UserPromptSubmit 훅은 별개 프로세스가 각자
  POST하고 서버는 도착순으로 seq를 찍는다. UserPromptSubmit 직후 ~1s 안에 도구
  이벤트 없이 도착한 Stop은 **직전 턴의 종료로 재배열**한다(`client_ts` 보조 참고).
- **큐잉 프롬프트 판별** (v1 규칙을 뒤집음 — 검증 ③ C-1): Stop 없이 새
  UserPromptSubmit이 오는 경우는 두 가지다 — (a) 턴 진행 중 큐잉된 메시지,
  (b) Esc 인터럽트 후 재질문. 판별 신호: **진짜 큐잉이면 직전 턴의 in-flight
  Pre가 새 프롬프트 이후의 Post와 페어링된다**(루프가 계속 달렸다는 증거).
  Esc였다면 그 Pre는 영원히 고아다. 따라서 **병합은 이 페어링이 관측될 때만**,
  기본값은 **분리 + 직전 턴 `interrupted`**. (오분리는 큐잉 주석 하나를 잃지만
  오병합은 두 턴의 flags·비용·상태를 모두 오염시킨다. 실측 no-Stop 세그먼트
  36/480 = 7.5%.) 병합된 프롬프트는 `queued_prompts`로 카운트.
- **post-stop tail**: 마지막 Stop과 다음 UserPromptSubmit 사이의 이벤트. 실측
  **302/439턴에 존재**하고 그 도구 이벤트는 **100% 서브에이전트 레인**(백그라운드
  에이전트가 메인 Stop 후에도 계속 달림). 규칙 — **직전 턴 소속으로 표시**하되
  (타임라인에서 Stop 마커 뒤 흐린 구간), **시간 분해와 flags에서는 제외**. 예외:
  이 구간에 **main 레인 도구 호출**이 있으면 최종 Stop 유실(수집기 타임아웃/
  다운타임)로 보고 `ended_at`을 마지막 main 이벤트로 연장, status는 complete 유지.
- 세션 마지막 턴이 Stop이 없고 세션이 활성(`OBS_ACTIVE_MS` 내)이면 → `open`,
  비활성이면 `interrupted`.
- 첫 UserPromptSubmit 앞의 이벤트는 가상 턴 `#0 (before first prompt / trimmed)`
  으로 접는다 — resume 잔여와 retention으로 머리가 잘린 턴의 몸통이 여기 흡수된다.
  flags 판정 제외, 비용 ts-폴백 버킷으로는 합법(§7).

### 4.2 턴 내부: 호출과 마커

**도구 호출(calls)** — `PreToolUse`를 앵커로 `tool_use_id`로 Post와 페어링.
**페어링은 턴 범위가 아니라 세션 전체에서 한다**(v_tool_calls와 동일) — 턴 범위
한정이면 턴 경계를 넘는 백그라운드 작업이 가짜 고아가 된다(검증 ③ B-1). 호출의
**소속 턴 = Pre가 속한 턴**. Post가 다음 턴 윈도우에 떨어지면 `crosses_turn`
표시하고 시간 계산은 턴 윈도우로 절단.

| 필드 | 유래 |
| --- | --- |
| `tool_use_id`, `tool_name` | Pre 행 |
| `started_at`, `duration_ms` | Pre/Post `received_at` 차 |
| `status` | `ok` / `error`(Post.error) / `pending`(Post 없음 + `orphan_after_ms` 미경과) / `orphan`(세션 어디에도 Post 없음 + 경과) |
| `input_summary` | Pre payload `tool_input`에서 **툴별 대표 필드 추출** (§6.3) |
| `gap_before_ms` | `max(0, started_at − 직전 main 구간들의 최댓값 끝)` — 음수(병렬 겹침)는 0 클램프 + `parallel` 배지 |
| `lane` | `main` / `subagent`(`agent_id` 기준 — agent_type은 결측 있음) |
| `dup_of` | 같은 턴·같은 레인에서 동일 `tool_name`+정규화 `tool_input` 해시가 앞서 있으면 그 tool_use_id |
| `crosses_turn` / `bg` / `parallel` | 경계 초과 / `run_in_background` / 겹침 배지 |

**고아의 지배적 원인은 권한 거부가 아니라 PreToolUse 훅 deny다** (검증 ① —
고아 396건 중 GuardDecision ±3s 상관 238건, 권한 Notification 상관은 9건뿐).
GuardDecision에는 tool_use_id가 없으므로 시간 상관(±3s)으로만 연결한다. 툴팁과
범례는 훅 거부를 첫 번째 원인으로 서술할 것. `pending↔orphan` 경계는 config
`turns.orphan_after_ms`(기본 = `OBS_ACTIVE_MS`) — 무정의면 새로고침마다 상태가
바뀐다. 역고아(Post만 있고 Pre 유실 — 실측 13건)와 tool_use_id 없는 구행은
`unpaired`로 집계.

**마커(markers)** — 호출은 아니지만 궤적 해석에 필요한 이벤트:

- `GuardDecision` — **신규 추가** (고아 호출의 실제 설명자).
- `Notification` — payload `message`로 이분: **권한**("needs your permission",
  실측 5%)만 wait 계산에 쓰고, **유휴**("waiting for your input", 95% — 그중
  229/241은 post-stop 구간)는 마커로만 표시.
- `PreCompact`(턴 중간 컴팩션 — 이후 갭·비용 왜곡의 설명자), `SubagentStop`,
  `SessionEnd`.

### 4.3 턴 시간 분해

검증 ③에서 v1 산식이 두 방향으로 깨짐이 확인됐다: (a) 권한 Notification은 항상
Pre와 Post **사이**에 발생하므로(훅→다이얼로그→승인→실행→Post) wait와 tool이
거의 전액 이중 계상되고, (b) 병렬 호출(실측 main 레인 0.4%)에서 gap이 음수가
된다. 수정된 산식:

- **tool_ms** = main 레인 `[Pre, Post]` 구간들의 **interval union** — 겹침을
  합집합으로 접어 벽시계를 초과하지 않게 한다. 개별 호출 행에는 raw duration 유지.
- **wait_ms** = 권한 Notification → **그 호출의 Post**까지의 구간 합. 이 구간은
  해당 호출의 tool 기여분에서 **차감**한다(이중 계상 방지). 승인 후 실행 잔여가
  섞이므로 **상한 근사**임을 툴팁에 명시. 아웃라이어 캡 `turns.wait_cap_ms`
  (기본 30m) — 실측 권한 대기 꼬리가 42h(밤새 방치)까지 간다.
- **gap_ms** = 잔차. 라벨은 "**모델·미분류 시간**(생성, API 지연, 관측 밖 대기)".
- 항등식: `duration_ms = tool_ms + wait_ms + gap_ms` (post-stop tail 제외 기준).
- 서브에이전트 레인은 main과 겹쳐 돌므로 합산에서 제외, `subagent_calls`/
  `subagent_ms`(해당 레인 union)로 별도 표기. **이 레인 분리가 산식의 전제**다
  (레인 미분리 시 겹침이 7.9%로 뛴다 — 검증 ①).

## 5. 비효율 신호(flags) 카탈로그

턴 요약에 `flags: string[]`로 실린다. **대상은 main 레인 호출만**(`dup_of`도
레인 내에서만) — Explore 서브에이전트가 Grep 20번 도는 건 걔 일이다. 임계값은
`config.json {"turns": {...}}`로 튜닝(mega 컨벤션), 기본값은 아래. v1 표의 4개
규칙은 "오탐보다 미탐" 원칙을 자체 위반하고 있어 조건을 강화했다(검증 ③ D).

| flag | 판정 규칙 (기본값) | 오탐 방지 조건 (v2) |
| --- | --- | --- |
| `dup-call` | 동일 `tool_name` + 정규화 `tool_input` 해시 ≥ 2회 | 두 발생 사이에 같은 `file_path`에 대한 Edit/Write 또는 임의의 Bash(상태 변경 가능)가 있으면 제외 — `git status` 전후 확인, Edit 후 재검증 Read는 정당 |
| `re-read` | 같은 `file_path` Read ≥ 3회 | **offset/limit 범위가 겹칠 때만** 카운트 — 큰 파일의 분할 읽기(2,000줄 캡)는 정당 |
| `retry-loop` | error 후 재호출 연쇄 ≥ 3 | **같은 tool + 같은 input 해시**의 연쇄로 한정, 사이 read-only 호출 ≤ 1개는 연쇄 유지 — lint→typecheck→test 연속 실패는 서로 다른 검사다 |
| `search-storm` | 첫 Read/Edit 전 Grep/Glob 연속 ≥ 5 | **병렬 배치(gap≈0 클러스터·구간 겹침)는 1회로 접기** — 배치 발행은 권장 패턴이지 폭주가 아니다 |
| `long-tail` | 단일 호출 raw duration이 tool_ms(union)의 ≥ 50% 이고 ≥ 30s | wait 차감 후 기준 |
| `gap-heavy` | gap_ms ≥ tool_ms × 2 이고 gap_ms ≥ 60s | 라벨 "모델·미분류 시간이 지배" — 원인 후보(생성/API 지연/컨텍스트 크기)는 툴팁에, Tokens 탭 교차 확인 안내 |
| `orphaned` | orphan 호출 ≥ 1 | 훅 deny(GuardDecision 상관)가 첫 원인임을 범례에 |
| `mega-turn` | 호출 ≥ 30 또는 턴 ≥ 10m | — |

정규화 해시: `tool_input`을 키 정렬 JSON으로 직렬화해 해시. Bash `command`의
연속 공백 정도만 정규화하고 과하게 똑똑해지지 않는다. **redaction 주의**: key-
서브트리 마스킹(`[redacted by key]`)이 서로 다른 입력을 같은 해시로 만들 수
있으므로, 해시 대상에 redaction 마커가 포함되면 dup 판정에서 제외(보수적).

**비목표**: LLM에게 "이 접근이 옳았나"를 자동 판정시키는 것. flags는 기계적으로
셀 수 있는 것만 센다. 질적 판단은 화면을 보는 사람 몫이고, 그걸 위해 프롬프트
원문과 input_summary를 나란히 보여주는 것이 이 화면의 역할이다 (§1.1의 한계
안에서).

## 6. API 설계

### 6.1 `GET /stats/turns?session_id=X` — 턴 목록 (요약만)

```jsonc
{
  "session_id": "abc…", "count": 12,
  "turns": [{
    "turn_seq": 4213,            // 시작 UserPromptSubmit의 seq = 안정 키
    "n": 3,                      // 표시용 순번 — 보존창 기준이라 리로드 간 밀릴 수 있음
    "prompt": "대시보드에 턴 뷰 추가…",   // 200자 트림
    "queued_prompts": 0,         // 병합된 큐잉 프롬프트 수 (§4.1)
    "started_at": 1720500000000, "ended_at": 1720500180000,
    "status": "complete",        // complete | interrupted | open
    "duration_ms": 180000,
    "tool_ms": 92000, "gap_ms": 74000, "wait_ms": 14000,   // §4.3 산식 (union·차감·캡)
    "calls": 17, "errors": 1, "orphans": 0, "unpaired": 0,
    "guard_denies": 1,           // GuardDecision 상관 고아 수
    "distinct_tools": 5, "dup_calls": 2,
    "subagent_calls": 6, "subagents": 1, "subagent_ms": 41000,
    "post_stop_events": 12,      // post-stop tail 크기 (§4.1)
    "longest": { "tool_name": "Bash", "duration_ms": 41000 },
    "precompacts": 0, "notifications": 1,
    "flags": ["dup-call", "long-tail"],
    "cost_usd": 1.84             // §7 — 메인 체인 비용만; 귀속 행 0개면 null
  }]
}
```

파라미터: `session_id`(필수), `limit`(**최신** N턴, 기본 100 ≤ 500). 세션 하나의
이벤트를 `idx_session`으로 seq 순 스캔 → JS에서 그룹핑/페어링/판정.
`/stats/tokens?group=timeline`과 같은 "드릴다운은 비윈도우" 태도 — retention이
상한이다.

### 6.2 `GET /stats/turns?session_id=X&turn=<turn_seq>` — 턴 상세

요약(위와 동일) + 타임라인:

```jsonc
{
  "turn": { /* §6.1 요약과 동일 */ },
  "prompt_full": "…(2000자 트림)…",
  "calls": [{
    "tool_use_id": "toolu_…", "tool_name": "Read", "lane": "main",
    "event_seq": 4217,           // /events/:id 점프용 (retention 만료 시 404 — UI가 안내)
    "started_at": 1720500001000, "duration_ms": 350, "gap_before_ms": 4200,
    "status": "ok", "error": null,
    "input_summary": "core/observability/server.mjs :858-942",
    "dup_of": null,
    "crosses_turn": false, "bg": false, "parallel": false
  }],
  "markers": [
    { "type": "Notification", "kind": "permission", "at": 1720500060000, "wait_ms": 14000 },
    { "type": "GuardDecision", "at": 1720500090000, "guard": "bash-guard", "rule": "…", "correlated_tool_use_id": "toolu_…" },
    { "type": "PreCompact",   "at": 1720500120000 }
  ]
}
```

`tool_response`는 **싣지 않는다**(수 MB가 될 수 있고, 검증에는 status/error면
충분). 원문은 행의 `event_seq`로 `/events/:id` 새 탭 점프(JSON 응답이라 탭
렌더 안전; `OBS_TOKEN` 설정 시 Bearer를 못 실어 401 — 기존 대시보드 fetch와
동일한 한계, 기본 loopback 무토큰 환경에선 문제 없음).

### 6.3 `input_summary` 추출 규칙 (payload 화이트리스트)

| tool | 요약 |
| --- | --- |
| Bash | `description` 있으면 그것, 없으면 `command` 첫 줄 120자; `run_in_background`면 `bg` 배지 |
| Read | `file_path` (+ `offset`/`limit` 있으면 `:o-l`) |
| Edit / Write | `file_path` |
| Grep | `pattern` + `path`/`glob` |
| Glob | `pattern` |
| Task / Agent | `description` (+ `subagent_type`) |
| WebFetch / WebSearch | `url` / `query` |
| 그 외 | 키 정렬 JSON 앞 120자 (기존 preview와 동일한 태도) |

redaction은 ingest에서 이미 적용된 payload를 읽으므로 추가 처리 불필요(단 §5의
dup 해시 예외). 대시보드 자체가 loopback + 토큰 게이트 뒤라는 전제도 기존과 동일.

### 6.4 성능

세션당 이벤트 수천 행 × json_extract 몇 개 = 수십 ms 수준 — 실측으로 성립:
PreToolUse payload p50 748B / p95 3.1KB / max 26KB, 최악 세션의 Pre+UPS 합계
1.57MB(전체 11.3MB 중 — 화이트리스트 한정이 핵심). 목록 응답에서는 payload
파싱을 `UserPromptSubmit`(prompt)과 `PreToolUse`(dup 해시·input 요약)로 한정.
상세는 한 턴 범위만. 전 세션 fleet 집계는 하지 않는다(§10).

## 7. 턴별 비용 (usage 조인 — 근사)

10a의 `usage` 테이블과 잇는다. **행당 단일 귀속**(이중 계상 금지 — 검증 ③ E-1):

1. **emitted 우선**: usage 행의 `emitted_tool_ids`가 턴의 tool_use_id 집합과
   교집합이 있으면 그 턴 소속. 두 턴과 걸치면 emitted 쪽이 이긴다.
2. **follows 차선**: emitted가 비었을 때만 `follows_tool_ids`로 귀속. (파서는
   user 메시지에서 follows를 리셋하지 않으므로, 도구 호출로 끝난 턴의 다음 턴
   첫 메시지가 이전 턴 id를 follow한다 — emitted 우선이 이 오귀속을 막는다.)
3. **ts 폴백**: 둘 다 없으면 `ts ∈ [started_at, ended_at]`인 턴에 귀속. `#0`도
   합법적 버킷이다(resume 잔여). 실측상 ts 폴백은 예외가 아니라 **상시 경로**다
   — id 매칭율은 retention 창 안에서도 88~99%, usage 세션의 13%는 events가
   아예 없다(수명 차이).
4. **unattributed 잔액**: 어느 턴에도 못 붙은 행의 합계를 세션 드릴 상단에
   `unattributed_cost_usd`로 표시 — 무음 증발 방지 + 정합성 자가 검증.

**서브에이전트 비용은 v1에서 제외한다** (검증 ①·② 일치, v1 설계의 규칙 3 폐기):
실측 usage 5,183행 중 `sidechain=1`이 **0행** — CC 2.1.197+가 서브에이전트
대화를 메인 transcript가 아닌 `subagents/agent-*.jsonl` 별도 파일로 쓰기
때문에 현행 파서가 영원히 못 본다. 따라서 `cost_usd`는 "**메인 체인 비용만**"
으로 문서화·툴팁 표기하고, 서브에이전트 usage 수집(파서 확장)은 별도 선행
이슈로 분리한다(§10). 서브에이전트-heavy 턴의 비용이 체계적으로 과소함을 화면이
숨기지 않는 것이 목적.

추가 정직성 규칙:

- **compact 사각지대**: 컴팩션 API 호출은 transcript usage에 기록되지 않는다
  (실측 메모). `PreCompact` 마커가 있는 턴의 cost에 "compact 호출 비용 미포함"
  배지 — 가장 비싼 턴에서 가장 크게 거짓말하는 걸 막는다.
- **null의 단위는 턴**: 그 턴에 귀속된 usage 행이 0개면 `cost_usd: null`(빈칸).
  $0.00으로 렌더하지 않는다 — 공짜로 보이는 건 빈칸보다 나쁜 거짓말.
- resume이 transcript 경로를 바꾸는 케이스는 과거 usage가 재인제스트되어 유령
  비용이 될 수 있다 — #0과 unattributed가 받아내고, 툴팁에 한 줄 안내.

기존 tool-attribution과 마찬가지로 **문서화된 근사**다. usage가 비어 있으면
전 턴 null. 구현은 3단계(§9)로 미뤄도 된다: 턴 구조와 flags만으로도 화면 가치의
80%가 나온다.

## 8. UI 설계

새 탭이 아니라 **Sessions 드릴다운의 턴 리스트를 교체**한다(현 §5.3 client-side
그룹핑 삭제 → `/stats/turns` 호출로 대체). 이유: 진입 동선이 이미 "세션 클릭 →
무슨 일이 있었나"이고, 컨텍스트 곡선·what-if 카드와 한 화면에 있는 게 검증
목적에 맞는다. `fetchSession()`의 5×1000행 payload 전송도 함께 사라진다.

```text
[session drill]
  제목 · context growth 카드 · what-if 카드 · unattributed cost   (§7)
  ── Turns ──────────────────────────────  [⚑ flags만]  (?)
  ▸ #1 (seq 3101)  "훅 문법 정리해줘"        45s · 3 calls          $0.21
  ▾ #2 (seq 4213)  "대시보드에 턴 뷰 추가…" 3m0s · 17 calls · 1 err $1.84
        ⚑ dup-call ×2  ⚑ long-tail
        [tool 92s ████████░░ gap 74s ▒▒▒▒ wait 14s ░]   ← §4.3 산식
        ┌──────────────────────────────────────────────────────┐
        │ 16:03:21  +4.2s  Read   server.mjs:858-942    0.4s ▏ok│
        │ 16:03:21  ∥      Grep   "handleStats" core/   0.2s ▏ok│
        │ 16:03:30  +3.1s  Read   server.mjs:858-942    0.4s ▏ok ⚑dup│
        │ 16:04:02  ⚠ 권한 대기 14s (Notification)               │
        │ 16:04:10  ⛔ GuardDecision bash-guard deny             │
        │ 16:04:16  +1.0s  Bash   npm test [bg]         0.3s ▏ok│
        │   └ sub:a3f  Task   "verify diff"             22s █▏ok │
        │ ── Stop ──  (이후 흐린 구간 = post-stop tail)           │
        │   └ sub:a3f  Grep   …                         (tail)   │
        └──────────────────────────────────────────────────────┘
```

- 턴 행 = `<details>` (기존 컨벤션): `#n (seq)` 병기 · 프롬프트 트림 · duration ·
  calls · err · flags 뱃지 · cost. `[⚑ flags만]` 토글로 문제 턴만 필터(신규
  패턴 — 기존 UI는 select뿐이지만 무해). 상세(`turn=`)는 **펼칠 때 lazy-fetch**.
- 펼치면: 시간 분해 스택바(inline SVG, §4.3 산식) + 호출 테이블. 각 행: 시각,
  `+gap`(병렬은 `∥`), tool, input_summary, duration 미니바, status, dup/bg/
  crosses-turn 뱃지. 서브에이전트는 들여쓰기 + `sub:<agent_id 앞4>` 레인 라벨.
  Stop 마커 뒤 post-stop tail은 흐리게.
- 행 클릭 → `/events/<event_seq>` 새 탭. **404면 "retention으로 만료" 안내**
  (실DB에서 이미 seq 앞부분이 지워져 있음).
- `(?)` 툴팁 3개 추가(#61 컨벤션, 한글 카피 + 영어 지표 토큰): ① 턴 경계·큐잉·
  post-stop tail 규칙 ② 시간 분해 산식과 근사인 이유(gap = 미분류 전부, wait =
  상한, bg = 사각지대) ③ flags 정의표(orphan의 첫 원인 = 훅 deny). **주의**:
  기존 Tools 탭 툴팁의 orphan 설명이 코드와 반대("Pre 없이 결과만")인 기존 버그
  가 있다 — turns 툴팁 작성 시 전염 금지, 해당 카피도 함께 수정(§9).
- status 색: ok 기본 / error 빨강 / orphan 주황 / pending 회색 (정적).

## 9. 구현 단계 (PR 쪼개기)

이슈 1개 등록(#72 이후 번호 — #71은 git-guard protected-edit 오탐이 점유).
워크플로우는 평소대로 이슈 → feat 브랜치 + 워크트리 → PR → 사람 머지.

| 단계 | 내용 | 버전 |
| --- | --- | --- |
| **1. 서버** | `/stats/turns` 목록+상세: 턴 그룹핑(경계 레이스·큐잉 판별·post-stop tail), 세션 전체 페어링, 시간 산식(union·wait 차감·캡), flags(v2 조건), input_summary. 테스트는 **DB 시딩 + 실서버 spawn + statGet HTTP 통합테스트**(test.mjs의 넛지 테스트가 본보기 — server.mjs는 export가 없어 순수 유닛테스트 불가): 정상 턴 / interrupted / 다중 Stop / 경계 레이스 / 큐잉 판별(in-flight 페어링 유·무) / post-stop tail(서브 꼬리 + main 연장) / 고아(GuardDecision 상관) / dup 면제(중간 mutation) / 병렬 union / 권한 wait 차감 / crosses-turn | server 0.13.0 |
| **2. UI** | drill() 교체(클라이언트 그룹핑·fetchSession 삭제), 스택바·타임라인·flags 필터·툴팁 3종 + 기존 Tools orphan 툴팁 카피 수정, 문서 정정 일괄: README payload 예외 서술(#4까지), 코드 주석 S:802-804·S:1388, `docs/agent-dashboard-analysis-design.md` §5.3(클라이언트 그룹핑 서술이 규범 문서로 남지 않게) | plugin minor |
| **3. 비용** | usage 조인(§7 단일 귀속 + unattributed + compact 배지 + null 규칙). usage 스키마 무변경 | server 0.14.0 |

배포는 기존 플로우: plugin.json + marketplace.json 범프 → `/plugin marketplace
update` + `/reload-plugins` → 4090 서버 재기동.

## 10. 비범위 (명시적으로 안 하는 것)

- **서브에이전트 usage 수집** — CC가 `subagents/agent-*.jsonl`로 분리 저장하는
  transcript를 파서가 추적하도록 확장하는 것. 턴별 서브에이전트 비용의 선행
  조건이며 **별도 이슈**로 분리(이게 없는 동안 cost는 "메인 체인만"으로 표기).
- **fleet 수준 턴 집계** ("전 세션 평균 dup율" 등) — 전 구간 payload 스캔이
  필요해져 예외 원칙이 무너진다. 필요해지면 그때 물질화(턴 테이블, schema v6)와
  함께 별도 설계.
- **LLM 자동 판정** ("이 접근은 비효율" 요약) — flags는 기계적 카운트만. 질적
  판단은 사람.
- **tool_response 본문 렌더링** — `/events/:id` 링크로 충분.
- **백그라운드 작업의 실시간 추적** — bg 배지 표시까지만(§1.1).
- APP 컬럼(tmux 창 구분), NudgeOutcome 연계 — 기존 잔여 항목, 이 작업과 무관.

## 11. 오픈 퀘스천

1. **flags·시간 임계값 기본값** — §5 표와 `wait_cap_ms` 30m, `orphan_after_ms` =
   OBS_ACTIVE_MS는 초기값이다. 1단계 배포 후 실데이터로 일주일 보고 조정
   (config.json 튜닝은 1단계부터 지원).
2. **도구 없는 큐잉 버스트** — in-flight Pre 신호가 아예 없는 연속 프롬프트
   (실측 18건 중 13건이 30s 내)는 판별 신호가 없어 기본값(분리)으로 처리된다.
   운영 데이터에서 오분리가 거슬리면 "N초 내 + 직전 턴 open"류 보조 규칙 검토.
3. **compact 직후 턴** — PreCompact 다음 턴은 gap-heavy가 잘 뜰 텐데 이건
   비효율이 아니라 재읽기 비용이다. 마커·배지·툴팁으로 시작, 필요하면 flag 억제
   규칙 추가.
4. **GuardDecision 상관 창(±3s)** — 실측 기반이지만 하드코딩이다. 이벤트에
   tool_use_id를 실어주는 게 근본 해법(guard 쪽 한 줄) — 별도 개선 이슈 후보.

---

## 부록 A. 적대적 검증 실측 요약 (2026-07-10)

라이브 DB(12,351 이벤트 / 46 세션 / usage 5,183행, 07-04~07-10) + server.mjs
v0.12.1 코드 검증에서 나온, 설계를 바꾼 수치들:

| 검증 항목 | 실측 | 설계 반영 |
| --- | --- | --- |
| 턴 세그먼트 | 480개, Stop-종결 439 | — |
| Stop 없는 세그먼트 | 36/480 (7.5%) — 큐잉·인터럽트 혼재 | §4.1 큐잉 판별 규칙(in-flight 페어링) + 분리 기본값 |
| post-stop tail | 302/439턴에 존재, 도구 이벤트 **100% 서브 레인**(~800건) | §4.1 tail 규칙 신설 |
| 다중 Stop | 4/439 (0.9%) | "마지막 Stop" 유지 |
| Pre의 tool_use_id 보유 | 5,454/5,454 (100%) | 페어링 전제 성립 |
| 고아 Pre | 396 (7.3%) — GuardDecision ±3s 상관 238 vs 권한 Notification 상관 9 | 고아 원인 서술 교체, GuardDecision 마커 추가 |
| 역고아(Post만) | 13 | unpaired 집계 |
| main 레인 구간 겹침 | 17/4,117 (0.4%) — 레인 미분리 시 7.9% | interval union + 클램프 + 레인 분리가 전제 |
| Notification 구성 | 유휴 95% / 권한 5%; 유휴의 229/241은 post-stop; 권한 대기 중앙값 ~61s, 꼬리 42h | wait = 권한만 + Post까지 + 차감 + 캡 |
| usage sidechain | **0/5,183** (서브 transcript 별도 파일 — 파서 미추적) | 서브 비용 v1 제거, 선행 이슈 분리 |
| usage id 매칭 | retention 창 내 88~99%; usage 세션 13%는 events 없음 | ts 폴백 = 상시 경로, unattributed 라인 |
| payload 크기 | Pre p50 748B / p95 3.1KB / max 26KB; 최악 세션 Pre+UPS 1.57MB | §6.4 성능 주장 성립 |
| payload 예외 수 | 이미 3 (guards·nudges·sessions first_prompt) — 주석·README 낡음 | turns = 예외 #4, 문서 일괄 정정 |
| /events seq 만료 | 실DB MIN(seq)=2711 (앞 구간 삭제됨) | 링크 404 안내 |
| 테스트 표면 | export 없는 단일 파일 — DB 시딩 + HTTP 검증만 가능 | §9 테스트 계획 용어 정정 |

검증 방법: ① 실데이터 대조(읽기 전용 SQL + GET), ② 코드 정합성(file:line 대조),
③ 논리 공격(반례 시나리오 구성) — 각각 독립 에이전트로 수행, 교차 확인 후 반영.
