---
name: db-schema-enrich
argument-hint: "[table ...]"
disable-model-invocation: true
description: >-
  잘 만들어진 의미 제안(proposal.json)을 db-schema 문서에 안전하게 반영하고,
  사람 검토 후 승격까지의 신뢰도 라이프사이클(scaffold → 추정) → confirmed)을
  집행한다 — dbdoc 마커 보존, confirmed 동결, dry-run→승인. 제안 생산(코드베이스
  분석)은 생산자 몫이며, 생산자가 없을 때의 기본 분석 절차는 부록 A.
  /db-schema-enrich 로만 호출된다 (모델 자동 발동 없음).
---

# db-schema-enrich

## 책임 경계 (이 스킬이 무엇인가)

**핵심 책임 = 반영과 승격.** 이미 만들어진 의미 제안(proposal.json)을 받아:

1. db-schema 문서에 **안전하게 반영** — dbdoc 마커 보존, 신뢰도 티어 강제,
   confirmed 동결, dry-run→승인 (`enrich-cli apply`)
2. 사람이 검토한 추론의 **승격 집행** (`enrich-cli promote`)

제안을 **만드는 것**(코드베이스 분석)은 이 스킬의 핵심 책임이 아니라
**생산자의 몫**이다. 생산자는 여럿일 수 있다:

- agent-skill-foundry가 찍는 도메인 스킬들 (주 생산자, 예정)
- 사내 정적 분석 MCP(Neo4j 관계도) 기반 분석 (사내 이관 후)
- 이 스킬을 단독 호출했을 때의 에이전트 직접 분석 — **부록 A**의 기본 절차

어느 생산자든 계약은 하나 — §제안 스키마의 proposal.json. 그리고 문서로
들어가는 문은 이 스킬(enrich-cli)뿐이다: 생산자는 문서를 직접 수정하지 않는다.

## 배경

`db-schema-docs`가 만든 문서는 **구조**(컬럼·타입·PK·인덱스)는 카탈로그에서
자동으로 채우지만 **의미**(용도·컬럼 설명)는 `{{...}}` 스캐폴드로 비워 둔다.
`USE_YN`, `GUBUN`, `STATUS` 같은 컬럼의 실제 뜻과 값 코드는 카탈로그가 아니라
**애플리케이션 코드에만** 있기 때문 — 그 지식이 이 스킬을 거쳐 문서로 들어온다.

## 핵심 원칙: 신뢰 컨텍스트를 오염시키지 않는다

이 문서는 keyword-docs로 **매 세션 자동 주입**되는 검증된 컨텍스트다. 틀린
추론이 권위 있는 사실처럼 주입되면 빈 스캐폴드보다 나쁘다. 그래서 채운 값은
전부 **신뢰도 티어를 문구 안에 드러낸다**:

| 티어 | 표기 | 성격 |
| --- | --- | --- |
| scaffold | `{{설명}}` | 미상, 채울 수 있음 |
| inferred | `추정) <설명> [근거: a.java:12]` | 코드 추론, **저신뢰**, 근거 동반, 재생성 가능, 주입 시 "추정)"이 곧 헤지 |
| confirmed | `<설명> [근거: a.java:12]` | 사람 검토, **고신뢰**, 동결(덮어쓰지 않음) |

- **신뢰도는 LLM 자기점수가 아니다.** 티어 + **근거 개수**(독립 코드 사이트가
  몇 곳에서 일치하는가)가 신뢰의 신호다.
- **승격은 사람 전용.** 에이전트가 자기 추론을 스스로 confirmed로 올리면 안 된다.
- **confirmed는 절대 안 덮어쓴다.** 사람이 확인한 건 재실행해도 보존된다.
- 티어 접두어는 CLI가 붙인다 — 생산자가 `추정)`을 직접 쓰지 않는다.

## 전제

- 대상 테이블의 db-schema 문서가 이미 있어야 한다(없으면 먼저
  [db-schema-docs](../db-schema-docs/SKILL.md) 실행). 기본 위치는 user 층
  `~/.claude/docs/db/<table>.md`.

## 제안 스키마 (생산자 계약)

proposal.json — enrich-cli로 들어가는 **유일한 입력**:

```json
{
  "purpose": { "text": "주문 헤더 — 배치가 쓰고 리포트가 읽음", "evidence": ["OrderService.java:20"] },
  "columns": {
    "STATUS": { "text": "주문 상태('N'=신규,'P'=처리중,'D'=완료)", "evidence": ["OrderStatus.java:12", "OrderMapper.xml:45"] },
    "GUBUN":  { "text": "주문 구분 코드", "evidence": ["OrderType.java:8"] }
  }
}
```

- 키 4종(`purpose`/`queries`/`migration`/`columns`) 전부 선택 — 알아낸 것만.
  의미를 못 세운 컬럼은 통째로 생략(빈 스캐폴드로 남는 게 정상).
- **text**: 한 줄. 값 코드는 `'N'=신규,'P'=처리중` 형태로 나열. **코드에서
  확인 못 한 내용은 쓰지 않는다** — 문장의 모든 조각이 evidence로 뒷받침돼야 한다.
- **evidence**: 실제로 읽은 위치만, `파일:라인`(레포 루트 상대). 근거 없는
  항목은 아예 넣지 않는다.

## 절차 (핵심 책임)

### 1. 입력 확인

