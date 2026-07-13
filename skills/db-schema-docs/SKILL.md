---
name: db-schema-docs
argument-hint: "[db-alias] [table ...]"
disable-model-invocation: true
description: >-
  라이브 Oracle 스키마를 keyword-docs db-schema 문서로 생성/재생성한다:
  대상 테이블을 describe_table MCP tool로 조회 → 구조 슬롯 자동 채움 →
  의미 슬롯은 비워 스캐폴딩 → user 층(~/.claude/docs/db/)에 저장 + 인덱스 등록
  (레포 커밋용은 --cwd 옵트인). 재생성 시 사람이 채운 구역은 dbdoc 마커로 보존.
  Oracle MCP(agent-db-plugin)가 연결돼 있어야 한다. /db-schema-docs 로만
  호출된다 (모델 자동 발동 없음).
---

# db-schema-docs

Oracle MCP(agent-db-plugin)가 붙은 실 DB의 스키마를 읽어 **keyword-docs
`db-schema` 문서**로 굳히는 절차. `describe_table` tool이 주는 **구조**(컬럼·
타입·PK·FK·인덱스·NUM_ROWS)는 자동으로 채우고, 카탈로그에 없는 **의미**(용도·
쓰기/읽기 주체·컬럼 설명·대표 쿼리)는 `{{...}}` 스캐폴딩으로
남겨 사람/에이전트가 채우게 한다.

[keyword-docs-new-docs](../keyword-docs-new-docs/SKILL.md)의 db-schema
카테고리와 같은 문서 포맷을 생성한다 — new-docs가 "인터뷰/코드 추출로 손수
채우기"라면 이 스킬은 "라이브 DB에서 구조를 자동으로". 인덱스 등록 규약은
[keyword-docs-add-index](../keyword-docs-add-index/SKILL.md)와 동일하되,
`generate.mjs`가 upsert까지 처리한다.

**명시적 호출 전용** — `/db-schema-docs` 로만 실행되고 모델이 스스로 발동하지
않는다(`disable-model-invocation: true`). 파일 저장과 인덱스 수정은 **반드시
dry-run 미리보기 → 사용자 승인 후에만** 한다.

## 전제: Oracle MCP 연결

`describe_table`/`list_tables` tool(agent-db-plugin의 MCP 서버)이 이 세션에
연결돼 있어야 한다. 없으면 그 사실을 알리고 중단한다 — 이 스킬은 DB에 직접
접속하지 않으며, MCP tool 출력(JSON)만 소비한다. DB 서버가 어디서 돌든(예:
방화벽 때문에 Windows 쪽에서 실행하는 WSL 구성) tool만 보이면 동작한다.

## 산출물이 저장되는 곳 (기본: user 층)

- 문서: `~/.claude/docs/db/<테이블명 소문자>.md`
- 인덱스: `~/.claude/context-docs.db-schema.json` — `{keywords, path}` 배열.
  `core/context`의 db-schema provider가 프롬프트에 DB/테이블명이 등장하면
  이 문서를 주입한다. (인덱스가 `.claude/` 폴더에 있으므로 `path`는 그 부모
  기준 — provider의 `docBaseFor` 규약. user 층이면 `~` 기준이 되어 project
  층과 같은 상대경로 `.claude/docs/db/...`를 그대로 쓴다.)
- **user 층이 기본인 이유**: DB 문서는 여러 레포에서 소비된다 — provider는
  user 층 인덱스를 **모든 레포에서** 읽으므로, `~/.claude` 한 벌이면 어느
  레포에서 테이블명을 언급해도 주입된다. 레포마다 다시 생성할 필요 없고,
  DB 내부 구조가 서비스 레포 커밋에 섞이지도 않는다.
- **project 층 옵트인**: 특정 레포에 커밋해 팀과 공유하려면 3단계 커맨드에
  `--cwd <레포 루트>`를 붙인다 → `<레포>/.claude/docs/db/` + 레포 인덱스에
  기록. 같은 키워드는 project > user 섀도잉이라 그 레포에서는 레포 버전이
  이긴다.
- DB들이 거의 동일한 환경이면 **테이블당 문서 1개**(alias 무관)를 공유한다.
  DB별 차이는 문서 안에 주석으로 남긴다.

## 절차

### 1. 대상 테이블 결정

- 인자로 테이블 목록을 받았으면 그것을 쓴다.
- 아니면 `list_connections`로 alias를 고르고 `list_tables(db)`를 호출한다 —
  **이 출력이 곧 허용 표면이다**: 서버가 `tables.allow`를 이미 강제하므로
  (수준 1, 카탈로그에서 필터), 설정 파일을 읽을 필요도 권한도 없다.
- 목록이 크면(수십 개 이상) 전부 문서화하지 말고 사용자에게 대상을 좁혀 달라고
  한다 — allow가 안 걸린 DB에서 스키마 전체를 무단 문서화하지 않는다.

### 2. 스키마 조회

각 대상 테이블에 대해:

