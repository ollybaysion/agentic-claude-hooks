---
name: squash-import
argument-hint: "[<주제>] [--from external/main] [--to samsung/main] [--since <sha>] [워크트리 경로]"
description: >-
  리모트 사이 반영. `external/main` 의 변경을 `samsung/main` 에 squash 커밋 하나 + PR 로
  올린다(기본값, `--from` · `--to` 로 바꾼다). PR 글은 추가된 기능만 적고, 머지는 사람이
  한다. 사용자가 "사내로 옮겨 / samsung 에 올려 / 변경 가져와서 PR 올려" 라고 할 때 발동한다.
---

# squash-import

`fetch → 지난 지점 찾기 → <도착> 에서 브랜치 → 변경 적용 → 기능 글 → 커밋 하나 → push → PR` 을
하나로 묶은 리모트 사이 반영 절차. 클론 하나가 리모트 둘을 본다(보통 `external` 과 `samsung`).
`<도착 리모트>` 에 올라가는 것은 feat 브랜치의 squash 커밋 하나이고, 머지는 사람이 GitHub 에서
한다(에이전트의 PR 머지와 `<도착>` 브랜치 push 는 `git-guard` 가 막는다).

Claude Code 에서는 `/claude-hooks:squash-import`, opencode 에서는 에이전트가 `skill` 도구로 이
본문을 읽는다(설치는 `adapters/opencode/install.mjs`).

## 용어

- `<출발>` — 옮겨 올 리모트 브랜치. 기본 `external/main`. `<출발 리모트>` 는 그 앞부분(`external`).
- `<도착>` — 받을 리모트 브랜치. 기본 `samsung/main`. `<도착 리모트>` 는 `samsung`, `<base>` 는 `main`.
- `<REPO>` — `<도착 리모트>` 의 `host/owner/repo`. `git remote get-url <도착 리모트>` 에서 읽는다
  (`git@host:owner/repo.git` · `ssh://git@host/owner/repo.git` · `https://host/owner/repo.git` 모두).
  `gh` 는 `-R <REPO>` 로 그 호스트에 붙는다.
- `<LAST>` — 지난 가져오기가 끝난 `<출발>` 쪽 커밋. 이번에 옮길 범위는 `<LAST>..<출발>`.
- `<REF>` — `refs/squash-import/<도착 리모트>/<base>`. 마지막으로 push 한 가져오기의 `<출발>`
  커밋을 적어 두는 로컬 ref. `refs/heads` · `refs/tags` 밖이라 push 대상에서 빠진다.
- `<MAIN>` · `<WT>` · `<BRANCH>` · `<주제>` — [`agentic-coding-git-workflow`](../agentic-coding-git-workflow/SKILL.md)
  와 같다. `<MAIN>` 은 리모트 둘을 가진 클론, `<WT>` 는 이번 가져오기 워크트리.

## 인자

- `<주제>` — kebab-case. 비우면 3 단계에서 가장 큰 기능 이름으로 정한다.
- `--from <리모트/브랜치>` · `--to <리모트/브랜치>` — 기본 `external/main` · `samsung/main`.
- `--since <sha>` — `<LAST>` 를 직접 준다. 트리 일치도 `<REF>` 도 없을 때 쓴다.
- 워크트리 경로 — 비우면 `$(dirname <MAIN>)/worktrees/$(basename <MAIN>)-<주제>`.

## 전제

시작 전 확인하고, 하나라도 어긋나면 멈추고 알린다:

```bash
git -C <MAIN> remote get-url <출발 리모트>
git -C <MAIN> remote get-url <도착 리모트>
git -C <MAIN> status --porcelain          # 비어 있어야 한다
gh auth status -h <REPO 의 host>          # 미인증이면 `! gh auth login -h <host>` 안내
```

`<도착>` 브랜치가 있어야 한다. 비어 있는 저장소를 처음 채울 때는 사람이 orphan 커밋 하나를
`main` 으로 올린다(에이전트의 main push 는 `git-guard` 가 막는다):

```bash
git clone <출발 URL> <임시>
git -C <임시> checkout --detach <출발 커밋>
git -C <임시> checkout --orphan seed
git -C <임시> commit -m "<기능 요약>"
git -C <임시> push <도착 URL> seed:main
```

## 도착 쪽 독자 변경 — 사내가 채우는 자리

`<출발>` 레포는 자리만 두고 `<도착>` 레포가 본문을 채우는 파일이 있다. 이 파일을 **자리 파일**이라
한다. 사내 API 호출처럼 `<도착>` 에서만 쓸 수 있는 구현이 자리 파일에 들어간다. 자리 파일을
채우면 `<도착>` 에 `<출발>` 에 없는 독자 변경이 생긴다.

자리 파일은 아래 규칙 셋을 따른다:

1. **충돌은 `<도착>` 쪽을 남긴다.** 5 단계 3-way 에서 ours 는 `<도착>`(`<WT>` 의 HEAD)이다:
   `git -C <WT> checkout --ours -- <파일> && git -C <WT> add <파일>`.
   3 단계 `--stat` 에 자리 파일이 보이면 PR 본문에 "자리 파일이 바뀌었다 — 사내 구현을 다시
   맞춘다" 를 적는다.
