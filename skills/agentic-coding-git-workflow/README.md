# agentic-coding-git-workflow ✅

개인 git 워크플로우를 하나로 묶은 **skill**. hook 이 아니라 사용자가 호출하는
절차형 skill 이다(Claude Code: `/claude-hooks:agentic-coding-git-workflow`,
opencode: 에이전트가 `skill` 도구로 읽는다 — `adapters/opencode/install.mjs` 가 링크).

- **종류**: Skill (SKILL.md) — `skills/agentic-coding-git-workflow/SKILL.md`
- **흐름**: `main 최신화 → feat 브랜치 + 워크트리 → 개발 → 커밋 → PR 생존 확인 → main 동기화 → push → PR → 정리`
- **출발점은 주제 하나**: `setup <주제> [워크트리 경로]`. 경로를 주면 그 자리, 비우면
  `<MAIN>` 옆 `worktrees/<repo>-<주제>`
- **국면**: 개발을 경계로 `setup`/`finish`, 머지 후 `cleanup`
  - `setup <주제> [경로]` — main 최신화 ~ 워크트리 생성
  - `finish` — 커밋 ~ PR (열린 PR 이 있으면 얹고, MERGED 면 멈춘다)
  - `cleanup` — 머지 후 워크트리 제거 → main 최신화 → 로컬 브랜치 삭제
  - 인자 없으면 상태로 자동 감지(main+clean → setup / feature 워크트리+변경 → finish /
    PR 머지+워크트리 잔존 → cleanup)
- **요구사항**: `git`, `gh`(GitHub CLI, 인증됨). 없으면 멈추고 안내(조용히 넘어가지 않음)

## 왜 skill 인가 (그리고 가드와의 관계)

`git-guard`/`bash-guard` 는 정책을 **강제**한다 — main 직접 작업 금지, force-push ·
`--no-verify` 차단, 에이전트 머지 차단(`gh pr merge` · main 에서의 `merge`/`pull <다른
브랜치>`/`rebase`, `git checkout main && git merge …` 같은 한 줄 연쇄 포함). 이 skill 은 그
정책을 그대로 따라가는 **happy-path** 다: 가드는 "하지 마라"(채찍), skill 은 "이 길로
가라"(포장도로). 그래서 각 단계가 가드와 충돌하지 않도록 설계됐다.

| 단계 | 명령 | 가드 |
| --- | --- | --- |
| main 최신화 | `git fetch` + `origin/main` 에서 분기 | main 워킹트리 안 건드림 |
| 브랜치+워크트리 | `git worktree add <WT> -b feat/<주제> origin/main` | 무관 |
| 개발 | 워크트리 HEAD 가 feature 라 편집 허용 | ✅ |
| 커밋/푸시 | feature 브랜치, force · no-verify 없음 | ✅ |
| PR 생존 확인 | `gh pr view <BRANCH> --json state` | 무관 |
| main 동기화 | `git merge origin/main` (충돌 시 사용자 해결) | feature 브랜치라 허용 |
| PR | `gh pr create` | 무관 |
| 정리 | `git worktree remove` → `git checkout main` + `pull --ff-only origin main` | checkout/ff-pull 은 허용 |

## 규칙

- 작업 브랜치는 `feat/*` 또는 `fix/*`, 워크트리 기본 경로는 메인 체크아웃 옆
  `worktrees/<repo>-<주제>`(사용자가 준 경로가 우선)
- `--force` 대신 `--force-with-lease`, `--no-verify` 사용 안 함
- `git` 은 `git -C <경로>`, `gh` 는 `-C` 가 없으니 `(cd <경로> && gh …)` 나 `-R` 로

## 정리 (cleanup 국면)

PR 머지 후 `cleanup`: 워크트리 제거(`git worktree remove`) → main 최신화
(`git checkout main` + `pull --ff-only`) → 로컬 브랜치 삭제(`branch -d`).
