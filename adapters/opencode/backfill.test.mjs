#!/usr/bin/env node
// Tests for the opencode → collector backfill (#119).
// Run: node adapters/opencode/backfill.test.mjs
//
// There is no opencode on this machine, so the test builds a SYNTHETIC
// opencode.db in the shape issue #119 documented (session / message / part with
// JSON `data`, tool parts carrying callID, step-finish parts carrying tokens),
// runs the real script against it, and then reads the collector DB back through
// the collector's own server to assert the dashboard sees it.
//
// What it pins:
//   - history keeps its ORIGINAL timestamps (the whole reason the import writes
//     the DB directly instead of POSTing)
//   - the CC event vocabulary is produced, so existing rollups work unchanged
//   - tokens land in `usage` (Tokens tab), tagged runtime=opencode
//   - dry-run writes nothing; a second run is a no-op (cursor); --force redoes it
//   - it refuses to write while a collector is listening

import { spawnSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "backfill.mjs");
const SERVER = path.join(HERE, "..", "..", "core", "observability", "server.mjs");
const NODE_ARGS = ["--disable-warning=ExperimentalWarning"];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc-backfill-test-"));
const OC_DB = path.join(TMP, "opencode.db");
const OBS_DIR = path.join(TMP, "obs");
fs.mkdirSync(OBS_DIR, { recursive: true });

let failed = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` → ${detail}`}`);
};

// ── fixture: an opencode DB with two sessions ──────────────────────────────
const T0 = Date.UTC(2026, 5, 1, 9, 0, 0); // 2026-06-01 — far outside any live window
{
  const db = new DatabaseSync(OC_DB);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT,
             time_created INTEGER, time_updated INTEGER,
             tokens_input INTEGER, tokens_output INTEGER, cost REAL)`);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)`);
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
             type TEXT, data TEXT, time_created INTEGER)`);

  const S = db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?)");
  const M = db.prepare("INSERT INTO message VALUES (?,?,?)");
  const P = db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)");

  S.run("ses_a", "리팩터링", "/home/u/proj-alpha", T0, T0 + 600_000, 1200, 340, 0);
  M.run("msg_a1", "ses_a", JSON.stringify({ role: "user", time: { created: T0 + 1000 } }));
  P.run("prt_a1", "msg_a1", "ses_a", "text", JSON.stringify({ text: "테스트를 고쳐줘" }), T0 + 1000);
  M.run("msg_a2", "ses_a", JSON.stringify({
    role: "assistant", time: { created: T0 + 2000, completed: T0 + 9000 },
    model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
  }));
  P.run("prt_a2", "msg_a2", "ses_a", "step-start", JSON.stringify({}), T0 + 2000);
  P.run("prt_a3", "msg_a2", "ses_a", "tool", JSON.stringify({
    callID: "call_aaa", tool: "bash",
    state: { status: "completed", input: { command: "npm test" }, output: "ok",
      time: { start: T0 + 3000, end: T0 + 5000 } },
  }), T0 + 3000);
  P.run("prt_a4", "msg_a2", "ses_a", "tool", JSON.stringify({
    callID: "call_bbb", tool: "read",
    state: { status: "error", input: { filePath: "/nope" }, error: "ENOENT",
      time: { start: T0 + 6000, end: T0 + 6100 } },
  }), T0 + 6000);
  P.run("prt_a5", "msg_a2", "ses_a", "step-finish", JSON.stringify({
    tokens: { total: 1540, input: 1200, output: 340, reasoning: 0, cache: { read: 900, write: 120 } },
  }), T0 + 9000);

  // a second session on another project, one prompt, no tools
  S.run("ses_b", null, "/home/u/proj-beta", T0 + 86_400_000, T0 + 86_400_000 + 5000, 10, 5, 0);
  M.run("msg_b1", "ses_b", JSON.stringify({ role: "user", time: { created: T0 + 86_400_000 + 100 } }));
  P.run("prt_b1", "msg_b1", "ses_b", "text", JSON.stringify({ text: "안녕" }), T0 + 86_400_000 + 100);
  db.close();
}

// ── the collector DB the import writes into (schema owned by the server) ────
const baseEnv = { ...process.env, OBS_DATA_DIR: OBS_DIR, OBS_PORT: "45810", OBS_TITLE_AUTO: "0" };

