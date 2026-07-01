// core/context/lib/config.mjs — load/validate <project>/.claude/context.json.
//
// Zero-config by design: a missing or invalid file runs the built-in
// DEFAULT_PROFILE (never inactive). An explicit empty providers array is the
// kill switch. See DESIGN.md §4.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Only git + time — the two things CLAUDE.md fundamentally cannot do (live git
// state, current time). project-files / keyword-docs / db-schema / tool-time
// providers are opt-in and shipped separately (see DESIGN.md §1, §12).
export const DEFAULT_PROFILE = {
  providers: [
    { id: "git", priority: 90 },
    { id: "time", priority: 40 },
  ],
};

export function loadConfig(cwd) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(cwd, ".claude", "context.json"), "utf8"));
  } catch {
    return { providers: DEFAULT_PROFILE.providers, disabled: false }; // missing/invalid -> defaults
  }
  if (Array.isArray(raw.providers) && raw.providers.length === 0) {
    return { providers: [], disabled: true }; // explicit kill switch
  }
  return {
    charBudget: raw.charBudget,
    providers: Array.isArray(raw.providers) ? raw.providers : DEFAULT_PROFILE.providers,
    disabled: false,
  };
}