대상 문서(`~/.claude/docs/db/<table>.md`)와 proposal.json이 준비됐는지 확인.
제안이 아직 없으면 — 생산자가 따로 없다면 — 부록 A로 직접 만든다.

### 2. dry-run 미리보기 → 승인

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/db-schema-enrich/enrich-cli.mjs apply \
  --doc ~/.claude/docs/db/orders.md --proposal <proposal.json>
```

기본이 dry-run이라 디스크를 안 건드리고 채워질 문서 전문 + 요약
(`filled`/`skipped`)만 출력한다. confirmed 슬롯을 만나면 건드리지 않고
`skipped`로 보고한다(종료코드 2). 이를 사용자에게 보여주고 승인받는다.

### 3. 기록

승인되면 `--write`. 기존 `추정)` 값은 기본적으로 최신 추론으로 갱신되며,
`--keep-inferred`를 주면 남긴다.

### 4. 사람 검토 → 승격

사용자가 `추정)` 슬롯을 근거와 대조해 맞다고 판단하면 confirmed로 올린다.
**판단은 반드시 사람이 한다** (커맨드 실행 대행은 가능, 판단 대행은 불가).

```bash
# 특정 컬럼/슬롯만
node .../enrich-cli.mjs promote --doc ~/.claude/docs/db/orders.md --column STATUS --slot purpose --write
# 전부
node .../enrich-cli.mjs promote --doc ~/.claude/docs/db/orders.md --all --write
```

승격은 `추정)` 접두어만 떼고 근거는 남긴다(confirmed 사실의 출처로).

## db-schema-docs와의 합성

`db-schema-docs`를 나중에 다시 돌려 구조를 갱신해도 이 스킬이 채운 의미는
살아남는다 — 컬럼 설명은 컬럼명 단위로, 용도·쿼리·마이그레이션은 manual 구역
보존 규칙(render.mjs) 그대로. inferred는 inferred로, confirmed는 confirmed로
유지된다. 세 생산자(구조=db-schema-docs / 의미=이 스킬 경유 / 사람 확정=승격)가
**서로 다른 슬롯**을 쓰므로 충돌하지 않는다.

## 한계

- 반영은 마커 규약 위에서만 동작한다 — 마커 없는 수기 문서는 conflict로
  거부(덮어쓰지 않음).
- 제안의 품질은 생산자 책임이다 — 이 스킬은 티어·동결·근거 형식을 강제할 뿐,
  틀린 추론 자체를 검증하지는 못한다(그래서 승격이 사람 전용이다).

## 부록 A — 기본 생산 절차 (생산자가 없을 때)

단독 호출에서 제안을 직접 만들어야 할 때의 코드베이스 분석 절차. 컬럼 하나의
의미는 다음 4단계로 세운다(테이블 purpose도 동일, 단위만 다름):

**① 사이트 발견** — 이 컬럼을 만지는 코드를 찾는다:

- `rg -i '<테이블명>'` (스키마 접두 유/무 모두) → 매퍼 XML·엔티티·SQL 파일
- 찾은 매퍼/엔티티 안에서 컬럼명 검색: `resultMap`의 `column="STATUS"
  property="orderStatus"`, `@Column(name = "STATUS")` 붙은 필드
- `rg -i '<컬럼명>'`으로 직접 검색 (컬럼명이 흔한 단어면 테이블 파일 안으로 한정)

**② 의미 후보 도출** — 발견한 사이트에서 의미를 읽는다:

- **매핑된 property/필드명이 1차 후보다**: `column="STATUS"
  property="orderStatus"` → "주문 상태". 개발자가 이미 번역해 둔 이름이다.
- **값을 해석하는 enum/상수/분기**: `if (status.equals("P")) // 처리중`,
  `OrderStatus.NEW("N")` → 값 코드표가 나온다.
- **Javadoc·주석·DTO 필드 설명** — 있으면 문장 그대로가 후보.

**③ 교차 확인** — 후보들이 서로 일치하는가:

- 독립 사이트 **2곳 이상**이 같은 의미를 가리키면 채택.
- **1곳뿐이면** 텍스트를 보수적으로 쓴다 — 단정("주문 상태") 대신 관찰
  서술("OrderMapper가 orderStatus로 매핑") 수준까지만.
- 사이트끼리 **모순**이면(같은 컬럼을 다른 뜻으로) 그 컬럼은 제안에서 빼고
  사용자에게 모순 사실을 보고한다.

**④ 근거 기록** — 채택한 의미마다 ①에서 본 위치를 `파일:라인`으로 남기고,
§제안 스키마의 규칙대로 proposal.json을 스크래치패드에 작성한다.

> **TODO (사내 이관 후)**: 사내에는 MyBatis Mapper/Loader 관계를 정적 분석해
> Neo4j에 넣고 MCP화한 코드베이스 분석 플러그인이 있다. 그 MCP가 연결돼
> 있으면 ①(사이트 발견)을 grep 대신 **그래프 조회로 먼저** 한다(탐색 가속·
> 누락 감소). ②~④는 동일하고, 근거 표기도 그대로 `파일:라인` — 그래프는
> 사이트를 찾는 수단이고, 출처는 항상 코드다.

관련 코드: `enrich.mjs`(순수 병합·티어·승격), `enrich-cli.mjs`(파일 IO CLI),
`test.mjs`(오프라인 회귀 — `node skills/db-schema-enrich/test.mjs`).
