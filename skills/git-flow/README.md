# git-flow ✅

개인 git 워크플로우를 하나로 묶은 **skill**. hook이 아니라 사용자가 호출하는
절차형 skill이다(`/claude-hooks:git-flow`).

- **종류**: Skill (SKILL.md) — `skills/git-flow/SKILL.md`
- **흐름**: `issue → 계획 → main 최신화 → feat 브랜치 + 워크트리 → 개발 → 커밋 → push → PR`
- **국면**: 개발을 경계로 **2단계**
  - `setup [<이슈설명> | #N]` — 이슈 조회~워크트리 생성+계획까지
  - `finish` — 커밋~PR
  - 인자 없으면 상태로 자동 감지(main+clean → setup, feature 워크트리+변경 → finish)
- **요구사항**: `git`, `gh`(GitHub CLI, 인증됨). 없으면 멈추고 안내(조용히 넘어가지 않음)

## 왜 skill인가 (그리고 가드와의 관계)

`git-guard`/`bash-guard`는 정책을 **강제**한다 — main 직접 작업 금지, force-push·
`--no-verify` 차단. 이 skill은 그 정책을 그대로 따라가는 **happy-path**다: 가드는
"하지 마라"(채찍), skill은 "이 길로 가라"(포장도로). 그래서 각 단계가 가드와 충돌하지
않도록 설계됐다.

| 단계 | 명령 | 가드 |
| --- | --- | --- |
| 이슈 | `gh issue create` / `view` | 무관 |
| main 최신화 | `git fetch` + `origin/main`에서 분기 | main 워킹트리 안 건드림 |
| 브랜치+워크트리 | `git worktree add -b feat/<slug> origin/main` | 무관 |
| 개발 | 워크트리 HEAD가 feature라 편집 허용 | ✅ |
| 커밋/푸시 | feature 브랜치, force·no-verify 없음 | ✅ |
| PR | `gh pr create` (`Closes #N`) | 무관 |

## 규칙

- 작업 브랜치는 `feat/*` 또는 `fix/*`, 워크트리 경로는 형제 `<repo>-<slug>`
- `--force` 대신 `--force-with-lease`, `--no-verify` 사용 안 함
- `cd X && ...` 대신 `git -C`/절대경로

## 정리

머지 후 `git worktree remove <경로>`, 또는 gone 브랜치+워크트리 일괄 정리는
`commit-commands:clean_gone`.
