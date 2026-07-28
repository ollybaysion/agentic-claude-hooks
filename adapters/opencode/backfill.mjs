#!/usr/bin/env node
// opencode history → collector backfill (#119).
//
//   node adapters/opencode/backfill.mjs --inspect        # what's actually in the DB
//   node adapters/opencode/backfill.mjs                  # dry run (default): counts + samples
//   node adapters/opencode/backfill.mjs --write          # import (collector must be STOPPED)
//
// opencode keeps every session, message, tool call and per-step token count in
// its own SQLite DB (~/.local/share/opencode/opencode.db). The live plugin
// (adapters/opencode/plugin.js) only reports sessions from the moment it is
// installed; this imports what happened BEFORE that.
//
// WHY IT WRITES THE DB DIRECTLY (and not POST /events, as the issue sketched):
// the collector stamps `received_at = Date.now()` on ingest — deliberately, the
// server clock owns ordering. Backfilled history sent over HTTP would therefore
// all land as "now": one giant fake session-of-today, every duration ~0. The
// only faithful import writes the original timestamps in, which means the same
// direct-DB route the collector's own `ingest-usage` CLI takes.
//
// THREE THINGS TO KNOW BEFORE `--write`:
//  1. The collector must be STOPPED (`node core/observability/server.mjs stop`).
//     It keeps `seq` in memory from boot; rows appended behind its back would
//     make it reuse those ids, and its INSERT OR IGNORE would then silently drop
//     LIVE events. The script refuses to write while the port is open.
//  2. Retention will eat the import unless the window covers it. The collector
//     archives rows older than OBS_MAX_AGE_DAYS (default 7) — every backfilled
//     row is older than that by definition. Set e.g. OBS_MAX_AGE_DAYS=3650 for
//     the collector before restarting it, or the history leaves again on the
//     next retention pass.
//  3. The opencode schema is read DEFENSIVELY (column names are discovered, not
//     assumed) because it is not a published contract. If the mapping comes out
//     empty, run --inspect and send that output — it prints the real tables,
//     columns and part-type histogram.
//
// Idempotent: tool events dedup on the collector's UNIQUE(tool_use_id,
// hook_event_type) index, and a cursor file records which sessions were already
// imported (`--force` re-imports them).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import { dataDir } from "../../lib/obs-paths.mjs";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const WRITE = has("--write");
const FORCE = has("--force");
const INSPECT = has("--inspect");
const APP = val("--app", null);            // source_app label; default = session dir basename
const ONLY = val("--session", null);
const SINCE_DAYS = Number(val("--since", "0")) || 0;
const LIMIT = Number(val("--limit", "0")) || 0;
const OBS_DIR = val("--data-dir", dataDir());
const IDLE_END_MS = 3_600_000; // a session untouched for >1h is imported as ended

const OC_DB = val("--db",
  process.env.OPENCODE_DB ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "opencode", "opencode.db"));

const OBS_PORT = Number(process.env.OBS_PORT) > 0 ? Number(process.env.OBS_PORT) : 4090;
const OBS_HOST = process.env.OBS_HOST || "127.0.0.1";
const CURSOR = path.join(OBS_DIR, "opencode-backfill.json");

const log = (...a) => console.log(...a);
const die = (msg) => { console.error(msg); process.exit(1); };

// ── sqlite (same backend pair as the collector) ─────────────────────────────
// node:sqlite rejects an explicit `undefined` options argument, so the
// read-write case must omit it entirely rather than pass a falsy value —
// otherwise every write run silently falls through to the better-sqlite3
// branch and dies with MODULE_NOT_FOUND.
async function open(file, readOnly) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return readOnly ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file);
  } catch {
    const { default: Database } = await import("better-sqlite3");
    return readOnly ? new Database(file, { readonly: true }) : new Database(file);
  }
}

const portOpen = (host, port, timeoutMs = 300) => new Promise((resolve) => {
  const sock = net.connect({ host, port });
  const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
  sock.setTimeout(timeoutMs);
  sock.once("connect", () => done(true));
  sock.once("timeout", () => done(false));
  sock.once("error", () => done(false));
});

