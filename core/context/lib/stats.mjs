// core/context/lib/stats.mjs — append-only injection stats (오탐 프루닝 layer 1).
//
// Records WHAT keyword-docs injected and WHICH keywords fired, so repeated
// false positives become visible ("keyword X fired 14 times, never followed
// up") and pruning decisions can be data-driven. Recording only — outcome
// judging and report/mute tooling are follow-up layers (issue #32).
//
// Storage: ~/.claude/context-stats/<sha256(cwd)>.jsonl — deliberately NOT
// os.tmpdir() (the ledger convention): stats exist to accumulate across weeks
// and must survive reboots. One JSON line per injected doc:
//   { "ts": 1751600000000, "session": "abc", "keywords": ["mcp"], "path": "docs/x.md" }
//
// Best-effort by design: any I/O failure is swallowed — stats must never
// break, delay, or alter an injection.

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Env overrides exist for tests and relocation, not day-to-day tuning.
const MAX_BYTES = Number(process.env.CLAUDE_CONTEXT_STATS_MAX_BYTES) || 1024 * 1024;
const KEEP_LINES = 4000; // rolling cap: keep the newest lines when trimming

function statsPath(cwd) {
  const dir =
    process.env.CLAUDE_CONTEXT_STATS_DIR || join(homedir(), ".claude", "context-stats");
  mkdirSync(dir, { recursive: true });
  const key = createHash("sha256").update(String(cwd)).digest("hex").slice(0, 16);
  return join(dir, `${key}.jsonl`);
}

/** Append one stats line per injected doc. Silent on any failure. */
export function recordInjection(cwd, entry) {
  try {
    const file = statsPath(cwd);
    appendFileSync(file, JSON.stringify(entry) + "\n");
    if (statSync(file).size > MAX_BYTES) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      writeFileSync(file, lines.slice(-KEEP_LINES).join("\n") + "\n");
    }
  } catch {
    // stats are an observability aid — never let them break the injection path
  }
}
