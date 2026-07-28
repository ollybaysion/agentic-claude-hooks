# claude-hooks on opencode — 설치·운영 매뉴얼

claude-hooks의 가드(bash-guard·git-guard)와 관측(observability collector)을
**opencode 세션에도 그대로 적용**하는 어댑터의 설치 문서다. 이슈 #74.

- 어댑터: [`adapters/opencode/plugin.js`](../adapters/opencode/plugin.js)
- 설치기: [`adapters/opencode/install.mjs`](../adapters/opencode/install.mjs)
- 규칙 본체(공유): [`core/bash-guard/decide.mjs`](../core/bash-guard/decide.mjs),
  [`core/git-guard/decide.mjs`](../core/git-guard/decide.mjs)

> **한 줄 요약**: `node adapters/opencode/install.mjs` → opencode 재시작 →
> opencode에게 `rm -rf` 시켜보고 거부되면 끝.

---

## 1. 무엇이 켜지는가

| | opencode에서 하는 일 | 대응하는 CC 훅 |
| --- | --- | --- |
| **bash-guard** | `rm -rf`·디스크 파괴·`curl \| sh`·비밀 파일 노출 등을 `tool.execute.before`에서 `throw`로 차단 | PreToolUse deny |
| **git-guard** | main/master 직접 커밋·푸시, force push, `--no-verify`, 에이전트의 PR 머지, 보호 브랜치 파일 수정 차단 | PreToolUse deny |
| **재시도 차단** | 거부된 명령을 다시 시도하면 문구가 단계적으로 강해진다 (2회=재시도 금지, 3회+=사용자에게 물어라) | (opencode 전용) |
| **관측** | 프롬프트·툴 호출·세션 라이프사이클을 로컬 collector로 전송 → 대시보드 sessions 탭에 `oc` 배지로 표시 | send-event |
| **collector 자동 기동** | collector가 안 떠 있으면 detached로 띄움 | obs-lazy-start |

**규칙은 복제되지 않았다.** 판정은 CC 훅이 쓰는 `core/*/decide.mjs`를 그대로
호출한다 — 한쪽에서 규칙을 고치면 양쪽이 같이 바뀐다. 어댑터 파일은 I/O만 한다.

### 차이점 (정직하게)

