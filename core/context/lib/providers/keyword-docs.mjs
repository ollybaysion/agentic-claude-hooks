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
// Stats (오탐 프루닝 layer 1, issue #32): every ACTUAL injection appends one
// line {ts, session, keywords(fired), path} to ~/.claude/context-stats/ (see
// lib/stats.mjs). Recording only, best-effort; dedup-suppressed matches are
// not recorded (they cost no tokens).

import { readFileSync } from "node:fs";
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

export default {
  id: "keyword-docs",
  events: ["UserPromptSubmit"],
  defaultPriority: 50,
  async run({ cwd, prompt, sessionId, params }) {
    if (!prompt) return null;

    let index;
    try {
      index = JSON.parse(readFileSync(join(cwd, params.index ?? ".claude/context-docs.json"), "utf8"));
    } catch {
      return null; // no / invalid index -> opt-in not configured for this project
    }
    if (!Array.isArray(index)) return null;

    const mode = params.match ?? "word";
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
      candidates.push({ path: entry.path, matched });
    }
    if (candidates.length === 0) return null; // common case: no ledger I/O at all

    // Cross-turn dedup: skip docs already injected in this session within the TTL.
    const dedup = params.dedup !== false;
    const ttlMs = params.dedupTtlMs ?? 15 * 60 * 1000;
    const now = Date.now();
    let led, sess;
    if (dedup) {
      led = loadLedger(cwd);
      const sid = sessionId || "nosession";
      sess = led.sessions[sid] ?? (led.sessions[sid] = { paths: {}, ts: now });
      sess.ts = now;
    }

    const maxDocs = params.maxDocs ?? 2;
    const maxCharsEach = params.maxCharsEach ?? 1200;
    const blocks = [];
    for (const { path, matched } of candidates) {
      if (blocks.length >= maxDocs) break;
      if (dedup && sess.paths[path] && now - sess.paths[path] < ttlMs) continue; // still fresh in context
      let body;
      try {
        body = readFileSync(join(cwd, path), "utf8").slice(0, maxCharsEach);
      } catch {
        continue; // matched an entry whose file is missing / unreadable
      }
      if (!body.trim()) continue;
      blocks.push(`--- ${path} ---\n${body}`);
      if (dedup) sess.paths[path] = now;
      recordInjection(cwd, { ts: now, session: sessionId ?? null, keywords: matched, path });
    }

    if (dedup) saveLedger(cwd, led);
    return blocks.length ? { text: blocks.join("\n\n") } : null;
  },
};
