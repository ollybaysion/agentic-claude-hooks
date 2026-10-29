---
name: fdc-answer-debug
argument-hint: "[messageId … | 질문 묶음.jsonl]"
description: >-
  검증 agent 가 FDC BE 에 질문을 보내고 틀린 답을 분석할 때 쓴다. 질문 묶음을 agent API
  (POST /api/fdc/v1/agent/answer)로 보내 답을 받는다. ok=false 이거나 답이 기대와 다르면 그 답의
  디버그 기록(GET /api/fdc/v1/agent/trace/{messageId}, TraceResponse 원문)을 읽는다.
  어느 걸음 · 어느 조회 · 어느 인자에서 어긋났는지 jq 로 짚는다. 까닭(input_required · query_failed ·
  no_source · verdict_failed · no_query · run_failed)마다 보는 곳 표, 묶음 결과 보고
  (POST /api/fdc/v1/agent/report)를 담는다.
---

# fdc-answer-debug

검증 agent(Claude Code · opencode)가 FDC BE 의 답을 검증하는 스킬이다.

- **답**: `POST /api/fdc/v1/agent/answer` 한 번의 응답이다. 답마다 `messageId` 가 있다.
- **기록**: 답 하나를 만든 디버그 기록이다. BE 의 `TraceResponse` 원문 그대로다. 걸음 · LLM 호출 · 조회 판정 · 예외가 든다.
- **까닭**: 답 응답의 `reason` 이다. `ok=false` 일 때 무엇이 실패했는지 말한다.

이 스킬은 답을 받고, 틀린 답의 기록을 읽고, 어긋난 곳을 짚고, 묶음 결과를 보고한다.

