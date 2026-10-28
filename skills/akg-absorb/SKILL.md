---
name: akg-absorb
argument-hint: "[<type>/<id> …]"
disable-model-invocation: true
description: >-
  AKG 의 1급 문서(domain-skill · db-schema)에 반영되지 않은 다른 타입 문서(voc · manual ·
  unclassified · 검증 결과 · 분석 기록 …)를 찾아 지식을 1급 문서에 추정 슬롯으로 넣는다.
  표 · 열 · 값의 뜻은 db-schema 슬롯 제안(akg propose)으로, 업무 규칙 · 판단 기준 · 용어는
  domain-skill 의 도메인 지식 조각(akg push)으로 넣는다. 확정은 사람이 AKG 화면에서 한다.
  사람이 /akg-absorb 로 부른다.
---

# akg-absorb

AKG 의 **1급 문서**는 `domain-skill`(에이전트 md)과 `db-schema`(표 문서) 둘이다.
**원본 문서**는 그 밖의 타입 문서다: voc · manual · unclassified · 검증 결과 · 분석 기록 …
이 스킬은 아직 녹이지 않은 원본 문서를 찾는다. 그 지식을 1급 문서에 넣는다.
**녹인 rev** 는 원본 문서를 마지막으로 녹인 때의 rev 다. 원본의 지금 rev 와 녹인 rev 가 다르면 다시 녹인다.

- 올리기 준비(`AKG_SERVER` · `AKG_TOKEN` · `/health`)는 [`akg-push`](../akg-push/SKILL.md) 1절이다.
- domain-skill md 의 틀 · 검사 · 거부 글은 [`fdc-agent-md`](../fdc-agent-md/SKILL.md) 다.
- 인자로 `<type>/<id>` 를 주면 그 원본 문서만 본다. 인자가 없으면 3절 절차 4의 목록 전체를 본다.
- `jq` 를 쓴다.

## 1. 넣는 곳

| 원본의 지식 | 넣는 곳 | 올리는 명령 | 확정 |
| --- | --- | --- | --- |
| 표 설명 | `db-schema/<표>` 의 슬롯 `purpose` | `akg propose db-schema/<표> proposal.json` | admin 이 리뷰 큐에서 채택한다(→ inferred). 사람이 AKG 화면에서 승격한다(→ confirmed) |
| 열 · 값의 뜻 | `db-schema/<표>` 의 슬롯 `columnDescs.<열>` | 위와 같다 | 위와 같다 |
| 업무 규칙 · 판단 기준 · 용어 | 가장 가까운 `domain-skill/<md이름>` 의 `## 도메인 지식` 아래 `### 소제목` 조각 | `akg push domain-skill/<md이름> <md이름>.md --rev <rev>` | 사람이 AKG 화면에서 조각을 읽고 고치거나 지운다 |

- domain-skill 의 body 는 `{ name, markdown }` 이다. 티어드 값 슬롯이 없다.
  그래서 domain-skill 에는 본문 수정(`akg push`)으로 넣고, 조각마다 근거 줄을 단다(5절).
- db-schema 슬롯 제안의 값은 슬롯 전체를 바꾼다. 그래서 `text` 는 지금 글에 새 뜻을 이어 쓰고,
  `evidence` 는 지금 근거에 원본을 더한다. 서버는 채택한 값의 tier 를 `inferred` 로 둔다.
- 지금 슬롯이 `confirmed` 면 제안하지 않는다. 7절 끝 보고의 "사람이 볼 것" 에 적는다.

## 2. 녹인 rev 를 두는 곳

녹인 rev 는 원본 문서 봉투의 선택 칸 `absorbed`(`{ rev, at, by }`)에 둔다. AKG #89 가 이 칸을 더했다.
이 칸을 올려도 원본 문서의 rev 는 그대로다.

| 일 | akg CLI | API |
| --- | --- | --- |
| 대상 목록 | `akg list [<type>] --stale-absorbed`. 한 줄 `<type>/<id> <rev> <녹인 rev\|->` | `GET /api/docs?absorbed=stale`(`type` · `q` 와 함께 쓸 수 있다) |
| 녹인 rev 올리기 | `akg absorb-mark <type>/<id> --rev <읽은 rev>`. 출력 `absorbed <type>/<id> (rev <rev>)` | `PUT /api/docs/<type>/<id>/absorbed`, 몸 `{ "rev": "<읽은 rev>" }` |

- `--stale-absorbed` 는 녹인 rev 가 없거나 지금 rev 와 다른 문서만 낸다.
- `absorb-mark` 에 `--rev` 가 없으면 서버의 지금 rev 로 올린다. 이 스킬은 늘 읽은 rev 를 준다.
- 읽은 rev 가 지금 rev 와 다르면 409 `unknown_base_rev`(`currentRev` 포함)다. 그 사이에 원본이 바뀌었다는 뜻이다.
  올리지 않고 둔다. 다음 실행 때 다시 대상이 된다. 몸에 `rev` 가 없으면 400 `rev_required` 다.