2. **트리 일치 검사는 자리 파일을 뺀 나머지로 한다.** 5 단계 끝 검사로 아래를 쓴다. 출력이
   비면 통과다: `git -C <WT> diff --cached --stat <출발> -- . ':!<파일1>' ':!<파일2>'`.
3. **2 단계에서 `X` 가 없는 것이 정상이다.** 채운 자리 파일 때문에 `<도착>` 트리는 `<출발>`
   의 어느 커밋과도 다르다. 그래서 `<LAST>` 는 `<REF>` 다(2 단계 "`X` 없고 `R` 있음" 줄).

### 레포별 자리 파일

- **fdc-agent-be-spring**
  - `src/main/java/fdc/agent/source/port/impl/InhouseVocTicketSource.java` — 사내가 채우는 자리 셋:
    - 상수 `LINK_KEYWORD` — 링크에 이 글이 들어 있으면 VOC 구현체가 그 링크를 받는다. 대소문자는
      가리지 않는다.
    - `toRequest(link)` — 링크를 사내 API 요청 주소로 바꾼다.
    - `toAct(element, index)` — 사내 응답의 항목 하나를 절 하나로 바꾼다.
  - `src/test/java/fdc/agent/source/port/impl/InhouseVocTicketSourceTest.java` — 사내 응답 표본
  - 배포 설정의 `VOC_ENDPOINT` 값 — 트리 밖 환경 값이다. 규칙 2 의 제외 목록은 위 두 파일이다.
- 다른 레포 — 아직 없음.

새 자리가 생기면 이 목록에 더한다. 외부 PR 이 자리를 만들 때 같이 더한다.

자리 파일이 `<출발>` 에서 **옮겨지거나 서명이 바뀌면** 규칙 1 의 `checkout --ours` 로 맞출 수
없다. 패키지 이동 · `implements` 변경 · 반환 타입 변경이 그런 경우다. 3 단계에서 아래로 옮김을
확인한다. 출력 줄은 `R<유사도> <옛 경로> <새 경로>` 모양이다:

```bash
git -C <MAIN> diff -M --diff-filter=R --name-status <LAST> <출발> | rg '<옛 경로>'
```

경로 제한(`-- <옛 경로>`)을 붙이면 git 이 새 경로를 보지 못해 옮김을 찾지 못한다. 그래서 전체
diff 를 `rg` 로 거른다. 옮김이 보이면 아래 순서로 맞춘다:

1. `<출발>` 쪽 새 파일을 그대로 받는다.
2. 사내가 채운 본문(위 목록의 자리)을 옛 파일에서 새 파일로 손으로 옮긴다.
3. 옛 파일을 지운다.
4. 규칙 2 의 제외 목록과 이 목록을 새 경로로 쓴다.
5. PR 본문에 "자리 파일이 옮겨졌다 — 사내 본문을 새 파일로 옮긴다" 를 적는다.

## 절차

1. **fetch.**

   ```bash
   git -C <MAIN> fetch <출발 리모트>
   git -C <MAIN> fetch <도착 리모트>
   ```

2. **`<LAST>` 찾기.** 트리 일치가 가장 믿을 만한 증거다. `<도착>` 의 트리와 같은 트리를
   가진 `<출발>` 쪽 커밋(가장 최근 것)을 `X` 라 한다:

   ```bash
   TT=$(git -C <MAIN> rev-parse '<도착>^{tree}')
   X=$(git -C <MAIN> log <출발> --format='%H %T' | awk -v t="$TT" '$2==t{print $1; exit}')
   R=$(git -C <MAIN> rev-parse -q --verify <REF>)   # 없으면 빈 값
   ```

   위에서부터 처음 맞는 줄을 따른다:

   - `X` 와 `R` 이 둘 다 있고 다르며 `X` 가 `R` 의 조상(`git merge-base --is-ancestor X R`)
     → 앞선 가져오기(`X..R`)가 아직 `<도착>` 에 없다. 멈추고
     `gh pr list -R <REPO> --state open` 을 보여 준다. 사람이 그 PR 을 머지하면 다시 시작한다.
     닫았으면 `--since X` 로 다시 시작한다.
   - `X` 있음 → `<LAST> = X`.
   - `X` 없고 `R` 있음 → `<LAST> = R`. `<도착>` 에 독자 변경이 있는 경우다.
   - 둘 다 없음 → `--since` 값을 쓴다. 그것도 없으면 멈추고 `<LAST>` 를 묻는다.

   `git -C <MAIN> diff --quiet <LAST> <출발>` 이 참이면 가져올 것이 없다. 그렇게 알리고 끝낸다.

3. **범위 읽기.** 글의 재료다:

   ```bash
   git -C <MAIN> log --no-merges --reverse --format='%h %s%n%b' <LAST>..<출발>
   git -C <MAIN> diff --stat <LAST> <출발>
   ```

   `<주제>` 가 비어 있으면 여기서 정한다: 가장 큰 기능 하나를 kebab-case 로.

