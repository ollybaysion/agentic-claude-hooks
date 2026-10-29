# TraceResponse 칸 표

`GET /api/fdc/v1/agent/trace/{messageId}` 의 응답 칸이다.
원본은 BE 레포 `src/main/java/fdc/agent/contract/trace/response/TraceResponse.java` 와 그 주석이 가리키는 domain 파일(`trace/domain/Step.java` · `Call.java` · `Failure.java` · `ToolRun.java`, `runner/domain/RetrieveRequest.java` · `Failure.java`)의 주석이다.
뜻은 그 주석을 옮겼다. 이 표와 BE 주석이 다르면 BE 주석이 원본이다.

"없다" 는 JSON 에 그 칸이 빠진다는 뜻이다(`@JsonInclude NON_NULL` · `NON_EMPTY`).

## 1. 머리

| 칸 | 뜻 |
| --- | --- |
| `messageId` | 답 id(`msg_` + 시각 36진) |
| `requestId` | `x-request-id`. 앱 로그의 줄과 잇는다 |
| `conversationId` | FE 가 보낸 대화 id, 해석하지 않는 글. 보내지 않았거나 다시 돌린 답이면 없다 |
| `rerunOf` | 다시 돌린 답이면 원래 답의 `messageId`. 사용자 답이면 없다 |
| `steps[]` | 걸음, 걸은 순서(2절) |
| `failure` | 답이 실패했으면 그 오류(7절). 성공 · 출구면 없다 |
| `request` | 답을 만든 요청(1.1). 이 칸이 생기기 전의 기록이거나 읽지 못하면 없다 |
| `answer` | 답 조각 원문(8절). 이 칸이 생기기 전의 기록이거나 읽지 못하면 없다 |

### 1.1 `request`

| 칸 | 뜻 |
| --- | --- |
| `agent` | 요청의 에이전트. agent API 는 늘 없다(에이전트 없는 턴) |
| `messages[]` | `{role, content, …}`. 모르는 role 의 줄은 빠져 있다. 질문은 마지막 `role: user` 줄이다 |
| `settings` | 요청의 `settings`(`effort` · `model` · `query` 등) |
| `budget` | effort 의 값 위에 요청의 budget 을 덧씌운 것 |
| `agentRequests[]` | 설비마다의 요청(설비 · 기간 · 입력) |
| `documents[]` | 읽은 문서. 그래프가 던져 답이 실패했으면 없다 |
| `note` | 다시 돌릴 때 적은 메모 |

## 2. `steps[]` — 걸음

| 칸 | 뜻 |
| --- | --- |
| `step` | 걸음 번호, 1 부터 |
| `node` | 노드 이름 |
| `next` | 다음 노드. 던져서 끝났으면 없다 |
| `startedAt` | 노드를 부른 시각 |
| `ms` | 노드가 돈 시간 |
| `wrote` | 노드가 칠판에 쓴 것. 출구면 `inputRequests` |
| `exit` | 출구로 끝냈으면 사용자에게 보인 글. 아니면 없다 |
| `calls[]` | 이 걸음 안의 LLM 호출, 부른 순서(5절) |
| `procured[]` | 이 걸음이 판정한 조달 요청, 판정한 순서(3절). retrieve 밖의 걸음은 없다. 이 모양으로 읽지 못한 줄은 빠진다 |
| `planning` | 플로우 플래닝 근거(4절). retrieve_data 걸음에만 있다 |
| `agentSelect` | 에이전트 추천 근거(6절). 요청에 에이전트가 없는 턴의 extract 걸음에만 있다 |

노드(`runner/graph/Nodes.java`):

| 노드 | 하는 일 |
| --- | --- |
| `initialize` | 요청의 agent 가 등재됐는지 확인한다 — 코드만 돈다 |
| `extract` | 설비 없는 질문에서 설비 · 기간 · 값 · 에이전트 후보를 뽑아 추출 카드로 끝낸다 — LLM 한 번 |
| `retrieve_document` | 질문에 맞는 지식 조각을 고른다 |
| `retrieve_data` | 질문에 맞는 데이터 항목을 고른다 |
| `retrieve` | 진입 스킬의 조달을 에이전트 입력마다 돌린다 — 코드만 돈다 |
| `synthesize` | 툴 루프로 답을 쓴다 |
| `verify_answer` | 답이 근거에 서 있는지 LLM 이 검토한다 |
| `recommend_question` | 답에 이어 물을 후속 질문을 LLM 한 번으로 만든다 |
| `END` | 노드가 아니다 — 루프가 멈추는 표지다 |

