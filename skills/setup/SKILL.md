---
name: setup
argument-hint: "[claude | opencode | env | akg | check]"
disable-model-invocation: true
description: >-
  새 머신에 이 플러그인을 처음 들이는 절차: 체크아웃 하나 → Claude Code 설치 → opencode
  설치 → 환경변수 → AKG 연결(akg-pull · akg-push 가 쓴다) → 확인. 인자로 한 단계만 할 수도
  있다. /setup 으로만 호출된다(모델 자동 발동 없음).
---

# setup

이 플러그인(claude-hooks)을 **새 머신에 처음 들이는** 절차다. 순서대로 하면 Claude Code 와
opencode 둘 다 같은 가드 · 관측 · 스킬을 쓰게 된다. 인자를 주면 그 단계만 한다
(`claude` · `opencode` · `env` · `akg` · `check`).

각 명령은 사용자에게 보여 주고 동의를 받은 뒤 실행한다. 설치 · 전역 npm · 셸 설정 파일
수정은 전부 사용자 머신을 바꾸는 일이다.

## 0. 전제

| 도구 | 쓰는 곳 | 확인 |
| --- | --- | --- |
| `node` 18+ | 훅 전부(.mjs), collector, 설치기 | `node --version` |
| `git` · `gh`(로그인) | git-guard, agentic-coding-git-workflow | `gh auth status` |
| `rg` · `fd` | bash-guard 의 넛지가 `grep`/`find` 대신 권한다 | `rg --version`, `fd --version` |
| `markdownlint-cli2` · `prettier` · `eslint` · `html-validate` | lint 훅(md · json · js · html) | `npm i -g markdownlint-cli2 prettier eslint html-validate` |
| `shellcheck` · `shfmt` · `ruff` | lint 훅(sh · py). 없으면 그 확장자만 건너뛴다 | 배포판 패키지 또는 정적 바이너리 |

없는 도구가 있어도 훅은 **fail-open** 이다(그 검사만 쉬고 세션은 멈추지 않는다).
`gh` 가 없거나 미인증이면 `! gh auth login` 을 안내한다.

## 1. 체크아웃 하나 (경로 고정)

```bash
git clone git@github.com:ollybaysion/agentic-claude-hooks.git ~/work/claude-plugins/claude-hooks
```

이 경로가 기준이다. opencode 의 플러그인 스텁과 스킬 링크가 **이 경로를 가리키므로**
옮기면 설치기를 다시 돌려야 한다. `~/.claude/plugins/…` 마켓플레이스 캐시는 버전마다
경로가 바뀌니 opencode 쪽에서는 쓰지 않는다.

## 2. Claude Code 설치 (`claude`)

두 길 중 하나. 훅(`hooks/hooks.json`)과 `skills/*` 는 플러그인 로더가 자동으로 읽는다.

- **마켓플레이스(보통)** — Claude Code 안에서:

  ```text
  /plugin marketplace add ollybaysion/agentic-claude-hooks
  /plugin install claude-hooks@claude-hooks
  ```

  갱신은 `/plugin` 화면의 update 로 받는다. **버전(`.claude-plugin/plugin.json`)이
  올라가야 update 가 새 것으로 본다** — 같은 버전으로 올린 PR 은 받지 않는다.

- **로컬 체크아웃(개발 · 한 머신)**:

  ```bash
  claude --plugin-dir ~/work/claude-plugins/claude-hooks
  ```

  세션 안에서 고친 뒤에는 `/reload-plugins`. 이 길은 `git pull` 이 곧 갱신이다.

확인: 새 세션을 열면 SessionStart 가 git 상태를 넣어 주고, `/claude-hooks:` 를 치면
스킬 목록(agentic-coding-git-workflow · svg-diagram · setup · akg-pull · akg-push)이 뜬다.

## 3. opencode 설치 (`opencode`)

opencode 가 **실제로 도는 머신**에서 한다. 자세한 것은 [docs/opencode.md](../../docs/opencode.md).

```bash
node ~/work/claude-plugins/claude-hooks/adapters/opencode/install.mjs
```

이 한 번이 둘을 한다:

1. `~/.config/opencode/plugin{,s}/claude-hooks.js` — 체크아웃의 `adapters/opencode/plugin.js`
   를 재export 하는 한 줄 스텁(가드 + 관측).
2. `~/.config/opencode/skills/<name>` → 체크아웃의 `skills/<name>` 심볼릭 링크(스킬).

그다음 opencode 를 재시작한다(플러그인 · 스킬은 기동 때 읽는다). 되돌리기는
`install.mjs --uninstall`.

