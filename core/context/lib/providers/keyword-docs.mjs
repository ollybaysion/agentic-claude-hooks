// keyword-docs context provider (UserPromptSubmit, prio 50) — OPT-IN, default OFF.
//
// Local RAG-lite: match the submitted prompt against hand-curated indexes
// (arrays of { keywords, path }) and inject the matched docs (each clipped to
// maxCharsEach, at most maxDocs). No match -> null, so most turns inject
// nothing (0 tokens) with zero ledger I/O. Deterministic — no vector DB /
// embeddings. See DESIGN.md §8.
//
// Layers (issue #47) — each instance reads up to three indexes per turn, in
// precedence order (a keyword already claimed by a higher layer is shadowed
// in lower ones; same-keyword entries within one index shadow the same way):
//   project  <cwd>-resolved params.index (default .claude/context-docs*.json)
//   user     ~/.claude/context.json entry params.index
//            (default ~/.claude/<basename of the instance default>)
//   bundle   ${CLAUDE_PLUGIN_ROOT}/context-docs/<id>.json — ships with the
//            plugin; env var absent -> layer skipped (fail-open)
//
// Path resolution: params.index accepts absolute paths and ~; a doc entry's
// `path` resolves against the folder CONTAINING ITS INDEX FILE — except when
// that folder is named `.claude`, where the base is its parent (so the
// long-standing "<cwd>/.claude/index + cwd-relative docs" layout keeps
// working unchanged). Absolute doc paths pass through. An index+docs folder
// is therefore self-contained: point params.index anywhere (company docs
// outside any repo) and injection works from any cwd.
//
// Matching (params.match, default "word"):
//   "word"      - word-boundary match, plural-tolerant: keyword "migration"
//                 also matches "migrations"; multi-word keywords (with a space)
//                 match as a case-insensitive substring ("phrase").
//   "exact"     - exact lowercase token match only.
//   "substring" - keyword appears anywhere in the prompt (loose).
//
// Dedup (params.dedup, default true): a doc already injected in THIS session
// within params.dedupTtlMs (default 15m) is skipped, so mentioning the same
// topic on consecutive turns does not re-inject what is already in context.
// State is per-session in os.tmpdir() (see lib/ledger.mjs), keyed by the
// RESOLVED absolute doc path (consistent across layers), best-effort.
//
// Precision (per index entry, default 1): 1 injects the clipped doc slice;
// < 1 (e.g. 0.5) injects only a one-line pointer (~20 tokens) telling the
// model to Read the doc if relevant.
//
// Inheritance: makeKeywordDocsProvider({ id, defaultPriority, defaults })
// builds a NAMED INSTANCE of this engine with its own index files and param
// defaults — msg-format / db-schema / domain-docs are such instances. Every
// index is re-read each turn, so appending an entry takes effect immediately.
//
// Stats (오탐 프루닝 layer 1, issue #32): every ACTUAL injection appends one
// line {ts, session, keywords(fired), path, mode: "full"|"link", index, layer}
// to ~/.claude/context-stats/ (see lib/stats.mjs). `index` is the resolved
// absolute index path and `layer` its source, so per-instance AND per-layer
// analysis stays possible. Recording only, best-effort.
//
// Hub / B모드 (params.hub, opt-in — agent-knowledge-governance design §8.3):
// { url, type, timeoutMs?, indexTtlMs? } backs exactly ONE index source — the
// user layer (or sources[0] for direct/test calls where `layers` is absent,
// same convention as the rest of this file) — with a remote akg server, so
// injection reflects the server's latest doc instead of the last `akg sync`:
//   1. Index refresh is TTL-gated (default 5m) and bounded by `timeoutMs`
//      (default 400ms) — a slow/down server just means this turn matches
//      against whatever index.json was already on disk, never a stall.
//   2. Once a doc MATCHES (full or pointer precision — a pointer still fetches,
//      so the pointed-at file exists for the model's own follow-up Read), that
//      one doc is fetched fresh: same timeoutMs cap, ETag-aware (a 304 costs
//      ~0 bytes), fail-open to whatever copy is already cached. A doc with
//      neither a fresh fetch nor a local copy is skipped silently.
// A hub-backed source shares its mirror directory with A모드's `akg sync`
// (same index.json / docs/*.md layout) and its auth token file
// (~/.claude/akg/token or AKG_TOKEN — see lib/hub-cache.mjs). All hub state
// lives in a sidecar `.hub-cache.json` next to the index, never touching
// A모드's own meta.json.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { loadLedger, saveLedger } from "../ledger.mjs";
import { recordInjection } from "../stats.mjs";
import { docBaseFor, expandTilde, readIndex } from "../../../../lib/doc-index.mjs";
import { fetchDocFresh, loadCacheState, refreshIndexIfStale, saveCacheState } from "../hub-cache.mjs";