// ── schema discovery — nothing about opencode's DB is assumed ───────────────
const tableNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => r.name);
const columnsOf = (db, t) => {
  try { return db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all().map((r) => r.name); }
  catch { return []; }
};
// First candidate that actually exists, else null.
const pick = (cols, ...cands) => cands.find((c) => cols.includes(c)) ?? null;
// A table whose name matches one of the candidates (opencode has used both
// singular and plural at times).
const table = (names, ...cands) => cands.find((c) => names.includes(c)) ?? null;

const parseJson = (v) => {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(String(v)); } catch { return null; }
};
// opencode stores ms epoch; tolerate seconds just in case.
const ms = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
};
const clip = (s, n = 4000) =>
  typeof s === "string" && s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s;

// Dig a value out of nested JSON by trying several paths ("a.b" style).
function dig(obj, ...paths) {
  for (const p of paths) {
    let cur = obj;
    for (const key of p.split(".")) {
      if (cur == null || typeof cur !== "object") { cur = undefined; break; }
      cur = cur[key];
    }
    if (cur != null) return cur;
  }
  return undefined;
}

// ── read the opencode DB ────────────────────────────────────────────────────
async function readOpencode() {
  if (!fs.existsSync(OC_DB)) {
    die(`opencode DB not found: ${OC_DB}\n` +
      `  --db <path>로 지정하거나, opencode가 설치된 머신에서 실행해라.`);
  }
  const db = await open(OC_DB, true);
  const names = tableNames(db);

  const T = {
    session: table(names, "session", "sessions"),
    message: table(names, "message", "messages"),
    part: table(names, "part", "parts"),
  };
  if (INSPECT) { inspect(db, names, T); db.close(); process.exit(0); }
  if (!T.session || !T.message || !T.part) {
    die(`expected session/message/part tables, found: ${names.join(", ")}\n` +
      `  --inspect 출력을 공유해라 — 스키마가 다르면 매핑을 고쳐야 한다.`);
  }

  const sc = columnsOf(db, T.session), mc = columnsOf(db, T.message), pc = columnsOf(db, T.part);
  const C = {
    sId: pick(sc, "id", "session_id"),
    sCreated: pick(sc, "time_created", "created_at", "created", "time"),
    sUpdated: pick(sc, "time_updated", "updated_at", "updated"),
    sTitle: pick(sc, "title", "summary", "name"),
    sDir: pick(sc, "directory", "cwd", "path", "worktree"),
    sData: pick(sc, "data"),
    mId: pick(mc, "id", "message_id"),
    mSession: pick(mc, "session_id", "sessionID", "session"),
    mData: pick(mc, "data"),
    mRole: pick(mc, "role"),
    mCreated: pick(mc, "time_created", "created_at", "time"),
    pId: pick(pc, "id"),
    pMessage: pick(pc, "message_id", "messageID", "message"),
    pSession: pick(pc, "session_id", "sessionID", "session"),
    pType: pick(pc, "type"),
    pData: pick(pc, "data"),
    pCreated: pick(pc, "time_created", "created_at", "time"),
  };
  if (!C.sId || !C.mId || !C.pType) {
    die(`could not map the key columns (session.id / message.id / part.type).\n` +
      `  --inspect 출력을 공유해라.`);
  }

  const sessions = db.prepare(`SELECT * FROM ${T.session}`).all().map((r) => {
    const d = C.sData ? parseJson(r[C.sData]) : null;
    return {
      id: String(r[C.sId]),
      started: ms(r[C.sCreated] ?? dig(d, "time.created")) ,
      updated: ms(r[C.sUpdated] ?? dig(d, "time.updated")),
      title: (C.sTitle ? r[C.sTitle] : null) ?? dig(d, "title") ?? null,
      dir: (C.sDir ? r[C.sDir] : null) ?? dig(d, "directory") ?? null,
      raw: r,
    };
  });

  const messages = db.prepare(`SELECT * FROM ${T.message}`).all().map((r) => {
    const d = C.mData ? parseJson(r[C.mData]) : null;
    return {
      id: String(r[C.mId]),
      session: String((C.mSession ? r[C.mSession] : null) ?? dig(d, "sessionID", "session_id") ?? ""),
      role: (C.mRole ? r[C.mRole] : null) ?? dig(d, "role") ?? null,
      created: ms((C.mCreated ? r[C.mCreated] : null) ?? dig(d, "time.created")),
      completed: ms(dig(d, "time.completed")),
      model: dig(d, "model.modelID", "modelID", "model") ?? null,
      agent: dig(d, "agent") ?? null,
      error: dig(d, "error") ?? null,
    };
  });

  const parts = db.prepare(`SELECT * FROM ${T.part}`).all().map((r) => {
    const d = C.pData ? parseJson(r[C.pData]) : null;
    return {
      id: C.pId ? String(r[C.pId]) : null,
      message: String((C.pMessage ? r[C.pMessage] : null) ?? dig(d, "messageID", "message_id") ?? ""),
      session: String((C.pSession ? r[C.pSession] : null) ?? dig(d, "sessionID", "session_id") ?? ""),
      type: String(r[C.pType] ?? ""),
      created: ms((C.pCreated ? r[C.pCreated] : null) ?? dig(d, "time.created")),
      data: d,
    };
  });

  db.close();
  return { sessions, messages, parts };
}

