// db-schema — keyword-docs instance (UserPromptSubmit, prio 60) — OPT-IN.
//
// When a prompt mentions a DB (or table) name, inject that DB's schema doc.
// Index maps DB names to schema docs kept as FILES in the repo:
//   .claude/context-docs.db-schema.json
//   [ { "keywords": ["orderdb", "orders"], "path": "docs/schema/orderdb.md" } ]
// This is the file-based v1 of issue #22 — live introspection + cache +
// migration-file invalidation remain future scope there. Schema docs are often
// large: consider "precision": 0.5 (link-only) for broad names, and regenerate
// the doc files from your schema dump tooling. Same engine/ledger/stats as
// keyword-docs; index edits apply on the next turn.

import { makeKeywordDocsProvider } from "./keyword-docs.mjs";

export default makeKeywordDocsProvider({
  id: "db-schema",
  defaultPriority: 60,
  defaults: { index: ".claude/context-docs.db-schema.json" },
});
