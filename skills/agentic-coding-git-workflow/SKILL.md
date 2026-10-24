---
name: agentic-coding-git-workflow
argument-hint: "[setup <주제> [워크트리 경로] | finish | cleanup]"
description: >-
  개인 git 워크플로우(main 최신화 → feat 브랜치 + 워크트리 → 개발 → 커밋 → main 동기화 →
  push → PR → 머지 후 정리)를 실행한다. `setup <주제> [경로]` 로 개발 준비, `finish` 로
  커밋~PR, `cleanup` 으로 머지 후 정리한다. 사용자가 "브랜치 파서 정식으로 작업하자 /
  워크트리 만들어 / PR 까지 가자" 처럼 작업을 정식 착수 · 마무리할 때 발동한다. 자잘한
  일회성 수정은 스킬 밖에서 바로 한다.
---

# agentic-coding-git-workflow

`main 최신화 → 브랜치 → 워크트리 → 개발 → 커밋 → main 동기화 → push → PR → 정리` 를
하나로 묶은 개인 워크플로우. `git-guard`/`bash-guard` 가 **강제**하는 정책(main 직접
작업 금지, force-push · `--no-verify` · 에이전트 머지 차단)의 happy-path — 가드는 채찍,
이 스킬은 포장도로다.

출발점은 **주제 하나**다(이슈 번호가 아니라). 개발을 경계로 `setup`/`finish` 로 나뉘고,
PR 머지 후 `cleanup` 으로 정리한다. Claude Code 에서는 `/claude-hooks:agentic-coding-git-workflow`,
opencode 에서는 에이전트가 `skill` 도구로 이 본문을 읽는다(설치는 `adapters/opencode/install.mjs`).

## 용어

- `<MAIN>` — `main` 이 체크아웃된 워크트리(보통 원본 클론). `git worktree list` 의 `[main]` 행.
- `<WT>` — feature 워크트리 경로.
- `<BRANCH>` — feature 브랜치명. `git -C <WT> branch --show-current` 로 확인(슬러그로 재구성하지 말 것).
- `<주제>` — kebab-case 한 단어 묶음(`scoping-panel`, `fix-login-timeout`). 브랜치와 워크트리 이름의 재료.
- `<PR>` — PR 번호.
- **`gh` 엔 `-C` 가 없다.** `gh` 는 repo 안에서 실행한다: `(cd <WT> && gh …)` 또는
  `-R <owner/repo>`. (`git` 은 `-C <경로>` 로 어디서든 실행.)

## 인자

- `setup <주제> [워크트리 경로]` — 개발 준비: main 최신화 → `feat/<주제>` 브랜치 + 워크트리
  생성. 경로를 주면 그 자리에, 비우면 기본 자리(`<MAIN>` 옆 `worktrees/<repo>-<주제>`)에
  만든다. 주제가 없으면 사용자에게 묻는다. 여기서 멈춘다.
- `finish` — 마무리: 변경 커밋 → PR 생존 확인 → main 동기화(충돌 해결) → push → PR.
- `cleanup` — 머지 후 정리: 워크트리 제거 → main 최신화 → 로컬 브랜치 삭제.
- 인자 없음 — 상태로 국면 자동 감지: `main` 이고 워킹트리 깨끗 → **setup**(주제를 물어봄),
  feature 워크트리에 변경 있음 → **finish**, PR 머지됐고 워크트리 남음 → **cleanup**.

시작 전 항상 확인: `git rev-parse --show-toplevel`, `git worktree list`,
`git branch --show-current`, `git status -sb`, `gh auth status`. `gh` 가 없거나 미인증이면
멈추고 `! gh auth login` 실행을 안내한다(프롬프트 `!` 접두사로 그 세션에서 실행됨).

## Phase: setup

1. **main 최신화.** 로컬 main 을 건드리지 않고 최신 `origin/main` 에서 분기한다:

   ```bash
   git -C <MAIN> fetch origin
   ```

   로컬 `main` 이 있으면 best-effort ff: `git -C <MAIN> pull --ff-only origin main` (실패 무시).

2. **브랜치 + 워크트리 생성.** 브랜치는 기능 `feat/<주제>`, 버그 `fix/<주제>`(주제가 이미
   `feat/`·`fix/` 로 시작하면 그대로). 워크트리 경로는 둘 중 하나:
   - 사용자가 준 경로 → 그대로.
   - 없으면 `<MAIN>` 옆 `worktrees/` 폴더 안의 `<repo>-<주제>` — 워크트리를 메인 체크아웃과
     섞지 않고 한 폴더에 모은다(`worktrees/` 는 `worktree add` 가 만든다).

   ```bash
   git -C <MAIN> worktree add "<WT>" -b feat/<주제> origin/main
   # 기본 자리: <WT> = "$(dirname <MAIN>)/worktrees/$(basename <MAIN>)-<주제>"
   ```

3. **부트스트랩(필요 시).** 워크트리는 비추적 파일 · 의존성을 공유하지 않는다. `.env` 복사,
   의존성 재설치(`npm i` / `uv sync` 등)가 필요하면 사용자에게 물어본 뒤 진행한다.

4. **마무리 안내.** 워크트리 경로 · 브랜치를 요약하고, 개발을 그 워크트리에서 진행한 뒤
   `finish` 로 오라고 알린다. setup 은 여기서 종료한다(개발은 스킬 밖).

## Phase: finish

`<WT>`(feature 브랜치) 기준으로 실행한다.

