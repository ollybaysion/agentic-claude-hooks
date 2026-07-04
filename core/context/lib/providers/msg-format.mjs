// msg-format — keyword-docs instance (UserPromptSubmit, prio 65) — OPT-IN.
//
// 설비 메시지 포맷: when a prompt mentions an equipment COMMAND name, inject
// that command's message-format doc. Index maps command names to format docs:
//   .claude/context-docs.msg-format.json
//   [ { "keywords": ["cmd_start_lot", "startlot"], "path": "docs/msg/start-lot.md" } ]
// Command names are identifiers, so keep keywords lowercase; the "word" matcher
// handles underscore identifiers as single tokens. Same engine, ledger, stats,
// and precision semantics as keyword-docs — adding an index entry takes effect
// on the next turn, no reload.

import { makeKeywordDocsProvider } from "./keyword-docs.mjs";

export default makeKeywordDocsProvider({
  id: "msg-format",
  defaultPriority: 65, // domain-specific beats the generic keyword-docs (50) under budget pressure
  defaults: { index: ".claude/context-docs.msg-format.json" },
});
