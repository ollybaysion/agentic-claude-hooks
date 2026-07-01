---
name: agentic-coding-git-workflow
argument-hint: "[setup #N | finish | cleanup]"
description: >-
  기존 이슈(#N)를 받아 개인 git 워크플로우(이슈 조회 → 계획 → main 최신화 →
  feat 브랜치 + 워크트리 → 개발 → 커밋 → push → PR → 머지 후 정리)를 실행한다.
  `setup #N`으로 개발 준비, `finish`로 커밋~PR, `cleanup`으로 머지 후 정리한다.
  사용자가 "이 이슈로 개발 시작하자 / 브랜치 파서 정식으로 작업하자 / PR까지 가자"처럼
  이슈 기반 작업을 정식 착수·마무리할 때 발동한다. 이슈 생성이나 자잘한 일회성 코드
  수정에는 발동하지 않는다.
---

# agentic-coding-git-workflow

기존 이슈에서 출발해 `이슈 조회 → 계획 → main 최신화 → 브랜치 → 워크트리 → 개발 →
커밋 → push → PR → 정리` 를 하나로 묶은 개인 워크플로우. `git-guard`/`bash-guard`가
**강제**하는 정책(main 직접 작업 금지, force-push·`--no-verify` 차단)의 happy-path —
가드는 채찍, 이 skill은 포장도로다.

**이 스킬은 이슈를 생성하지 않는다.** 대상 이슈는 미리 만들어 두고 `#N`으로 넘긴다
(자동호출로 발동해도 GitHub에 멋대로 이슈를 만들지 않게 하려는 의도적 설계). 개발을
경계로 `setup`/`finish`로 나뉘고, PR 머지 후 `cleanup`으로 정리한다.

## 용어

- `<MAIN>` — `main`이 체크아웃된 워크트리(보통 원본 클론). `git worktree list`의 `[main]` 행.
- `<WT>` — feature 워크트리 경로.
- `<BRANCH>` — feature 브랜치명. `git -C <WT> branch --show-current`로 확인(슬러그로 재구성하지 말 것).
- `<N>` / `<PR>` — 이슈 / PR 번호.
- **`gh`엔 `-C`가 없다.** `gh`는 repo 안에서 실행한다: `(cd <MAIN> && gh …)` 또는
  `(cd <WT> && gh …)`, 또는 `-R <owner/repo>`. (`git`은 `-C <경로>`로 어디서든 실행.)

## 인자

- `setup #N` — 개발 준비: 이슈 `#N` 조회 → 계획 → main 최신화 → `feat/<slug>` 브랜치 +
  워크트리 생성. 번호를 안 주면 어느 이슈인지 사용자에게 물어본다. 여기서 멈춘다.
- `finish` — 마무리: 변경 커밋 → main 동기화(충돌 해결) → push → PR(`Closes #N`).
- `cleanup` — 머지 후 정리: 워크트리 제거 → 로컬 브랜치 삭제 → main 최신화.
- 인자 없음 — 상태로 국면 자동 감지: `main`이고 워킹트리 깨끗 → **setup**(이슈 번호를 물어봄),
  feature 워크트리에 변경 있음 → **finish**, PR 머지됐고 워크트리 남음 → **cleanup**.

시작 전 항상 확인: `git rev-parse --show-toplevel`, `git worktree list`,
`git branch --show-current`, `git status -sb`, `gh auth status`. `gh`가 없거나 미인증이면
멈추고 `! gh auth login` 실행을 안내한다(프롬프트 `!` 접두사로 그 세션에서 실행됨).

## Phase: setup

1. **이슈 조회 (생성하지 않음).** 대상 이슈는 이미 있어야 한다. `#N`(없으면 사용자에게
   물어봄)을 조회한다:

   ```bash
   (cd <MAIN> && gh issue view <N>)
   ```

   이슈가 아직 없으면 여기서 멈추고 "먼저 이슈를 만들어 달라"고 안내한다 — 스킬 밖에서
   생성한다(자동 생성하지 않는다).

2. **계획 수립.** 이슈를 읽고 구현 계획(수정/생성 파일, 순서, 검증 방법)을 세워 제시한다.
   개발이 별도 세션·워크트리에서 이어지므로 **계획을 영속화**한다 — 이슈 코멘트가 기본:

   ```bash
   (cd <MAIN> && gh issue comment <N> --body-file <계획 md>)
   ```

3. **main 최신화.** 로컬 main을 건드리지 않고 최신 `origin/main`에서 분기한다:

   ```bash
   git -C <MAIN> fetch origin
   ```

   로컬 `main`이 있으면 best-effort ff: `git -C <MAIN> pull --ff-only origin main` (실패 무시).

4. **브랜치 + 워크트리 생성.** 슬러그는 이슈 제목에서 kebab-case. 타입은 기능 `feat/`,
   버그 `fix/`. 경로는 `<MAIN>`의 형제(`<repo>-<slug>`):

   ```bash
   git -C <MAIN> worktree add "$(dirname <MAIN>)/$(basename <MAIN>)-<slug>" \
     -b feat/<slug> origin/main
   ```