## 3. `procured[]` — 조회 판정 한 줄

retrieve 가 조달 요청 하나를 판정한 한 줄이다.

| 칸 | 뜻 |
| --- | --- |
| `eqp` | 에이전트 입력 카드의 설비 |
| `queryId` | 조회 id. 변환 노드의 막힘이면 그 노드 id 다. 조회 없이 붙여넣은 표면 없다 |
| `round` | 데이터 판 차례(`RunnerState#dataRound`) |
| `origin` | 요청을 낸 곳(3.1). 출처 없이 만든 요청이면 없다 |
| `args[]` | 문장의 바인드 이름 순, 그 뒤에 문장 밖의 인자. 값이 없는 이름도 든다(3.2) |
| `verdict` | 판정(3.3) |
| `run` | 실행(3.4). 돌리지 않고 막혔으면 없다 |

### 3.1 `origin`

갈래마다 쓰는 칸만 차고 나머지는 없다.

| 칸 | 뜻 |
| --- | --- |
| `kind` | `md_own`(에이전트 md 의 조회) · `md_link`(에이전트와 link 하나로 이어진 md 의 조회) · `fallback`(에이전트 쪽 조회가 하나도 열리지 않아 더한 등재 md 전부의 조회) · `llm`(synthesize 의 LLM 이 낸 요청) · `pasted`(사람이 카드에 붙여넣은 표) |
| `md` | 조회가 적힌 md 이름. md_own · md_link |
| `key` | 붙여넣은 표의 카드 입력 키. pasted |
| `step` | 요청을 낸 synthesize 걸음 번호. llm |
| `call` | 그 걸음 안의 LLM 호출 번호. llm |
| `index` | synthesize 답의 `dataRequests` 안의 차례, 0 부터. llm |

### 3.2 `args[]`

| 칸 | 뜻 |
| --- | --- |
| `name` | 바인드 이름 |
| `value` | 값. 값이 없으면 없다 — 판정이 missing 으로 말한다 |
| `source` | 값이 온 곳. 값이 없거나 출처 없이 채웠으면 없다 |
| `source.kind` | `card`(카드 입력) · `table`(이번 턴에 도착한 결과 표) · `pasted`(사람이 카드에 붙여넣은 표) · `llm`(synthesize 의 LLM 이 적은 값) |
| `source.key` | 카드 입력 키. card · pasted. 설비 바인드를 카드의 설비로 채웠으면 설비 키 |
| `source.inputKind` | 카드 입력의 종류 — `text` · `many` · `duration` · `eqp`(카드의 설비). card |
| `source.table` | 값을 낸 결과 표 id. table |
| `source.column` | 값을 낸 열 — 표가 낸 이름 그대로다. table · pasted |
| `source.step` | 값을 적은 synthesize 걸음 번호. llm |
| `source.call` | 그 걸음 안의 LLM 호출 번호. llm |

### 3.3 `verdict`

막힘 · 실패의 칸은 갈래마다 쓰는 칸만 있다.

| 칸 | 뜻 |
| --- | --- |
| `kind` | `arrived`(결과 표가 칠판에 들었다) · `blocked`(사람이 카드로 푸는 막힘) · `failed`(오류 — 답에 "조회 실패" 로 적힌다) |
| `blocked` | 막힘의 갈래. kind 가 blocked 일 때만: `missing` · `choose` · `by_user` · `time_range` · `unusable_answer` |
| `args` | missing: 값을 어디서도 못 찾은 `:var` 이름. time_range: `:start_time` · `:end_time` 의 문장 표기 — 다시 물을 이름. unusable_answer: 빈 바인드 하나 |
| `maxMinutes` | time_range: 이 조회의 시간 범위 상한(분) |
| `table` | time_range: 상한을 정한 표(배포 기본 상한이면 없다). choose: 후보를 낸 표의 이름 |
| `problem` | time_range: 무엇이 어긋났는지 — 사람에게 보인다 |
| `reason` | by_user: 사람용 사유 문구 — 라인 코드를 담는다 |
| `sql` | by_user: 완성 문장 — 값을 박았고, 사용자가 그대로 돌린다 |
| `columns` | by_user: 기대 컬럼 — 문장의 SELECT 목록. unusable_answer: 받은 표의 열 |
| `name` | choose: 문장의 `:var` 이름 — 고를 컬럼. unusable_answer: 답이 실린 입력 키 |
| `message` | failed: 실패 메시지 그대로 — 가공하지 않는다 |

