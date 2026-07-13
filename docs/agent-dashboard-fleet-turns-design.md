# Fleet 수준 턴 집계 — 턴 물질화 설계 v2 (#82)

> v2 = 적대적 검증(3방향 병렬) 반영. 뒤집힌 가정과 그로 인한 구조 변경은 **부록 A**에 요약.
> 핵심 교훈: "다음 턴이 열리면 이전 턴은 확정"은 **거짓**이고, upsert-only·`max(ts)` 워터마크·
> 나이 기반 retention 가정도 모두 깨진다. 아래 본문은 수정본이다.

## 1. 문제와 목표

Turn Inspector(#73)는 턴을 **세션 하나 안에서, 조회 시점에** `events` payload로부터 파생한다
(derive-on-read). "한 세션에 한정된 읽기"라는 근거로 payload 접근을 정당화했다.

Fleet 수준 질문은 **전 세션의 턴을 가로질러** 집계해야 답이 나온다:

- 턴당 평균 도구 호출 수 / dup-call 발생 턴 비율의 시간 추이
- gap-heavy 턴이 몰리는 프로젝트(app)·시간대
- 비효율 flag별 "주의 비용"(그 flag를 가진 턴들의 비용 합) 롤업
- 프로젝트·기간 간 효율 비교, 회귀 감시

derive-on-read를 fleet 규모로 그대로 쓸 수 없는 이유: `buildTurns`는 SQL로 표현 불가능한 JS 로직이고
(session-wide 페어링·arrival-race·queued-merge·시간분해), 매 조회마다 전 세션에 대해 돌리면
O(전체 이벤트) + payload 재파싱이며, retention이 `events`를 삭제하면 재파생조차 불가능하다.

**목표**: 정착된(settled) 턴 하나당 요약 1행을 담는 `turns` 테이블을 계산해 저장한다. 그러면 fleet
조회는 값싼 SQL 집계가 되고 이벤트 retention 이후에도 살아남는다. **`buildTurns`가 유일한 진실원으로
남는다** — 물질화는 그 출력을 저장하는 것이지 재구현이 아니다.

## 2. 핵심 원칙: 턴 파생은 하나, 소비자는 둘

- **드릴다운**(단일 세션, calls/markers 상세) — 기존 #73대로 events에서 derive-on-read. 유지.
- **fleet 집계** — 물질화된 `turns` 테이블을 읽는다.
- 물질화기는 세션마다 기존 `buildTurns` + `attachTurnCosts`를 **실행**하고 그 출력을 저장한다.
  턴 세그멘테이션을 두 번 구현하지 않는다.

단, "구성상 항상 일치"는 **이벤트가 살아있고, 정의 차이(열린 턴·가상 턴)를 감안할 때만** 성립한다
(부록 A-9). 그래서 아래 §3·§5의 게이팅과 §9의 라벨링이 필요하다.

## 3. 정착(settled) 규칙 — 게이팅 강화

턴 지표는 **다음 턴 이후의 이벤트에도 의존한다**(session-wide `pairs` 맵으로 늦은 Post가 앞 턴의
call duration·orphan·flag를 바꾸고, orphan 판정은 `now` 의존, queued-merge 경계는 늦은 Post가 결정).
따라서 "다음 턴이 열림"만으로는 확정이 아니다(부록 A-1·A-2·A-3). 턴은 **아래를 모두** 만족할 때만 정착:

1. 다음 턴이 열렸다(또는 `SessionEnd`가 있다, 또는 세션이 idle: `now − last_event_at ≥ SETTLE_IDLE_MS`).
2. 그 턴의 **main-lane Pre가 전부 해소**됐다 — 각 Pre에 Post가 있거나, `now − pre.received_at ≥ TURN_ORPHAN_MS`.
   후자의 미-Post Pre는 정착 시 **결정론적 orphan**으로 확정한다(열린 마지막 턴에만 쓰던 `now` 기반
   pending↔orphan 컷오프를 정착 턴엔 적용하지 않는다 — 아니면 "pending"으로 동결된다, 부록 A-2).

정착 못 한 턴(열린 마지막 턴, 또는 미해소 Pre를 든 턴)은 **물질화하지 않고** derive-on-read로만 보인다.
가상 턴 #0은 포함하되 `n=0`/`virtual`로 표시해 효율 통계에서 제외 가능하게 한다.

**시간 기반 재검토 트리거 필요**: 게이팅이 `now`(Pre 노화)에 의존하므로, "새 이벤트/새 usage/​config 변경"
외에 **"미해소 Pre가 TURN_ORPHAN_MS를 지났는지" 재평가**가 주기적으로 돌아야 한다(§5 후보 조건에 포함).

## 4. 스키마 (v7)

새 테이블 2개 + 기존 `usage` 테이블에 arrival 컬럼 추가. 마이그레이션은 `if (exists && prevVersion < 7)` 패턴.

### 4.1 `turns` — 정착된 턴 1행

```sql
CREATE TABLE IF NOT EXISTS turns (
  session_id   TEXT    NOT NULL,
  turn_seq     INTEGER NOT NULL,   -- 여는 UserPromptSubmit의 seq (가상=0)
  source_app   TEXT    NOT NULL,
  n            INTEGER NOT NULL,   -- 표시 순번 (0=가상)
  status       TEXT    NOT NULL,   -- closed | interrupted | virtual  (open은 저장 안 함)
  auto         TEXT,               -- 하네스 주입 종류 (NULL=사람)
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL,
  tool_ms INTEGER NOT NULL, wait_ms INTEGER NOT NULL, gap_ms INTEGER NOT NULL,
  calls INTEGER NOT NULL, subagent_calls INTEGER NOT NULL, distinct_tools INTEGER NOT NULL,
  errors INTEGER NOT NULL, orphans INTEGER NOT NULL, dup_calls INTEGER NOT NULL,
  guard_denies INTEGER NOT NULL, queued_prompts INTEGER NOT NULL, precompacts INTEGER NOT NULL,
  cost_usd REAL, cost_subagent_usd REAL,     -- NULL = 귀속 usage 0행 ($0.00 아님)
  cost_has_gap INTEGER NOT NULL DEFAULT 0,    -- 1 = 이 턴에 compaction 등 usage 미기록 호출 있음 (비용 하한)
  flags TEXT NOT NULL DEFAULT '[]', flags_mask INTEGER NOT NULL DEFAULT 0,
  config_ver INTEGER NOT NULL, materialized_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_seq)
);
CREATE INDEX IF NOT EXISTS idx_turns_app_time ON turns(source_app, started_at);
CREATE INDEX IF NOT EXISTS idx_turns_time     ON turns(started_at);
```

`subagent_ms`는 **일부러 넣지 않는다** — post-stop 서브에이전트 꼬리 시간은 정착 후에도 늦은 Post로
자라기 때문(부록 A-5). `subagent_calls`(Pre 개수)만 안정적이라 저장한다. `cost_has_gap`은 compaction처럼
usage에 안 잡히는 지출이 있어 `cost_usd`가 **하한**임을 표시(§6, 부록 A-8).

### 4.2 `turn_cursor` — 세션별 물질화 워터마크(+완결성 앵커)

```sql
CREATE TABLE IF NOT EXISTS turn_cursor (
  session_id               TEXT PRIMARY KEY,
  materialized_through_seq INTEGER NOT NULL DEFAULT 0,  -- 마지막 물질화 때 본 최대 event seq
  min_event_seq_seen       INTEGER NOT NULL DEFAULT 0,  -- 완결성 앵커: 최초 물질화 때 세션의 MIN(seq)
  usage_epoch              INTEGER NOT NULL DEFAULT 0,   -- 세션 usage가 바뀔 때마다 증가 (비용 갱신 트리거)
  usage_epoch_seen         INTEGER NOT NULL DEFAULT 0,   -- 마지막 물질화 때 본 usage_epoch
  last_turn_seq            INTEGER NOT NULL DEFAULT 0,
  unattributed_cost_usd    REAL,                          -- 세션총 − Σ정착턴비용 (잔여 흡수)
  config_ver               INTEGER NOT NULL DEFAULT 0,
  session_ended            INTEGER NOT NULL DEFAULT 0,    -- sticky: 한번 1이면 유지
  frozen                   INTEGER NOT NULL DEFAULT 0,    -- 1 = events 불완전(트리밍) → 재파생 금지
  stale_config             INTEGER NOT NULL DEFAULT 0,    -- 1 = frozen인데 config_ver 낡음 (UI 표시)
  updated_at               INTEGER NOT NULL
);
```

`usage_through_ts`(max) 대신 **`usage_epoch`**(세션 usage 테이블이 insert/update될 때마다 증가하는
카운터)를 쓴다 — `usage.ts`는 트랜스크립트 메시지 시각이라 늦게 도착해도 값이 세션 max보다 작을 수
있고(서브 꼬리), `--rescan`은 ts·행수 불변으로 비용만 바꾸기 때문(부록 A-4·A-6). arrival 신호가 필요하다.

`usage` 테이블에 **`inserted_at INTEGER`** 컬럼을 v7에서 ALTER로 추가하고, INSERT와 on-conflict UPDATE
양쪽에서 `Date.now()`로 채운다. 세션의 `usage_epoch`는 "그 세션 usage의 `MAX(inserted_at)` 또는
`COUNT(*)`"로 싸게 파생한다(둘 다 insert·update 시 전진).

## 5. 물질화 파이프라인 — 조정(reconcile)·완결성·쓰기 규율

`title-sessions`/`startAutoTitler`를 본뜨되(CLI + 주기적 detached 자식), 세 가지를 강화한다.

**세션별 절차:**

1. 세션 events를 seq 순 로드(handleStatsTurns와 동일 쿼리). 동시에 현재 `MIN(seq)`도 읽는다.
2. **완결성 검사**: `turn_cursor`가 있고 `현재 MIN(seq) > min_event_seq_seen`이면(앞부분 트리밍됨) →
   `frozen=1`로 표시하고 **재파생하지 않는다**(기존 행 보존). config 낡았으면 `stale_config=1`만 세운다.
   커서를 `config_ver=현재`로 **절대 전진시키지 않는다**(부록 A-7).
3. `all = buildTurns(rows, now)` → `attachTurnCosts(all, sid)`.
4. §3 게이팅으로 정착 집합 산출.
5. **조정 upsert(reconcile), 한 트랜잭션**: 먼저
   `DELETE FROM turns WHERE session_id=? AND turn_seq NOT IN (<정착 turn_seqs>)`
   (재세그멘테이션으로 사라진 turn_seq의 유령 행 제거, 부록 A-1) → 그 다음 정착 턴 upsert.
   트랜잭션은 **세션당 짧게** 잡는다(§5 쓰기 규율).
6. `unattributed_cost_usd := 세션_usage_총비용 − Σ(정착 턴 cost_usd)` 로 저장한다
   (드롭된 열린 턴/미귀속 잔여를 모두 흡수 — 항등식 보존, 부록 A-9).
7. 커서 갱신: `materialized_through_seq=max(seq)`, `min_event_seq_seen`(최초만 기록), `usage_epoch_seen`,
   `last_turn_seq`, `config_ver`, `session_ended`(sticky), `updated_at`.

**후보 선정(증분):** 아래 중 하나 & `frozen=0` —

- `max(events.seq) > materialized_through_seq` (새 활동), 또는
- `usage_epoch > usage_epoch_seen` (usage insert/update/rescan → 비용 갱신), 또는
- `config_ver ≠ 현재` (임계값 변경 → flag 재계산), 또는
- **미해소 Pre가 `TURN_ORPHAN_MS`를 지난 세션**(시간 경과로 정착 가능해짐, §3), 또는
- 커서 없음.

**쓰기 규율(부록 A-10):** 단일 WAL writer + `busy_timeout 5s`에서 background 쓰기가 ingest flush를 굶기면
**spill=이벤트 유실**이 난다. 그래서 (a) 물질화는 **세션당 짧은 트랜잭션**으로 쪼개고, (b) 세션 사이에
yield + jitter 백오프, (c) `--rebuild`/config 스윕은 **배치+스로틀**(틱당 `--limit`, 세션 간 소휴면)로
throughput을 제한해 ingest·retention 체크포인트가 항상 락을 얻게 한다.

**주기:** 기동 후 ≤30s 첫 패스, 이후 `OBS_TURN_MAT_INTERVAL`마다 detached 자식. CLI 경로는
auto-materializer를 안 켬(재귀 없음). `materialize-turns --all --rebuild`로 전량 재구축.
`ingest-usage --rescan`은 **완료 후 touched 세션의 usage_epoch를 전진**시켜 재물질화를 유발한다(부록 A-4).

## 6. 비용: 지연 일관성 + 한계 명시

usage는 비동기로 채워진다. `usage_epoch` 전진이 늦은 usage(서브 꼬리 포함)를 잡아 재물질화 →
`attachTurnCosts` 재계산 → 조정 upsert가 수렴한다. cost는 재계산으로 **감소할 수도** 있고(재귀속),
upsert-overwrite가 이를 정확히 반영한다(부록 A-9의 트리거가 핵심).

**한계(부록 A-8):** compaction API 호출 등은 `usage`에 안 잡힌다 → 그 턴 cost는 **하한**이며
`usage_epoch`로도 영영 안 채워진다. 그러므로 §6은 "true total로 수렴"을 **약속하지 않는다**. 물질화 cost는
**"귀속된 usage 비용(compaction/미기록 호출 제외)"**으로 라벨하고, `cost_has_gap=1` 턴은 UI에서 표시한다.
`unattributed`는 §5-6대로 `세션총 − Σ정착`이라, 세션총 자체가 compaction을 놓치는 만큼만 누락된다.

## 7. Retention 상호작용 — 유효창 붕괴 방지 + turns 예산 분리

- `turns`·`turn_cursor`는 `runRetention`(events만 트리밍)이 건드리지 않는다 → 물질화 턴이 이벤트보다
  오래 산다. **단 이는 트리밍 전에 물질화됐을 때만 성립**한다.
- **핵심 위험(부록 A-11)**: retention은 나이(`MAX_AGE_MS`)뿐 아니라 **행수(`MAX_ROWS`)·크기(`MAX_DB_BYTES`)로도
  나이 하한 없이 축출**한다. 버스트/다세션이면 유효창이 분 단위로 붕괴해 물질화 전에 events가 사라진다.
  v1이 아카이브를 안 읽으면 **영구 구멍**. 대응(택1 이상, v1 필수):
  - (a) seq/size 축출 **직전에** 해당 seq 범위 세션의 정착 턴을 **강제 물질화**(로그만으론 불충분), 또는
  - (b) retention이 **미물질화 정착 턴을 든 세션의 events 트리밍을 보류**, 또는
  - (c) `--rebuild-from-archive`(아카이브 NDJSON 재인제스트)를 **v1에 포함**해 유실 턴 복구 경로 확보.
  - 추가: 유효창(newest-`MAX_ROWS` span, 또는 size-loop 발동)이 물질화 cadence×안전계수 밑으로 내려가면 **경보**.
- **turns 저장 예산(부록 A-12)**: `usedBytes()`는 파일 전체(turns 포함)를 재고, size-loop는 events만
  지운다. turns는 안 지워져 freelist에 안 가므로 **영구 증가세로 events 예산을 잠식**(연 ~2.9GB 추정) →
  유효창을 더 좁혀 위 (a~c) 위험을 악화. 대응: **turns/turn_cursor에 자체 retention(나이 또는 개수)**을
  주거나, events size-cap 회계에서 turns 페이지를 제외(`MAX_DB_BYTES`를 `page_count − turns_pages` 기준으로).

## 8. Config/임계값 버저닝

각 턴 행·커서에 `config_ver`(기동 시 TURN_FLAGS의 안정 해시)를 저장한다. 변경 시 불일치 세션이 후보가
되어 재계산 — **단 `frozen=0`(완전한 events)일 때만**. `frozen=1`이면 재파생 대신 `stale_config=1`만 세워
UI가 "현재 임계값 이전 데이터"로 표시한다(부록 A-7). tool/wait/gap·카운트는 임계값 무관, flag만 바뀌지만
턴 전체 재계산이 단순·저렴하다.

## 9. Fleet 집계 API + 라벨 정합

`GET /stats/fleet-turns` — 순수 SQL over `turns`(+ flags_mask JS 디코드).

- **params**: `window`(started_at), `app`, `group`(app | bucket | flag | none), `bucket_ms`.
- **totals**: `settled_turns`, `human_turns`(auto NULL), `avg_calls_per_turn`, `dup_call_turn_ratio`,
  `gap_heavy_turns`, `mega_turns`, `interrupted_turns`, `orphan_turns`,
  `total_cost_usd`, `total_subagent_cost_usd`, `unattributed_cost_usd`,
  `cost_incomplete_turns`(cost_has_gap=1 수).
- **by_flag**: `[{flag, turns, cost_of_those_turns_usd}]`.
- **series / by_app**: 시간버킷·프로젝트별 롤업.

효율 비율은 가상 턴(n=0) 제외, 옵션으로 auto 턴 제외. 비용 총합엔 포함.

**라벨 정합(부록 A-13)**: "turns"는 세 곳에서 정의가 다르다 — Sessions 탭 = 기간 내 **프롬프트 수(열린 턴
포함)**, 드릴 = buildTurns 턴수(열린 턴 포함), Fleet = **정착 턴(열린 턴 제외, 가상 #0 포함)**. 같은 단어를
재사용하지 않는다: Sessions 컬럼은 "prompts", Fleet은 "settled turns"로 라벨하고, 각 행에
`materialized_at`/완결성(`frozen`·`stale_config`)을 노출해 retention 후 불일치가 "버그가 아니라 events
트리밍"으로 읽히게 한다.

**"flag별 비용"의 의미**: 절감액이 아니라 "그 flag를 보인 턴들의 비용 합"(주의 신호·상한). 다중 flag 턴은
중복 계상되어 `Σ by_flag ≠ total`임을 UI 라벨로 경고.

## 10. UI: Fleet Turns 탭

- 상단 카드: settled turns, avg calls/turn, dup-call 턴 %, gap-heavy %, mega %, total cost, unattributed,
  cost-incomplete 턴 수.
- 시계열(avg calls/turn, dup 비율), by-flag 표, by-app 표. 드릴 클릭 → 기존 뷰로 필터.
- 완결성 배지: `frozen`/`stale_config`/`cost_has_gap` 표시. JS는 CSP상 `/app.js` 별도 서빙.

## 11. 롤아웃 (단계별)

- **1단계**: 스키마 v7(`turns`, `turn_cursor`, `usage.inserted_at`), 게이팅·조정·완결성·쓰기규율 물질화기,
  `materialize-turns` CLI(`--all --rebuild`, `--rebuild-from-archive`), auto-materializer, retention
  강제-물질화 훅. 테스트: 게이팅(미해소 Pre 미정착), 조정 삭제(사라진 turn_seq 유령 제거), 결정론적
  orphan, usage_epoch 재물질화, `--rescan` 재물질화, frozen 세션 재파생 금지, config 스윕이 frozen 무시,
  unattributed 항등식, v6→v7 마이그레이션, 쓰기 스로틀 하에서 ingest spill 없음. UI 없음.
- **2단계**: `/stats/fleet-turns` + 테스트(합성 + 라이브 사본에서 derive-on-read 합과 대조, **동일 `now`로**).
- **3단계**: Fleet Turns UI 탭 + 완결성 배지 + 툴팁.

## 12. 열린 질문

- 강제-물질화(a) vs 트리밍 보류(b) vs rebuild-from-archive(c) — v1에서 어느 조합을 필수로? (권장: a+c.)
- `turns` 자체 retention 정책(나이 vs 개수)과 events 예산 회계 분리 방식.
- `SETTLE_IDLE_MS`·`TURN_ORPHAN_MS`·`OBS_TURN_MAT_INTERVAL` 기본값 튜닝.
- "낭비 비용" 프레이밍(주의 신호)을 사용자가 어떻게 원하는지 확인.

## 부록 A. 적대적 검증 결과 (뒤집힌 가정)

3방향 병렬(세그멘테이션/비용/retention) 검증. 판정: 2× BROKEN-as-written, 1× SOUND-WITH-FIXES →
아래 수정으로 **SOUND-WITH-FIXES**. 각 항목 = [뒤집힌 v1 가정] → [v2 대응].

1. **upsert-only가 사라진 turn_seq를 안 지움 → 유령·중복 계상.** queued-merge(1743-1748)·arrival-race
   (1755-1761)가 증분 패스 간 턴 경계를 재분류하면 turn_seq가 사라지는데 v1은 삭제 안 함. → §5-5 **조정
   upsert(DELETE NOT IN + upsert, 한 txn)**.
2. **orphan/pending이 `now` 의존 + 노화 트리거 없음 → 정착 턴이 "pending"으로 동결**(1814,
   TURN_ORPHAN_MS=600s). → §3 정착 시 **결정론적 orphan** + §5 시간 기반 재검토 트리거.
3. **session-wide Pre/Post 페어링으로 늦은 Post가 정착 턴의 tool_ms·gap·flag를 변경**(1711,1877,1983) →
   불변성 가정 거짓. → §3 **미해소 Pre가 있으면 미정착**(Post 도착/orphan 확정까지).
4. **`usage_through_ts=max(ts)`가 늦은 usage를 놓침** — 서브 꼬리 ts는 세션 중간(<max), `--rescan`은
   ts·행수 불변인데 비용 변경(1060-1077). → §4.2 **`usage.inserted_at` + `usage_epoch`** 워터마크,
   `--rescan`→epoch 전진.
5. **post-stop subagent 꼬리 시간이 정착 후 자람**(1878-1890). → §4.1 **`subagent_ms` 컬럼 미채택**
   (`subagent_calls`만).
6. **`usage.ts` 비단조**(Date.parse||Date.now 폴백, 1100) → max 워터마크 부적합. → 위 4와 동일 대응.
7. **config_ver 전량 재계산이 트리밍된 세션을 덮쳐 유령·열화 + stale를 "정합"으로 오도.** → §4.2/§5-2
   **완결성 앵커 `min_event_seq_seen` + `frozen`**: 앞부분 트리밍 시 재파생 금지, config 낡으면
   `stale_config`만.
8. **compaction 비용이 usage에 없어 "true total 수렴" 거짓**(collector 사각지대). → §6 수렴 **불약속** +
   `cost_has_gap` 라벨.
9. **드롭된 열린 턴 비용이 turns·unattributed 어디에도 없음 → 항등식 영구 깨짐**(특히 #51 non-SessionEnd).
   → §5-6 **`unattributed := 세션총 − Σ정착`** + idle 마지막 턴 정착 허용.
10. **단일 WAL writer + busy_timeout 5s에서 `--rebuild` 스윕이 ingest flush를 굶겨 spill=이벤트 유실**
    (609,618). → §5 **짧은 per-session txn + 백오프 + 스로틀**.
11. **retention이 ROW/SIZE로도(나이 하한 없이) 축출 → 유효창 분 단위 붕괴, 물질화 전 유실**(565-577,
    MAX_ROWS/MAX_DB_BYTES). → §7 **seq/size 축출 전 강제 물질화 / 트리밍 보류 / rebuild-from-archive + 경보**.
12. **turns가 `MAX_DB_BYTES`를 잠식(연 ~2.9GB) → 이벤트 예산·유효창 축소**(usedBytes=파일 전체, 532). →
    §7 **turns 전용 예산/​retention**.
13. **"turns"가 3곳 3정의로 라벨 충돌**(Sessions=windowed 프롬프트, 드릴=buildTurns, Fleet=정착). →
    §9 **라벨 분리 + 완결성 노출**.
