---
name: fdc-md-migrate
argument-hint: "[모은 폴더]"
description: >-
  FDC 에이전트 md 들을 옛 구조에서 starter 항목 참조 구조로 옮길 때 쓴다. 여러 에이전트 md(domain-skill ·
  domain)가 같은 조회(설비 기본 정보 등)를 자기 ## 데이터 에 따로 들고 있을 때, starter 문서의 항목과
  같은 조회가 흩어져 있을 때 읽는다. AKG 에서 starter · 에이전트 md 를 rev 와 함께 모으기, 중복 찾기 스크립트
  dupes.mjs(같은 조회 · 비슷한 조회 · starter 로 올릴 후보 · 옛 id 를 적은 자리), 사람 확인, 무리 하나 고치는 차례
  (노드 이름 · 항목 지우기 · 범위 줄 · 열 확인 · chart · 글 · 다른 문서), check-flow --starter= 검사, 올리는 순서
  (starter 먼저 · --rev · flowWarnings), BE /starters 의 needs 확인, 되돌리기, 손으로 지은 예의 전후를 담는다.
---

# fdc-md-migrate

옛 구조의 에이전트 md 들을 starter 항목 참조 구조로 옮긴다.

- **옛 구조:** 에이전트 md 마다 같은 조회를 자기 `## 데이터` 에 따로 든 꼴이다. 예: 설비 기본 정보를 md 셋이 저마다 든다.
- **새 구조:** 그 조회는 starter 문서에 한 번만 있다. 에이전트 md 의 흐름 조회 노드가 그 항목 id 를 적는다([`fdc-agent-md`](../fdc-agent-md/SKILL.md) 7.2절).
- **옛 id:** 에이전트 md 에서 지울 항목의 id 다. **새 id:** 그 자리에 적을 starter 항목의 id 다.

ASK 항목 · `@묶음` 은 더 옛 꼴이다. 그 꼴은 [`fdc-agent-md`](../fdc-agent-md/SKILL.md) 11절이 맡는다. 이 스킬의 차례 2 에서 먼저 옮긴다.

근거(2026-11-12): BE #252(`feat/starter-needs`, head `bbefc13`) · AKG #116(`feat/flow-starter-reference`, head `398f291`).
두 PR 이 머지된 뒤에 쓰는 스킬이다. 9절의 전후는 두 브랜치의 체크아웃과 그 위에 띄운 AKG · BE 서버로 돌린 것이다.

다른 스킬과 나누기:

| 할 일 | 스킬 |
| --- | --- |
| 흩어진 같은 조회를 starter 항목 참조로 옮긴다 | 이 스킬 |
| starter 문서 한 장을 쓴다 · 항목을 더한다 | [`fdc-starter-md`](../fdc-starter-md/SKILL.md) |
| 에이전트 md 의 흐름 문법 · 검사 · 오류 코드 | [`fdc-agent-md`](../fdc-agent-md/SKILL.md) |
| ASK 항목 · `@묶음` 옮기기 | [`fdc-agent-md`](../fdc-agent-md/SKILL.md) 11절 |

## 1. 준비

| 준비 | 쓰는 곳 |
| --- | --- |
| AKG 체크아웃. 셸 변수 `AKG_DIR` | `dupes.mjs` 의 읽기 함수 · node 검사 · `akg` CLI |
| BE 체크아웃 `FDC_BE` 와 JDK 21 `JAVA_HOME` | `scripts/check-flow --starter=` · `scripts/reload.sh` |
| `AKG_SERVER` · agent 토큰 `AKG_TOKEN` | 모으기 · 올리기([`akg-push`](../akg-push/SKILL.md) 1절) |
| admin 한 사람 | 꺼진 문서 켜기 |

BE 가 없으면 검사는 node 검사로 한다([`fdc-agent-md`](../fdc-agent-md/SKILL.md) 9절).

## 2. 차례