근거 파일(BE 레포 [ollybaysion/fdc-agent-be-spring](https://github.com/ollybaysion/fdc-agent-be-spring), 계약 v1.43~v1.44):

- `docs/agent-api.md`: 인증 · 답 · 보고 · 실패 까닭 · 응답 예.
- `src/main/java/fdc/agent/contract/trace/response/TraceResponse.java`: 기록의 모양. 칸 뜻은 이 파일의 주석이 원본이다.
- `src/main/java/fdc/agent/api/agent/AgentAnswerController.java`: 기록 읽기 길 `GET /api/fdc/v1/agent/trace/{messageId}`(BE PR feat/agent-trace, 계약 v1.44).
- `src/main/java/fdc/agent/runner/graph/Nodes.java`: 걸음의 노드 이름.

기록의 칸 표 전부는 [`reference/trace.md`](reference/trace.md) 에 있다.
BE 의 코드 이름 · 메시지는 "흐름" 이라고 적는다. 이 스킬의 "플로우" 와 같은 것이다.

다른 스킬과 나누기:

| 할 일 | 스킬 |
| --- | --- |
| 질문을 보내고 틀린 답의 기록을 읽고 보고한다 | 이 스킬 |
| 조회 SQL · 플로우 펜스 · 바인드를 고친다 | [`fdc-agent-md`](../fdc-agent-md/SKILL.md) |
| 조회 결과의 그래프(chart 펜스)를 고친다 | [`fdc-chart`](../fdc-chart/SKILL.md) |

## 1. 언제 쓰나

질문 묶음을 FDC BE 에 보내 답을 검증할 때 쓴다.

1. 질문 하나마다 답을 받는다(3절).
2. `ok=false` 인 답을 고른다. `ok=true` 여도 답 글이나 표가 기대와 다르면 고른다.
3. 고른 답마다 기록을 읽는다(4절).
4. 어긋난 곳을 **걸음 · 조회 · 인자** 셋으로 짚는다(5절).
5. 묶음을 다 돌린 뒤 보고 하나를 올린다(6절).

짚은 결과는 이 꼴로 적는다: `질문 — 까닭(messageId): 걸음 <node> · 조회 <queryId> · 인자 <name> — 무엇이 어긋났나`.

## 2. 준비

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `FDC_URL` | 없음(필수) | BE 주소. 예 `http://127.0.0.1:8090`. 끝에 `/` 를 붙이지 않는다 |
| `FDC_AGENT_TOKEN` | 없음(필수) | agent 비밀번호. 비밀번호 파일(`FDC_AUTH_USERS_FILE`)의 `group: agent` 줄 비밀번호다. Keycloak 서버에서는 client 역할이 agent 인 access token 이다 |
| `FDC_LINE` | 비움 | 질문 묶음에 `line` 이 없을 때 쓸 라인 id. 예 `L1` |

- 토큰은 셸 환경변수로만 둔다. 질문 묶음 · 결과 파일 · 보고 글에는 `$FDC_AGENT_TOKEN` 이름만 쓴다.
- `curl` · `jq` 를 쓴다.
- 결과 파일은 작업 폴더 하나(아래 예의 `run/`)에 모은다.

연결 확인:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$FDC_URL/api/fdc/v1/agent/report" \
  -H "Authorization: Bearer $FDC_AGENT_TOKEN" -H "Content-Type: application/json" -d '{}'
```

`400` 이면 연결 · 인증이 맞다(빈 몸이라 `name` 검사에 걸린다). `401` 이면 아래 표를 본다.

| 401 몸의 `message` | 까닭 | 할 것 |
| --- | --- | --- |
| `로그인이 필요합니다.` | `Authorization` 머리가 없다 | `-H "Authorization: Bearer $FDC_AGENT_TOKEN"` 을 싣는다 |
| `agent 비밀번호가 틀렸습니다.` | 비밀번호가 틀렸다. 또는 user · admin 줄 비밀번호를 실었다 | group agent 줄 비밀번호를 싣는다 |

Bearer 는 `/api/fdc/v1/agent/**` 에서만 받는다. 다른 경로에 Bearer 를 실으면 401 이다.

## 3. 질문 보내기

`POST $FDC_URL/api/fdc/v1/agent/answer` 로 질문 하나를 보낸다. 그래프가 돌면 응답은 늘 200 이다. 성공 · 실패는 `ok` 가 말한다.

요청 칸(`docs/agent-api.md` 3절):

| 칸 | 꼴 |
| --- | --- |
| `question` | 글. 필수 |
| `line` · `eqp` | 설비 하나. 둘 다 있거나 둘 다 없다 |
| `eqps` | `[{line, eqp}]`, 많아야 2개. `line` · `eqp` 와 같이 보내면 400 |
| `duration` | `{start, end}`, `yyyy-MM-ddTHH:mm` |
| `inputs` | `{키: 글}` 또는 `{키: [글, …]}`. 키는 플로우 입력 노드 id 나 바인드 이름(예 `snsr_id` · `lot_id`) |
| `settings` | `POST /chat` 의 `settings` 와 같다(`effort` · `model` · `query` 등) |

질문 하나:

```sh
mkdir -p run
curl -s -X POST "$FDC_URL/api/fdc/v1/agent/answer" \
  -H "Authorization: Bearer $FDC_AGENT_TOKEN" -H "Content-Type: application/json" \
  -d '{"question":"ETCH-01 어제 셋업 이벤트","line":"L1","eqp":"ETCH-01",
       "duration":{"start":"2026-10-28T00:00","end":"2026-10-29T00:00"},
       "inputs":{"snsr_id":"S-0007","evt_type":"S"}}' > run/a1.json
```

질문 묶음(`questions.jsonl`, 한 줄에 요청 몸 하나):

```sh
mkdir -p run
n=0
while IFS= read -r body; do
  n=$((n + 1))
  printf '%s' "$body" | jq -c --arg line "$FDC_LINE" 'if .line == null and .eqps == null and $line != "" and .eqp != null then .line = $line else . end' \
    | curl -s -X POST "$FDC_URL/api/fdc/v1/agent/answer" \
        -H "Authorization: Bearer $FDC_AGENT_TOKEN" -H "Content-Type: application/json" -d @- > "run/a$n.json"
done < questions.jsonl
```

응답 읽기:

```sh
jq '{ok, reason, detail, messageId,
     tables: [.tables[] | {name, queryId, columns, rows: (.rows | length)}]}' run/a1.json
```

| 칸 | 뜻 |
| --- | --- |
| `ok` | 성공이면 true |
| `reason` | 실패 까닭. 성공이면 null. 5절 표의 여섯 가운데 하나 |
| `detail` | 까닭의 자세한 글. 꼴은 까닭마다 다르다(5절) |
| `messageId` | 답 id. `msg_` 뒤 소문자 36진. 기록을 이것으로 읽는다 |
| `answer` | 디버그 페이지의 답과 같은 모양(`AnswerBody`): `text` · `finishReason` · `verdict` · `inputRequests` · `agentRequests` 등. `run_failed` 면 null |
| `tables[]` | 돌린 조회 결과 표 전부. 표마다 `name` · `title` · `sql` · `columns` · `rows`(행 전부) · `queryId`. 실패면 빈 목록 |

묶음의 실패만 고르기:

```sh
for f in run/a*.json; do
  jq -r --arg f "$f" 'select(.ok | not) | [$f, .messageId, .reason, (.detail // "")] | @tsv' "$f"
done
```

200 이 아닌 응답은 요청 모양이 틀린 것이다. 기록이 남지 않는다.

| 상태 | `error` | 할 것 |
| --- | --- | --- |
| 400 | `question_required` | `question` 을 채운다 |
| 400 | `eqp_ambiguous` | `line` · `eqp` 와 `eqps` 가운데 하나만 보낸다. `line` · `eqp` 는 둘 다 보낸다 |
| 400 | `duration_invalid` | `start` · `end` 를 둘 다 `yyyy-MM-ddTHH:mm` 로 보낸다 |
| 400 | `inputs_invalid` | `inputs` 의 값을 글이나 글 목록으로 보낸다 |
| 400 | `agent_requests_too_many` | `eqps` 를 2개씩 나눠 보낸다 |

## 4. 기록 읽기

`GET $FDC_URL/api/fdc/v1/agent/trace/{messageId}` 로 답 하나의 기록을 읽는다. 인증은 3절과 같다.

```sh
id=$(jq -r .messageId run/a1.json)
curl -s "$FDC_URL/api/fdc/v1/agent/trace/$id" -H "Authorization: Bearer $FDC_AGENT_TOKEN" > "run/$id.trace.json"
```

| 상태 | 몸 | 뜻 |
| --- | --- | --- |
| 200 | `TraceResponse` | 이 agent 가 부른 답의 기록이다 |
| 400 | `{"error":"invalid_message_id","message":"messageId 는 msg_ 뒤 소문자 36진 숫자입니다."}` | id 꼴이 틀렸다 |
| 404 | `{"error":"not_found","message":"그 답의 기록이 없습니다."}` | 기록이 없다. 또는 다른 계정 · 사람이 부른 답이다 |

기록의 큰 칸(칸 전부는 [`reference/trace.md`](reference/trace.md)):

| 칸 | 든 것 |
| --- | --- |
| `messageId` · `requestId` · `conversationId` · `rerunOf` | 답 머리. `requestId` 는 `x-request-id` 다. 앱 로그의 줄과 잇는다 |
| `request` | 답을 만든 요청 원문: `agent` · `messages` · `settings` · `budget` · `agentRequests` · `documents` · `note` |
| `steps[]` | 걸음, 걸은 순서. 걸음마다 `node` · `next` · `ms` · `calls[]`(LLM 호출) · `procured[]`(조회 판정) · `planning`(플로우 플래닝) |
| `failure` | 답이 실패했으면 그 오류: `step` · `node` · `type` · `message` · `causes` · `stack` |
| `answer` | 답 조각 원문(`AnswerBody`). 표는 앞 3 행과 행 수만 든다 |

아래 예는 기록 파일을 `T` 로 둔다: `T=run/$id.trace.json`.

### 요청 · 질문

```sh
jq '.request | {agent, settings, agentRequests,
     question: ([.messages[] | select(.role == "user")] | last | .content)}' "$T"
```

### 걸음 순서

```sh
jq -r '.steps[] | "\(.step) \(.node) → \(.next // "(던짐)") \(.ms)ms"' "$T"
```

노드 이름(`Nodes.java`): `initialize` · `extract` · `retrieve_document` · `retrieve_data` · `retrieve` · `synthesize` · `verify_answer` · `recommend_question` · `END`.
`next` 가 없는 걸음은 예외를 던져 끝났다. 그때 `failure` 를 본다.
`exit` 가 있는 걸음은 출구로 끝냈다. `exit` 는 사용자에게 보인 글이다(예: 되묻기 카드 글).

### 플로우 플래닝

`planning` 은 `retrieve_data` 걸음에만 있다.

```sh
jq '.steps[] | select(.planning) | .planning
    | {mode, question, rewritten, cached, empty, emptyReason,
       candidates: [.candidates[] | {rank, id, md, score, binds, outputs}],
       inputs: .rule.inputs, cards: .rule.cards, dropped: .rule.dropped,
       model: (.model | if . then {accepted, errors} else null end),
       final: (.final | if . then {source, mermaid} else null end)}' "$T"
```

- `candidates`: 끝 조회 후보, 검색 순위 순. `score` 는 BM25 · 임베딩 순위의 RRF 합이다.
- `emptyReason`: `no_queries`(등재된 조회가 없다) · `below_threshold`(조회가 모두 점수 문턱 아래다). `empty` 일 때만 있다.
- `model.accepted=false` 면 모델 답을 버리고 규칙 그래프를 썼다. 까닭은 `model.errors` 다.
- `final.source`: `model`(모델 답) · `rule`(규칙 그래프) · `md`(md 에 적힌 플로우).

### 조회 판정

`procured[]` 는 `retrieve` 걸음에 있다. 한 줄이 조달 요청 하나의 판정이다.

```sh
jq -r '.steps[] | .procured[]?
       | [.eqp, (.queryId // "-"), .round, .verdict.kind, (.verdict.blocked // ""),
          (.verdict.message // .verdict.problem // .verdict.reason // ""), (.run.rows // "")] | @tsv' "$T"
```

`verdict.kind` 로 거른다:

```sh
# failed — 조회가 돌다 실패했다. 메시지 한 줄만 있다
jq '.steps[].procured[]? | select(.verdict.kind == "failed") | {eqp, queryId, origin, args, message: .verdict.message}' "$T"

# blocked — 돌리지 않고 막혔다. 사람이 카드로 푸는 막힘이다
jq '.steps[].procured[]? | select(.verdict.kind == "blocked")
    | {eqp, queryId, blocked: .verdict.blocked, args: .verdict.args, maxMinutes: .verdict.maxMinutes,
       table: .verdict.table, problem: .verdict.problem, reason: .verdict.reason, sql: .verdict.sql}' "$T"

# arrived — 결과 표가 칠판에 들었다
jq '.steps[].procured[]? | select(.verdict.kind == "arrived")
    | {eqp, queryId, rows: .run.rows, truncated: .run.truncated, reused: .run.reused, sql: .run.sql}' "$T"
```

`verdict.blocked` 의 갈래:

| 값 | 뜻 | 볼 칸 |
| --- | --- | --- |
| `missing` | 값을 어디서도 못 찾은 바인드가 있다 | `verdict.args` |
| `choose` | 사람이 표의 행을 골라야 한다 | `verdict.name` · `verdict.table` |
| `by_user` | 사용자가 그대로 돌릴 완성 문장이다 | `verdict.reason` · `verdict.sql` · `verdict.columns` |
| `time_range` | 시간 범위가 조회 상한을 넘었다 | `verdict.args` · `verdict.maxMinutes` · `verdict.table` · `verdict.problem` |
| `unusable_answer` | 카드 답을 바인드로 쓸 수 없다 | `verdict.args` · `verdict.name` · `verdict.columns` |

### 인자 출처

```sh
jq -r '.steps[].procured[]? | (.queryId // "-") as $q | .args[]
       | [$q, .name, (.value // "(없음)"),
          (.source | if . then "\(.kind) \(.key // .table // "") \(.column // "")" else "-" end)] | @tsv' "$T"
```

`args[].source.kind`:

| 값 | 값이 온 곳 | 함께 있는 칸 |
| --- | --- | --- |
| `card` | 카드 입력. agent API 의 `line` · `eqp` · `duration` · `inputs` 가 이 갈래다 | `key` · `inputKind`(`text` · `many` · `duration` · `eqp`) |
| `table` | 이번 턴에 도착한 결과 표 | `table` · `column` |
| `pasted` | 사람이 카드에 붙여넣은 표 | `key` · `column` |
| `llm` | synthesize 의 LLM 이 적은 값 | `step` · `call` |

- `value` 가 없으면 값이 없는 바인드다. 판정은 `missing` 이다.
- `source` 가 없으면 값이 없거나 출처 없이 채웠다.
- 요청을 낸 곳은 `origin.kind` 다: `md_own`(에이전트 md 의 조회) · `md_link`(link 로 이어진 md 의 조회) · `fallback`(등재 md 전부의 조회) · `llm`(synthesize 의 LLM 이 낸 요청) · `pasted`(붙여넣은 표).

### LLM 호출

```sh
jq -r '.steps[] | .step as $s | .node as $n | .calls[]
       | [$s, $n, .call, .kind, (.answer // ""), (.round // ""), .ms, (.error // "")] | @tsv' "$T"
```

- `kind`: `prose` · `structured` · `loop` · `embed`. 루프는 바퀴마다 한 줄이다.
- `sent`: 보낸 messages 전문(`[{role, content}]`). 임베딩이면 글 목록이다.
- `received`: 받은 답. 보내다 실패했으면 없다. `error` 가 그 사유다.
- `toolRuns[]`: 답이 부른 툴(`query_table` 등)을 돌린 것. `name` · `args` · `result` · `ms`.

synthesize 가 본 `<data>` · `<unmet>` 블록:

```sh
jq -r '.steps[] | select(.node == "synthesize") | .calls[0].sent[]? | (.content? // empty) | strings' "$T" \
  | awk '/<unmet>/,/<\/unmet>/'
jq -r '.steps[] | select(.node == "synthesize") | .calls[0].sent[]? | (.content? // empty) | strings' "$T" \
  | awk '/<data>/,/<\/data>/'
```

- `<data>`: 표의 머리(컬럼과 타입 · 행 수 · 앞 몇 행 · 컬럼 통계)다. 머리에 없는 값은 모델이 `query_table` 로 꺼낸다.
- `<unmet>`: 조달에 값이 빠져 못 돈 항목이다. verify_answer 는 이 항목이 답에 "없다" · "조회 실패" 로 적혔는지 본다.
- 바퀴마다 보낸 글이 다르면 `.calls[0]` 을 `.calls[-1]` 로 바꿔 마지막 바퀴를 본다.

query_table 결과:

```sh
jq '.steps[] | select(.node == "synthesize") | .calls[].toolRuns[] | {name, args, result}' "$T"
```

### 걸음 예외

```sh
jq '.failure | if . then {step, node, type, message, causes, top: (.stack | split("\n") | .[:8])} else "예외 없음" end' "$T"
```

`causes` 는 cause 사슬, 바깥부터다. 줄마다 `클래스: 메시지` 다.

### 기록에 아직 없는 것

- 실패한 조회(`verdict.kind=failed`)의 **완성 SQL**. 기록에는 `verdict.message` 한 줄만 있다. 들어오면 `verdict.sql` 자리다.
- 실패한 조회의 예외 전체(원인 사슬 · 스택). 들어오면 `verdict.detail` 자리다. 그래프 전체가 던진 예외는 `failure` 에 있다.
- 답 머리의 `question` · `agent` · `effort` · `model` · `userId`. BE 의 기록 파일(`TraceMessage`)에는 있다. 이 응답(`TraceResponse`)에는 없다.
  질문은 `request.messages` 의 마지막 user 줄이나 `planning.question` 에서 읽는다. `effort` · `model` 은 `request.settings` 에서 읽는다.
- LLM 호출의 모델 이름 · 토큰 수. BE 의 기록 파일(`trace.domain.Call`)에는 있다. 이 응답의 `calls[]` 에는 없다.

## 5. 까닭별 보는 곳

BE 는 까닭을 위에서부터 차례로 보고, 처음 맞는 것을 낸다: `input_required` → `query_failed` → `no_source` → `verdict_failed` → `no_query` → 성공. `run_failed` 는 예외다.

| 까닭 | `detail` | 기록에서 볼 곳 | 짚는 법 · 할 것 |
| --- | --- | --- | --- |
| `input_required` | 카드 key 목록, 쉼표로 잇는다 | `procured[]` 의 `verdict.blocked`(`missing` 이면 `verdict.args`). 그 조회의 `args[]` 에서 `value` 가 없는 이름 | 1. detail 의 키를 본다. 2. 어느 조회의 어느 바인드가 비었나 찾는다. 3. 그 인자에 `source` 가 없는지 본다. 4. 그 키를 `inputs` 에 채워 다시 보낸다. detail 이 `eqp` 면 `line` · `eqp` 를 보낸다 |
| `query_failed` | 막힌 조회마다 `조회 id: 까닭`, 빗금(/)으로 잇는다 | `verdict.kind=failed` 줄의 `verdict.message` | 1. 메시지에서 표 이름 · 권한(`차단된 표: …` 는 `settings.query.blockedTables`) · 바인드 꼴을 본다. 2. 같은 조회가 다른 질문에서 `arrived` 였으면 그 `run.sql` 을 성공 예로 놓고 인자 값(`args[].value`)을 견준다. 3. 실패한 조회의 완성 SQL 은 기록에 아직 없다(4절 끝) |
| `no_source` | null | `planning` 의 `candidates` · `score` · `emptyReason`. `retrieve_document` 걸음 | 1. 후보가 비었나 본다. 2. 후보의 `id` · `md` 가 기대한 조회인가 본다. 3. 기대한 조회가 없으면 에이전트 md 의 조회 제목 · 설명에 질문의 낱말이 있나 본다 |
| `verdict_failed` | 검토 까닭 | `answer.verdict`(`ok` · `reason`). `verify_answer` 걸음의 `calls[].received` | 1. 검토 까닭을 읽는다. 2. `answer.text` 의 문장을 `tables[]` 의 행과 맞춰 본다. 3. `<unmet>` 항목이 답에 "없다" · "조회 실패" 로 적혔나 본다 |
| `no_query` | `돌린 조회가 없습니다.` | `planning` 의 `empty` · `emptyReason` · `candidates` · `model.errors` | 1. `emptyReason` 이 `no_queries` 면 등재된 조회가 없다. 2. `below_threshold` 면 조회가 모두 점수 문턱 아래다. 질문 낱말과 조회 제목을 견준다. 3. `model.accepted=false` 면 `model.errors` 를 읽는다 |
| `run_failed` | 예외 글 | `failure.type` · `failure.message` · `failure.stack` 첫 줄 · `failure.step` · `failure.node` | 1. 어느 걸음에서 던졌나 본다. 2. `causes` 의 맨 안쪽 줄을 본다. 3. `requestId` 로 앱 로그의 줄을 찾는다. `answer` 는 null 이다 |
| 답은 왔는데 틀림 | null | `synthesize` 걸음 `calls[].sent` 의 `<data>` · `toolRuns[]` 의 `query_table` 결과 · `procured[]` 의 `args[]` | 1. 답 글의 틀린 문장을 고른다. 2. 그 값이 `<data>` 의 어느 표 어느 행에서 왔나 찾는다. 3. 표가 틀렸으면 그 조회의 `args[].value` · `source` 를 본다. 4. 표가 맞으면 모델이 읽기를 틀렸다 |

## 6. 보고

묶음을 다 돌린 뒤 `POST $FDC_URL/api/fdc/v1/agent/report` 로 보고 하나를 올린다.

| 칸 | 꼴 |
| --- | --- |
| `name` | 검증 묶음 이름(예 `nightly`). 100자 이하. 필수 |
| `total` | 검증한 항목 수. 필수 |
| `passed` | 성공한 항목 수, 0 이상 `total` 이하. 필수 |
| `at` | 검증한 시각, ISO-8601. 없으면 받은 시각 |
| `note` | 메모, 1000자 이하 |
| `failures` | 실패한 항목. 많아야 200개, 항목마다 1000자 이하. 꼴은 `질문 — 까닭(messageId)` 이다. 짚은 곳(1절 꼴)을 뒤에 붙인다 |

```sh
jq -n --arg name nightly --argjson total 10 --argjson passed 7 \
  --argjson failures '["ETCH-01 어제 셋업 이벤트 — query_failed(msg_mvsyul1q): 걸음 retrieve · 조회 setup_events — 차단된 표: fdc_setup_event"]' \
  '{name: $name, total: $total, passed: $passed, failures: $failures}' \
  | curl -s -X POST "$FDC_URL/api/fdc/v1/agent/report" \
      -H "Authorization: Bearer $FDC_AGENT_TOKEN" -H "Content-Type: application/json" -d @-
```

- 받으면 200 `{"id":"rpt_…","at":"…"}` 다.
- 틀린 모양은 400 이다. 예 `{"error":"passed_invalid","message":"passed 는 0 이상 total 이하의 정수입니다."}`.
- admin 은 `/admin/coverage` 화면에서 보고를 본다(`GET /api/fdc/v1/admin/reports`).

## 7. 다른 곳에서 하는 일

| 일 | 하는 곳 |
| --- | --- |
| 다른 계정 · 사람이 부른 답의 기록 보기 | admin 이 `/admin/debug/{messageId}` 화면과 `GET /api/fdc/v1/trace/{messageId}` 로 본다. 모양은 이 스킬의 기록과 같다 |
| agent 호출 목록 보기 | admin 이 `/admin/answers` 에서 `userId` 가 agent 줄 id 인 줄을 본다 |
| 조회 SQL · 플로우 · 바인드 고치기 | AKG 의 에이전트 md 에서 고친다. [`fdc-agent-md`](../fdc-agent-md/SKILL.md) 스킬을 따른다 |
