// keyword-docs context provider (UserPromptSubmit, prio 50) — OPT-IN, default OFF.
//
// Local RAG-lite: match the submitted prompt against a hand-curated index
// (<project>/.claude/context-docs.json, an array of { keywords, path }) and
// inject the matched docs (each clipped to maxCharsEach, at most maxDocs). No
// match -> null, so most turns inject nothing (0 tokens) with zero ledger I/O.
// Deterministic — no vector DB / embeddings. See DESIGN.md §8.
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
// topic on consecutive turns does not re-inject what is already in context. It
// re-injects on a new session or after the TTL (when the doc has likely scrolled
// off). State is per-session in os.tmpdir() (see lib/ledger.mjs), best-effort.
//
// Precision (per index entry, default 1): how confident the keyword→doc
// mapping is, and therefore how much to inject.
//   precision 1 (or omitted) - inject the doc content (clipped slice).
//   precision < 1 (e.g. 0.5) - inject only a one-line LINK ("this doc is
//                              related — Read it if relevant"), ~20 tokens.
// Low-confidence keywords stay useful without paying the full-slice cost on
// every misfire; the model pulls the doc itself only when actually relevant.
//
// Inheritance: makeKeywordDocsProvider({ id, defaultPriority, defaults })
// builds a NAMED INSTANCE of this engine with its own index file and param
// defaults — msg-format / db-schema / domain-docs are such instances (one
// thin file + one registry line each; see DESIGN.md §8). Instances share the
// engine, the dedup ledger (path-keyed), and the stats format. Every instance
// re-reads its index on each turn, so adding a doc to an index file takes
// effect immediately — no reload.
//
// Stats (오탐 프루닝 layer 1, issue #32): every ACTUAL injection appends one
// line {ts, session, keywords(fired), path, mode: "full"|"link", index} to
// ~/.claude/context-stats/ (see lib/stats.mjs). `index` names the index file,
// so per-instance analysis stays possible. Recording only, best-effort;
// dedup-suppressed matches are not recorded (they cost no tokens).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLedger, saveLedger } from "../ledger.mjs";
import { recordInjection } from "../stats.mjs";

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

/** Build a named instance of the keyword-docs engine (see header). */
export function makeKeywordDocsProvider({ id, defaultPriority = 50, defaults = {} }) {
  return {
    id,
    events: ["UserPromptSubmit"],
    defaultPriority,
    async run({ cwd, prompt, sessionId, params }) {
      if (!prompt) return null;
      const p = { ...defaults, ...params }; // config params override instance defaults

      const idxRel = p.index ?? ".claude/context-docs.json";
      let index;
      try {
        index = JSON.parse(readFileSync(join(cwd, idxRel), "utf8"));
      } catch {
        return null; // no / invalid index -> opt-in not configured for this project
      }
      if (!Array.isArray(index)) return null;

      const mode = p.match ?? "word";
      const lower = prompt.toLowerCase();
      const words = new Set(lower.match(TOKEN) ?? []);

      // Matched docs (with the keywords that fired — recorded to stats on
      // injection), in index order, de-duplicated within this turn.
      const candidates = [];
      const seenPath = new Set();
      for (const entry of index) {
        if (!entry || typeof entry.path !== "string" || seenPath.has(entry.path)) continue;
        const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
        const matched = keywords.filter((k) => matcherFor(k, mode)(lower, words));
        if (matched.length === 0) continue;
        seenPath.add(entry.path);
        const precision = Number.isFinite(Number(entry.precision)) ? Number(entry.precision) : 1;
        candidates.push({ path: entry.path, matched, precision });
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
      for (const { path, matched, precision } of candidates) {
        if (blocks.length >= maxDocs) break;
        if (dedup && sess.paths[path] && now - sess.paths[path] < ttlMs) continue; // still fresh in context

        // Low precision -> pointer only, the model Reads the doc if it matters.
        if (precision < 1) {
          if (!existsSync(join(cwd, path))) continue; // never point at a missing file
          blocks.push(`→ ${path} — related doc (matched: ${matched.join(", ")}); Read it if relevant.`);
          if (dedup) sess.paths[path] = now;
          recordInjection(cwd, { ts: now, session: sessionId ?? null, keywords: matched, path, mode: "link", index: idxRel });
          continue;
        }

        let body;
        try {
          body = readFileSync(join(cwd, path), "utf8").slice(0, maxCharsEach);
        } catch {
          continue; // matched an entry whose file is missing / unreadable
        }
        if (!body.trim()) continue;
        blocks.push(`--- ${path} ---\n${body}`);
        if (dedup) sess.paths[path] = now;
        recordInjection(cwd, { ts: now, session: sessionId ?? null, keywords: matched, path, mode: "full", index: idxRel });
      }

      if (dedup) saveLedger(cwd, led);
      return blocks.length ? { text: blocks.join("\n\n") } : null;
    },
  };
}

export default makeKeywordDocsProvider({ id: "keyword-docs" });
