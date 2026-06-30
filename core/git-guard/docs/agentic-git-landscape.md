# Agentic Coding의 Git 관리 — 조사 & 정밀 분석

> 2026-06-30 조사. 2개 워크플로(웹 62개 발견 + 8개 대상 정밀 fetch)로 작성.
> 목적: 기존 스킬·도구·패턴을 파악하고, 우리 git 관리 설계(`git-guard` 훅 +
> `git-workflow` 스킬 + worktree-per-instance + 솔로 PR-only)를 consensus에 맞춰 다듬기.

## 1. 한눈에

| 합의된 핵심 | 우리 설계와 |
| --- | --- |
| 병렬 에이전트 = worktree-per-instance (dir+branch+port+DB 격리) | ✅ 일치 |
| 에이전트는 main에 직접 push 금지 → 리뷰 가능한 PR로만, 자동 머지 안 함 | ✅ 일치 |
| 가드레일은 지시(prompt)가 아니라 구조적 강제(PreToolUse 훅) | ✅ 일치 |
| 차단 시 "더 안전한 대안 제시"(force→force-with-lease) | ⚠️ 반영 필요 |
| `--no-verify`로 품질 게이트 우회 차단 | ⚠️ 반영 필요 |
| 네이티브 worktree(`--worktree`, `.worktreeinclude`) | ⚠️ wt.sh 일부 대체 |
| per-agent branch + Co-Authored-By trailer | ➕ 보강 |

## 2. 합의된 패턴

- **One-agent-per-worktree** — 한 repo를 둘 이상이 ~10분+ 만지면 lockfile/`package.json` 경합. 각 에이전트에 전용 worktree(+브랜치+포트+DB 격리). 거의 모든 병렬 도구의 토대.
- **PR-only, 자동 머지 금지** — Copilot coding agent·GitHub Agentic Workflows 등 벤더 공통: AI 산출물은 *리뷰 가능한 PR*, 사람 승인 필수. branch protection으로 뒷받침.
- **구조적 강제 > 지시** — PreToolUse 훅·Copilot hookflows로 "올바른 동작만 가능하게". best practice는 **차단 + 더 안전한 대안 제시**.
- **Checkpoint-then-clean-commit** — 작업 중엔 잦은 체크포인트 커밋(복구), 머지 전 squash/rebase로 깔끔한 Conventional Commits로 재구성.
- **Per-agent branch + Co-Authored-By** — 공유 브랜치 금지, 머신 파싱 가능한 trailer로 모델 표기(`git log --grep`).
- **Secret 스캔 게이트** — pre-commit/pre-push로 *staged 내용* 스캔. AI 공동저자 커밋이 비밀 ~2배 더 유출.

**유일한 큰 대립 — 체크포인트를 어디 두나:**

| 방식 | 도구 | 트레이드오프 |
| --- | --- | --- |
| Shadow-git (별도 저장소 스냅샷, 실제 히스토리 안 건드림) | Cline, Roo Code, Cursor | 깨끗한 히스토리, 세밀한 per-edit 복원 |
| Real-history auto-commit (편집마다 실제 repo에 커밋) | Aider | 단일 진실원천, 복구 단순 |

## 3. 도구·스킬 지형 (카테고리별)

- **Claude Code 자산** — `commit-commands`(`/commit`·`/commit-push-pr`·`/clean_gone`), 네이티브 worktree, `code-review`/`pr-review-toolkit`, `netresearch/git-workflow-skill`, 커뮤니티 worktree 스킬·명령.
- **worktree 오케스트레이터** — uzi, Worktrunk(wt), Claude Squad(tmux TUI), Conductor(mac GUI), Nimbalyst, Vibe Kanban, Sculptor(Docker 격리).
- **가드레일** — git-safe(Boucle), block-no-verify, mattpocock git-guardrails, dwarvesf/claude-guardrails, claude-security-guardrails.
- **커밋/PR 생성** — aicommits, OpenCommit, gh-prai, gh-ai-pr (전부 Conventional Commits로 수렴, commoditized).
- **MCP** — GitHub MCP(공식, 원격 API), git MCP(`mcp-server-git`, 로컬).
- **이탈 주의** — Crystal→Nimbalyst, Vibe Kanban 호스티드 종료, Bloop. 도구 과잉·미수렴.

## 4. 정밀 분석 (deep-dive)

