---
name: git-flow
description: >-
  개인 git 워크플로우(issue → 계획 → main 최신화 → feat 브랜치 + 워크트리 → 개발 →
  커밋 → push → PR)를 하나로 실행한다. `setup`으로 개발 준비(이슈 조회~워크트리+계획)를,
  `finish`로 마무리(커밋~PR)를 한다. 새 기능/버그를 이 표준 흐름으로 시작하거나
  브랜치 작업을 PR까지 마무리할 때 사용.
---

# git-flow

`issue → 계획 → main 최신화 → 브랜치 → 워크트리 → 개발 → 커밋 → push → PR` 를
하나로 묶은 개인 워크플로우. `git-guard`/`bash-guard`가 **강제**하는 정책(main 직접
작업 금지, force-push·`--no-verify` 차단)의 happy-path — 가드는 채찍, 이 skill은 포장도로다.

개발을 경계로 두 국면으로 나뉜다. 워크트리는 별도 디렉토리라, 개발은 그 안에서 자유롭게
하고 준비/마무리만 skill이 담당한다.

## 인자

- `setup [<이슈 설명> | #N]` — 개발 준비: 이슈 생성/조회 → 계획 → main 최신화 →
  `feat/<slug>` 브랜치 + 워크트리 생성. 여기서 멈춘다.
- `finish` — 마무리: 워크트리의 변경을 커밋 → push → PR(`Closes #N`).
- 인자 없음 — 상태로 국면 자동 감지: `main`이고 워킹트리가 깨끗하면 **setup**,
  feature 워크트리에 변경이 있으면 **finish**.

시작 전 항상 확인: `git rev-parse --show-toplevel`(repo 루트), `git branch --show-current`,
`git status -sb`, `gh auth status`. `gh`가 없거나 미인증이면 진행을 멈추고
사용자에게 `! gh auth login` 실행을 안내한다(프롬프트에 `!` 접두사로 그 세션에서 실행됨).

## Phase: setup

1. **이슈 확보.**
   - 인자가 `#N`이면 기존 이슈 사용: `gh issue view <N>`.
   - 인자가 설명 텍스트면 새 이슈 생성 후 그 번호를 사용:

     ```bash
     gh issue create --title "<한 줄 제목>" --body-file <임시 md 파일>
     ```

     제목/본문 초안을 먼저 사용자에게 보여주고 동의를 받은 뒤 생성한다(이슈는 외부 공개
     액션이다).
   - 인자가 없으면 방금 한 작업 맥락에서 제목·본문을 제안하고 동의를 받는다.

2. **계획 수립.** `gh issue view <N>`로 이슈를 읽고 구현 계획(수정/생성할 파일, 순서,
   검증 방법)을 세워 사용자에게 제시한다. 사용자가 원하면 이슈에 코멘트로 남긴다:
   `gh issue comment <N> --body-file <md>`. 기본은 세션에만 두고 넘어간다.

3. **main 최신화.** 로컬 main을 건드리지 않고 최신 `origin/main`에서 분기해 가드를
   피하고 확실히 최신을 쓴다:

   ```bash
   git -C <REPO_ROOT> fetch origin
   ```

   로컬 `main`이 어딘가 체크아웃돼 있으면 best-effort로 ff:
   `git -C <MAIN_WORKTREE> pull --ff-only origin main` (실패해도 무시).

4. **브랜치 + 워크트리 생성.** 슬러그는 이슈 제목에서 kebab-case로 만든다. 타입은
   기능이면 `feat/`, 버그면 `fix/`. 경로는 형제 컨벤션 `<repo>-<slug>`:

   ```bash
   git -C <REPO_ROOT> worktree add <REPO_PARENT>/<REPO_NAME>-<slug> \
     -b feat/<slug> origin/main
   ```

5. **부트스트랩(필요 시).** 워크트리는 비추적 파일과 의존성을 공유하지 않는다. 프로젝트에
   `.env`나 `node_modules`/`.venv` 등이 있으면 안내한다: `.env`는 복사, 의존성은 재설치
   (`npm i` / `uv sync` 등). 자동 실행하지 말고 사용자에게 물어본다.

6. **마무리 안내.** 워크트리 경로와 계획을 요약하고, 개발을 그 워크트리에서 진행한 뒤
   `finish`로 돌아오라고 알린다. setup은 여기서 종료한다(개발은 skill 밖).

## Phase: finish

워크트리(feature 브랜치) 안에서 실행한다. `<WT>` = 워크트리 경로.

1. **변경 리뷰.** `git -C <WT> status -sb` 와 `git -C <WT> diff`(스테이지 전/후 모두)로
   무엇이 바뀌는지 확인하고 요약한다. 무관한 파일이 섞였으면 사용자에게 확인한다.

2. **커밋.** feature 브랜치이므로 커밋은 가드에 허용된다. 관례적 커밋 메시지 + 이슈 참조:

   ```bash
   git -C <WT> add -A
   git -C <WT> commit -m "<type>: <요약>" -m "Closes #<N>"
   ```

   `--no-verify`는 절대 쓰지 않는다(가드가 차단하며, pre-commit 훅을 우회하면 안 된다).

3. **Push.**

   ```bash
   git -C <WT> push -u origin feat/<slug>
   ```

   재푸시로 히스토리를 덮어야 하면 `--force`가 아니라 `--force-with-lease`만 쓴다.

4. **PR 생성.** 본문에 `Closes #<N>`을 넣어 머지 시 이슈가 닫히게 한다:

   ```bash
   gh pr create --base main --head feat/<slug> \
     --title "<제목>" --body-file <pr-body.md>
   ```

   PR 본문 초안을 사용자에게 보여주고 동의를 받은 뒤 생성한다(외부 공개 액션).
   생성 후 PR URL을 사용자에게 전달한다.

## 규칙 (가드 준수)

- `main`/`master`에서 편집·커밋·push 금지. 작업 브랜치는 `feat/*` 또는 `fix/*`.
- `--force` 금지(`--force-with-lease`만), `--no-verify` 금지.
- `cd X && ...` 대신 `git -C <경로>`나 절대경로를 쓴다(`bash-guard` 넛지 준수).
- 워크트리 경로는 형제 컨벤션 `<repo>-<slug>`, 디렉토리명과 브랜치명을 일치시켜 혼동을 줄인다.
- `gh`가 없거나 미인증이면 멈추고 안내한다 — 조용히 건너뛰지 않는다.

## 정리 (선택)

PR이 머지된 뒤:

```bash
git -C <REPO_ROOT> worktree remove <WT>
```

원격에서 삭제된(gone) 브랜치와 그 워크트리를 한 번에 치우려면
`commit-commands:clean_gone` skill을 쓴다.
