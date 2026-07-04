// core/context/lib/config.mjs — load & merge layered context config.
//
// Two config files, merged (issue #47):
//   user    ~/.claude/context.json      — personal, cwd-independent
//   project <cwd>/.claude/context.json  — repo-specific, wins on conflict
//
// Merge rules:
//   - providers: union by id over DEFAULT_PROFILE -> user -> project (later
//     layer replaces the whole entry for the same id). DEFAULT_PROFILE is
//     always the base, so creating a user file never silently kills git/time
//     in unconfigured projects. Turn one provider off with
//     { "id": "...", "enabled": false }.
//   - charBudget: shallow key merge, project wins.
//   - kill switch: PROJECT "providers": [] disables everything (all layers,
//     including plugin-bundled indexes). A user-level empty array contributes
//     nothing (it is not a global kill switch).
//
// The raw per-layer configs are returned as cfg.layers so layer-aware
// providers (keyword-docs engine) can resolve per-layer index files.
// Zero-config unchanged: no files at all -> DEFAULT_PROFILE. See DESIGN.md §4.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Only git + time — the two things CLAUDE.md fundamentally cannot do (live git
// state, current time). keyword-docs and its named instances are opt-in
// (config or a plugin-bundled index; see DESIGN.md §1, §8, §12).
export const DEFAULT_PROFILE = {
  providers: [
    { id: "git", priority: 90 },
    { id: "time", priority: 40 },
  ],
};

function readLayerFile(path) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null; // missing/invalid layer -> absent
  }
}

function mergeById(...lists) {
  const byId = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (e && typeof e.id === "string") byId.set(e.id, e);
    }
  }
  return [...byId.values()];
}

export function loadConfig(cwd) {
  const user = readLayerFile(join(homedir(), ".claude", "context.json"));
  const project = readLayerFile(join(cwd, ".claude", "context.json"));
  const layers = { user, project };

  if (project && Array.isArray(project.providers) && project.providers.length === 0) {
    return { providers: [], disabled: true, layers }; // explicit project kill switch
  }

  const providers = mergeById(
    DEFAULT_PROFILE.providers,
    user?.providers,
    project?.providers
  ).filter((e) => e.enabled !== false);

  return {
    charBudget: { ...user?.charBudget, ...project?.charBudget },
    providers,
    disabled: false,
    layers,
  };
}
