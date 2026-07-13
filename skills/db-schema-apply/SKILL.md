---
name: db-schema-apply
argument-hint: "[table ...]"
disable-model-invocation: true
description: >-
  잘 만들어진 의미 제안(proposal.json)을 db-schema 문서에 안전하게 반영하고,
  사람 검토 후 승격까지의 신뢰도 라이프사이클(scaffold → 추정) → confirmed)을
  집행한다 — dbdoc 마커 보존, confirmed 동결, dry-run→승인. 제안 생산(코드베이스
  분석)은 생산자 몫이며, 기본 생산자는 형제 스킬 db-schema-propose-codebase.
  /db-schema-apply 로만 호출된다 (모델 자동 발동 없음).
---

# db-schema-apply

## 책임 경계 (이 스킬이 무엇인가)

**핵심 책임 = 반영과 승격.** 이미 만들어진 의미 제안(proposal.json)을 받아:

1. db-schema 문서에 **안전하게 반영** — dbdoc 마커 보존, 신뢰도 티어 강제,
   confirmed 동결, dry-run→승인 (`cli.mjs apply`)
2. 사람이 검토한 추론의 **승격 집행** (`cli.mjs promote`)

제안을 **만드는 것**(코드베이스 분석)은 이 스킬의 핵심 책임이 아니라
**생산자의 몫**이다. 생산자는 여럿일 수 있다:

- **기본 생산자 = [db-schema-propose-codebase](../db-schema-propose-codebase/SKILL.md)** —
  코드베이스 분석 + 제안 lint(조용한 증발 방지)
- agent-skill-foundry가 찍는 도메인 스킬들 (주 생산자, 예정)
- 전문가 구술의 구조화, 사내 정적 분석 MCP(Neo4j) 기반 분석 (사내 이관 후)

어느 생산자든 계약은 하나 — §제안 스키마의 proposal.json. 그리고 문서로
들어가는 문은 이 스킬(cli.mjs)뿐이다: 생산자는 문서를 직접 수정하지 않는다.

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

proposal.json — cli.mjs로 들어가는 **유일한 입력**:

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
제안이 아직 없으면 — 생산자가 따로 없다면 —
[db-schema-propose-codebase](../db-schema-propose-codebase/SKILL.md)로 만든다.

### 2. dry-run 미리보기 → 승인

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/db-schema-apply/cli.mjs apply \
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
node .../cli.mjs promote --doc ~/.claude/docs/db/orders.md --column STATUS --slot purpose --write
# 전부
node .../cli.mjs promote --doc ~/.claude/docs/db/orders.md --all --write
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

관련 코드: `apply.mjs`(순수 병합·티어·승격), `cli.mjs`(파일 IO CLI),
`test.mjs`(오프라인 회귀 — `node skills/db-schema-apply/test.mjs`).
