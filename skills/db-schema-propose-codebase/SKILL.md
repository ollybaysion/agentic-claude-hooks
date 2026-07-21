---
name: db-schema-propose-codebase
argument-hint: "[table 또는 문서 경로]"
disable-model-invocation: true
description: >-
  코드베이스를 근거 원천으로 db-schema 문서의 의미 제안(proposal.json)을
  만드는 생산자. 문서의 채울
  슬롯을 인벤토리하고, 코드베이스에서 근거(사이트)를 찾아 교차 확인한 의미
  후보를 proposal.json으로 구조화한 뒤, lint로 계약·문서 정합을 자가 점검해
  db-schema-apply(로컬) 또는 akg propose(공유 레지스트리)에 넘긴다. 문서는
  직접 수정하지 않는다(쓰기는 그 출구들 전용).
  /db-schema-propose-codebase 로만 호출된다 (모델 자동 발동 없음).
---

# db-schema-propose-codebase — 의미 제안 생산자 (원천: 코드베이스)

**생산 전용.** 산출물은 proposal.json 하나이고, 문서로 들어가는 문은
[db-schema-apply](../db-schema-apply/SKILL.md)(유일한 쓰기 게이트웨이)뿐이다.

생산자는 이 스킬 말고도 여럿일 수 있고 전부 같은 계약(apply의 §제안
스키마)으로 수렴한다:

- **이 스킬** — 원천 = 코드베이스. 생산자가 따로 없을 때의 기본 경로.
  (원천별 생산자는 `db-schema-propose-<원천>` 이름을 따른다 — 예: 관측
  쿼리 기반이 생기면 `db-schema-propose-obs`)
- **도메인 스킬 부산물** — agent-skill-foundry 산출 스킬이 절차 실행 중 알게
  된 의미를 분리 산출
- **전문가 구술** — 사람이 아는 것을 서술하면 구조화만 해서 제안으로. 본인이
  곧 검토자이므로 apply 직후 promote까지 한 번에 가는 최단 경로다(최종적으로는
  대시보드 인라인 편집으로 대체 예정 — claude-hooks #90 후속).

## 절차

### 1. 대상 확인 + 슬롯 인벤토리

대상 문서(기본 위치 user 층 `~/.claude/docs/db/<table>.md`)가 없으면 먼저
[db-schema-docs](../db-schema-docs/SKILL.md)로 생성한다. 있으면:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/db-schema-propose-codebase/propose-cli.mjs slots \
  --doc ~/.claude/docs/db/orders.md
```

채울 수 있는 슬롯(scaffold/빈 값/기존 추정)과 동결된 슬롯(confirmed)이 JSON
으로 나온다. **이 목록이 작업 목록이다** — confirmed 슬롯은 제안해도 apply가
건너뛰므로 처음부터 제외한다.

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

apply의 §제안 스키마 규약대로 스크래치패드에 작성한다. 요점:

- **text** 한 줄, 값 코드는 `'N'=신규,'P'=처리중` 형태 — **코드에서 확인 못 한
  내용은 쓰지 않는다** (문장의 모든 조각이 evidence로 뒷받침).
- **evidence** 는 실제로 읽은 위치만, `파일:라인`(레포 루트 상대).
- 의미를 못 세운 컬럼은 통째로 생략 — 빈 스캐폴드로 남는 게 정상이다.

### 6. lint — 넘기기 전 자가 점검

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/db-schema-propose-codebase/propose-cli.mjs lint \
  --doc ~/.claude/docs/db/orders.md --proposal <proposal.json>
```

ERROR는 apply가 **조용히 버릴** 항목(모르는 키·오타·문서에 없는 컬럼)과 계약
위반(타입) — 반드시 고치고 다시 lint. WARN은 눈에 보이게 건너뛰어질 항목
(confirmed 동결)과 위생(근거 없음). ERROR 0 이 될 때까지가 이 스킬의 책임이다.

### 7. 인계 — 출구 2개

같은 proposal.json이 나가는 문이 둘이다. **akg 서버가 설정돼 있으면 akg를,
아니면 로컬을** 쓴다. 둘 다 쓰지는 않는다 — 정본이 둘이 되면 어느 쪽이 맞는지
아무도 모르게 된다.

#### A. akg (설정돼 있으면 이쪽)

지식이 개인 노트북이 아니라 **공유 레지스트리**로 간다. 검토·채택·승격이 전부
akg 대시보드에서 이뤄지고, 주입은 B모드(hub-fetch)가 처리한다.

```bash
# 제안을 akg 슬롯 주소 형태로 변환 (stdout=slots, stderr=진단)
node ${CLAUDE_PLUGIN_ROOT}/skills/db-schema-propose-codebase/propose-cli.mjs akg-slots \
  --doc ~/.claude/docs/db/orders.md --proposal <proposal.json> > slots.json

# 리뷰 큐에 제출 (AKG_SERVER / AKG_TOKEN)
akg propose db-schema/<owner>.<table> slots.json
```

`--doc`을 주면 변환 전에 lint를 돌려 ERROR가 있으면 변환을 거부한다(로컬 출구와
같은 게이트). `UNMAPPED:` 로 나온 항목은 **넘어가지 않은 것**이므로 반드시
사용자에게 보고한다:

- `queries` — akg는 대표 쿼리를 `{sql, note}[]`로 모델링해서 note를 매달 sql이
  제안에 없다. 대시보드에서 직접 넣는다.
- **근거 없는 항목** — akg는 채택 시 이런 슬롯을 `invalid_slot_value`(400)로
  거부하는데, **거기서 제안 전체가 멈춘다**(같이 들어 있던 멀쩡한 슬롯도 반영
  안 됨). 그래서 보내기 전에 뺀다.

티어는 `inferred`로 나간다. 서버도 이걸 믿지 않고 채택 시 `inferred`로 다시
못박는다 — **승격은 어느 경로로도 사람 전용이다.**

#### B. 로컬 (akg가 없으면)

proposal.json 경로를 [db-schema-apply](../db-schema-apply/SKILL.md)에 넘긴다 —
dry-run 미리보기 → 승인 → `--write`, 이후의 검토·승격(promote)은 전부 apply
쪽 절차다.

## 규율

1. **문서를 직접 수정하지 않는다** — 이 스킬의 산출물은 proposal.json뿐,
   쓰기는 apply(로컬) 또는 akg 채택 경유만.
2. 근거 없는 항목은 넣지 않는다 — 넣을 수 없으면 생략이 정답.
3. lint ERROR 0 을 만들고 나서 넘긴다 — 조용한 증발은 생산자 단계에서 잡는다.

관련 코드: `propose.mjs`(순수: 슬롯 인벤토리·제안 lint),
`propose-cli.mjs`(읽기 전용 CLI), `test.mjs`(오프라인 회귀 —
`node skills/db-schema-propose-codebase/test.mjs`).