4. **브랜치 + 워크트리.** `<도착>` 에서 판다:

   ```bash
   git -C <MAIN> worktree add "<WT>" -b feat/<주제> <도착>
   ```

5. **변경 적용.** `<LAST>..<출발>` 의 diff 를 3-way 로 얹는다. 커밋 이력 없이 트리 변경만
   옮기므로, 지난 가져오기가 squash 였어도 범위가 겹치지 않는다:

   ```bash
   git -C <MAIN> diff --binary --full-index <LAST> <출발> | git -C <WT> apply --index --3way
   ```

   - 새 파일은 "Falling back to direct application" 메시지와 함께 그대로 들어간다.
   - 충돌이 나면 파일 목록(`git -C <WT> diff --name-only --diff-filter=U`)을 보여 주고
     해결을 사용자에게 맡긴다. 버전 · 문서 같은 기계적 충돌만 직접 푼다. 푼 뒤
     `git -C <WT> add <파일>`.
   - 자리 파일의 충돌은 [도착 쪽 독자 변경](#도착-쪽-독자-변경--사내가-채우는-자리) 규칙 1 로 푼다.
   - `<도착>` 에 독자 변경이 없다면 결과 트리가 `<출발>` 과 같아야 한다:
     `[ "$(git -C <WT> write-tree)" = "$(git -C <MAIN> rev-parse '<출발>^{tree}')" ]`.
     자리 파일이 있는 레포는 자리 파일을 빼고 비교한다(같은 절 규칙 2).

6. **글 쓰기(PR 제목 · 본문 · 커밋 메시지 공통).** 3 단계의 커밋 목록과 diff 를 읽고
   **무엇이 추가 · 변경됐는지**를 사용하는 사람 관점으로 다시 쓴다. 커밋 제목 대신 기능
   단위로 묶는다.

   - 제목: 기능 이름을 `·` 로 잇는다. 넷 이상이면 큰 것 둘 + `외 N건`.
   - 본문: 기능마다 항목 하나, 한두 문장. 말투는 `<도착>` 저장소의 최근 PR
     (`gh pr list -R <REPO> --state merged --limit 5 --json title,body`)을 따르고, 없으면 한국어.
   - 검사: 제목과 본문에서 아래가 **0 건**이면 통과. 걸리면 고쳐 쓴다(자리는 값으로 바꾼다):

     ```bash
     rg -n -i '<출발 리모트>|<출발 URL 의 host>|<출발 URL 의 owner>|사외|upstream|#[0-9]+|\b[0-9a-f]{7,40}\b' <제목 파일> <본문 파일>
     ```

     `#N` 은 다른 저장소의 PR · 이슈 번호라 `<REPO>` 에서 엉뚱한 곳에 링크된다. 16진수 7자
     이상은 커밋 해시다.
   - 초안을 사용자에게 보여 주고 동의를 받은 뒤 다음으로 간다.

7. **커밋 하나.** 첫 줄 = PR 제목, 빈 줄, 본문:

   ```bash
   git -C <WT> commit -F <메시지 파일>
   ```

8. **push + PR.**

   ```bash
   git -C <WT> push -u <도착 리모트> <BRANCH>
   (cd <WT> && gh pr create -R <REPO> --base <base> --head <BRANCH> --title "<제목>" --body-file <본문 파일>)
   ```

9. **`<REF>` 기록.** 다음 가져오기의 기준점이다:

   ```bash
   git -C <MAIN> update-ref <REF> "$(git -C <MAIN> rev-parse <출발>)"
   ```

10. **안내.** PR URL 을 전달한다. 머지는 사람이 GitHub 에서 한다. 머지 뒤 정리:

    ```bash
    git -C <MAIN> worktree remove <WT> && git -C <MAIN> worktree prune
    git -C <MAIN> fetch <도착 리모트>
    git -C <MAIN> branch -D <BRANCH>       # squash 머지라 -d 는 거부된다. 머지 확인 뒤 -D
    ```

## 규칙

- 머지는 사람이 GitHub 에서 한다. 에이전트의 PR 머지(`gh pr` 의 merge, `--auto` 포함) ·
  `gh api … /merge` · `<도착>` 브랜치로의 push 는 `git-guard` 가 막는다. 이 스킬은 PR URL 을
  건네는 데서 끝난다.
- `<도착 리모트>` 에 올리는 것은 feat 브랜치의 squash 커밋 하나다. 옮기는 것은 트리 변경이고,
  `<출발>` 의 커밋 · 태그 · 브랜치 이름은 `<MAIN>` 안에만 있다.
- 제목 · 본문 · 커밋 메시지는 기능만 적는다(6 단계 검사 통과).
- `--force` 대신 `--force-with-lease`, `--no-verify` 금지 — `git-guard` 가 막는다.
- `git` 은 `-C <경로>`, `gh` 는 `-R <REPO>` 또는 `(cd <WT> && gh …)` 로 실행한다.
