# agentic-coding-git-workflow ✅

개인 git 워크플로우를 하나로 묶은 **skill**. hook이 아니라 사용자가 호출하는
절차형 skill이다(`/claude-hooks:agentic-coding-git-workflow`).

- **종류**: Skill (SKILL.md) — `skills/agentic-coding-git-workflow/SKILL.md`
- **흐름**: `이슈(기존) 조회 → 계획 → main 최신화 → feat 브랜치 + 워크트리 → 개발 → 커밋 → main 동기화 → push → PR → 정리`
- **이슈 생성 안 함**: 대상 이슈는 미리 만들어 `#N`으로 넘긴다(자동호출로 발동해도 멋대로 이슈를 만들지 않게 한 의도적 설계)
- **국면**: 개발을 경계로 `setup`/`finish`, 머지 후 `cleanup`
  - `setup #N` — 이슈 조회~워크트리 생성+계획까지
  - `finish` — 커밋~PR
  - `cleanup` — 머지 후 워크트리 제거 → main 최신화
  - 인자 없으면 상태로 자동 감지(main+clean → setup / feature 워크트리+변경 → finish /
    PR 머지+워크트리 잔존 → cleanup)
- **요구사항**: `git`, `gh`(GitHub CLI, 인증됨). 없으면 멈추고 안내(조용히 넘어가지 않음)

## 왜 skill인가 (그리고 가드와의 관계)

`git-guard`/`bash-guard`는 정책을 **강제**한다 — main 직접 작업 금지, force-push·
`--no-verify` 차단. 이 skill은 그 정책을 그대로 따라가는 **happy-path**다: 가드는
"하지 마라"(채찍), skill은 "이 길로 가라"(포장도로). 그래서 각 단계가 가드와 충돌하지
않도록 설계됐다.

| 단계 | 명령 | 가드 |
| --- | --- | --- |
| 이슈 | `gh issue view` (기존 이슈, 생성 안 함) | 무관 |
| main 최신화 | `git fetch` + `origin/main`에서 분기 | main 워킹트리 안 건드림 |
| 브랜치+워크트리 | `git worktree add -b feat/<slug> origin/main` | 무관 |
| 개발 | 워크트리 HEAD가 feature라 편집 허용 | ✅ |
| 커밋/푸시 | feature 브랜치, force·no-verify 없음 | ✅ |
| main 동기화 | `git merge origin/main` (충돌 시 사용자 해결) | feature 브랜치라 허용 |
| PR | `gh pr create` (`Closes #N`) | 무관 |
| 정리 | `git worktree remove` → `git checkout main` + `pull` | checkout/pull은 허용 |

## 규칙

- 작업 브랜치는 `feat/*` 또는 `fix/*`, 워크트리 경로는 형제 `<repo>-<slug>`
- `--force` 대신 `--force-with-lease`, `--no-verify` 사용 안 함
- `git`은 `git -C <경로>`, `gh`는 `-C`가 없으니 `(cd <경로> && gh …)`나 `-R`로

## 정리 (cleanup 국면)

PR 머지 후 `cleanup`: 워크트리 제거(`git worktree remove`) → main 최신화
(`git checkout main` + `pull --ff-only`). 원격에서 삭제된(gone) 브랜치 + 워크트리
일괄 정리는 `commit-commands:clean_gone`.
