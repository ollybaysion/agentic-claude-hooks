# git-guard ✅

**main/master 브랜치에서의 직접 작업을 차단**하는 PreToolUse 훅. "작업은 브랜치를 따서 PR로"를 강제하는 가드레일.

- **Event**: `PreToolUse` (matcher `Bash` + `Write|Edit|MultiEdit`)
- **Mechanism**: 위반 시 구조화된 `permissionDecision:"deny"` + 타입화된 이유 (stdout JSON + exit 0) — bash-guard와 동일
- **Requirement**: Node.js + `git` (PATH). git 저장소가 아니거나 git이 없으면 **fail-open**
- **복합명령 분리**: `;` `&&` `||` `|` 줄바꿈으로 쪼개 각 조각 검사
- **범위**: main 보호만. 파괴적 명령(`push --force`, `reset --hard`, `clean -fd` 등)은 **bash-guard** 소관

## 차단 규칙

| 도구 | 조건 | 차단 이유 |
| --- | --- | --- |
| `Write`/`Edit`/`MultiEdit` | 현재 HEAD가 `main`/`master` | 보호 브랜치 직접 수정 → "브랜치 먼저" |
| `Bash` (`git commit`) | 현재 HEAD가 `main`/`master` | 보호 브랜치 직접 커밋 |
| `Bash` (`git push`) | 대상이 `main`/`master` | 보호 브랜치로 직접 push → PR로 |

> 왜 hook인가: "지금 어느 브랜치냐"는 **git 상태**가 필요해서 — 상태 없는 명령 매처(bash-guard)로는 불가능. 그래서 main 보호는 git-guard 몫이다.

## 로컬 테스트

```bash
cd claude-hooks
# 보호 브랜치에서 파일 수정 차단 (claude-hooks가 main/master일 때)
echo '{"tool_name":"Write","tool_input":{"file_path":"x"}}' | node core/git-guard/git-guard.mjs
# main 직접 push 차단
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | node core/git-guard/git-guard.mjs
# 일반 명령 통과 (무출력 + exit 0)
echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | node core/git-guard/git-guard.mjs
# feature 브랜치로의 force push는 통과 (이제 git-guard 범위 밖, bash-guard 소관)
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force origin feat"}}' | node core/git-guard/git-guard.mjs
# 범위 밖 도구 통과
echo '{"tool_name":"Read","tool_input":{"file_path":"x"}}' | node core/git-guard/git-guard.mjs
```