1. 모은다: starter 문서 전부와 에이전트 md 전부를 한 폴더에 받는다. 문서마다 rev 를 적어 둔다(3절).
2. ASK 항목 · `@묶음` 이 있으면 [`fdc-agent-md`](../fdc-agent-md/SKILL.md) 11절로 먼저 옮긴다. `dupes.mjs` 의 "읽지 못한 에이전트 문서" 줄이 그 md 를 알린다.
3. 중복을 찾는다: `dupes.mjs` 를 돌린다(4절).
4. 사람에게 표를 보인다. 무리마다 고칠지 확인받는다. 확인받은 무리만 고친다.
5. 무리마다 고친다(5절). 옛 id 를 적은 자리를 다 고친다(6절).
6. 검사한다: 모든 md 를 한 번에 넘긴다(7절).
7. 올린다: starter 문서 먼저, 그다음 에이전트 md 다(8절).
8. BE 에 반영하고 확인한다: `/starters` 의 `needs` 를 본다(8절).
9. 틀어지면 되돌린다(9절 끝).

## 3. 모으기

폴더 꼴은 `<폴더>/<타입>/<id>.md` 다. `dupes.mjs` 가 이 꼴을 읽는다. 받은 json 도 같은 자리에 둔다.

```bash
D=migrate-$(date +%Y%m%d)
for type in starter domain-skill domain; do
  mkdir -p "$D/$type"
  akg list "$type" | while read -r doc rev _; do
    id=${doc#*/}
    curl -sS -H "Authorization: Bearer $AKG_TOKEN" "$AKG_SERVER/api/docs/$type/$id" > "$D/$type/$id.json"
    jq -j '.json.body.markdown' "$D/$type/$id.json" > "$D/$type/$id.md"
    echo "$type/$id $(jq -r .rev "$D/$type/$id.json") $(jq -r .json.status "$D/$type/$id.json")" >> "$D/revs.txt"
  done
done
```

- `akg list <타입>` 은 한 줄에 `<타입>/<id> <rev> <녹임 rev|->` 를 낸다.
- `jq -j` 는 끝 줄바꿈을 더하지 않는다. 받은 md 가 AKG 본문과 바이트로 같다(2026-11-12 `cmp` 로 확인).
- `revs.txt` 한 줄은 `<타입>/<id> <rev> <status>` 다. 8절의 `--rev` 와 9절의 되돌리기가 이 파일을 쓴다.
- 받은 폴더는 고치지 않는다. 고칠 md 는 다른 폴더에 복사해 고친다. 받은 폴더가 되돌리기의 원본이다.

## 4. 중복 찾기: dupes.mjs

```bash
AKG_DIR="$AKG_DIR" node "<이 스킬 폴더>/dupes.mjs" "$D"          # 표
AKG_DIR="$AKG_DIR" node "<이 스킬 폴더>/dupes.mjs" "$D" --json   # 같은 내용의 json
```

스크립트는 읽기만 한다. 항목은 AKG 체크아웃의 읽기 함수로 읽는다:
`src/skill-data-ids.mjs`(항목) · `src/skill-sections.mjs`(절 · 펜스) · `src/flow/agent-md.mjs`(흐름 노드 · 거부) ·
`src/table-class.mjs`(읽는 표) · `src/sql-bind.mjs`(바인드 · select 열).

### 무리를 가르는 규칙

SQL 은 **견주는 꼴**로 바꿔 견준다. 작은따옴표 글은 그대로 둔다. 그 밖에서:

1. `--` 주석과 `/* */` 주석을 뗀다.
2. 영문자를 소문자로 바꾼다.
3. 공백 묶음을 공백 하나로 줄인다.
4. `, ( ) = < > !` 양옆의 공백을 뗀다.
5. 앞뒤 공백과 끝 `;` 를 뗀다.

| 무리 | 규칙 | 뜻 |
| --- | --- | --- |
| 같은 조회 | 에이전트 md 항목의 견주는 꼴이 starter 항목의 견주는 꼴과 같다 | 확정이다. 5절 "같은 조회" 차례로 고친다 |
| 비슷한 조회 | 같은 조회가 아니다. 읽는 표의 모음이 starter 항목과 같다. 바인드의 모음도 같다 | 후보다. 열 · 정렬 · 조건이 다를 수 있다. 사람이 정한다 |
| starter 로 올릴 후보 | 어느 starter 항목과도 같은 조회가 아니다. 같은 견주는 꼴의 항목이 에이전트 md 둘 이상에 있다 | 후보다. 사람이 starter 로 올릴지 정한다 |

