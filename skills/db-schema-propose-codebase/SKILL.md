---
name: db-schema-propose-codebase
argument-hint: "[table 또는 akg 문서 id]"
disable-model-invocation: true
description: >-
  코드베이스를 근거 원천으로 db-schema 문서의 의미 제안(proposal.json)을
  만드는 생산자. 코드베이스에서 근거(사이트)를 찾아 교차 확인한 의미 후보를
  proposal.json으로 구조화한 뒤, lint로 계약 정합을 자가 점검해 akg 리뷰
  큐(akg propose)에 제출한다. 문서는 직접 수정하지 않는다 — 검토·채택·승격은
  전부 akg 대시보드의 일이다. /db-schema-propose-codebase 로만 호출된다
  (모델 자동 발동 없음).
---

# db-schema-propose-codebase — 의미 제안 생산자 (원천: 코드베이스)

**생산 전용.** 산출물은 proposal.json 하나이고, 문서로 들어가는 문은 **akg
리뷰 큐**(`akg propose` → 대시보드 채택)뿐이다. 문서 생성은
akg-collector(배치·대량)가, 검토·채택·승격은 akg 대시보드가 맡는다 — 로컬
md 파이프라인(구 db-schema-docs/apply)은 없다(#125, 2026-07-23).

생산자는 이 스킬 말고도 여럿일 수 있고 전부 같은 계약(§제안 스키마)으로
수렴한다:

- **이 스킬** — 원천 = 코드베이스. 생산자가 따로 없을 때의 기본 경로.
  (원천별 생산자는 `db-schema-propose-<원천>` 이름을 따른다 — 예: 관측
  쿼리 기반이 생기면 `db-schema-propose-obs`)
- **도메인 스킬 부산물** — agent-skill-foundry 산출 스킬이 절차 실행 중 알게
  된 의미를 분리 산출
- **전문가 구술** — 사람이 아는 것을 서술하면 구조화만 해서 제안으로. 본인이
  곧 검토자이므로 akg 대시보드에서 즉시 채택·확정까지 가는 최단 경로다.

## 절차

### 1. 대상 확인 — akg 문서와 슬롯

대상은 akg의 db-schema 문서다(`db-schema/<owner>.<table>`). 문서가 akg에
없으면 **akg-collector로 먼저 적재**한다(문서 생성은 collector 소관 — 이
스킬이 만들지 않는다). 있으면 문서 조회(`GET /api/docs/db-schema/<id>` 또는
대시보드)로 **비어 있는 슬롯과 확정(confirmed)된 슬롯**을 확인한다 —
confirmed는 제안해도 서버가 거부하므로 처음부터 제외한다.

### 2. 사이트 발견 — 컬럼을 만지는 코드 찾기

- `rg -i '<테이블명>'` (스키마 접두 유/무 모두) → 매퍼 XML·엔티티·SQL 파일
- 찾은 매퍼/엔티티 안에서 컬럼명 검색: `resultMap`의 `column="STATUS"
  property="orderStatus"`, `@Column(name = "STATUS")` 붙은 필드
- `rg -i '<컬럼명>'`으로 직접 검색 (컬럼명이 흔한 단어면 테이블 파일 안으로 한정)

> **TODO (사내 이관 후)**: 사내에는 MyBatis Mapper/Loader 관계를 정적 분석해
> Neo4j에 넣고 MCP화한 코드베이스 분석 플러그인이 있다. 그 MCP가 연결돼
> 있으면 이 단계를 grep 대신 **그래프 조회로 먼저** 한다(탐색 가속·누락 감소).
> 이후 단계는 동일하고, 근거 표기도 그대로 `파일:라인` — 그래프는 사이트를
> 찾는 수단이고, 출처는 항상 코드다.

### 3. 의미 후보 도출

- **매핑된 property/필드명이 1차 후보다**: `column="STATUS"
  property="orderStatus"` → "주문 상태". 개발자가 이미 번역해 둔 이름이다.
- **값을 해석하는 enum/상수/분기**: `if (status.equals("P")) // 처리중`,
  `OrderStatus.NEW("N")` → 값 코드표가 나온다.
- **Javadoc·주석·DTO 필드 설명** — 있으면 문장 그대로가 후보.

### 4. 교차 확인

- 독립 사이트 **2곳 이상**이 같은 의미를 가리키면 채택.
- **1곳뿐이면** 텍스트를 보수적으로 쓴다 — 단정("주문 상태") 대신 관찰
  서술("OrderMapper가 orderStatus로 매핑") 수준까지만.
- 사이트끼리 **모순**이면(같은 컬럼을 다른 뜻으로) 그 컬럼은 제안에서 빼고
  사용자에게 모순 사실을 보고한다.

### 5. proposal.json 작성

§제안 스키마 규약대로 스크래치패드에 작성한다. 요점:

- **text** 한 줄, 값 코드는 `'N'=신규,'P'=처리중` 형태 — **코드에서 확인 못 한
  내용은 쓰지 않는다** (문장의 모든 조각이 evidence로 뒷받침).
- **evidence** 는 실제로 읽은 위치만, `파일:라인`(레포 루트 상대).
- 의미를 못 세운 컬럼은 통째로 생략 — 빈 스캐폴드로 남는 게 정상이다.

## 제안 스키마 (생산자 계약)

```json
{
  "purpose":  { "text": "...", "evidence": ["파일:라인"] },
  "queries":  { "text": "...", "evidence": ["파일:라인"] },
  "columns": {
    "STATUS": { "text": "...", "evidence": ["파일:라인"] }
  }
}
```

허용 키는 위가 전부다(`purpose`·`queries`·`columns`) — 모르는 키는 lint가
거부한다. 항목은 `{text, evidence}` 형태이고 evidence 없는 항목은 넣지
않는다.

### 6. lint — 넘기기 전 자가 점검

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/db-schema-propose-codebase/propose-cli.mjs lint \
  --proposal <proposal.json>
```

ERROR는 계약 위반(모르는 키·타입) — 반드시 고치고 다시 lint. WARN은
위생(근거 없음 — akg가 그 슬롯을 거부한다). ERROR 0 이 될 때까지가 이
스킬의 책임이다. 문서 측 정합(없는 컬럼·confirmed 동결)은 akg 서버가 제출
시점에 검증한다.

### 7. 인계 — akg 리뷰 큐

```bash
# 제안을 akg 슬롯 주소 형태로 변환 (stdout=slots, stderr=진단; lint 게이트 내장)
node ${CLAUDE_PLUGIN_ROOT}/skills/db-schema-propose-codebase/propose-cli.mjs akg-slots \
  --proposal <proposal.json> > slots.json

# 리뷰 큐에 제출 (AKG_SERVER / AKG_TOKEN)
akg propose db-schema/<owner>.<table> slots.json
```

`UNMAPPED:` 로 나온 항목은 **넘어가지 않은 것**이므로 반드시 사용자에게
보고한다:

- `queries` — akg는 대표 쿼리를 `{sql, note}[]`로 모델링해서 note를 매달 sql이
  제안에 없다. 대시보드에서 직접 넣는다.
- **근거 없는 항목** — akg가 `invalid_slot_value`로 거부한다. 보내기 전에 뺀다.

티어는 `inferred`로 나간다. 서버도 이걸 믿지 않고 채택 시 `inferred`로 다시
못박는다 — **승격은 어느 경로로도 사람 전용이다.**

## 규율

1. **문서를 직접 수정하지 않는다** — 이 스킬의 산출물은 proposal.json뿐,
   쓰기는 akg 채택 경유만.
2. 근거 없는 항목은 넣지 않는다 — 넣을 수 없으면 생략이 정답.
3. lint ERROR 0 을 만들고 나서 넘긴다 — 조용한 증발은 생산자 단계에서 잡는다.

관련 코드: `propose.mjs`(순수: 제안 lint·akg 슬롯 변환),
`propose-cli.mjs`(읽기 전용 CLI), `test.mjs`(오프라인 회귀 —
`node skills/db-schema-propose-codebase/test.mjs`).