### 4.1 commit-commands — `/commit`, `/commit-push-pr`, `/clean_gone`

Anthropic 공식 플러그인(15.9만+ 설치). **훅·스크립트 없는 순수 prompt 플러그인** — 각 명령은 `commands/` 아래 YAML frontmatter + 본문 Markdown 한 장.

두 가지 핵심 메커니즘:

- **명령 치환 `!`백틱``** — 명령 확장 시점에 셸을 실행해 stdout을 프롬프트에 인라인. 모델이 시작부터 전체 상태를 갖고 탐색 호출을 생략 → 턴 절약·결정론적.

```markdown
- Current git status: !`git status`
- Current git diff: !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`
```

- **`allowed-tools` 화이트리스트** — 글롭 스코핑으로 그 명령이 쓸 수 있는 명령을 한정.

```yaml
# /commit
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*)
# /commit-push-pr (push/branch/PR 추가)
allowed-tools: Bash(git checkout --branch:*), Bash(git add:*), Bash(git status:*), Bash(git push:*), Bash(git commit:*), Bash(gh pr create:*)
```

- **`/commit`** — `git log --oneline -10`으로 repo 커밋 스타일을 학습해 단일 커밋. "다른 텍스트 보내지 말고 한 메시지에 끝내라"로 잡담 억제.
- **`/commit-push-pr`** — 5단계: ①main이면 브랜치 생성 ②커밋 ③push ④`gh pr create`(브랜치 전체 커밋 분석 + 테스트플랜 체크리스트 PR 본문) ⑤한 메시지에. `gh`+`origin` 필요. **단, "main이면 브랜치"는 프롬프트 지시일 뿐 하드 차단 아님.**
- **`/clean_gone`** — `[gone]` 브랜치(원격 삭제됨) 정리. 핵심 안전장치: **현재/메인 worktree(`git rev-parse --show-toplevel`)는 절대 제거 안 함**, worktree 먼저 `remove --force` 후 `branch -D`. `[gone]`은 `git fetch --prune` 후에만 나타남.

> 함의: commit-commands는 *편의/inner-loop* 레이어(강제력 없음). `.env`/secret 회피와 "main이면 브랜치"가 전부 README 산문 → **우리 git-guard 훅이 하드 백스톱**이어야 함. `/clean_gone`의 "현재 worktree 보호" 가드는 우리 `wt-done`에 그대로 차용 가치.

### 4.2 Claude Code 네이티브 worktree

`git worktree`를 1급 기능으로 내장 — 우리 `wt.sh`의 상당 부분이 이미 네이티브.

- `claude --worktree <name>` (`-w`) → `.claude/worktrees/<name>/`에 `worktree-<name>` 브랜치로 격리 세션 시작. 이름 생략 시 자동 생성.
- **베이스 브랜치**: 기본 `origin/HEAD`(remote 기준 clean). `worktree.baseRef` 설정 = `"fresh"`(기본) 또는 `"head"`(로컬 HEAD, 진행 중 작업 위에).
- **`.worktreeinclude`** (프로젝트 루트, gitignore 문법) — **gitignore된 `.env` 등을 새 worktree에 자동 복사.** 우리 wt.sh의 `.env` 복사 로직을 대체.

```text
.env
.env.local
config/secrets.json
```

- **서브에이전트 격리** — frontmatter `isolation: worktree` 또는 "use worktrees for your agents". 실행 중 `git worktree lock`/unlock 자동.
- **자동 정리** — `--worktree` 세션 종료 시 변경 없으면 worktree+브랜치 제거(이름 있으면 유지 프롬프트). 서브에이전트/백그라운드 worktree는 `cleanupPeriodDays` 경과 + clean이면 청소(단 `--worktree` 세션은 sweep 안 함).
- **PR worktree** — `claude --worktree "#1234"` → `pull/1234/head` fetch, `.claude/worktrees/pr-1234`.
- **`WorktreeCreate`/`WorktreeRemove` 훅** — non-git VCS나 커스텀 위치용으로 기본 동작 전체 대체(단 이때 `.worktreeinclude` 미처리 → 훅이 직접 복사).
- 권고: `.claude/worktrees/`를 `.gitignore`에 추가.

> 함의: worktree-per-instance가 **네이티브 primitive**. 손수 만든 `git worktree add` 스크립트보다 `claude --worktree`를 우선. 자동 브랜치(`worktree-<name>`)라 인스턴스가 **구조적으로 main이 아님** → git-guard는 "네이티브가 못 막는 경우(메인 체크아웃·`-p`·플래그 생략)"의 백스톱. push 안전은 네이티브가 전혀 안 다룸 → **force-push 차단은 우리 훅이 계속 필요**(상호보완).

### 4.3 netresearch/git-workflow-skill

우리가 만들려는 것과 **거의 동명·동목적**의 성숙한 Agent Skill (v1.18.2, 31릴리스, 27★ — 활발하나 소수 채택). 멀티플랫폼(Claude·Cursor·Copilot).

구조: `SKILL.md`(핵심 규칙) + `references/`(브랜칭·커밋컨벤션·PR·CI·advanced 등 ~9개 심화) + `commands/pr-finish.md` + `scripts/verify-git-workflow.sh`.

`allowed-tools: Bash(git:*) Bash(gh:*) Read Write`. **7개 "non-negotiable rules"**(행동 계약):

```text
1. main 직접 push 금지; PR 워크플로 필수
2. 모든 리뷰 스레드 해결 전 머지 차단
3. squash 머지 지양 — 원자 커밋+서명 보존
4. 명령 출력 없이 "테스트했다" 주장 금지
5. 캐시된 skill/plugin 경로 수정 금지; repo worktree에서 수정
6. --force-with-lease만; plain --force 금지
7. 순서: add → commit → fetch → rebase → push; tree dirty면 중단
```

`/pr-finish`: preflight(PR상태·mergeability·필수체크 GraphQL 수집) → spec-cleanup → rebase(`--force-with-lease`) → **push 전 로컬에서 테스트/타입/린트** → 리뷰스레드 GraphQL 해결 → 메타데이터 갱신 → 머지(체크통과+스레드해결시만) → post-merge 브랜치 삭제.

- **강점** — 증거 기반 규칙(출력 없이 "테스트함" 금지), CI-before-push 규율, 실용적 `/pr-finish`, 폭넓은 hook 프레임워크 커버(lefthook/husky/pre-commit) + worktree hook 디버깅.
- **약점** — **전부 advisory(강제 없음)**: 모든 안전 규칙이 프롬프트 레벨, raw bash로 우회 가능. 무겁고 의견 강함(anti-squash, `.spec-cleanup.yml`, composer 경로). 소수 채택, 표면 넓음, GitHub/GraphQL 의존.

> 함의: **"스킬이 가르친다"는 절반이 유효함을 입증하되, 핵심 갭(안전 규칙이 전부 산문)을 노출** — 그 갭이 정확히 우리 git-guard 훅이 메우는 자리. 차용할 것: `--force-with-lease`만, "dirty면 중단", "push 전 로컬 테스트", 출력 없이 테스트 주장 금지. 버릴 것: 멀티 브랜칭 모델·anti-squash 강제·spec-cleanup·멀티리뷰어 스레드 안무(솔로엔 과함). `/pr-finish`를 **얇게** 차용(preflight + 로컬 CI + force-with-lease push + PR), spec-cleanup/버전범프금지 제외.

### 4.4 가드레일 4종

넷 다 동일 primitive: **PreToolUse(Bash) + exit 2 + stderr 거부**. 차이는 (a)차단만 vs 대안제시, (b)MCP 커버, (c)내용 인식 스캔.

- **git-safe (Boucle)** — *차단 + 더 안전한 대안 제시*(차별점). 매핑이 재사용 가능한 자산:

```text
git push --force      -> git push --force-with-lease
git reset --hard      -> git stash  (또는 reset --soft)
git checkout . / -- f -> git stash
git restore <path>    -> git restore --staged
git clean -f          -> git clean -n  (먼저 dry run)
git branch -D         -> git branch -d  (머지된 것만)
git commit --no-verify-> 플래그 제거, hook이 보고한 것 수정
```

  main/master force-push은 무조건 차단. 탈출구: `.git-safe` allowlist / `GIT_SAFE_DISABLED=1`.

- **block-no-verify** — 단일목적: `--no-verify`(+commit `-n`) 차단. **문맥 인식**: `-n`을 commit엔 차단(=no-verify), push엔 허용(=dry-run). **MCP 우회까지 차단**: `mcp__github__push_files`/`merge_pull_request`/`update_pull_request_branch` 등. 대안 제시는 안 함.
- **mattpocock git-guardrails** — `skills/` 트리지만 실제론 `.claude/hooks/`의 `block-dangerous-git.sh` PreToolUse 훅. `git push`(--force 포함)·`reset --hard`·`clean -f`·`branch -D`·`checkout .`·`restore .` **순수 차단**(대안 없음). 설치 시 block list 편집.
- **dwarvesf/claude-guardrails** — 방어심화(full/lite). lite=permission deny + 3훅 + CLAUDE.md. full=+exfil/권한상승 패턴 + PostToolUse 프롬프트인젝션 스캐너 + OS sandbox. 차별점: **`scan-commit.sh`가 `git diff --cached -U0`를 secret 정규식으로 스캔(내용 인식)**. 정직하게 한계 명시: "deny는 빌트인 도구만, bash는 못 막음 → OS sandbox가 진짜 경계."

공통 사각: `core.hooksPath` 재설정은 4개 모두 미대응.

> 함의: 우리 git-guard와 **아키텍처 일치**(검증됨). 업그레이드 3가지: ①git-safe식 **차단+대안제시**(force→force-with-lease) ②`--no-verify` 차단 ③PR-only이므로 `mcp__github__.*` 직접 main 쓰기도 차단(아니면 우회 가능). worktree-per-instance가 dwarvesf의 OS sandbox 대응물 = 진짜 경계, 훅은 catch-net.

### 4.5 Worktrunk (wt)

worktree를 4동사(switch/list/merge/remove) + TOML 훅 엔진 + 템플릿으로 감싼 Rust CLI. **"두꺼운 자동화" 극** (우리 가드레일-only의 반대편).

- `wt switch -c <branch>` 생성+이동, `wt switch -c -x claude feat`(Claude 인스턴스당 worktree 1개), `wt switch pr:123`.
- `wt list --full`: CI 상태 + AI 요약 + 글리프(`@`현재 `↑`ahead `⇡`unpushed), 활동마커 `🤖`/`💬`.
- `wt merge main`: squash→rebase→ff-merge→정리 한 방(+LLM squash 메시지).
- **템플릿 필터** `sanitize`(슬래시→-), `codename`(결정론적 이름), **`hash_port`(브랜치명→10000-19999 고정 포트, dev 서버 충돌 방지)**.
- **라이프사이클 훅** TOML: `pre-start`/`post-start`/`pre-merge` — `pre-*`는 블로킹, `post-*`는 백그라운드.

```toml
[pre-start]
deps = "npm ci"
[pre-merge]
test = "npm test"
```

- Claude Code 플러그인: `WorktreeCreate` 훅으로 에이전트의 `git worktree add`를 `wt switch --create`로 **리라우팅** → wt 네이밍·훅·정리 상속. `/wt-switch-create` 명령, statusline 통합.

> 함의: wt는 **Skill 레이어의 기능 메뉴**로 참고. 차용: `post-start` 부트스트랩(블로킹-pre/백그라운드-post 구분), `hash_port`/`sanitize` 결정론적 네이밍(포트·경로 충돌 방지). 버릴 것: `wt merge`(squash→ff)는 PR 리뷰 우회 → **솔로 PR-only에선 머지 자동화 안 함**. 손수 `wt.sh`는 더 투명·감사가능·무의존(가드레일 철학에 맞음).

### 4.6 uzi

한 작업을 N개 에이전트로 fan-out, 각자 worktree+격리deps+자동포트, 베스트를 골라 병합하는 CLI(Go, 에이전트 무관).

```yaml
# uzi.yaml
devCommand: cd app && yarn && yarn dev --port $PORT
portRange: 3000-3010
```

- `uzi prompt --agents claude:2,codex:1 "..."` (또는 `random:5`) — 각 에이전트 = worktree + tmux 세션 + `$PORT` 주입.
- `uzi ls -w`(watch), `uzi auto`(확인 자동), `uzi broadcast`(전체 지시), `uzi run`(전 worktree에 명령).
- **`uzi checkpoint <agent> "msg"`** = 사람이 게이트하는 통합: 그 에이전트 worktree를 **커밋 + 현재 브랜치에 rebase**. 자동으론 아무것도 본류에 안 감.

> 함의: worktree-per-instance + per-worktree deps + 자동포트 **검증**. 단 uzi `checkpoint`는 현재 브랜치에 직접 rebase = 우리 git-guard가 막는 경로. **우리는 의도적으로 발산** — 머지 대신 PR 경계 강제. 어휘(watch/broadcast/checkpoint)는 ergonomics로 차용하되 "merge" 동사는 "PR 열기"로.

### 4.7 MCP — GitHub 서버 vs git 서버

상호보완 2종. **둘 다 `git push`/`git worktree` 미모델 → 진짜 publish/격리는 셸 git** → 그래서 가드레일 훅이 필요.

- **GitHub-API 서버**(`github/github-mcp-server`, Go) — 원격 API(이슈·PR·릴리스·Actions). ~20 toolset(`default`=context/issues/pull_requests/repos/users). Oct 2025 통합: `pull_request_read`(method: get/get_diff/get_files/get_reviews...), `pull_request_review_write`, `issue_read`/`issue_write`, `create_pull_request`/`merge_pull_request`. **하드 `--read-only`/`GITHUB_READ_ONLY=1`**(원격만 보호), `--lockdown-mode`(프롬프트인젝션 완화). 원격 호스티드 엔드포인트 있음.
- **git 서버**(`mcp-server-git`, Python) — 로컬 working tree. `git_status`/`git_diff_staged`/`git_add`/`git_commit`/`git_log`/`git_create_branch`/`git_checkout`/`git_show`/`git_branch`. **read-only 모드 없음**, `git_commit`/`checkout` 항상 노출. **`git push` 미포함**(원격에 못 올림).

판단 규칙: 원격 상태 → GitHub-API 서버(기본 read-only, PR 올릴 때만 write). 로컬 커밋 위생 → git 서버 타입드 툴 또는 셸. **push/force-push/worktree/rebase → 셸 git(여기서 git-guard가 강제).**

> 함의: 어떤 MCP 서버도 git-guard를 대체 못 함. git 서버는 branch protection/read-only 없음, GitHub 서버 `--read-only`는 원격만. push/worktree가 셸 전용이라 **정책은 우리 PreToolUse 훅에 있어야 함**. 리뷰어 서브에이전트엔 `GITHUB_READ_ONLY=1` + lean toolset(`repos,issues,pull_requests`).

### 4.8 AI 커밋·PR 도구

동일 파이프라인: `git diff --staged` → LLM → 메시지. 둘 다 `prepare-commit-msg` 훅으로 통합, lockfile 기본 제외.

- **aicommits** — `aic`. `--type plain`(기본)/`conventional`/`gitmoji`/`subject+body`(Conventional은 **opt-in**). `-g N` 후보 N개, `--exclude`. Provider: TogetherAI(기본)/OpenAI/Groq/Ollama 등. `aicommits hook install` → `prepare-commit-msg`.
- **OpenCommit** — `oco`. **Conventional 기본**, `OCO_PROMPT_MODULE=@commitlint`로 repo commitlint 학습/강제. `OCO_EMOJI`, 이슈번호 템플릿(`oco '#205: $msg'`). Provider: OpenAI(기본 gpt-4o-mini)/Anthropic/Ollama/Gemini/DeepSeek. `oco hook set`.
- **PR 본문** — `gh-prai`(diff→ChatGPT→PR 제목/본문, 생성/갱신), **`gh-ai-pr`**(base 탐지 + `.github/PULL_REQUEST_TEMPLATE.md` 인식 + XML 태그 프롬프트 생성 → 모델은 직접 안 부름, 별도 키 불필요).

> 함의: 훅 네임스페이스(`prepare-commit-msg`)가 우리 PreToolUse와 안 겹침. 스킬이 **CLI로 opt-in 호출**(`oco --yes`)이 repo 훅 설치보다 나음(worktree-per-instance·솔로 흐름과 충돌 회피). Conventional은 스킬에 명시. PR 본문은 Claude가 직접 쓰되 `gh-ai-pr`식으로 repo 템플릿 존중.

## 5. 핵심 시사점 & 빈틈

**시사점** — worktree가 격리 표준(최대 도구 군집), PR-only가 벤더 공통, 가드레일이 지시→구조강제로 이동, GitHub MCP가 표준 원격 surface, secret이 AI 특유 리스크, provenance는 미성숙(git-ai + Co-Authored-By뿐).

**빈틈 = 기회** — ①**converge(머지/충돌해소)가 미흡**(fan-out 도구는 수십, 수렴은 수동) ②provenance/감사 도구 거의 없음 ③도구 과잉·이탈 ④대량 AI 커밋 리뷰 미해결 ⑤로컬 가드레일은 우회 가능(서버측과 미통합) ⑥branch+dir 넘는 상태 격리(DB/포트)는 Sculptor 정도뿐 ⑦크로스-에이전트 표준 부재.

## 6. 우리 설계에 주는 함의 (consensus 반영)

### 6.1 검증됨 (그대로 유지)

worktree 격리 + PR-only + per-task 브랜치 + PreToolUse 차단 훅 = **업계 consensus와 정확히 일치**. 방향 옳음.

### 6.2 변경 — git-guard v2

- **차단 + 더 안전한 대안 제시** (git-safe 패턴): force push 거부 메시지에 `--force-with-lease` 안내.
- **`--force-with-lease`는 허용**, plain `--force`/`-f`만 차단 (netresearch rule 6 + git-safe). 단 보호 브랜치로의 push는 형태 불문 차단 유지.
- **`--no-verify` 차단** (commit/push/merge/rebase; commit `-n`은 차단, push `-n`=dry-run은 허용).
- (선택) `mcp__github__.*` 직접 main 쓰기 차단 — PR-only 우회 봉쇄. *현재 미구현, 후속 후보.*

### 6.3 변경 — git-workflow Skill v2

- **네이티브 worktree 우선** — `claude --worktree <name>` + `.worktreeinclude`(.env 자동 복사)로 wt.sh의 부트스트랩 일부 대체. wt.sh는 비-Claude-Code 셸 폴백.
- **`allowed-tools` 스코핑** — `Bash(git:*) Bash(gh:*) Read Write` (netresearch·commit-commands 패턴).
- **차용 규칙** — `--force-with-lease`만 · "tree dirty면 중단" · "push 전 로컬 테스트/린트" · "출력 없이 테스트 주장 금지".
- **상태 front-load** — `/commit`처럼 `!`백틱`` 치환으로 status/diff/branch/log 선주입.

### 6.4 의도적 제외 (솔로 PR-only엔 과함)

멀티 브랜칭 모델(Git Flow 등) 강제, anti-squash 강제, `wt merge` 류 머지 자동화(PR 우회), `.spec-cleanup.yml`, 멀티리뷰어 스레드 안무, PostToolUse 프롬프트인젝션 스캐너(신뢰 repo면 불필요).

## 출처 (주요)

- Claude Code: [worktrees](https://code.claude.com/docs/en/worktrees) · [commit-push-pr 참조명령](https://raw.githubusercontent.com/anthropics/claude-code/main/.claude/commands/commit-push-pr.md) · [commit-commands](https://claude.com/plugins/commit-commands)
- [netresearch/git-workflow-skill](https://github.com/netresearch/git-workflow-skill)
- 가드레일: [git-safe(Boucle)](https://github.com/Bande-a-Bonnot/Boucle-framework/tree/main/tools/git-safe) · [block-no-verify](https://github.com/tupe12034/block-no-verify) · [mattpocock](https://github.com/mattpocock/skills/blob/main/skills/misc/git-guardrails-claude-code/SKILL.md) · [dwarvesf](https://github.com/dwarvesf/claude-guardrails)
- worktree 도구: [Worktrunk](https://worktrunk.dev/claude-code/) · [uzi](https://github.com/devflowinc/uzi)
- MCP: [GitHub MCP](https://github.com/github/github-mcp-server) · [git MCP](https://github.com/modelcontextprotocol/servers/tree/main/src/git)
- 커밋/PR: [aicommits](https://github.com/nutlope/aicommits) · [OpenCommit](https://github.com/di-sukharev/opencommit) · [gh-ai-pr](https://github.com/iloveitaly/gh-ai-pr)
- 패턴: [worktrees for AI agents](https://www.mindstudio.ai/blog/parallel-ai-coding-agents-git-worktrees) · [stop pushing to main](https://dev.to/ticktockbent/stop-letting-agents-code-push-to-main-2kfk) · [checkpoints: Cline](https://docs.cline.bot/core-workflows/checkpoints) · [Aider git](https://aider.chat/docs/git.html)