const health = (port) => new Promise((res) => {
  http.get({ host: "127.0.0.1", port, path: "/health", headers: { Host: "127.0.0.1" } },
    (r) => { r.resume(); res(true); }).on("error", () => res(false));
});
async function startCollector() {
  const srv = spawn("node", [...NODE_ARGS, SERVER], { env: baseEnv, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    if (await health(45810)) return srv;
    await new Promise((r) => setTimeout(r, 100));
  }
  return srv;
}
async function stopCollector(srv) {
  srv.kill("SIGTERM");
  await new Promise((r) => { srv.on("exit", r); setTimeout(r, 2000); });
}
// The collector owns the schema (and its migrations), so let it create the DB
// once — the import refuses to invent a schema it doesn't own.
await stopCollector(await startCollector());

const run = (...args) => spawnSync("node", [...NODE_ARGS, SCRIPT, "--db", OC_DB, "--data-dir", OBS_DIR, ...args],
  { env: baseEnv, encoding: "utf8" });

// ── dry run ─────────────────────────────────────────────────────────────────
{
  const r = run();
  check("dry run: exits 0", r.status === 0, r.stderr);
  check("dry run: counts both sessions", /sessions\s+:\s*2 to import/.test(r.stdout), r.stdout.slice(0, 300));
  check("dry run: reports the historical date range", /2026-06-01/.test(r.stdout), r.stdout);
  check("dry run: writes nothing", (() => {
    const db = new DatabaseSync(path.join(OBS_DIR, "events.db"), { readOnly: true });
    const n = db.prepare("SELECT COUNT(*) c FROM events").get().c;
    db.close();
    return Number(n) === 0;
  })());
}

// ── inspect ─────────────────────────────────────────────────────────────────
{
  const r = run("--inspect");
  check("inspect: dumps tables + part.type histogram",
    /session → table "session"/.test(r.stdout) && /part\.type histogram: .*tool=2/.test(r.stdout),
    r.stdout.slice(0, 400));
}

// ── the real import ─────────────────────────────────────────────────────────
{
  const r = run("--write");
  check("write: exits 0", r.status === 0, r.stderr);
  check("write: reports imported counts", /imported \d+ events \+ 1 usage rows/.test(r.stdout), r.stdout.slice(-400));
  check("write: warns about the retention window", /OBS_MAX_AGE_DAYS/.test(r.stdout), "no retention warning");

  const db = new DatabaseSync(path.join(OBS_DIR, "events.db"), { readOnly: true });
  const rows = db.prepare("SELECT * FROM events ORDER BY seq").all();
  const types = rows.map((r2) => r2.hook_event_type);
  const a = rows.filter((r2) => r2.session_id === "ses_a");
  const usage = db.prepare("SELECT * FROM usage").all();
  db.close();

  check("events: CC vocabulary produced",
    types.includes("SessionStart") && types.includes("UserPromptSubmit") &&
    types.includes("PreToolUse") && types.includes("PostToolUse") && types.includes("Stop"),
    types.join(","));
  check("events: every row tagged runtime=opencode", rows.every((r2) => r2.runtime === "opencode"));
  check("events: ORIGINAL timestamps preserved (not now)",
    a.every((r2) => Math.abs(Number(r2.received_at) - T0) < 86_400_000),
    JSON.stringify(a.slice(0, 2).map((r2) => r2.received_at)));
  check("events: source_app = project dir basename",
    a.every((r2) => r2.source_app === "proj-alpha"), a[0]?.source_app);
  check("events: tool pairs share the callID",
    a.filter((r2) => r2.tool_use_id === "call_aaa").length === 2,
    String(a.filter((r2) => r2.tool_use_id === "call_aaa").length));
  check("events: failed tool call carries the error",
    a.some((r2) => r2.hook_event_type === "PostToolUse" && r2.tool_use_id === "call_bbb" && r2.error === "ENOENT"));
  check("events: idle session marked ended", types.includes("SessionEnd"));
  check("usage: one row per step-finish with the token split",
    usage.length === 1 && usage[0].input === 1200 && usage[0].output === 340 &&
    usage[0].cache_read === 900 && usage[0].cache_create === 120 && usage[0].model === "claude-sonnet-5",
    JSON.stringify(usage[0]));
}

// ── idempotency ─────────────────────────────────────────────────────────────
{
  const before = countEvents();
  const r = run("--write");
  check("re-run: cursor skips already-imported sessions",
    /2 already imported/.test(r.stdout) && countEvents() === before, r.stdout.slice(0, 300));

  const f = run("--write", "--force");
  check("--force: re-imports to the SAME row count (prior import cleared first)",
    f.status === 0 && countEvents() === before, `${before} → ${countEvents()}`);
}

// ── refuses to write while the collector is up ──────────────────────────────
{
  const srv = await startCollector();
  const r = run("--write", "--force");
  check("refuses to write while the collector is listening",
    r.status === 1 && /수집기가/.test(r.stderr), `status=${r.status} ${r.stderr.slice(0, 120)}`);

  // and the dashboard's own API sees the backfilled session
  const sess = await new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port: 45810, path: "/stats/sessions?window=all&limit=50", headers: { Host: "127.0.0.1" } },
      (r2) => { const c = []; r2.on("data", (x) => c.push(x)); r2.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch (e) { rej(e); } }); }).on("error", rej);
  });
  const row = (sess.sessions || []).find((s) => s.session_id === "ses_a");
  check("dashboard: backfilled session visible with window=all", !!row, JSON.stringify(sess.count));
  check("dashboard: tagged as opencode", row && row.runtime === "opencode", row && row.runtime);
  check("dashboard: turns + tool_calls counted", row && row.turns === 1 && row.tool_calls === 2,
    row && `${row.turns}/${row.tool_calls}`);
  check("dashboard: original start time kept", row && Math.abs(row.started_at - T0) < 86_400_000,
    row && new Date(row.started_at).toISOString());

  await stopCollector(srv);
}

function countEvents() {
  const db = new DatabaseSync(path.join(OBS_DIR, "events.db"), { readOnly: true });
  const n = Number(db.prepare("SELECT COUNT(*) c FROM events").get().c);
  db.close();
  return n;
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
