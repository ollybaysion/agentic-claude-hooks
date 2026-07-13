#!/usr/bin/env node
// Observability collector — receives every Claude Code hook event over HTTP,
// stores it, and (later) streams it live to a dashboard.
//
// This file is built in stages (see docs/agent-dashboard-collector-design.md §10
// for 0-6 and docs/agent-dashboard-analysis-design.md for 7+). Implemented here:
// skeleton + lifecycle (0), non-blocking ingest (1), SQLite WAL storage (2),
// redaction (3), SSE (4), query API + dashboard (5), read-only stats
// aggregation API (7), the tabbed analysis UI (8 — Live | Sessions | Tools
// + fleet strip), and token-usage collection from CC transcripts (10a).
// Auto-start (6) lives in core/obs-lazy-start/.
//
// Invariants held from the start (design §2, §11):
//   • single monotonic seq (ingest seq = future store PK = future SSE id = cursor)
//   • redact ONCE on the post-ack path (same value to writer + broadcaster)
//   • every in-memory buffer is BYTE-bounded with drop-oldest (no count-only caps)
//   • fail-open: process-level guards + explicit EADDRINUSE handling
//   • boundary = loopback bind + Host allowlist + 0600/0700 + umask(0o077)
//
// CLI:  node server.mjs                start the server (default)
//       node server.mjs status         probe /health and print it (never the token)
//       node server.mjs stop           verify ours via /health, then SIGTERM
//       node server.mjs retain         one retention pass (ops/test)
//       node server.mjs ingest-usage   backfill token usage from transcripts

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { dataDir, configFile, pidFile } from "../../lib/obs-paths.mjs";
import { resolveIndexEntries, userDocIndexes, expandTilde } from "../../lib/doc-index.mjs";

const SERVICE = "claude-observability";
const VERSION = "0.20.1"; // 0.5: tokens UI (10b) · 0.5.1: resume≠ended (#51) · 0.6: cost + daily/model views (#53) · 0.7: guard observation (stage 9) · 0.8: cache-write TTL split (#57) · 0.9: cost anatomy + session diagnostics (#56) · 0.9.1: metric help tooltips (#61) · 0.9.2: tooltip copy → Korean · 0.9.3: tooltip UX (fixed-position tips, native copy, ko UI labels) · 0.10: session titles (#66, schema v5) · 0.11: nudge observation (#63, /stats/nudges + Nudges tab) · 0.12: auto-titler (recent sessions titled on a timer → fleet shows summary not raw prompt) · 0.12.1: titler DB isolation (void OBS_DATA_DIR — stop titler prompts leaking as sessions) + shorter idle gate (30s) + VERSION label fix · 0.13: /stats/turns (#73 Turn Inspector stage 1 — turn grouping, session-wide pairing, tool/wait/gap time split, inefficiency flags) · 0.13.1: Turn Inspector UI (#73 stage 2 — drill-down replaced with /stats/turns: time-split stack bar, call timeline + markers, flags filter, auto-turn labels; fetchSession removed) · 0.14: per-turn cost (#73 stage 3 — single-bucket usage attribution emitted→follows→ts, unattributed line, compact badge, null over $0.00; main-chain only) · 0.15: subagent usage (#81, schema v6 — subagents/agent-*.jsonl ingested via per-(session,path) cursors + usage.agent_id; turn cost_subagent_usd; Tokens-tab subagent columns live again) · 0.15.1: reveal truncated text (#86 — fleet chip hover title + full turn prompt rendered on expand) · 0.16: DB query observation (#87 — /stats/db + DB tab; agent-db-plugin DbQuery events, sql verbatim/local-only) · 0.17.0: fleet turn materialization (#82 stage 1 — turns/turn_cursor tables schema v7, buildTurns-backed materializer with settle gating + reconcile-delete + completeness freeze + arrival-time usage watermark + unattributed residual; materialize-turns CLI + in-process auto-materializer + retention pre-trim hook; no aggregate endpoint/UI yet — stages 2-3) · 0.18.0: fleet turns view (#82 stages 2-3 — /stats/fleet-turns aggregate over the materialized table + Fleet Turns dashboard tab: totals/by-flag/by-project/series, efficiency ratios exclude virtual+auto turns) · 0.18.1: Fleet Turns (?) tooltips — explain the view's role + the 8 inefficiency flags (no issue-number/impl jargon) · 0.18.2: rename the Fleet Turns tab → "insight" (label/hash/tooltip-key only; endpoint /stats/fleet-turns + element ids unchanged) · 0.19.0: keyword-docs corpus viewer (#92 — /docs + /docs/content over the user-layer indexes of all keyword-docs instances via shared lib/doc-index.mjs, Docs tab renders full markdown with dbdoc tier highlighting; realpath allowlist + traversal guard) · 0.19.1: exact guard↔orphan correlation (#99 — guards stamp the blocked call's tool_use_id into the GuardDecision payload; buildTurns matches the deny to its Pre by id, falling back to the ±3s time window only for legacy rows without one; guard_denies counts only denies that orphaned a call) · 0.19.2: docs render fix (#101 — markdown tables → <table> with tier-highlighted cells, strip dbdoc/HTML comments so markers stop leaking + merging paragraphs, --- → <hr>, paragraph collector stops at table/hr; follow-up to #92) · 0.19.3: rename docs nav tab label → "keyword-docs" (#103 — matches the section header + tooltip; hash/element-id/endpoint unchanged) · 0.20.0: enrich review folded into keyword-docs (#90 stage 1 — no separate tab: the keyword-docs corpus table IS the review surface, its 추정) column = the pending queue (live file scan via /docs), 추정)>0 docs highlighted + a '추정) 대기' total card, and opening a doc shows each inferred slot + 근거 inline; /stats/schema-docs shrinks to the events-only apply/promote activity log (SchemaDocApply/SchemaDocPromote) shown as a history section under the corpus; enrich-cli emits both on --write (fire-and-forget via obs-client); promote stays a human CLI action, dashboard buttons deferred to stage 2) · 0.20.1: doc table header CSS fix (#110 — the global stats-table th rule (position:sticky;top:41px;uppercase;gray;11px) leaked into keyword-docs tables, floating the header so it overlapped the content below (header + 대표 쿼리 looked broken); .doc-tbl th now overrides position/top/text-transform/color/font-size — CSS-only, renderDoc unchanged)
const STARTED_AT = Date.now();

// ── config (env OBS_* > config.json > default) ──────────────────────────────
function intEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : def; // design §3.2: validate port is int
}

const HOST = process.env.OBS_HOST || "127.0.0.1";
const PORT = intEnv("OBS_PORT", 4090);
const DATA_DIR = dataDir();
const MAX_BODY = intEnv("OBS_MAX_BODY", 5 * 1024 * 1024); // 5 MiB (large Write tool_input)
const BODY_TIMEOUT_MS = 2000; // slow-body cutoff → 408
const REDACT = process.env.OBS_REDACT !== "0"; // default ON
const DURABLE = process.env.OBS_DURABLE === "1"; // store-before-ack (stage 2)
const GRACE_MS = intEnv("OBS_SHUTDOWN_GRACE_MS", 3000);

// retention budget (design §5.4 / §11). Tune to your disk in stage 6.
const MAX_AGE_MS = intEnv("OBS_MAX_AGE_DAYS", 7) * 86_400_000;
const MAX_ROWS = intEnv("OBS_MAX_ROWS", 500_000);
const MAX_DB_BYTES = intEnv("OBS_MAX_DB_MB", 1024) * 1024 * 1024;

// stats idle threshold (analysis design §3): a Pre with no Post older than this
// is an "orphan" (hook deny / user reject / crash — indistinguishable here), and
// a session idle longer than this is no longer "active". Raise it if
// long-running Bash calls (builds) show up as false orphans.
const ACTIVE_MS = intEnv("OBS_ACTIVE_MS", 600_000);

// "mega session" flags (analysis #56): a session with at least this many
// main-chain messages OR this large an average context is a cost hot-spot worth
// compacting. env override here; config.json {mega:{turns,ctx}} wins (loadThresholds).
let MEGA_TURNS = intEnv("OBS_MEGA_TURNS", 300);
let MEGA_CTX = intEnv("OBS_MEGA_CTX", 300_000);

// Turn Inspector (#73): orphan cutoff (a Pre with no Post anywhere in the
// session older than this), permission-wait cap (an overnight permission prompt
// must not devour the time split — live tail reaches 42h), and flag thresholds.
// env here; config.json {turns:{...}} wins (loadThresholds).
let TURN_ORPHAN_MS = intEnv("OBS_TURN_ORPHAN_MS", ACTIVE_MS);
let TURN_WAIT_CAP_MS = intEnv("OBS_TURN_WAIT_CAP_MS", 1_800_000); // 30m
const TURN_FLAG_DEFAULTS = {
  dup: 2,                    // dup-call: same tool+input occurrences
  reread: 3,                 // re-read: overlapping Reads of one file
  retry: 3,                  // retry-loop: same-call error chain length
  storm: 5,                  // search-storm: Grep/Glob batches before the first Read/Edit
  storm_batch_gap_ms: 2000,  // searches starting closer than this collapse into one batch
  longtail_ms: 30_000, longtail_share: 0.5,
  gap_ratio: 2, gap_min_ms: 60_000,
  mega_calls: 30, mega_ms: 600_000,
};
let TURN_FLAGS = { ...TURN_FLAG_DEFAULTS };

// Auth is OFF by default (single-user box trusts loopback — design §8, decision).
// Turn it on by exporting a non-empty OBS_TOKEN, or by putting {token} in
// config.json. An empty OBS_TOKEN explicitly disables auth.
let TOKEN = null;
{
  const envTok = process.env.OBS_TOKEN;
  if (envTok !== undefined) TOKEN = envTok === "" ? null : envTok;
}
let EXPECT = null; // sha256(TOKEN), set after config load

// ── monotonic seq + counters ────────────────────────────────────────────────
let SEQ = 0; // boot seeds from MAX(seq) once the DB exists (stage 2)
const stats = {
  received: 0, accepted: 0, duplicate: 0, rejected: 0,
  flushed: 0, dropped_queue: 0, broadcast: 0, redaction_hits: 0,
  bad_row: 0, spilled: 0,
};

// ── small helpers ─────────────────────────────────────────────────────────-
function json(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...(extra || {}),
  });
  res.end(body);
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest();
}

// Never print rejected/oversized payloads — redaction must not be undone by the
// operational log. Code / message only (design §7).
function logSafe(tag, err) {
  const msg = err?.code || err?.message || (err == null ? "" : String(err));
  process.stderr.write(`[obs] ${tag}${msg ? ": " + msg : ""}\n`);
}

// ── security gates (design §8) ──────────────────────────────────────────────
function hostOk(req) {
  const h = (req.headers.host || "").split(":")[0].toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

function authed(req) {
  if (!EXPECT) return true; // no token → loopback-trust
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  const t = m ? m[1] : req.headers["x-obs-token"] || "";
  if (!t) return false;
  const got = sha256(t);
  return got.length === EXPECT.length && crypto.timingSafeEqual(got, EXPECT);
}

// ── normalize (lenient — design §4.2) ───────────────────────────────────────
const KNOWN_EVENTS = new Set([
  "PreToolUse", "PostToolUse", "UserPromptSubmit", "Notification",
  "Stop", "SubagentStop", "PreCompact", "SessionStart", "SessionEnd",
]);
// Custom observation types (GuardDecision, NudgeFired, NudgeOutcome, DbQuery) are
// intentionally NOT listed above: they store with unknown_event=1 like any other
// non-CC type and are read back by their own /stats/* handlers.
const PROMOTED = ["tool_name", "tool_use_id", "error", "agent_id", "agent_type", "source", "reason"];

function normalize(env, received_at) {
  if (!env || typeof env !== "object" || Array.isArray(env))
    return { error: "body must be a JSON object" };
  const het = env.hook_event_type;
  if (typeof het !== "string" || !het)
    return { error: "hook_event_type (string) required" };
  const rec = {
    id: crypto.randomUUID(),
    source_app: typeof env.source_app === "string" ? env.source_app : "unknown",
    session_id: typeof env.session_id === "string" ? env.session_id : "unknown",
    hook_event_type: het,
    unknown_event: KNOWN_EVENTS.has(het) ? 0 : 1, // keep unknown types, don't drop
    client_ts: Number.isFinite(env.timestamp) ? env.timestamp : null,
    received_at, // server clock decides order, never client_ts
    payload: env.payload ?? null,
  };
  for (const k of PROMOTED) if (env[k] != null) rec[k] = env[k];
  return { rec };
}

// ── in-memory dedup gate (TTL, pre-seq — design §4.2 step 5) ────────────────
const DEDUP_TTL_MS = 30_000, DEDUP_MAX = 5000;
const seen = new Map(); // key -> expiry ms
function dedupHit(key) {
  if (!key) return false;
  const now = Date.now();
  const exp = seen.get(key);
  if (exp && exp > now) return true;
  seen.set(key, now + DEDUP_TTL_MS);
  if (seen.size > DEDUP_MAX) {
    // evict oldest insertions (Map preserves order) until back under the cap
    for (const k of seen.keys()) {
      seen.delete(k);
      if (seen.size <= DEDUP_MAX) break;
    }
  }
  return false;
}

// ── body reader (size-capped, slow-body timeout — design §4.2 step 3) ───────
class BodyError extends Error {
  constructor(code, status, msg) { super(msg); this.code = code; this.status = status; }
}

function readBody(req, cap = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > cap)
      return reject(new BodyError("TOO_LARGE", 413, `declared ${declared} > ${cap}`));
    const chunks = [];
    let size = 0, settled = false;
    const done = (fn, a) => { if (settled) return; settled = true; cleanup(); fn(a); };
    const timer = setTimeout(() => done(reject, new BodyError("TIMEOUT", 408, "slow body")), BODY_TIMEOUT_MS);
    const onData = (c) => {
      size += c.length;
      if (size > cap) return done(reject, new BodyError("TOO_LARGE", 413, `streamed > ${cap}`));
      chunks.push(c);
    };
    const onEnd = () => done(resolve, Buffer.concat(chunks, size));
    // req.destroy() emits 'aborted' with NO argument → e?.message is null-safe
    // (a bare e.message would throw → uncaughtException → process death).
    const onErr = (e) => done(reject, new BodyError("ABORTED", 400, e?.message ?? "aborted"));
    function cleanup() {
      clearTimeout(timer);
      req.off("data", onData); req.off("end", onEnd);
      req.off("error", onErr); req.off("aborted", onErr);
    }
    req.on("data", onData); req.on("end", onEnd);
    req.on("error", onErr); req.on("aborted", onErr);
  });
}

// ── POST /events (hot path — design §4.2) ───────────────────────────────────
async function handleEvents(req, res) {
  try {
    stats.received++;
    if (!hostOk(req)) { stats.rejected++; return json(res, 421, { error: "bad host" }); }
    if (!authed(req)) { stats.rejected++; return json(res, 401, { error: "unauthorized" }); }

    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      stats.rejected++;
      // 413/408 respond first (Connection: close) — never destroy the socket.
      if (e.code === "TOO_LARGE") return json(res, 413, { error: "too large", cap: MAX_BODY }, { Connection: "close" });
      if (e.code === "TIMEOUT") return json(res, 408, { error: "timeout" }, { Connection: "close" });
      return json(res, 400, { error: "bad body", detail: e.message });
    }

    const received_at = Date.now();
    let env;
    try { env = JSON.parse(raw.toString("utf8")); }
    catch { stats.rejected++; return json(res, 400, { error: "malformed json" }); }

    const { rec, error } = normalize(env, received_at);
    if (error) { stats.rejected++; return json(res, 400, { error }); }

    const key = rec.tool_use_id ? `${rec.tool_use_id}|${rec.hook_event_type}` : null;
    if (dedupHit(key)) { stats.duplicate++; return json(res, 200, { status: "duplicate" }); }

    rec.seq = String(++SEQ); // the unique identifier
    const ack = () => json(res, 202, { status: "accepted", seq: rec.seq, id: rec.id }, { "X-Obs-Seq": rec.seq });

    if (DURABLE) {
      // store-before-ack: materialize (redact once) + write synchronously, ack,
      // then stream off the response path.
      const safe = materialize(rec);
      try { storeOne(safe); } catch (e) { logSafe("durable store", e); }
      stats.accepted++;
      ack();
      setImmediate(() => {
        try { broadcast(safe); } catch (e) { logSafe("broadcast", e); }
        try { maybeParseUsage(rec); } catch (e) { logSafe("usage", e); } // stage 10a
      });
    } else {
      // default: ack first, then redact once → writer + broadcaster off-path.
      stats.accepted++;
      ack();
      setImmediate(() => { try { ingestPostAck(rec); } catch (e) { logSafe("post-ack", e); } });
    }
  } catch (e) {
    // async throw bypasses the router's sync try/catch — caught here.
    if (!res.headersSent) try { json(res, 500, { error: "internal" }); } catch {}
    logSafe("handleEvents", e);
  }
}

// redact ONCE; the same value goes to writer and broadcaster (design §2).
function materialize(rec) {
  if (!REDACT) return rec;
  const r = redactDeep(rec.payload);
  stats.redaction_hits += r.hits;
  return { ...rec, payload: r.value };
}

function ingestPostAck(rec) {
  const safe = materialize(rec);
  enqueueWrite(safe); // stage 2 storage
  broadcast(safe); // stage 4 SSE
  try { maybeParseUsage(rec); } catch (e) { logSafe("usage", e); } // stage 10a
}

// ── redaction (design §8) ───────────────────────────────────────────────────
// Two ways in: value SHAPE (token formats) and KEY NAME (mask the whole subtree
// under a sensitive key). Best-effort, not a boundary — the boundary is loopback
// + 0600. The marker keeps the secret's *kind* for cause-tracing. OBS_REDACT=0
// turns it off. Bounded (depth 12, skip >1MB strings) against ReDoS / OOM.
const VALUE_PATTERNS = [
  ["aws_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["gcp_key", /\bAIza[0-9A-Za-z\-_]{35}\b/g],
  ["github_token", /\bgh[oprsu]_[0-9A-Za-z]{36}\b/g],
  ["slack_token", /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g],
  ["ai_key", /\bsk-(?:ant-)?[0-9A-Za-z._\-]{16,}\b/g],
  ["jwt", /\beyJ[0-9A-Za-z_\-]+\.[0-9A-Za-z_\-]+\.[0-9A-Za-z_\-]+\b/g],
  ["bearer", /\bBearer\s+[0-9A-Za-z._\-]+/gi],
  ["pem", /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g],
  ["assignment", /\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Za-z0-9_]*\s*[=:]\s*[^\s"',]+/gi],
];
// Key matched ANYWHERE (not end-anchored) so access_key_id / password_hash /
// client_secret / authorization are caught. A match masks the whole subtree.
const KEY_RE = /(secret|passw(?:or)?d|passphrase|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|credential|bearer|token)/i;
const REDACT_MAX_DEPTH = 12;
const REDACT_MAX_STR = 1024 * 1024;

function redactString(s, h) {
  if (s.length > REDACT_MAX_STR) return s; // skip huge strings (ReDoS/memory)
  let out = s;
  for (const [kind, re] of VALUE_PATTERNS) {
    out = out.replace(re, () => { h.n++; return `[redacted ${kind}]`; });
  }
  return out;
}

function redactValue(v, depth, h) {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return redactString(v, h);
  if (typeof v !== "object" || depth >= REDACT_MAX_DEPTH) return v;
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1, h));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (KEY_RE.test(k)) { out[k] = "[redacted by key]"; h.n++; } // mask whole subtree
    else out[k] = redactValue(val, depth + 1, h);
  }
  return out;
}

// Returns a NEW value (original untouched) + a hit count surfaced via /health.
function redactDeep(payload) {
  const h = { n: 0 };
  return { value: redactValue(payload, 0, h), hits: h.n };
}

// ── SQLite backend (design §5) ──────────────────────────────────────────────
// node:sqlite (builtin, experimental on Node 24) with a better-sqlite3 fallback.
// Lazy dynamic import so the CLI (status/stop) never needs a sqlite backend.
let db = null; // adapter or null (degraded counter-only mode)
let insertStmt = null;

const SCHEMA_COLUMNS = [
  "seq", "id", "source_app", "session_id", "hook_event_type",
  "tool_name", "tool_use_id", "agent_id", "agent_type",
  "source", "reason", "error", "unknown_event", "client_ts", "received_at", "payload",
];

async function openBackend(dbPath) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return { kind: "node:sqlite", impl: new DatabaseSync(dbPath) };
  } catch (e1) {
    try {
      const { default: Database } = await import("better-sqlite3");
      return { kind: "better-sqlite3", impl: new Database(dbPath) };
    } catch (e2) {
      throw new Error(`no sqlite backend (node:sqlite: ${e1.message}; better-sqlite3: ${e2.message})`);
    }
  }
}

function pragmaScalar(impl, sql) {
  const row = impl.prepare(sql).get();
  return row ? Number(Object.values(row)[0]) : null;
}