| 항목 | Claude Code | opencode |
| --- | --- | --- |
| `ask` 판정 (`git reset --hard`, `git clean -f`, `checkout .`) | 사용자에게 확인 요청 | **차단**(`tool.execute.before`엔 ask 채널이 없다). `CLAUDE_HOOKS_OC_ASK=allow`로 통과시킬 수 있다 |
| 스타일 넛지 (grep→rg, find→fd, cat→read …) | deny 후 재시도 유도 | 동일. 시끄러우면 `CLAUDE_HOOKS_OC_NUDGES=off` |
| 토큰/비용 (Tokens 탭) | CC 트랜스크립트 파싱 | **없음.** opencode 토큰은 자체 DB(`opencode.db`)에 있고 아직 수집하지 않는다 (이슈 #119) |
| 컨텍스트 주입(keyword-docs 등) | UserPromptSubmit | **없음.** opencode에 동급 훅이 없다 |
| lint(PostToolUse 교정 루프) | 있음 | 아직 없음 |

### 같은 명령 반복 시도 차단

거부된 명령을 에이전트가 그대로 다시 던지는 건 흔한 실패 모드다. 판정은 재시도해도
안 바뀌므로, 어댑터는 **세션별로 같은 시도를 세어 문구를 단계적으로 올린다.**

| 시도 | 에이전트가 받는 메시지 |
| --- | --- |
| 1회 | 원래 거부 사유 (왜 막혔는지) |
| 2회 | + "같은 명령을 다시 실행하지 마라 — 인자만 바꿔 재시도하는 것도 안 된다. 다른 방법을 찾거나 사용자에게 물어라" |
| 3회+ | + "이 세션에서 N번 거부됐다. 재시도를 멈추고 사용자에게 설명한 뒤 지시를 받아라" |

- 같은 명령 판정은 **공백을 정규화한 명령 문자열**(또는 대상 파일 경로) 기준 —
  줄바꿈/들여쓰기만 바꾼 재시도는 같은 시도로 센다.
- **세션별로 따로 센다.** 다른 세션·다른 대상은 다시 1회부터.
- 횟수는 GuardDecision 이벤트의 `repeat` 필드로도 나가므로, 대시보드 guards 탭의
  `top_commands`에서 "한 명령을 N번 갈고 있는 세션"이 그대로 보인다.

---

## 2. 설치

opencode가 **실제로 도는 그 머신**에서 한다. 요구사항은 두 가지뿐이다 — 이 저장소
체크아웃 하나, 그리고 `node`(collector 기동용. 가드 자체는 opencode의 Bun에서 돈다).
npm install은 없다(런타임 의존성 0).

### 2.0 준비 — 체크아웃 하나

스텁이 체크아웃 경로를 가리키므로 **경로가 변하지 않는 clone**이 필요하다.

```bash
git clone git@github.com:ollybaysion/agentic-claude-hooks.git ~/repo/claude-hooks
# PR #132 머지 전이라면:
git -C ~/repo/claude-hooks switch feat/opencode-adapter
```

> ⚠️ `~/.claude/plugins/…` **마켓플레이스 캐시 경로를 가리키게 하지 마라** — 플러그인
> 업데이트마다 경로가 바뀌어 스텁이 끊긴다. 체크아웃을 옮겼다면 설치기를 다시 실행한다.

### 2.1 전역 설치 (권장)

```bash
node ~/repo/claude-hooks/adapters/opencode/install.mjs
# node가 없으면 bun으로도 된다: bun ~/repo/claude-hooks/adapters/opencode/install.mjs
```

`~/.config/opencode/plugin/claude-hooks.js` 와 `~/.config/opencode/plugins/claude-hooks.js`
**둘 다**에 스텁을 쓴다. 디렉터리 이름이 opencode 버전에 따라 `plugin`(구버전) /
`plugins`(현재 문서)로 갈리는데, 안 읽히는 쪽은 그냥 무시될 뿐이고 **틀린 쪽 하나만
깔면 가드가 조용히 아무 일도 안 하기 때문**이다.

스텁 내용은 한 줄이다:

```js
export { ClaudeHooksGuard } from "/path/to/claude-hooks/adapters/opencode/plugin.js";
```

즉 **체크아웃을 가리키기만 한다** → `git pull` 하면 가드도 같이 갱신된다(재설치 불필요).

### 2.2 프로젝트 단위 설치

```bash
cd /path/to/project
node /path/to/claude-hooks/adapters/opencode/install.mjs --project   # ./.opencode/plugin{,s}/
```

### 2.3 그 외

```bash
node adapters/opencode/install.mjs --dir ~/.config/opencode/plugin   # 경로 직접 지정
node adapters/opencode/install.mjs --print                           # 스텁 내용만 출력
node adapters/opencode/install.mjs --uninstall                       # 설치한 스텁 제거
```

**설치 후 opencode를 재시작**해야 한다 (플러그인은 기동 시 로드된다).

---

## 3. 검증 (설치 직후 2분)

1. **가드**: opencode에게 아래를 시킨다.

   ```text
   rm -rf /tmp/claude-hooks-guard-check 실행해줘
   ```

   → `[claude-hooks/bash-guard] 파괴적 'rm -rf' 거부…` 메시지와 함께 실행이 막혀야 한다.
   막히지 않으면 §6 트러블슈팅.

2. **git-guard**: main 브랜치가 체크아웃된 저장소에서 파일 수정을 시켜본다.
   → `'main' 브랜치에서 파일 수정 거부…` 가 떠야 한다.

3. **관측**: <http://127.0.0.1:4090> → **sessions** 탭.
   방금 그 opencode 세션이 세션 ID 옆 **`OC` 배지**와 함께 보여야 한다.
   (collector가 안 떠 있었다면 어댑터가 알아서 띄운다. 수동으로는
   `node core/observability/server.mjs &`.)

   > **대시보드는 하나다 — 단, 머신당 하나.** Claude Code 세션과 opencode 세션은
   > 같은 collector·같은 DB·같은 sessions 탭에 들어가고 `runtime` 배지로만 구분된다
   > (탭·포트·DB를 따로 만들지 않았다). 다만 collector는 `127.0.0.1`에만 바인딩하고
   > 요청의 Host도 loopback만 받으므로 **박스가 다르면 각자 자기 대시보드**가 된다.
   > 한 곳에 모으려면 opencode 박스에서 SSH 터널을 열어 그 포트로 보내면 된다:
   > `ssh -N -L 4090:127.0.0.1:4090 <대시보드-박스>` + `CLAUDE_HOOKS_OC_AUTOSTART=off`
   > (터널이 이미 4090을 점유하므로 로컬 collector는 안 뜬다).

4. **차단 기록**: 같은 대시보드 **guards** 탭에 방금 거부가 `bash-guard /
   dangerous-rm`으로 집계된다.

CC 쪽 회귀는 기존 테스트로 확인한다:

```bash
node core/bash-guard/test.mjs        # CC 어댑터 (규칙 코어 공유 후에도 동일)
node core/git-guard/test.mjs
node adapters/opencode/test.mjs      # opencode 어댑터 (차단/통과/fail-open)
node core/observability/test.mjs     # 수집기 (runtime 컬럼 + 기간 필터 포함)
```

---

## 4. 스위치 (환경변수)

opencode를 띄우기 전에 export 한다.

| 변수 | 기본 | 효과 |
| --- | --- | --- |
| `CLAUDE_HOOKS_OC_GUARD=off` | on | 차단 전부 끄기 (관측만) |
| `CLAUDE_HOOKS_OC_NUDGES=off` | on | 안전 차단만 남기고 스타일 넛지 제거 |
| `CLAUDE_HOOKS_OC_ASK=allow` | block | `git reset --hard` 류를 통과시킴 |
| `CLAUDE_HOOKS_OC_OBSERVE=off` | on | collector로 아무것도 안 보냄 |
| `CLAUDE_HOOKS_OC_AUTOSTART=off` | on | collector 자동 기동 안 함 |
| `CLAUDE_HOOKS_NODE=/usr/bin/node` | `node` | collector를 띄울 node 바이너리 지정 |
| `CLAUDE_HOOKS_OC_DEBUG=1` | off | 내부 오류를 stderr로 출력 (조용한 실패 추적용) |
| `OBS_PORT` / `OBS_HOST` | 4090 / 127.0.0.1 | collector 주소 |

---

## 5. 보조 방어선 — opencode 자체 permission

플러그인과 **별개로** opencode 설정에도 안전망을 걸어두면 좋다
(`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": {
      "rm *": "ask",
      "git push *": "ask",
      "*": "allow"
    }
  }
}
```

플러그인 가드는 argv를 해석해서 판정하고(오탐이 적다), 이 설정은 문자열 패턴이라
거칠지만 **플러그인이 로드되지 않았을 때도 동작한다**. 둘 다 켜두는 걸 권장한다.

---

## 6. 트러블슈팅

### 가드가 안 걸린다

1. 스텁이 실제로 읽히는 디렉터리에 있는지: `ls ~/.config/opencode/plugin*/claude-hooks.js`
2. opencode를 재시작했는지 (플러그인은 기동 시 로드)
3. `CLAUDE_HOOKS_OC_DEBUG=1 opencode` 로 띄워 stderr에 뜨는 오류 확인
4. 스텁의 경로가 실제 체크아웃을 가리키는지 (`cat` 대신 Read/에디터로 확인).
   체크아웃을 옮겼다면 `install.mjs`를 다시 실행한다
5. opencode 버전이 `plugin`/`plugins` 중 어느 쪽을 읽는지 모르면 둘 다 둔다
   (설치기 기본값이 이미 그렇다)

### 대시보드에 세션이 안 보인다

- collector가 떴는지: `curl -s 127.0.0.1:4090/health`
- 어댑터가 collector를 못 띄운 경우(= PATH에 `node` 없음): `CLAUDE_HOOKS_NODE`로
  절대경로 지정, 또는 수동 기동
- 기간 필터가 짧아서 안 보일 수도 있다 — sessions 탭 기간을 **30d / 전체**로

### 정상적인 명령이 막힌다 (오탐)

- 임시 회피: `CLAUDE_HOOKS_OC_NUDGES=off` (넛지 계열), `CLAUDE_HOOKS_OC_ASK=allow`
  (파괴적 git 계열)
- 진짜 오탐이면 규칙 코어(`core/*/decide.mjs`)의 문제이므로 이슈로 남긴다 —
  CC와 opencode가 같은 코어를 쓰므로 고치면 양쪽이 같이 고쳐진다

### opencode가 플러그인 자체를 로드하다 죽는다

- 어댑터는 모든 훅에서 자기 오류를 삼키지만(fail-open), 로드 실패는 별개다.
  `--uninstall`로 스텁을 빼고 opencode가 정상 기동하는지 먼저 분리한다

---

## 7. 아직 안 되는 것 (남은 작업)

- **토큰·비용**: opencode의 per-step 토큰은 `~/.local/share/opencode/opencode.db`에
  있다. 대시보드 Tokens 탭은 CC 트랜스크립트만 읽으므로 opencode 세션은 비어 보인다.
  → 이슈 #119(기존 세션 백필) 재개가 필요하다.
- **과거 세션 백필**: 이 어댑터는 **설치 이후**의 세션만 기록한다.
- **컨텍스트 주입 / lint 교정 루프**: opencode에 UserPromptSubmit 동급 훅이 없고,
  `tool.execute.after` 피드백이 CC의 exit-2 교정 루프와 등가인지 미검증.
- **`permission.ask` 훅**: 보조 방어선으로 구현해 뒀지만 실제 opencode에서
  호출되는 입력 형태를 검증하지 못했다 (없으면 그냥 호출되지 않을 뿐, 무해).
