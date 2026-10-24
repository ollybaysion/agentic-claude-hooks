---
name: akg-push
argument-hint: "[type] [문서.json | 스킬.md | proposal.json]"
disable-model-invocation: true
description: >-
  자리표시(placeholder). 로컬에서 만든 지식 문서 · 도메인 스킬 · 의미 제안을 AKG
  (agent-knowledge-governance) 서버에 올리는 스킬이 들어올 자리다. 지금은 절차가 없다.
---

# akg-push (placeholder)

AKG 로 **올리는** 쪽. 짝은 [`akg-pull`](../akg-pull/SKILL.md)(가져오는 쪽).
연결 준비는 [`setup`](../setup/SKILL.md) 의 5절.

## 가리키는 곳

- AKG 레포: [ollybaysion/agent-knowledge-governance](https://github.com/ollybaysion/agent-knowledge-governance),
  로컬 체크아웃 `~/work/fdc-agent/agent-knowledge-governance`.
- CLI: `akg`(= `<체크아웃>/bin/akg.mjs`). 이 스킬이 부를 명령:

  ```bash
  akg push <type> <doc.json|skill.md> [--dry-run] [--keyword <kw[:inject]>] [--status <s>]   # 문서 · 스킬 생성/갱신
  akg propose <type>/<id> <proposal.json> [--server <url>] [--mirror <dir>]                 # 의미 제안 → 리뷰 큐
  akg catalog-push <table> <describe.json> [--server <url>] [--mirror <dir>]                # 테이블 카탈로그
  ```

- 서버 · 토큰: `AKG_SERVER`(없으면 미러 `meta.json` 의 `serverUrl`) · `AKG_TOKEN`(없으면
  `~/.claude/akg/token`). `--dry-run` 은 검증과 렌더만 하고 쓰지 않는다.

## 맡을 일(예정)

로컬 문서(md · json)나 proposal.json 을 받아 형식을 검사하고 `akg push`/`akg propose` 로
올린 뒤 결과(생성 · 갱신 · 거절 사유)를 보여 준다. 전신은 `keyword-docs-add-index` ·
`keyword-docs-new-docs` · `db-schema-propose-codebase` 스킬이다(2026-10-24, 이 자리로 합침).

절차가 들어오면 이 파일을 통째로 바꾼다. 지금 호출하면 "아직 자리표시" 라고만 답한다.
