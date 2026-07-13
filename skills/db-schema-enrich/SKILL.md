---
name: db-schema-enrich
argument-hint: "[table ...]"
disable-model-invocation: true
description: >-
  db-schema 문서의 빈 의미 슬롯(용도·컬럼 설명)을 코드베이스에서 캐낸 근거로
  채운다: 대상 테이블이 코드(ORM 엔티티·MyBatis 매퍼·값 enum·SQL 리터럴)에서
  어떻게 쓰이는지 분석 → 컬럼/테이블 의미를 근거와 함께 추론 → 문서에 "추정)"
  티어로 기록. 사람이 검토 후 승격하면 confirmed. 구조는 db-schema-docs가,
  의미는 이 스킬이. /db-schema-enrich 로만 호출된다 (모델 자동 발동 없음).
---

# db-schema-enrich

`db-schema-docs`가 만든 문서는 **구조**(컬럼·타입·PK·인덱스)는 카탈로그에서
자동으로 채우지만 **의미**(용도·컬럼 설명)는 `{{...}}` 스캐폴드로 비워 둔다.
Oracle 카탈로그엔 그 의미가 없기 때문이다 — `USE_YN`, `GUBUN`, `STATUS` 같은
컬럼의 실제 뜻과 값 코드는 **애플리케이션 코드에만** 있다. 이 스킬은 그 코드를
읽어 의미 슬롯을 채운다.

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

## 전제

- 대상 테이블의 db-schema 문서가 이미 있어야 한다(없으면 먼저
  [db-schema-docs](../db-schema-docs/SKILL.md) 실행). 기본 위치는 user 층
  `~/.claude/docs/db/<table>.md`.
- 그 테이블을 **쓰는 코드베이스**가 있어야 한다. 코드가 없으면 추론할 근거가
  없다 — 이 스킬은 라이브 DB가 아니라 **코드**를 읽는다(구조는 이미 문서에 있음).

## 절차

### 1. 대상 문서 확인

인자로 받은 테이블(없으면 코드베이스와 관련된 문서)의 `~/.claude/docs/db/*.md`
에서 아직 `{{...}}`(scaffold)이거나 `추정)`(inferred)인 슬롯을 파악한다.
confirmed 슬롯은 건드리지 않는다.

### 2. 코드베이스 분석 (에이전트 작업)

각 대상 테이블/컬럼이 코드에서 어떻게 쓰이는지 찾는다:

- **ORM 엔티티** — `@Table`/`@Column(name=...)`과 필드명·Javadoc
- **MyBatis/iBATIS 매퍼** — `resultMap`의 `column`↔`property` 매핑, SQL
- **값 코드** — 컬럼값을 해석하는 enum·상수(`STATUS='A'` → `ACTIVE`)
- **DTO/VO 필드명**, 코드 주석, 리터럴

**교차 근거를 센다** — 한 곳에서만 나온 의미는 약하고, 매퍼+enum+주석이
일치하면 강하다. 각 의미마다 **출처(`파일:라인`)를 근거로 수집**한다.

### 3. 의미 제안 JSON 작성

분석 결과를 하나의 JSON으로 모아 스크래치패드에 저장한다:

```json
{
  "purpose": { "text": "주문 헤더 — 배치가 쓰고 리포트가 읽음", "evidence": ["OrderService.java:20"] },
  "columns": {
    "STATUS": { "text": "주문 상태('N'=신규,'P'=처리중,'D'=완료)", "evidence": ["OrderStatus.java:12", "OrderMapper.xml:45"] },
    "GUBUN":  { "text": "주문 구분 코드", "evidence": ["OrderType.java:8"] }
  }
}
```

근거 없는 추론은 넣지 않는다(빈 스캐폴드가 낫다). `queries`/`migration` 슬롯도
같은 형태로 채울 수 있다.

### 4. dry-run 미리보기 → 승인

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/db-schema-enrich/enrich-cli.mjs apply \
  --doc ~/.claude/docs/db/orders.md --proposal <proposal.json>
```

기본이 dry-run이라 디스크를 안 건드리고 채워질 문서 전문 + 요약
(`filled`/`skipped`)만 출력한다. confirmed 슬롯을 만나면 건드리지 않고
`skipped`로 보고한다(종료코드 2). 이를 사용자에게 보여주고 승인받는다.

### 5. 기록

승인되면 `--write`. 기존 `추정)` 값은 기본적으로 최신 추론으로 갱신되며,
`--keep-inferred`를 주면 남긴다.

### 6. 사람 검토 → 승격

사용자가 `추정)` 슬롯을 근거와 대조해 맞다고 판단하면 confirmed로 올린다.
**이 단계는 반드시 사람이 한다.**

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
유지된다. 세 생산자(구조=db-schema-docs / 의미=이 스킬 / 사람 확정=승격)가
**서로 다른 슬롯**을 쓰므로 충돌하지 않는다.

## 한계

- 코드에서 의미가 안 나오는 컬럼은 스캐폴드로 남는다 — 추론을 지어내지 않는다.
- 동적 SQL 문자열 조립이 심한 코드베이스는 회수율이 낮을 수 있다(Phase 0에서
  실측 권장).
- 값 코드(`GUBUN` 코드표)의 의미는 앱마다 다를 수 있다 — 여러 앱이 같은 DB를
  쓰면 근거 출처를 남겨 어느 앱 기준인지 드러낸다.

관련 코드: `enrich.mjs`(순수 병합·티어·승격), `enrich-cli.mjs`(파일 IO CLI),
`test.mjs`(오프라인 회귀 — `node skills/db-schema-enrich/test.mjs`).
입력 계약: db-schema-docs가 생성한 문서 + 에이전트의 의미 제안 JSON.