function initSchema(impl) {
  const exists = impl.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
  const prevVersion = Number(pragmaScalar(impl, "PRAGMA user_version")) || 0; // read BEFORE overwrite (migration gate)
  impl.exec("PRAGMA journal_mode = WAL;");
  impl.exec(`PRAGMA synchronous = ${DURABLE ? "FULL" : "NORMAL"};`);
  impl.exec("PRAGMA busy_timeout = 5000;");
  if (!exists) {
    impl.exec("PRAGMA auto_vacuum = INCREMENTAL;"); // only honoured on a fresh DB
  } else if (pragmaScalar(impl, "PRAGMA auto_vacuum") === 0) {
    impl.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    impl.exec("VACUUM;"); // one-time migration of an existing non-incremental DB
  }
  impl.exec("PRAGMA user_version = 7;"); // v2 = + v_tool_calls view · v3 = + usage/transcript_cursor (10a) · v4 = + usage.cache_create_1h (#57) · v5 = + session_titles (#66) · v6 = + usage.agent_id + cursor PK (session,path) (#81 subagent usage) · v7 = + turns/turn_cursor + usage.inserted_at (#82 fleet turn materialization)
  impl.exec(`CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY, id TEXT NOT NULL,
    source_app TEXT NOT NULL, session_id TEXT NOT NULL, hook_event_type TEXT NOT NULL,
    tool_name TEXT, tool_use_id TEXT, agent_id TEXT, agent_type TEXT,
    source TEXT, reason TEXT, error TEXT,
    unknown_event INTEGER NOT NULL DEFAULT 0,
    client_ts INTEGER, received_at INTEGER NOT NULL, payload TEXT NOT NULL)`);
  impl.exec("CREATE INDEX IF NOT EXISTS idx_session   ON events(session_id, seq)");
  impl.exec("CREATE INDEX IF NOT EXISTS idx_type_time ON events(hook_event_type, received_at)");
  impl.exec("CREATE INDEX IF NOT EXISTS idx_app_time  ON events(source_app, received_at)");
  impl.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dedup ON events(tool_use_id, hook_event_type)
    WHERE tool_use_id IS NOT NULL`);
  // One Pre/Post pair per row, for /stats/tools. A view costs no storage;
  // idx_dedup (partial unique) serves the post-side lookup, idx_type_time the
  // pre-side scan. ended_at IS NULL = still running / denied / crashed.
  impl.exec(`CREATE VIEW IF NOT EXISTS v_tool_calls AS
    SELECT
      pre.tool_use_id                    AS tool_use_id,
      pre.session_id                     AS session_id,
      pre.source_app                     AS source_app,
      pre.tool_name                      AS tool_name,
      pre.received_at                    AS started_at,
      post.received_at                   AS ended_at,
      post.received_at - pre.received_at AS duration_ms,
      post.error                         AS error
    FROM events pre
    LEFT JOIN events post
      ON post.tool_use_id = pre.tool_use_id AND post.hook_event_type = 'PostToolUse'
    WHERE pre.hook_event_type = 'PreToolUse' AND pre.tool_use_id IS NOT NULL`);
  // stage 10a: token usage parsed from CC transcripts — ONE row per API message
  // (message.id; CC writes one transcript line per content block and duplicates
  // usage on each, so per-line summing would double-count). Numbers/ids/model
  // only, never transcript content. emitted/follows carry the tool-attribution
  // id lists (analysis design / issue #38 comment).
  impl.exec(`CREATE TABLE IF NOT EXISTS usage (
    session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
    source_app TEXT NOT NULL, ts INTEGER NOT NULL, model TEXT,
    input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
    cache_create INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
    cache_create_1h INTEGER NOT NULL DEFAULT 0,
    sidechain INTEGER NOT NULL DEFAULT 0,
    agent_id TEXT,
    inserted_at INTEGER,
    emitted_tool_ids TEXT NOT NULL DEFAULT '[]',
    follows_tool_ids TEXT NOT NULL DEFAULT '[]',
    UNIQUE(session_id, msg_id))`);
  // v3→v4 (#57): cache_write TTL split. `cache_create` stays the TOTAL; the new
  // `cache_create_1h` is the 1h-TTL subset (5m = total − 1h). An existing table
  // predates the column — CREATE IF NOT EXISTS won't add it, so ALTER once. The
  // subset defaults 0, so untouched old rows bill as all-5m (prior behaviour)
  // until `ingest-usage --rescan` backfills the real split.
  if (exists && prevVersion < 4) {
    try { impl.exec("ALTER TABLE usage ADD COLUMN cache_create_1h INTEGER NOT NULL DEFAULT 0"); }
    catch (e) { logSafe("migrate v4", e); } // already present → ignore
  }
  // v5→v6 (#81): subagent usage. CC writes each subagent conversation to its own
  // <dir>/<sessionId>/subagents/agent-<id>.jsonl, so a session tracks MANY
  // transcript files — the cursor key grows to (session_id, path) via a table
  // rebuild (SQLite can't alter a PK), and usage rows learn which agent spent
  // the tokens. Old rows keep agent_id NULL (main chain).
  if (exists && prevVersion < 6) {
    try { impl.exec("ALTER TABLE usage ADD COLUMN agent_id TEXT"); }
    catch (e) { logSafe("migrate v6 usage", e); } // already present → ignore
    try {
      impl.exec(`CREATE TABLE IF NOT EXISTS transcript_cursor_v6 (
        session_id TEXT NOT NULL, path TEXT NOT NULL,
        offset INTEGER NOT NULL DEFAULT 0,
        last_emitted TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, path));
        INSERT OR IGNORE INTO transcript_cursor_v6
          SELECT session_id, path, offset, last_emitted, updated_at FROM transcript_cursor;
        DROP TABLE transcript_cursor;
        ALTER TABLE transcript_cursor_v6 RENAME TO transcript_cursor;`);
    } catch (e) { logSafe("migrate v6 cursor", e); } // fresh DB / already rebuilt
  }
  // v6→v7 (#82): fleet turn materialization. `usage.inserted_at` is the ARRIVAL
  // time (Date.now() at insert/update) — the watermark the materializer polls, so
  // late usage whose transcript `ts` is OLD (subagent tails) or a `--rescan` that
  // rewrites cost without moving `ts` still triggers a re-materialization.
  if (exists && prevVersion < 7) {
    try { impl.exec("ALTER TABLE usage ADD COLUMN inserted_at INTEGER"); }
    catch (e) { logSafe("migrate v7 usage", e); } // already present → ignore
  }
  impl.exec("CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts)");
  impl.exec("CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id, ts)");
  impl.exec(`CREATE TABLE IF NOT EXISTS transcript_cursor (
    session_id TEXT NOT NULL, path TEXT NOT NULL,
    offset INTEGER NOT NULL DEFAULT 0,
    last_emitted TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, path))`);
  // #66: human-readable session titles, generated offline by the `title-sessions`
  // batch (a cheap LLM summary of the session's user prompts). Separate table so
  // titling never touches the ingest hot path; prompt_count records how many
  // prompts the title was built from, so the batch can re-title only when a
  // session has grown.
  impl.exec(`CREATE TABLE IF NOT EXISTS session_titles (
    session_id TEXT PRIMARY KEY, title TEXT NOT NULL,
    prompt_count INTEGER NOT NULL DEFAULT 0, generated_at INTEGER NOT NULL)`);
  // #82: materialized SETTLED turns — one summary row per turn, computed ONCE by
  // running the same buildTurns/attachTurnCosts as the drill-down and persisting
  // the output. Fleet aggregates read this (cheap SQL) and it OUTLIVES `events`
  // (retention never trims this table). Never holds the open/last turn (§3 settle
  // rule); `subagent_ms` is deliberately absent (post-stop tail time keeps growing).
  impl.exec(`CREATE TABLE IF NOT EXISTS turns (
    session_id TEXT NOT NULL, turn_seq INTEGER NOT NULL,
    source_app TEXT NOT NULL, n INTEGER NOT NULL,
    status TEXT NOT NULL, auto TEXT,
    started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
    tool_ms INTEGER NOT NULL, wait_ms INTEGER NOT NULL, gap_ms INTEGER NOT NULL,
    calls INTEGER NOT NULL, subagent_calls INTEGER NOT NULL, distinct_tools INTEGER NOT NULL,
    errors INTEGER NOT NULL, orphans INTEGER NOT NULL, dup_calls INTEGER NOT NULL,
    guard_denies INTEGER NOT NULL, queued_prompts INTEGER NOT NULL, precompacts INTEGER NOT NULL,
    cost_usd REAL, cost_subagent_usd REAL, cost_has_gap INTEGER NOT NULL DEFAULT 0,
    flags TEXT NOT NULL DEFAULT '[]', flags_mask INTEGER NOT NULL DEFAULT 0,
    config_ver INTEGER NOT NULL, materialized_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, turn_seq))`);
  impl.exec("CREATE INDEX IF NOT EXISTS idx_turns_app_time ON turns(source_app, started_at)");
  impl.exec("CREATE INDEX IF NOT EXISTS idx_turns_time ON turns(started_at)");
  // Per-session materialization watermark + completeness anchor. `frozen`=1 means
  // early events were trimmed (current MIN(seq) rose above the anchor) → the
  // session can no longer be re-derived correctly, so we FREEZE it: keep the good
  // historical rows, never re-run buildTurns over the truncated stream.
  impl.exec(`CREATE TABLE IF NOT EXISTS turn_cursor (
    session_id TEXT PRIMARY KEY,
    materialized_through_seq INTEGER NOT NULL DEFAULT 0,
    min_event_seq_seen INTEGER NOT NULL DEFAULT 0,
    usage_epoch_seen INTEGER NOT NULL DEFAULT 0,
    last_turn_seq INTEGER NOT NULL DEFAULT 0,
    unattributed_cost_usd REAL,
    config_ver INTEGER NOT NULL DEFAULT 0,
    session_ended INTEGER NOT NULL DEFAULT 0,
    frozen INTEGER NOT NULL DEFAULT 0,
    stale_config INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL)`);
}

function toRow(r) {
  return [
    Number(r.seq), r.id, r.source_app, r.session_id, r.hook_event_type,
    r.tool_name ?? null, r.tool_use_id ?? null, r.agent_id ?? null, r.agent_type ?? null,
    r.source ?? null, r.reason ?? null, r.error ?? null,
    r.unknown_event ?? 0, r.client_ts ?? null, r.received_at,
    JSON.stringify(r.payload ?? null),
  ];
}

// Open + migrate + seed SEQ. On total failure, run degraded (db stays null).
async function startBackend() {
  const dbPath = path.join(DATA_DIR, "events.db");
  try {
    const be = await openBackend(dbPath);
    initSchema(be.impl);
    const placeholders = SCHEMA_COLUMNS.map(() => "?").join(",");
    insertStmt = be.impl.prepare(
      `INSERT OR IGNORE INTO events (${SCHEMA_COLUMNS.join(",")}) VALUES (${placeholders})`
    );
    const row = be.impl.prepare("SELECT MAX(seq) m FROM events").get();
    if (row && row.m != null) SEQ = Number(row.m); // boot seed: seq stays monotonic
    db = be;
  } catch (e) {
    logSafe("backend", e); // degraded: ingest still acks, rows are dropped
  }
}

// Single synchronous insert (durable path).
function storeOne(safe) {
  if (!db || !insertStmt) return;
  try { insertStmt.run(...toRow(safe)); stats.flushed++; }
  catch (e) { stats.bad_row++; logSafe("store row", e); }
}

// fail-open spill: gzip the batch and append to spill.jsonl.gz (rotated).
const SPILL_MAX_BYTES = 64 * 1024 * 1024;
function spill(batch, err) {
  stats.spilled += batch.length;
  logSafe("spill", err);
  try {
    const text = batch.map((x) => JSON.stringify(x.rec)).join("\n") + "\n";
    const p = path.join(DATA_DIR, "spill.jsonl.gz");
    try { if (fs.statSync(p).size > SPILL_MAX_BYTES) fs.renameSync(p, p + ".1"); } catch {}
    fs.appendFileSync(p, zlib.gzipSync(text), { mode: 0o600 });
  } catch (e) { logSafe("spill write", e); }
}

// ── retention (paged archive+delete; freelist-aware size cap — design §5.4) ──
function usedBytes() {
  return (pragmaScalar(db.impl, "PRAGMA page_count") - pragmaScalar(db.impl, "PRAGMA freelist_count")) *
    pragmaScalar(db.impl, "PRAGMA page_size");
}

function appendArchive(text) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(DATA_DIR, "archive");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, `events-${day}.jsonl.gz`), zlib.gzipSync(text), { mode: 0o600 });
}

// Page through matches (LIMIT N) → archive slice → DELETE slice. Never SELECT
// the whole set at once (a giant join string would RangeError / OOM).
function archiveAndDeletePaged(whereSql, params) {
  const PAGE = 1000;
  for (;;) {
    const rows = db.impl.prepare(
      `SELECT * FROM events WHERE ${whereSql} ORDER BY seq LIMIT ${PAGE}`
    ).all(...params);
    if (!rows.length) break;
    appendArchive(rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const seqs = rows.map((r) => r.seq);
    db.impl.prepare(`DELETE FROM events WHERE seq IN (${seqs.map(() => "?").join(",")})`).run(...seqs);
    if (rows.length < PAGE) break;
  }
}

function runRetention() {
  // Whole thing in try/catch — a throw escaping setInterval would kill the process.
  try {
    if (!db) return;
    flush();
    // §7: capture settled turns BEFORE their events are trimmed. Retention evicts
    // by rows/size (no age floor), so a burst can drop recent events fast — the
    // materialized rows must already exist by then, or fleet history has a hole.
    try { materializeSweep(Date.now(), 100_000); } catch (e) { logSafe("retention materialize", e); }
    archiveAndDeletePaged("received_at < ?", [Date.now() - MAX_AGE_MS]); // by age
    archiveAndDeletePaged("seq <= (SELECT MAX(seq) - ? FROM events)", [MAX_ROWS]); // by rows
    // size cap: page_count only shrinks after incremental_vacuum returns pages
    // (DELETE alone just moves them to the freelist). Measure used pages, drop a
    // slice, vacuum, re-measure — inside the loop.
    let guard = 50;
    while (usedBytes() > MAX_DB_BYTES && guard-- > 0) {
      const lo = pragmaScalar(db.impl, "SELECT MIN(seq) m FROM events");
      const hi = pragmaScalar(db.impl, "SELECT MAX(seq) m FROM events");
      if (lo == null || hi == null || hi <= lo) break;
      archiveAndDeletePaged("seq <= ?", [lo + Math.max(1, Math.floor((hi - lo) * 0.05))]);
      db.impl.exec("PRAGMA incremental_vacuum;");
    }
    db.impl.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (e) { logSafe("retention", e); }
}

// ── write queue (BYTE-bounded, drop-oldest — design §5.3) ───────────────────
const Q_MAX_BYTES = 64 * 1024 * 1024;
const BATCH_ROWS = 256;
const q = [];
let qBytes = 0, qTimer = null;

function enqueueWrite(rec) {
  const size = JSON.stringify(rec).length;
  q.push({ rec, size });
  qBytes += size;
  while (qBytes > Q_MAX_BYTES && q.length) {
    qBytes -= q.shift().size;
    stats.dropped_queue++;
  }
  if (q.length >= BATCH_ROWS) flush();
  else if (!qTimer) qTimer = setTimeout(flush, 50).unref();
}

function flush() {
  if (qTimer) { clearTimeout(qTimer); qTimer = null; }
  if (!q.length) return;
  const batch = q.splice(0, BATCH_ROWS); // bounded slice, not the whole queue
  for (const x of batch) qBytes -= x.size;
  if (!db || !insertStmt) {
    stats.dropped_queue += batch.length; // degraded: no backend, drop
  } else {
    try {
      db.impl.exec("BEGIN IMMEDIATE");
      for (const x of batch) {
        // row-level try: one poison row must not roll back the other 255.
        try { insertStmt.run(...toRow(x.rec)); stats.flushed++; }
        catch (e) { stats.bad_row++; logSafe("bad row", e); }
      }
      db.impl.exec("COMMIT");
    } catch (e) {
      try { db.impl.exec("ROLLBACK"); } catch {}
      spill(batch, e); // fail-open: DB down → don't die, don't lose
    }
  }
  if (q.length && !qTimer) qTimer = setTimeout(flush, 50).unref();
}

// ── live streaming (SSE pub/sub — design §6) ────────────────────────────────
// One direction (server → dashboard/curl), so SSE beats WebSocket: free auto
// reconnect + Last-Event-ID, `curl -N` tailing, same loopback+bearer guard.
const RING_MAX_BYTES = 64 * 1024 * 1024; // replay buffer, BYTE-bounded (not slot count)
const STREAM_EVENT_MAX = 64 * 1024; // per-event cap: stream truncated, full stays in DB
const SUB_MAX_ITEMS = 2000;
const SUB_MAX_BYTES = 8 * 1024 * 1024;
const HEARTBEAT_MS = 20_000;

const ring = []; // [{ seq:Number, frame:String, bytes:Number }]
let ringBytes = 0;
const subscribers = new Set();

const sseSafe = (s) => String(s).replace(/[\r\n]/g, " "); // event: name can't span lines

function streamFrame(rec) {
  const meta = {
    seq: rec.seq, hook_event_type: rec.hook_event_type, source_app: rec.source_app,
    session_id: rec.session_id, tool_name: rec.tool_name ?? null, received_at: rec.received_at,
  };
  let data = JSON.stringify({ ...meta, payload: rec.payload });
  if (data.length > STREAM_EVENT_MAX) data = JSON.stringify({ ...meta, payload: "[truncated]", _truncated: true });
  // id: only on real data events (so control frames don't move Last-Event-ID).
  return `id: ${rec.seq}\nevent: ${sseSafe(rec.hook_event_type)}\ndata: ${data}\n\n`;
}

function ringPush(rec, frame) {
  const bytes = Buffer.byteLength(frame);
  // keep the match fields so replay can honour a subscriber's filter
  ring.push({
    seq: Number(rec.seq), frame, bytes,
    source_app: rec.source_app, session_id: rec.session_id, hook_event_type: rec.hook_event_type,
  });
  ringBytes += bytes;
  while (ringBytes > RING_MAX_BYTES && ring.length) ringBytes -= ring.shift().bytes;
}

class Subscriber { // one SSE connection = one bounded outbound queue
  constructor(res, filter) {
    this.res = res; this.filter = filter;
    this.queue = []; this.bytes = 0; this.dropped = 0;
    this.writing = false; this.closed = false;
  }
  matches(rec) {
    const f = this.filter;
    if (f.source_app && rec.source_app !== f.source_app) return false;
    if (f.session_id && rec.session_id !== f.session_id) return false;
    if (f.hook_event_type && rec.hook_event_type !== f.hook_event_type) return false;
    return true;
  }
  enqueue(chunk) {
    if (this.closed) return;
    this.queue.push(chunk); this.bytes += chunk.length;
    while (this.queue.length > SUB_MAX_ITEMS || this.bytes > SUB_MAX_BYTES) { // drop-oldest
      this.bytes -= this.queue.shift().length; this.dropped++;
    }
    this._pump();
  }
  _pump() {
    if (this.writing || this.closed) return;
    this.writing = true;
    if (this.dropped > 0) {
      const c = `event: _dropped\ndata: {"dropped":${this.dropped}}\n\n`; // no id:
      this.dropped = 0; this.queue.unshift(c); this.bytes += c.length;
    }
    while (this.queue.length) {
      const c = this.queue.shift(); this.bytes -= c.length;
      let ok;
      try { ok = this.res.write(c); } catch { return this.close(); } // dead socket → close, don't starve others
      if (!ok) { this.res.once("drain", () => { this.writing = false; this._pump(); }); return; } // backpressure
    }
    this.writing = false;
  }
  close() {
    if (this.closed) return;
    this.closed = true; subscribers.delete(this);
    try { this.res.end(); } catch {}
  }
}

function broadcast(rec) {
  stats.broadcast++;
  const frame = streamFrame(rec);
  ringPush(rec, frame);
  for (const sub of subscribers) {
    try { if (sub.matches(rec)) sub.enqueue(frame); } catch (e) { logSafe("broadcast sub", e); }
  }
}

function handleStream(req, res) {
  if (!hostOk(req)) return json(res, 421, { error: "bad host" }); // same guards as ingest
  if (!authed(req)) return json(res, 401, { error: "unauthorized" });
  const u = new URL(req.url, "http://localhost");
  const filter = {
    source_app: u.searchParams.get("source_app") || null,
    session_id: u.searchParams.get("session_id") || null,
    hook_event_type: u.searchParams.get("hook_event_type") || null,
  };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const sub = new Subscriber(res, filter);
  subscribers.add(sub);

  // resume only when a cursor was actually given (Number(null)===0 would
  // otherwise replay the whole ring on every fresh, live-only connection).
  // Clamp to the current seq so a forged / too-large cursor can't wedge
  // "never receive anything".
  const cursor = req.headers["last-event-id"] ?? u.searchParams.get("since");
  if (cursor != null && cursor !== "" && Number.isFinite(Number(cursor))) {
    const from = Math.min(Number(cursor), SEQ);
    if (ring.length && from < ring[0].seq - 1) {
      sub.enqueue(`event: _gap\ndata: {"from":${from},"oldest":${ring[0].seq}}\n\n`); // missed events evicted
    }
    // replay respects the subscriber's filter (broadcast does; replay must too).
    for (const item of ring) if (item.seq > from && sub.matches(item)) sub.enqueue(item.frame);
  }
  sub.enqueue(`event: _ready\ndata: {"seq":${SEQ}}\n\n`); // no id:
  req.on("close", () => sub.close());
}

let heartbeatTimer = null;
function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    for (const sub of subscribers) {
      try { sub.res.write(": keepalive\n\n"); } catch { sub.close(); } // half-open socket → close
    }
  }, HEARTBEAT_MS).unref();
}

function closeAllSubscribers() {
  for (const sub of subscribers) {
    sub.closed = true;
    // end() flushes the farewell; destroy() would drop the buffered _bye.
    try { sub.res.end("event: _bye\ndata: {}\n\n"); } catch {}
  }
  subscribers.clear();
}

// ── GET /health ─────────────────────────────────────────────────────────────
function dbRowCount() {
  if (!db) return null;
  try { return pragmaScalar(db.impl, "SELECT COUNT(*) c FROM events"); } catch { return null; }
}

function handleHealth(req, res) {
  json(res, 200, {
    status: "ok",
    service: SERVICE,
    version: VERSION,
    pid: process.pid,
    host: HOST,
    port: PORT,
    uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
    seq: SEQ,
    sse: subscribers.size,
    durable: DURABLE,
    redact: REDACT,
    backend: db ? db.kind : null,
    rows: dbRowCount(),
    counters: { ...stats },
  });
}

// ── query API (keyset — design §4) ──────────────────────────────────────────
function rowToEvent(r) {
  let payload = r.payload;
  try { payload = JSON.parse(r.payload); } catch {}
  return { ...r, payload };
}

function handleEventsQuery(req, res, u) {
  if (!hostOk(req)) return json(res, 421, { error: "bad host" });
  if (!authed(req)) return json(res, 401, { error: "unauthorized" });
  if (!db) return json(res, 200, { count: 0, events: [], next_cursor: null });
  const order = u.searchParams.get("order") === "asc" ? "ASC" : "DESC";
  let limit = Math.trunc(Number(u.searchParams.get("limit"))) || 200;
  limit = Math.min(Math.max(1, limit), 1000);
  const filters = [], params = [];
  const since = u.searchParams.get("since");
  if (since != null && since !== "" && Number.isFinite(Number(since))) {
    filters.push(order === "ASC" ? "seq > ?" : "seq < ?"); // keyset cursor
    params.push(Number(since));
  }
  for (const k of ["source_app", "session_id", "hook_event_type"]) {
    const v = u.searchParams.get(k);
    if (v) { filters.push(`${k} = ?`); params.push(v); }
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  let rows;
  try {
    rows = db.impl.prepare(`SELECT * FROM events ${where} ORDER BY seq ${order} LIMIT ?`).all(...params, limit);
  } catch (e) { logSafe("query", e); return json(res, 500, { error: "query failed" }); }
  json(res, 200, {
    count: rows.length,
    events: rows.map(rowToEvent),
    next_cursor: rows.length ? rows[rows.length - 1].seq : null,
  });
}

function handleEventById(req, res, idStr) {
  if (!hostOk(req)) return json(res, 421, { error: "bad host" });
  if (!authed(req)) return json(res, 401, { error: "unauthorized" });
  if (!db) return json(res, 404, { error: "not found" });
  let row;
  try {
    row = /^\d+$/.test(idStr)
      ? db.impl.prepare("SELECT * FROM events WHERE seq = ?").get(Number(idStr))
      : db.impl.prepare("SELECT * FROM events WHERE id = ?").get(idStr);
  } catch (e) { logSafe("query id", e); return json(res, 500, { error: "query failed" }); }
  if (!row) return json(res, 404, { error: "not found" });
  json(res, 200, rowToEvent(row));
}

// ── stats API (read-only aggregates — analysis design §4) ───────────────────
// Same gates as the query API; degraded (db=null) answers empty-but-200.
// Aggregates avoid the payload column (the widest one) except four bounded
// cases: /stats/guards and /stats/nudges (rare custom rows), /stats/sessions'
// first_prompt (one row per session), and /stats/turns (one session per
// request). The hot path (POST /events) is untouched by this whole section.
const WINDOW_MS = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };

function statsGate(req, res) {
  if (!hostOk(req)) { json(res, 421, { error: "bad host" }); return false; }
  if (!authed(req)) { json(res, 401, { error: "unauthorized" }); return false; }
  return true;
}

// window=1h|6h|24h|7d — whitelist only (no free-form parsing), else the default.
function windowOf(u, def) {
  return WINDOW_MS[u.searchParams.get("window")] ?? WINDOW_MS[def];
}

// p-th percentile of an ASC-sorted array (nearest-rank; null on empty).
function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function handleStatsOverview(req, res, u) {
  if (!statsGate(req, res)) return;
  const window_ms = windowOf(u, "24h");
  const bucket_ms = window_ms <= WINDOW_MS["1h"] ? 60_000 : 3_600_000;
  if (!db) return json(res, 200, { window_ms, bucket_ms, events: 0, errors: 0, sessions: 0, sessions_active: 0, by_event_type: {}, buckets: [] });
  const now = Date.now(), since = now - window_ms;
  try {
    const by_event_type = {};
    let events = 0;
    for (const r of db.impl.prepare(
      "SELECT hook_event_type t, COUNT(*) c FROM events WHERE received_at >= ? GROUP BY hook_event_type"
    ).all(since)) { by_event_type[r.t] = Number(r.c); events += Number(r.c); }
    const errors = Number(db.impl.prepare(
      "SELECT COUNT(*) c FROM events WHERE received_at >= ? AND hook_event_type = 'PostToolUse' AND error IS NOT NULL"
    ).get(since).c);
    // ended only when SessionEnd is the latest event — resumed sessions return to active
    const sess = db.impl.prepare(
      "SELECT MAX(received_at) last_at, MAX(CASE WHEN hook_event_type = 'SessionEnd' THEN received_at END) last_end FROM events WHERE received_at >= ? GROUP BY session_id"
    ).all(since);
    const sessions_active = sess.filter((s) =>
      !(s.last_end != null && Number(s.last_end) >= Number(s.last_at)) && Number(s.last_at) >= now - ACTIVE_MS
    ).length;
    // bucket_ms is INLINED, not bound: node:sqlite binds JS numbers as REAL, so
    // a bound `received_at / ?` becomes float division and never buckets.
    // Safe to template — bucket_ms only comes from the two-value whitelist above.
    const buckets = db.impl.prepare(
      `SELECT (received_at / ${bucket_ms}) * ${bucket_ms} t, COUNT(*) count,
              SUM(hook_event_type = 'PostToolUse' AND error IS NOT NULL) errors
       FROM events WHERE received_at >= ? GROUP BY t ORDER BY t`
    ).all(since).map((b) => ({ t: Number(b.t), count: Number(b.count), errors: Number(b.errors) }));
    json(res, 200, { window_ms, bucket_ms, events, errors, sessions: sess.length, sessions_active, by_event_type, buckets });
  } catch (e) { logSafe("stats overview", e); json(res, 500, { error: "query failed" }); }
}

function handleStatsSessions(req, res, u) {
  if (!statsGate(req, res)) return;
  const window_ms = windowOf(u, "7d");
  if (!db) return json(res, 200, { window_ms, count: 0, sessions: [] });
  const now = Date.now(), since = now - window_ms;
  let limit = Math.trunc(Number(u.searchParams.get("limit"))) || 50;
  limit = Math.min(Math.max(1, limit), 200);
  const app = u.searchParams.get("source_app");
  const where = app ? "received_at >= ? AND source_app = ?" : "received_at >= ?";
  const params = app ? [since, app] : [since];
  try {
    // boolean SUM = 0/1 rollup (analysis design §3.2)
    const sessions = db.impl.prepare(
      `SELECT session_id, source_app,
         MIN(received_at)                                         started_at,
         MAX(received_at)                                         last_at,
         SUM(hook_event_type = 'UserPromptSubmit')                turns,
         SUM(hook_event_type = 'PreToolUse')                      tool_calls,
         SUM(hook_event_type = 'PostToolUse' AND error IS NOT NULL) errors,
         SUM(hook_event_type = 'PreCompact')                      precompacts,
         SUM(hook_event_type = 'SubagentStop')                    subagents,
         MAX(CASE WHEN hook_event_type = 'SessionEnd' THEN received_at END) last_end,
         (SELECT st.title FROM session_titles st WHERE st.session_id = events.session_id) title,
         (SELECT json_extract(e2.payload, '$.prompt') FROM events e2
            WHERE e2.session_id = events.session_id AND e2.hook_event_type = 'UserPromptSubmit'
            ORDER BY e2.seq ASC LIMIT 1)                          first_prompt
       FROM events WHERE ${where}
       GROUP BY session_id ORDER BY last_at DESC LIMIT ?`
    ).all(...params, limit).map((r) => {
      // ended only when SessionEnd is the latest event — resumed sessions return to active
      const ended = r.last_end != null && Number(r.last_end) >= Number(r.last_at);
      return {
        session_id: r.session_id, source_app: r.source_app,
        started_at: Number(r.started_at), last_at: Number(r.last_at),
        duration_ms: Number(r.last_at) - Number(r.started_at),
        turns: Number(r.turns), tool_calls: Number(r.tool_calls), errors: Number(r.errors),
        precompacts: Number(r.precompacts), subagents: Number(r.subagents),
        ended,
        active: !ended && Number(r.last_at) >= now - ACTIVE_MS,
        title: r.title ? String(r.title) : null,
        first_prompt: r.first_prompt ? String(r.first_prompt).replace(/\s+/g, " ").trim().slice(0, 120) : null,
      };
    });
    json(res, 200, { window_ms, count: sessions.length, sessions });
  } catch (e) { logSafe("stats sessions", e); json(res, 500, { error: "query failed" }); }
}

function handleStatsTools(req, res, u) {
  if (!statsGate(req, res)) return;
  const window_ms = windowOf(u, "24h");
  if (!db) return json(res, 200, { window_ms, count: 0, tools: [] });
  const now = Date.now(), since = now - window_ms;
  const app = u.searchParams.get("source_app");
  const where = app ? "started_at >= ? AND source_app = ?" : "started_at >= ?";
  const params = app ? [since, app] : [since];
  try {
    // percentiles in JS — SQLite has none built in; the window keeps this bounded.
    const byTool = new Map();
    for (const r of db.impl.prepare(
      `SELECT tool_name, duration_ms, error, ended_at, started_at FROM v_tool_calls WHERE ${where}`
    ).all(...params)) {
      const name = r.tool_name || "unknown";
      let t = byTool.get(name);
      if (!t) byTool.set(name, (t = { tool_name: name, calls: 0, errors: 0, orphans: 0, pending: 0, durations: [] }));
      t.calls++;
      if (r.error != null) t.errors++;
      if (r.ended_at == null) {
        // no Post yet: recent = pending (still running), old = orphan
        if (Number(r.started_at) < now - ACTIVE_MS) t.orphans++;
        else t.pending++;
      } else t.durations.push(Number(r.duration_ms));
    }
    const tools = [...byTool.values()].map((t) => {
      const d = t.durations.sort((a, b) => a - b);
      return {
        tool_name: t.tool_name, calls: t.calls, errors: t.errors,
        orphans: t.orphans, pending: t.pending,
        p50_ms: pct(d, 0.5), p95_ms: pct(d, 0.95), max_ms: d.length ? d[d.length - 1] : null,
      };
    }).sort((a, b) => b.calls - a.calls);
    json(res, 200, { window_ms, count: tools.length, tools });
  } catch (e) { logSafe("stats tools", e); json(res, 500, { error: "query failed" }); }
}

// ── token usage (transcript tail parser — stage 10a, issue #38; subagents #81) ─
// CC transcripts are append-only JSONL and every hook payload carries
// transcript_path. On Stop/SubagentStop/SessionEnd we parse that session's MAIN
// file plus its subagent files (<dir>/<sessionId>/subagents/agent-*.jsonl —
// CC keeps each Task/Agent conversation separate) from per-(session,path) byte
// bookmarks, off the response path. Rules: read-only, per-line fail-open,
// sidechain rows kept and flagged (subagent files carry isSidechain:true in
// the data). The format is CC's internal contract — if it changes, parsing
// quietly stops and the rest of the collector is unaffected.
const USAGE_TRIGGERS = new Set(["Stop", "SubagentStop", "SessionEnd"]);
const USAGE_CHUNK = 8 * 1024 * 1024; // bytes per read pass (loops until caught up)
const usageBusy = new Set();

function maybeParseUsage(rec) {
  if (!USAGE_TRIGGERS.has(rec.hook_event_type)) return;
  const p = rec.payload && rec.payload.transcript_path;
  // source_app comes from the triggering event itself — the events row may not
  // be flushed yet (50ms batch writer), so a DB lookup here would race.
  if (typeof p === "string" && p) scheduleUsageParse(rec.session_id, p, rec.source_app);
}

function scheduleUsageParse(sessionId, tPath, app) {
  if (!db || usageBusy.has(sessionId)) return;
  usageBusy.add(sessionId);
  setImmediate(() => {
    try { parseSessionTranscripts(sessionId, tPath, app); }
    catch (e) { logSafe("usage parse", e); }
    finally { usageBusy.delete(sessionId); }
  });
}

// Subagent transcripts (#81): CC writes each Task/Agent conversation to its own
// file — <dir>/<sessionId>/subagents/agent-<id>.jsonl next to the main
// transcript. Same JSONL shape (message.usage + TTL split), rows carry
// isSidechain:true and the parent sessionId, so the same parser ingests them;
// the filename's agent id keeps per-agent attribution. No directory → the
// common case (no subagents yet) → empty.
function subagentTranscripts(sessionId, tPath) {
  const dir = path.join(path.dirname(tPath), sessionId, "subagents");
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(n);
    if (m) out.push({ path: path.join(dir, n), agentId: m[1] });
  }
  return out;
}

// One trigger parses the whole session: the main transcript, then every
// subagent file. Per-(session,path) cursors (v6) keep each file incremental —
// a dozen agent files cost a readdir + a stat each once caught up.
function parseSessionTranscripts(sessionId, tPath, app) {
  parseTranscriptTail(sessionId, tPath, app, null);
  for (const s of subagentTranscripts(sessionId, tPath)) {
    try { parseTranscriptTail(sessionId, s.path, app, s.agentId); }
    catch (e) { logSafe("usage sub parse", e); }
  }
}

// One pass of complete lines → usage rows. Lines of one API message are
// adjacent and share message.id; we fold them into one row (merging tool_use
// ids). follows = the PREVIOUS main-chain message's emitted ids — a tool result
// feeds the NEXT call's input, so that is where its input cost lands.
function ingestUsageLines(sessionId, app, text, lastEmitted, agentId) {
  const ins = db.impl.prepare(`INSERT OR IGNORE INTO usage
    (session_id, msg_id, source_app, ts, model, input, output, cache_create, cache_read, cache_create_1h, sidechain, agent_id, inserted_at, emitted_tool_ids, follows_tool_ids)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const sel = db.impl.prepare("SELECT emitted_tool_ids FROM usage WHERE session_id = ? AND msg_id = ?");
  // On conflict (rescan, or a message straddling a read boundary) refresh the
  // token/TTL columns from this parse and UNION the tool ids. The numbers are
  // stable per message (usage is duplicated across its content-block lines), so
  // this is a no-op on a straddle and a real backfill on a --rescan of a row
  // written before cache_create_1h existed (#57). follows_tool_ids is left as the
  // first insert set it (unchanged from prior behaviour).
  const upd = db.impl.prepare(`UPDATE usage SET
    ts = ?, model = ?, input = ?, output = ?, cache_create = ?, cache_read = ?, cache_create_1h = ?,
    inserted_at = ?, emitted_tool_ids = ? WHERE session_id = ? AND msg_id = ?`);
  let cur = null, last = lastEmitted;
  const flush = () => {
    if (!cur) return;
    try {
      const info = ins.run(sessionId, cur.id, app, cur.ts, cur.model,
        cur.input, cur.output, cur.cc, cur.cr, cur.cc1h, cur.side, agentId ?? null, Date.now(),
        JSON.stringify(cur.emitted), JSON.stringify(cur.follows));
      if (info.changes === 0) {
        // row already existed (rescan / straddled pass) → refresh columns and
        // union any newly-seen tool ids onto the stored set
        const row = sel.get(sessionId, cur.id);
        let old = [];
        if (row) { try { old = JSON.parse(row.emitted_tool_ids) || []; } catch {} }
        const merged = cur.emitted.length ? [...new Set([...old, ...cur.emitted])] : old;
        upd.run(cur.ts, cur.model, cur.input, cur.output, cur.cc, cur.cr, cur.cc1h,
          Date.now(), JSON.stringify(merged), sessionId, cur.id);
      }
    } catch (e) { logSafe("usage row", e); }
    if (!cur.side) last = cur.emitted;
    cur = null;
  };
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; } // fail-open per line
    if (!e || e.type !== "assistant" || !e.message || !e.message.usage) continue;
    const m = e.message;
    if (typeof m.id !== "string" || !m.id) continue;
    const ids = Array.isArray(m.content)
      ? m.content.filter((b) => b && b.type === "tool_use" && typeof b.id === "string").map((b) => b.id)
      : [];
    if (cur && cur.id === m.id) {
      for (const id of ids) if (!cur.emitted.includes(id)) cur.emitted.push(id);
      continue;
    }
    flush();
    const u = m.usage, side = e.isSidechain === true ? 1 : 0;
    cur = {
      id: m.id, ts: Date.parse(e.timestamp) || Date.now(), model: m.model ?? null,
      input: u.input_tokens | 0, output: u.output_tokens | 0,
      cc: u.cache_creation_input_tokens | 0, cr: u.cache_read_input_tokens | 0,
      // cc = TOTAL cache-write tokens; cc1h = the 1h-TTL subset (5m = cc − cc1h).
      // Absent on pre-TTL-split transcripts → 0 → billed as all-5m (#57).
      cc1h: (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) | 0,
      side, emitted: ids, follows: side ? [] : last,
    };
  }
  flush();
  return last;
}

