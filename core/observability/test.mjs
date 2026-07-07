// Deterministic end-to-end checks for the cache-write TTL split (#57).
// No test framework — plain assertions over the real CLI + HTTP surface.
//
//   node --disable-warning=ExperimentalWarning core/observability/test.mjs
//
// Covers: v3→v4 migration (ALTER adds cache_create_1h), the re-backfill path
// (cursor-at-EOF blocker → --rescan drops cursors + upsert refreshes old rows),
// TTL-split collection + fallback, per-TTL billing (5m 1.25× / 1h 2×), the
// no-regression invariant (cache_create stays the TOTAL), and the config
// partial-override NaN guard.

import { DatabaseSync } from "node:sqlite";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const SERVER = path.join(import.meta.dirname, "server.mjs");
const NODE_ARGS = ["--disable-warning=ExperimentalWarning"];
const SESSION = "sess-ttl-test";
const MODEL = "claude-opus-4-8"; // input 5, output 25, cache 5m 6.25 / 1h 10 (=5×2), read 0.5

let failures = 0;
function check(name, cond, detail = "") {
  process.stdout.write(`${cond ? "  ok  " : "FAIL  "}${name}${cond ? "" : "  → " + detail}\n`);
  if (!cond) failures++;
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── temp state dir + fixture transcript ─────────────────────────────────────
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obs-ttl-"));
const DB_PATH = path.join(DATA_DIR, "events.db");
const TRANSCRIPT = path.join(DATA_DIR, "transcript.jsonl");
const NOW = new Date().toISOString();
const baseEnv = { ...process.env, OBS_DATA_DIR: DATA_DIR, OBS_TOKEN: "" };

// 3 assistant messages, all main-chain, same model:
//   m_old  — mixed TTL, PRE-SEEDED into a v3 usage row (cache_create_1h missing)
//   m_new  — mixed TTL, brand new (insert path)
//   m_flat — legacy shape: flat cache_creation_input_tokens, NO nested object
//            (fallback → billed as all-5m)
const msg = (id, u) => JSON.stringify({
  type: "assistant", timestamp: NOW, message: { id, model: MODEL, usage: u },
});
fs.writeFileSync(TRANSCRIPT, [
  msg("m_old", { input_tokens: 100000, output_tokens: 50000, cache_read_input_tokens: 200000,
    cache_creation_input_tokens: 1000000, cache_creation: { ephemeral_5m_input_tokens: 400000, ephemeral_1h_input_tokens: 600000 } }),
  msg("m_new", { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5,
    cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 800 } }),
  msg("m_flat", { input_tokens: 30, output_tokens: 40, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 500 }), // no cache_creation object → 1h subset = 0
].join("\n") + "\n");
const FIXTURE_SIZE = fs.statSync(TRANSCRIPT).size;

