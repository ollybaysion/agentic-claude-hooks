// core/context/lib/registry.mjs — id -> provider.
//
// Static relative imports only (never absolute / project paths). Add a provider
// == import it and add it to the array below. Config entries that reference an
// unknown id, or a provider that does not run on this event, are skipped
// silently. See DESIGN.md §5.

import git from "./providers/git.mjs";
import time from "./providers/time.mjs";
import keywordDocs from "./providers/keyword-docs.mjs";
import msgFormat from "./providers/msg-format.mjs";
import dbSchema from "./providers/db-schema.mjs";
import domainDocs from "./providers/domain-docs.mjs";

const REGISTRY = Object.fromEntries(
  [git, time, keywordDocs, msgFormat, dbSchema, domainDocs].map((p) => [p.id, p])
);

export function selectProviders(cfg, event) {
  return (cfg.providers ?? [])
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
}
