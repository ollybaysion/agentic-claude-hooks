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
- CSRF 헤더(`x-csrf-token`)는 브라우저 세션(사람)의 쓰기만 쓴다. 프로그램의 요청은
  Bearer 헤더 하나로 끝난다.
- 토큰 값은 서버 종류에 따라 한 곳에서 온다.

| 서버 | 토큰 값 | 받는 곳 |
| --- | --- | --- |
| 비밀번호 파일 서버(`FDC_AUTH_KEYCLOAK_ISSUER` 가 빔) | `FDC_AUTH_USERS_FILE`(users.yml)에서 `group: agent` 줄의 비밀번호 | 서버 관리자가 그 줄을 만들어 값을 준다. 사람 줄(admin · user)의 비밀번호는 Bearer 로 401 이다 |
| Keycloak 서버 | realm `fdc-voc-agent` 의 client `fdc-voc-agent-a2a` 로 받은 access token(client_credentials) | Keycloak 토큰 엔드포인트. 만료되면 다시 받는다. 그 client 에 agent 역할이 있어야 한다 |

Keycloak 서버에서 토큰을 받는 명령(issuer 주소와 client secret 은 서버 관리자가 준다):

```bash
install -m 600 /dev/null ~/.claude/akg/token
curl -sS -d grant_type=client_credentials -d client_id=fdc-voc-agent-a2a \
  -d client_secret="$A2A_SECRET" \
  "$FDC_AUTH_KEYCLOAK_ISSUER/protocol/openid-connect/token" \
  | jq -r .access_token > ~/.claude/akg/token
```

