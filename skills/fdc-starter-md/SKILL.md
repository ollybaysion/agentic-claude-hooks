---
name: fdc-starter-md
argument-hint: "[starter.md …]"
description: >-
  FDC 첫 화면의 starter 문서(AKG 타입 starter 의 md)를 쓰고 검사하고 올릴 때 쓴다.
  여러 에이전트 md 가 같이 쓰는 조회나 사람이 첫 화면에서 먼저 고를 바탕 데이터를 starter 에 둘 때 읽는다.
  무엇을 starter 에 두나, 문서 틀(# 제목 · ## 데이터 항목 · ## 프리셋), 항목 id 규칙(domain-skill · domain ·
  starter 에 걸쳐 하나), 제목 · 산문이 첫 화면에서 하는 일, 바인드, kind · major · group 이 정해지는 곳,
  BE 검사 scripts/check-flow --starter= 와 AKG node 검사, akg push starter/<id>, 올린 뒤 확인
  (queryWarnings · /starters 의 needs · description), 좋은 표본과 흔한 실수를 담는다.
  에이전트 md 쪽 참조는 fdc-agent-md 7.2절, 옛 문서의 겹친 조회 옮기기는 fdc-md-migrate 가 맡는다.
---

# fdc-starter-md

FDC 첫 화면의 starter 문서 한 장을 쓰고, 검사하고, AKG 에 올린다.
**starter 문서**는 AKG 타입 `starter` 의 md 다. 첫 화면에서 사람이 에이전트를 고르기 전에 고를 데이터를 든다.
BE 는 starter 문서의 항목을 첫 화면 목록의 공통 항목으로 낸다. 에이전트 md 의 흐름은 그 항목 id 를 조회 노드로 적는다.

근거 파일(2026-11-12, 열린 PR 두 개의 브랜치):

