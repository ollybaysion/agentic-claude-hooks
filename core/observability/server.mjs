#!/usr/bin/env node
// Observability collector — receives every Claude Code hook event over HTTP,
// stores it, and (later) streams it live to a dashboard.
//
// This file is built in stages (see docs/agent-dashboard-collector-design.md §10
// for 0-6 and docs/agent-dashboard-analysis-design.md for 7+). Implemented here:
// skeleton + lifecycle (0), non-blocking ingest (1), SQLite WAL storage (2),
// redaction (3), SSE (4), query API + dashboard (5), read-only stats
// aggregation API (7), and the tabbed analysis UI (8 — Live | Sessions | Tools
// + fleet strip). Auto-start (6) lives in core/obs-lazy-start/.
//
// Invariants held from the start (design §2, §11):
//   • single monotonic seq (ingest seq = future store PK = future SSE id = cursor)
//   • redact ONCE on the post-ack path (same value to writer + broadcaster)
//   • every in-memory buffer is BYTE-bounded with drop-oldest (no count-only caps)
//   • fail-open: process-level guards + explicit EADDRINUSE handling
//   • boundary = loopback bind + Host allowlist + 0600/0700 + umask(0o077)
//
// CLI:  node server.mjs            start the server (default)
//       node server.mjs status     probe /health and print it (never the token)
//       node server.mjs stop       verify ours via /health, then SIGTERM

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { dataDir, configFile, pidFile } from "../../lib/obs-paths.mjs";

