---
name: akg-push
argument-hint: "[문서 또는 제안 경로]"
disable-model-invocation: true
description: >-
  자리표시(placeholder). 로컬에서 만든 지식 문서 · 의미 제안을 AKG(agent-knowledge-governance)
  레지스트리에 올리는 스킬이 들어올 자리다. 지금은 절차가 없다.
---

# akg-push (placeholder)

AKG 로 **올리는** 쪽. 짝은 [`akg-pull`](../akg-pull/SKILL.md)(가져오는 쪽).

맡을 일(예정): 로컬 keyword-docs 문서와 db-schema 의미 제안(proposal.json)을 AKG 의
공유 레지스트리에 등록한다. 전신은 `keyword-docs-add-index` · `keyword-docs-new-docs` ·
`db-schema-propose-codebase` 스킬이다(2026-10-24, 이 자리로 합침).

절차가 들어오면 이 파일을 통째로 바꾼다. 지금 호출하면 "아직 자리표시" 라고만 답한다.