- BE 레포 [ollybaysion/fdc-agent-be-spring](https://github.com/ollybaysion/fdc-agent-be-spring) #252
  (`feat/starter-needs`, head `bbefc13`, 계약 v1.65):
  - `src/main/java/fdc/agent/knowledge/tools/markdown/SkillMarkdownTool.java` 의 `starter`: starter 문서 읽기 · 거부 글.
  - `src/test/java/fdc/agent/knowledge/tools/markdown/StarterMarkdownTest.java`: 프리셋 줄 · 거부 예.
  - `src/main/java/fdc/agent/knowledge/KnowledgeService.java` 의 `starters` · `waitedBy`: 첫 화면 목록 · 필요 항목.
  - `src/main/java/fdc/agent/data/DataService.java` 의 `kindOf` · `majorOf`: 항목의 kind · major.
  - `scripts/check-flow`(`--starter=`) · `src/test/resources/starter-ref/`(공용 표본).
- AKG 레포 [ollybaysion/agent-knowledge-governance](https://github.com/ollybaysion/agent-knowledge-governance) #116
  (`feat/flow-starter-reference`, head `398f291`):
  - `schemas/starter/v1.schema.json`(body `{ name, markdown }`) · `examples/starter/eqp-basics.json`.
  - `src/flow/agent-md.mjs` 의 `readStarter`: BE 와 같은 읽기 · 거부 글.
  - `src/starter.mjs`: 저장 경고(`queryWarnings`) · 프리셋 읽기. `server/data-ids.mjs`: 조회 id 겹침 · 등재 목록.

두 PR 이 머지된 뒤에 쓰는 스킬이다. 머지 전에는 두 브랜치의 체크아웃으로 검사한다.

다른 스킬과 나누기:

| 할 일 | 스킬 |
| --- | --- |
| starter 문서를 쓰고 · 검사하고 · 올린다 | 이 스킬 |
| 에이전트 md 의 흐름에서 starter 항목을 참조한다 · 필요 항목이 정해지는 법 | [`fdc-agent-md`](../fdc-agent-md/SKILL.md) 7.2절 |
| 옛 에이전트 md 들에 흩어진 같은 조회를 starter 로 옮긴다 | [`fdc-md-migrate`](../fdc-md-migrate/SKILL.md) |
| AKG 토큰 · `akg` CLI 전반 | [`akg-push`](../akg-push/SKILL.md) |

## 1. 무엇을 starter 에 두나

| 둔다 | 예 |
| --- | --- |
| 여러 에이전트 md 가 같이 쓰는 조회 | 설비 정보 · 챔버 목록 |
| 사람이 첫 화면에서 먼저 고를 바탕 데이터 | 셋업 이벤트 이력 |

- 한 조회는 한 곳에만 둔다. starter 문서에 둔 조회는 에이전트 md 에 다시 쓰지 않는다. 에이전트 md 는 그 항목 id 를 흐름에 적는다.
- 한 에이전트 md 만 쓰는 조회는 그 에이전트 md 의 `## 데이터` 에 둔다.
- 사내 저장소에서 같은 조회가 여러 에이전트 md 에 있으면 [`fdc-md-migrate`](../fdc-md-migrate/SKILL.md) 로 옮긴다.

## 2. 문서 틀

````markdown
# 설비 바탕 데이터

설비를 고르면 먼저 읽어 두는 데이터.

## 데이터

### eqp_info — 설비 정보

설비 한 대의 바탕 정보다. 한 행이 설비 한 대다.

```sql
select eqp_id, eqp_name, model_id, line_id from fdc_equipment where eqp_id = :eqp_id
```

### chamber_info — 챔버 목록

설비에 달린 챔버다. 한 행이 챔버 하나다.

```sql
select chamber_id, chamber_name from fdc_chamber where eqp_id = :eqp_id
```

## 프리셋

- 기본 점검: eqp_info, chamber_info
````

| 줄 · 절 | 뜻 |
| --- | --- |
| `# 제목` | 문서의 보이는 이름. `/starters` 의 `docTitle` 이다. 없으면 문서 id 를 쓴다 |
| 첫 문단 | 사람이 읽는 글이다. BE 는 읽지 않는다 |
| `## 데이터` | 항목을 든다. 문서 하나에 하나다. 흐름 펜스는 두지 않는다 |
| `### id — 제목` + 산문 + ```` ```sql ```` | 항목 하나. 에이전트 md 의 SQL 항목과 같은 문법이다([`fdc-agent-md`](../fdc-agent-md/SKILL.md) 3절) |
| `## 프리셋` | 목록 줄 `- 이름: id, id` 하나가 프리셋 하나다. 빠져도 된다 |

- 항목의 kind(`info` · `data`)는 md 에 적지 않는다. BE 가 SQL 이 읽는 표(FROM · JOIN)로 정한다.
  그 표의 활성 DB 스키마 문서(AKG `db-schema`)가 kind `data` 면 `data` 다. 그 밖은 `info` 다.
- 항목의 major 도 md 에 적지 않는다. 읽는 표의 DB 스키마 문서가 주요면 `true` 다.
- 항목의 group 은 문서 타입이 정한다. starter 문서의 항목은 `common`, 에이전트 md 의 항목은 `optional` 이다.
- 항목에 ```` ```chart ```` 펜스를 둘 수 있다. 문법은 [`fdc-chart`](../fdc-chart/SKILL.md) 다.
- map 항목(```` ```map ````)은 쓰지 않는다. BE 가 문서를 거부한다(6절).

## 3. 항목 id · 제목 · 산문

### id

1. id 는 `[A-Za-z][A-Za-z0-9_]*` 다. `_` 를 쓴다.
2. 조회 id 는 `domain-skill` · `domain` · `starter` 세 타입에 걸쳐 하나다.
   다른 문서에 같은 id 가 있으면 AKG 가 409 `data_id_conflict` 로 저장을 거부한다(7절).
3. id 는 에이전트 md 가 흐름에 적는 이름이다. 올린 뒤에 바꾸면 그 id 를 적은 문서를 다 고친다([`fdc-md-migrate`](../fdc-md-migrate/SKILL.md) 5절).

### 제목 · 산문

첫 화면은 이렇게 쓴다:

- 제목은 줄에 홀로 선다.
- 산문은 설명이 된다. 사람이 그 줄을 가리키면 산문이 뜬다.
- 에이전트 md 흐름의 조회 노드가 필요 항목을 정한다([`fdc-agent-md`](../fdc-agent-md/SKILL.md) 7.2절).

그래서 이렇게 쓴다:

1. 제목은 짧은 이름으로 쓴다. 예: `설비 정보` · `챔버 목록`.
2. 산문은 항목 머리와 `sql` 펜스 사이에 둔다. BE 는 항목 안의 펜스 밖 글을 산문으로 읽는다.
3. 산문은 한두 문장이다. 무슨 데이터인지 적는다. 한 행이 무엇인지 적는다. 예: `설비 한 대의 바탕 정보다. 한 행이 설비 한 대다.`
4. 산문이 없으면 `/starters` 의 `description` 이 `null` 이다. 첫 화면에서 그 항목의 뜻을 알 수 없다.

## 4. 바인드

| 바인드 | 채우는 것 |
| --- | --- |
| 설비 `:eqp_id` · `:equipment` · `:eqp` | 첫 화면에서 고른 설비 |
| 라인 `:line` | 고른 설비의 라인 |
| 그 밖(`:start_time` · `:end_time` 등) | 에이전트 조회와 같은 카드 입력 |

- 근거는 `SkillMarkdownTool.starter` 의 설명 글과 AKG `src/sql-bind.mjs` 의 설비 · 라인 바인드 이름이다.
- 에이전트 md 가 이 항목을 참조하면 그 md 의 흐름이 이 항목의 바인드를 채운다([`fdc-agent-md`](../fdc-agent-md/SKILL.md) 7절).
- info 항목이 설비 · 라인 밖의 바인드를 받으면 AKG 가 저장 경고를 낸다(7절). info 조회는 설비마다 한 번만 돈다.
- select 에 열을 적는다. `select *` 면 검사가 열을 모른다. 그러면 이 항목의 열로 채우는 뒤 조회의 바인드를 검사가 확인하지 못한다.
  2026-11-12 에 `eqp_info` 를 `select *` 로 바꿔 돌렸다. `eqp-scope --> interlock_data` 를 뺀 md 가 `OK` 였다. 열을 적으면 `UNSOURCED_VAR interlock_data 의 :start_time 를 채울 입력이 없다` 가 났다.

## 5. 검사

### BE: scripts/check-flow --starter=

starter 문서는 `--starter=파일.md` 로 넘긴다. 그 문서를 참조하는 에이전트 md 를 같이 넘긴다.

```bash
JAVA_HOME=~/tools/jdk-21.0.11+10 "$FDC_BE/scripts/check-flow" --starter=eqp-basics.md interlock-check.md alarm-check.md
```

- 파일 이름(확장자 뺌)이 starter 문서 id 다. AKG 의 문서 id 와 같게 짓는다.
- `--starter=` 는 여러 번 줄 수 있다.
- 에이전트 md 쪽 출력 줄의 뜻은 [`fdc-agent-md`](../fdc-agent-md/SKILL.md) 9절이다.

2026-11-12 BE #252 체크아웃에서 돌린 줄이다. 파일은 [`fdc-md-migrate`](../fdc-md-migrate/SKILL.md) 9절의 손으로 지은 예를 옮긴 뒤의 꼴이다.

```text
OK starter/eqp-basics.md
OK domain-skill/interlock-check.md
OK domain-skill/alarm-check.md
OK domain-skill/recipe-check.md
```

| 줄 | 뜻 |
| --- | --- |
| `OK 파일` | 그 문서에 오류가 없다 |
| `파일:1 MD 이름: 글` | BE 가 그 starter 문서를 읽지 않는다. 글은 6절 표의 거부 글이다. 그 문서를 참조하는 에이전트 md 에는 `UNKNOWN_ID` 줄이 같이 난다 |
| `에이전트.md:줄 DATA_ID_CLASH 데이터 항목 id 가 starter.md 에도 있다` | 에이전트 md 에 starter 항목과 같은 id 의 항목이 있다. 에이전트 md 의 그 항목을 지운다 |

### JDK 가 없을 때: AKG node 검사

[`fdc-agent-md`](../fdc-agent-md/SKILL.md) 9절의 node 한 줄에 `--starter=파일.md` 를 같이 넘긴다. check-flow 와 같은 줄을 낸다.
두 곳이 다르다. node 검사는 `DATA_ID_CLASH` 를 내지 않는다. 그 겹침은 AKG 저장이 409 로 잡는다.
node 검사는 문서 안의 같은 id 도 잡지 않는다. check-flow 는 `파일:1 MD 이름: 조달 id 가 중복입니다: a` 로 잡는다.

## 6. 거부 글

BE 가 starter 문서를 읽지 않는 까닭이다. AKG `readStarter` 도 같은 글을 낸다. check-flow 는 `파일:1 MD 글` 로 낸다.

| 거부 글(`이름` 은 문서 id) | 고치는 꼴 |
| --- | --- |
| `이름: 첫 선택 데이터 문서에는 변환 항목을 쓰지 않는다 — id` | map 항목을 지운다. 변환은 에이전트 md 의 흐름에 둔다 |
| `이름: ## 데이터 절에 항목이 없다` | `### id — 제목` 항목을 하나 이상 둔다 |
| ``이름: 데이터 항목에 id 가 없습니다 — `### id — 제목` 처럼 ascii id 를 제목 앞에 적으세요`` | `### id — 제목` 으로 쓴다 |
| `이름: ## 데이터 절은 하나다, 2 개다 — …` | 항목을 한 `## 데이터` 절에 모은다 |
| `이름: 조달 id 가 중복입니다: id`(BE) | 문서 안의 같은 id 하나를 바꾼다 |
| `이름 needs[id]: sql 펜스가 없다 — …` | 그 항목에 `sql` 펜스를 쓴다 |

starter 문서가 거부되면 BE 는 그 문서의 항목을 등재 조회로 세지 않는다. 그 항목을 참조하는 에이전트 md 가 모두 `UNKNOWN_ID` 로 빠진다.

## 7. AKG 에 올리기

### 문서

| 칸 | 값 |
| --- | --- |
| 타입 | `starter`. 봉투 `schema` 는 `starter/v1` |
| id · body `name` | 문서 id. 예: `eqp-basics` |
| body `markdown` | md 원문 전체 |
| `status` | `inactive`(초안) 다음 `active`(켬). BE 와 AKG 흐름 검사는 active 문서만 센다 |

### 차례

1. 5절 검사를 돌린다. 모든 파일이 `OK` 일 때까지 고친다.
2. 새 문서를 초안으로 올린다: `akg push starter/<id> <id>.md --create --note "<글>"`.
3. admin 이 AKG 화면에서 켠다(`activate`). agent 토큰의 켜기는 403 이다.
4. 있는 문서를 고칠 때는 rev 를 받는다: `curl -sS -H "Authorization: Bearer $AKG_TOKEN" "$AKG_SERVER/api/docs/starter/<id>" | jq -r .rev`.
5. 고친 md 를 올린다: `akg push starter/<id> <id>.md --rev <rev> --note "<글>"`.
6. 저장 응답의 `queryWarnings` · `flowWarnings` 를 읽는다(아래). `akg push` 는 이 둘을 찍지 않는다.
   그래서 올린 뒤 문서를 다시 받아 `queryWarnings` 를 본다. `flowWarnings` 는 [`fdc-agent-md`](../fdc-agent-md/SKILL.md) 10절의 등재 검사로 본다.

- starter 문서를 에이전트 md 보다 먼저 켠다. 꺼진 starter 의 항목은 등재 조회가 아니다. 그 항목을 참조하는 에이전트 md 를 켜면 `UNKNOWN_ID` 로 거부된다.
- 2026-11-12 AKG #116 체크아웃의 서버로 위 차례를 돌렸다. `akg push` 의 출력은 `pushed starter/eqp-basics (rev …)` 한 줄과 미러 안내 한 줄이다.

### 저장 응답

| 응답 | 뜻 | 하는 일 |
| --- | --- | --- |
| 409 `{"error":"data_id_conflict","conflicts":[{"id":"chamber_list","doc":"interlock-check","kind":"data"}]}` | 다른 문서(`doc`)에 같은 조회 id 가 있다. 아무것도 쓰지 않았다 | 다른 id 를 쓴다. 옮기기라면 [`fdc-md-migrate`](../fdc-md-migrate/SKILL.md) 의 차례를 따른다 |
| 400 `validation_failed`, `details: ["$.body.markdown: 데이터 항목 id 는 ascii 식별자([A-Za-z][A-Za-z0-9_]*)여야 합니다 — \"### 챔버 목록\""]` | 항목 머리에 id 가 없다 | `### id — 제목` 으로 쓴다 |
| 200 · `queryWarnings[]` | 저장은 끝났다. 경고 글이다(아래 표) | 경고마다 고칠지 정한다 |
| 200 · `flowWarnings: [{md, errors}]` | 저장은 끝났다. 이 저장 때문에 `md` 의 흐름이 깨진다. BE 가 그 md 를 뺀다 | 바로 고친다. 지운 항목을 되살리거나 그 md 를 고친다 |

`queryWarnings` 의 글(AKG `src/starter.mjs`, 2026-11-12 저장 응답에서 본 글):

| 경고 | 뜻 |
| --- | --- |
| ``항목 `eqp_info` 가 읽는 표 `FDC_EQUIPMENT` 에 활성 DB 스키마 문서가 없다. 이 표는 info 로 센다.`` | 표의 DB 스키마 문서가 없다. kind 가 `info` 다 |
| ``info 조회 `setup_events` 가 바인드 `start_time` · `end_time` 를 받는다. info 조회는 설비마다 한 번만 돌고 그 뒤에는 바인드 값이 달라도 첫 표를 다시 쓴다.`` | info 항목이 설비 · 라인 밖의 바인드를 받는다. 기간을 바꿔도 첫 표를 다시 쓴다 |
| ``프리셋 `기본 점검` 이 없는 항목 `eqp_base` 를 가리킨다.`` | 프리셋 줄의 id 가 이 문서에 없다. BE 는 그 id 를 프리셋에서 뺀다. id 가 모두 빠진 프리셋은 버린다 |
| ``항목 `to_model` 에 ```sql 펜스가 없다.`` | sql 펜스가 없는 항목이다. map 항목도 이 경고다 |

- map 항목이 든 starter 문서를 AKG 는 저장한다. BE 는 그 문서를 거부한다(6절).
  2026-11-12 에 저장했더니 `flowWarnings` 에 그 문서를 참조하는 에이전트 md 셋이 모두 왔다. 저장 전에 5절 검사로 잡는다.

## 8. 올린 뒤 확인

1. BE 에 반영한다: `"$FDC_BE/scripts/reload.sh" [BE 주소]`. 출력 첫 줄은 `skills: source=akg outcome=fetched count=N` 이다.
2. 로그인한 세션으로 `GET /api/fdc/v1/starters` 를 부른다.
3. `items[]` 에서 이 문서의 항목을 찾는다. `group` 이 `common`, `doc` 이 이 문서 id 다.
4. `description` 이 산문인지 본다. `null` 이면 산문을 쓴다(3절).
5. 이 항목을 참조하는 에이전트 md 항목의 `needs` 에 이 항목 id 가 있는지 본다.
6. `presets[]` 의 `items` 가 적은 id 인지 본다.

2026-11-12 BE #252 체크아웃(`./gradlew bootRun`, AKG 는 위 서버)에서 본 항목 둘이다:

```json
{"id":"eqp_info","title":"설비 정보","kind":"info","major":false,"tables":["fdc_equipment"],"group":"common","doc":"eqp-basics","docTitle":"설비 바탕 데이터","needs":[],"description":"설비 한 대의 바탕 정보다. 한 행이 설비 한 대다."}
{"id":"interlock_data","title":"Interlock 이력","kind":"info","major":false,"tables":["fdc_interlock_event"],"group":"optional","doc":"interlock-check","docTitle":"Interlock 점검","needs":["eqp_info"],"description":"모델별 Interlock 이력이다. `eqp_info` 의 `model_id` 로 찾는다."}
```

- common 항목의 `needs` 는 늘 빈 목록이다.
- 같은 조회 id 는 목록에 한 번 든다. starter 문서와 에이전트 md 에 다 있으면 common 쪽이다.

## 9. 표본

### 좋은 표본

2절의 틀이 좋은 표본이다. 2026-11-12 에 셋업 이벤트 항목을 더한 꼴로 check-flow `OK` 이고 AKG 에 저장했다.
에이전트 md 쪽 짝은 [`fdc-agent-md`](../fdc-agent-md/SKILL.md) 7.2절의 확정 예다.

- 제목은 짧은 이름이다. 산문은 두 문장이다.
- select 에 열을 적었다. 뒤 조회의 `:model_id` · `:line_id` 를 검사가 확인한다.
- 바인드는 설비 `:eqp_id` 하나다. info 바인드 경고가 나지 않는다.

### 흔한 실수와 고친 꼴

항목 머리에 id 가 없다. 거부 글 `데이터 항목에 id 가 없습니다 — …` 다.

```text
### 챔버 목록
```

```text
### chamber_info — 챔버 목록
```

변환 항목을 starter 에 두었다. BE 가 문서를 거부한다. 참조하던 에이전트 md 가 모두 빠진다.

````text
### to_model — 모델 맞추기

```map
model = model_id
```
````

변환은 그 변환을 쓰는 에이전트 md 의 `## 데이터` 에 둔다([`fdc-agent-md`](../fdc-agent-md/SKILL.md) 7.1절).

산문이 없다. 검사는 지나간다. 첫 화면에서 `description` 이 `null` 이다.

````text
### chamber_info — 챔버 목록

```sql
select chamber_id, chamber_name from fdc_chamber where eqp_id = :eqp_id
```
````

````text
### chamber_info — 챔버 목록

설비에 달린 챔버다. 한 행이 챔버 하나다.

```sql
select chamber_id, chamber_name from fdc_chamber where eqp_id = :eqp_id
```
````

프리셋이 없는 id 를 가리킨다. AKG 경고 ``프리셋 `기본 점검` 이 없는 항목 `eqp_base` 를 가리킨다.`` 다.

```text
- 기본 점검: eqp_info, setup_events, eqp_base
```

```text
- 기본 점검: eqp_info, setup_events
```
