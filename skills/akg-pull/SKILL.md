---
name: akg-pull
argument-hint: "[문서 id 또는 범위]"
disable-model-invocation: true
description: >-
  자리표시(placeholder). AKG(agent-knowledge-governance) 레지스트리의 지식 문서를 로컬
  keyword-docs 층으로 가져오는 스킬이 들어올 자리다. 지금은 절차가 없다.
---

# akg-pull (placeholder)

AKG 에서 **가져오는** 쪽. 짝은 [`akg-push`](../akg-push/SKILL.md)(올리는 쪽).

맡을 일(예정): AKG 레지스트리의 문서를 로컬 keyword-docs 층(`~/.claude/docs/…`)에 내려
받고 인덱스에 등록한다. 전신은 `keyword-docs-prune` · `db-schema-docs` 스킬이다
(2026-10-24, 이 자리로 합침).

절차가 들어오면 이 파일을 통째로 바꾼다. 지금 호출하면 "아직 자리표시" 라고만 답한다.