1. **변경 리뷰.** `git -C <WT> status -sb` 와 `git -C <WT> diff` 로 무엇이 바뀌는지 확인 · 요약한다.
   무관한 파일이 섞였으면 사용자에게 확인한다.

2. **커밋.** feature 브랜치이므로 커밋은 가드에 허용된다. 관례적 메시지:

   ```bash
   git -C <WT> add -A
   git -C <WT> commit -m "<type>: <요약>"
   ```

   `--no-verify` 는 절대 쓰지 않는다(가드가 차단하며, pre-commit 훅을 우회하면 안 된다).

3. **PR 생존 확인(열린 PR 에 얹을 때).** 이 브랜치의 PR 이 이미 있으면 상태부터 본다:

   ```bash
   gh pr view <BRANCH> -R <owner/repo> --json state,number
   ```

   `MERGED` 면 그 브랜치에 더 얹지 않는다 — 멈추고 사용자에게 알린다(새 브랜치를 `setup`
   으로 다시 판다). `OPEN` 이면 그대로 얹는다.

4. **main 동기화 (필요 시).** 브랜치를 딴 뒤 main 이 앞서갔을 수 있다 — PR 충돌을 미리
   없애려면 최신 main 을 브랜치에 합친다:

   ```bash
   git -C <WT> fetch origin
   git -C <WT> merge origin/main --no-edit
   ```

   - 충돌이 없으면 그대로 진행한다.
   - **충돌이 나면 자동으로 봉합하지 않는다.** 충돌 파일
     (`git -C <WT> diff --name-only --diff-filter=U`)을 사용자에게 보여주고 해결을 맡긴다.
     버전 bump · 문서 같이 명백히 기계적인 충돌만 직접 해결하고, 코드 로직 충돌은 반드시
     사용자 확인을 받는다. 해결 후 `git -C <WT> add <파일>` →
     `git -C <WT> commit --no-edit`(머지 커밋)로 마무리한다.
   - 깔끔한 히스토리를 원하면 merge 대신 `git -C <WT> rebase origin/main`. 단 이후 push 는
     `--force-with-lease` 가 필요하다(`--force` 는 가드가 차단).

5. **Push.**

   ```bash
   git -C <WT> push -u origin <BRANCH>
   ```

   재푸시로 히스토리를 덮어야 하면 `--force` 가 아니라 `--force-with-lease` 만 쓴다.

6. **PR 생성(없을 때).** head 브랜치가 있는 `<WT>` 안에서 실행한다. 본문은 변경 요약;
   사용자가 이슈 번호를 말해 줬으면 `Closes #<N>` 을 넣는다:

   ```bash
   (cd <WT> && gh pr create --base main --head <BRANCH> \
     --title "<제목>" --body-file <pr-body md>)
   ```

   본문 초안을 보여주고 동의를 받은 뒤 생성한다(외부 공개 액션). 생성 후 PR URL 을 전달하고,
   **머지되면 `cleanup` 으로 정리**하라고 안내한다. 머지는 사람이 GitHub 에서 한다.

## Phase: cleanup

PR 이 머지된 뒤 실행한다. 워크트리를 제거하고 로컬 main 을 최신화해, 다음 작업을 깨끗한
출발점에서 시작하게 한다. 워크트리 안에서는 자신을 못 지우므로 `<MAIN>` 에서 실행한다.

1. **머지 확인.** `gh pr view <PR> -R <owner/repo> --json state,mergedAt` 로 머지를 확인한다.
   `<WT>` 에 커밋 안 된 변경이 없어야 한다(있으면 사용자에게 확인).

2. **워크트리 제거.**

   ```bash
   git -C <MAIN> worktree remove <WT>
   git -C <MAIN> worktree prune
   ```

3. **main 최신화.** 다음 작업의 출발점을 갱신한다:

   ```bash
   git -C <MAIN> checkout main
   git -C <MAIN> pull --ff-only origin main
   ```

4. **로컬 브랜치 삭제.** main 최신화 **뒤에** 한다 — 로컬 main 이 머지 커밋을 알아야
   `-d`(머지 확인 후 안전 삭제)가 "not fully merged" 로 거부되지 않는다(특히 squash 머지):

   ```bash
   git -C <MAIN> branch -d <BRANCH>
   ```

   그래도 `-d` 가 거부되면(squash 머지로 브랜치 커밋이 그대로 안 들어간 경우) 머지 사실을
   재확인한 뒤 `git -C <MAIN> branch -D <BRANCH>` 로 지운다.

## 규칙 (가드 준수)

- `main`/`master` 에서 편집 · 커밋 · push · merge · pull <다른 브랜치> · rebase 금지.
  작업 브랜치는 `feat/*` 또는 `fix/*`. 머지는 사람이 GitHub 에서 한다(`gh pr merge` 금지).
- `--force` 금지(`--force-with-lease` 만), `--no-verify` 금지.
- `git` 은 `git -C <경로>` 로, `gh` 는 `-C` 가 없으니 `(cd <경로> && gh …)` 나 `-R` 로 실행한다
  (서브셸 `(cd …)` 는 `bash-guard` 가 허용하는 형태).
- 워크트리 기본 경로는 `$(dirname <MAIN>)/worktrees/<repo>-<주제>`, 디렉토리명과 브랜치명을
  맞춰 혼동을 줄인다. 사용자가 경로를 주면 그 경로가 우선이다.
- `gh` 가 없거나 미인증이면 멈추고 안내한다 — 조용히 건너뛰지 않는다.