자세한 것은 AKG [`docs/consuming.md`](https://github.com/ollybaysion/agent-knowledge-governance/blob/main/docs/consuming.md#9-프로그램이-akg-에-바로-붙는-법)
의 "9. 프로그램이 AKG 에 바로 붙는 법" 절에 있다(요청 모양 · 되는 경로 · 오류 코드).

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
| 새 md 문서 | 본문 md | `akg push <type>/<id> 문서.md --create --note "<글>"` | 출력 `pushed <type>/<id> (rev <rev>) — 새 문서` |
| 기존 문서의 본문 수정 | 고친 본문 md | `akg push <type>/<id> 문서.md --rev <rev> --note "<글>"` | 출력 `pushed <type>/<id> (rev <rev>)`, 문서 조회의 `.json.body.markdown` 이 고친 글 |
| 기존 문서 전체 수정(body · links) | 고친 문서 json | `akg push <type>/<id> 문서.json --rev <rev> --note "<글>"` | 출력 `pushed <type>/<id> (rev <rev>)`, 문서 조회의 `.json.body` · `.json.links` 가 고친 값 |
| 슬롯 제안 | `proposal.json`(`{"slots": {…}}`) | `akg propose <type>/<id> proposal.json` | 출력 `proposed <type>/<id>: <uuid>` 또는 `proposal already pending: <uuid>` |
| 표 카탈로그 | `describe_table` 결과 json | `akg catalog-push <table> describe.json` | 출력 `catalog pushed: db-schema/<table> (rev <rev>)` |

`akg push` 의 파일 둘:

- `.md` 파일은 body 가 `{ name, markdown }` 인 타입(md 타입 · `domain-skill` · `domain`)에
  쓴다. 화면에서 등록한 md 타입도 같다. 수정은 body 의 `markdown` 만 바꾼다. 봉투와 links 는
  서버의 것이 남는다.
- `.json` 파일은 문서 전체(봉투 + body)다. 수정은 body 를 서버에 PUT 한다. 파일의 links 가
  서버와 다르면 links 도 PUT 한다. 그 밖의 봉투 칸(keywords · status …)은 서버 값이 남고,
  CLI 가 그 칸 이름을 stderr 에 알린다.

`akg push` 의 플래그:

- `--create` 는 새 문서를 만들 때 붙인다. 서버에 그 문서가 없으면(404) 이 플래그가 있을 때
  만든다. 새 문서는 비활성(inactive)으로 들어간다. 활성화는 admin 이 AKG 화면에서 한다.
- `--rev <rev>` 는 원본을 읽은 때의 rev 다. 서버가 그 뒤에 바뀌었으면 409 로 멈춘다.
  그래서 남이 그 사이에 고친 것이 지켜진다. 수정할 때는 늘 붙인다.
- `--note <글>` 은 서버 이력의 메시지가 된다.
- `--dry-run` 은 로컬 파일의 모양만 검사한다. 통과하면
  `dry-run ok: <type>/<id> (md|json) — 쓰지 않았습니다` 가 나온다.
- `--server <url>` · `--mirror <dir>` 은 환경변수 대신 쓴다.

고칠 원본과 rev 는 서버에서 받는다(`jq` 사용):

```bash
curl -sS -H "Authorization: Bearer $AKG_TOKEN" "$AKG_SERVER/api/docs/<type>/<id>" > 원본.json
jq -r '.rev' 원본.json                       # --rev 에 넣을 값
jq -r '.json.body.markdown' 원본.json > 문서.md   # md 본문
jq '.json' 원본.json > 문서.json                 # 문서 전체
```

표의 "문서 조회"는 첫 줄과 같은 `curl` 이다.

## 3. 절차

1. 인자에서 `<type>/<id>` 와 파일을 읽는다. 빠진 것은 사용자에게 묻는다.
2. 2절 표에서 올릴 것을 고른다.
3. 수정이면 2절의 `curl` 로 원본과 rev 를 받는다.
4. 받은 원본 위에 고친다.
5. `akg push` 면 같은 명령에 `--dry-run` 을 붙여 먼저 돌린다.
6. 실제 명령과 dry-run 결과를 사용자에게 보여 준다.
7. 사용자의 동의를 받는다.
8. 명령을 돌린다. 수정이면 3에서 받은 rev 를 `--rev` 로 준다.
9. 2절 표의 확인 칸대로 확인한다.
10. 결과(생성 · 갱신 · 오류 글)를 사용자에게 보여 준다.

## 4. 오류

CLI 는 실패하면 `akg push failed: …` 와 서버의 오류 글을 stderr 에 적고 1 로 끝난다.

| 응답 | 뜻 | 할 일 |
| --- | --- | --- |
| 401 | 토큰이 틀렸거나 만료됐다(`unauthorized`). 실패가 잦으면 429 로 잠시 막힌다 | 1절 표의 받는 곳에서 토큰을 다시 받는다. 1절 절차 3의 `curl` 로 다시 확인한다 |
| 403 | 토큰은 맞고 agent 범위 밖의 일이다(`forbidden`): 승격 · 활성화 · 삭제 · 역할 · 타입 등록 · 제안 채택 | 그 일은 admin 이 한다. 사용자에게 AKG 화면에서 해 달라고 요청한다 |
| 404 | 문서가 없다(`push: 없는 문서 … — --create 로 만든다`) | 새 문서면 `--create` 를 붙여 다시 돌린다. 수정이면 `<type>/<id>` 를 확인한다 |
| 409 | 서버가 앞섰다(`push: 서버가 앞섭니다 — sync 뒤 다시`), 또는 방금 생겼다(`already_exists`) | `akg sync` 를 돌린다. 2절의 `curl` 로 원본과 rev 를 다시 받는다. 고친 것을 새 원본 위에 다시 얹는다. 새 rev 로 `akg push` 를 다시 돌린다 |
| 400 | 내용이 틀렸다(`validation_failed` · `edit_rejected` · `unknown_type` · `unknown_link_target` …) | 서버 글을 사용자에게 그대로 보여 준다. 그 글대로 파일을 고친다 |

409 의 `data_id_conflict`(데이터 id 겹침) · `type_archived`(닫힌 타입)는 내용 거절이다.
서버 글을 사용자에게 그대로 보여 준다.

## 5. 올린 뒤

agent 가 쓴 슬롯은 추정(inferred)으로 들어간다. 확정 슬롯을 고치면 추정으로 내려간다.
확정(confirmed)으로 올리는 승격은 사람이 AKG 화면에서 한다. `--create` 로 만든 문서의
활성화도 admin 이 화면에서 한다. 슬롯 제안은 리뷰 큐에 들어가고, 채택 · 기각도 admin 이
화면에서 한다. 미러는 다음 `akg sync` 에서 갱신된다.
