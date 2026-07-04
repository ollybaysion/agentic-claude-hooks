// domain-docs — keyword-docs instance (UserPromptSubmit, prio 55) — OPT-IN.
//
// 도메인 로직 용어: when a prompt mentions a domain concept (e.g. TSUM,
// Interlock), inject that concept's doc. Index maps domain terms to docs:
//   .claude/context-docs.domain.json
//   [ { "keywords": ["tsum"], "path": "docs/domain/tsum.md" },
//     { "keywords": ["interlock"], "path": "docs/domain/interlock.md" } ]
// Keywords are lowercased before matching, so "TSUM" in a prompt matches the
// keyword "tsum". Same engine/ledger/stats/precision as keyword-docs; index
// edits apply on the next turn, no reload.

import { makeKeywordDocsProvider } from "./keyword-docs.mjs";

export default makeKeywordDocsProvider({
  id: "domain-docs",
  defaultPriority: 55,
  defaults: { index: ".claude/context-docs.domain.json" },
});