- 읽는 표는 FROM · JOIN 뒤의 이름이다. 대문자로 셈하고 스키마 접두를 뗀다(AKG `tablesOfSql`).
- 바인드는 `:이름` 이다. 대소문자를 가리지 않는다.
- 비슷한 조회의 열 차이는 select 열로 센다(AKG `columnsOf`). `select *` 이거나 별칭 없는 식이 있으면 `알 수 없음` 이다.
- 표 · 바인드가 같고 글자 값만 다른 조회(`grade = 'A'` · `grade = 'a'`)는 다른 조회다. 비슷한 조회에도 들지 않는다.

### 표의 칸

| 칸 | 뜻 |
| --- | --- |
| starter 항목 · 에이전트 항목 | `id (파일:### 줄)` |
| 항목에 든 것 | 지울 항목의 `chart 펜스` · `산문`. 지우면 함께 사라진다(5절) |
| 옛 id 를 적은 자리 | 모은 문서 전부에서 옛 id 가 낱말로 나온 줄. 자리는 `흐름` · `항목 머리` · `chart` · `map` · `프리셋` · `글` 가운데 하나다. sql 펜스 안의 줄은 뺀다 |

### 출력 예

9절의 손으로 지은 예를 모은 폴더로 돌린 출력 그대로다(2026-11-12).

```text
## 같은 조회(확정)

| starter 항목 | 에이전트 항목 | 항목에 든 것 | 옛 id 를 적은 자리 |
| --- | --- | --- | --- |
| eqp_info (starter/eqp-basics.md:7) | equip_info (domain-skill/alarm-check.md:24) | chart 펜스 | domain-skill/alarm-check.md:16 흐름<br>domain-skill/alarm-check.md:18 흐름<br>domain-skill/alarm-check.md:22 글<br>domain-skill/alarm-check.md:24 항목 머리<br>domain-skill/recipe-check.md:17 흐름<br>domain-skill/recipe-check.md:19 흐름 |
| eqp_info (starter/eqp-basics.md:7) | eqp_base (domain-skill/interlock-check.md:22) | 없음 | domain-skill/interlock-check.md:16 흐름<br>domain-skill/interlock-check.md:18 흐름<br>domain-skill/interlock-check.md:22 항목 머리<br>domain-skill/interlock-check.md:39 글 |

## 비슷한 조회(후보)

| starter 항목 | 에이전트 항목 | 표 · 바인드 | 에이전트에만 있는 열 | starter 에만 있는 열 | 항목에 든 것 | 옛 id 를 적은 자리 |
| --- | --- | --- | --- | --- | --- | --- |
| eqp_info (starter/eqp-basics.md:7) | eqp_model (domain-skill/recipe-check.md:23) | FDC_EQUIPMENT · :eqp_id | 없음 | eqp_name, line_id | 없음 | domain-skill/recipe-check.md:16 흐름<br>domain-skill/recipe-check.md:18 흐름<br>domain-skill/recipe-check.md:23 항목 머리 |

## starter 로 올릴 후보

| 에이전트 항목 | 표 · 바인드 | 옛 id 를 적은 자리 |
| --- | --- | --- |
| alarm_chamber (domain-skill/alarm-check.md:38)<br>chamber_list (domain-skill/interlock-check.md:31) | FDC_CHAMBER · :eqp_id | domain-skill/alarm-check.md:17 흐름<br>domain-skill/alarm-check.md:38 항목 머리<br>domain-skill/interlock-check.md:17 흐름<br>domain-skill/interlock-check.md:31 항목 머리 |
```

읽지 못한 에이전트 md 가 있으면 끝에 `## 읽지 못한 에이전트 문서` 와 `- 파일: 거부 글` 줄이 붙는다. 그 md 는 차례 2 로 먼저 옮긴다.

끝 코드:

| 코드 | 뜻 |
| --- | --- |
| 0 | 다 읽었다. 무리가 있어도 0 이다 |
| 2 | 인자가 틀렸다(`쓰는 법:` 줄). 또는 폴더 · starter 문서 · 에이전트 md · AKG 체크아웃이 없다(`dupes: …` 줄) |

## 5. 무리 하나 고치기

### 같은 조회

고칠 md 마다 이 차례를 한다. 새 id 는 무리의 starter 항목 id 다.

1. 흐름 펜스에서 옛 id 를 새 id 로 바꾼다. 노드 줄과 간선 줄 모두다.
2. 바꾼 뒤 같은 줄이 둘이 되면 하나를 지운다. 검사는 같은 간선 둘도 받는다. 읽기 쉽게 하나만 둔다.
3. `### 옛 id — 제목` 항목을 지운다. 머리 · 산문 · sql 펜스 · chart 펜스를 함께 지운다.
4. 범위 줄을 세운다. 새 id 의 바인드는 이 md 의 흐름이 채운다. 설비 바인드면 두 줄이다: `eqp-scope[[설비 범위]]` · `eqp-scope --> 새 id`.
5. 새 id 에서 나가는 간선마다 callee 의 바인드를 본다. 옛 항목의 열로 채우던 바인드가 starter 항목의 select 열에 다 있어야 한다.
6. 5 에서 빠진 열이 있으면 고치기를 멈춘다. 사람에게 되묻는다. starter 항목에 열을 더하면 그 항목을 쓰는 모든 md 의 표가 바뀐다.
7. 표의 "항목에 든 것" 이 `chart 펜스` 면 사람에게 묻는다. 버릴지, starter 항목으로 옮길지 정한다.
8. 표의 "항목에 든 것" 이 `산문` 이면 사람에게 묻는다. starter 항목 산문에 없는 뜻이면 이 md 의 본문 글로 옮긴다.
9. 표의 `글` 자리에서 옛 id 를 새 id 로 바꾼다.
10. 표의 다른 자리(다른 md 의 흐름 · `## 프리셋`)를 고친다. 다른 md 의 흐름이면 그 md 에서 1 · 2 · 4 · 5 를 한다.

- 5 의 열은 `select` 목록으로 본다. starter 항목이 `select *` 면 검사가 열을 모른다. 검사는 이 바인드를 지나간다.
  그때는 DB 스키마 문서나 표의 열 목록으로 사람이 확인한다.
- 이 md 가 옛 항목을 다른 곳에 쓰지 않았는지 7절 검사가 확인한다. 남은 옛 id 는 `UNKNOWN_ID` 로 나온다.

### 비슷한 조회

1. 표의 "에이전트에만 있는 열" 을 본다. `없음` 이 아니면 그 열을 쓰는 뒤 조회가 있는지 흐름에서 찾는다.
2. 쓰는 뒤 조회가 있으면 사람에게 묻는다. starter 항목에 열을 더하거나, 이 무리를 두고 간다.
3. 두 SQL 을 사람에게 나란히 보인다. 정렬 · 조건 · 열 순서가 다르면 표의 모양이 바뀐다.
4. 사람이 바꿔도 된다고 하면 "같은 조회" 차례로 고친다.
5. `알 수 없음` 칸이 있으면 select 열을 사람이 견준다.

### starter 로 올릴 후보

1. 사람과 starter 항목의 id · 제목 · 산문을 정한다([`fdc-starter-md`](../fdc-starter-md/SKILL.md) 3절).
2. id 는 무리 안의 옛 id 와 다르게 짓는다. 옛 id 가 에이전트 md 에 남은 동안 같은 id 로 starter 를 저장하면 409 `data_id_conflict` 다.
3. starter 문서에 항목을 더한다. SQL 은 무리의 SQL 하나를 쓴다.
4. 무리의 항목마다 "같은 조회" 차례로 고친다.

## 6. 옛 id 를 적는 자리

옛 id 를 지우면 아래 자리가 영향을 받는다. 사람이 쓴 자리는 고친다. 나머지는 낡는다.

