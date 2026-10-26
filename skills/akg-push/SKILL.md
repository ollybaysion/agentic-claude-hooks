---
name: akg-push
argument-hint: "[<type>/<id>] [문서.md | 문서.json | proposal.json | describe.json]"
disable-model-invocation: true
description: >-
  로컬에서 만든 지식 문서 · 문서 수정 · 슬롯 제안 · 표 카탈로그를 AKG
  (agent-knowledge-governance) 서버에 올린다. akg CLI 의 push · propose · catalog-push 를
  부른다. agent 가 쓴 슬롯은 추정(inferred)으로 들어가고, 확정은 사람이 AKG 화면에서
  승격한다. 사람이 /akg-push 로 부른다.
---

# akg-push

AKG 로 **올리는** 쪽이다. 짝은 [`akg-pull`](../akg-pull/SKILL.md)(가져오는 쪽)이다.
처음 연결은 [`setup`](../setup/SKILL.md) 의 5절이 한다.

- AKG 레포: [ollybaysion/agent-knowledge-governance](https://github.com/ollybaysion/agent-knowledge-governance),
  로컬 체크아웃 `~/work/fdc-agent/agent-knowledge-governance`.
- CLI: `akg`(= `<체크아웃>/bin/akg.mjs`). `akg push` 는 AKG `feat/agent-write` PR 이 더한다.

## 1. 준비 — 프로그램이 AKG 에 바로 붙는 법

요약:

- 프로그램(Claude Code · opencode · `akg` CLI · `curl`)의 요청은 `Authorization: Bearer <토큰>`
  헤더 하나로 붙는다.
- CSRF 헤더는 브라우저의 쿠키 세션만 쓴다. 프로그램의 요청은 Bearer 헤더 하나로 끝난다.
- 토큰 값은 서버 종류에 따라 한 곳에서 온다.

| 서버 | 토큰 값 | 받는 곳 |
| --- | --- | --- |
| Keycloak 없는 서버 | `users.yml` 에서 group `agent` 줄의 비밀번호 | 서버 관리자가 그 줄을 만들어 값을 준다 |
| Keycloak 서버 | client `fdc-voc-agent-a2a` 서비스 계정의 access token(client_credentials) | Keycloak 토큰 엔드포인트. 만료되면 다시 받는다 |

Keycloak 서버에서 토큰을 받는 명령(`<keycloak>` · `<realm>` · `<client secret>` 은 서버
관리자가 준다):

```bash
install -m 600 /dev/null ~/.claude/akg/token
curl -sS -d grant_type=client_credentials -d client_id=fdc-voc-agent-a2a \
  -d client_secret='<client secret>' \
  "<keycloak>/realms/<realm>/protocol/openid-connect/token" \
  | jq -r .access_token > ~/.claude/akg/token
```

자세한 것은 AKG [`docs/consuming.md`](https://github.com/ollybaysion/agent-knowledge-governance/blob/main/docs/consuming.md)
의 "프로그램이 AKG 에 바로 붙는 법" 절에 있다.

절차:

1. 서버 주소를 확인한다: `echo "$AKG_SERVER"`. 비어 있으면 setup 5절로 간다.
2. 토큰을 셸에 싣는다: `export AKG_TOKEN="${AKG_TOKEN:-$(cat ~/.claude/akg/token)}"`.
   토큰 파일도 없으면 setup 5절로 간다. 토큰 값은 파일과 환경변수에만 둔다.
3. 붙는지 확인한다: `curl -sS -H "Authorization: Bearer $AKG_TOKEN" "$AKG_SERVER/health"`.
   200 이 오면 된다. 401 이면 4절의 오류 표로 간다.
4. 미러를 최신으로 맞춘다: `akg sync`.

## 2. 무엇을 올리나

올릴 것마다 명령 하나다. 확인은 오른쪽 칸으로 한다.

| 올릴 것 | 파일 | 명령 | 확인 |
| --- | --- | --- | --- |
| 새 md 문서 | 본문 md | `akg push <type>/<id> 문서.md --create --note "<글>"` | 문서 조회가 200 |
| 기존 문서의 본문 수정(md 타입) | 고친 본문 md | `akg push <type>/<id> 문서.md --note "<글>"` | 문서 조회의 `.json.body.markdown` 이 고친 글 |
| 기존 문서 전체 수정(슬롯 · links) | 고친 문서 json | `akg push <type>/<id> 문서.json --note "<글>"` | 문서 조회의 `.json` 이 고친 값 |
| 슬롯 제안 | `proposal.json`(`{"slots": {…}}`) | `akg propose <type>/<id> proposal.json` | 출력 `proposed <type>/<id>: <uuid>` 또는 `proposal already pending: <uuid>` |
| 표 카탈로그 | `describe_table` 결과 json | `akg catalog-push <table> describe.json` | 출력 `catalog pushed: db-schema/<table> (rev <rev>)` |

- `akg push` 의 `.md` 파일은 md 타입 본문만 바꾼다. 봉투와 links 는 서버의 것이 남는다.
  `.json` 파일은 문서 전체를 바꾼다.
- `--create` 는 새 문서를 만들 때 붙인다. 서버에 그 문서가 없으면(404) 이 플래그가 있을 때 만든다.
- `--note` 의 글은 서버 이력의 메시지가 된다.
- `--dry-run` 은 검사만 하고 결과를 보여 준다. `--server <url>` · `--mirror <dir>` 은
  환경변수 대신 쓴다.

고칠 원본은 서버에서 받는다(`jq` 사용):

```bash
curl -sS -H "Authorization: Bearer $AKG_TOKEN" "$AKG_SERVER/api/docs/<type>/<id>" | jq -r '.json.body.markdown' > 문서.md   # md 본문
curl -sS -H "Authorization: Bearer $AKG_TOKEN" "$AKG_SERVER/api/docs/<type>/<id>" | jq '.json' > 문서.json                   # 문서 전체
```

표의 "문서 조회"는 같은 `curl` 이다. 200 과 문서 JSON 이 오면 서버에 있다.

## 3. 절차

1. 인자에서 `<type>/<id>` 와 파일을 읽는다. 빠진 것은 사용자에게 묻는다.
2. 2절 표에서 올릴 것을 고른다.
3. `akg push` 면 같은 명령에 `--dry-run` 을 붙여 먼저 돌린다.
4. 실제 명령과 dry-run 결과를 사용자에게 보여 준다.
5. 사용자의 동의를 받는다.
6. 명령을 돌린다.
7. 2절 표의 확인 칸대로 확인한다.
8. 결과(생성 · 갱신 · 오류 이유)를 사용자에게 보여 준다.

## 4. 오류

| 응답 | 뜻 | 할 일 |
| --- | --- | --- |
| 401 | 토큰이 틀렸거나 만료됐다 | 1절 표의 받는 곳에서 토큰을 다시 받는다. 1절 절차 3의 `curl` 로 다시 확인한다 |
| 403 | agent 범위 밖의 일이다(승격 · 삭제 · 역할 · 타입 등록) | 그 일은 사람이 한다. 사용자에게 AKG 화면에서 해 달라고 요청한다 |
| 409 | 받은 뒤에 서버 문서가 바뀌었다 | `akg sync` 로 최신을 받는다. 고친 것을 새 원본 위에 다시 얹는다. 같은 `akg push` 를 다시 돌린다 |

## 5. 올린 뒤

agent 가 쓴 슬롯은 추정(inferred)으로 들어간다. 확정(confirmed)으로 올리는 승격은 사람이
AKG 화면에서 한다. 슬롯 제안은 리뷰 큐에 들어가고, 채택 · 거절도 사람이 AKG 화면에서 한다.