확인: opencode 에게 `rm -rf /tmp/claude-hooks-guard-check` 를 시키면
`[claude-hooks/bash-guard]` 로 거부한다. "setup <주제> 로 워크트리 만들어" 라고 하면
`skill` 도구로 agentic-coding-git-workflow 를 읽는다.

## 4. 환경변수 (`env`)

대부분 기본값으로 된다. 바꿀 것만 셸 설정(`~/.bashrc` · `~/.zshrc`)에 `export` 한다.
훅과 opencode 플러그인 모두 **셸에서 상속**받으므로 한 곳이면 된다. 토큰은 환경변수
대신 파일(0600)로 두는 쪽이 기본이다.

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `OBS_PORT` · `OBS_HOST` | `4090` · `127.0.0.1` | 관측 collector 가 듣는 곳. 대시보드 `http://127.0.0.1:4090` |
| `OBS_DATA_DIR` | `$XDG_STATE_HOME/claude-observability`, 없으면 `~/.claude/observability` | SQLite · config · pidfile 자리 |
| `OBS_TOKEN` | 비움(인증 끔) | collector 베어러 토큰. 루프백은 기본 신뢰 |
| `OBS_MAX_AGE_DAYS` · `OBS_MAX_ROWS` · `OBS_MAX_DB_MB` | `7` · `500000` · `1024` | 보존 한도 |
| `CLAUDE_HOOKS_OC_GUARD` · `_NUDGES` · `_ASK` · `_OBSERVE` · `_AUTOSTART` | 전부 켜짐 | opencode 쪽 스위치. `off` 로 끈다(`_ASK=allow` 는 ask 급을 통과) |
| `CLAUDE_HOOKS_NODE` | `node` | opencode 플러그인이 collector 를 띄울 때 쓰는 node 경로 |
| `AKG_SERVER` | 미러 `meta.json` 의 `serverUrl` | AKG 서버 URL |
| `AKG_TOKEN` | `~/.claude/akg/token` 파일 | AKG 인증 토큰(파일이 기본) |
| `AKG_MIRROR` | `~/.claude/akg` | AKG 미러(`<type>/{index.json, docs/*.md}`) |
| `AKG_SKILLS_DIR` | `~/.claude/skills` | `akg sync --skills` 가 내려놓는 스킬 자리 |

나머지(`OBS_REDACT` · `OBS_DURABLE` · `OBS_MEGA_*` …)는 `core/observability/README.md` 의 표.

## 5. AKG 연결 (`akg`) — akg-pull · akg-push 가 쓴다

AKG = [agent-knowledge-governance](https://github.com/ollybaysion/agent-knowledge-governance).
지식 문서의 공유 레지스트리(서버)와 그 CLI `akg` 다. `akg-pull` 은 `akg sync`,
`akg-push` 는 `akg push` · `akg propose` 를 부른다.

1. 체크아웃과 CLI:

   ```bash
   git clone git@github.com:ollybaysion/agent-knowledge-governance.git ~/work/fdc-agent/agent-knowledge-governance
   npm --prefix ~/work/fdc-agent/agent-knowledge-governance install
   npm link ~/work/fdc-agent/agent-knowledge-governance   # `akg` 를 PATH 에
   ```

   `npm link` 를 피하려면 `node ~/work/fdc-agent/agent-knowledge-governance/bin/akg.mjs …` 로 부른다.

2. 서버 주소와 토큰:

   ```bash
   export AKG_SERVER=https://<akg 서버>
   install -m 600 /dev/null ~/.claude/akg/token && printf '%s' '<토큰>' > ~/.claude/akg/token
   ```

3. 첫 동기화: `akg sync`. 서버가 꺼져 있으면 "나중에 다시" 로 **fail-open** 이다.
   미러 `~/.claude/akg/<type>/` 가 생기면 `core/context` 의 keyword-docs hub 모드가
   같은 미러를 읽는다(설정은 `core/context/README.md` 의 Hub 절).

## 6. 확인 (`check`)

| 무엇 | 어떻게 | 기대 |
| --- | --- | --- |
| 훅 | Claude Code 새 세션 | SessionStart 가 git 상태를 넣는다 |
| 가드 | `rm -rf /tmp/x` 시키기 | bash-guard 거부 |
| 관측 | `http://127.0.0.1:4090` | sessions 탭에 세션이 보인다(opencode 는 `oc` 배지) |
| 스킬 | `/claude-hooks:` 자동완성 · opencode 에 "setup <주제>" | 목록 · `skill` 도구 호출 |
| AKG | `akg sync` | 미러 갱신 또는 fail-open 안내 |

모두 되면 끝. 하나가 막히면 그 절의 README(`core/<모듈>/README.md`, `docs/opencode.md`)
트러블슈팅으로 간다.