function parseTranscriptTail(sessionId, tPath, appHint, agentId = null) {
  if (!db) return;
  // v6: one cursor per (session, path) — a session tracks its main transcript
  // plus every subagent file, each incrementally.
  const cur = db.impl.prepare("SELECT offset, last_emitted FROM transcript_cursor WHERE session_id = ? AND path = ?").get(sessionId, tPath);
  let offset = cur ? Number(cur.offset) : 0; // new file → from the top
  let lastEmitted = [];
  if (cur) { try { lastEmitted = JSON.parse(cur.last_emitted) || []; } catch {} }
  let app = appHint;
  if (!app) { // CLI/backfill path: events are already flushed, lookup is safe
    const appRow = db.impl.prepare("SELECT source_app FROM events WHERE session_id = ? LIMIT 1").get(sessionId);
    app = appRow ? appRow.source_app : "unknown";
  }
  const saveCursor = db.impl.prepare(`INSERT INTO transcript_cursor (session_id, path, offset, last_emitted, updated_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(session_id, path) DO UPDATE SET offset=excluded.offset,
      last_emitted=excluded.last_emitted, updated_at=excluded.updated_at`);
  let fd;
  try { fd = fs.openSync(tPath, "r"); } catch (e) { logSafe("usage open", e); return; }
  try {
    for (;;) {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) break;
      const len = Math.min(size - offset, USAGE_CHUNK);
      const buf = Buffer.alloc(len);
      const got = fs.readSync(fd, buf, 0, len, offset);
      if (got <= 0) break;
      const nl = buf.lastIndexOf(0x0a, got - 1);
      if (nl < 0) break; // no complete line yet — wait for the next trigger
      db.impl.exec("BEGIN IMMEDIATE");
      try {
        lastEmitted = ingestUsageLines(sessionId, app, buf.toString("utf8", 0, nl), lastEmitted, agentId);
        offset += nl + 1;
        saveCursor.run(sessionId, tPath, offset, JSON.stringify(lastEmitted.slice(0, 32)), Date.now());
        db.impl.exec("COMMIT");
      } catch (e) {
        try { db.impl.exec("ROLLBACK"); } catch {}
        throw e;
      }
    }
  } finally { try { fs.closeSync(fd); } catch {} }
}

// ── model pricing (#53, TTL split #57) ──────────────────────────────────────
// USD per MTok, official API rates as of 2026-07-04. Longest matching prefix of
// the transcript's message.model wins. Cache writes are billed per TTL: 5m =
// 1.25× input, 1h = 2× input (Anthropic's rates). `cache_write` here is the 5m
// rate (back-compat); the 1h rate is `cache_write_1h` if given, else input × 2.
// Extend or correct via {"pricing": {"<prefix>": {input, output, cache_write,
// cache_write_1h, cache_read}}} in config.json — a PARTIAL override merges onto
// the base entry (missing keys keep their defaults), a prefix set to null is
// unpriced.
const DEFAULT_PRICING = {
  "claude-fable-5": { input: 10, output: 50, cache_write: 12.5, cache_read: 1 },
  "claude-mythos-5": { input: 10, output: 50, cache_write: 12.5, cache_read: 1 },
  "claude-opus-4-8": { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  "claude-opus-4": { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 }, // Opus 4 / 4.1 dated ids
  "claude-sonnet-5": { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 }, // intro; 3/15 from 2026-09-01
  "claude-sonnet-4": { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cache_write: 1, cache_read: 0.08 },
};
const PRICING = { ...DEFAULT_PRICING }; // + config.json overrides (loadPricing)
const priceMemo = new Map(); // model -> rates | null
function priceOf(model) {
  if (!model) return null;
  if (priceMemo.has(model)) return priceMemo.get(model);
  let best = null, bestLen = -1;
  for (const k in PRICING)
    if (PRICING[k] && model.startsWith(k) && k.length > bestLen) { best = PRICING[k]; bestLen = k.length; }
  priceMemo.set(model, best);
  return best;
}
// Cache-write rates per TTL, derived from the price entry (base input × 1.25 / 2
// when not given explicitly). Single source for the TTL multipliers (#57).
function writeRates(p) {
  const w5m = p.cache_write_5m ?? p.cache_write ?? p.input * 1.25;
  const w1h = p.cache_write_1h ?? p.input * 2;
  return [w5m, w1h];
}
// USD cost split into its four components (input / cache write / cache read /
// output). Single source for both the scalar cost and the anatomy view (#56).
// Cache writes bill per TTL: the 1h subset at 2×, the rest (5m) at 1.25×ish.
function costParts(p, input, output, cacheCreate, cacheRead, cacheCreate1h = 0) {
  const [w5m, w1h] = writeRates(p);
  const cc1h = Math.min(cacheCreate, Math.max(0, cacheCreate1h)); // 1h subset ≤ total
  const cc5m = cacheCreate - cc1h;
  return {
    input: input * p.input / 1e6,
    write: (cc5m * w5m + cc1h * w1h) / 1e6,
    read: cacheRead * p.cache_read / 1e6,
    output: output * p.output / 1e6,
  };
}
function costOf(p, input, output, cacheCreate, cacheRead, cacheCreate1h = 0) {
  const c = costParts(p, input, output, cacheCreate, cacheRead, cacheCreate1h);
  return c.input + c.write + c.read + c.output;
}
const roundUsd = (n) => Math.round(n * 1e4) / 1e4;

// ── GET /stats/tokens (stage 10a) ───────────────────────────────────────────
// group=session|app|bucket|tool|model. Non-tool groups are exact sums of the usage
// rows; group=tool is the DOCUMENTED APPROXIMATION: a message's output is split
// across the tool calls it emitted, its input+cache_create across the calls it
// follows (tool results feed the next call's input). No emitted → "(response)",
// no follows → "(prompt)" (or "(subagent)" for sidechain rows).
function tokensByTool(rows) {
  const perId = new Map(); // tool_use_id -> {out, inp, oc, ic}
  const named = new Map(); // bucket name -> {out, inp, oc, ic}
  const bump = (map, k, f, v, c, cv) => {
    let o = map.get(k); if (!o) map.set(k, (o = { out: 0, inp: 0, oc: 0, ic: 0 }));
    o[f] += v; o[c] += cv;
  };
  for (const r of rows) {
    let emitted = [], follows = [];
    try { emitted = JSON.parse(r.emitted_tool_ids) || []; } catch {}
    try { follows = JSON.parse(r.follows_tool_ids) || []; } catch {}
    const out = Number(r.output), inp = Number(r.input) + Number(r.cache_create);
    // cost rides the same split as the tokens (same documented approximation);
    // cache_read stays unattributed here, exactly like the token figures.
    const p = priceOf(r.model);
    const outCost = p ? out * p.output / 1e6 : 0;
    let inpCost = 0;
    if (p) {
      const [w5m, w1h] = writeRates(p);
      const cc1h = Math.min(Number(r.cache_create), Math.max(0, Number(r.cache_create_1h)));
      const cc5m = Number(r.cache_create) - cc1h;
      inpCost = (Number(r.input) * p.input + cc5m * w5m + cc1h * w1h) / 1e6;
    }
    if (emitted.length) for (const id of emitted) bump(perId, id, "out", out / emitted.length, "oc", outCost / emitted.length);
    else bump(named, "(response)", "out", out, "oc", outCost);
    if (follows.length) for (const id of follows) bump(perId, id, "inp", inp / follows.length, "ic", inpCost / follows.length);
    else bump(named, Number(r.sidechain) ? "(subagent)" : "(prompt)", "inp", inp, "ic", inpCost);
  }
  const ids = [...perId.keys()], nameOf = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const q = db.impl.prepare(
      `SELECT tool_use_id, tool_name FROM events WHERE hook_event_type = 'PreToolUse'
       AND tool_use_id IN (${chunk.map(() => "?").join(",")})`
    ).all(...chunk);
    for (const r of q) nameOf.set(r.tool_use_id, r.tool_name || "(unknown)");
  }
  const agg = new Map();
  const fold = (name, o, calls) => {
    let a = agg.get(name);
    if (!a) agg.set(name, (a = { key: name, output: 0, input_cache: 0, total: 0, calls: 0, cost_usd: 0 }));
    a.output += o.out; a.input_cache += o.inp; a.total += o.out + o.inp; a.calls += calls;
    a.cost_usd += o.oc + o.ic;
  };
  for (const [id, o] of perId) fold(nameOf.get(id) || "(unknown)", o, 1);
  for (const [name, o] of named) fold(name, o, 0);
  return [...agg.values()]
    .map((a) => ({ ...a, output: Math.round(a.output), input_cache: Math.round(a.input_cache), total: Math.round(a.total), cost_usd: roundUsd(a.cost_usd) }))
    .sort((a, b) => b.total - a.total);
}

// GET /stats/tokens?group=anatomy — window-wide + per-model cost split into its
// four components (input / cache write / cache read / output), $ and % of that
// row's total. Same rows/prices as every other group; only the split is new.
// `totals` also carries baseline_ctx: Σ over sessions of the smallest main-chain
// context seen — a rough floor for the harness fixed cost re-sent every turn (#56).
function tokensAnatomy(rows) {
  const byModel = new Map();
  const zero = () => ({ input: 0, write: 0, read: 0, output: 0 });
  const totals = zero();
  const sessionMin = new Map(); // session -> min main-chain context
  let unpriced = 0;
  for (const r of rows) {
    if (!Number(r.sidechain)) {
      const ctx = Number(r.input) + Number(r.cache_create) + Number(r.cache_read);
      const cur = sessionMin.get(r.session_id);
      if (cur === undefined || ctx < cur) sessionMin.set(r.session_id, ctx);
    }
    const p = priceOf(r.model);
    if (!p) { unpriced += Number(r.input) + Number(r.output) + Number(r.cache_create) + Number(r.cache_read); continue; }
    const c = costParts(p, Number(r.input), Number(r.output), Number(r.cache_create), Number(r.cache_read), Number(r.cache_create_1h));
    const key = r.model || "(unknown)";
    let m = byModel.get(key);
    if (!m) byModel.set(key, (m = { key, ...zero() }));
    for (const f of ["input", "write", "read", "output"]) { m[f] += c[f]; totals[f] += c[f]; }
  }
  let baseline_ctx = 0;
  for (const v of sessionMin.values()) baseline_ctx += v;
  const withPct = (o) => {
    const cost = o.input + o.write + o.read + o.output;
    const p = (v) => cost > 0 ? Math.round(v / cost * 1000) / 10 : 0;
    return {
      key: o.key,
      input_usd: roundUsd(o.input), write_usd: roundUsd(o.write),
      read_usd: roundUsd(o.read), output_usd: roundUsd(o.output),
      cost_usd: roundUsd(cost),
      pct: { input: p(o.input), write: p(o.write), read: p(o.read), output: p(o.output) },
    };
  };
  const modelRows = [...byModel.values()].map(withPct).sort((a, b) => b.cost_usd - a.cost_usd);
  return { rows: modelRows, totals: { ...withPct({ key: "(all)", ...totals }), baseline_ctx, unpriced } };
}

// Enrich group=session rows with per-session diagnostics derived from the SAME
// window rows (#56): average / peak context, model switches and the cache
// rewrite they cost, mega flag. Additive — token/cost sums stay untouched.
function enrichSessions(out, rows) {
  const bySession = new Map();
  for (const r of rows) {
    if (Number(r.sidechain)) continue; // main chain only — context = what resends
    let l = bySession.get(r.session_id);
    if (!l) bySession.set(r.session_id, (l = []));
    l.push(r);
  }
  for (const a of out) {
    const l = bySession.get(a.key);
    if (!l || !l.length) { a.avg_ctx = 0; a.peak_ctx = 0; a.model_switches = 0; a.switch_rewrite_est = 0; a.mega = false; continue; }
    l.sort((x, y) => Number(x.ts) - Number(y.ts));
    let sum = 0, peak = 0, switches = 0, rewrite = 0, prevModel = null;
    for (const r of l) {
      const ctx = Number(r.input) + Number(r.cache_create) + Number(r.cache_read);
      sum += ctx; if (ctx > peak) peak = ctx;
      const m = r.model || "";
      if (prevModel !== null && m !== prevModel) {
        switches++;
        const p = priceOf(r.model); // the rewrite the new model had to pay on switch-in
        if (p) rewrite += costParts(p, 0, 0, Number(r.cache_create), 0, Number(r.cache_create_1h)).write;
      }
      prevModel = m;
    }
    a.avg_ctx = Math.round(sum / l.length);
    a.peak_ctx = peak;
    a.model_switches = switches;
    a.switch_rewrite_est = roundUsd(rewrite);
    a.mega = l.length >= MEGA_TURNS || a.avg_ctx >= MEGA_CTX;
  }
}

// GET /stats/tokens?group=timeline&session_id=X — one session's main-chain
// messages in ts order: context growth, compact markers (a sharp ctx drop), and
// a compact what-if (cache-read $ a context cap would have avoided) (#56). Not
// windowed — a drilldown shows the whole session.
function tokensTimeline(res, sid) {
  try {
    const rows = db.impl.prepare(
      `SELECT ts, model, input, output, cache_create, cache_read, cache_create_1h
       FROM usage WHERE session_id = ? AND sidechain = 0 ORDER BY ts ASC`
    ).all(sid);
    const series = rows.map((r) => {
      const ctx = Number(r.input) + Number(r.cache_create) + Number(r.cache_read);
      const p = priceOf(r.model);
      const cost = p ? costOf(p, Number(r.input), Number(r.output), Number(r.cache_create), Number(r.cache_read), Number(r.cache_create_1h)) : 0;
      return { ts: Number(r.ts), model: r.model || "(unknown)", ctx,
        input: Number(r.input), output: Number(r.output),
        cache_create: Number(r.cache_create), cache_read: Number(r.cache_read),
        cost_usd: roundUsd(cost) };
    });
    // compact marker: context fell below 60% of the previous turn while the
    // previous was substantial (>50k) — a compaction / clear boundary heuristic.
    const compact_markers = [];
    for (let i = 1; i < series.length; i++)
      if (series[i - 1].ctx > 50_000 && series[i].ctx < series[i - 1].ctx * 0.6)
        compact_markers.push({ ts: series[i].ts, from_ctx: series[i - 1].ctx, to_ctx: series[i].ctx });
    // what-if: had the session been capped, each turn's cache_read above the cap
    // would have been avoided (rough upper bound, billed at that turn's read rate).
    const whatif = {};
    for (const cap of [200_000, 300_000]) {
      let saved = 0;
      for (const r of rows) {
        const p = priceOf(r.model); if (!p) continue;
        saved += Math.max(0, Number(r.cache_read) - cap) * p.cache_read / 1e6;
      }
      whatif[cap] = roundUsd(saved);
    }
    json(res, 200, { session_id: sid, count: series.length, series, compact_markers, whatif });
  } catch (e) { logSafe("stats tokens timeline", e); json(res, 500, { error: "query failed" }); }
}

function handleStatsTokens(req, res, u) {
  if (!statsGate(req, res)) return;
  const window_ms = windowOf(u, "7d");
  const bucket_ms = window_ms <= WINDOW_MS["1h"] ? 60_000 : 3_600_000;
  const group = u.searchParams.get("group") || "session";
  if (!["session", "app", "bucket", "tool", "model", "anatomy", "timeline"].includes(group))
    return json(res, 400, { error: "bad group (session|app|bucket|tool|model|anatomy|timeline)" });
  if (!db) return json(res, 200, { window_ms, bucket_ms, group, count: 0, rows: [] });
  if (group === "timeline") {
    const sid = u.searchParams.get("session_id");
    if (!sid) return json(res, 400, { error: "timeline needs session_id" });
    return tokensTimeline(res, sid);
  }
  const since = Date.now() - window_ms;
  const app = u.searchParams.get("source_app");
  const where = app ? "ts >= ? AND source_app = ?" : "ts >= ?";
  const params = app ? [since, app] : [since];
  try {
    const rows = db.impl.prepare(
      `SELECT session_id, source_app, ts, model, input, output, cache_create, cache_read, cache_create_1h,
              sidechain, emitted_tool_ids, follows_tool_ids
       FROM usage WHERE ${where}`
    ).all(...params);
    let out, totals;
    if (group === "tool") out = tokensByTool(rows);
    else if (group === "anatomy") { const a = tokensAnatomy(rows); out = a.rows; totals = a.totals; }
    else {
      const keyOf = group === "session" ? (r) => r.session_id
        : group === "app" ? (r) => r.source_app
        : group === "model" ? (r) => r.model || "(unknown)"
        : (r) => Math.floor(Number(r.ts) / bucket_ms) * bucket_ms;
      const agg = new Map();
      for (const r of rows) {
        const k = keyOf(r);
        let a = agg.get(k);
        if (!a) agg.set(k, (a = {
          key: k, input: 0, output: 0, cache_create: 0, cache_read: 0,
          total: 0, messages: 0, subagent_total: 0, subagent_messages: 0,
          cost_usd: 0, unpriced: 0,
        }));
        if (group === "session") {
          if (!a.source_app) a.source_app = r.source_app;
          // context = the LATEST main-chain message's input+cache sums — what
          // the next turn will resend (compaction-pressure signal for the UI).
          if (!Number(r.sidechain) && Number(r.ts) >= (a.last_ts || 0)) {
            a.last_ts = Number(r.ts);
            a.context = Number(r.input) + Number(r.cache_create) + Number(r.cache_read);
          }
        }
        const t = Number(r.input) + Number(r.output) + Number(r.cache_create) + Number(r.cache_read);
        // cost counts main chain AND sidechain (real spend either way); tokens
        // without a known price go to `unpriced` instead of a made-up $0 rate.
        const p = priceOf(r.model);
        if (p) a.cost_usd += costOf(p, Number(r.input), Number(r.output), Number(r.cache_create), Number(r.cache_read), Number(r.cache_create_1h));
        else a.unpriced += t;
        if (Number(r.sidechain)) { a.subagent_total += t; a.subagent_messages++; }
        else {
          a.input += Number(r.input); a.output += Number(r.output);
          a.cache_create += Number(r.cache_create); a.cache_read += Number(r.cache_read);
          a.total += t; a.messages++;
        }
      }
      out = [...agg.values()].sort(group === "bucket" ? (a, b) => a.key - b.key : (a, b) => b.total - a.total);
      for (const a of out) a.cost_usd = roundUsd(a.cost_usd);
      if (group === "session") enrichSessions(out, rows);
    }
    const resp = { window_ms, bucket_ms, group, count: out.length, rows: out };
    if (totals) resp.totals = totals;
    json(res, 200, resp);
  } catch (e) { logSafe("stats tokens", e); json(res, 500, { error: "query failed" }); }
}

// ── GET /stats/guards (stage 9) ─────────────────────────────────────────────
// Roll up GuardDecision events (guard deny/ask/warn — design §6). Reads the
// payload column (see the stats-section header for the full exception list):
// GuardDecision rows are few (tens/day) so per-row json_extract over the
// idx_type_time range is cheap. The command is already redacted by the
// collector's post-ack path.
function handleStatsGuards(req, res, u) {
  if (!statsGate(req, res)) return;
  const window_ms = windowOf(u, "7d");
  if (!db) return json(res, 200, { window_ms, count: 0, by_guard: [], by_rule: [], by_app: [], top_commands: [] });
  const since = Date.now() - window_ms;
  try {
    const rows = db.impl.prepare(
      `SELECT source_app,
              json_extract(payload, '$.guard')    guard,
              json_extract(payload, '$.rule')     rule,
              json_extract(payload, '$.decision') decision,
              json_extract(payload, '$.command')  command
       FROM events
       WHERE hook_event_type = 'GuardDecision' AND received_at >= ?`
    ).all(since);
    const guards = new Map(), rules = new Map(), apps = new Map(), cmds = new Map();
    for (const r of rows) {
      const guard = r.guard || "(unknown)";
      const rule = r.rule || "(unknown)";
      const decision = r.decision || "(unknown)";
      const app = r.source_app || "unknown";
      let g = guards.get(guard);
      if (!g) guards.set(guard, (g = { guard, total: 0, deny: 0, ask: 0, warn: 0 }));
      g.total++;
      if (decision === "deny" || decision === "ask" || decision === "warn") g[decision]++;
      const rk = `${guard} ${rule} ${decision}`;
      let rr = rules.get(rk);
      if (!rr) rules.set(rk, (rr = { guard, rule, decision, count: 0 }));
      rr.count++;
      apps.set(app, (apps.get(app) || 0) + 1);
      if (typeof r.command === "string" && r.command) cmds.set(r.command, (cmds.get(r.command) || 0) + 1);
    }
    json(res, 200, {
      window_ms, count: rows.length,
      by_guard: [...guards.values()].sort((a, b) => b.total - a.total),
      by_rule: [...rules.values()].sort((a, b) => b.count - a.count),
      by_app: [...apps.entries()].map(([app, count]) => ({ app, count })).sort((a, b) => b.count - a.count),
      top_commands: [...cmds.entries()].map(([command, count]) => ({ command, count }))
        .sort((a, b) => b.count - a.count).slice(0, 20),
    });
  } catch (e) { logSafe("stats guards", e); json(res, 500, { error: "query failed" }); }
}

// ── GET /stats/nudges (#63) ─────────────────────────────────────────────────
// Roll up ctx-budget boundary nudges: NudgeFired (fired) joined to NudgeOutcome
// (acp's compliance verdict, when present). Same payload-read rationale as
// /stats/guards — nudges are rare (cooldown + boundary gated), so per-row
// json_extract over idx_type_time is cheap.
//
// JOIN KEY (F3): (transcriptHash, byteOffset). byteOffset can be null at fire
// time (statSync failure on the acp side), so it degrades to (transcriptHash,
// ts) — the fire row and its outcome must agree on the same fallback.
//
// The compliance VERDICT is acp-owned (analyze pushes NudgeOutcome — acp#29);
// this endpoint only stores/aggregates/displays. And because a nudge fired while
// the collector was down leaves a ledger line but no event (no retry), the
// NudgeFired count here is an OBSERVED LOWER BOUND — acp's ledger report is the
// single source of truth for the exact compliance rate (F4). The UI notes this.
const KILL_N_TARGET = 20;   // acp kill-judgment window: n outcomes …
const KILL_DAYS_TARGET = 30; // … over d days before retiring an ignored nudge
function nudgeJoinKey(th, boff, ts) {
  return `${th ?? ""} ${boff != null ? "b" + boff : "t" + (ts ?? "")}`;
}
function handleStatsNudges(req, res, u) {
  if (!statsGate(req, res)) return;
  const window_ms = windowOf(u, "7d");
  const empty = {
    window_ms, count: 0, by_kind: [], by_cost_shown: [], by_app: [],
    series: [], recent: [], compliance: null,
    judgment: { n: 0, n_target: KILL_N_TARGET, days: 0, days_target: KILL_DAYS_TARGET },
  };
  if (!db) return json(res, 200, empty);
  const since = Date.now() - window_ms;
  try {
    const fires = db.impl.prepare(
      `SELECT received_at, source_app,
              json_extract(payload, '$.ts')             ts,
              json_extract(payload, '$.transcriptHash') th,
              json_extract(payload, '$.byteOffset')     boff,
              json_extract(payload, '$.kind')           kind,
              json_extract(payload, '$.template')       template,
              json_extract(payload, '$.keepLabel')      keepLabel,
              json_extract(payload, '$.dropLabel')      dropLabel,
              json_extract(payload, '$.dropForm')       dropForm,
              json_extract(payload, '$.ctxTokens')      ctxTokens,
              json_extract(payload, '$.estUsd')         estUsd,
              json_extract(payload, '$.model')          model,
              json_extract(payload, '$.costShown')      costShown
       FROM events
       WHERE hook_event_type = 'NudgeFired' AND received_at >= ?`
    ).all(since);
    const outcomes = db.impl.prepare(
      `SELECT json_extract(payload, '$.ref.transcriptHash')   th,
              json_extract(payload, '$.ref.byteOffset')       boff,
              json_extract(payload, '$.ref.ts')               ts,
              json_extract(payload, '$.complied')             complied,
              json_extract(payload, '$.baseRateWindow')       baseRate,
              json_extract(payload, '$.keepAudit.misassigned') keepMis
       FROM events
       WHERE hook_event_type = 'NudgeOutcome' AND received_at >= ?`
    ).all(since);
    const outByKey = new Map();
    for (const o of outcomes) outByKey.set(nudgeJoinKey(o.th, o.boff, o.ts), o);

    const kinds = new Map(), costs = new Map(), apps = new Map(), buckets = new Map();
    let outcomeCount = 0, complied = 0, keepMisassign = 0, baseRate = null, earliest = null;
    const recent = [];
    const DAY = 86400000;
    for (const f of fires) {
      const kind = f.kind || "(unknown)";
      const template = f.template || "(unknown)";
      const app = f.source_app || "unknown";
      const kk = `${kind} ${template}`;
      let k = kinds.get(kk);
      if (!k) kinds.set(kk, (k = { kind, template, count: 0, outcomes: 0, complied: 0 }));
      k.count++;
      costs.set(f.costShown || "(unknown)", (costs.get(f.costShown || "(unknown)") || 0) + 1);
      apps.set(app, (apps.get(app) || 0) + 1);
      const day = Math.floor(f.received_at / DAY) * DAY;
      buckets.set(day, (buckets.get(day) || 0) + 1);
      if (earliest == null || f.received_at < earliest) earliest = f.received_at;

      const o = outByKey.get(nudgeJoinKey(f.th, f.boff, f.ts));
      let compliedFlag = null;
      if (o) {
        outcomeCount++; k.outcomes++;
        compliedFlag = !!o.complied;
        if (compliedFlag) { complied++; k.complied++; }
        if (o.keepMis) keepMisassign++;
        if (typeof o.baseRate === "number") baseRate = o.baseRate;
      }
      recent.push({
        ts: f.ts ?? f.received_at, kind, template,
        keepLabel: f.keepLabel, dropLabel: f.dropLabel, dropForm: f.dropForm,
        ctxTokens: f.ctxTokens, estUsd: f.estUsd, costShown: f.costShown,
        complied: compliedFlag,
      });
    }
    recent.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const days = earliest != null ? Math.round(((Date.now() - earliest) / DAY) * 10) / 10 : 0;

    json(res, 200, {
      window_ms, count: fires.length,
      by_kind: [...kinds.values()].sort((a, b) => b.count - a.count),
      by_cost_shown: [...costs.entries()].map(([costShown, count]) => ({ costShown, count }))
        .sort((a, b) => b.count - a.count),
      by_app: [...apps.entries()].map(([app, count]) => ({ app, count })).sort((a, b) => b.count - a.count),
      series: [...buckets.entries()].map(([t, count]) => ({ t, count })).sort((a, b) => a.t - b.t),
      recent: recent.slice(0, 100),
      compliance: outcomeCount > 0
        ? { outcomes: outcomeCount, complied, rate: complied / outcomeCount, base_rate: baseRate, keep_misassign: keepMisassign }
        : null,
      judgment: { n: outcomeCount, n_target: KILL_N_TARGET, days, days_target: KILL_DAYS_TARGET },
    });
  } catch (e) { logSafe("stats nudges", e); json(res, 500, { error: "query failed" }); }
}

// ── GET /stats/db (#87) ─────────────────────────────────────────────────────
// Roll up DbQuery events (agent-db-plugin audit → observability). Same
// payload-read rationale as /stats/guards: DbQuery rows are the plugin's local /
// rehearsal query volume (the in-office Windows MCP host has no reachable
// collector — #87 scope note), so per-row json_extract over the idx_type_time
// range is fine. `sql` is stored verbatim (masking scoped out of #87), so table
// extraction is a best-effort FROM/JOIN scan, not a parser.
const DB_SLOW_LIMIT = 20;
const DB_ORA_CODE_RE = /ORA-\d{5}/;
const DB_TABLE_RE = /\b(?:from|join)\s+("?[a-zA-Z_][\w$#]*"?(?:\."?[a-zA-Z_][\w$#]*"?)?)/gi;

