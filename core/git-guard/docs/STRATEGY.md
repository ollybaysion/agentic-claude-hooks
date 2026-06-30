# Git 관리 전략 (최종)

> 2026-07-01 확정. 시장 조사([agentic-git-landscape.md](agentic-git-landscape.md))를 거쳐
> 단순화한 최종 결정. 핵심: "꼭 필요한 빈칸(main 보호) 하나만 새로 만들고, 나머지는 재사용."

## 결정 요약

| 항목 | 결정 |
| --- | --- |
| main 보호 | **git-guard** 훅이 main/master 직접 작업 차단 (Edit·commit·push), `deny` |
| 파괴적 명령 | **bash-guard** 소관 (force-push·reset --hard·clean 등) — git-guard 범위 밖 |
| 병렬 격리 | 네이티브 `claude --worktree` + `.worktreeinclude` (wt.sh 재발명 안 함) |
| 커밋/PR | 기존 `/commit`·`/commit-push-pr`·`/clean_gone` 재사용 (재구현 안 함) |
| 협업 형태 | 솔로 — PR은 셀프리뷰·이력·롤백용 |
| 보류 | git-workflow 스킬, 자동 체크포인트 훅, squash 자동화 — 지금은 불필요 |

## git-guard (이번 구현)

main 보호만 담당하는 PreToolUse 훅 (`core/git-guard/`):

- `Write`/`Edit`/`MultiEdit` — 현재 HEAD가 main/master면 차단
- `Bash` `git commit` — main/master에서 차단
- `Bash` `git push` — main/master 대상이면 차단

"지금 어느 브랜치냐"는 git 상태가 필요해 **bash-guard(상태 없는 명령 매처)로는 불가능** — 그래서 별도 훅. 파괴적 명령은 bash-guard가 맡아 경계가 깔끔하다.

## 워크플로 (도구 조합)

```text
작업 시작 → claude --worktree <name>   # 격리된 worktree+브랜치 (네이티브)
  작업 + 커밋   → /commit
  푸시 + PR     → /commit-push-pr       # main은 PR 머지로만
  정리          → /clean_gone
```

`.worktreeinclude`에 `.env` 등을 적어두면 새 worktree에 자동 복사된다.

## 왜 이렇게 단순한가

조사 결과 worktree 격리·PR-only·차단 훅은 업계 consensus와 일치(검증됨). 커밋/PR/worktree는
이미 성숙한 자산이 있어 **재사용**하고, 우리가 새로 만드는 건 "main 보호"라는 빈칸
하나(git-guard)뿐. 자동 체크포인트·스킬은 현재 사용에 문제가 없어 보류한다.

## 배경 조사

[agentic-git-landscape.md](agentic-git-landscape.md) — 에이전틱 코딩의 git 관리
도구·패턴 시장 조사 (웹 62개 발견 + 8개 대상 정밀 분석).