const TOKEN = /[a-z0-9_]+/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Predicate for one keyword under a match mode. Receives the lowercased prompt
// and its token Set.
function matcherFor(keyword, mode) {
  const kw = String(keyword).toLowerCase().trim();
  if (!kw) return () => false;
  if (mode === "exact") return (_lower, words) => words.has(kw);
  if (mode === "substring") return (lower) => lower.includes(kw);
  // "word" (default): phrase -> substring; single token -> \bword(es|s)?\b
  if (/\s/.test(kw)) return (lower) => lower.includes(kw);
  const re = new RegExp(`\\b${escapeRe(kw)}(?:es|s)?\\b`, "i");
  return (lower) => re.test(lower);
}

// expandTilde / docBaseFor / readIndex now live in lib/doc-index.mjs, so the
// collector's /docs viewer (#92) resolves a doc entry's path to the same file
// this provider injects — one source of truth for path resolution (and thus for
// the /docs content allowlist, which must not diverge from what gets injected).

// The config entry for this instance in one raw layer config.
const entryFor = (layerCfg, id) =>
  layerCfg?.providers?.find?.((e) => e && e.id === id) ?? null;

/** Build a named instance of the keyword-docs engine (see header). */
export function makeKeywordDocsProvider({ id, defaultPriority = 50, defaults = {} }) {
  return {
    id,
    events: ["UserPromptSubmit"],
    defaultPriority,
    async run({ cwd, prompt, sessionId, params, layers }) {
      if (!prompt) return null;
      const p = { ...defaults, ...params }; // config params override instance defaults

      const defIdx = defaults.index ?? ".claude/context-docs.json";

      // Per-layer index files, precedence order: project > user > bundle.
      // `layers` is absent on direct calls (tests) — merged params then act as
      // the project layer, matching the pre-#47 behavior.
      const sources = [];
      {
        const projSpec = layers !== undefined ? (entryFor(layers?.project, id)?.params?.index ?? defIdx) : (p.index ?? defIdx);
        const spec = expandTilde(String(projSpec));
        sources.push({ layer: "project", path: isAbsolute(spec) ? spec : join(cwd, spec) });
      }
      if (layers !== undefined) {
        const userSpec = entryFor(layers?.user, id)?.params?.index;
        const spec = userSpec
          ? expandTilde(String(userSpec))
          : join(homedir(), ".claude", basename(defIdx));
        sources.push({ layer: "user", path: isAbsolute(spec) ? spec : join(homedir(), spec) });
      }
      if (process.env.CLAUDE_PLUGIN_ROOT) {
        sources.push({
          layer: "bundle",
          path: join(process.env.CLAUDE_PLUGIN_ROOT, "context-docs", `${id}.json`),
        });
      }

      // Hub (B모드): attach the remote config to exactly one source (see header
      // comment), then give it a bounded, best-effort chance to refresh its
      // index.json before this turn reads it. Never throws — a hub-cache bug
      // must fall through to the plain local read, same as a down server does.
      const hub = p.hub && typeof p.hub === "object" && typeof p.hub.url === "string" && typeof p.hub.type === "string" ? p.hub : null;
      let hubSource = null;
      let hubState = null;
      if (hub) {
        hubSource = layers !== undefined ? sources.find((s) => s.layer === "user") : sources[0];
        if (hubSource) {
          hubSource.hub = hub;
          try {
            hubState = loadCacheState(hubSource.path);
            await refreshIndexIfStale({
              indexPath: hubSource.path,
              hub,
              cacheState: hubState,
              now: Date.now(),
              fetchImpl: hub.fetchImpl,
            });
            saveCacheState(hubSource.path, hubState);
          } catch {
            hubState = hubState ?? { index: null, docs: {} };
          }
        }
      }

      // Flatten all layers' entries in precedence order, resolving each doc
      // path against its own index's folder.
      const entries = [];
      for (const src of sources) {
        const arr = readIndex(src.path);
        if (!arr) continue;
        const base = docBaseFor(src.path);
        for (const entry of arr) {
          if (!entry || typeof entry.path !== "string") continue;
          entries.push({
            entry,
            abs: isAbsolute(entry.path) ? entry.path : join(base, entry.path),
            layer: src.layer,
            index: src.path,
            hub: src.hub ?? null,
          });
        }
      }
      if (entries.length === 0) return null;

      const mode = p.match ?? "word";
      const lower = prompt.toLowerCase();
      const words = new Set(lower.match(TOKEN) ?? []);

      // Matched docs in precedence order. A keyword claimed by an earlier
      // entry is shadowed in later ones (within an index and across layers),
      // so "project > user > bundle" falls out of the scan order.
      const candidates = [];
      const seenPath = new Set();
      const seenKw = new Set();
      for (const { entry, abs, layer, index, hub: srcHub } of entries) {
        if (seenPath.has(abs)) continue;
        const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
        const matched = keywords
          .filter((k) => matcherFor(k, mode)(lower, words))
          .filter((k) => !seenKw.has(String(k).toLowerCase()));
        if (matched.length === 0) continue;
        seenPath.add(abs);
        for (const k of matched) seenKw.add(String(k).toLowerCase());
        const precision = Number.isFinite(Number(entry.precision)) ? Number(entry.precision) : 1;
        const rel = relative(cwd, abs);
        const display = rel.startsWith("..") || isAbsolute(rel) ? abs : rel;
        candidates.push({ abs, display, matched, precision, layer, index, hub: srcHub, relPath: entry.path });
      }
      if (candidates.length === 0) return null; // common case: no ledger I/O at all

      // Cross-turn dedup: skip docs already injected in this session within the TTL.
      const dedup = p.dedup !== false;
      const ttlMs = p.dedupTtlMs ?? 15 * 60 * 1000;
      const now = Date.now();
      let led, sess;
      if (dedup) {
        led = loadLedger(cwd);
        const sid = sessionId || "nosession";
        sess = led.sessions[sid] ?? (led.sessions[sid] = { paths: {}, ts: now });
        sess.ts = now;
      }

      const maxDocs = p.maxDocs ?? 2;
      const maxCharsEach = p.maxCharsEach ?? 1200;
      const blocks = [];
      for (const { abs, display, matched, precision, layer, index, hub: docHub, relPath } of candidates) {
        if (blocks.length >= maxDocs) break;
        if (dedup && sess.paths[abs] && now - sess.paths[abs] < ttlMs) continue; // still fresh in context

        // Hub-backed candidate: try to freshen `abs` from the server before
        // reading it below (bounded, ETag-aware, fail-open — see hub-cache.mjs).
        // A pointer-precision match fetches too, so the model's own follow-up
        // Read finds the file even on a first-ever, previously-empty mirror.
        if (docHub) {
          try {
            await fetchDocFresh({ abs, relPath, hub: docHub, cacheState: hubState, fetchImpl: docHub.fetchImpl });
            saveCacheState(hubSource.path, hubState);
          } catch {
            /* a fetch bug must never block this candidate — fall through to whatever is on disk */
          }
        }

        // Low precision -> pointer only, the model Reads the doc if it matters.
        if (precision < 1) {
          if (!existsSync(abs)) continue; // never point at a missing file
          blocks.push(`→ ${display} — related doc (matched: ${matched.join(", ")}); Read it if relevant.`);
          if (dedup) sess.paths[abs] = now;
          recordInjection(cwd, { ts: now, session: sessionId ?? null, keywords: matched, path: display, mode: "link", index, layer });
          continue;
        }

        let body;
        try {
          body = readFileSync(abs, "utf8").slice(0, maxCharsEach);
        } catch {
          continue; // matched an entry whose file is missing / unreadable
        }
        if (!body.trim()) continue;
        blocks.push(`--- ${display} ---\n${body}`);
        if (dedup) sess.paths[abs] = now;
        recordInjection(cwd, { ts: now, session: sessionId ?? null, keywords: matched, path: display, mode: "full", index, layer });
      }

      if (dedup) saveLedger(cwd, led);
      return blocks.length ? { text: blocks.join("\n\n") } : null;
    },
  };
}

export default makeKeywordDocsProvider({ id: "keyword-docs" });