function dbExtractTables(sql) {
  const out = [];
  if (typeof sql !== "string") return out;
  DB_TABLE_RE.lastIndex = 0;
  let m;
  while ((m = DB_TABLE_RE.exec(sql))) out.push(m[1].replace(/"/g, "").toUpperCase());
  return out;
}

function handleStatsDb(req, res, u) {
  if (!statsGate(req, res)) return;
  const window_ms = windowOf(u, "7d");
  const empty = { window_ms, count: 0, errors: 0, by_alias: [], by_tool: [], by_error: [], slow: [], top_tables: [] };
  if (!db) return json(res, 200, empty);
  const since = Date.now() - window_ms;
  try {
    const rows = db.impl.prepare(
      `SELECT received_at,
              json_extract(payload, '$.alias')     alias,
              json_extract(payload, '$.tool')      tool,
              json_extract(payload, '$.sql')       sql,
              json_extract(payload, '$.elapsedMs') elapsedMs,
              json_extract(payload, '$.oraError')  oraError
       FROM events
       WHERE hook_event_type = 'DbQuery' AND received_at >= ?`
    ).all(since);
    const aliases = new Map(), tools = new Map(), errs = new Map(), tables = new Map();
    let errors = 0;
    for (const r of rows) {
      const alias = r.alias || "(unknown)";
      const tool = r.tool || "(unknown)";
      const ms = Number(r.elapsedMs) || 0;
      let a = aliases.get(alias);
      if (!a) aliases.set(alias, (a = { alias, total: 0, errors: 0, slowest_ms: 0 }));
      a.total++;
      if (ms > a.slowest_ms) a.slowest_ms = ms;
      tools.set(tool, (tools.get(tool) || 0) + 1);
      if (r.oraError) {
        errors++; a.errors++;
        const code = (DB_ORA_CODE_RE.exec(String(r.oraError)) || [])[0] || String(r.oraError).slice(0, 40);
        errs.set(code, (errs.get(code) || 0) + 1);
      }
      for (const t of dbExtractTables(r.sql)) tables.set(t, (tables.get(t) || 0) + 1);
    }
    const slow = rows
      .map((r) => ({
        alias: r.alias, tool: r.tool,
        sql: typeof r.sql === "string" ? r.sql.slice(0, 200) : "",
        elapsedMs: Number(r.elapsedMs) || 0,
        oraError: r.oraError ? String(r.oraError).slice(0, 120) : null,
        ts: r.received_at,
      }))
      .sort((a, b) => b.elapsedMs - a.elapsedMs)
      .slice(0, DB_SLOW_LIMIT);
    json(res, 200, {
      window_ms, count: rows.length, errors,
      by_alias: [...aliases.values()].sort((a, b) => b.total - a.total),
      by_tool: [...tools.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count),
      by_error: [...errs.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
      slow,
      top_tables: [...tables.entries()].map(([table, count]) => ({ table, count }))
        .sort((a, b) => b.count - a.count).slice(0, 20),
    });
  } catch (e) { logSafe("stats db", e); json(res, 500, { error: "query failed" }); }
}

// ── GET /stats/schema-docs (#90 — enrich apply/promote activity log) ─────────
// The apply/promote HISTORY behind the keyword-docs review flow: SchemaDocApply /
// SchemaDocPromote events, empty until enrich-cli --write runs. It records WHAT
// changed WHEN, not current state — the pending "queue" itself is just the
// keyword-docs corpus table's 추정) column, a live file scan the viewer already
// does via /docs (summed client-side), so this endpoint is events-only and never
// reads files. Read-only and loopback-gated like every other /stats endpoint.
function handleStatsSchemaDocs(req, res, u) {
  if (!statsGate(req, res)) return;
  const window_ms = windowOf(u, "30d");
  const history = [];
  let applies = 0, promotes = 0, promotedSlots = 0, filledSlots = 0;
  if (db) {
    try {
      const since = Date.now() - window_ms;
      const rows = db.impl.prepare(
        `SELECT received_at, source_app, hook_event_type,
                json_extract(payload, '$.doc')      doc,
                json_extract(payload, '$.filled')   filled,
                json_extract(payload, '$.skipped')  skipped,
                json_extract(payload, '$.promoted') promoted
         FROM events
         WHERE hook_event_type IN ('SchemaDocApply', 'SchemaDocPromote') AND received_at >= ?
         ORDER BY received_at DESC LIMIT 200`
      ).all(since);
      const arr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
      for (const r of rows) {
        if (r.hook_event_type === "SchemaDocApply") {
          const filled = arr(r.filled).length;
          applies++; filledSlots += filled;
          history.push({ ts: r.received_at, type: "apply", app: r.source_app, doc: r.doc || "(unknown)",
            filled, skipped: arr(r.skipped).length });
        } else {
          const p = arr(r.promoted);
          promotes++; promotedSlots += p.length;
          history.push({ ts: r.received_at, type: "promote", app: r.source_app, doc: r.doc || "(unknown)", promoted: p.length });
        }
      }
    } catch (e) { logSafe("schema-docs history", e); }
  }
  json(res, 200, {
    window_ms,
    totals: { applies, promotes, promoted_slots: promotedSlots, filled_slots: filledSlots },
    history,
  });
}

// ── GET /docs + /docs/content (#92 — keyword-docs corpus viewer) ────────────
// List every doc the keyword-docs instances can inject at the USER layer, and
// serve one doc's raw text. Path resolution + the content allowlist come from
// the SHARED lib/doc-index.mjs — the exact resolution the hook injects with — so
// discovery and the allowlist can't diverge. Files are the source of truth: read
// fresh each request (no cache), everything fail-soft (a broken index or missing
// doc contributes nothing, never a 500).
const DOCS_MAX_BYTES = 512 * 1024;

// Home root the docs viewer reads under. OBS_DOCS_HOME overrides it (test seam /
// escape hatch, same spirit as OBS_DATA_DIR); production uses the real home.
function docsHomeDir() {
  return process.env.OBS_DOCS_HOME || os.homedir();
}

// dbdoc tier markers (db-schema-docs / enrich #89). Best-effort: scaffold {{…}}
// and inferred "추정)" are positively marked; a confirmed slot drops its prefix
// so it isn't separately counted. Marker-less docs → dbdoc:false (plain render).
function docTiers(text) {
  const scaffold = (text.match(/\{\{[^}]*\}\}/g) || []).length;
  const inferred = (text.match(/추정\)/g) || []).length;
  return { dbdoc: /<!--\s*dbdoc:/.test(text) || scaffold > 0 || inferred > 0, scaffold, inferred };
}

function handleDocsList(req, res) {
  if (!statsGate(req, res)) return;
  const docs = [];
  try {
    for (const { id, index } of userDocIndexes(docsHomeDir())) {
      for (const e of resolveIndexEntries(index)) {
        let exists = true, bytes = 0, tiers = { dbdoc: false, scaffold: 0, inferred: 0 };
        try {
          const text = fs.readFileSync(e.abs, "utf8");
          bytes = Buffer.byteLength(text);
          tiers = docTiers(text);
        } catch { exists = false; }
        docs.push({ instance: id, index, path: e.abs, display: e.path, keywords: e.keywords, exists, bytes, tiers });
      }
    }
  } catch (e) { logSafe("docs list", e); return json(res, 500, { error: "docs failed" }); }
  json(res, 200, { count: docs.length, docs });
}

function docUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// realpath both the requested path and the allowlist so legit symlinked docs
// work while an escape (a symlink to /etc/… or a `..` climb) resolves OUTSIDE
// the allowed set and is refused.
function docsAllowReal() {
  const set = new Set();
  for (const { index } of userDocIndexes(docsHomeDir()))
    for (const e of resolveIndexEntries(index)) {
      try { set.add(fs.realpathSync(e.abs)); } catch { /* missing doc — skip */ }
    }
  let root = null;
  try { root = fs.realpathSync(path.join(docsHomeDir(), ".claude", "docs")); } catch { /* no docs dir */ }
  return { set, root };
}

function handleDocsContent(req, res, u) {
  if (!statsGate(req, res)) return;
  const raw = u.searchParams.get("path");
  if (!raw || raw.includes("\0")) return json(res, 400, { error: "path required" });
  let real;
  try { real = fs.realpathSync(path.resolve(expandTilde(raw))); }
  catch { return json(res, 404, { error: "not found" }); }
  const { set, root } = docsAllowReal();
  if (!set.has(real) && !(root && docUnder(real, root)))
    return json(res, 403, { error: "path not allowed" });
  let content;
  try {
    const st = fs.statSync(real);
    if (!st.isFile()) return json(res, 404, { error: "not found" });
    if (st.size > DOCS_MAX_BYTES) return json(res, 413, { error: "doc too large" });
    content = fs.readFileSync(real, "utf8");
  } catch (e) { logSafe("docs content", e); return json(res, 500, { error: "read failed" }); }
  json(res, 200, { path: real, bytes: Buffer.byteLength(content), content });
}

// ── GET /stats/turns (#73 — Turn Inspector, stage 1) ────────────────────────
// One session's events grouped into turns (UserPromptSubmit → last Stop before
// the next prompt) with per-call Pre↔Post pairing, the tool/wait/gap time split
// and inefficiency flags (docs/agent-dashboard-turn-inspector-design.md).
// Pairing runs over the WHOLE session, not the turn window — a background
// task's Post can land turns later, and a turn-scoped pair would fake an
// orphan. Payload-reading exception (see the stats-section header): bounded to
// ONE session, parsed only for UserPromptSubmit / PreToolUse / Notification /
// GuardDecision rows.

const TURN_RACE_MS = 1000;       // Stop landing ≤1s after a prompt = arrival race
const TURN_GUARD_CORR_MS = 3000; // GuardDecision ↔ orphan-Pre correlation window
const TURN_READONLY = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
const TURN_MUTATING = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function turnPayload(r) { // lazy parse, cached on the row
  if (r._p !== undefined) return r._p;
  let p = null;
  if (r.payload != null) { try { p = JSON.parse(r.payload); } catch {} }
  return (r._p = p);
}

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeysDeep(v[k]);
    return o;
  }
  return v;
}

// Normalized dup key; null = no verdict. A "[redacted …]" mask can make two
// different inputs collide, so masked inputs are conservatively exempt (§5:
// a missed dup beats a false accusation).
function turnInputKey(tool, inp) {
  let x = inp ?? null;
  if (tool === "Bash" && x && typeof x.command === "string")
    x = { ...x, command: x.command.replace(/\s+/g, " ").trim() };
  let s;
  try { s = JSON.stringify(sortKeysDeep(x)); } catch { return null; }
  if (s.includes("[redacted")) return null;
  return `${tool} ${s}`;
}

function turnClip(s, n) {
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Tool-aware one-line summary of tool_input (whitelisted fields only).
function turnInputSummary(tool, inp) {
  if (!inp || typeof inp !== "object") return "";
  const s = (v) => (typeof v === "string" ? v : "");
  if (tool === "Bash") return turnClip(s(inp.description) || s(inp.command).split("\n")[0], 120);
  if (tool === "Read") {
    let r = s(inp.file_path);
    if (inp.offset != null || inp.limit != null) r += ` :${inp.offset ?? 0}${inp.limit != null ? "+" + inp.limit : "-"}`;
    return turnClip(r, 120);
  }
  if (TURN_MUTATING.has(tool)) return turnClip(s(inp.file_path), 120);
  if (tool === "Grep") return turnClip([s(inp.pattern), s(inp.path) || s(inp.glob)].filter(Boolean).join("  "), 120);
  if (tool === "Glob") return turnClip(s(inp.pattern), 120);
  if (tool === "Task" || tool === "Agent")
    return turnClip([s(inp.description), s(inp.subagent_type) ? `(${inp.subagent_type})` : ""].filter(Boolean).join(" "), 120);
  if (tool === "WebFetch") return turnClip(s(inp.url), 120);
  if (tool === "WebSearch") return turnClip(s(inp.query), 120);
  try { return turnClip(JSON.stringify(sortKeysDeep(inp)), 120); } catch { return ""; }
}

// Merged length of [start,end) intervals — parallel calls must not count twice.
function turnUnionMs(intervals) {
  const iv = intervals.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  let total = 0, curS = null, curE = null;
  for (const [s0, e0] of iv) {
    if (curE == null || s0 > curE) { if (curE != null) total += curE - curS; curS = s0; curE = e0; }
    else if (e0 > curE) curE = e0;
  }
  if (curE != null) total += curE - curS;
  return total;
}

// rows: one session's events ASC by seq (payload only on the four parsed types).
// Returns turn objects with internal _calls/_markers kept for the detail view.
function buildTurns(rows, now) {
  // session-wide Pre↔Post pairing (a turn-scoped pair fakes orphans — §4.2)
  const pairs = new Map(); // tool_use_id → {pre, post}
  for (const r of rows) {
    if (!r.tool_use_id) continue;
    let p = pairs.get(r.tool_use_id);
    if (!p) pairs.set(r.tool_use_id, (p = { pre: null, post: null }));
    if (r.type === "PreToolUse" && !p.pre) p.pre = r;
    else if (r.type === "PostToolUse" && !p.post) p.post = r;
  }

  // segmentation (§4.1)
  const turns = [];
  let cur = null;
  // Harness-injected "prompts" (never typed by a human): a background task's
  // completion notification re-enters the loop as a synthetic user message and
  // fires UserPromptSubmit like any real prompt. Classify so the UI can label
  // the turn instead of dumping raw XML. Live share: 19/502 prompts.
  const AUTO_PROMPT_RE = /^\s*<(task-notification|system-reminder|local-command-caveat|command-name)\b/;
  const open = (r, virtual) => {
    const prompt = virtual ? null : (turnPayload(r)?.prompt ?? null);
    const auto = prompt != null ? (AUTO_PROMPT_RE.exec(prompt)?.[1] ?? null) : null;
    cur = {
      virtual, turn_seq: virtual ? 0 : r.seq, started_at: r.received_at,
      prompt, auto,
      queued: 0, events: [], stops: [],
    };
    turns.push(cur);
  };
  for (const r of rows) {
    if (r.type === "UserPromptSubmit") {
      // queued-prompt merge: ONLY when an in-flight Pre of the running turn
      // pairs with a Post after this prompt (proof the loop kept running).
      // Esc-then-retype leaves that Pre orphaned forever → split (§4.1 C-1).
      if (cur && !cur.virtual && !cur.stops.length && cur.events.some((e) =>
        e.type === "PreToolUse" && e.tool_use_id &&
        pairs.get(e.tool_use_id)?.post && pairs.get(e.tool_use_id).post.seq > r.seq)) {
        cur.queued++; cur.events.push(r); continue;
      }
      open(r, false); continue;
    }
    if (!cur) open(r, true); // virtual #0: residue before the first prompt
    // Arrival race: Stop and a queued prompt POST from separate hook processes;
    // a Stop generated just before the prompt can arrive just after it. No tool
    // activity yet + ≤1s → it ends the PREVIOUS turn (else this turn would
    // "complete" with zero calls and the previous one would look interrupted).
    if (r.type === "Stop" && !cur.virtual && turns.length >= 2 &&
        r.received_at - cur.started_at <= TURN_RACE_MS &&
        !cur.events.some((e) => e.type === "PreToolUse" || e.type === "PostToolUse")) {
      const prev = turns[turns.length - 2];
      prev.events.push(r); prev.stops.push(r);
      continue;
    }
    cur.events.push(r);
    if (r.type === "Stop") cur.stops.push(r);
  }

  const out = [];
  let n = 0;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const next = turns[i + 1] || null;
    const lastEv = t.events.length ? t.events[t.events.length - 1] : null;
    const lastAt = Math.max(t.started_at, lastEv ? lastEv.received_at : t.started_at);
    const lastStop = t.stops[t.stops.length - 1] || null;

    // status + main-chain end (§4.1)
    let status, ended_at;
    if (t.virtual) { status = "virtual"; ended_at = lastAt; }
    else if (lastStop) {
      status = "complete"; ended_at = lastStop.received_at;
      // A main-lane Pre AFTER the last Stop = the real final Stop got lost
      // (collector timeout/downtime) — extend the end, keep complete. A late
      // POST alone is a legitimate background tail and does NOT extend.
      for (const e of t.events) {
        if (e.seq > lastStop.seq && e.type === "PreToolUse" && !e.agent_id) {
          ended_at = Math.max(ended_at, e.received_at);
          const post = e.tool_use_id ? pairs.get(e.tool_use_id)?.post : null;
          if (post && (!next || post.seq < next.turn_seq)) ended_at = Math.max(ended_at, post.received_at);
        }
      }
    } else if (!next && now - lastAt < ACTIVE_MS) { status = "open"; ended_at = lastAt; }
    else { status = "interrupted"; ended_at = lastAt; }

    // calls: every Pre in this turn, paired session-wide (§4.2)
    const calls = [];
    let unpaired = 0;
    for (const e of t.events) {
      if (e.type === "PostToolUse") {
        const pr = e.tool_use_id ? pairs.get(e.tool_use_id) : null;
        if (!pr || !pr.pre) unpaired++; // reverse orphan: the Pre was lost/dropped
        continue;
      }
      if (e.type !== "PreToolUse") continue;
      if (!e.tool_use_id) { unpaired++; continue; }
      const pair = pairs.get(e.tool_use_id);
      if (pair.pre !== e) { unpaired++; continue; }
      const post = pair.post;
      const inp = turnPayload(e)?.tool_input;
      calls.push({
        tool_use_id: e.tool_use_id, tool_name: e.tool_name || "unknown",
        lane: e.agent_id ? "subagent" : "main", agent_id: e.agent_id || null,
        event_seq: e.seq, started_at: e.received_at, post,
        duration_ms: post ? post.received_at - e.received_at : null,
        status: post ? (post.error != null ? "error" : "ok")
          : (now - e.received_at >= TURN_ORPHAN_MS ? "orphan" : "pending"),
        error: post && post.error != null ? String(post.error).slice(0, 200) : null,
        input: inp && typeof inp === "object" ? inp : null,
        input_summary: turnInputSummary(e.tool_name, inp),
        key: turnInputKey(e.tool_name, inp),
        bg: !!(inp && inp.run_in_background === true),
        crosses_turn: !!(post && next && post.seq >= next.turn_seq),
        tail: !!(lastStop && e.seq > lastStop.seq),
        dup_of: null, gap_before_ms: null, parallel: false, wait_ms: 0,
      });
    }
    const mainCalls = calls.filter((c) => c.lane === "main");

    // gap-before + parallel badge (main lane, §4.3): negative gap = overlap → 0
    let runEnd = t.started_at;
    for (const c of mainCalls) {
      c.parallel = c.started_at < runEnd;
      c.gap_before_ms = Math.max(0, c.started_at - runEnd);
      runEnd = Math.max(runEnd, c.post ? c.post.received_at : c.started_at);
    }

    // markers (§4.2) + permission wait (§4.3). The permission dialog sits INSIDE
    // the call's [Pre,Post] (hook → dialog → approve → run → Post), so its span
    // must come OUT of that call's tool time or it double-counts. Idle
    // notifications ("waiting for your input", 95% live share) are marker-only.
    const markers = [];
    let wait_ms = 0, guard_denies = 0, notifications = 0, precompacts = 0;
    for (const e of t.events) {
      if (e.type === "Notification") {
        notifications++;
        const kind = /permission/i.test(String(turnPayload(e)?.message ?? "")) ? "permission" : "idle";
        const m = { type: "Notification", kind, at: e.received_at, wait_ms: null };
        if (kind === "permission" && e.received_at <= ended_at) {
          const encl = mainCalls.find((c) => c.post && c.started_at <= e.received_at && c.post.received_at >= e.received_at);
          const rawEnd = encl ? encl.post.received_at
            : (t.events.find((x) => x.seq > e.seq)?.received_at ?? ended_at); // denied → next event
          const w = Math.min(Math.max(0, rawEnd - e.received_at), TURN_WAIT_CAP_MS);
          m.wait_ms = w; wait_ms += w;
          if (encl) encl.wait_ms += w;
        }
        markers.push(m);
      } else if (e.type === "GuardDecision") {
        // hook-guard deny is the DOMINANT orphan cause (238/396 live, vs 9 for
        // permission). The guard now stamps the blocked call's tool_use_id into
        // the payload — prefer an EXACT match (right call even with multiple
        // orphans, and robust to >3s clock skew); fall back to the ±3s time
        // window only for legacy rows / older guards that carry no id.
        const p = turnPayload(e) || {};
        const gTid = typeof p.tool_use_id === "string" ? p.tool_use_id : null;
        const corr = gTid
          ? calls.find((c) => c.tool_use_id === gTid)
          : calls.find((c) => c.status === "orphan" && Math.abs(c.started_at - e.received_at) <= TURN_GUARD_CORR_MS);
        // Count only denies that actually orphaned a call — an ask→approved
        // matches its (completed) call by id and must NOT inflate guard_denies.
        if (corr && corr.status === "orphan") guard_denies++;
        markers.push({
          type: "GuardDecision", at: e.received_at, guard: p.guard ?? null,
          rule: p.rule ?? null, decision: p.decision ?? null,
          correlated_tool_use_id: corr ? corr.tool_use_id : null,
        });
      } else if (e.type === "PreCompact") { precompacts++; markers.push({ type: "PreCompact", at: e.received_at }); }
      else if (e.type === "SubagentStop") markers.push({ type: "SubagentStop", at: e.received_at, agent_id: e.agent_id || null });
      else if (e.type === "Stop") markers.push({ type: "Stop", at: e.received_at });
      else if (e.type === "SessionEnd") markers.push({ type: "SessionEnd", at: e.received_at });
    }

    // time split (§4.3): tool = union of main [Pre,Post] clipped to the turn
    // window minus permission-wait spans; gap = the unexplained rest
    // (generation, API latency, unobserved waits). Post-stop tail excluded.
    const mainIv = [], subIv = [];
    const ownEnd = next ? next.started_at : Infinity;
    for (const c of calls) {
      if (!c.post) continue;
      if (c.lane === "subagent") {
        subIv.push([Math.max(c.started_at, t.started_at), Math.min(c.post.received_at, ownEnd)]);
        continue;
      }
      if (c.tail) continue;
      const a = Math.max(c.started_at, t.started_at);
      let b = Math.min(c.post.received_at, ended_at);
      if (c.wait_ms > 0) b = Math.min(b, c.post.received_at - c.wait_ms); // carve the wait out
      mainIv.push([a, b]);
    }
    const tool_ms = turnUnionMs(mainIv);
    const subagent_ms = turnUnionMs(subIv);
    const duration_ms = Math.max(0, ended_at - t.started_at);
    const gap_ms = Math.max(0, duration_ms - tool_ms - wait_ms);

    // dup detection (main lane, §5): a state change between two identical calls
    // (any Bash, or an Edit/Write to the same file) legitimizes the re-run.
    const firstByKey = new Map();
    let dup_calls = 0;
    for (let k = 0; k < mainCalls.length; k++) {
      const c = mainCalls[k];
      if (!c.key) continue;
      const prev = firstByKey.get(c.key);
      if (prev === undefined) { firstByKey.set(c.key, k); continue; }
      const file = c.input && typeof c.input.file_path === "string" ? c.input.file_path : null;
      let invalidated = false;
      for (let j = prev + 1; j < k && !invalidated; j++) {
        const b = mainCalls[j];
        if (b.tool_name === "Bash") invalidated = true;
        else if (TURN_MUTATING.has(b.tool_name) && file && b.input && b.input.file_path === file) invalidated = true;
      }
      if (invalidated) { firstByKey.set(c.key, k); continue; }
      c.dup_of = mainCalls[prev].tool_use_id;
      dup_calls++;
    }

    // re-read (§5): ≥N Reads of one file with OVERLAPPING ranges — disjoint
    // chunked reads of a big file are the correct pattern, not waste.
    let reread = false;
    {
      const byFile = new Map();
      for (const c of mainCalls) {
        if (c.tool_name !== "Read" || !c.input || typeof c.input.file_path !== "string") continue;
        const off = c.input.offset != null && Number.isFinite(Number(c.input.offset)) ? Number(c.input.offset) : 0;
        const lim = c.input.limit != null && Number.isFinite(Number(c.input.limit)) ? Number(c.input.limit) : Infinity;
        const arr = byFile.get(c.input.file_path) || [];
        arr.push([off, off + lim]);
        byFile.set(c.input.file_path, arr);
      }
      for (const ranges of byFile.values()) {
        if (ranges.length < TURN_FLAGS.reread) continue;
        let overlapping = 0;
        for (let a = 0; a < ranges.length; a++) {
          if (ranges.some((r2, b2) => b2 !== a && ranges[a][0] < r2[1] && r2[0] < ranges[a][1])) overlapping++;
        }
        if (overlapping >= TURN_FLAGS.reread) { reread = true; break; }
      }
    }

    // retry-loop (§5): the SAME call (tool+input) erroring ≥N times, allowing
    // one read-only look between attempts — lint→typecheck→test failing in a
    // row is three different checks, not a loop.
    let retry = false;
    {
      let key = null, count = 0, slack = 0;
      for (const c of mainCalls) {
        if (c.key && c.status === "error") {
          count = c.key === key ? count + 1 : 1;
          key = c.key; slack = 0;
          if (count >= TURN_FLAGS.retry) { retry = true; break; }
        } else if (key && TURN_READONLY.has(c.tool_name) && slack === 0) {
          slack = 1; // one read-only call keeps the chain alive
        } else { key = null; count = 0; slack = 0; }
      }
    }

    // search-storm (§5): Grep/Glob batches before the first Read/Edit. A
    // parallel/near-simultaneous batch is ONE probe, not five.
    let storm = false;
    {
      let batches = 0, lastStart = null;
      for (const c of mainCalls) {
        if (c.tool_name === "Read" || TURN_MUTATING.has(c.tool_name)) break;
        if (c.tool_name !== "Grep" && c.tool_name !== "Glob") continue;
        if (lastStart == null || (!c.parallel && c.started_at - lastStart > TURN_FLAGS.storm_batch_gap_ms)) batches++;
        lastStart = c.started_at;
      }
      storm = batches >= TURN_FLAGS.storm;
    }

    const errors = calls.filter((c) => c.status === "error").length;
    const orphans = calls.filter((c) => c.status === "orphan").length;
    const mainOrphans = mainCalls.filter((c) => c.status === "orphan").length;
    const longest = mainCalls.filter((c) => c.duration_ms != null)
      .reduce((m, c) => (!m || c.duration_ms > m.duration_ms ? c : m), null);

    const flags = [];
    if (!t.virtual) { // #0 holds residue/trimmed bodies — never judged (§4.1)
      if (dup_calls >= TURN_FLAGS.dup - 1) flags.push("dup-call");
      if (reread) flags.push("re-read");
      if (retry) flags.push("retry-loop");
      if (storm) flags.push("search-storm");
      if (longest && longest.duration_ms - longest.wait_ms >= TURN_FLAGS.longtail_ms &&
          tool_ms > 0 && longest.duration_ms - longest.wait_ms >= TURN_FLAGS.longtail_share * tool_ms) flags.push("long-tail");
      if (gap_ms >= TURN_FLAGS.gap_ratio * tool_ms && gap_ms >= TURN_FLAGS.gap_min_ms) flags.push("gap-heavy");
      if (mainOrphans >= 1) flags.push("orphaned");
      if (mainCalls.length >= TURN_FLAGS.mega_calls || duration_ms >= TURN_FLAGS.mega_ms) flags.push("mega-turn");
    }

    out.push({
      turn_seq: t.turn_seq, n: t.virtual ? 0 : ++n,
      prompt: t.prompt != null ? turnClip(t.prompt, 200) : null,
      auto: t.auto, // harness-injected prompt kind (task-notification, …) | null = human
      queued_prompts: t.queued,
      started_at: t.started_at, ended_at, status, duration_ms,
      tool_ms, gap_ms, wait_ms,
      calls: calls.length, errors, orphans, unpaired, guard_denies,
      distinct_tools: new Set(calls.map((c) => c.tool_name)).size,
      dup_calls,
      subagent_calls: calls.length - mainCalls.length,
      subagents: new Set(calls.filter((c) => c.agent_id).map((c) => c.agent_id)).size,
      subagent_ms,
      post_stop_events: lastStop ? t.events.filter((e) => e.seq > lastStop.seq).length : 0,
      longest: longest ? { tool_name: longest.tool_name, duration_ms: longest.duration_ms } : null,
      precompacts, notifications, flags,
      _prompt_raw: t.prompt, _calls: calls, _markers: markers,
    });
  }
  return out;
}

// #73 stage 3 + #81: per-turn cost from the usage table. One usage row lands in
// exactly ONE bucket (no double counting): emitted-id match first, follows only
// when emitted is EMPTY (the row after a tool-ending turn follows the previous
// turn's ids — emitted-first blocks that misattribution), ts window last, else
// `unattributed` — surfaced in the drill so cost never silently evaporates.
// Since #81 sidechain rows exist (subagent transcripts ARE ingested): their
// emitted ids match the agent's own tool calls, which already sit in the turn
// map's subagent lane — the same id join attributes them, summed SEPARATELY as
// cost_subagent_usd. Mutates each turn's cost_usd / cost_subagent_usd (null =
// zero rows attributed, NEVER $0.00) and returns
// { usage_cost_usd, unattributed_cost_usd } | null when usage is empty.
function attachTurnCosts(all, sid) {
  let usage;
  try {
    usage = db.impl.prepare(
      `SELECT ts, model, input, output, cache_create, cache_read, cache_create_1h,
              sidechain, emitted_tool_ids, follows_tool_ids
         FROM usage WHERE session_id = ?`
    ).all(sid);
  } catch (e) { logSafe("turns cost", e); usage = []; }
  if (!usage.length) { for (const t of all) { t.cost_usd = null; t.cost_subagent_usd = null; } return null; }
  const turnByToolId = new Map();
  for (const t of all) for (const c of t._calls) turnByToolId.set(c.tool_use_id, t);
  const ids = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } };
  const sums = new Map(); // turn → {usd, rows, subUsd, subRows}
  let total = 0, unattributed = 0;
  for (const r of usage) {
    const p = priceOf(r.model);
    const usd = p ? costOf(p, r.input, r.output, r.cache_create, r.cache_read, r.cache_create_1h || 0) : 0;
    total += usd;
    let target = null;
    const emitted = ids(r.emitted_tool_ids);
    for (const id of emitted) if (turnByToolId.has(id)) { target = turnByToolId.get(id); break; }
    if (!target && !emitted.length)
      for (const id of ids(r.follows_tool_ids)) if (turnByToolId.has(id)) { target = turnByToolId.get(id); break; }
    if (!target) {
      const ts = Number(r.ts); // transcript time vs received_at — documented skew
      target = all.find((t) => ts >= t.started_at && ts <= t.ended_at) || null;
    }
    if (target) {
      const s = sums.get(target) || { usd: 0, rows: 0, subUsd: 0, subRows: 0 };
      if (r.sidechain) { s.subUsd += usd; s.subRows++; } else { s.usd += usd; s.rows++; }
      sums.set(target, s);
    } else unattributed += usd; // inter-turn ts, resume re-ingest ghosts, retention gaps
  }
  for (const t of all) {
    const s = sums.get(t);
    t.cost_usd = s && s.rows ? roundUsd(s.usd) : null;
    t.cost_subagent_usd = s && s.subRows ? roundUsd(s.subUsd) : null;
  }
  return { usage_cost_usd: roundUsd(total), unattributed_cost_usd: roundUsd(unattributed) };
}

// ── #82 fleet turn materialization ──────────────────────────────────────────
// Persist SETTLED turns (one summary row each) by RE-RUNNING buildTurns +
// attachTurnCosts per session and writing the output — buildTurns stays the
// single source of truth (fleet aggregates and the drill-down agree by
// construction). Runs IN-PROCESS on the shared db.impl connection: buildTurns is
// milliseconds (not the blocking LLM the titler needs a detached child for), so
// writes serialize on the event loop and there is NO cross-connection WAL
// contention / spill risk. The design's adversarial review forced five guards,
// tagged inline: [gate] [reconcile] [freeze] [arrival-wm] [residual].
const TURN_MAT_AUTO = process.env.OBS_TURN_MAT !== "0";
const TURN_MAT_INTERVAL_MS = intEnv("OBS_TURN_MAT_INTERVAL_SEC", 120) * 1000;
const TURN_MAT_LIMIT = intEnv("OBS_TURN_MAT_LIMIT", 50); // sessions per auto tick (bounds event-loop stall)

const FLAG_BIT = { // 8 inefficiency flags → bitmask (fixed order, append-only)
  "dup-call": 1, "re-read": 2, "retry-loop": 4, "search-storm": 8,
  "long-tail": 16, "gap-heavy": 32, "orphaned": 64, "mega-turn": 128,
};
function flagsMask(flags) { let m = 0; for (const f of flags || []) m |= (FLAG_BIT[f] || 0); return m; }

