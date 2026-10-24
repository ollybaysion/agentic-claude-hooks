---
name: akg-pull
argument-hint: "[--skills] [type]"
disable-model-invocation: true
description: >-
  자리표시(placeholder). AKG(agent-knowledge-governance) 서버의 지식 문서를 로컬 미러
  (~/.claude/akg/<type>/)로 가져오는 스킬이 들어올 자리다. 지금은 절차가 없다.
---

# akg-pull (placeholder)

AKG 에서 **가져오는** 쪽. 짝은 [`akg-push`](../akg-push/SKILL.md)(올리는 쪽).
연결 준비는 [`setup`](../setup/SKILL.md) 의 5절.

## 가리키는 곳

- AKG 레포: [ollybaysion/agent-knowledge-governance](https://github.com/ollybaysion/agent-knowledge-governance),
  로컬 체크아웃 `~/work/fdc-agent/agent-knowledge-governance`.
- CLI: `akg`(= `<체크아웃>/bin/akg.mjs`). 이 스킬이 부를 명령:

  ```bash
  akg sync [--skills] [--skills-dir <dir>] [--server <url>] [--mirror <dir>]
  ```

- 서버 · 토큰: `AKG_SERVER`(없으면 미러 `meta.json` 의 `serverUrl`) · `AKG_TOKEN`(없으면
  `~/.claude/akg/token`).
- 내려놓는 자리: 미러 `~/.claude/akg/<type>/{index.json, docs/*.md}`(`AKG_MIRROR`),
  스킬은 `~/.claude/skills`(`AKG_SKILLS_DIR`). `core/context` 의 keyword-docs hub 모드가
  같은 미러를 읽는다.

## 맡을 일(예정)

`akg sync` 를 돌려 미러를 갱신하고, 바뀐 문서 · 인덱스를 요약해 보여 준다. 전신은
`keyword-docs-prune` · `db-schema-docs` 스킬이다(2026-10-24, 이 자리로 합침).

절차가 들어오면 이 파일을 통째로 바꾼다. 지금 호출하면 "아직 자리표시" 라고만 답한다.
