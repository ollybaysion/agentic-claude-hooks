#!/usr/bin/env node
// Observability collector — receives every Claude Code hook event over HTTP,
// stores it, and (later) streams it live to a dashboard.
//
// This file is built in stages (see docs/agent-dashboard-collector-design.md §10).
// Implemented here: STAGE 0 (skeleton + lifecycle) and STAGE 1 (non-blocking
// ingest core, no DB yet). SQLite (stage 2), redaction (stage 3), SSE (stage 4),
// and the query API + dashboard (stage 5) slot into the marked TODO seams.
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
const VERSION = "0.1.0";
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
  impl.exec("PRAGMA user_version = 1;");
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

// ── router ──────────────────────────────────────────────────────────────────
function onRequest(req, res) {
  try {
    const pathname = (req.url || "/").split("?")[0];
    if (pathname === "/events") {
      if (req.method === "POST") return handleEvents(req, res);
      return json(res, 405, { error: "method not allowed" }, { Allow: "POST" });
    }
    if (pathname === "/stream") {
      if (req.method === "GET") return handleStream(req, res);
      return json(res, 405, { error: "method not allowed" }, { Allow: "GET" });
    }
    if (pathname === "/health") {
      if (req.method === "GET") return handleHealth(req, res);
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