AKG 가 #89 이전 버전이면(`akg` 를 인자 없이 부른 쓰는 법에 `absorb-mark` 가 없으면) 녹인 rev 를
`~/.claude/akg-absorbed.json`(`{ "<type>/<id>": "<rev>" }`)에 두고, 목록은 `GET /api/docs` 의 `rev` 와 견준다.
이 파일은 미러 폴더 밖에 둔다. `akg sync` 가 미러 폴더 `~/.claude/akg/` 를 통째로 바꿔 끼우기 때문이다.

## 3. 절차

1. 붙는지 확인한다. `akg-push` 1절 절차 1~3 을 따른다.
2. AKG 버전을 본다: `akg 2>&1 | rg -q 'absorb-mark'`. 실패하면 2절 끝 문단의 로컬 파일 길을 쓴다.
3. 대상 목록을 받는다: `akg list --stale-absorbed | rg -v '^(domain-skill|db-schema)/'`.
   1급 둘을 뺀 타입의 문서 가운데 녹인 rev 가 없거나 다른 것이다.
4. 활성 문서만 남긴다. `akg list` 의 줄에는 status 가 없다. 그래서 status 는 API 로 본다.

   ```bash
   curl -sS -H "Authorization: Bearer $AKG_TOKEN" "$AKG_SERVER/api/docs?absorbed=stale" \
     | jq '[.docs[]
         | select(.status == "active" and .type != "domain-skill" and .type != "db-schema")
         | {type, id, rev, title, links}]' > targets.json
   ```

5. 목록을 사용자에게 보여 준다. 문서 수 · 타입별 수 · id 를 적는다.
6. 원본 문서마다 7~13 을 한다. `targets.json` 의 `rev` 를 그 문서의 **읽은 rev** 로 적어 둔다.
7. 원본을 md 로 읽는다: `curl -sS -H "Authorization: Bearer $AKG_TOKEN" "$AKG_SERVER/api/docs/<type>/<id>?format=md"`.
8. 지식을 1절 표의 셋으로 나눈다. 셋에 들지 않는 것은 "못 분류한 것" 에 이유와 함께 적는다.
   예: 한 번 일어난 일 · 사람의 요청만 있고 규칙이 없는 글.
9. 넣을 1급 문서를 4절 기준으로 고른다.
10. 1급 문서의 지금 내용을 받는다. 이미 같은 뜻이 있는 지식은 넣지 않는다.
11. db-schema 지식은 5절의 제안으로 올린다.
12. domain-skill 지식은 5절의 본문 수정으로 올린다. 가까운 domain-skill 이 없으면 6절의 새 초안으로 올린다.
13. 그 원본의 쓰기가 다 성공하면 녹인 rev 를 올린다: `akg absorb-mark <type>/<id> --rev <읽은 rev>`.
    넣을 지식이 없던 원본도 올린다. 쓰기가 하나라도 실패한 원본은 올리지 않는다. 다음 실행 때 다시 대상이 된다.
14. 7절 꼴로 끝 보고를 한다.

## 4. 가까운 1급 문서 고르기

위에서부터 보고, 처음 걸리는 것을 고른다. 같은 단에서 둘 이상 걸리면 사용자에게 선택지로 묻는다.

| 단 | db-schema | domain-skill |
| --- | --- | --- |
| 1. 원본의 링크 | 원본이 `[[db-schema/<표>]]` 로 가리키는 표(목록의 `links`) | 원본이 `[[domain-skill/<md이름>]]` 로 가리키는 md |
| 2. 같은 표 | 원본에 나온 표 이름. id 는 표 이름의 소문자다 | 1단 · 2단에서 고른 표를 조회에 쓰는 md: `GET /api/docs/db-schema/<표>` 의 `usedBy[]` |
| 3. 이름 · 키워드 | 원본에 나온 열 이름을 `catalog.columns[].name` 에 가진 표 | 원본의 낱말이 md 의 id · `title` · `keywords[].kw` 와 겹치는 md |

- db-schema 는 문서가 있어야 한다. 표 문서가 없으면 "못 분류한 것" 에 "표 문서 없음 — catalog-push 먼저" 로 적는다.
- 열은 그 표의 `catalog.columns[].name` 에 있어야 한다. 없으면 "못 분류한 것" 에 적는다.
- domain-skill 은 role 이 `main` 인 md 를 먼저 고른다. 목록의 domain-skill 항목에 `role` 이 있다.

## 5. 올리기

### db-schema: 슬롯 제안

