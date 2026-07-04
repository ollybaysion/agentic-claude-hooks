// core/context/lib/registry.mjs — id -> provider.
//
// Static relative imports only (never absolute / project paths). Add a provider
// == import it and add it to the array below. Config entries that reference an
// unknown id, or a provider that does not run on this event, are skipped
// silently. See DESIGN.md §5.
//
// Bundle auto-enable (issue #47): a registered provider whose plugin-bundled
// index exists (${CLAUDE_PLUGIN_ROOT}/context-docs/<id>.json) is activated
// even with zero config — bundled docs must work on a fresh install, that is
// the point of shipping them. Opt out per project/user with
// { "id": "<id>", "enabled": false }; the project kill switch ("providers": [])
// turns this off too (the runner exits before selection).

import { existsSync } from "node:fs";
import { join } from "node:path";
import git from "./providers/git.mjs";
import time from "./providers/time.mjs";
import keywordDocs from "./providers/keyword-docs.mjs";
import msgFormat from "./providers/msg-format.mjs";
import dbSchema from "./providers/db-schema.mjs";
import domainDocs from "./providers/domain-docs.mjs";

const REGISTRY = Object.fromEntries(
  [git, time, keywordDocs, msgFormat, dbSchema, domainDocs].map((p) => [p.id, p])
);

// The winning config entry for id (project beats user), for the explicit-off check.
function configEntry(layers, id) {
  const find = (cfg) => cfg?.providers?.find?.((e) => e && e.id === id);
  return find(layers?.project) ?? find(layers?.user) ?? null;
}

export function selectProviders(cfg, event) {
  const selected = (cfg.providers ?? [])
    .map((entry) => {
      const p = REGISTRY[entry.id];
      if (!p || !p.events.includes(event)) return null; // unknown id or wrong event -> skip
      return {
        id: p.id,
        run: p.run,
        params: entry.params ?? {},
        priority: entry.priority ?? p.defaultPriority,
      };
    })
    .filter(Boolean);

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    for (const p of Object.values(REGISTRY)) {
      if (!p.events.includes(event)) continue;
      if (selected.some((s) => s.id === p.id)) continue;
      if (configEntry(cfg.layers, p.id)?.enabled === false) continue; // explicit off
      if (!existsSync(join(pluginRoot, "context-docs", `${p.id}.json`))) continue;
      selected.push({ id: p.id, run: p.run, params: {}, priority: p.defaultPriority });
    }
  }
  return selected;
}