function inspect(db, names, T) {
  log(`opencode DB: ${OC_DB}\n`);
  log(`tables: ${names.join(", ")}\n`);
  for (const [role, t] of Object.entries(T)) {
    if (!t) { log(`${role}: (not found)`); continue; }
    const cols = columnsOf(db, t);
    let n = 0;
    try { n = Number(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c); } catch {}
    log(`${role} → table "${t}" (${n} rows)\n  columns: ${cols.join(", ")}`);
    try {
      const row = db.prepare(`SELECT * FROM ${t} LIMIT 1`).get();
      log(`  sample: ${JSON.stringify(row).slice(0, 600)}`);
    } catch {}
    log("");
  }
  if (T.part) {
    try {
      const hist = db.prepare(`SELECT type, COUNT(*) c FROM ${T.part} GROUP BY type ORDER BY c DESC`).all();
      log(`part.type histogram: ${hist.map((h) => `${h.type}=${h.c}`).join(" · ")}`);
    } catch {}
  }
}

// ── opencode rows → collector rows ──────────────────────────────────────────
// Emits the same event vocabulary the CC hooks produce, so every existing
// rollup (sessions, tools, turns, guards) reads opencode history without a
// single special case — plus `usage` rows so the Tokens tab is not empty.
function buildRows({ sessions, messages, parts }, seen) {
  const byMsg = new Map(), bySessionMsgs = new Map();
  for (const p of parts) {
    if (!byMsg.has(p.message)) byMsg.set(p.message, []);
    byMsg.get(p.message).push(p);
  }
  for (const m of messages) {
    if (!bySessionMsgs.has(m.session)) bySessionMsgs.set(m.session, []);
    bySessionMsgs.get(m.session).push(m);
  }

  const cutoff = SINCE_DAYS > 0 ? Date.now() - SINCE_DAYS * 86_400_000 : 0;
  const events = [], usage = [], imported = [];
  let skipped = 0;

  const chosen = sessions
    .filter((s) => (!ONLY || s.id === ONLY))
    .filter((s) => (s.started ?? s.updated ?? 0) >= cutoff)
    .sort((a, b) => (a.started ?? 0) - (b.started ?? 0));

  for (const s of chosen) {
    if (!FORCE && seen[s.id]) { skipped++; continue; }
    const msgs = (bySessionMsgs.get(s.id) ?? []).sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
    if (!msgs.length && !s.started) continue;

    const app = APP || (s.dir ? path.basename(String(s.dir)) : "opencode");
    const start = s.started ?? msgs[0]?.created ?? Date.now();
    const ev = (ts, type, extra = {}) => events.push({
      ts, type, app, session: s.id, ...extra,
    });

    ev(start, "SessionStart", {
      payload: { source: "startup", backfill: true, title: s.title, directory: s.dir },
    });

    let last = start;
    for (const m of msgs) {
      const t = m.created ?? last;
      last = Math.max(last, t);
      const mparts = (byMsg.get(m.id) ?? []).sort((a, b) => (a.created ?? 0) - (b.created ?? 0));

      if (m.role === "user") {
        const text = mparts.filter((p) => p.type === "text")
          .map((p) => dig(p.data, "text") ?? "").filter(Boolean).join("\n");
        ev(t, "UserPromptSubmit", { payload: { prompt: clip(text), backfill: true } });
        continue;
      }

      // assistant: tool calls (Pre/Post pair per part) + per-step token rows
      let step = 0;
      for (const p of mparts) {
        if (p.type === "tool") {
          const callID = dig(p.data, "callID", "callId", "id") ?? p.id;
          const tool = dig(p.data, "tool", "state.tool") ?? "unknown";
          const status = dig(p.data, "state.status") ?? null;
          const startedAt = ms(dig(p.data, "state.time.start")) ?? p.created ?? t;
          const endedAt = ms(dig(p.data, "state.time.end")) ?? startedAt;
          const input = dig(p.data, "state.input");
          const output = dig(p.data, "state.output");
          last = Math.max(last, endedAt);
          ev(startedAt, "PreToolUse", {
            tool, callID, payload: { tool_name: tool, tool_input: input, backfill: true },
          });
          ev(endedAt, "PostToolUse", {
            tool, callID,
            error: status === "error" ? clip(String(dig(p.data, "state.error") ?? "error")) : null,
            payload: { tool_name: tool, tool_response: { output: clip(typeof output === "string" ? output : JSON.stringify(output ?? null)) }, backfill: true },
          });
          continue;
        }
        if (p.type === "step-finish") {
          const tok = dig(p.data, "tokens") ?? {};
          const ts = p.created ?? t;
          usage.push({
            session_id: s.id,
            // UNIQUE(session_id,msg_id) and one message can hold several steps,
            // so the key is (message, step index) — deterministic across runs,
            // which is what makes a re-import a no-op instead of a duplicate.
            msg_id: `${m.id}#${step++}`,
            source_app: app, ts,
            model: m.model ?? null,
            input: Number(tok.input) || 0,
            output: Number(tok.output) || 0,
            cache_read: Number(dig(tok, "cache.read")) || 0,
            cache_create: Number(dig(tok, "cache.write")) || 0,
          });
        }
      }
      const done = m.completed ?? last;
      last = Math.max(last, done);
      ev(done, "Stop", { payload: { backfill: true } }); // turn boundary the rollups count
    }

    const end = s.updated ?? last;
    if (Date.now() - end > IDLE_END_MS) ev(end, "SessionEnd", { payload: { reason: "backfill", backfill: true } });
    imported.push({ id: s.id, app, start, end, msgs: msgs.length });
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events, usage, imported, skipped };
}