// Stable hash of the flag-affecting config; a change makes non-frozen sessions
// candidates so their flags recompute against the new thresholds (§8).
function configVer() {
  const parts = Object.keys(TURN_FLAGS).sort().map((k) => k + "=" + TURN_FLAGS[k]);
  parts.push("orphan=" + TURN_ORPHAN_MS, "waitcap=" + TURN_WAIT_CAP_MS);
  const s = parts.join("|");
  let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

// same events as the drill-down (handleStatsTurns) + source_app for the fleet axis
function turnEventsForSession(sid) {
  return db.impl.prepare(
    `SELECT seq, hook_event_type AS type, tool_name, tool_use_id, agent_id, error, received_at, source_app,
            CASE WHEN hook_event_type IN ('UserPromptSubmit','PreToolUse','Notification','GuardDecision')
                 THEN payload END AS payload
       FROM events WHERE session_id = ? ORDER BY seq ASC`
  ).all(sid);
}
// [arrival-wm] session usage watermark = MAX(inserted_at) (arrival time), NOT
// MAX(ts) — late subagent-tail rows carry mid-session ts, and a --rescan rewrites
// cost without moving ts, so a ts watermark would miss both.
function sessionUsageEpoch(sid) {
  try { const r = db.impl.prepare("SELECT MAX(inserted_at) AS e FROM usage WHERE session_id = ?").get(sid);
    return r && r.e != null ? Number(r.e) : 0; } catch { return 0; }
}

const TURN_UPSERT_SQL = `INSERT INTO turns
  (session_id, turn_seq, source_app, n, status, auto, started_at, ended_at, duration_ms,
   tool_ms, wait_ms, gap_ms, calls, subagent_calls, distinct_tools, errors, orphans, dup_calls,
   guard_denies, queued_prompts, precompacts, cost_usd, cost_subagent_usd, cost_has_gap,
   flags, flags_mask, config_ver, materialized_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(session_id, turn_seq) DO UPDATE SET
   source_app=excluded.source_app, n=excluded.n, status=excluded.status, auto=excluded.auto,
   started_at=excluded.started_at, ended_at=excluded.ended_at, duration_ms=excluded.duration_ms,
   tool_ms=excluded.tool_ms, wait_ms=excluded.wait_ms, gap_ms=excluded.gap_ms,
   calls=excluded.calls, subagent_calls=excluded.subagent_calls, distinct_tools=excluded.distinct_tools,
   errors=excluded.errors, orphans=excluded.orphans, dup_calls=excluded.dup_calls,
   guard_denies=excluded.guard_denies, queued_prompts=excluded.queued_prompts, precompacts=excluded.precompacts,
   cost_usd=excluded.cost_usd, cost_subagent_usd=excluded.cost_subagent_usd, cost_has_gap=excluded.cost_has_gap,
   flags=excluded.flags, flags_mask=excluded.flags_mask, config_ver=excluded.config_ver,
   materialized_at=excluded.materialized_at`;

// Materialize one session's settled turns in ONE short transaction. Returns a
// small status object (never throws — caller may still guard).
function materializeSession(sid, now, cv) {
  const rows = turnEventsForSession(sid);
  if (!rows.length) return { skipped: true };
  const minSeq = rows[0].seq, maxSeq = rows[rows.length - 1].seq;
  const lastAt = rows[rows.length - 1].received_at;
  const app = rows[rows.length - 1].source_app || rows[0].source_app || "?";
  const sessionEnded = rows.some((r) => r.type === "SessionEnd");
  const cur = db.impl.prepare("SELECT * FROM turn_cursor WHERE session_id = ?").get(sid) || null;

  // [freeze] early events trimmed (live MIN(seq) rose above the anchor) → the
  // session can no longer be re-derived correctly. Keep the good historical rows;
  // never re-run buildTurns over the truncated stream, never advance config_ver.
  if (cur && cur.min_event_seq_seen > 0 && minSeq > cur.min_event_seq_seen) {
    db.impl.prepare("UPDATE turn_cursor SET frozen = 1, stale_config = ?, updated_at = ? WHERE session_id = ?")
      .run(cur.config_ver !== cv ? 1 : 0, now, sid);
    return { frozen: true };
  }

  const all = buildTurns(rows, now);
  const costs = attachTurnCosts(all, sid); // sets t.cost_usd / t.cost_subagent_usd
  const usageTotal = costs ? costs.usage_cost_usd : null;

  // [gate] settle rule (§3): drop the open last turn (unless SessionEnd or the
  // session is idle ≥ TURN_ORPHAN_MS), and DEFER any turn still holding an
  // unresolved main-lane Pre (status 'pending' — no Post yet, not yet aged to
  // orphan) so its orphan/guard-deny/flag numbers are not frozen wrong.
  const idle = now - lastAt >= TURN_ORPHAN_MS;
  const settled = [];
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (i === all.length - 1 && !(sessionEnded || idle)) continue;
    if (t._calls.some((c) => c.lane === "main" && c.status === "pending")) continue;
    settled.push(t);
  }
  const currentSeqs = all.map((t) => t.turn_seq);
  let sumSettled = 0;
  for (const t of settled) sumSettled += (t.cost_usd || 0) + (t.cost_subagent_usd || 0);
  // [residual] unattributed = session total − Σ settled, so the dropped open turn
  // and any not-yet-settled turn's cost is absorbed here (invariant preserved).
  const unattributed = usageTotal == null ? null : roundUsd(usageTotal - sumSettled);
  const lastTurnSeq = settled.length ? settled[settled.length - 1].turn_seq : 0;
  const usageEpoch = sessionUsageEpoch(sid);

  try {
    db.impl.exec("BEGIN IMMEDIATE");
    // [reconcile] delete rows whose turn_seq no longer exists — queued-merge /
    // arrival-race can reclassify a boundary so a previously-settled turn_seq
    // vanishes; an upsert alone would leave it as a ghost double-count.
    if (currentSeqs.length) {
      db.impl.prepare(`DELETE FROM turns WHERE session_id = ? AND turn_seq NOT IN (${currentSeqs.map(() => "?").join(",")})`)
        .run(sid, ...currentSeqs);
    } else db.impl.prepare("DELETE FROM turns WHERE session_id = ?").run(sid);
    const upsert = db.impl.prepare(TURN_UPSERT_SQL);
    for (const t of settled) {
      upsert.run(sid, t.turn_seq, app, t.n, t.status, t.auto ?? null,
        t.started_at, t.ended_at, t.duration_ms, t.tool_ms, t.wait_ms, t.gap_ms,
        t.calls, t.subagent_calls, t.distinct_tools, t.errors, t.orphans, t.dup_calls,
        t.guard_denies, t.queued_prompts, t.precompacts,
        t.cost_usd ?? null, t.cost_subagent_usd ?? null, t.precompacts > 0 ? 1 : 0, // cost_has_gap: compaction spend absent from usage (§6)
        JSON.stringify(t.flags || []), flagsMask(t.flags), cv, now);
    }
    const minSeen = cur ? cur.min_event_seq_seen : minSeq; // anchor set ONCE, on first materialization
    db.impl.prepare(`INSERT INTO turn_cursor
      (session_id, materialized_through_seq, min_event_seq_seen, usage_epoch_seen, last_turn_seq,
       unattributed_cost_usd, config_ver, session_ended, frozen, stale_config, updated_at)
      VALUES (?,?,?,?,?,?,?,?,0,0,?)
      ON CONFLICT(session_id) DO UPDATE SET
       materialized_through_seq=excluded.materialized_through_seq, usage_epoch_seen=excluded.usage_epoch_seen,
       last_turn_seq=excluded.last_turn_seq, unattributed_cost_usd=excluded.unattributed_cost_usd,
       config_ver=excluded.config_ver, session_ended=MAX(turn_cursor.session_ended, excluded.session_ended),
       stale_config=0, updated_at=excluded.updated_at`)
      .run(sid, maxSeq, minSeen, usageEpoch, lastTurnSeq, unattributed, cv, sessionEnded ? 1 : 0, now);
    db.impl.exec("COMMIT");
  } catch (e) {
    try { db.impl.exec("ROLLBACK"); } catch {}
    logSafe("materialize session", e);
    return { error: true };
  }
  return { settled: settled.length, total: all.length };
}

