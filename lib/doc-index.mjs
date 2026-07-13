// Shared keyword-docs index resolution — the SINGLE source of truth for how a
// doc entry's `path` resolves to an absolute file, used by BOTH the context
// hook (keyword-docs provider) and the observability collector's /docs viewer
// (#92). Sharing the resolution is what keeps doc discovery and the /docs
// content allowlist from diverging (a divergence would be a path-traversal
// hole), so the primitives live here, not copied in two places.
//
// Path rules (must match the provider exactly):
//   • a doc entry's `path` resolves against the folder CONTAINING its index,
//     except a folder literally named `.claude` delegates to its PARENT
//     (backward-compat with the <cwd>/.claude/index + cwd-relative docs layout);
//   • absolute doc paths pass through; `~` / `~/…` expands to home.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export function expandTilde(p) {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// Base folder for a doc `path` inside the index at indexPath: the index's own
// folder, except a folder literally named `.claude` delegates to its parent.
export function docBaseFor(indexPath) {
  const dir = dirname(indexPath);
  return basename(dir) === ".claude" ? dirname(dir) : dir;
}

// Parse an index file → array, or null on missing/invalid (this layer then
// contributes nothing — fail-soft).
export function readIndex(indexPath) {
  try {
    const arr = JSON.parse(readFileSync(indexPath, "utf8"));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

// Resolve one index file → [{ keywords, path, abs, precision }]. Missing/invalid
// index → []; non-object rows or rows without a string `path` are skipped
// (fail-soft, same as the provider).
export function resolveIndexEntries(indexPath) {
  const arr = readIndex(indexPath);
  if (!arr) return [];
  const base = docBaseFor(indexPath);
  const out = [];
  for (const entry of arr) {
    if (!entry || typeof entry.path !== "string") continue;
    out.push({
      keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
      path: entry.path,
      abs: isAbsolute(entry.path) ? entry.path : join(base, entry.path),
      precision: Number.isFinite(Number(entry.precision)) ? Number(entry.precision) : 1,
    });
  }
  return out;
}

// The keyword-docs engine instances and their default index basenames — mirrors
// core/context/lib/providers/{keyword-docs,msg-format,db-schema,domain-docs}.mjs.
// If a provider is added there, add it here too (the collector reads the USER
// layer only for #92, so only the basename matters).
export const KEYWORD_DOCS_INSTANCES = [
  { id: "keyword-docs", defaultBasename: "context-docs.json" },
  { id: "msg-format", defaultBasename: "context-docs.msg-format.json" },
  { id: "db-schema", defaultBasename: "context-docs.db-schema.json" },
  { id: "domain-docs", defaultBasename: "context-docs.domain.json" },
];

// Resolve each instance's USER-layer index path (mirrors keyword-docs.mjs's user
// layer): a per-instance `params.index` override in ~/.claude/context.json wins
// (expanded; relative resolves under home), else ~/.claude/<defaultBasename>.
// Returns [{ id, index }]. The collector reads only these (project/bundle layers
// are out of scope for #92 — the collector can't locate a repo's cwd).
export function userDocIndexes(homeDir = homedir()) {
  let cfg = null;
  try {
    cfg = JSON.parse(readFileSync(join(homeDir, ".claude", "context.json"), "utf8"));
  } catch {
    /* no user config → all instances fall back to their default basename */
  }
  const providers = Array.isArray(cfg?.providers) ? cfg.providers : [];
  return KEYWORD_DOCS_INSTANCES.map(({ id, defaultBasename }) => {
    const override = providers.find((e) => e && e.id === id)?.params?.index;
    if (typeof override === "string" && override) {
      const spec = expandTilde(override);
      return { id, index: isAbsolute(spec) ? spec : join(homeDir, spec) };
    }
    return { id, index: join(homeDir, ".claude", defaultBasename) };
  });
}