1. 표 문서를 받는다: `curl -sS -H "Authorization: Bearer $AKG_TOKEN" "$AKG_SERVER/api/docs/db-schema/<표>" > 표.json`.
2. 지금 슬롯을 읽는다: `jq '.slots[] | select(.address == "columnDescs.<열>")' 표.json`.
   항목 칸은 `address` · `text` · `tier` · `evidence` 다.
3. `proposal.json` 을 쓴다. 슬롯 하나에 `text` 와 `evidence` 를 둔다.
   - `text`: 지금 글이 있으면 그 뒤에 새 뜻을 이어 쓴다. 지금 글이 없으면(scaffold) 새 뜻만 쓴다.
   - `evidence`: 지금 근거 + `<원본 type>/<원본 id>@<읽은 rev>`.
4. 올린다: `akg propose db-schema/<표> proposal.json`.
5. 출력을 읽는다. `proposed db-schema/<표>: <uuid>` 는 새 제안이다. `proposal already pending: <uuid>` 는 같은 제안이 이미 큐에 있다는 뜻이다.
6. 거부되면 `akg propose failed: propose failed: HTTP <코드> (<오류>)` 가 나온다.
   `invalid_slot_address` 는 슬롯 주소가 틀렸다는 뜻이다. `invalid_slot_value` 는 `text` 나 `evidence` 가 비었다는 뜻이다.
   `validation_failed` 는 문서 모양에 어긋난다는 뜻이다. 그 원본은 "쓰기 실패" 로 적는다.

### domain-skill: 본문 수정

1. 원본 md 와 rev 를 받는다(`akg-push` 2절의 `curl` · `jq`). 받은 rev 를 **md rev** 로 적는다.
2. `## 도메인 지식` 절 끝에 조각을 더한다. 절이 없으면 `## 데이터` 앞에 만든다.
   - 조각 하나 = `### 소제목` 하나다. 조각 id 는 `md이름/소제목` 이다. 소제목은 그 md 안의 소제목과 겹치지 않게 짓는다.
   - 조각 끝 줄은 근거 줄 `근거: <원본 type>/<원본 id> rev <읽은 rev>` 다.
3. 모양을 검사한다: `akg push domain-skill/<md이름> <md이름>.md --rev <md rev> --dry-run`.
4. `diff -u 원본.md <md이름>.md` 와 실제 명령을 사용자에게 보여 준다. 동의를 받는다.
5. 올린다: `akg push domain-skill/<md이름> <md이름>.md --rev <md rev> --note "absorb <원본 type>/<원본 id>"`.
6. 출력 `pushed domain-skill/<md이름> (rev <rev>)` 를 확인한다.
7. 409 는 그 사이에 md 가 바뀌었다는 뜻이다. 1부터 다시 한다. 400 · 409 의 내용 거절은
   [`fdc-agent-md`](../fdc-agent-md/SKILL.md) 12절로 읽는다.

## 6. 가까운 domain-skill 이 없을 때: 새 초안

1. `fdc-agent-md` 3절의 틀로 md 를 쓴다. 절은 `# 제목` · `## 한 줄 설명` · `## 언제 호출되는가?` · `## 도메인 지식` 넷이다.
   - `fdc-agent-md` 3절: "절은 빠져도 된다". 그래서 `## 데이터` 절은 두지 않는다.
   - BE `SkillMarkdownTool` 은 `## 데이터` 절이 없는 md 를 조회 0 개로 읽는다. 플로우 펜스가 필요한 때는
     `:var` 를 쓰는 조회가 있을 때뿐이다(BE `docs/skill-md.md`).
2. md 이름은 `fdc-agent-md` 3절의 꼴(`^[a-z][a-z0-9-]*$`)로 짓는다. 같은 id 가 없는지
   `GET /api/docs/domain-skill/<md이름>` 의 404 로 본다.
3. 조각마다 5절과 같은 근거 줄을 단다.
4. 5절 domain-skill 의 3~4(dry-run · 보여 주기 · 동의)를 `--rev` 대신 `--create` 로 한다.
5. 올린다: `akg push domain-skill/<md이름> <md이름>.md --create --note "absorb <원본 type>/<원본 id>"`.
6. 출력 `pushed domain-skill/<md이름> (rev <rev>) — 새 문서` 를 확인한다. 새 문서는 비활성(inactive) · role main 이다.
   켜기 · role 바꾸기는 admin 이 AKG 화면에서 한다.

## 7. 끝 보고 꼴

```markdown
## 녹인 문서

| 원본 | 읽은 rev | 넣은 곳 | 넣은 수 | 결과 |
| --- | --- | --- | --- | --- |
| voc/<id> | <rev> | db-schema/<표> columnDescs.<열> | 1 | 제안 <uuid> |
| voc/<id> | <rev> | domain-skill/<md이름> ## 도메인 지식 | 2 | rev <rev> |

## 사람이 볼 것

- 리뷰 큐 채택 → 승격: 제안 <uuid> (db-schema/<표>)
- 조각 확인: domain-skill/<md이름> 의 ### <소제목> · ### <소제목>
- 새 초안 켜기: domain-skill/<md이름>
- confirmed 슬롯이라 넣지 않은 것: db-schema/<표> columnDescs.<열> — <원본의 뜻>

## 못 분류한 것

- voc/<id>: <글 한 줄> — <이유>

## 쓰기 실패

- <type>/<id>: <stderr 첫 줄> — 녹인 rev 를 올리지 않음
```