failed 줄의 완성 SQL 과 예외 전체(원인 사슬 · 스택)는 아직 없다. 들어오면 `verdict.sql` · `verdict.detail` 자리다.

### 3.4 `run`

| 칸 | 뜻 |
| --- | --- |
| `ms` | 조회가 돈 시간. 붙여넣은 표면 없다 |
| `resultId` | 칠판에 든 결과의 id. 못 얻었으면 없다 |
| `rows` | 결과의 행 수. 못 얻었으면 없다 |
| `truncated` | 행이 잘렸다. DB 에서 받지 않았으면 false |
| `sql` | DB 에 보낸 문장. DB 에서 받지 않았으면 없다 |
| `reused` | 다시 쓴 앞 턴 표의 이름. 새로 받았으면 없다 |

## 4. `planning` — 플로우 플래닝

플로우 플래닝 한 번의 근거다. 모델 호출 자체는 그 걸음의 `calls` 에 있다.

| 칸 | 뜻 |
| --- | --- |
| `mode` | `guided`(에이전트 없는 턴. 규칙 그래프를 짓고 모델이 그 부분 그래프를 고른다) · `agent-llm`(에이전트 턴, 모델이 그린 플로우) |
| `question` | 질문 원문 |
| `rewritten` | 검색 · 모델에 넣은 다시 쓴 질문. 원문 그대로였으면 없다 |
| `cached` | 담아 둔 계획을 꺼냈다 — 그때 아래 칸은 담아 둘 때의 것 그대로다 |
| `ms` | 이번 플래닝이 걸린 시간 |
| `candidates[]` | 끝 조회 후보, 검색 순위 순. agent-llm 이면 빈 목록 |
| `rule` | 규칙 역추적의 결과. agent-llm 이면 md 에 적힌 플로우 |
| `model` | 모델 답의 판정. 모델을 부르지 않았으면(후보 0) 없다 |
| `final` | 최종 플로우. 그래프가 비어 문서 답으로 갔으면 없다 |
| `empty` | 그래프가 비어 문서 답으로 갔다. 아니면 칸이 없다 |
| `emptyReason` | 끝 조회 후보가 없던 까닭 — `no_queries`(등재된 조회가 없다) · `below_threshold`(조회가 모두 점수 문턱 아래다). empty 일 때만 있다 |

| 칸 | 뜻 |
| --- | --- |
| `candidates[].rank` | 검색 순위, 1 부터 |
| `candidates[].id` | 조회 id |
| `candidates[].md` | 그 조회가 적힌 md 이름 |
| `candidates[].title` | 조회 제목. 없으면 id |
| `candidates[].score` | 검색 점수(BM25 · 임베딩 순위의 RRF 합) |
| `candidates[].binds` | 받는 값 — 문장의 바인드 이름, 나온 순서 |
| `candidates[].outputs` | 내는 열 — SELECT 목록의 이름. 읽지 못했으면 빈 목록 |
| `rule.flow` · `rule.mermaid` | 규칙 그래프와 그 펜스 글. 상태 · 행 수가 없다 |
| `rule.inputs` | 입력 노드가 된 바인드 — 사람이 카드로 준다 |
| `rule.cards` | 설비 카드 · 기간 카드가 채우는 바인드(설비 · 라인 · 시간 범위) |
| `rule.dropped[]` | 잇지 않은 caller 후보 `{id, reason}`. reason: `self`(받는 조회 자신이 낸다) · `cycle`(이으면 순환) · `depth`(끝 조회에서 간선 4 개를 넘는다) |
| `model.mermaid` | 모델이 낸 펜스 글. 모델이 답하지 못했으면 없다 |
| `model.accepted` | 그 답을 최종 플로우로 썼다. 아니면 규칙 그래프(agent-llm 이면 md 플로우)를 썼다 |
| `model.errors` | 틀린 곳 — 문법 · 후보 밖 노드 · 간선 · 플로우 검사 오류. 썼으면 빈 목록 |
| `final.flow` · `final.mermaid` | 최종 플로우와 그 펜스 글 |
| `final.source` | `model`(모델 답) · `rule`(규칙 그래프) · `md`(md 에 적힌 플로우, agent-llm 에서 모델 답이 틀렸다) |

