# git-guard ✅

**main/master 직접 작업 + force push + `--no-verify` + 에이전트의 PR 머지를 차단**하는 PreToolUse 훅.

- **Event**: `PreToolUse` (matcher `Bash` + `Write|Edit|MultiEdit`)
- **Mechanism**: 위반 시 구조화된 `permissionDecision:"deny"` + 타입화된 이유 (stdout JSON + exit 0) — bash-guard와 동일
- **Requirement**: Node.js + `git` (PATH). git 저장소가 아니거나 git이 없으면 **fail-open**
- **argv 기반 탐지**: 명령을 `;` `&&` `||` `|` `&` 줄바꿈·명령치환(`$(…)`/백틱)으로 쪼개 **각 조각을 따옴표 인식 argv로 토큰화**한 뒤, 실제 `git`/`gh` 서브커맨드(`push`/`commit`/`merge`, `gh pr merge`, `gh api …/pulls/<n>/merge`)일 때만 규칙을 건다. 단어 `push`·`main`·`merge`가 인자·메시지에 **우연히 함께 나온다고** 걸리지 않음 — 예: `git show main:push.txt`, `gh pr create --title "merge …"`는 통과. `push` 대상은 refspec 목적지에서만 `main`/`master`를, 머지 API는 **PUT**만 매칭(조회성 GET·`--help`는 통과)
- **Write/Edit 판정 기준 = 대상 파일**: Write/Edit/MultiEdit은 세션 cwd가 아니라 **`file_path`가 속한 저장소**의 브랜치로 판정한다(#71). cwd가 main 체크아웃이어도 저장소 밖·다른 워크트리 파일은 통과하고, 반대로 cwd가 어디든 main 체크아웃 안 파일은 차단. 상대경로는 세션 cwd 기준으로 해석, 아직 없는 디렉토리는 존재하는 조상으로 판정. Bash 규칙은 명령이 cwd에서 실행되므로 기존대로 세션 cwd 기준
- **범위**: main 보호 + force-push + `--no-verify` + PR 머지 차단. `reset --hard`·`clean`·`checkout .`은 **bash-guard** 소관

## 차단 규칙

| 도구 | 조건 | 차단 이유 |
| --- | --- | --- |
| `Write`/`Edit`/`MultiEdit` | **`file_path`가 속한 저장소**의 HEAD가 `main`/`master` | 보호 브랜치 직접 수정 → "브랜치 먼저" |
| `Bash` (`git commit`) | 현재 HEAD가 `main`/`master` | 보호 브랜치 직접 커밋 |
| `Bash` (`git push`) | 대상이 `main`/`master` | 보호 브랜치로 직접 push → PR로 |
| `Bash` (`git push`) | `--force` / `-f` | force push (히스토리 덮어쓰기). `--force-with-lease`는 허용 |
| `Bash` (모든 git) | `--no-verify` | pre-commit/pre-push 훅 우회 |
| `Bash` (`gh pr merge`) | 모든 플래그 변형(`--merge`/`--squash`/`--rebase`/`--auto`/`--admin`) | 에이전트 PR 머지 → 사람이 리뷰 후 직접 (`--help`은 통과) |
| `Bash` (`gh api`) | `pulls/<n>/merge` 엔드포인트에 `PUT` | REST 우회 머지 (조회성 `GET`은 통과) |
| `Bash` (`git merge`) | 현재 HEAD가 `main`/`master` | 저수준 머지 우회 (`--abort`/`--continue`/`--quit`은 통과) |

> 왜 hook인가: "지금 어느 브랜치냐"는 **git 상태**가 필요해서 — 상태 없는 명령 매처(bash-guard)로는 불가능. main 보호·force-push·no-verify는 git-guard, 그 외 파괴적 명령은 bash-guard로 경계가 깔끔하다.
>
> **참고**: 짧은 `-n`(commit에서 `--no-verify` 의미)은 커밋 메시지 속 "-n" 오탐을 피하려 잡지 않는다. 의도적 우회는 보통 `--no-verify`로 쓴다.

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
# --no-verify 차단
echo '{"tool_name":"Bash","tool_input":{"command":"git commit --no-verify -m x"}}' | node core/git-guard/git-guard.mjs
# gh pr merge 차단 (에이전트 머지 금지 — 모든 플래그 변형)
echo '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 30 --squash"}}' | node core/git-guard/git-guard.mjs
# gh api PUT 로 merge 엔드포인트 우회 차단
echo '{"tool_name":"Bash","tool_input":{"command":"gh api -X PUT repos/o/r/pulls/30/merge"}}' | node core/git-guard/git-guard.mjs
# main 체크아웃 상태의 git merge 차단 (feature 브랜치에선 통과)
echo '{"tool_name":"Bash","tool_input":{"command":"git merge feature"}}' | node core/git-guard/git-guard.mjs
# 조회성/도움말은 통과 (gh pr view, gh pr merge --help, merge 엔드포인트 GET)
echo '{"tool_name":"Bash","tool_input":{"command":"gh pr merge --help"}}' | node core/git-guard/git-guard.mjs
# 일반 명령 통과
echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | node core/git-guard/git-guard.mjs
```