- `describe_table(db, "SCHEMA.TABLE")` → 구조 전량.
- 테이블 용도 시드가 필요하면 `list_tables` 결과의 해당 테이블 `comment`를
  `tableComment` 필드로 각 describe 결과에 얹는다 (describe_table은 컬럼
  코멘트만 주고 테이블 코멘트는 주지 않으므로).

조회 결과들을 **JSON 배열** 하나로 모아 임시 파일(스크래치패드)에 저장한다.
각 원소는 `describe_table` 응답 그대로 + 선택적 `tableComment`.

### 3. dry-run 미리보기 → 승인

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/db-schema-docs/generate.mjs \
  --describe <tables.json>
```

기본이 dry-run이라 디스크를 건드리지 않고 생성될 문서 전문과 요약
(`created/updated/conflict`)만 출력한다. 이를 사용자에게 보여주고 승인을 받는다.
대상은 기본 user 층(`~/.claude`)이며, 레포에 커밋할 문서만 예외적으로
`--cwd <레포 루트>`를 붙인다(위 "산출물" 절).

### 4. 저장

승인되면 `--write`를 붙여 다시 실행한다. 문서와 인덱스가 기록된다.

### 5. 의미 슬롯 채우기 유도

생성/재생성 후, 비어 있는 `{{용도}}`·`{{쓰기→읽기}}`·컬럼 `{{설명}}`·
`{{대표 쿼리}}`를 코드/도메인 지식으로 채우도록
사용자에게 제안한다.

## 대표 쿼리 포집 (관측 → 슬롯 제안, 선택)

`## 대표 쿼리` manual 슬롯은 손으로 채우는 게 기본이지만, **실사용을 이미 관측하고
있으면** 그 로그에서 후보를 뽑을 수 있다. agent-db-plugin은 실행한 모든 `run_query`를
`DbQuery` 이벤트로 observability collector에 흘리고(#87), 다음 CLI가 그 이벤트를
**테이블별 대표 쿼리**로 정규화·랭킹해 이 슬롯에 붙일 **제안**을 만든다(#114):

```bash
node ${CLAUDE_PLUGIN_ROOT}/core/observability/server.mjs representative-queries \
  --window 30d            # 1h|6h|24h|7d|30d (기본 30d)
  [--table FDC.LOT_HISTORY]  # 한 테이블만
  [--alias fdc]           # 한 접속 별칭만
  [--per-table 3] [--min-count 2]
  [--all-tools]           # describe_table/list_tables 내부 카탈로그 조회까지 포함
  [--json]                # 구조화 출력
```

- **정규화**: 리터럴·바인드·`IN (?,…)`만 다른 쿼리는 한 그룹으로 묶고(빈도 desc →
  성공률 → 최근성 순 랭킹), 대표 SQL은 그 그룹의 **가장 최근 성공** 인스턴스를 보여준다.
- **기본은 `run_query`만** — 카탈로그 조회는 대표 쿼리가 아니므로 제외(`--all-tools`로 포함).
- **읽기 전용·제안 전용**: 문서를 직접 쓰지 않는다. 출력된 블록을 **사람이 검토한 뒤**
  해당 테이블 문서의 `## 대표 쿼리` 구역(`dbdoc:manual:queries` 마커 안)에 붙인다 —
  manual 슬롯 원문 보존 + enrich의 propose→promote 규율과 같은 계약.
- **전제**: 의미 있는 대표 쿼리가 나오려면 실사용 트래픽이 collector로 쌓여 있어야 한다.
  관측이 0건이면 그 사실을 안내하고 끝낸다(문서를 억지로 만들지 않는다).

## dbdoc 마커 규약 (재생성 안전)

이 스킬이 만드는 문서는 `<!-- dbdoc:auto:... -->` / `<!-- dbdoc:manual:... -->`
마커로 구역을 나눈다. **이 규약은 keyword-docs 포맷의 일부다** — 다른
keyword-docs 스킬(prune/new-docs)이 문서를 만질 때 마커를 제거하거나 구역을
재배치하면 안 된다.

- **auto** (컬럼 구조·PK·인덱스·관계): 재생성 때마다 카탈로그에서 새로 만든다.
- **manual** (용도·컬럼 설명·대표 쿼리): 사람이 채운 내용을
  **원문 보존**. 컬럼 설명은 **컬럼명 단위로 보존**되어, 타입이 바뀌어도 그
  컬럼 설명은 살아남는다.
- 마커가 **없는** 기존 문서(수기 작성, 예: new-docs로 만든 것)는 `conflict`로
  표시하고 **덮어쓰지 않는다**.

## 한계

- deny 테이블은 `describe_table`이 거부하므로 애초에 문서화되지 않는다.
- 구조는 카탈로그를 따르지만 의미는 사람 몫 — "뼈대 자동 + 의미 채우기 유도"
  이지 완전 자동 문서화가 아니다.

관련 코드: `render.mjs`(순수 렌더·병합), `generate.mjs`(파일 IO CLI),
`test.mjs`(오프라인 회귀 테스트 — `node skills/db-schema-docs/test.mjs`).
입력 계약: agent-db-plugin `describe_table` tool의 JSON 출력.