## 5. `calls[]` — LLM 호출

LLM 호출 한 번이다. 루프는 바퀴마다 한 줄이다.

| 칸 | 뜻 |
| --- | --- |
| `call` | 걸음 안의 호출 번호, 1 부터 |
| `kind` | `prose` · `structured` · `loop` · `embed` 중 하나 |
| `answer` | 답의 모양 이름. 산문 · 임베딩이면 없다 |
| `round` | 루프 바퀴, 0 부터. 루프가 아니면 없다 |
| `startedAt` | 보낸 시각 |
| `ms` | 답이 올 때까지 |
| `sent` | 보낸 messages 전문(`[{role, content, …}]`, role 은 `system` · `user` · `assistant` · `tool`). 임베딩이면 글 목록 |
| `tools` | 내민 툴 이름 |
| `received` | 받은 답. 보내다 실패했으면 없다 |
| `error` | 보내다 던졌거나 답을 읽지 못한 사유. 없으면 없다 |
| `toolRuns[]` | 답이 부른 툴을 돌린 것, 부른 순서 |
| `toolRuns[].name` | 툴 이름 |
| `toolRuns[].args` | 모델이 준 인자 |
| `toolRuns[].result` | 모델에 되실은 결과. 툴이 던졌으면 그 사유 |
| `toolRuns[].startedAt` · `ms` | 툴을 부른 시각 · 툴이 돈 시간 |

모델 이름 · 토큰 수(`promptTokens` · `completionTokens`)는 BE 기록 파일에는 있다. 이 응답에는 아직 없다.

## 6. `agentSelect` — 에이전트 추천

요청에 에이전트가 없어 질문으로 켜진 main 에이전트를 추천한 근거다.

| 칸 | 뜻 |
| --- | --- |
| `question` | 질문 원문 |
| `rewritten` | 검색에 넣은 다시 쓴 질문. 원문 그대로였으면 없다 |
| `candidates[]` | 검색에 든 에이전트 전부, 검색 순위 순: `rank` · `agent` · `title` · `score` · `passed`(점수 문턱을 지났다 — BM25 에 걸렸고 유사도가 하한 이상이다) |
| `threshold` | 점수 문턱: `minSimilarity`(임베딩 코사인 하한. 0 이면 유사도로 거르지 않는다) · `below`(문턱으로 떨어진 에이전트 수) |
| `recommended` | 추천한 에이전트 이름, 순위 순, 많아야 셋 |
| `reason` | `recommended`(추천했다) · `below_threshold`(모두 점수 문턱 아래다) · `no_agents`(켜진 main 에이전트가 없다) |

## 7. `failure` — 걸음 예외

| 칸 | 뜻 |
| --- | --- |
| `step` | 던질 때 돌던 걸음 번호. 걸음 밖에서 던졌으면 없다 |
| `node` | 그 걸음의 노드. 걸음 밖이면 없다 |
| `type` | 예외 클래스 이름 |
| `message` | 예외 메시지 |
| `causes` | cause 사슬, 바깥부터. 줄마다 `클래스: 메시지` |
| `stack` | 전체 스택 |

## 8. `answer` — 답 조각

`POST /api/fdc/v1/agent/answer` 응답의 `answer` 와 같은 모양(`AnswerBody`)이다.

| 칸 | 뜻 |
| --- | --- |
| `text` | 답 글 |
| `finishReason` | 끝난 까닭: `stop` · `length`(답 검토를 넘지 못했다) · `no_source`(출처가 모자라 "모른다" 로 끝났다) |
| `verdict` | 답 검토: `ok`(답이 근거에 서 있으면 true. 검토 LLM 이 실패해도 true) · `reason`(실패 이유 — 다음 synthesize 의 `<retry>` 에 실린다) · `round`(검토 차례, 1 부터). 검토 없이 끝났으면 null |
| `recommendQuestion` | 추천 질문 |
| `agent` | 답한 에이전트 |
| `sources` | 출처 |
| `inputRequests` | 되묻기 카드 |
| `agentRequests[]` | 설비마다 값 · 표 · `flow`. 기록에서는 표마다 앞 3 행과 행 수만 든다 |