## 8. 표본: voc 한 장 녹이기

원본은 AKG `examples/voc/line-a-rf-power-drift.json` 의 본문이다.

```markdown
# line-a-rf-power-drift

## 받은 말

"라인 A 식각 설비에서 RF Power 가 PM 뒤로 조금씩 올라가는데, 알람은 안 떠요. 언제부터인지 보고 싶어요."

## 정리

- 설비: 라인 A 식각 설비, 센서: RF_POWER_CH1.
- 바라는 것: PM 전후 추세를 한 장으로, 관리 한계 안의 완만한 상승도 보이게.
- 값의 출처는 [[db-schema/fdc_sensor]] 에서 보고, 관리 한계는 [[spc-chart-config]] 화면에서 고친다.
```

나누기:

| 원본의 글 | 지식 | 넣는 곳 |
| --- | --- | --- |
| "센서: RF_POWER_CH1", "값의 출처는 fdc_sensor" | 열 뜻 | `db-schema/fdc_sensor` 의 `columnDescs.SNSR_ID` |
| "PM 뒤로 조금씩 올라가는데, 알람은 안 떠요", "관리 한계 안의 완만한 상승" | 판단 기준 | domain-skill 조각 하나 |
| "관리 한계는 spc-chart-config 화면에서 고친다" | 업무 규칙 | domain-skill 조각 하나 |
| "언제부터인지 보고 싶어요" | 사람의 요청 | 못 분류한 것 |

고르기(4절): db-schema 는 1단(원본 링크 `[[db-schema/fdc_sensor]]`)에서 `fdc_sensor` 다.
domain-skill 은 2단에서 `fdc_sensor` 를 조회에 쓰는 md 다. AKG 예시에서는
`fdc-explain-sensor-origin`(조회 `sensor_row`)이다.

`proposal.json`: AKG 예시 `examples/db-schema/fdc_sensor.json` 의 지금 슬롯 위에 잇는다.

```json
{
  "slots": {
    "columnDescs.SNSR_ID": {
      "text": "센서 ID — sensors[].id로 노출, 조회 정렬 기준. 예: RF_POWER_CH1(라인 A 식각 설비의 RF Power 센서)",
      "evidence": [
        "fixtures/fdc-app/src/schema-map.ts:27",
        "fixtures/fdc-app/src/schema-map.ts:61-64",
        "voc/line-a-rf-power-drift@<읽은 rev>"
      ]
    }
  }
}
```

`fdc-explain-sensor-origin.md` 의 `## 도메인 지식` 끝(`### 답의 예` 뒤, `## 데이터` 앞)에 더하는 두 조각:

```markdown
### RF Power 의 PM 뒤 완만한 상승

- RF Power 는 PM 뒤로 조금씩 올라갈 수 있다. 관리 한계 안의 상승이면 알람이 뜨지 않는다.
- 이 상승은 PM 전후 추세를 한 장으로 그려야 보인다.

근거: voc/line-a-rf-power-drift rev <읽은 rev>

### 관리 한계를 고치는 곳

- 센서의 관리 한계는 `spc-chart-config` 화면에서 고친다.

근거: voc/line-a-rf-power-drift rev <읽은 rev>
```

명령:

```bash
akg propose db-schema/fdc_sensor proposal.json
akg push domain-skill/fdc-explain-sensor-origin fdc-explain-sensor-origin.md --rev <md rev> --dry-run
akg push domain-skill/fdc-explain-sensor-origin fdc-explain-sensor-origin.md --rev <md rev> --note "absorb voc/line-a-rf-power-drift"
```

두 쓰기가 성공하면 녹인 rev 를 올린다(3절 13):
`akg absorb-mark voc/line-a-rf-power-drift --rev <읽은 rev>`.

## 9. 규칙

- 확정(confirmed)은 사람이 AKG 화면에서 한다. 이 스킬의 쓰기는 제안 · 본문 수정 · 비활성 새 초안 셋이다.
- domain-skill 의 쓰기는 diff 를 보여 주고 동의를 받은 뒤에 한다.
- 근거는 원본 문서 id 와 읽은 rev 다. 제안은 `evidence` 칸에, 조각은 근거 줄에 적는다.
- 대상은 활성 원본이다. 비활성 원본(예: `analysis-flow` 로 올린 초안)은 admin 이 켠 뒤에 대상이 된다.