// Cheap candidate scan: sessions whose materialization may be stale. Recently
// active sessions are re-checked so time-based settling (idle / a Pre aging to
// orphan) lands even without new events. Frozen sessions are excluded.
function turnCandidates(now, cv, limit) {
  let ev, us, cursors;
  try {
    ev = db.impl.prepare("SELECT session_id, MAX(seq) AS maxseq, MAX(received_at) AS last_at FROM events GROUP BY session_id").all();
    us = db.impl.prepare("SELECT session_id, MAX(inserted_at) AS epoch FROM usage GROUP BY session_id").all();
    cursors = db.impl.prepare("SELECT * FROM turn_cursor").all();
  } catch (e) { logSafe("turn candidates", e); return []; }
  const usMap = new Map(us.map((r) => [r.session_id, Number(r.epoch) || 0]));
  const cMap = new Map(cursors.map((c) => [c.session_id, c]));
  const out = [];
  for (const e of ev) {
    const c = cMap.get(e.session_id);
    if (c && c.frozen) continue;
    const recent = now - Number(e.last_at) < TURN_ORPHAN_MS * 2; // re-check window for time-based settling
    if (!c || Number(e.maxseq) > c.materialized_through_seq ||
        (usMap.get(e.session_id) || 0) > c.usage_epoch_seen || c.config_ver !== cv || recent) {
      out.push(e.session_id);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function materializeSweep(now, limit) {
  if (!db) return { sessions: 0, candidates: 0 };
  const cv = configVer();
  const cands = turnCandidates(now, cv, limit);
  let done = 0;
  for (const sid of cands) { try { materializeSession(sid, now, cv); done++; } catch (e) { logSafe("materialize", e); } }
  return { sessions: done, candidates: cands.length };
}

// In-process auto-materializer (shared connection → no WAL contention). Bounded
// per tick so a backlog can't stall ingest/SSE for long. Timers unref'd.
function startAutoMaterializer() {
  if (!TURN_MAT_AUTO) return;
  const tick = () => { try { materializeSweep(Date.now(), TURN_MAT_LIMIT); } catch (e) { logSafe("auto-materialize", e); } };
  setTimeout(tick, Math.min(30_000, TURN_MAT_INTERVAL_MS)).unref();
  setInterval(tick, TURN_MAT_INTERVAL_MS).unref();
}

function handleStatsTurns(req, res, u) {
  if (!statsGate(req, res)) return;
  const sid = u.searchParams.get("session_id");
  if (!sid) return json(res, 400, { error: "turns needs session_id" });
  if (!db) return json(res, 200, { session_id: sid, count: 0, turns: [] });
  let limit = Math.trunc(Number(u.searchParams.get("limit"))) || 100;
  limit = Math.min(Math.max(1, limit), 500);
  const turnParam = u.searchParams.get("turn");
  try {
    const rows = db.impl.prepare(
      `SELECT seq, hook_event_type AS type, tool_name, tool_use_id, agent_id, error, received_at,
              CASE WHEN hook_event_type IN ('UserPromptSubmit','PreToolUse','Notification','GuardDecision')
                   THEN payload END AS payload
         FROM events WHERE session_id = ? ORDER BY seq ASC`
    ).all(sid);
    const all = buildTurns(rows, Date.now());
    const costs = attachTurnCosts(all, sid); // sets each turn's cost_usd (#73 stage 3)
    const strip = ({ _prompt_raw, _calls, _markers, ...s }) => s;
    if (turnParam != null && turnParam !== "") {
      const t = all.find((x) => x.turn_seq === Number(turnParam));
      if (!t) return json(res, 404, { error: "turn not found (retention may have trimmed it)" });
      return json(res, 200, {
        turn: strip(t),
        prompt_full: t._prompt_raw != null ? String(t._prompt_raw).slice(0, 2000) : null,
        calls: t._calls.map((c) => ({
          tool_use_id: c.tool_use_id, tool_name: c.tool_name, lane: c.lane, agent_id: c.agent_id,
          event_seq: c.event_seq, started_at: c.started_at, duration_ms: c.duration_ms,
          gap_before_ms: c.lane === "main" ? c.gap_before_ms : null,
          status: c.status, error: c.error, input_summary: c.input_summary,
          dup_of: c.dup_of, crosses_turn: c.crosses_turn, bg: c.bg, parallel: c.parallel,
          tail: c.tail, wait_ms: c.wait_ms,
        })),
        markers: t._markers,
      });
    }
    // limit = the LATEST N turns (audits look at recent work first)
    const turns = all.slice(-limit).map(strip);
    json(res, 200, {
      session_id: sid, count: turns.length, turns,
      usage_cost_usd: costs ? costs.usage_cost_usd : null,
      unattributed_cost_usd: costs ? costs.unattributed_cost_usd : null,
    });
  } catch (e) { logSafe("stats turns", e); json(res, 500, { error: "query failed" }); }
}

// ── GET /stats/fleet-turns (#82 stage 2) ────────────────────────────────────
// Fleet-wide turn aggregates over the MATERIALIZED `turns` table (no payload
// read — that is the whole point of stage 1). Efficiency ratios exclude virtual
// (#0) and harness-`auto` turns; cost totals include everything. `by_flag` cost
// is "cost of turns carrying the flag" (an attention signal, NOT savings — a turn
// with k flags counts in k buckets, so Σ by_flag ≠ total; the UI labels this).
function handleStatsFleetTurns(req, res, u) {
  if (!statsGate(req, res)) return;
  const window_ms = windowOf(u, "7d");
  const app = u.searchParams.get("source_app") || u.searchParams.get("app") || null;
  const empty = { window_ms, source_app: app, bucket_ms: 0, totals: null, by_flag: [], by_app: [], series: [] };
  if (!db) return json(res, 200, empty);
  const since = Date.now() - window_ms;
  const r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;
  try {
    const where = app ? "started_at >= ? AND source_app = ?" : "started_at >= ?";
    const params = app ? [since, app] : [since];
    const rows = db.impl.prepare(
      `SELECT session_id, source_app, status, auto, started_at, calls, errors, orphans,
              cost_usd, cost_subagent_usd, cost_has_gap, flags_mask
         FROM turns WHERE ${where}`
    ).all(...params);
    if (!rows.length) return json(res, 200, { ...empty, totals: { settled_turns: 0 } });

    const bit = (f) => FLAG_BIT[f];
    const hasFlag = (r, f) => (r.flags_mask & bit(f)) !== 0;
    const isHuman = (r) => r.auto == null && r.status !== "virtual"; // efficiency denominator
    const human = rows.filter(isHuman);
    const sum = (arr, fn) => arr.reduce((s, r) => s + fn(r), 0);

    // unattributed is a per-session residual (turn_cursor) — sum over the sessions present in this window
    const sids = [...new Set(rows.map((r) => r.session_id))];
    let unatt = 0;
    try {
      const q = db.impl.prepare(`SELECT COALESCE(SUM(unattributed_cost_usd),0) u FROM turn_cursor WHERE session_id IN (${sids.map(() => "?").join(",")})`).get(...sids);
      unatt = q ? q.u || 0 : 0;
    } catch (e) { logSafe("fleet unattributed", e); }

    const totals = {
      settled_turns: rows.length,
      human_turns: human.length,
      avg_calls_per_turn: human.length ? r2(sum(human, (r) => r.calls) / human.length) : 0,
      dup_call_turn_ratio: human.length ? r3(human.filter((r) => hasFlag(r, "dup-call")).length / human.length) : 0,
      gap_heavy_turns: rows.filter((r) => hasFlag(r, "gap-heavy")).length,
      mega_turns: rows.filter((r) => hasFlag(r, "mega-turn")).length,
      interrupted_turns: rows.filter((r) => r.status === "interrupted").length,
      orphan_turns: rows.filter((r) => hasFlag(r, "orphaned")).length,
      total_cost_usd: roundUsd(sum(rows, (r) => r.cost_usd || 0)),
      total_subagent_cost_usd: roundUsd(sum(rows, (r) => r.cost_subagent_usd || 0)),
      unattributed_cost_usd: roundUsd(unatt),
      cost_incomplete_turns: rows.filter((r) => r.cost_has_gap).length,
    };

    const by_flag = Object.keys(FLAG_BIT).map((f) => ({
      flag: f,
      turns: rows.filter((r) => hasFlag(r, f)).length,
      cost_usd: roundUsd(sum(rows.filter((r) => hasFlag(r, f)), (r) => r.cost_usd || 0)),
    })).filter((x) => x.turns > 0).sort((a, b) => b.turns - a.turns);

    const appMap = new Map();
    for (const r of rows) {
      const a = r.source_app || "?";
      let m = appMap.get(a);
      if (!m) appMap.set(a, (m = { app: a, turns: 0, human: 0, calls: 0, cost: 0 }));
      m.turns++;
      if (isHuman(r)) { m.human++; m.calls += r.calls; }
      m.cost += (r.cost_usd || 0) + (r.cost_subagent_usd || 0);
    }
    const by_app = [...appMap.values()].map((m) => ({
      app: m.app, turns: m.turns, avg_calls: m.human ? r2(m.calls / m.human) : 0, cost_usd: roundUsd(m.cost),
    })).sort((a, b) => b.cost_usd - a.cost_usd);

    const bucket_ms = window_ms <= 86_400_000 ? 3_600_000 : 86_400_000; // hourly ≤1d, else daily
    const bMap = new Map();
    for (const r of rows) {
      const t = Math.floor(r.started_at / bucket_ms) * bucket_ms;
      let b = bMap.get(t);
      if (!b) bMap.set(t, (b = { t, turns: 0, human: 0, calls: 0, cost: 0 }));
      b.turns++;
      if (isHuman(r)) { b.human++; b.calls += r.calls; }
      b.cost += (r.cost_usd || 0) + (r.cost_subagent_usd || 0);
    }
    const series = [...bMap.values()].map((b) => ({
      t: b.t, turns: b.turns, avg_calls: b.human ? r2(b.calls / b.human) : 0, cost_usd: roundUsd(b.cost),
    })).sort((a, b) => a.t - b.t);

    json(res, 200, { window_ms, bucket_ms, source_app: app, totals, by_flag, by_app, series });
  } catch (e) { logSafe("stats fleet-turns", e); json(res, 500, { error: "query failed" }); }
}

// ── dashboard (dependency-free, same-origin — design §8) ────────────────────
// Strict CSP: the page loads /app.js from 'self' (no inline script), and the JS
// renders every value via textContent (never innerHTML), so attacker-influenced
// payloads can't execute. No Access-Control-Allow-Origin is ever emitted.
const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude observability</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0b0e14;color:#c8d0dc}
header{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid #1c2230;position:sticky;top:0;background:#0b0e14;z-index:2}
header h1{font-size:13px;margin:0;font-weight:600;color:#e6edf3;letter-spacing:.02em}
nav{display:flex;gap:2px}
nav a{color:#6b7686;text-decoration:none;padding:3px 10px;border-radius:4px}
nav a.on{color:#e6edf3;background:#1a2130}
#status{font-size:12px}
#status.ok{color:#3fb950}#status.warn{color:#d29922}#status.err{color:#f85149}
#meta{margin-left:auto;color:#6b7686;font-size:12px}
#fleet{display:flex;flex-wrap:wrap;gap:8px;padding:8px 16px;border-bottom:1px solid #141a26;background:#0d1119}
#fleet .car{display:flex;gap:8px;align-items:baseline;padding:2px 10px;border:1px solid #1c2230;border-radius:4px;font-size:12px}
#fleet .dot{color:#3fb950}
#fleet .app{color:#e6edf3;font-weight:600}
#fleet .what{color:#79c0ff}
#fleet .ago,#fleet .none{color:#6b7686}
section{display:none}
section.on{display:block}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:4px 10px;border-bottom:1px solid #141a26;vertical-align:top;white-space:nowrap}
th{position:sticky;top:41px;background:#0b0e14;color:#6b7686;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
td.evt{color:#79c0ff}
td.num,th.num{text-align:right}
td.pay{white-space:pre-wrap;word-break:break-word;max-width:60vw;color:#8b949e}
tbody tr:hover{background:#11161f}
tbody tr.sess{cursor:pointer}
.bar{fill:#2f6feb}
.spark{stroke:#3fb950;fill:none;stroke-width:1.5}
.err{color:#f85149}.warn{color:#d29922}.ok{color:#3fb950}.dim{color:#6b7686}
.tsc{color:#6b7686}.tin{color:#d29922}
#doc-view{margin-top:14px}
#doc-view h2,#doc-view h3,#doc-view h4,#doc-view h5,#doc-view h6{margin:12px 0 4px}
#doc-view .doc{border:1px solid #1c2230;border-radius:6px;padding:12px 16px;background:#0d1119;line-height:1.5}
#doc-view .doc pre{background:#161b22;padding:8px 10px;border-radius:4px;overflow-x:auto;white-space:pre-wrap}
#doc-view .doc p{margin:6px 0}#doc-view .doc ul{margin:6px 0 6px 20px}
#doc-view .doc table.doc-tbl{border-collapse:collapse;margin:8px 0;font-size:12px;display:block;overflow-x:auto;max-width:100%}
#doc-view .doc table.doc-tbl th,#doc-view .doc table.doc-tbl td{border:1px solid #1c2230;padding:4px 8px;text-align:left;vertical-align:top;white-space:pre-wrap}
/* override the global stats-table th (position:sticky;top:41px;uppercase;gray;11px) so it doesn't leak into doc tables and float/overlap the header — #110 */
#doc-view .doc table.doc-tbl th{background:#161b22;color:#c8d0dc;font-weight:600;font-size:12px;white-space:nowrap;position:static;top:auto;text-transform:none;letter-spacing:normal}
#doc-view .doc hr{border:0;border-top:1px solid #1c2230;margin:12px 0}
#docs-rows tr:hover{background:#161b22}
#docs-rows tr.pending td:nth-child(2){box-shadow:inset 2px 0 #d29922}
#docs-rows tr.pending td:nth-child(4){color:#d29922;font-weight:600}
td.tprom{color:#3fb950}
.cards{display:flex;gap:12px;padding:10px 16px;flex-wrap:wrap;align-items:stretch}
.card{border:1px solid #1c2230;border-radius:6px;padding:8px 14px;min-width:100px}
.card .k{font-size:11px;color:#6b7686;text-transform:uppercase;letter-spacing:.04em}
.card .v{font-size:18px;color:#e6edf3}
.stitle{max-width:46ch;overflow:hidden;text-overflow:ellipsis;color:#e6edf3}
.stitle.prov{color:#8b949e;font-style:italic}
.stitle.dim{color:#6b7686}
.ssub{font-size:11px;color:#6b7686;margin-top:1px}
.tprompt{white-space:pre-wrap;overflow-wrap:anywhere;color:#c8d0dc;background:#0d1119;border:1px solid #1c2230;border-radius:5px;padding:8px 11px;margin:2px 0 10px;max-height:260px;overflow:auto;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
#fleet .tt{display:inline-block;vertical-align:bottom;max-width:34ch;overflow:hidden;text-overflow:ellipsis;color:#d6deea}
.toolbar{display:flex;gap:10px;align-items:center;padding:8px 16px;color:#6b7686;font-size:12px}
select{background:#11161f;color:#c8d0dc;border:1px solid #1c2230;border-radius:4px;font:inherit;padding:2px 6px}
#drill{padding:0 16px 24px}
#drill details{border:1px solid #1c2230;border-radius:6px;margin:8px 0;background:#0d1119}
#drill summary{cursor:pointer;padding:6px 12px;color:#e6edf3}
#drill th{position:static}
h2{font-size:12px;color:#6b7686;text-transform:uppercase;letter-spacing:.04em;margin:14px 16px 4px}
#drill h2{margin:14px 0 4px}
.hint{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-left:5px;border:1px solid #2f3a4d;border-radius:50%;color:#6b7686;font:400 10px/1 ui-monospace,monospace;text-transform:none;letter-spacing:0;cursor:help;position:relative;vertical-align:middle;user-select:none}
.hint:hover,.hint:focus{color:#e6edf3;border-color:#3d4a60;outline:none}
.hint .tip{display:none;position:fixed;left:0;top:0;z-index:60;max-width:min(400px,calc(100vw - 24px));white-space:pre-line;text-align:left;pointer-events:none;background:#141a26;border:1px solid #303a4d;border-radius:7px;padding:9px 12px;color:#d6deea;font:400 12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:none;letter-spacing:normal;box-shadow:0 10px 28px rgba(0,0,0,.6)}
.fl{display:inline-block;border:1px solid #4d3800;background:#20180a;color:#d29922;border-radius:3px;padding:0 5px;margin-left:6px;font-size:11px;font-style:normal}
.seg-tool{fill:#2f6feb}.seg-wait{fill:#d29922}.seg-gap{fill:#30363d}
.tsplit{padding:8px 12px 2px;display:flex;align-items:center;gap:8px;font-size:12px;color:#6b7686}
#drill tr.tail td{opacity:.45}
#drill .tbar{display:flex;gap:12px;align-items:center;padding:10px 0 2px;color:#6b7686;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
#drill .tbar label{cursor:pointer;display:flex;align-items:center;gap:4px;text-transform:none;letter-spacing:normal}
a.evlink{color:inherit;text-decoration:none;border-bottom:1px dotted #2f3a4d}
a.evlink:hover{color:#79c0ff}
#drill summary .auto{color:#8b949e;font-style:italic}
</style></head>
<body>
<header>
  <h1>claude obs</h1>
  <nav>
    <a href="#live" id="tab-live">live</a>
    <a href="#sessions" id="tab-sessions">sessions</a>
    <a href="#tools" id="tab-tools">tools</a>
    <a href="#tokens" id="tab-tokens">tokens</a>
    <a href="#guards" id="tab-guards">guards</a>
    <a href="#nudges" id="tab-nudges">nudges</a>
    <a href="#db" id="tab-db">db</a>
    <a href="#docs" id="tab-docs">keyword-docs</a>
    <a href="#insight" id="tab-insight">insight</a>
  </nav>
  <span id="status" class="warn">connecting…</span>
  <span id="meta"></span>
</header>
<div id="fleet"></div>
<section id="view-live" class="on">
  <div class="toolbar">실시간 이벤트<span data-help="live"></span></div>
<table>
  <thead><tr><th>seq</th><th>time</th><th>event</th><th>app</th><th>session</th><th>tool</th><th>payload</th></tr></thead>
  <tbody id="rows"></tbody>
</table>
</section>
<section id="view-sessions">
  <div class="cards" id="ov-cards"></div>
  <div class="toolbar">기간
    <select id="sess-window"><option>1h</option><option>6h</option><option>24h</option><option selected>7d</option></select>
    <span data-help="sessions"></span>
    <span class="dim">행을 누르면 턴별 타임라인</span>
  </div>
  <table>
    <thead><tr><th></th><th>app</th><th>session</th><th>started</th><th>dur</th><th class="num">turns</th><th class="num">tools</th><th class="num">errs</th><th class="num">compacts</th><th class="num">agents</th><th class="num">avg ctx</th><th class="num">peak</th><th class="num">sw</th><th class="num">tokens</th><th class="num">cost</th></tr></thead>
    <tbody id="sess-rows"></tbody>
  </table>
  <div id="drill"></div>
</section>
<section id="view-tools">
  <div class="toolbar">기간
    <select id="tools-window"><option>1h</option><option>6h</option><option selected>24h</option><option>7d</option></select>
    <span data-help="tools"></span>
  </div>
  <table>
    <thead><tr><th>tool</th><th class="num">calls</th><th></th><th class="num">errs</th><th class="num">orphans</th><th class="num">pend</th><th class="num">p50</th><th class="num">p95</th><th class="num">max</th></tr></thead>
    <tbody id="tools-rows"></tbody>
  </table>
</section>
<section id="view-tokens">
  <div class="cards" id="tok-cards"></div>
  <div class="toolbar">기간
    <select id="tok-window"><option>1h</option><option>6h</option><option>24h</option><option selected>7d</option><option>30d</option></select>
    <span data-help="tokens"></span>
    <span class="dim">비용은 공식 단가 기준 추정치 · baseline·turn tax·switch rewrite는 어림값</span>
  </div>
  <h2 data-help="tok-anat">cost anatomy</h2>
  <div class="cards" id="tok-anat-cards"></div>
  <table>
    <thead><tr><th>model</th><th></th><th class="num">input</th><th class="num">write</th><th class="num">read</th><th class="num">output</th><th class="num">cost</th></tr></thead>
    <tbody id="tok-anat-rows"></tbody>
  </table>
  <h2>daily</h2>
  <table>
    <thead><tr><th>day</th><th class="num">total</th><th></th><th class="num">output</th><th class="num">cache read</th><th class="num">cost</th></tr></thead>
    <tbody id="tok-day-rows"></tbody>
  </table>
  <h2>by app</h2>
  <table>
    <thead><tr><th>app</th><th class="num">total</th><th></th><th class="num">cost</th><th class="num">output</th><th class="num">cache read</th><th class="num">msgs</th><th class="num">subagent</th></tr></thead>
    <tbody id="tok-app-rows"></tbody>
  </table>
  <h2>by model</h2>
  <table>
    <thead><tr><th>model</th><th class="num">total</th><th></th><th class="num">cost</th><th class="num">output</th><th class="num">cache read</th><th class="num">msgs</th><th class="num">subagent</th></tr></thead>
    <tbody id="tok-model-rows"></tbody>
  </table>
  <h2>by tool</h2>
  <table>
    <thead><tr><th>tool</th><th class="num">total</th><th></th><th class="num">cost</th><th class="num">output</th><th class="num">in+cache</th><th class="num">calls</th></tr></thead>
    <tbody id="tok-tool-rows"></tbody>
  </table>
</section>
<section id="view-guards">
  <div class="cards" id="guard-cards"></div>
  <div class="toolbar">기간
    <select id="guard-window"><option>24h</option><option selected>7d</option><option>30d</option></select>
    <span data-help="guards"></span>
    <span class="dim">deny·ask만 기록 (allow 제외) · 명령은 서버에서 가림</span>
  </div>
  <h2>by guard × rule</h2>
  <table>
    <thead><tr><th>guard</th><th>rule</th><th>decision</th><th class="num">count</th><th></th></tr></thead>
    <tbody id="guard-rule-rows"></tbody>
  </table>
  <h2>top blocked commands</h2>
  <table>
    <thead><tr><th class="num">count</th><th>command</th></tr></thead>
    <tbody id="guard-cmd-rows"></tbody>
  </table>
  <h2>by app</h2>
  <table>
    <thead><tr><th>app</th><th class="num">count</th><th></th></tr></thead>
    <tbody id="guard-app-rows"></tbody>
  </table>
</section>
<section id="view-nudges">
  <div class="cards" id="nudge-cards"></div>
  <div class="toolbar">기간
    <select id="nudge-window"><option>24h</option><option selected>7d</option><option>30d</option></select>
    <span data-help="nudges"></span>
    <span class="dim">발화 카운트는 관측 하한 (수집기 다운 중 발화는 누락) · 순응 판정은 acp 원장이 단일 진실원</span>
  </div>
  <h2>by kind × template</h2>
  <table>
    <thead><tr><th>kind</th><th>template</th><th class="num">fires</th><th class="num">outcomes</th><th class="num">complied</th><th></th></tr></thead>
    <tbody id="nudge-kind-rows"></tbody>
  </table>
  <h2>recent fires</h2>
  <table>
    <thead><tr><th>time</th><th>kind</th><th>template</th><th>drop → keep</th><th class="num">ctx</th><th class="num">est$</th><th>complied</th></tr></thead>
    <tbody id="nudge-recent-rows"></tbody>
  </table>
  <h2>by app</h2>
  <table>
    <thead><tr><th>app</th><th class="num">count</th><th></th></tr></thead>
    <tbody id="nudge-app-rows"></tbody>
  </table>
</section>
<section id="view-db">
  <div class="cards" id="db-cards"></div>
  <div class="toolbar">기간
    <select id="db-window"><option>24h</option><option selected>7d</option><option>30d</option></select>
    <span data-help="db"></span>
    <span class="dim">agent-db-plugin 조회 감사 · 로컬/리허설 한정 (사내 Windows MCP는 수집기 미도달) · sql 원문 기록</span>
  </div>
  <h2>by alias</h2>
  <table>
    <thead><tr><th>alias</th><th class="num">queries</th><th class="num">errors</th><th class="num">slowest</th><th></th></tr></thead>
    <tbody id="db-alias-rows"></tbody>
  </table>
  <h2>by tool</h2>
  <table>
    <thead><tr><th>tool</th><th class="num">count</th><th></th></tr></thead>
    <tbody id="db-tool-rows"></tbody>
  </table>
  <h2>slowest queries</h2>
  <table>
    <thead><tr><th>time</th><th>alias</th><th>tool</th><th class="num">ms</th><th>sql</th></tr></thead>
    <tbody id="db-slow-rows"></tbody>
  </table>
  <h2>errors</h2>
  <table>
    <thead><tr><th>code</th><th class="num">count</th></tr></thead>
    <tbody id="db-error-rows"></tbody>
  </table>
  <h2>top tables</h2>
  <table>
    <thead><tr><th>table</th><th class="num">queries</th><th></th></tr></thead>
    <tbody id="db-table-rows"></tbody>
  </table>
</section>
<section id="view-docs">
  <div class="cards" id="docs-cards"></div>
  <div class="toolbar">keyword-docs 코퍼스 (user 층)<span data-help="docs"></span>
    <span class="dim">파일이 진실원 · 매 요청 새로 읽음 · 행을 누르면 전체 문서 · dbdoc 마커 있으면 티어 표시</span>
  </div>
  <table>
    <thead><tr><th>instance</th><th>doc</th><th class="num">{{scaffold}}</th><th class="num">추정)</th><th>keywords</th></tr></thead>
    <tbody id="docs-rows"></tbody>
  </table>
  <div id="doc-view"></div>
  <div class="toolbar">apply / promote 이력
    <select id="docs-hist-window"><option>7d</option><option selected>30d</option><option>90d</option></select>
    <span data-help="dochist"></span>
    <span class="dim">enrich-cli --write 활동 로그 (SchemaDocApply/Promote) · 승격은 사람이 CLI로</span>
  </div>
  <table>
    <thead><tr><th>time</th><th>type</th><th>doc</th><th>app</th><th class="num">slots</th></tr></thead>
    <tbody id="docs-history-rows"></tbody>
  </table>
</section>
<section id="view-insight">
  <div class="cards" id="ft-cards"></div>
  <div class="toolbar">기간
    <select id="ft-window"><option>24h</option><option selected>7d</option><option>30d</option></select>
    <span data-help="insight"></span>
    <span class="dim">프롬프트당 응답(턴)이 도구를 얼마나·얼마나 효율적으로 썼는지 전 세션을 가로질러 집계 · 진행 중인 턴 제외 · 효율 지표는 사람이 보낸 턴만</span>
  </div>
  <h2 data-help="ft-flags">by flag</h2>
  <table>
    <thead><tr><th>flag</th><th class="num">turns</th><th></th><th class="num">cost</th></tr></thead>
    <tbody id="ft-flag-rows"></tbody>
  </table>
  <h2>by project</h2>
  <table>
    <thead><tr><th>app</th><th class="num">turns</th><th class="num">avg calls</th><th class="num">cost</th></tr></thead>
    <tbody id="ft-app-rows"></tbody>
  </table>
  <h2>turns over time</h2>
  <table>
    <thead><tr><th>bucket</th><th class="num">turns</th><th></th><th class="num">avg calls</th><th class="num">cost</th></tr></thead>
    <tbody id="ft-series-rows"></tbody>
  </table>
</section>
<script src="/app.js"></script>
</body></html>`;

const DASHBOARD_JS = `(function(){
  var KNOWN=["PreToolUse","PostToolUse","UserPromptSubmit","Notification","Stop","SubagentStop","PreCompact","SessionStart","SessionEnd"];
  var $=function(id){return document.getElementById(id);};
  var MAX_ROWS=500, seen=0;
  function fmt(ms){ try{return new Date(ms).toLocaleTimeString();}catch(e){return "";} }
  function fmtDT(ms){ try{var d=new Date(ms);return (d.getMonth()+1)+"/"+d.getDate()+" "+d.toLocaleTimeString();}catch(e){return "";} }
  function fmtDur(ms){ if(ms==null||isNaN(ms))return ""; if(ms<1000)return Math.round(ms)+"ms"; var s=Math.round(ms/1000); if(s<60)return s+"s"; var m=Math.floor(s/60); if(m<60)return m+"m"+(s%60>0?(s%60)+"s":""); return Math.floor(m/60)+"h"+(m%60)+"m"; }
  function fmtAgo(ms){ var s=Math.max(0,Math.round((Date.now()-ms)/1000)); if(s<60)return s+"s"; var m=Math.floor(s/60); if(m<60)return m+"m"; return Math.floor(m/60)+"h"; }
  function fmtTok(n){ n=Number(n)||0; if(n>=1e9)return (n/1e9).toFixed(1)+"G"; if(n>=1e6)return (n/1e6).toFixed(1)+"M"; if(n>=1e3)return Math.round(n/1e3)+"k"; return String(n); }
  function fmtUsd(n){ n=Number(n)||0; if(!n)return ""; if(n>=100)return "$"+Math.round(n); if(n>=1)return "$"+n.toFixed(2); return "$"+n.toFixed(3); }
  function pad2(n){ return (n<10?"0":"")+n; }
  function el(tag,cls,text){ var e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=String(text); return e; }
  function cell(text,cls){ return el("td",cls,text==null?"":text); }
  function preview(p,n){ try{var s=JSON.stringify(p); return s.length>n?s.slice(0,n)+"…":s;}catch(e){return "";} }
  function getJson(p){ return fetch(p).then(function(r){ if(!r.ok)throw new Error(p+" -> "+r.status); return r.json(); }); }
  var SVGNS="http://www.w3.org/2000/svg";
  function svgEl(t,attrs){ var e=document.createElementNS(SVGNS,t); for(var k in attrs)e.setAttribute(k,attrs[k]); return e; }
  function hbar(v,max,w,h){ var s=svgEl("svg",{width:w,height:h}); s.appendChild(svgEl("rect",{x:0,y:1,height:h-2,rx:1,"class":"bar",width:max>0?Math.max(1,Math.round(v/max*w)):0})); return s; }
  function spark(vals,w,h){ var s=svgEl("svg",{width:w,height:h}); if(!vals.length)return s; var max=Math.max.apply(null,vals),pts=[],n=vals.length,i,x,y; for(i=0;i<n;i++){ x=n<2?1:(i/(n-1))*(w-2)+1; y=h-1-(max>0?(vals[i]/max)*(h-2):0); pts.push(x.toFixed(1)+","+y.toFixed(1)); } s.appendChild(svgEl("polyline",{points:pts.join(" "),"class":"spark"})); return s; }

  // ── metric help tooltips (#61): per-screen + key derived metrics.
  // hover/focus a ? badge; native Korean copy, English metric tokens (match UI labels).
  // tip is position:fixed + JS-placed beside the badge so it never clips or hides the table.
  var HELP={
    live:"실시간 훅 이벤트 로그 (최신순)\\n• payload — 비밀값·토큰은 서버가 자동으로 가림\\n• 맨 위 띠 — 최근 10분 안에 움직인 세션들",
    sessions:"세션마다 무슨 일이 있었는지 한눈에\\n• compacts — 문맥이 꽉 차 자동 요약된 횟수\\n• agents — 띄운 서브에이전트 수\\n• avg ctx / peak — 매 턴 모델이 다시 읽는 문맥량 (평균 / 최대)\\n• sw — 도중에 모델 바꾼 횟수 (바꿀 때마다 캐시를 다시 만들어 돈이 듦)\\n• ●mega — 유난히 무거운 세션 (턴 300+ 또는 평균 문맥 300k+)\\n행을 누르면 턴별 타임라인이 열림",
    tools:"도구별 호출 상태\\n• orphans — 시작(Pre)만 있고 끝(Post)이 안 잡힌 호출 — 1순위 원인은 훅 가드 deny, 그 외 권한 거부·중단\\n• pend — 아직 안 끝난 호출\\n• p50 / p95 / max — 걸린 시간 (중앙값 / 상위 5% / 최대)",
    tokens:"토큰 사용량과 추정 비용 (공식 단가 기준)\\n• cache read — 대화가 길어질수록 이전 내용을 매 턴 다시 읽는 비용\\n• unpriced — 단가표에 없는 모델의 토큰\\n• total은 서브에이전트 포함, cost는 어림값",
    "tok-anat":"AI 요금이 어디서 새는지 4갈래로 분해\\n• input — 처음 보내는(캐시 안 된) 프롬프트\\n• cache write — 프롬프트를 캐시에 저장 (5분 1.25배 / 1시간 2배)\\n• cache read — 캐시된 문맥을 매 턴 다시 읽음 (0.1배) · 보통 제일 큼\\n• output — 생성된 답변 · 토큰당 제일 비쌈\\n아래 turn tax·baseline·switch rewrite 카드는 어림값",
    guards:"git·bash 가드가 막은 기록\\n• deny — 아예 차단 / ask — 한 번 물어봄 (allow는 기록 안 함)\\n• 명령에 든 민감정보는 서버가 가림",
    nudges:"ctx-budget가 작업 경계에서 띄운 /compact 넛지\\n• fires — 넛지 발화 횟수 (수집기 다운 중 발화는 누락 → 관측 하한)\\n• template — start(새 작업 시작) / terminal(작업 종료)\\n• complied — 넛지 후 실제로 압축했는지 (순응 판정은 acp 원장이 단일 진실원)\\n• est$ — 그때 압축했으면 들 일회성 비용 추정",
    db:"agent-db-plugin이 실행한 조회의 감사 로그 (DbQuery 이벤트)\\n• by alias / tool — 접속 별칭·MCP 도구별 쿼리 수 (describe_table·list_tables의 내부 카탈로그 조회도 포함)\\n• slowest — elapsedMs 상위 · ⚠ = 에러로 끝난 쿼리\\n• errors — ORA 코드별 집계 (ORA-00942 반복 = 에이전트가 테이블명 헛짚음 → 스키마 문서 공백 신호)\\n• top tables — sql의 FROM/JOIN에서 추출 (근사) · sql은 원문 그대로 기록 (마스킹 없음, 로컬/리허설 한정)",
    docs:"context 훅의 keyword-docs가 주입하는 문서 (user 층) — 문서 열람 + enrich 검토를 한 화면에\\n• 대상 = keyword-docs·msg-format·db-schema·domain-docs 인스턴스의 ~/.claude 인덱스 (project/bundle 층은 스코프 밖)\\n• 행을 누르면 전체 문서를 마크다운으로 렌더 (파일이 진실원, 매번 새로 읽음) · 추정) 슬롯은 문서 안에 근거(파일:라인)와 함께 인라인 표시\\n• {{scaffold}} = 미작성 슬롯(회색) · 추정) = 코드 추정 슬롯(주황, enrich #89) · 마커 없으면 일반 문서\\n• 추정)>0 문서는 강조 = 사람 검토 대기 · 상단 카드의 '추정) 대기' = 전 문서 추정) 슬롯 총합(파일 스캔이 진실원, 즉시 반영)\\n• 경로는 인덱스가 가리키는 파일 + ~/.claude/docs/ 아래만 열람 (그 밖은 거부)",
    dochist:"enrich apply/promote 활동 로그 (db-schema-enrich #89 + 도메인 스킬)\\n• enrich-cli 를 --write 로 실행하면 emit — apply = 추정) 슬롯 채움, promote = 추정)→확정 승격\\n• 상태가 아니라 변경 이력 — 현재 검토 대기는 위 코퍼스 표의 추정) 컬럼(파일 스캔)이 진실원, 이력은 누가 언제 뭘 바꿨나\\n• 승격 = 사람이 CLI로 (대시보드 버튼화는 2단계(쓰기 표면)에서 결정)",
    insight:"한 세션이 아니라 전 세션을 가로질러, 프롬프트 하나에 대한 응답(=턴)이 도구를 얼마나·얼마나 효율적으로 썼는지 보는 화면. 특정 작업 유형에서 도구 호출이 새는 곳을 찾는 용도다\\n• settled turns — 응답이 끝난(확정된) 턴만 셈 · 아직 진행 중인 마지막 턴은 뺀다\\n• avg calls/turn·dup-call% — 사람이 보낸 턴 기준 (내부 자동 턴·프롬프트 이전 잔여 턴은 제외)\\n• total/subagent cost — 그 기간 턴 비용 합 · subagent = 그 턴이 띄운 서브에이전트 지출\\n• unattributed — 어느 턴에도 안 붙은 잔여 비용 (진행 중 턴 비용 등을 흡수, 합을 정직하게 유지)\\n• ✂ cost-incomplete — 압축(compaction)이 낀 턴은 그 지출이 usage에 안 잡혀 비용이 하한값",
    "ft-flags":"턴에서 자동으로 잡아낸 비효율 패턴. 한 턴이 여러 flag를 가질 수 있어 flag별 비용을 다 더하면 총비용을 넘는다(중복 계상) · 비용은 '그 패턴을 보인 턴들의 비용'이지 아낄 수 있는 금액이 아님\\n• dup-call — 같은 도구를 같은 입력으로 반복 호출\\n• re-read — 한 파일을 겹치는 범위로 여러 번 읽음\\n• retry-loop — 같은 호출이 에러로 반복됨\\n• search-storm — 첫 Read/Edit 전에 Grep/Glob 검색만 연달아(5+ 배치)\\n• long-tail — 한 호출이 그 턴 도구 시간의 절반 이상을 잡아먹음\\n• gap-heavy — 도구 호출 사이 설명 안 되는 빈 시간이 많음\\n• orphaned — Pre만 있고 Post가 없는 호출(가드 deny·중단·크래시)\\n• mega-turn — 한 턴이 지나치게 길거나 호출이 너무 많음",
    "sess-ctx":"턴이 쌓일수록 커지는 문맥 크기 — /compact 하면 뚝 떨어져 톱니 모양이 됨 ('compact' = 떨어진 횟수)",
    "sess-whatif":"이 세션이 문맥 상한을 넘길 때마다 /compact 했다면 아꼈을 '다시 읽기' 비용\\n• @200k / @300k — 20만 / 30만 토큰에서 잘랐을 경우\\n문맥이 클수록 매 턴 통째로 다시 읽어 요금이 계속 붙음 · 어디까지나 어림값",
    turns:"프롬프트 하나가 응답을 마칠 때까지(=턴)의 도구 호출 궤적\\n• 턴 = UserPromptSubmit → 마지막 Stop · #번호는 보존창 기준이라 리로드마다 밀릴 수 있음 (seq가 고정 키)\\n• ⚙ 기울임 턴 — 사람이 입력한 게 아니라 하네스가 주입한 메시지 (백그라운드 작업 완료 알림 등) · 원문은 마우스 올리면\\n• +N queued — 턴 도중 미리 입력해 둔 메시지 (루프가 계속 달린 게 확인될 때만 병합)\\n• ✕ interrupted — Stop 없이 끊긴 턴 (Esc·크래시·수집기 다운)\\n• Stop 뒤 흐린 행 — 응답이 끝난 뒤에도 돌던 서브에이전트 꼬리 (시간 계산엔 제외)\\n• $ — 그 턴의 API 비용 · +sub = 그 턴이 띄운 서브에이전트 지출 (별도 합산) · compact 호출은 기록에 없음(✂ 뱃지) · 빈칸 = 귀속된 기록 없음\\n• 미귀속 — 어느 턴에도 못 붙은 비용 (턴 사이 유휴 시각·수집 공백·resume 잔재)\\n• 행의 시각을 누르면 원본 이벤트 JSON (오래되면 404 = 보존기간 만료)",
    "turn-split":"턴의 벽시계 시간 3분해 — 전부 근사\\n• tool — 도구 실행 (병렬은 겹침 합집합, 이중계산 없음)\\n• wait — 권한 프롬프트 앞 사람 대기 (해당 도구 시간에서 차감 · 상한 추정 · 캡 30m)\\n• gap — 나머지 전부: 모델 생성 · API 지연 · 관측 못한 대기\\n• bg 배지 — 백그라운드 실행이라 실제 작업 시간은 관측 불가",
    "turn-flags":"기계적으로 셀 수 있는 비효율 신호 (메인 체인만 · 질적 판단은 사람 몫)\\n• dup-call — 같은 도구+같은 입력 반복 (사이에 상태 변경 있으면 정당한 재확인으로 제외)\\n• re-read — 같은 파일을 겹치는 범위로 3회+ 읽기\\n• retry-loop — 같은 호출이 에러로 3연속\\n• search-storm — 첫 Read 전에 탐색만 5배치+ (병렬 배치는 1로 접음)\\n• long-tail — 호출 하나가 턴 도구 시간의 절반+ (30s+)\\n• gap-heavy — 미분류 시간이 도구 시간의 2배+ (60s+)\\n• orphaned — 끝(Post)이 없는 호출 (1순위 원인 = 훅 가드 deny)\\n• mega-turn — 호출 30+ 또는 10분+ · 임계값은 config {turns}로 조정"
  };
  function placeTip(badge){ var tip=badge.querySelector(".tip"); if(!tip)return;
    tip.style.visibility="hidden"; tip.style.display="block";
    var b=badge.getBoundingClientRect(), tw=tip.offsetWidth, th=tip.offsetHeight;
    var vw=window.innerWidth, vh=window.innerHeight, m=8, left, top;
    if(b.right+8+tw<=vw-m){ left=b.right+8; top=b.top; }      // prefer right of the badge → keeps the table clear
    else { left=Math.min(b.left, vw-tw-m); top=b.bottom+6; }  // no room → drop below
    if(top+th>vh-m)top=Math.max(m, vh-th-m);
    if(top<m)top=m; if(left<m)left=m;
    tip.style.left=left+"px"; tip.style.top=top+"px"; tip.style.visibility="visible"; }
  function hideTip(badge){ var tip=badge.querySelector(".tip"); if(tip)tip.style.display="none"; }
  function hint(key){ var txt=HELP[key]||""; var s=el("span","hint","?"); s.tabIndex=0;
    s.setAttribute("aria-label",txt); s.appendChild(el("div","tip",txt));
    s.addEventListener("mouseenter",function(){ placeTip(s); });
    s.addEventListener("mouseleave",function(){ hideTip(s); });
    s.addEventListener("focus",function(){ placeTip(s); });
    s.addEventListener("blur",function(){ hideTip(s); });
    return s; }
  function initHints(){ var ns=document.querySelectorAll("[data-help]");
    for(var i=0;i<ns.length;i++){ var k=ns[i].getAttribute("data-help"); if(HELP[k])ns[i].appendChild(hint(k)); }
    window.addEventListener("scroll",function(){ var t=document.querySelectorAll(".hint .tip");
      for(var j=0;j<t.length;j++)t[j].style.display="none"; },true); }

  // ── tabs (#live | #sessions | #tools | #tokens | #guards | #nudges | #db) — hash routing
  var TABS=["live","sessions","tools","tokens","guards","nudges","db","docs","insight"];
  function showTab(name){ if(TABS.indexOf(name)<0)name="live";
    TABS.forEach(function(t){ $("view-"+t).className=t===name?"on":""; $("tab-"+t).className=t===name?"on":""; });
    if(name==="sessions")loadSessions();
    if(name==="tools")loadTools();
    if(name==="tokens")loadTokens();
    if(name==="guards")loadGuards();
    if(name==="nudges")loadNudges();
    if(name==="db")loadDb();
    if(name==="docs")loadDocs();
    if(name==="insight")loadFleetTurns(); }
  window.addEventListener("hashchange",function(){ showTab(location.hash.slice(1)); });

  // ── live tail (stage 5 behaviour, unchanged)
  var tbody=$("rows"), statusEl=$("status"), metaEl=$("meta");
  function addRow(ev,prepend){
    var tr=document.createElement("tr");
    tr.appendChild(cell(ev.seq));
    tr.appendChild(cell(fmt(ev.received_at)));
    tr.appendChild(cell(ev.hook_event_type,"evt"));
    tr.appendChild(cell(ev.source_app));
    tr.appendChild(cell(ev.session_id));
    tr.appendChild(cell(ev.tool_name));
    tr.appendChild(cell(preview(ev.payload,400),"pay"));
    if(prepend&&tbody.firstChild)tbody.insertBefore(tr,tbody.firstChild); else tbody.appendChild(tr);
    while(tbody.childNodes.length>MAX_ROWS)tbody.removeChild(tbody.lastChild);
    seen++; metaEl.textContent=seen+" events";
  }
  function setStatus(s,cls){ statusEl.textContent=s; statusEl.className=cls||""; }
  fetch("/events?order=desc&limit=200").then(function(r){return r.json();}).then(function(d){
    (d.events||[]).forEach(function(ev){ addRow(ev,false); });
  }).catch(function(){ setStatus("history unavailable","err"); });
  var es=new EventSource("/stream");
  function onData(e){ try{ var ev=JSON.parse(e.data); addRow(ev,true); fleetNote(ev); }catch(x){} }
  KNOWN.forEach(function(name){ es.addEventListener(name,onData); });
  es.addEventListener("_ready",function(){ setStatus("● live","ok"); });
  es.addEventListener("_bye",function(){ setStatus("○ server stopped","err"); });
  es.onerror=function(){ setStatus("○ reconnecting…","warn"); };

  // ── fleet strip — seeded from /stats/sessions, then updated live off the SSE feed
  var FLEET_IDLE=600000;
  var fleet={};
  function fleetNote(ev){ if(!ev.session_id)return; var f=fleet[ev.session_id]||(fleet[ev.session_id]={what:""});
    f.app=ev.source_app; f.last_at=ev.received_at||Date.now();
    f.what=ev.hook_event_type+(ev.tool_name?" "+ev.tool_name:"");
    f.ended=(ev.hook_event_type==="SessionEnd");
    renderFleet(); }
  function renderFleet(){ var box=$("fleet"), now=Date.now(); box.textContent="";
    var ids=Object.keys(fleet).filter(function(k){ var f=fleet[k]; return !f.ended&&now-f.last_at<FLEET_IDLE; })
      .sort(function(a,b){ return fleet[b].last_at-fleet[a].last_at; });
    if(!ids.length){ box.appendChild(el("span","none","no active sessions")); return; }
    ids.forEach(function(sid){ var f=fleet[sid], c=el("span","car");
      c.appendChild(el("span","dot","●"));
      c.appendChild(el("span","app",f.app||"?"));
      c.appendChild(el("span","dim",sid.slice(0,8)));
      if(f.title){var tt=el("span","tt",f.title);tt.title=f.title;c.appendChild(tt);}
      if(f.what)c.appendChild(el("span","what",f.what));
      c.appendChild(el("span","ago",fmtAgo(f.last_at)));
      if(f.ctx)c.appendChild(el("span","dim","ctx "+fmtTok(f.ctx)));
      box.appendChild(c); }); }
  function fleetSeed(){ getJson("/stats/sessions?window=1h&limit=50").then(function(d){
      (d.sessions||[]).forEach(function(s){ var f=fleet[s.session_id]||(fleet[s.session_id]={what:""});
        f.title=s.title||s.first_prompt||f.title;
        if(!f.last_at||s.last_at>f.last_at){ f.app=s.source_app; f.last_at=s.last_at; f.ended=!!s.ended; } });
      renderFleet(); }).catch(function(){ renderFleet(); });
    // context size per session (compaction pressure) — best-effort, wider window
    getJson("/stats/tokens?window=6h&group=session").then(function(d){
      (d.rows||[]).forEach(function(t){ var f=fleet[t.key]; if(f&&t.context)f.ctx=t.context; });
      renderFleet(); }).catch(function(){}); }
  fleetSeed(); setInterval(renderFleet,5000); setInterval(fleetSeed,30000);

  // ── sessions tab
  function card(k,v){ var c=el("div","card"); c.appendChild(el("div","k",k)); c.appendChild(el("div","v",v)); return c; }
  function loadOverview(w){ getJson("/stats/overview?window="+w).then(function(o){ var box=$("ov-cards"); box.textContent="";
      box.appendChild(card("events",o.events)); box.appendChild(card("errors",o.errors));
      box.appendChild(card("sessions",o.sessions)); box.appendChild(card("active",o.sessions_active));
      var sp=el("div","card"); sp.appendChild(el("div","k","activity"));
      sp.appendChild(spark((o.buckets||[]).map(function(b){return b.count;}),180,28)); box.appendChild(sp);
    }).catch(function(){}); }
  function loadSessions(){ var w=$("sess-window").value; loadOverview(w);
    Promise.all([
      getJson("/stats/sessions?window="+w+"&limit=100"),
      getJson("/stats/tokens?window="+w+"&group=session").catch(function(){ return { rows: [] }; })
    ]).then(function(rr){ var d=rr[0], tok={};
      (rr[1].rows||[]).forEach(function(t){ tok[t.key]=t; });
      var tb=$("sess-rows"); tb.textContent="";
      (d.sessions||[]).forEach(function(s){ var tr=el("tr","sess"); var tk=tok[s.session_id];
        tr.appendChild(cell(s.active?"●":(s.ended?"✓":"·"),s.active?"ok":"dim"));
        tr.appendChild(cell(s.source_app));
        var sc=el("td"); var lbl=s.title||s.first_prompt;
        var main=el("div","stitle"+(s.title?"":(s.first_prompt?" prov":" dim")),lbl||s.session_id.slice(0,8));
        if(lbl)main.title=lbl; sc.appendChild(main);
        var sub=el("div","ssub"); sub.appendChild(el("span",null,s.session_id.slice(0,8)));
        if(tk&&tk.mega)sub.appendChild(el("span","err"," ●mega"));
        sc.appendChild(sub); tr.appendChild(sc);
        tr.appendChild(cell(fmtDT(s.started_at)));
        tr.appendChild(cell(fmtDur(s.duration_ms)));
        tr.appendChild(cell(s.turns,"num"));
        tr.appendChild(cell(s.tool_calls,"num"));
        tr.appendChild(cell(s.errors,"num"+(s.errors?" err":"")));
        tr.appendChild(cell(s.precompacts,"num"+(s.precompacts?" warn":"")));
        tr.appendChild(cell(s.subagents,"num"));
        tr.appendChild(cell(tk&&tk.avg_ctx?fmtTok(tk.avg_ctx):"","num"+(tk&&tk.mega?" warn":"")));
        tr.appendChild(cell(tk&&tk.peak_ctx?fmtTok(tk.peak_ctx):"","num"));
        tr.appendChild(cell(tk&&tk.model_switches?tk.model_switches:"","num"+(tk&&tk.model_switches?" warn":"")));
        tr.appendChild(cell(tk?fmtTok(tk.total+(tk.subagent_total||0)):"","num"));
        tr.appendChild(cell(tk?fmtUsd(tk.cost_usd):"","num"));
        tr.addEventListener("click",function(){ drill(s); });
        tb.appendChild(tr); }); }).catch(function(){}); }
  $("sess-window").addEventListener("change",loadSessions);

  // ── session drill-down (#73 stage 2): server-grouped turns via /stats/turns.
  // Replaces the old client-side grouping (analysis design §5.3) and its
  // 5×1000-row full-payload fetchSession() — the server owns turn semantics.
  function statusMark(t){
    if(t.status==="open")return el("span","ok"," ● open");
    if(t.status==="interrupted")return el("span","warn"," ✕ interrupted");
    if(t.status==="virtual")return null;
    return null; }
  function stackbar(t){ var w=300,h=10,d=t.duration_ms||0;
    var s=svgEl("svg",{width:w,height:h}); if(d<=0)return s;
    var x=0;
    [[t.tool_ms,"seg-tool"],[t.wait_ms,"seg-wait"],[t.gap_ms,"seg-gap"]].forEach(function(p){
      var ww=Math.round((p[0]||0)/d*w);
      if(ww>0){ s.appendChild(svgEl("rect",{x:x,y:1,width:ww,height:h-2,rx:1,"class":p[1]})); x+=ww; } });
    return s; }
  function turnBadges(t){ var wrap=el("span");
    (t.flags||[]).forEach(function(f){ wrap.appendChild(el("span","fl",f+(f==="dup-call"&&t.dup_calls>1?" ×"+t.dup_calls:""))); });
    return wrap; }
  function markerRow(m){ var tr=document.createElement("tr");
    tr.appendChild(cell(fmt(m.at),"dim"));
    var td=document.createElement("td"); td.colSpan=7;
    if(m.type==="Notification"&&m.kind==="permission")td.appendChild(el("span","warn","⚠ 권한 대기"+(m.wait_ms!=null?" "+fmtDur(m.wait_ms):"")));
    else if(m.type==="Notification")td.appendChild(el("span","dim","⏸ notification (대기 알림)"));
    else if(m.type==="GuardDecision")td.appendChild(el("span","err","⛔ "+(m.guard||"guard")+" · "+(m.rule||"")+" "+(m.decision||"")));
    else if(m.type==="PreCompact")td.appendChild(el("span","warn","✂ compact — 이후 문맥 재구축 (갭·비용 증가, 이 턴 비용엔 미포함)"));
    else if(m.type==="Stop")td.appendChild(el("span","dim","── Stop · 아래 흐린 행 = 응답 종료 뒤 서브에이전트 꼬리 ──"));
    else if(m.type==="SubagentStop")td.appendChild(el("span","dim","└ subagent 종료"+(m.agent_id?" (sub:"+String(m.agent_id).slice(0,4)+")":"")));
    else td.appendChild(el("span","dim",m.type));
    tr.appendChild(td); return tr; }
  function callRow(c,maxDur){ var tr=document.createElement("tr");
    if(c.tail)tr.className="tail";
    var t1=el("td","dim"); var a=document.createElement("a");
    a.href="/events/"+c.event_seq; a.target="_blank"; a.rel="noopener"; a.className="evlink";
    a.textContent=fmt(c.started_at); a.title="원본 이벤트 JSON 열기 (오래되면 404 = 보존기간 만료)";
    t1.appendChild(a); tr.appendChild(t1);
    tr.appendChild(cell(c.parallel?"∥":(c.gap_before_ms>0?"+"+fmtDur(c.gap_before_ms):""),"dim num"));
    var t3=document.createElement("td");
    if(c.lane==="subagent")t3.appendChild(el("span","dim","└ sub:"+String(c.agent_id||"").slice(0,4)+" "));
    t3.appendChild(el("span","evt",c.tool_name)); tr.appendChild(t3);
    var t4=el("td","pay"); t4.appendChild(el("span",null,c.input_summary||""));
    if(c.error)t4.appendChild(el("div","err",c.error)); tr.appendChild(t4);
    tr.appendChild(cell(c.duration_ms==null?"":fmtDur(c.duration_ms),"num"));
    var t6=document.createElement("td");
    if(c.duration_ms!=null)t6.appendChild(hbar(c.duration_ms,maxDur,60,10)); tr.appendChild(t6);
    var st=c.status, cls=st==="ok"?"ok":st==="error"?"err":st==="orphan"?"warn":"dim";
    tr.appendChild(cell(st,cls));
    var t8=document.createElement("td");
    if(c.dup_of)t8.appendChild(el("span","fl","dup"));
    if(c.bg)t8.appendChild(el("span","fl","bg"));
    if(c.crosses_turn)t8.appendChild(el("span","fl","→next"));
    if(c.wait_ms)t8.appendChild(el("span","fl","wait "+fmtDur(c.wait_ms)));
    tr.appendChild(t8);
    return tr; }
  // Harness-injected turns (auto): show a readable label instead of raw XML —
  // the original text stays on hover (title) and in the detail's prompt_full.
  var AUTO_LABEL={"task-notification":"백그라운드 작업 완료 알림","system-reminder":"시스템 주입 메시지",
    "local-command-caveat":"로컬 명령 실행 로그","command-name":"로컬 명령 실행 로그"};
  function autoText(t){ var lbl=AUTO_LABEL[t.auto]||"하네스 주입 메시지";
    var m=/<task-id>([^<]{1,20})/.exec(t.prompt||""); if(m)lbl+=" · task "+m[1].slice(0,9);
    return "⚙ "+lbl; }
  function turnRow(sid,t){ var d=document.createElement("details"),sm=document.createElement("summary");
    sm.appendChild(el("span","dim","#"+t.n+(t.turn_seq?" · seq "+t.turn_seq:"")+"  "));
    if(t.auto){ var at=el("span","auto",autoText(t)); at.title=t.prompt||""; sm.appendChild(at); }
    else sm.appendChild(el("span",null,t.prompt||(t.status==="virtual"?"(before first prompt / trimmed)":"(empty prompt)")));
    var meta="  ·  "+fmtDur(t.duration_ms)+" · "+t.calls+" calls";
    if(t.subagent_calls)meta+=" ("+t.subagent_calls+" sub)";
    if(t.queued_prompts)meta+=" · +"+t.queued_prompts+" queued";
    sm.appendChild(el("span","dim",meta));
    if(t.cost_usd!=null||t.cost_subagent_usd!=null){
      var cstr=(t.cost_usd!=null?fmtUsd(t.cost_usd):"")+(t.cost_subagent_usd!=null?" +sub "+fmtUsd(t.cost_subagent_usd):"");
      sm.appendChild(el("span","dim","  "+cstr.trim())); }
    if(t.errors)sm.appendChild(el("span","err"," "+t.errors+" err"));
    if(t.orphans)sm.appendChild(el("span","warn"," "+t.orphans+" orphan"));
    var stm=statusMark(t); if(stm)sm.appendChild(stm);
    sm.appendChild(turnBadges(t));
    if(t.precompacts)sm.appendChild(el("span","fl","✂ compact $ 미포함"));
    d.appendChild(sm);
    var body=el("div"); d.appendChild(body);
    var loaded=false;
    d.addEventListener("toggle",function(){ if(!d.open||loaded)return; loaded=true;
      body.appendChild(el("div","dim","loading…"));
      getJson("/stats/turns?session_id="+encodeURIComponent(sid)+"&turn="+t.turn_seq).then(function(det){
        body.textContent="";
        if(det.prompt_full){ body.appendChild(el("div","tprompt",det.prompt_full)); }
        var lg=el("div","tsplit"); lg.appendChild(stackbar(det.turn));
        var parts="tool "+fmtDur(det.turn.tool_ms)+" · wait "+fmtDur(det.turn.wait_ms)+" · gap "+fmtDur(det.turn.gap_ms);
        if(det.turn.subagent_ms)parts+="  ·  sub "+fmtDur(det.turn.subagent_ms)+" (별도 레인)";
        if(det.turn.cost_usd!=null)parts+="  ·  "+fmtUsd(det.turn.cost_usd);
        if(det.turn.cost_subagent_usd!=null)parts+=" +sub "+fmtUsd(det.turn.cost_subagent_usd);
        lg.appendChild(el("span",null,parts));
        lg.appendChild(hint("turn-split"));
        body.appendChild(lg);
        var rows=[];
        (det.calls||[]).forEach(function(c){ rows.push({at:c.started_at,call:c}); });
        (det.markers||[]).forEach(function(m){ rows.push({at:m.at,marker:m}); });
        rows.sort(function(a,b){ return a.at-b.at; });
        var maxDur=0; (det.calls||[]).forEach(function(c){ if(c.duration_ms>maxDur)maxDur=c.duration_ms; });
        var tbl=document.createElement("table"),tb=document.createElement("tbody");
        rows.forEach(function(r){ tb.appendChild(r.marker?markerRow(r.marker):callRow(r.call,maxDur)); });
        tbl.appendChild(tb); body.appendChild(tbl);
      }).catch(function(e){ body.textContent=""; body.appendChild(el("div","err","detail load failed: "+e.message)); }); });
    return d; }
  function drill(s){ var box=$("drill"); box.textContent="";
    box.appendChild(el("h2",null,(s.title||s.first_prompt||("session "+s.session_id.slice(0,8)))+" · "+s.source_app));
    // context growth curve + compact what-if (from the token timeline, #56)
    var tlBox=el("div","cards"); box.appendChild(tlBox);
    getJson("/stats/tokens?group=timeline&session_id="+encodeURIComponent(s.session_id)).then(function(t){
      tlBox.textContent=""; if(!t.series||!t.series.length)return;
      var wrap=el("div","card");
      var wk=el("div","k","context growth · "+t.series.length+" msgs · "+((t.compact_markers||[]).length)+" compact"); wk.appendChild(hint("sess-ctx")); wrap.appendChild(wk);
      wrap.appendChild(spark(t.series.map(function(x){ return x.ctx; }),300,40));
      wrap.appendChild(el("div","dim","peak "+fmtTok(Math.max.apply(null,t.series.map(function(x){ return x.ctx; })))));
      tlBox.appendChild(wrap);
      var wi=el("div","card"); var wik=el("div","k","compact what-if (cache-read saved)"); wik.appendChild(hint("sess-whatif")); wi.appendChild(wik);
      wi.appendChild(el("div","v","@200k "+(fmtUsd(t.whatif&&t.whatif["200000"])||"$0")+"  ·  @300k "+(fmtUsd(t.whatif&&t.whatif["300000"])||"$0")));
      tlBox.appendChild(wi);
    }).catch(function(){ tlBox.textContent=""; });
    // turns list (#73): summaries up front, per-turn detail lazy-fetched on open
    var bar=el("div","tbar"); bar.appendChild(el("span",null,"turns")); bar.appendChild(hint("turns"));
    var lab=document.createElement("label"); var cb=document.createElement("input"); cb.type="checkbox";
    lab.appendChild(cb); lab.appendChild(el("span",null,"⚑ flags만")); lab.appendChild(hint("turn-flags"));
    bar.appendChild(lab);
    var costLine=el("span","dim",""); bar.appendChild(costLine); box.appendChild(bar);
    var list=el("div"); box.appendChild(list);
    var data=null;
    function render(){ list.textContent=""; if(!data)return;
      costLine.textContent=data.usage_cost_usd!=null
        ?("세션 "+fmtUsd(data.usage_cost_usd)+(data.unattributed_cost_usd?" · 미귀속 "+fmtUsd(data.unattributed_cost_usd):"")):"";
      var ts=data.turns||[];
      if(cb.checked)ts=ts.filter(function(t){ return t.flags&&t.flags.length; });
      if(!ts.length){ list.appendChild(el("div","dim",cb.checked?"no flagged turns":"no turns in window")); return; }
      ts.forEach(function(t){ list.appendChild(turnRow(s.session_id,t)); }); }
    cb.addEventListener("change",render);
    getJson("/stats/turns?session_id="+encodeURIComponent(s.session_id)+"&limit=200").then(function(d){
      data=d; render(); box.scrollIntoView({behavior:"smooth"});
    }).catch(function(e){ list.appendChild(el("div","err","turns load failed: "+e.message)); }); }

  // ── tools tab
  function loadTools(){ var w=$("tools-window").value;
    getJson("/stats/tools?window="+w).then(function(d){ var tb=$("tools-rows"); tb.textContent=""; var max=0;
      (d.tools||[]).forEach(function(t){ if(t.calls>max)max=t.calls; });
      (d.tools||[]).forEach(function(t){ var tr=document.createElement("tr");
        tr.appendChild(cell(t.tool_name));
        tr.appendChild(cell(t.calls,"num"));
        var td=document.createElement("td"); td.appendChild(hbar(t.calls,max,120,12)); tr.appendChild(td);
        tr.appendChild(cell(t.errors,"num"+(t.errors?" err":"")));
        tr.appendChild(cell(t.orphans,"num"+(t.orphans?" warn":"")));
        tr.appendChild(cell(t.pending,"num"));
        tr.appendChild(cell(t.p50_ms==null?"":fmtDur(t.p50_ms),"num"));
        tr.appendChild(cell(t.p95_ms==null?"":fmtDur(t.p95_ms),"num"));
        tr.appendChild(cell(t.max_ms==null?"":fmtDur(t.max_ms),"num"));
        tb.appendChild(tr); }); }).catch(function(){}); }
  $("tools-window").addEventListener("change",loadTools);

  // ── tokens tab (stage 10b — /stats/tokens; costs + daily/model views #53)
  // grouped rows share one shape: key | total | bar | cost | output | cache read | msgs | subagent
  function tokRow(r,max){ var tr=document.createElement("tr");
    tr.appendChild(cell(r.key));
    tr.appendChild(cell(fmtTok(r.total),"num"));
    var td=document.createElement("td"); td.appendChild(hbar(r.total,max,120,12)); tr.appendChild(td);
    tr.appendChild(cell(fmtUsd(r.cost_usd),"num"));
    tr.appendChild(cell(fmtTok(r.output),"num"));
    tr.appendChild(cell(fmtTok(r.cache_read),"num"));
    tr.appendChild(cell(r.messages,"num"));
    tr.appendChild(cell(fmtTok(r.subagent_total),"num"));
    return tr; }
  function fillTok(id,rows){ var tb=$(id); tb.textContent=""; var max=0;
    rows.forEach(function(r){ if(r.total>max)max=r.total; });
    rows.forEach(function(r){ tb.appendChild(tokRow(r,max)); }); }
  // hourly buckets folded into LOCAL calendar days (the server is TZ-blind);
  // daily total includes subagent tokens, matching cost_usd's scope.
  function renderDaily(rows){ var tb=$("tok-day-rows"); tb.textContent="";
    var days={},order=[];
    rows.forEach(function(r){ var d=new Date(Number(r.key));
      var k=d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate());
      var a=days[k]; if(!a){ a=days[k]={total:0,output:0,cache_read:0,cost:0}; order.push(k); }
      a.total+=(Number(r.total)||0)+(Number(r.subagent_total)||0);
      a.output+=Number(r.output)||0; a.cache_read+=Number(r.cache_read)||0;
      a.cost+=Number(r.cost_usd)||0; });
    order.sort().reverse();
    var max=0; order.forEach(function(k){ if(days[k].total>max)max=days[k].total; });
    order.forEach(function(k){ var a=days[k],tr=document.createElement("tr");
      tr.appendChild(cell(k));
      tr.appendChild(cell(fmtTok(a.total),"num"));
      var td=document.createElement("td"); td.appendChild(hbar(a.total,max,120,12)); tr.appendChild(td);
      tr.appendChild(cell(fmtTok(a.output),"num"));
      tr.appendChild(cell(fmtTok(a.cache_read),"num"));
      tr.appendChild(cell(fmtUsd(a.cost),"num"));
      tb.appendChild(tr); }); }
  // ── cost anatomy (#56): 4-component stacked bar + baseline / turn tax / switch cards
  var ANAT=[["input_usd","#2f6feb"],["write_usd","#d29922"],["read_usd","#3fb950"],["output_usd","#a371f7"]];
  function anatBar(o,max,w,h){ var s=svgEl("svg",{width:w,height:h}),x=0;
    ANAT.forEach(function(g){ var pw=max>0?Math.round((Number(o[g[0]])||0)/max*w):0;
      if(pw>0){ s.appendChild(svgEl("rect",{x:x,y:1,width:pw,height:h-2,fill:g[1]})); x+=pw; } });
    return s; }
  function renderAnatomy(d,sessRows){ var T=d.totals||{};
    var box=$("tok-anat-cards"); box.textContent="";
    var msgs=0,ctxSum=0,rewrite=0;
    (sessRows||[]).forEach(function(s){ var m=Number(s.messages)||0; msgs+=m;
      ctxSum+=(Number(s.avg_ctx)||0)*m; rewrite+=Number(s.switch_rewrite_est)||0; });
    box.appendChild(card("turn tax (avg ctx)",fmtTok(msgs>0?Math.round(ctxSum/msgs):0)));
    box.appendChild(card("baseline ctx (est.)",fmtTok(T.baseline_ctx)));
    box.appendChild(card("switch rewrite (est.)",fmtUsd(rewrite)||"$0"));
    box.appendChild(card("input",fmtUsd(T.input_usd)||"$0"));
    box.appendChild(card("cache write",fmtUsd(T.write_usd)||"$0"));
    box.appendChild(card("cache read",fmtUsd(T.read_usd)||"$0"));
    box.appendChild(card("output",fmtUsd(T.output_usd)||"$0"));
    var tb=$("tok-anat-rows"); tb.textContent=""; var max=Number(T.cost_usd)||0;
    var all=[{key:"(all)",input_usd:T.input_usd,write_usd:T.write_usd,read_usd:T.read_usd,output_usd:T.output_usd,cost_usd:T.cost_usd}].concat(d.rows||[]);
    all.forEach(function(r){ if(!(Number(r.cost_usd)>0))return; var tr=document.createElement("tr");
      tr.appendChild(cell(r.key));
      var td=document.createElement("td"); td.appendChild(anatBar(r,max,140,12)); tr.appendChild(td);
      tr.appendChild(cell(fmtUsd(r.input_usd),"num"));
      tr.appendChild(cell(fmtUsd(r.write_usd),"num"));
      tr.appendChild(cell(fmtUsd(r.read_usd),"num"));
      tr.appendChild(cell(fmtUsd(r.output_usd),"num"));
      tr.appendChild(cell(fmtUsd(r.cost_usd),"num"));
      tb.appendChild(tr); }); }
  function loadTokens(){ var w=$("tok-window").value;
    Promise.all([
      getJson("/stats/tokens?window="+w+"&group=anatomy").catch(function(){ return {}; }),
      getJson("/stats/tokens?window="+w+"&group=session").catch(function(){ return { rows: [] }; })
    ]).then(function(rr){ renderAnatomy(rr[0]||{},(rr[1]||{}).rows||[]); }).catch(function(){});
    getJson("/stats/tokens?window="+w+"&group=app").then(function(d){
      var rows=d.rows||[];
      var box=$("tok-cards"); box.textContent="";
      var sum=function(f){ return rows.reduce(function(a,r){ return a+(Number(r[f])||0); },0); };
      box.appendChild(card("total",fmtTok(sum("total"))));
      box.appendChild(card("output",fmtTok(sum("output"))));
      box.appendChild(card("cache read",fmtTok(sum("cache_read"))));
      box.appendChild(card("subagent",fmtTok(sum("subagent_total"))));
      box.appendChild(card("cost (est.)",fmtUsd(sum("cost_usd"))||"$0"));
      if(sum("unpriced")>0)box.appendChild(card("unpriced tok",fmtTok(sum("unpriced"))));
      getJson("/stats/tokens?window="+w+"&group=bucket").then(function(b){
        var sp=el("div","card"); sp.appendChild(el("div","k","tokens over time"));
        sp.appendChild(spark((b.rows||[]).map(function(x){ return x.total; }),180,28));
        box.appendChild(sp);
        renderDaily(b.rows||[]); }).catch(function(){});
      fillTok("tok-app-rows",rows); }).catch(function(){});
    getJson("/stats/tokens?window="+w+"&group=model").then(function(d){
      fillTok("tok-model-rows",(d.rows||[]).filter(function(r){ return r.total+(r.subagent_total||0)>0; })); }).catch(function(){});
    getJson("/stats/tokens?window="+w+"&group=tool").then(function(d){
      var rows=(d.rows||[]).slice(0,20);
      var tb=$("tok-tool-rows"); tb.textContent=""; var max=0;
      rows.forEach(function(r){ if(r.total>max)max=r.total; });
      rows.forEach(function(r){ var tr=document.createElement("tr");
        tr.appendChild(cell(r.key));
        tr.appendChild(cell(fmtTok(r.total),"num"));
        var td=document.createElement("td"); td.appendChild(hbar(r.total,max,120,12)); tr.appendChild(td);
        tr.appendChild(cell(fmtUsd(r.cost_usd),"num"));
        tr.appendChild(cell(fmtTok(r.output),"num"));
        tr.appendChild(cell(fmtTok(r.input_cache),"num"));
        tr.appendChild(cell(r.calls,"num"));
        tb.appendChild(tr); }); }).catch(function(){});
  }
  $("tok-window").addEventListener("change",loadTokens);

  // ── guards tab (stage 9 — /stats/guards): what the git/bash guards blocked
  function loadGuards(){ var w=$("guard-window").value;
    getJson("/stats/guards?window="+w).then(function(d){
      var box=$("guard-cards"); box.textContent="";
      var deny=0,ask=0; (d.by_guard||[]).forEach(function(g){ deny+=g.deny||0; ask+=g.ask||0; });
      box.appendChild(card("decisions",d.count||0));
      box.appendChild(card("denied",deny));
      box.appendChild(card("asked",ask));
      (d.by_guard||[]).forEach(function(g){ box.appendChild(card(g.guard,g.total)); });
      var rr=$("guard-rule-rows"); rr.textContent=""; var max=0;
      (d.by_rule||[]).forEach(function(r){ if(r.count>max)max=r.count; });
      (d.by_rule||[]).forEach(function(r){ var tr=document.createElement("tr");
        tr.appendChild(cell(r.guard,"dim"));
        tr.appendChild(cell(r.rule));
        tr.appendChild(cell(r.decision,r.decision==="deny"?"err":"warn"));
        tr.appendChild(cell(r.count,"num"));
        var td=document.createElement("td"); td.appendChild(hbar(r.count,max,120,12)); tr.appendChild(td);
        rr.appendChild(tr); });
      if(!(d.by_rule||[]).length){ var etr=document.createElement("tr"),etd=el("td","dim","no guard decisions in window"); etd.colSpan=5; etr.appendChild(etd); rr.appendChild(etr); }
      var cr=$("guard-cmd-rows"); cr.textContent="";
      (d.top_commands||[]).forEach(function(c){ var tr=document.createElement("tr");
        tr.appendChild(cell(c.count,"num"));
        tr.appendChild(cell(c.command,"pay"));
        cr.appendChild(tr); });
      var ar=$("guard-app-rows"); ar.textContent=""; var amax=0;
      (d.by_app||[]).forEach(function(a){ if(a.count>amax)amax=a.count; });
      (d.by_app||[]).forEach(function(a){ var tr=document.createElement("tr");
        tr.appendChild(cell(a.app));
        tr.appendChild(cell(a.count,"num"));
        var td=document.createElement("td"); td.appendChild(hbar(a.count,amax,120,12)); tr.appendChild(td);
        ar.appendChild(tr); });
    }).catch(function(){}); }
  $("guard-window").addEventListener("change",loadGuards);

  // ── nudges tab (#63 — /stats/nudges): ctx-budget boundary /compact nudges,
  // joined to acp's compliance verdict when present. Counts are an observed
  // lower bound (see toolbar note); acp's ledger report owns the exact rate.
  function loadNudges(){ var w=$("nudge-window").value;
    getJson("/stats/nudges?window="+w).then(function(d){
      var box=$("nudge-cards"); box.textContent="";
      box.appendChild(card("fires",d.count||0));
      var start=0,term=0; (d.by_kind||[]).forEach(function(k){ if(k.template==="start")start+=k.count; else if(k.template==="terminal")term+=k.count; });
      box.appendChild(card("start / terminal",start+" / "+term));
      var priced=0; (d.by_cost_shown||[]).forEach(function(c){ if(c.costShown==="on")priced=c.count; });
      if(priced)box.appendChild(card("priced",priced));
      var c=d.compliance;
      if(c){ box.appendChild(card("complied",c.complied+"/"+c.outcomes+" ("+Math.round(c.rate*100)+"%)"));
        if(c.base_rate!=null)box.appendChild(card("base rate",Math.round(c.base_rate*100)+"%"));
        if(c.keep_misassign)box.appendChild(card("keep misassign",c.keep_misassign)); }
      var j=d.judgment;
      if(j)box.appendChild(card("kill judgment","n "+j.n+"/"+j.n_target+" · "+j.days+"/"+j.days_target+"d"));

      var kr=$("nudge-kind-rows"); kr.textContent=""; var kmax=0;
      (d.by_kind||[]).forEach(function(k){ if(k.count>kmax)kmax=k.count; });
      (d.by_kind||[]).forEach(function(k){ var tr=document.createElement("tr");
        tr.appendChild(cell(k.kind));
        tr.appendChild(cell(k.template,k.template==="start"?"ok":"warn"));
        tr.appendChild(cell(k.count,"num"));
        tr.appendChild(cell(k.outcomes||"","num"));
        tr.appendChild(cell(k.outcomes?(k.complied+"/"+k.outcomes):"","num"));
        var td=document.createElement("td"); td.appendChild(hbar(k.count,kmax,120,12)); tr.appendChild(td);
        kr.appendChild(tr); });
      if(!(d.by_kind||[]).length){ var etr=document.createElement("tr"),etd=el("td","dim","no nudges in window"); etd.colSpan=6; etr.appendChild(etd); kr.appendChild(etr); }

      var rr=$("nudge-recent-rows"); rr.textContent="";
      (d.recent||[]).forEach(function(r){ var tr=document.createElement("tr");
        tr.appendChild(cell(fmtDT(r.ts)));
        tr.appendChild(cell(r.kind));
        tr.appendChild(cell(r.template,r.template==="start"?"ok":"warn"));
        var keep=r.keepLabel||"—", drop=r.dropLabel?(r.dropLabel+(r.dropForm?" ("+r.dropForm+")":"")):"—";
        tr.appendChild(cell(drop+" → "+keep));
        tr.appendChild(cell(r.ctxTokens!=null?fmtTok(r.ctxTokens):"","num"));
        tr.appendChild(cell(r.costShown==="on"&&r.estUsd!=null?fmtUsd(r.estUsd):"","num"));
        tr.appendChild(r.complied==null?cell("—","dim"):cell(r.complied?"✓":"✗",r.complied?"ok":"err"));
        rr.appendChild(tr); });
      if(!(d.recent||[]).length){ var rtr=document.createElement("tr"),rtd=el("td","dim","no nudges in window"); rtd.colSpan=7; rtr.appendChild(rtd); rr.appendChild(rtr); }

      var ar=$("nudge-app-rows"); ar.textContent=""; var amax=0;
      (d.by_app||[]).forEach(function(a){ if(a.count>amax)amax=a.count; });
      (d.by_app||[]).forEach(function(a){ var tr=document.createElement("tr");
        tr.appendChild(cell(a.app));
        tr.appendChild(cell(a.count,"num"));
        var td=document.createElement("td"); td.appendChild(hbar(a.count,amax,120,12)); tr.appendChild(td);
        ar.appendChild(tr); });
    }).catch(function(){}); }
  $("nudge-window").addEventListener("change",loadNudges);

  // ── db tab (#87 — /stats/db): agent-db-plugin query audit → DbQuery events.
  // Local/rehearsal only (the in-office Windows MCP host has no reachable
  // collector). sql is stored verbatim (masking scoped out).
  function loadDb(){ var w=$("db-window").value;
    getJson("/stats/db?window="+w).then(function(d){
      var box=$("db-cards"); box.textContent="";
      box.appendChild(card("queries",d.count||0));
      box.appendChild(card("errors",d.errors||0));
      box.appendChild(card("aliases",(d.by_alias||[]).length));
      var top=(d.slow||[])[0]; if(top)box.appendChild(card("slowest",fmtDur(top.elapsedMs)));
      var ar=$("db-alias-rows"); ar.textContent=""; var amax=0;
      (d.by_alias||[]).forEach(function(a){ if(a.total>amax)amax=a.total; });
      (d.by_alias||[]).forEach(function(a){ var tr=document.createElement("tr");
        tr.appendChild(cell(a.alias));
        tr.appendChild(cell(a.total,"num"));
        tr.appendChild(cell(a.errors||"",a.errors?"err":"num"));
        tr.appendChild(cell(fmtDur(a.slowest_ms),"num"));
        var td=document.createElement("td"); td.appendChild(hbar(a.total,amax,120,12)); tr.appendChild(td);
        ar.appendChild(tr); });
      if(!(d.by_alias||[]).length){ var etr=document.createElement("tr"),etd=el("td","dim","no queries in window"); etd.colSpan=5; etr.appendChild(etd); ar.appendChild(etr); }
      var tr2=$("db-tool-rows"); tr2.textContent=""; var tmax=0;
      (d.by_tool||[]).forEach(function(t){ if(t.count>tmax)tmax=t.count; });
      (d.by_tool||[]).forEach(function(t){ var tr=document.createElement("tr");
        tr.appendChild(cell(t.tool));
        tr.appendChild(cell(t.count,"num"));
        var td=document.createElement("td"); td.appendChild(hbar(t.count,tmax,120,12)); tr.appendChild(td);
        tr2.appendChild(tr); });
      var sr=$("db-slow-rows"); sr.textContent="";
      (d.slow||[]).forEach(function(s){ var tr=document.createElement("tr");
        tr.appendChild(cell(fmtDT(s.ts)));
        tr.appendChild(cell(s.alias));
        tr.appendChild(cell(s.tool));
        tr.appendChild(cell(s.elapsedMs,s.oraError?"err":"num"));
        tr.appendChild(cell(s.oraError?("⚠ "+s.sql):s.sql,"pay"));
        sr.appendChild(tr); });
      if(!(d.slow||[]).length){ var str=document.createElement("tr"),std=el("td","dim","no queries in window"); std.colSpan=5; str.appendChild(std); sr.appendChild(str); }
      var er=$("db-error-rows"); er.textContent="";
      (d.by_error||[]).forEach(function(e){ var tr=document.createElement("tr");
        tr.appendChild(cell(e.code,"err"));
        tr.appendChild(cell(e.count,"num"));
        er.appendChild(tr); });
      if(!(d.by_error||[]).length){ var e2=document.createElement("tr"),e2d=el("td","dim","no errors in window"); e2d.colSpan=2; e2.appendChild(e2d); er.appendChild(e2); }
      var br=$("db-table-rows"); br.textContent=""; var bmax=0;
      (d.top_tables||[]).forEach(function(t){ if(t.count>bmax)bmax=t.count; });
      (d.top_tables||[]).forEach(function(t){ var tr=document.createElement("tr");
        tr.appendChild(cell(t.table));
        tr.appendChild(cell(t.count,"num"));
        var td=document.createElement("td"); td.appendChild(hbar(t.count,bmax,120,12)); tr.appendChild(td);
        br.appendChild(tr); });
    }).catch(function(){}); }
  $("db-window").addEventListener("change",loadDb);

  // ── fleet turns (#82 stage 3): aggregates over the materialized turns table
  function ftEmpty(tb,cs){ var tr=document.createElement("tr"),td=el("td","dim","no turns in window"); td.colSpan=cs; tr.appendChild(td); tb.appendChild(tr); }
  function loadFleetTurns(){ var w=$("ft-window").value;
    getJson("/stats/fleet-turns?window="+w).then(function(d){
      var box=$("ft-cards"); box.textContent=""; var t=d.totals||{};
      box.appendChild(card("settled turns",t.settled_turns||0));
      box.appendChild(card("avg calls/turn",t.human_turns?t.avg_calls_per_turn:"—"));
      box.appendChild(card("dup-call turns",t.dup_call_turn_ratio!=null&&t.human_turns?Math.round(t.dup_call_turn_ratio*100)+"%":"—"));
      box.appendChild(card("gap-heavy",t.gap_heavy_turns||0));
      box.appendChild(card("mega",t.mega_turns||0));
      box.appendChild(card("interrupted",t.interrupted_turns||0));
      box.appendChild(card("total cost",fmtUsd(t.total_cost_usd)||"$0"));
      if(t.total_subagent_cost_usd)box.appendChild(card("subagent cost",fmtUsd(t.total_subagent_cost_usd)));
      box.appendChild(card("unattributed",fmtUsd(t.unattributed_cost_usd)||"$0"));
      if(t.cost_incomplete_turns)box.appendChild(card("✂ cost-incomplete",t.cost_incomplete_turns));
      var fr=$("ft-flag-rows"); fr.textContent=""; var fmax=0;
      (d.by_flag||[]).forEach(function(f){ if(f.turns>fmax)fmax=f.turns; });
      (d.by_flag||[]).forEach(function(f){ var tr=document.createElement("tr");
        tr.appendChild(cell(f.flag));
        tr.appendChild(cell(f.turns,"num"));
        var td=document.createElement("td"); td.appendChild(hbar(f.turns,fmax,120,12)); tr.appendChild(td);
        tr.appendChild(cell(fmtUsd(f.cost_usd),"num"));
        fr.appendChild(tr); });
      if(!(d.by_flag||[]).length)ftEmpty(fr,4);
      var ar=$("ft-app-rows"); ar.textContent="";
      (d.by_app||[]).forEach(function(a){ var tr=document.createElement("tr");
        tr.appendChild(cell(a.app));
        tr.appendChild(cell(a.turns,"num"));
        tr.appendChild(cell(a.avg_calls,"num"));
        tr.appendChild(cell(fmtUsd(a.cost_usd),"num"));
        ar.appendChild(tr); });
      if(!(d.by_app||[]).length)ftEmpty(ar,4);
      var sr=$("ft-series-rows"); sr.textContent=""; var smax=0;
      (d.series||[]).forEach(function(s){ if(s.turns>smax)smax=s.turns; });
      (d.series||[]).forEach(function(s){ var tr=document.createElement("tr");
        tr.appendChild(cell(fmtDT(s.t)));
        tr.appendChild(cell(s.turns,"num"));
        var td=document.createElement("td"); td.appendChild(hbar(s.turns,smax,120,12)); tr.appendChild(td);
        tr.appendChild(cell(s.avg_calls,"num"));
        tr.appendChild(cell(fmtUsd(s.cost_usd),"num"));
        sr.appendChild(tr); });
      if(!(d.series||[]).length)ftEmpty(sr,5);
    }).catch(function(){}); }
  $("ft-window").addEventListener("change",loadFleetTurns);

  // ── docs tab (#92 — keyword-docs corpus viewer): list every doc the
  // keyword-docs instances inject at the user layer; click a row to render the
  // full doc. dbdoc tier markers ({{scaffold}} gray, 추정) amber) are highlighted.
  // Not on the 30s poll — docs are read fresh from disk on each click.
  function docTierize(container,s){
    var re=/(\\{\\{[^}]*\\}\\})|(추정\\)[^\\n]*)/g, last=0, m;
    while((m=re.exec(s))){
      if(m.index>last)container.appendChild(document.createTextNode(s.slice(last,m.index)));
      container.appendChild(el("span",m[1]?"tsc":"tin",m[0]));
      last=re.lastIndex;
    }
    if(last<s.length)container.appendChild(document.createTextNode(s.slice(last)));
  }
  function docCells(ln){ var s=ln.trim().replace(/^\\|/,"").replace(/\\|$/,""); return s.split("|").map(function(c){ return c.trim(); }); }
  function isRow(ln){ return /^\\s*\\|.*\\|\\s*$/.test(ln); }
  function isSep(ln){ return /^\\s*\\|[\\s:|-]*\\|\\s*$/.test(ln)&&ln.indexOf("-")>=0; }
  function isHr(ln){ return /^\\s*([-*_])(\\s*\\1){2,}\\s*$/.test(ln); }
  function renderDoc(text){
    // Strip HTML/dbdoc comments (<!-- ... -->) so markers don't leak as text and
    // merge into paragraphs. Tier highlighting keys off the text ({{}}/추정)), not
    // the markers, so hiding them loses nothing.
    var root=el("div","doc"), lines=String(text).replace(/<!--[\\s\\S]*?-->/g,"").split(/\\r?\\n/), i=0;
    while(i<lines.length){
      var ln=lines[i];
      if(/^\\s*\x60\x60\x60/.test(ln)){ var buf=[]; i++;
        while(i<lines.length&&!/^\\s*\x60\x60\x60/.test(lines[i])){ buf.push(lines[i]); i++; }
        i++; root.appendChild(el("pre",null,buf.join("\\n"))); continue; }
      var h=ln.match(/^(#{1,6})\\s+(.*)/);
      if(h){ var hd=el("h"+Math.min(6,h[1].length+1),null); docTierize(hd,h[2]); root.appendChild(hd); i++; continue; }
      if(isRow(ln)&&i+1<lines.length&&isSep(lines[i+1])){
        var tbl=el("table","doc-tbl"), thead=el("thead",null), htr=el("tr",null);
        docCells(ln).forEach(function(c){ var th=el("th",null); docTierize(th,c); htr.appendChild(th); });
        thead.appendChild(htr); tbl.appendChild(thead); i+=2;
        var tb=el("tbody",null);
        while(i<lines.length&&isRow(lines[i])){ var tr=el("tr",null);
          docCells(lines[i]).forEach(function(c){ var td=el("td",null); docTierize(td,c); tr.appendChild(td); });
          tb.appendChild(tr); i++; }
        tbl.appendChild(tb); root.appendChild(tbl); continue; }
      if(isHr(ln)){ root.appendChild(el("hr",null)); i++; continue; }
      if(/^\\s*[-*]\\s+/.test(ln)){ var ul=el("ul",null);
        while(i<lines.length&&/^\\s*[-*]\\s+/.test(lines[i])){ var li=el("li",null); docTierize(li,lines[i].replace(/^\\s*[-*]\\s+/,"")); ul.appendChild(li); i++; }
        root.appendChild(ul); continue; }
      if(!ln.trim()){ i++; continue; }
      var para=[]; while(i<lines.length&&lines[i].trim()&&!/^\\s*(#{1,6}\\s|\x60\x60\x60|[-*]\\s|\\|)/.test(lines[i])&&!isHr(lines[i])){ para.push(lines[i]); i++; }
      var p=el("p",null); docTierize(p,para.join(" ")); root.appendChild(p);
    }
    return root;
  }
  function openDoc(p,display){
    var view=$("doc-view"); view.textContent=""; view.appendChild(el("div","dim","loading…"));
    getJson("/docs/content?path="+encodeURIComponent(p)).then(function(d){
      view.textContent=""; view.appendChild(el("h2",null,display));
      view.appendChild(renderDoc(d.content||"")); view.scrollIntoView({block:"nearest"});
    }).catch(function(){ view.textContent=""; view.appendChild(el("div","err","문서를 불러올 수 없습니다 (삭제됐거나 접근 불가)")); });
  }
  // ── keyword-docs tab (#92 corpus viewer + #90 enrich review, folded in). The
  // corpus table IS the review queue: the 추정) column is the count of inferred
  // slots awaiting human promotion (a live file scan via /docs — the source of
  // truth), docs with 추정)>0 are highlighted, and the top card sums them. Opening
  // a doc renders it with each 추정) slot + its 근거 inline. The apply/promote
  // HISTORY below comes from events (loadDocsHistory), the enrich activity log.
  function loadDocs(){
    getJson("/docs").then(function(d){
      var box=$("docs-cards"); box.textContent="";
      box.appendChild(card("docs",d.count||0));
      var inst={}, pending=0;
      (d.docs||[]).forEach(function(x){ inst[x.instance]=(inst[x.instance]||0)+1;
        if(x.tiers&&x.tiers.inferred) pending+=x.tiers.inferred; });
      Object.keys(inst).forEach(function(k){ box.appendChild(card(k,inst[k])); });
      box.appendChild(card("추정) 대기",pending));
      var tb=$("docs-rows"); tb.textContent="";
      (d.docs||[]).forEach(function(x){ var tr=document.createElement("tr");
        var inf=x.tiers&&x.tiers.inferred?x.tiers.inferred:0;
        if(inf) tr.className="pending";
        tr.appendChild(cell(x.instance,"dim"));
        var dtd=cell(x.display); if(!x.exists){ dtd.appendChild(el("span","err"," (missing)")); } tr.appendChild(dtd);
        tr.appendChild(cell(x.tiers&&x.tiers.scaffold?x.tiers.scaffold:"","num"));
        tr.appendChild(cell(inf?inf:"","num"));
        tr.appendChild(cell((x.keywords||[]).join(", "),"dim"));
        if(x.exists){ tr.style.cursor="pointer"; tr.addEventListener("click",function(){ openDoc(x.path,x.display); }); }
        tb.appendChild(tr); });
      if(!(d.docs||[]).length){ var e=document.createElement("tr"),etd=el("td","dim","user 층(~/.claude/context-docs*.json)에 keyword-docs 인덱스 없음"); etd.colSpan=5; e.appendChild(etd); tb.appendChild(e); }
    }).catch(function(){});
    loadDocsHistory(); }
  function loadDocsHistory(){ var w=$("docs-hist-window").value;
    getJson("/stats/schema-docs?window="+w).then(function(d){
      var hr=$("docs-history-rows"); hr.textContent="";
      (d.history||[]).forEach(function(x){ var tr=document.createElement("tr");
        tr.appendChild(cell(fmtDT(x.ts)));
        tr.appendChild(cell(x.type,x.type==="promote"?"tprom":"dim"));
        tr.appendChild(cell(x.doc));
        tr.appendChild(cell(x.app,"dim"));
        tr.appendChild(cell(x.type==="promote"?x.promoted:x.filled,"num"));
        hr.appendChild(tr); });
      if(!(d.history||[]).length){ var h2=document.createElement("tr"),h2d=el("td","dim","이력 없음 — enrich-cli apply/promote를 --write 로 실행하면 여기 쌓임"); h2d.colSpan=5; h2.appendChild(h2d); hr.appendChild(h2); }
    }).catch(function(){}); }
  $("docs-hist-window").addEventListener("change",loadDocsHistory);

  // 30s refresh of whichever analytics tab is visible
  setInterval(function(){ var h=location.hash.slice(1); if(h==="sessions")loadSessions(); else if(h==="tools")loadTools(); else if(h==="tokens")loadTokens(); else if(h==="guards")loadGuards(); else if(h==="nudges")loadNudges(); else if(h==="db")loadDb(); else if(h==="insight")loadFleetTurns(); },30000);

  initHints();
  showTab(location.hash.slice(1));
})();`;

function handleDashboard(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(DASHBOARD_HTML);
}

function handleAppJs(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; connect-src 'self'",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(DASHBOARD_JS);
}

// ── router ──────────────────────────────────────────────────────────────────
function onRequest(req, res) {
  try {
    const u = new URL(req.url || "/", "http://localhost");
    const pathname = u.pathname;
    if (pathname === "/events") {
      if (req.method === "POST") return handleEvents(req, res);
      if (req.method === "GET") return handleEventsQuery(req, res, u);
      return json(res, 405, { error: "method not allowed" }, { Allow: "GET, POST" });
    }
    if (pathname.startsWith("/events/")) {
      if (req.method === "GET") return handleEventById(req, res, decodeURIComponent(pathname.slice(8)));
      return json(res, 405, { error: "method not allowed" }, { Allow: "GET" });
    }
    if (pathname === "/stream") {
      if (req.method === "GET") return handleStream(req, res);
      return json(res, 405, { error: "method not allowed" }, { Allow: "GET" });
    }
    if (pathname.startsWith("/stats/")) {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" }, { Allow: "GET" });
      if (pathname === "/stats/overview") return handleStatsOverview(req, res, u);
      if (pathname === "/stats/sessions") return handleStatsSessions(req, res, u);
      if (pathname === "/stats/tools") return handleStatsTools(req, res, u);
      if (pathname === "/stats/tokens") return handleStatsTokens(req, res, u);
      if (pathname === "/stats/guards") return handleStatsGuards(req, res, u);
      if (pathname === "/stats/nudges") return handleStatsNudges(req, res, u);
      if (pathname === "/stats/db") return handleStatsDb(req, res, u);
      if (pathname === "/stats/schema-docs") return handleStatsSchemaDocs(req, res, u);
      if (pathname === "/stats/turns") return handleStatsTurns(req, res, u);
      if (pathname === "/stats/fleet-turns") return handleStatsFleetTurns(req, res, u);
      return json(res, 404, { error: "not found" });
    }
    if (pathname === "/docs" || pathname === "/docs/content") {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" }, { Allow: "GET" });
      return pathname === "/docs" ? handleDocsList(req, res) : handleDocsContent(req, res, u);
    }
    if (pathname === "/health") {
      if (req.method === "GET") return handleHealth(req, res);
      return json(res, 405, { error: "method not allowed" }, { Allow: "GET" });
    }
    if (pathname === "/") {
      if (req.method === "GET") return handleDashboard(req, res);
      return json(res, 405, { error: "method not allowed" }, { Allow: "GET" });
    }
    if (pathname === "/app.js") {
      if (req.method === "GET") return handleAppJs(req, res);
      return json(res, 405, { error: "method not allowed" }, { Allow: "GET" });
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    logSafe("router", e);
    if (!res.headersSent) try { json(res, 500, { error: "internal" }); } catch {}
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────────-
function assertLoopback() {
  const loop = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!loop.has(HOST) && process.env.OBS_ALLOW_NONLOOPBACK !== "1") {
    process.stderr.write(`[obs] refusing non-loopback bind ${HOST} (set OBS_ALLOW_NONLOOPBACK=1 to override)\n`);
    process.exit(2);
  }
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DATA_DIR, 0o700); } catch {}
}

function loadToken() {
  if (process.env.OBS_TOKEN !== undefined) return; // env already decided
  try {
    const c = JSON.parse(fs.readFileSync(configFile(DATA_DIR), "utf8"));
    if (typeof c.token === "string" && c.token) TOKEN = c.token;
  } catch {}
}

// config.json {pricing} overrides/extends DEFAULT_PRICING (fail-open: bad file
// or key → defaults stand). Loaded once at boot; restart to pick up changes.
function loadPricing() {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(DATA_DIR), "utf8"));
    if (!c.pricing || typeof c.pricing !== "object") return;
    for (const k in c.pricing) {
      const o = c.pricing[k];
      if (o === null) { PRICING[k] = null; continue; } // explicit unprice
      if (typeof o !== "object") continue;
      // Field-level merge onto the base entry so a PARTIAL override (e.g. only
      // cache_write) can't drop input/output/cache_read → NaN costs (#57).
      PRICING[k] = { ...(PRICING[k] || {}), ...o };
    }
  } catch {}
}

// config.json {mega:{turns,ctx}} overrides the mega-session thresholds (#56).
// env (OBS_MEGA_*) is already applied above; config wins if present. Fail-open.
function loadThresholds() {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(DATA_DIR), "utf8"));
    if (c.mega && typeof c.mega === "object") {
      if (Number.isFinite(c.mega.turns)) MEGA_TURNS = c.mega.turns;
      if (Number.isFinite(c.mega.ctx)) MEGA_CTX = c.mega.ctx;
    }
    // {turns:{...}} tunes the Turn Inspector (#73): orphan cutoff, wait cap,
    // and any flag threshold from TURN_FLAG_DEFAULTS.
    if (c.turns && typeof c.turns === "object") {
      if (Number.isFinite(c.turns.orphan_after_ms)) TURN_ORPHAN_MS = c.turns.orphan_after_ms;
      if (Number.isFinite(c.turns.wait_cap_ms)) TURN_WAIT_CAP_MS = c.turns.wait_cap_ms;
      for (const k of Object.keys(TURN_FLAG_DEFAULTS))
        if (Number.isFinite(c.turns[k])) TURN_FLAGS[k] = c.turns[k];
    }
  } catch {}
}

function writePidfile() {
  const data = { pid: process.pid, host: HOST, port: PORT, startedAt: STARTED_AT, version: VERSION };
  try { fs.writeFileSync(pidFile(DATA_DIR), JSON.stringify(data), { mode: 0o600 }); }
  catch (e) { logSafe("pidfile", e); }
}

function probeHealth(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: "/health", method: "GET", timeout: timeoutMs, headers: { Host: "127.0.0.1" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(null); } });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function probeIsOurs(host, port) {
  const h = await probeHealth(host, port);
  return !!h && h.service === SERVICE;
}

let closing = false;
function installShutdown(server) {
  const shutdown = () => {
    if (closing) return;
    closing = true;
    setTimeout(() => process.exit(0), GRACE_MS).unref(); // force-exit backstop
    closeAllSubscribers(); // _bye + res.end() flushes the farewell, then closes
    server.close(() => {
      try { flush(); } catch (e) { logSafe("shutdown flush", e); }
      if (db) {
        try { db.impl.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch (e) { logSafe("checkpoint", e); }
        try { db.impl.close(); } catch (e) { logSafe("db close", e); }
      }
      try { fs.unlinkSync(pidFile(DATA_DIR)); } catch {}
      process.exit(0); // clean signal exit → 0 (systemd Restart=on-failure stays put)
    });
    // nudge the just-ended SSE sockets closed so server.close() doesn't wait on them.
    setImmediate(() => { try { server.closeIdleConnections?.(); } catch {} });
  };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, shutdown);
}

async function startServer() {
  process.umask(0o077);
  process.on("uncaughtException", (e) => logSafe("uncaught", e));
  process.on("unhandledRejection", (e) => logSafe("unhandled", e));

  assertLoopback();
  ensureDataDir();
  loadToken();
  loadPricing();
  loadThresholds();
  EXPECT = TOKEN ? sha256(TOKEN) : null;

  await startBackend(); // open SQLite, migrate, seed SEQ (degrades to null on failure)
  setInterval(runRetention, 3_600_000).unref(); // hourly; self-guarded
  startHeartbeat(); // SSE keepalive + half-open socket detection

  const server = http.createServer(onRequest);

  // EADDRINUSE must be handled explicitly — if the uncaughtException guard
  // swallowed it we'd have a non-listening zombie.
  server.on("error", async (err) => {
    if (err.code === "EADDRINUSE") {
      if (await probeIsOurs(HOST, PORT)) process.exit(0); // already ours → no-op
      logSafe("listen", "port held by foreign process");
      process.exit(3);
    }
    logSafe("listen", err);
    process.exit(1); // startup failure → non-zero (systemd restarts)
  });

  server.listen(PORT, HOST, () => {
    writePidfile();
    startAutoTitler();
    startAutoMaterializer(); // #82: fleet turn materialization (in-process, shared connection)
    process.stderr.write(`[obs] ${SERVICE} listening on http://${HOST}:${PORT} (pid ${process.pid})\n`);
  });

  installShutdown(server);
}

// ── CLI dispatch ──────────────────────────────────────────────────────────-
async function cliStatus() {
  const h = await probeHealth(HOST, PORT);
  if (!h) {
    process.stdout.write(`${SERVICE}: not running on ${HOST}:${PORT}\n`);
    process.exit(1);
  }
  // /health carries no token, so this is safe to print verbatim.
  process.stdout.write(JSON.stringify(h, null, 2) + "\n");
  process.exit(0);
}

async function cliStop() {
  const h = await probeHealth(HOST, PORT);
  if (!h || h.service !== SERVICE) {
    process.stdout.write(`${SERVICE}: not running (nothing to stop)\n`);
    process.exit(0);
  }
  try {
    process.kill(h.pid, "SIGTERM"); // confirmed ours via /health → safe PID
    process.stdout.write(`sent SIGTERM to pid ${h.pid}\n`);
  } catch (e) {
    process.stdout.write(`stop failed: ${e.message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

async function cliRetain() {
  await startBackend();
  if (!db) { process.stdout.write(`${SERVICE}: no sqlite backend\n`); process.exit(1); }
  runRetention();
  process.stdout.write(`retention pass done; rows=${dbRowCount()}\n`);
  process.exit(0);
}

// Backfill: parse the transcripts of every session the collector has seen.
// Idempotent (per-message UNIQUE + cursor bookmarks) — safe to re-run. With
// --rescan it drops the cursor bookmarks first so every transcript is re-read
// from offset 0; the per-message upsert then refreshes existing rows (needed to
// backfill cache_create_1h onto rows ingested before the TTL split — #57).
async function cliIngestUsage() {
  await startBackend();
  if (!db) { process.stdout.write(`${SERVICE}: no sqlite backend\n`); process.exit(1); }
  const rescan = process.argv.includes("--rescan");
  if (rescan) {
    try { db.impl.exec("DELETE FROM transcript_cursor"); }
    catch (e) { logSafe("rescan reset", e); }
  }
  const sess = db.impl.prepare("SELECT DISTINCT session_id FROM events").all();
  let parsed = 0, skipped = 0;
  for (const { session_id } of sess) {
    const row = db.impl.prepare(
      "SELECT payload FROM events WHERE session_id = ? AND payload LIKE '%transcript_path%' ORDER BY seq DESC LIMIT 1"
    ).get(session_id);
    let p = null;
    if (row) { try { p = JSON.parse(row.payload)?.transcript_path ?? null; } catch {} }
    if (typeof p === "string" && p) {
      try { parseSessionTranscripts(session_id, p); parsed++; } // main + subagent files (#81)
      catch (e) { logSafe("ingest-usage", e); skipped++; }
    } else skipped++;
  }
  const s = db.impl.prepare("SELECT COUNT(*) c, SUM(input+output+cache_create+cache_read) t FROM usage").get();
  process.stdout.write(`usage backfill${rescan ? " (rescan)" : ""}: sessions parsed=${parsed} skipped=${skipped}; msgs=${s.c} total_tokens=${s.t ?? 0}\n`);
  process.exit(0);
}

// ── #66 session titles: offline batch. Gather a session's user prompts and ask
// a cheap model for a short human title. The LLM spawn is the ONLY external touch
// (isolated in generateTitle; OBS_TITLE_STUB short-circuits it for tests).
const TITLE_MODEL = process.env.OBS_TITLE_MODEL || "claude-haiku-4-5-20251001";
const TITLE_MIN_GROWTH = intEnv("OBS_TITLE_MIN_GROWTH", 3); // re-title only after this many new prompts

// Auto-titler (#66 follow-up): the collector titles recently-idle sessions on a
// timer so the fleet strip shows a one-line summary instead of the raw first
// prompt. It uses a SHORT idle gate (default 90s quiet) so active sessions get
// titled soon after they pause, not just long-dead ones. On by default;
// OBS_TITLE_AUTO=0 disables it.
const TITLE_AUTO = process.env.OBS_TITLE_AUTO !== "0";
const TITLE_AUTO_INTERVAL_MS = intEnv("OBS_TITLE_INTERVAL_SEC", 180) * 1000;
const TITLE_AUTO_IDLE_MS = intEnv("OBS_TITLE_IDLE_SEC", 30) * 1000; // quiet this long → titled (short, so active sessions get a title during natural pauses)
const TITLE_AUTO_LIMIT = intEnv("OBS_TITLE_LIMIT", 8); // cap LLM spawns per tick

function sessionPromptRows(sid) {
  return db.impl.prepare(
    `SELECT json_extract(payload, '$.prompt') p FROM events
       WHERE session_id = ? AND hook_event_type = 'UserPromptSubmit' ORDER BY seq ASC`
  ).all(sid).map((r) => (r.p == null ? "" : String(r.p).replace(/\s+/g, " ").trim())).filter(Boolean);
}

function promptDigest(prompts, max = 4000) {
  const joined = prompts.map((p, i) => `${i + 1}. ${p}`).join("\n");
  return joined.length > max ? joined.slice(0, max) : joined;
}

// One-shot title via the claude CLI. The spawned claude runs its own Claude Code
// hooks, so we ISOLATE its observability side effects two ways: OBS_PORT=59999
// keeps its events off the live 4090 collector, and OBS_DATA_DIR=<void> makes the
// sacrificial collector that obs-lazy-start spawns on 59999 write to a throwaway
// DB — NOT the shared one. Without the void dir, that 59999 collector shares
// dataDir() with 4090 and the titler's own prompts leak in as fake sessions.
// Returns a clean one-line title, or null on any failure (titling is optional).
const TITLE_VOID_DIR = path.join(os.tmpdir(), "obs-titler-void"); // throwaway DB for the titler's claude
function generateTitle(digest) {
  if (process.env.OBS_TITLE_STUB) return process.env.OBS_TITLE_STUB.slice(0, 80); // tests
  const instruction =
    "다음은 한 코딩 세션에서 사용자가 순서대로 보낸 요청들이다. " +
    "이 세션이 무엇에 관한 것인지 한국어로 8단어 이내 제목 한 줄로만 답하라. " +
    "따옴표·마침표·설명 없이 제목만 출력:\n\n" + digest;
  try {
    const r = spawnSync("claude", ["-p", instruction, "--model", TITLE_MODEL], {
      encoding: "utf8", timeout: 60000, maxBuffer: 1 << 20,
      env: { ...process.env, OBS_PORT: "59999", OBS_DATA_DIR: TITLE_VOID_DIR },
    });
    if (r.status !== 0 || !r.stdout) return null;
    const line = r.stdout.trim().split("\n").map((s) => s.trim()).filter(Boolean)[0];
    return line ? line.replace(/^["'“”]+|["'“”.]+$/g, "").slice(0, 80) : null;
  } catch (e) { logSafe("title gen", e); return null; }
}

// Sessions worth (re)titling: idle (no events for a gate), have >=1 prompt, and
// are untitled OR grown by >= TITLE_MIN_GROWTH prompts since the last title.
function titleCandidates(all = false, idleMs = ACTIVE_MS) {
  const cutoff = Date.now() - idleMs;
  return db.impl.prepare(
    `SELECT e.session_id sid,
            SUM(e.hook_event_type = 'UserPromptSubmit') prompts, MAX(e.received_at) last_at,
            st.title title, st.prompt_count tpc
       FROM events e LEFT JOIN session_titles st ON st.session_id = e.session_id
       GROUP BY e.session_id HAVING prompts >= 1 AND last_at < ?`
  ).all(cutoff).filter((r) =>
    all || r.title == null || (Number(r.prompts) - Number(r.tpc || 0)) >= TITLE_MIN_GROWTH);
}

async function cliTitleSessions() {
  await startBackend();
  if (!db) { process.stdout.write(`${SERVICE}: no sqlite backend\n`); process.exit(1); }
  const all = process.argv.includes("--all");
  const li = process.argv.indexOf("--limit");
  const limit = li >= 0 ? Math.max(1, Number(process.argv[li + 1]) || 0) : Infinity;
  // --idle <sec>: how long a session must be quiet to be a candidate (the
  // auto-titler passes a short value so recently-paused sessions get titled).
  const ii = process.argv.indexOf("--idle");
  const idleMs = ii >= 0 ? Math.max(0, Number(process.argv[ii + 1]) || 0) * 1000 : ACTIVE_MS;
  const cands = titleCandidates(all, idleMs);
  const upsert = db.impl.prepare(
    `INSERT INTO session_titles(session_id, title, prompt_count, generated_at) VALUES(?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET title = excluded.title,
       prompt_count = excluded.prompt_count, generated_at = excluded.generated_at`
  );
  let titled = 0, skipped = 0, done = 0;
  for (const c of cands) {
    if (done >= limit) break;
    done++;
    const prompts = sessionPromptRows(c.sid);
    if (!prompts.length) { skipped++; continue; }
    const title = generateTitle(promptDigest(prompts));
    if (!title) { skipped++; continue; }
    upsert.run(c.sid, title, prompts.length, Date.now());
    titled++;
    process.stdout.write(`  ${c.sid.slice(0, 8)}  ${title}\n`);
  }
  process.stdout.write(`title-sessions: titled=${titled} skipped=${skipped} candidates=${cands.length}\n`);
  process.exit(0);
}

// Periodic auto-titler. Spawns our OWN `title-sessions` CLI as a DETACHED child
// rather than titling in-process: generateTitle is a blocking spawnSync(claude)
// that would stall ingest/SSE for seconds. The child opens the shared DB (WAL +
// busy_timeout make the concurrent write safe) and exits; it runs the CLI path,
// which never starts its own auto-titler, so there is no recursion. Timers are
// unref'd so they never hold the process open on their own.
function startAutoTitler() {
  if (!TITLE_AUTO) return;
  const tick = () => {
    try {
      const child = spawn(process.execPath, [
        "--disable-warning=ExperimentalWarning", process.argv[1],
        "title-sessions",
        "--idle", String(Math.round(TITLE_AUTO_IDLE_MS / 1000)),
        "--limit", String(TITLE_AUTO_LIMIT),
      ], { detached: true, stdio: "ignore", env: process.env });
      child.on("error", (e) => logSafe("auto-title spawn", e));
      child.unref();
    } catch (e) { logSafe("auto-title", e); }
  };
  setTimeout(tick, Math.min(30_000, TITLE_AUTO_INTERVAL_MS)).unref(); // first pass soon after startup (≤30s)
  setInterval(tick, TITLE_AUTO_INTERVAL_MS).unref();                  // then every interval
}

// #82: one materialization sweep from the CLI (backfill after deploy, or refresh).
// `--rebuild` / `--all` forces re-derivation of every NON-frozen session (reset
// their watermarks); frozen sessions (trimmed events) keep their historical rows.
async function cliMaterializeTurns() {
  await startBackend();
  if (!db) { process.stdout.write(`${SERVICE}: no sqlite backend\n`); process.exit(1); }
  if (process.argv.includes("--rebuild") || process.argv.includes("--all")) {
    try { db.impl.exec("UPDATE turn_cursor SET materialized_through_seq = 0, usage_epoch_seen = 0, config_ver = 0 WHERE frozen = 0"); }
    catch (e) { logSafe("materialize rebuild", e); }
    process.stdout.write("materialize-turns: reset watermarks for non-frozen sessions (rebuild)\n");
  }
  const r = materializeSweep(Date.now(), 1_000_000);
  let rows = "?"; try { rows = db.impl.prepare("SELECT COUNT(*) c FROM turns").get().c; } catch {}
  process.stdout.write(`materialize-turns: sessions=${r.sessions} candidates=${r.candidates} turn_rows=${rows}\n`);
  process.exit(0);
}

const cmd = process.argv[2];
if (cmd === "status") await cliStatus();
else if (cmd === "stop") await cliStop();
else if (cmd === "retain") await cliRetain(); // run one retention pass (ops/test)
else if (cmd === "ingest-usage") await cliIngestUsage(); // backfill token usage (stage 10a); --rescan re-reads all transcripts (#57)
else if (cmd === "title-sessions") await cliTitleSessions(); // #66: batch LLM session titles; --all re-titles, --limit N caps
else if (cmd === "materialize-turns") await cliMaterializeTurns(); // #82: backfill/refresh the fleet turns table; --rebuild forces re-derive of non-frozen sessions
else await startServer();
