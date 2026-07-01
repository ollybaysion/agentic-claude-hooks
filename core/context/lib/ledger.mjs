// core/context/lib/ledger.mjs — tiny per-project state for STATEFUL providers
// (currently keyword-docs dedup; db-schema cache will reuse it).
//
// Kept in os.tmpdir(), NEVER under CLAUDE_PLUGIN_ROOT (which changes on every
// plugin update). Best-effort by design: any I/O failure degrades to "no
// memory" and never breaks the hook. See DESIGN.md §10.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const MAX_SESSIONS = 50; // bound the file: keep the most-recently-touched sessions

function pathFor(cwd) {
  const key = createHash("sha256").update(String(cwd)).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), "claude-context");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${key}.json`);
}

export function loadLedger(cwd) {
  try {
    const led = JSON.parse(readFileSync(pathFor(cwd), "utf8"));
    if (led && typeof led === "object") return { sessions: led.sessions ?? {} };
  } catch {
    /* missing / corrupt -> start fresh */
  }
  return { sessions: {} };
}

export function saveLedger(cwd, led) {
  try {
    const entries = Object.entries(led.sessions ?? {});
    if (entries.length > MAX_SESSIONS) {
      entries.sort((a, b) => (b[1]?.ts ?? 0) - (a[1]?.ts ?? 0));
      led.sessions = Object.fromEntries(entries.slice(0, MAX_SESSIONS));
    }
    writeFileSync(pathFor(cwd), JSON.stringify(led), { mode: 0o600 });
  } catch {
    /* best-effort: dedup is an optimization, never fail the hook over it */
  }
}