| 자리 | 누가 쓰나 | 찾는 법 | 고치지 않으면 |
| --- | --- | --- | --- |
| 그 md 의 흐름 펜스 | 사람 | 표의 `흐름`(같은 파일) | `UNKNOWN_ID`. AKG 400 `flow_rejected` |
| 다른 에이전트 md 의 흐름 펜스 | 사람 | 표의 `흐름`(다른 파일) | 옛 주인을 올릴 때 `flowWarnings` 에 그 md 가 온다. BE 가 그 md 를 뺀다 |
| 지운 항목의 chart 펜스 · 산문 | 사람 | 표의 "항목에 든 것" | 항목과 함께 사라진다 |
| 본문 글 · 다른 항목의 산문 | 사람 | 표의 `글` | 모델이 읽는 md 원문이 없는 id 를 가리킨다 |
| starter 문서의 `## 프리셋` | 사람 | 표의 `프리셋` | AKG 경고 ``프리셋 `이름` 이 없는 항목 `id` 를 가리킨다.`` BE 는 그 id 를 프리셋에서 뺀다 |
| FE 대화 기록 · 작업대(브라우저 IndexedDB)의 표 `queryId` · 카드 키 | FE | 고칠 수 없다 | 다음 `/chat` 의 `retrieved[].queryId` · `inputs` 키가 옛 id 다. BE 가 맞추지 못한다. 그 조회를 다시 돌린다 |
| `/chat` 의 `starters` 에 든 옛 id | FE | 고칠 수 없다 | 400 `{"error":"starter_unknown","starter":id}` |
| 결과 표 이름 `{설비}_{조회 id}` | BE | 고칠 수 없다 | 앞 턴의 답 글 · 기록에 옛 이름이 남는다 |
| BE trace 기록 · 다시 돌리기 | BE | 고칠 수 없다 | 옛 요청을 다시 보내면 위 두 줄과 같다 |

- 첫째 · 둘째 · 다섯째 줄의 응답과 경고는 2026-11-12 에 돌려 보았다. 아래 네 줄은 BE · FE 코드에서 읽었다
  (`RunnerState.retrievedFor` · `ChatController` 의 `starter_unknown` · `RetrieveNode.nameOf` · FE `lib/workbench-idb.ts` · `lib/conversation-idb.ts`).
- DB 스키마 문서 · 검증 Set · 점수 기록 · 화면 카탈로그에는 조회 id 칸이 없다(AKG `schemas/`).

## 7. 검사

모든 md 를 한 번에 넘긴다. 고친 md 와 고치지 않은 md 를 다 넘긴다. starter 문서는 `--starter=` 로 넘긴다.
고친 폴더(3절 꼴)에서 돌린다.

```bash
shopt -s nullglob
JAVA_HOME=~/tools/jdk-21.0.11+10 "$FDC_BE/scripts/check-flow" $(printf -- '--starter=%s ' starter/*.md) domain-skill/*.md domain/*.md
```

- `nullglob` 은 빈 폴더의 `*.md` 를 지운다. 이 줄이 없으면 `domain/*.md` 가 글자 그대로 넘어가 `IO` 줄과 끝 코드 2 가 난다.
- 받은 공통 md `domain-skill/eqp-scope.md` 를 같이 넘겨도 된다. 2026-11-12 에 `OK domain-skill/eqp-scope.md` 였다.
- JDK 가 없으면 [`fdc-agent-md`](../fdc-agent-md/SKILL.md) 9절의 node 검사에 같은 인자를 준다.
- 그림 검사는 [`fdc-agent-md`](../fdc-agent-md/SKILL.md) 9절의 `check.mjs` 다.
- 고친 폴더로 `dupes.mjs` 를 다시 돌린다. 고친 무리가 표에서 빠졌는지 본다.