const SERVICE = "claude-observability";
const VERSION = "0.3.0"; // 0.2: stats API (stage 7) · 0.3: analysis UI (stage 8)
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
      setImmediate(() => { try { broadcast(safe); } catch (e) { logSafe("broadcast", e); } });
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
  impl.exec("PRAGMA journal_mode = WAL;");
  impl.exec(`PRAGMA synchronous = ${DURABLE ? "FULL" : "NORMAL"};`);
  impl.exec("PRAGMA busy_timeout = 5000;");
  if (!exists) {
    impl.exec("PRAGMA auto_vacuum = INCREMENTAL;"); // only honoured on a fresh DB
  } else if (pragmaScalar(impl, "PRAGMA auto_vacuum") === 0) {
    impl.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    impl.exec("VACUUM;"); // one-time migration of an existing non-incremental DB
  }
  impl.exec("PRAGMA user_version = 2;"); // v2 = + v_tool_calls view (stage 7)
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
// Same gates as the query API; degraded (db=null) answers empty-but-200; and no
// query here ever SELECTs the payload column (the widest one). The hot path
// (POST /events) is untouched by this whole section.
const WINDOW_MS = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 };

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
    const sess = db.impl.prepare(
      "SELECT MAX(received_at) last_at, MAX(hook_event_type = 'SessionEnd') ended FROM events WHERE received_at >= ? GROUP BY session_id"
    ).all(since);
    const sessions_active = sess.filter((s) => !Number(s.ended) && Number(s.last_at) >= now - ACTIVE_MS).length;
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
         MAX(hook_event_type = 'SessionEnd')                      ended
       FROM events WHERE ${where}
       GROUP BY session_id ORDER BY last_at DESC LIMIT ?`
    ).all(...params, limit).map((r) => ({
      session_id: r.session_id, source_app: r.source_app,
      started_at: Number(r.started_at), last_at: Number(r.last_at),
      duration_ms: Number(r.last_at) - Number(r.started_at),
      turns: Number(r.turns), tool_calls: Number(r.tool_calls), errors: Number(r.errors),
      precompacts: Number(r.precompacts), subagents: Number(r.subagents),
      ended: !!Number(r.ended),
      active: !Number(r.ended) && Number(r.last_at) >= now - ACTIVE_MS,
    }));
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
.cards{display:flex;gap:12px;padding:10px 16px;flex-wrap:wrap;align-items:stretch}
.card{border:1px solid #1c2230;border-radius:6px;padding:8px 14px;min-width:100px}
.card .k{font-size:11px;color:#6b7686;text-transform:uppercase;letter-spacing:.04em}
.card .v{font-size:18px;color:#e6edf3}
.toolbar{display:flex;gap:10px;align-items:center;padding:8px 16px;color:#6b7686;font-size:12px}
select{background:#11161f;color:#c8d0dc;border:1px solid #1c2230;border-radius:4px;font:inherit;padding:2px 6px}
#drill{padding:0 16px 24px}
#drill details{border:1px solid #1c2230;border-radius:6px;margin:8px 0;background:#0d1119}
#drill summary{cursor:pointer;padding:6px 12px;color:#e6edf3}
#drill th{position:static}
h2{font-size:12px;color:#6b7686;text-transform:uppercase;letter-spacing:.04em;margin:14px 0 4px}
</style></head>
<body>
<header>
  <h1>claude obs</h1>
  <nav>
    <a href="#live" id="tab-live">live</a>
    <a href="#sessions" id="tab-sessions">sessions</a>
    <a href="#tools" id="tab-tools">tools</a>
  </nav>
  <span id="status" class="warn">connecting…</span>
  <span id="meta"></span>
</header>
<div id="fleet"></div>
<section id="view-live" class="on">
<table>
  <thead><tr><th>seq</th><th>time</th><th>event</th><th>app</th><th>session</th><th>tool</th><th>payload</th></tr></thead>
  <tbody id="rows"></tbody>
</table>
</section>
<section id="view-sessions">
  <div class="cards" id="ov-cards"></div>
  <div class="toolbar">window
    <select id="sess-window"><option>1h</option><option>6h</option><option>24h</option><option selected>7d</option></select>
    <span class="dim">click a row for the turn timeline</span>
  </div>
  <table>
    <thead><tr><th></th><th>app</th><th>session</th><th>started</th><th>dur</th><th class="num">turns</th><th class="num">tools</th><th class="num">errs</th><th class="num">compacts</th><th class="num">agents</th></tr></thead>
    <tbody id="sess-rows"></tbody>
  </table>
  <div id="drill"></div>
</section>
<section id="view-tools">
  <div class="toolbar">window
    <select id="tools-window"><option>1h</option><option>6h</option><option selected>24h</option><option>7d</option></select>
  </div>
  <table>
    <thead><tr><th>tool</th><th class="num">calls</th><th></th><th class="num">errs</th><th class="num">orphans</th><th class="num">pend</th><th class="num">p50</th><th class="num">p95</th><th class="num">max</th></tr></thead>
    <tbody id="tools-rows"></tbody>
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
  function el(tag,cls,text){ var e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=String(text); return e; }
  function cell(text,cls){ return el("td",cls,text==null?"":text); }
  function preview(p,n){ try{var s=JSON.stringify(p); return s.length>n?s.slice(0,n)+"…":s;}catch(e){return "";} }
  function getJson(p){ return fetch(p).then(function(r){ if(!r.ok)throw new Error(p+" -> "+r.status); return r.json(); }); }
  var SVGNS="http://www.w3.org/2000/svg";
  function svgEl(t,attrs){ var e=document.createElementNS(SVGNS,t); for(var k in attrs)e.setAttribute(k,attrs[k]); return e; }
  function hbar(v,max,w,h){ var s=svgEl("svg",{width:w,height:h}); s.appendChild(svgEl("rect",{x:0,y:1,height:h-2,rx:1,"class":"bar",width:max>0?Math.max(1,Math.round(v/max*w)):0})); return s; }
  function spark(vals,w,h){ var s=svgEl("svg",{width:w,height:h}); if(!vals.length)return s; var max=Math.max.apply(null,vals),pts=[],n=vals.length,i,x,y; for(i=0;i<n;i++){ x=n<2?1:(i/(n-1))*(w-2)+1; y=h-1-(max>0?(vals[i]/max)*(h-2):0); pts.push(x.toFixed(1)+","+y.toFixed(1)); } s.appendChild(svgEl("polyline",{points:pts.join(" "),"class":"spark"})); return s; }

  // ── tabs (#live | #sessions | #tools) — hash routing
  var TABS=["live","sessions","tools"];
  function showTab(name){ if(TABS.indexOf(name)<0)name="live";
    TABS.forEach(function(t){ $("view-"+t).className=t===name?"on":""; $("tab-"+t).className=t===name?"on":""; });
    if(name==="sessions")loadSessions();
    if(name==="tools")loadTools(); }
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
    if(ev.hook_event_type==="SessionEnd")f.ended=true;
    renderFleet(); }
  function renderFleet(){ var box=$("fleet"), now=Date.now(); box.textContent="";
    var ids=Object.keys(fleet).filter(function(k){ var f=fleet[k]; return !f.ended&&now-f.last_at<FLEET_IDLE; })
      .sort(function(a,b){ return fleet[b].last_at-fleet[a].last_at; });
    if(!ids.length){ box.appendChild(el("span","none","no active sessions")); return; }
    ids.forEach(function(sid){ var f=fleet[sid], c=el("span","car");
      c.appendChild(el("span","dot","●"));
      c.appendChild(el("span","app",f.app||"?"));
      c.appendChild(el("span","dim",sid.slice(0,8)));
      if(f.what)c.appendChild(el("span","what",f.what));
      c.appendChild(el("span","ago",fmtAgo(f.last_at)));
      box.appendChild(c); }); }
  function fleetSeed(){ getJson("/stats/sessions?window=1h&limit=50").then(function(d){
      (d.sessions||[]).forEach(function(s){ var f=fleet[s.session_id]||(fleet[s.session_id]={what:""});
        if(!f.last_at||s.last_at>f.last_at){ f.app=s.source_app; f.last_at=s.last_at; }
        if(s.ended)f.ended=true; });
      renderFleet(); }).catch(function(){ renderFleet(); }); }
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
    getJson("/stats/sessions?window="+w+"&limit=100").then(function(d){ var tb=$("sess-rows"); tb.textContent="";
      (d.sessions||[]).forEach(function(s){ var tr=el("tr","sess");
        tr.appendChild(cell(s.active?"●":(s.ended?"✓":"·"),s.active?"ok":"dim"));
        tr.appendChild(cell(s.source_app));
        tr.appendChild(cell(s.session_id.slice(0,8),"dim"));
        tr.appendChild(cell(fmtDT(s.started_at)));
        tr.appendChild(cell(fmtDur(s.duration_ms)));
        tr.appendChild(cell(s.turns,"num"));
        tr.appendChild(cell(s.tool_calls,"num"));
        tr.appendChild(cell(s.errors,"num"+(s.errors?" err":"")));
        tr.appendChild(cell(s.precompacts,"num"+(s.precompacts?" warn":"")));
        tr.appendChild(cell(s.subagents,"num"));
        tr.addEventListener("click",function(){ drill(s); });
        tb.appendChild(tr); }); }).catch(function(){}); }
  $("sess-window").addEventListener("change",loadSessions);

  // ── session drill-down: turn-grouped timeline, client-side (design §5.3)
  function fetchSession(sid){ var out=[],since=null,pages=0;
    function page(){ var q="/events?session_id="+encodeURIComponent(sid)+"&order=asc&limit=1000"+(since!=null?"&since="+since:"");
      return getJson(q).then(function(d){ out=out.concat(d.events||[]); since=d.next_cursor;
        if(d.count===1000&&++pages<5)return page();
        return out; }); }
    return page(); }
  function drill(s){ var box=$("drill"); box.textContent="";
    box.appendChild(el("h2",null,"session "+s.session_id+" · "+s.source_app));
    fetchSession(s.session_id).then(function(evs){
      var turns=[],cur=null;
      evs.forEach(function(ev){
        if(ev.hook_event_type==="UserPromptSubmit"||!cur){
          var pr="(before first prompt)";
          if(ev.hook_event_type==="UserPromptSubmit"){ try{ pr=String((ev.payload&&ev.payload.prompt)||""); }catch(e){ pr=""; } }
          cur={prompt:pr.slice(0,120),start:ev.received_at,end:ev.received_at,tools:0,errors:0,events:[]};
          turns.push(cur); }
        cur.events.push(ev); cur.end=ev.received_at;
        if(ev.hook_event_type==="PreToolUse")cur.tools++;
        if(ev.hook_event_type==="PostToolUse"&&ev.error!=null)cur.errors++; });
      if(!turns.length){ box.appendChild(el("div","dim","no events in window")); return; }
      turns.forEach(function(t,i){ var d=document.createElement("details"),sm=document.createElement("summary");
        sm.appendChild(el("span","dim","#"+(i+1)+"  "));
        sm.appendChild(el("span",null,t.prompt||"(empty prompt)"));
        sm.appendChild(el("span","dim","  ·  "+fmtDur(t.end-t.start)+" · "+t.tools+" tools "));
        if(t.errors)sm.appendChild(el("span","err",t.errors+" errors"));
        d.appendChild(sm);
        var tbl=document.createElement("table"),tb2=document.createElement("tbody");
        t.events.forEach(function(ev){ var tr=document.createElement("tr");
          tr.appendChild(cell(fmt(ev.received_at),"dim"));
          tr.appendChild(cell(ev.hook_event_type,"evt"));
          tr.appendChild(cell(ev.tool_name));
          tr.appendChild(cell(ev.error?String(ev.error).slice(0,120):"","err"));
          tr.appendChild(cell(preview(ev.payload,200),"pay"));
          tb2.appendChild(tr); });
        tbl.appendChild(tb2); d.appendChild(tbl); box.appendChild(d); });
      box.scrollIntoView({behavior:"smooth"});
    }).catch(function(e){ box.appendChild(el("div","err","load failed: "+e.message)); }); }

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

  // 30s refresh of whichever analytics tab is visible
  setInterval(function(){ var h=location.hash.slice(1); if(h==="sessions")loadSessions(); else if(h==="tools")loadTools(); },30000);

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
      return json(res, 404, { error: "not found" });
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

const cmd = process.argv[2];
if (cmd === "status") await cliStatus();
else if (cmd === "stop") await cliStop();
else if (cmd === "retain") await cliRetain(); // run one retention pass (ops/test)
else await startServer();