// ── build a v3-schema DB (no cache_create_1h), as if written before #57 ──────
{
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA user_version = 3");
  db.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL,
    source_app TEXT NOT NULL, session_id TEXT NOT NULL, hook_event_type TEXT NOT NULL,
    tool_name TEXT, tool_use_id TEXT, agent_id TEXT, agent_type TEXT,
    source TEXT, reason TEXT, error TEXT, unknown_event INTEGER NOT NULL DEFAULT 0,
    client_ts INTEGER, received_at INTEGER NOT NULL, payload TEXT NOT NULL)`);
  db.exec(`CREATE TABLE usage (session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
    source_app TEXT NOT NULL, ts INTEGER NOT NULL, model TEXT,
    input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
    cache_create INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
    sidechain INTEGER NOT NULL DEFAULT 0,
    emitted_tool_ids TEXT NOT NULL DEFAULT '[]', follows_tool_ids TEXT NOT NULL DEFAULT '[]',
    UNIQUE(session_id, msg_id))`);
  db.exec(`CREATE TABLE transcript_cursor (session_id TEXT PRIMARY KEY, path TEXT NOT NULL,
    offset INTEGER NOT NULL DEFAULT 0, last_emitted TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL)`);
  // events row that points ingest-usage at the fixture transcript
  db.prepare(`INSERT INTO events (seq, id, source_app, session_id, hook_event_type, received_at, payload)
    VALUES (?,?,?,?,?,?,?)`).run(1, "evt-1", "testapp", SESSION, "SessionStart",
    Date.now(), JSON.stringify({ transcript_path: TRANSCRIPT }));
  // pre-existing usage row for m_old (v3 → no cache_create_1h yet)
  db.prepare(`INSERT INTO usage (session_id, msg_id, source_app, ts, model, input, output, cache_create, cache_read, sidechain)
    VALUES (?,?,?,?,?,?,?,?,?,0)`).run(SESSION, "m_old", "testapp", Date.now(), MODEL,
    100000, 50000, 1000000, 200000);
  // cursor already at EOF — the real-world blocker: a plain re-run reads nothing
  db.prepare(`INSERT INTO transcript_cursor (session_id, path, offset, last_emitted, updated_at)
    VALUES (?,?,?,?,?)`).run(SESSION, TRANSCRIPT, FIXTURE_SIZE, "[]", Date.now());
  db.close();
}

// ── helpers ─────────────────────────────────────────────────────────────────
function cli(...args) {
  const r = spawnSync("node", [...NODE_ARGS, SERVER, ...args], { env: baseEnv, encoding: "utf8" });
  if (r.status !== 0) process.stdout.write(`  (cli ${args.join(" ")} exit ${r.status}: ${r.stderr})\n`);
  return r.stdout || "";
}
function readUsage() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare("SELECT msg_id, cache_create, cache_create_1h FROM usage ORDER BY msg_id").all();
  db.close();
  return Object.fromEntries(rows.map((r) => [r.msg_id, r]));
}
function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p, headers: { Host: "127.0.0.1" } }, (res) => {
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
async function waitHealth(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { await get(port, "/health"); return true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
}
async function modelRow(port, config) {
  if (config === null) { try { fs.unlinkSync(path.join(DATA_DIR, "config.json")); } catch {} }
  else fs.writeFileSync(path.join(DATA_DIR, "config.json"), JSON.stringify(config));
  const srv = spawn("node", [...NODE_ARGS, SERVER], { env: { ...baseEnv, OBS_PORT: String(port) }, stdio: "ignore" });
  try {
    if (!(await waitHealth(port))) throw new Error("server did not come up");
    const res = await get(port, "/stats/tokens?group=model&window=7d");
    return (res.rows || []).find((r) => r.key === MODEL);
  } finally {
    srv.kill("SIGTERM");
    await new Promise((r) => { srv.on("exit", r); setTimeout(r, 2000); });
  }
}

// ── 1. blocker: plain re-run with cursor at EOF changes nothing ──────────────
process.stdout.write("\n# blocker (cursor at EOF, no --rescan)\n");
cli("ingest-usage");
let u = readUsage();
check("m_old still present, 1h NOT backfilled", u.m_old && u.m_old.cache_create_1h === 0, JSON.stringify(u.m_old));
check("m_new / m_flat NOT ingested (file skipped)", !u.m_new && !u.m_flat, JSON.stringify(Object.keys(u)));

// ── 2. migration + --rescan backfills existing row and ingests the rest ──────
process.stdout.write("\n# migration + --rescan\n");
const out = cli("ingest-usage", "--rescan");
check("rescan reported", /rescan/.test(out), out.trim());
u = readUsage();
check("m_old cache_create stays TOTAL (1,000,000)", u.m_old?.cache_create === 1000000, JSON.stringify(u.m_old));
check("m_old cache_create_1h backfilled to 600,000", u.m_old?.cache_create_1h === 600000, JSON.stringify(u.m_old));
check("m_new ingested: total 1000 / 1h 800", u.m_new?.cache_create === 1000 && u.m_new?.cache_create_1h === 800, JSON.stringify(u.m_new));
check("m_flat fallback: total 500 / 1h 0 (no nested object)", u.m_flat?.cache_create === 500 && u.m_flat?.cache_create_1h === 0, JSON.stringify(u.m_flat));

// idempotent: a second rescan yields identical values
cli("ingest-usage", "--rescan");
const u2 = readUsage();
check("rescan is idempotent", JSON.stringify(u2) === JSON.stringify(u), "values drifted on re-run");

// ── 3. billing: per-TTL cost via /stats/tokens (default pricing) ─────────────
process.stdout.write("\n# billing (default pricing)\n");
// m_old  (100000*5 +50000*25 +400000*6.25 +600000*10 +200000*0.5)/1e6 = 10.35
// m_new  (10*5 +20*25 +200*6.25 +800*10 +5*0.5)/1e6                    = 0.0098025
// m_flat (30*5 +40*25 +500*6.25 +0 +0)/1e6                             = 0.004275
// Σ = 10.3640775 → roundUsd → 10.3641
const row = await modelRow(45731, null);
check("model row present", !!row, "no opus-4-8 row");
check("cost_usd = 10.3641 (per-TTL: 1h billed 2×)", row && approx(row.cost_usd, 10.3641), row && String(row.cost_usd));
check("cache_create = TOTAL 1,001,500 (tokens unchanged by split)", row && row.cache_create === 1001500, row && String(row.cache_create));
check("messages = 3", row && row.messages === 3, row && String(row.messages));

// ── 4. config partial override does NOT NaN the cost (shallow-merge guard) ───
process.stdout.write("\n# config partial-override NaN guard\n");
// {cache_write:10} alone would, under a whole-object replace, drop input/output/
// cache_read → NaN. The field-merge keeps them; both 5m & 1h writes now bill 10:
// m_old 11.85 + m_new 0.0105525 + m_flat 0.00615 = 11.8667025 → 11.8667
const row2 = await modelRow(45732, { pricing: { [MODEL]: { cache_write: 10 } } });
check("cost_usd is finite (not NaN)", row2 && Number.isFinite(row2.cost_usd), row2 && String(row2.cost_usd));
check("cost_usd = 11.8667 (partial override merged onto base)", row2 && approx(row2.cost_usd, 11.8667), row2 && String(row2.cost_usd));

// ── done ─────────────────────────────────────────────────────────────────────
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
process.stdout.write(`\n${failures ? "FAILED " + failures : "ALL PASS"}\n`);
process.exit(failures ? 1 : 0);