자주 보는 줄(2026-11-12, BE #252 체크아웃):

| 줄 | 까닭 | 고치는 꼴 |
| --- | --- | --- |
| `UNKNOWN_ID 노드 eqp_info: 이 md 의 SQL 항목도, 등재된 조회도 아니다` | `--starter=` 를 넘기지 않았다. 또는 starter 문서에 그 항목이 없다 | starter 문서를 넘긴다. 올릴 후보면 starter 에 항목을 더했는지 본다 |
| `UNSOURCED_VAR eqp_info 의 :eqp_id 를 채울 입력이 없다` | 범위 줄을 빠뜨렸다(5절 차례 4) | `eqp-scope[[설비 범위]]` · `eqp-scope --> eqp_info` 를 둔다 |
| `UNSOURCED_VAR interlock_data 의 :model_id 를 채울 입력이 없다` | starter 항목의 select 에 그 열이 없다(5절 차례 5) | 사람에게 되묻는다 |
| `DATA_ID_CLASH 데이터 항목 eqp_info 가 starter/eqp-basics.md 에도 있다` | 옛 항목을 지우지 않고 머리만 새 id 로 바꿨다 | 항목을 지운다(5절 차례 3) |

## 8. 올리기 · BE 확인

### 올리는 순서

1. starter 문서를 올린다. 새 항목이 먼저 등재 조회가 된다.
2. 다른 md 의 옛 id 만 적던 md 를 올린다. 이 md 는 새 id 를 가리킨다.
3. 옛 항목을 지운 md(옛 id 의 주인)를 끝에 올린다.
4. 올릴 때마다 등재 검사를 돌린다([`fdc-agent-md`](../fdc-agent-md/SKILL.md) 10절). `OK 등재 N` 이 아니면 멈춘다.

```bash
akg push starter/eqp-basics after/starter/eqp-basics.md --rev <revs.txt 의 rev> --note "starter 항목 더함"
akg push domain-skill/recipe-check after/domain-skill/recipe-check.md --rev <revs.txt 의 rev> --note "starter 항목 참조로"
```

- `--rev` 는 `revs.txt` 의 rev 다. 고친 md 의 바탕이 그 rev 라고 AKG 에 알린다. 거부 응답은 [`akg-push`](../akg-push/SKILL.md) 의 표로 읽는다.
- `akg push` 는 `flowWarnings` 를 찍지 않는다. 그래서 차례 4 의 등재 검사로 본다. 응답을 그대로 보려면 API 로 올린다([`fdc-agent-md`](../fdc-agent-md/SKILL.md) 10절).
- 순서를 어기면 저장은 끝난다. 응답에 `flowWarnings` 가 온다. 2026-11-12 에 3 을 2 보다 먼저 올린 응답이다:

```json
{"rev":"fd58233…","flowWarnings":[{"md":"recipe-check","errors":[{"line":0,"code":"UNKNOWN_ID","message":"노드 equip_info: 이 md 의 SQL 항목도, 등재된 조회도 아니다"},{"line":0,"code":"UNSOURCED_VAR","message":"recipe_list 의 :line_id 를 채울 입력이 없다"}]}]}
```

`flowWarnings` 의 `md` 를 바로 고쳐 올린다. 그 md 를 올리면 등재 검사가 `OK 등재 N` 으로 돌아온다.

### 꺼진 문서

- 올려도 문서의 `status` 는 그대로다. `revs.txt` 에서 `inactive` 였던 문서는 꺼진 채다.
- 꺼진 문서를 켤 때는 admin 이 starter 문서를 먼저 켜고 에이전트 md 를 다음에 켠다.

### BE 에 반영

1. `"$FDC_BE/scripts/reload.sh" [BE 주소]` 를 돌린다. 첫 줄은 `skills: source=akg outcome=fetched count=N` 이다.
2. BE 로그에 `WARN` 줄이 없는지 본다([`fdc-agent-md`](../fdc-agent-md/SKILL.md) 10절 "BE 에 반영").
3. 로그인한 세션으로 `GET /api/fdc/v1/starters` 를 부른다.
4. 옮긴 옛 id 가 `items[]` 에 없는지 본다.
5. 새 id 를 참조한 md 의 항목마다 `needs` 에 새 id 가 있는지 본다.

## 9. 손으로 지은 예

2026-11-12 에 지은 예다. starter `eqp-basics` 하나와 에이전트 md 셋이다.

| md | 옛 구조 |
| --- | --- |
| `interlock-check` | `eqp_base`(starter `eqp_info` 와 같은 조회, 대문자 · 주석 · 끝 `;`) · `chamber_list` |
| `alarm-check` | `equip_info`(같은 조회, 주석 · 줄바꿈, chart 펜스) · `alarm_chamber`(`chamber_list` 와 같은 SQL) |
| `recipe-check` | `eqp_model`(비슷한 조회: 열 둘 · `order by`) · 다른 md 의 `equip_info` 를 흐름에 적음 |

사람 확인: 같은 조회 둘은 고친다. `equip_info` 의 chart 펜스는 버린다. `eqp_model` 은 `eqp_info` 로 바꾼다. 챔버 목록은 starter 에 `chamber_info` 로 올린다.

`recipe-check` 의 흐름 전후:

```text
  eqp-scope[[설비 범위]]
  eqp-scope --> eqp_model
  eqp-scope --> equip_info
  eqp_model --> recipe_list
  equip_info --> recipe_list
  eqp-scope --> recipe_list
```

```text
  eqp-scope[[설비 범위]]
  eqp-scope --> eqp_info
  eqp_info --> recipe_list
  eqp-scope --> recipe_list
```

`interlock-check` 의 흐름 전후(항목 `eqp_base` · `chamber_list` 는 지웠다):

```text
  eqp-scope --> eqp_base
  eqp-scope --> chamber_list
  eqp_base --> interlock_data
```

```text
  eqp-scope --> eqp_info
  eqp-scope --> chamber_info
  eqp_info --> interlock_data
```

검사(옮긴 뒤, 고친 폴더에서):

```text
$ scripts/check-flow --starter=starter/eqp-basics.md domain-skill/interlock-check.md domain-skill/alarm-check.md domain-skill/recipe-check.md
OK starter/eqp-basics.md
OK domain-skill/interlock-check.md
OK domain-skill/alarm-check.md
OK domain-skill/recipe-check.md
```

`/starters` 전후(`id` · `group` · `needs` 만 싣는다):

| 옮기기 전 | 옮긴 뒤 |
| --- | --- |
| `eqp_info` common `[]` | `eqp_info` common `[]` |
| `setup_events` common `[]` | `chamber_info` common `[]` |
| `equip_info` optional `[]` | `setup_events` common `[]` |
| `alarm_chamber` optional `[]` | `alarm_list` optional `["eqp_info"]` |
| `alarm_list` optional `["equip_info"]` | `interlock_data` optional `["eqp_info"]` |
| `eqp_base` optional `[]` | `recipe_list` optional `["eqp_info"]` |
| `chamber_list` optional `[]` | |
| `interlock_data` optional `["eqp_base"]` | |
| `eqp_model` optional `[]` | |
| `recipe_list` optional `["eqp_model","equip_info"]` | |

옮기기 전에는 설비 정보가 첫 화면에 넷(`eqp_info` · `equip_info` · `eqp_base` · `eqp_model`)이다. 옮긴 뒤에는 `eqp_info` 하나다.

### 되돌리기

1. 되돌릴 문서마다 지금 rev 를 받는다: `curl -sS -H "Authorization: Bearer $AKG_TOKEN" "$AKG_SERVER/api/docs/<타입>/<id>" | jq -r .rev`.
2. 에이전트 md 를 먼저 되돌린다: `akg push <타입>/<id> "$D/<타입>/<id>.md" --rev <지금 rev> --note "되돌림"`.
3. starter 문서를 끝에 되돌린다. 먼저 되돌리면 새 항목을 참조하는 md 가 깨진다.
4. 등재 검사를 돌린다. `OK 등재 N` 인지 본다.
5. BE 에 반영한다.

- `$D` 는 3절에서 모은 폴더다. 그 md 가 옛 본문이다.
- `--rev` 는 지금 rev 다. `revs.txt` 의 rev 는 옮기기 앞의 rev 다.
- 2026-11-12 에 위 차례로 넷을 되돌렸다. 등재 검사는 `OK 등재 5` 였다. 받은 본문과 되돌린 본문이 `cmp` 로 같았다.
