# git-guard ✅

**main/master 직접 작업 + force push를 차단**하는 PreToolUse 훅.

- **Event**: `PreToolUse` (matcher `Bash` + `Write|Edit|MultiEdit`)
- **Mechanism**: 위반 시 구조화된 `permissionDecision:"deny"` + 타입화된 이유 (stdout JSON + exit 0) — bash-guard와 동일
- **Requirement**: Node.js + `git` (PATH). git 저장소가 아니거나 git이 없으면 **fail-open**
- **복합명령 분리**: `;` `&&` `||` `|` 줄바꿈으로 쪼개 각 조각 검사
- **범위**: main 보호 + force-push. `reset --hard`·`clean`·`checkout .`은 **bash-guard** 소관

## 차단 규칙

| 도구 | 조건 | 차단 이유 |
| --- | --- | --- |
| `Write`/`Edit`/`MultiEdit` | 현재 HEAD가 `main`/`master` | 보호 브랜치 직접 수정 → "브랜치 먼저" |
| `Bash` (`git commit`) | 현재 HEAD가 `main`/`master` | 보호 브랜치 직접 커밋 |
| `Bash` (`git push`) | 대상이 `main`/`master` | 보호 브랜치로 직접 push → PR로 |
| `Bash` (`git push`) | `--force` / `-f` | force push (히스토리 덮어쓰기). `--force-with-lease`는 허용 |

> 왜 hook인가: "지금 어느 브랜치냐"는 **git 상태**가 필요해서 — 상태 없는 명령 매처(bash-guard)로는 불가능. main 보호·force-push는 git-guard, 그 외 파괴적 명령은 bash-guard로 경계가 깔끔하다.

## 로컬 테스트

```bash
cd claude-hooks
# main에서 파일 수정 차단 (claude-hooks가 main/master일 때)
echo '{"tool_name":"Write","tool_input":{"file_path":"x"}}' | node core/git-guard/git-guard.mjs
# main 직접 push 차단
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | node core/git-guard/git-guard.mjs
# force push 차단
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force origin feat"}}' | node core/git-guard/git-guard.mjs
# --force-with-lease는 통과 (안전 변형)
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force-with-lease origin feat"}}' | node core/git-guard/git-guard.mjs
# 일반 명령 통과
echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | node core/git-guard/git-guard.mjs
```