5. **부트스트랩(필요 시).** 워크트리는 비추적 파일·의존성을 공유하지 않는다. `.env` 복사,
   의존성 재설치(`npm i` / `uv sync` 등)가 필요하면 사용자에게 물어본 뒤 진행한다.

6. **마무리 안내.** 워크트리 경로·브랜치·계획을 요약하고, 개발을 그 워크트리에서 진행한 뒤
   `finish`로 오라고 알린다. setup은 여기서 종료한다(개발은 skill 밖).

## Phase: finish

`<WT>`(feature 브랜치) 기준으로 실행한다.

1. **변경 리뷰.** `git -C <WT> status -sb` 와 `git -C <WT> diff`로 무엇이 바뀌는지 확인·요약한다.
   무관한 파일이 섞였으면 사용자에게 확인한다.

2. **커밋.** feature 브랜치이므로 커밋은 가드에 허용된다. 관례적 메시지 + 이슈 참조:

   ```bash
   git -C <WT> add -A
   git -C <WT> commit -m "<type>: <요약>" -m "Closes #<N>"
   ```

   `--no-verify`는 절대 쓰지 않는다(가드가 차단하며, pre-commit 훅을 우회하면 안 된다).

3. **main 동기화 (필요 시).** 브랜치를 딴 뒤 main이 앞서갔을 수 있다 — PR 충돌을 미리
   없애려면 최신 main을 브랜치에 합친다:

   ```bash
   git -C <WT> fetch origin
   git -C <WT> merge origin/main --no-edit
   ```

   - 충돌이 없으면 그대로 진행한다.
   - **충돌이 나면 자동으로 봉합하지 않는다.** 충돌 파일
     (`git -C <WT> diff --name-only --diff-filter=U`)을 사용자에게 보여주고 해결을 맡긴다.
     버전 bump·문서 같이 명백히 기계적인 충돌만 직접 해결하고, 코드 로직 충돌은 반드시
     사용자 확인을 받는다. 해결 후 `git -C <WT> add <파일>` →
     `git -C <WT> commit --no-edit`(머지 커밋)로 마무리한다.
   - 깔끔한 히스토리를 원하면 merge 대신 `git -C <WT> rebase origin/main`. 단 이후 push는
     `--force-with-lease`가 필요하다(`--force`는 가드가 차단).

4. **Push.**

   ```bash
   git -C <WT> push -u origin <BRANCH>
   ```

   재푸시로 히스토리를 덮어야 하면 `--force`가 아니라 `--force-with-lease`만 쓴다.

5. **PR 생성.** head 브랜치가 있는 `<WT>` 안에서 실행한다. 본문에 `Closes #<N>`:

   ```bash
   (cd <WT> && gh pr create --base main --head <BRANCH> \
     --title "<제목>" --body-file <pr-body md>)
   ```

   본문 초안을 보여주고 동의를 받은 뒤 생성한다(외부 공개 액션). 생성 후 PR URL을 전달하고,
   **머지되면 `cleanup`으로 정리**하라고 안내한다.

## Phase: cleanup

PR이 머지된 뒤 실행한다. 워크트리를 제거하고 로컬 main을 최신화해, 다음 작업을 깨끗한
출발점에서 시작하게 한다. 워크트리 안에서는 자신을 못 지우므로 `<MAIN>`에서 실행한다.

1. **머지 확인.** `gh pr view <PR> -R <owner/repo> --json state,mergedAt`로 머지를 확인한다.
   `<WT>`에 커밋 안 된 변경이 없어야 한다(있으면 사용자에게 확인).

2. **워크트리 제거 → 브랜치 정리.**

   ```bash
   git -C <MAIN> worktree remove <WT>
   git -C <MAIN> worktree prune
   git -C <MAIN> branch -d <BRANCH>
   ```

   원격에서 삭제된(gone) 브랜치 + 워크트리를 한 번에 치우려면 `commit-commands:clean_gone`.

3. **main 최신화.** 다음 작업의 출발점을 갱신한다:

   ```bash
   git -C <MAIN> checkout main
   git -C <MAIN> pull --ff-only origin main
   ```

## 규칙 (가드 준수)

- 이슈는 **조회만** 한다 — 생성하지 않는다(자동호출 시 원치 않는 이슈 방지).
- `main`/`master`에서 편집·커밋·push 금지. 작업 브랜치는 `feat/*` 또는 `fix/*`.
- `--force` 금지(`--force-with-lease`만), `--no-verify` 금지.
- `git`은 `git -C <경로>`로, `gh`는 `-C`가 없으니 `(cd <경로> && gh …)`나 `-R`로 실행한다
  (서브셸 `(cd …)`는 `bash-guard`가 허용하는 형태).
- 워크트리 경로는 `<MAIN>`의 형제 `<repo>-<slug>`, 디렉토리명과 브랜치명을 맞춰 혼동을 줄인다.
- `gh`가 없거나 미인증이면 멈추고 안내한다 — 조용히 건너뛰지 않는다.