// ── write into the collector DB ─────────────────────────────────────────────
async function writeRows({ events, usage }) {
  const dbPath = path.join(OBS_DIR, "events.db");
  if (!fs.existsSync(dbPath)) die(`collector DB not found: ${dbPath}\n  --data-dir로 지정해라.`);
  const db = await open(dbPath, false);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  // The runtime column arrived with schema v8; an older DB just gets it now.
  const evCols = columnsOf(db, "events");
  if (!evCols.includes("runtime")) {
    try { db.exec("ALTER TABLE events ADD COLUMN runtime TEXT"); } catch {}
  }
  const hasUsage = tableNames(db).includes("usage");

  let seq = Number(db.prepare("SELECT MAX(seq) m FROM events").get()?.m ?? 0);
  const insEv = db.prepare(
    `INSERT OR IGNORE INTO events
       (seq,id,source_app,session_id,hook_event_type,tool_name,tool_use_id,
        agent_id,agent_type,source,reason,error,unknown_event,client_ts,received_at,payload,runtime)
     VALUES (?,?,?,?,?,?,?,NULL,NULL,?,NULL,?,0,?,?,?,'opencode')`
  );
  const insUse = hasUsage ? db.prepare(
    `INSERT OR IGNORE INTO usage
       (session_id,msg_id,source_app,ts,model,input,output,cache_create,cache_read,
        cache_create_1h,sidechain,agent_id,inserted_at,emitted_tool_ids,follows_tool_ids)
     VALUES (?,?,?,?,?,?,?,?,?,0,0,NULL,?,'[]','[]')`
  ) : null;

  db.exec("BEGIN");
  try {
    // --force re-imports a session from scratch. Tool events would dedup on
    // their own (UNIQUE(tool_use_id, hook_event_type)), but prompts and session
    // markers carry no such id and would pile up — so the previous IMPORT of
    // those sessions is cleared first. Only rows this script wrote are touched:
    // `runtime='opencode'` narrows it to opencode, and the payload's `backfill`
    // marker excludes anything the live plugin reported.
    if (FORCE) {
      const delEv = db.prepare(
        "DELETE FROM events WHERE session_id = ? AND runtime = 'opencode' AND json_extract(payload,'$.backfill') = 1"
      );
      const delUse = hasUsage ? db.prepare("DELETE FROM usage WHERE session_id = ?") : null;
      for (const id of new Set(events.map((e) => e.session))) {
        delEv.run(id);
        if (delUse) delUse.run(id);
      }
    }
    for (const e of events) {
      insEv.run(
        ++seq, crypto.randomUUID(), e.app, e.session, e.type,
        e.tool ?? null, e.callID ?? null,
        e.payload?.source ?? null, e.error ?? null,
        e.ts, e.ts, JSON.stringify({ ...(e.payload ?? {}), runtime: "opencode" })
      );
    }
    const now = Date.now();
    if (insUse) for (const u of usage) {
      insUse.run(u.session_id, u.msg_id, u.source_app, u.ts, u.model,
        u.input, u.output, u.cache_create, u.cache_read, now);
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    db.close();
    die(`write failed (rolled back): ${err?.message ?? err}`);
  }
  db.close();
  return { usageWritten: insUse ? usage.length : 0 };
}

// ── main ────────────────────────────────────────────────────────────────────
const oc = await readOpencode();
const seen = (() => { try { return JSON.parse(fs.readFileSync(CURSOR, "utf8")).sessions ?? {}; } catch { return {}; } })();
const built = buildRows(oc, seen);
const { events, usage, imported, skipped } = built;

const range = events.length
  ? `${new Date(events[0].ts).toISOString().slice(0, 10)} … ${new Date(events[events.length - 1].ts).toISOString().slice(0, 10)}`
  : "-";
const byType = {};
for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;

log(`opencode DB : ${OC_DB}`);
log(`collector   : ${path.join(OBS_DIR, "events.db")}`);
log(`sessions    : ${imported.length} to import${skipped ? ` (${skipped} already imported — --force to redo)` : ""}`);
log(`events      : ${events.length}  [${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(" · ")}]`);
log(`usage rows  : ${usage.length}  (tokens: in ${usage.reduce((a, u) => a + u.input, 0)} / out ${usage.reduce((a, u) => a + u.output, 0)})`);
log(`date range  : ${range}`);

if (!WRITE) {
  log(`\nsample:`);
  for (const e of events.slice(0, 5)) {
    log(`  ${new Date(e.ts).toISOString()} ${e.type.padEnd(16)} ${e.app} ${e.session.slice(0, 12)}${e.tool ? " " + e.tool : ""}`);
  }
  log(`\ndry run — nothing written. 실제 적재는 --write (수집기를 먼저 stop 해야 한다).`);
  process.exit(0);
}

if (!events.length) { log("\nnothing to import."); process.exit(0); }
if (await portOpen(OBS_HOST, OBS_PORT)) {
  die(`\n수집기가 ${OBS_HOST}:${OBS_PORT}에서 돌고 있다 — 먼저 멈춰라:\n` +
    `  node core/observability/server.mjs stop\n` +
    `이유: 수집기는 seq를 부팅 시 메모리에 올려두고 쓴다. 뒤에서 행을 밀어넣으면 ` +
    `같은 seq를 재사용하다가 INSERT OR IGNORE로 라이브 이벤트가 조용히 버려진다.`);
}

const { usageWritten } = await writeRows(built);
try {
  fs.mkdirSync(OBS_DIR, { recursive: true, mode: 0o700 });
  const next = { sessions: { ...seen } };
  for (const s of imported) next.sessions[s.id] = { at: Date.now(), events: s.msgs };
  fs.writeFileSync(CURSOR, JSON.stringify(next), { mode: 0o600 });
} catch (err) {
  log(`(cursor not saved: ${err?.message ?? err} — 재실행 시 중복 가능)`);
}

log(`\nimported ${events.length} events + ${usageWritten} usage rows.`);
log(`
다음:
  1. 보존 창을 늘려라 — 백필 행은 정의상 전부 '오래된' 행이라 기본 7일 정책이 지운다:
       OBS_MAX_AGE_DAYS=3650 로 수집기를 기동 (예: export 후 obs-lazy-start / server.mjs)
  2. 수집기 재기동 → 대시보드 sessions 탭 기간을 '전체'로 두면 백필된 opencode 세션이 OC 배지와 함께 보인다
  3. 턴 집계까지 채우려면: node core/observability/server.mjs materialize-turns`);
