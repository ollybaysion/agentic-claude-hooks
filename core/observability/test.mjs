// Deterministic end-to-end checks for the token cost views (#57 + #56).
// No test framework — plain assertions over the real CLI + HTTP surface.
//
//   node --disable-warning=ExperimentalWarning core/observability/test.mjs
//
// #57 — v3→v4 migration (ALTER adds cache_create_1h), the re-backfill path
// (cursor-at-EOF blocker → --rescan drops cursors + upsert refreshes old rows),
// TTL-split collection + fallback, per-TTL billing (5m 1.25× / 1h 2×), the
// no-regression invariant (cache_create stays the TOTAL), and the config
// partial-override NaN guard.
// #56 — cost anatomy (group=anatomy: 4-component split + pct + baseline_ctx),
// per-session diagnostics (group=session: avg/peak ctx, model switches +
// rewrite est, mega flag), and the session timeline (group=timeline: context
// series, compact markers, compact what-if).
// #66 — session titles: /stats/sessions first_prompt derivation, the batch
// `title-sessions` (LLM stubbed via OBS_TITLE_STUB), title→first_prompt fallback,
// and the candidate filter (0-prompt skipped, titled-not-grown not re-titled).

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
// OBS_TITLE_AUTO=0 pins off the server-side auto-titler so no spawned test server
// fires a `title-sessions` child at a live claude (the CLI titler path below is
// tested directly and is unaffected by this gate).
const baseEnv = { ...process.env, OBS_DATA_DIR: DATA_DIR, OBS_TOKEN: "", OBS_TITLE_AUTO: "0" };

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
function cliEnv(env, ...args) {
  const r = spawnSync("node", [...NODE_ARGS, SERVER, ...args], { env: { ...baseEnv, ...env }, encoding: "utf8" });
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
function postJson(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method: "POST",
        headers: { Host: "127.0.0.1", "content-type": "application/json", "content-length": data.length } },
      (res) => { const c = []; res.on("data", (x) => c.push(x));
        res.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch {}
          resolve({ status: res.statusCode, body: j }); }); });
    req.on("error", reject); req.write(data); req.end();
  });
}
async function waitHealth(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { await get(port, "/health"); return true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
}
// spawn a fresh server, GET one stats path, return parsed JSON. config=null
// clears any config.json first (default pricing/thresholds).
async function statGet(port, qpath, config = null) {
  if (config === null) { try { fs.unlinkSync(path.join(DATA_DIR, "config.json")); } catch {} }
  else fs.writeFileSync(path.join(DATA_DIR, "config.json"), JSON.stringify(config));
  const srv = spawn("node", [...NODE_ARGS, SERVER], { env: { ...baseEnv, OBS_PORT: String(port) }, stdio: "ignore" });
  try {
    if (!(await waitHealth(port))) throw new Error("server did not come up");
    return await get(port, qpath);
  } finally {
    srv.kill("SIGTERM");
    await new Promise((r) => { srv.on("exit", r); setTimeout(r, 2000); });
  }
}
async function modelRow(port, config) {
  const res = await statGet(port, "/stats/tokens?group=model&window=7d", config);
  return (res.rows || []).find((r) => r.key === MODEL);
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

// ══ #56 — cost anatomy + session diagnostics + timeline ══════════════════════

// ── 5. anatomy: per-model 4-component cost split (transcript session only) ────
process.stdout.write("\n# anatomy (cost by component)\n");
// components (opus-4-8): input 0.5002 / write 8.512375 / read 0.1000025 / output 1.2515
const anat = await statGet(45733, "/stats/tokens?group=anatomy&window=7d", null);
const T = anat.totals || {};
check("anatomy totals cost = 10.3641", approx(T.cost_usd, 10.3641), String(T.cost_usd));
check("components sum to cost", approx(T.input_usd + T.write_usd + T.read_usd + T.output_usd, T.cost_usd, 1e-4),
  `${T.input_usd}+${T.write_usd}+${T.read_usd}+${T.output_usd}`);
check("write is the dominant component (1h 2×)", approx(T.write_usd, 8.5124, 1e-3), String(T.write_usd));
check("pct sums to ~100", T.pct && approx(T.pct.input + T.pct.write + T.pct.read + T.pct.output, 100, 0.5), JSON.stringify(T.pct));
check("baseline_ctx = min main-chain ctx (530)", T.baseline_ctx === 530, String(T.baseline_ctx));
const am = (anat.rows || []).find((r) => r.key === MODEL);
check("per-model anatomy row present, cost 10.3641", am && approx(am.cost_usd, 10.3641), am && String(am.cost_usd));

// ── 6. session diagnostics on the transcript session (mega TRUE branch) ──────
process.stdout.write("\n# session diagnostics (avg/peak ctx, mega)\n");
// ctx: m_old 1,300,000 · m_new 1015 · m_flat 530 → avg 433848, peak 1,300,000
const sess = await statGet(45734, "/stats/tokens?group=session&window=7d", null);
const S = (sess.rows || []).find((r) => r.key === SESSION);
check("session row present", !!S, "no SESSION row");
check("messages = 3 (no-regression)", S && S.messages === 3, S && String(S.messages));
check("session cost = 10.3641 (no-regression)", S && approx(S.cost_usd, 10.3641), S && String(S.cost_usd));
check("avg_ctx = 433848", S && S.avg_ctx === 433848, S && String(S.avg_ctx));
check("peak_ctx = 1,300,000", S && S.peak_ctx === 1300000, S && String(S.peak_ctx));
check("model_switches = 0 (single model)", S && S.model_switches === 0, S && String(S.model_switches));
check("mega = true (avg_ctx ≥ 300k)", S && S.mega === true, S && String(S.mega));

// ── 7. multi-model session: switches, rewrite, compact markers, what-if ──────
process.stdout.write("\n# switches + compact markers + what-if\n");
{
  const db = new DatabaseSync(DB_PATH);
  const ins = db.prepare(`INSERT INTO usage
    (session_id, msg_id, source_app, ts, model, input, output, cache_create, cache_read, cache_create_1h, sidechain, emitted_tool_ids, follows_tool_ids)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,'[]','[]')`);
  const base = Date.now() - 60000;
  // [msg_id, model, input, output, cache_create (all 1h), cache_read]
  const rows = [
    ["t1", "claude-opus-4-8", 1000, 1000, 100000, 0],       // ctx 101000
    ["t2", "claude-opus-4-8", 1000, 1000, 100000, 300000],  // ctx 401000 (peak)
    ["t3", "claude-opus-4-8", 1000, 1000, 20000, 5000],     // ctx 26000  → compact marker
    ["t4", "claude-fable-5", 1000, 1000, 50000, 10000],     // ctx 61000  → model switch
  ];
  rows.forEach((r, i) => ins.run("sess-mix", r[0], "testapp", base + i * 1000, r[1], r[2], r[3], r[4], r[5], r[4]));
  db.close();
}
const mix = await statGet(45735, "/stats/tokens?group=session&window=7d", null);
const M = (mix.rows || []).find((r) => r.key === "sess-mix");
check("sess-mix present", !!M, "no sess-mix row");
check("messages = 4", M && M.messages === 4, M && String(M.messages));
check("avg_ctx = 147250", M && M.avg_ctx === 147250, M && String(M.avg_ctx));
check("peak_ctx = 401000", M && M.peak_ctx === 401000, M && String(M.peak_ctx));
check("model_switches = 1", M && M.model_switches === 1, M && String(M.model_switches));
check("switch_rewrite_est = 1.0 (fable 1h rewrite)", M && approx(M.switch_rewrite_est, 1.0), M && String(M.switch_rewrite_est));
check("mega = false (small session)", M && M.mega === false, M && String(M.mega));
check("latest context = t4 (61000)", M && M.context === 61000, M && String(M.context));

const tl = await statGet(45736, "/stats/tokens?group=timeline&session_id=sess-mix", null);
check("timeline count = 4", tl.count === 4, String(tl.count));
check("ctx series in ts order", tl.series && JSON.stringify(tl.series.map((s) => s.ctx)) === JSON.stringify([101000, 401000, 26000, 61000]),
  tl.series && JSON.stringify(tl.series.map((s) => s.ctx)));
check("one compact marker (401000→26000)",
  tl.compact_markers && tl.compact_markers.length === 1 && tl.compact_markers[0].from_ctx === 401000 && tl.compact_markers[0].to_ctx === 26000,
  JSON.stringify(tl.compact_markers));
check("what-if @200k ≈ 0.05, @300k = 0", tl.whatif && approx(tl.whatif["200000"], 0.05) && tl.whatif["300000"] === 0, JSON.stringify(tl.whatif));

// timeline requires a session_id
const tlBad = await statGet(45737, "/stats/tokens?group=timeline", null);
check("timeline without session_id → error", !!tlBad.error, JSON.stringify(tlBad));

// ══ #66 — session titles (first-prompt fallback + batch titler) ══════════════
process.stdout.write("\n# session titles (first_prompt + title-sessions)\n");
{
  const db = new DatabaseSync(DB_PATH);
  const insE = db.prepare(`INSERT INTO events (seq,id,source_app,session_id,hook_event_type,received_at,payload) VALUES (?,?,?,?,?,?,?)`);
  const past = Date.now() - 3600000; // > ACTIVE_MS ago → idle → titler candidate
  insE.run(100, "e100", "testapp", "sess-title", "UserPromptSubmit", past,        JSON.stringify({ prompt: "대시보드 세션 제목 만들기" }));
  insE.run(101, "e101", "testapp", "sess-title", "PreToolUse",       past + 1000, JSON.stringify({}));
  insE.run(102, "e102", "testapp", "sess-title", "UserPromptSubmit", past + 2000, JSON.stringify({ prompt: "두 번째 질문" }));
  insE.run(110, "e110", "testapp", "sess-noprompt", "SessionStart",  past,        JSON.stringify({}));
  db.close();
}
// first_prompt derived from the earliest UserPromptSubmit; title still null
const st1 = await statGet(45738, "/stats/sessions?window=7d&limit=100", null);
const stt = (st1.sessions || []).find((r) => r.session_id === "sess-title");
const stn = (st1.sessions || []).find((r) => r.session_id === "sess-noprompt");
check("first_prompt = earliest UserPromptSubmit", stt && stt.first_prompt === "대시보드 세션 제목 만들기", stt && JSON.stringify(stt.first_prompt));
check("title null before titling", stt && stt.title === null, stt && JSON.stringify(stt.title));
check("no prompt → first_prompt null", stn && stn.first_prompt === null, stn && JSON.stringify(stn.first_prompt));

// batch titler with a stubbed LLM (OBS_TITLE_STUB) — deterministic, no claude spawn
const tOut = cliEnv({ OBS_TITLE_STUB: "스텁 제목" }, "title-sessions");
check("titler titled exactly 1 (only idle, ≥1 prompt, untitled)", /titled=1\b/.test(tOut), tOut.trim());
const st2 = await statGet(45739, "/stats/sessions?window=7d&limit=100", null);
const stt2 = (st2.sessions || []).find((r) => r.session_id === "sess-title");
const stn2 = (st2.sessions || []).find((r) => r.session_id === "sess-noprompt");
check("title set, overrides first_prompt", stt2 && stt2.title === "스텁 제목", stt2 && JSON.stringify(stt2.title));
check("0-prompt session stays untitled", stn2 && stn2.title === null, stn2 && JSON.stringify(stn2.title));

// re-run without growth → not re-titled (candidate filter excludes titled-not-grown)
const tOut2 = cliEnv({ OBS_TITLE_STUB: "다른 제목" }, "title-sessions");
check("no candidates on re-run (titled=0)", /titled=0\b/.test(tOut2), tOut2.trim());
const st3 = await statGet(45740, "/stats/sessions?window=7d&limit=100", null);
const stt3 = (st3.sessions || []).find((r) => r.session_id === "sess-title");
check("existing title unchanged without growth", stt3 && stt3.title === "스텁 제목", stt3 && JSON.stringify(stt3.title));

// ══ auto-titler short idle gate (--idle) — recent sessions titled for the fleet ═
process.stdout.write("\n# auto-titler short idle gate (--idle)\n");
{
  const db = new DatabaseSync(DB_PATH);
  const insE = db.prepare(`INSERT INTO events (seq,id,source_app,session_id,hook_event_type,received_at,payload) VALUES (?,?,?,?,?,?,?)`);
  const recent = Date.now() - 5000; // quiet only 5s → "active", excluded by the default 600s gate
  insE.run(120, "e120", "testapp", "sess-recent", "UserPromptSubmit", recent, JSON.stringify({ prompt: "방금 시작한 활성 세션" }));
  db.close();
}
// default gate (ACTIVE_MS=600s): the recent session is NOT a candidate → untitled
cliEnv({ OBS_TITLE_STUB: "최근 스텁" }, "title-sessions");
const stR1 = await statGet(45743, "/stats/sessions?window=7d&limit=100", null);
const rr1 = (stR1.sessions || []).find((r) => r.session_id === "sess-recent");
check("recent session untitled at default idle gate", rr1 && rr1.title === null, rr1 && JSON.stringify(rr1.title));
// short idle (--idle 2 = 2s quiet): now a candidate → titled (what the auto-titler passes)
const tShort = cliEnv({ OBS_TITLE_STUB: "최근 스텁" }, "title-sessions", "--idle", "2");
check("short --idle titles the recent session", /sess-rec/.test(tShort), tShort.trim());
const stR2 = await statGet(45744, "/stats/sessions?window=7d&limit=100", null);
const rr2 = (stR2.sessions || []).find((r) => r.session_id === "sess-recent");
check("recent session titled with short idle", rr2 && rr2.title === "최근 스텁", rr2 && JSON.stringify(rr2.title));

// ══ #63 — nudge observation (/stats/nudges: fires + join to outcomes) ════════
process.stdout.write("\n# nudge observation (/stats/nudges)\n");
const NT = Date.now();
const FIRE_B_TS = NT + 1; // fire B has byteOffset null → outcome joins on this ts
{
  const db = new DatabaseSync(DB_PATH);
  const insN = db.prepare(`INSERT INTO events (seq,id,source_app,session_id,hook_event_type,received_at,payload) VALUES (?,?,?,?,?,?,?)`);
  // Fire A: priced terminal, byteOffset present → joins by (hash, byteOffset)
  insN.run(200, "n200", "app-a", "sess-n", "NudgeFired", NT, JSON.stringify({
    ts: NT, transcriptHash: "hashA", kind: "pr-create", template: "terminal",
    keepLabel: "기능 X 구현", dropLabel: "PR #9", dropForm: "captured",
    ctxTokens: 360000, byteOffset: 12345, estUsd: 0.42, model: "claude-fable-5", costShown: "on" }));
  // Fire B: start, byteOffset NULL → must join by (hash, ts) fallback (F3)
  insN.run(201, "n201", "app-a", "sess-n", "NudgeFired", FIRE_B_TS, JSON.stringify({
    ts: FIRE_B_TS, transcriptHash: "hashB", kind: "branch-cleanup", template: "start",
    keepLabel: "기능 Y", dropLabel: null, dropForm: null,
    ctxTokens: 120000, byteOffset: null, estUsd: 0.1, model: "claude-fable-5", costShown: "on" }));
  // Fire C: unpriced terminal, never gets an outcome
  insN.run(202, "n202", "app-b", "sess-n2", "NudgeFired", NT + 2, JSON.stringify({
    ts: NT + 2, transcriptHash: "hashC", kind: "pr-create", template: "terminal",
    keepLabel: "기능 Z", dropLabel: "PR #10", dropForm: "inherited",
    ctxTokens: 90000, byteOffset: 42, estUsd: null, model: "<synthetic>", costShown: "unpriced" }));
  db.close();
}
// outcome-ABSENT case: fires present, no NudgeOutcome yet
const nu1 = await statGet(45741, "/stats/nudges?window=7d", null);
check("nudges: fires counted", nu1.count === 3, JSON.stringify(nu1.count));
check("nudges: compliance null without outcomes", nu1.compliance === null, JSON.stringify(nu1.compliance));
check("nudges: judgment n=0 without outcomes", nu1.judgment && nu1.judgment.n === 0, JSON.stringify(nu1.judgment));
const kPr = (nu1.by_kind || []).find((k) => k.kind === "pr-create" && k.template === "terminal");
check("nudges: by_kind × template groups", kPr && kPr.count === 2, JSON.stringify(kPr));
check("nudges: recent complied null without outcomes", (nu1.recent || []).length === 3 && (nu1.recent || []).every((r) => r.complied === null), JSON.stringify((nu1.recent || []).map((r) => r.complied)));

// push acp's outcomes (analyze — acp#29): A complied, B not; B joins via ts fallback
{
  const db = new DatabaseSync(DB_PATH);
  const insN = db.prepare(`INSERT INTO events (seq,id,source_app,session_id,hook_event_type,received_at,payload) VALUES (?,?,?,?,?,?,?)`);
  insN.run(210, "n210", "app-a", "sess-n", "NudgeOutcome", NT, JSON.stringify({
    ref: { transcriptHash: "hashA", byteOffset: 12345, ts: NT }, complied: true,
    horizon: "next-turn", baseRateWindow: 0.3, keepAudit: { misassigned: false } }));
  insN.run(211, "n211", "app-a", "sess-n", "NudgeOutcome", NT, JSON.stringify({
    ref: { transcriptHash: "hashB", byteOffset: null, ts: FIRE_B_TS }, complied: false,
    baseRateWindow: 0.3, keepAudit: { misassigned: true } }));
  db.close();
}
// outcome-PRESENT case: compliance rollup + join semantics
const nu2 = await statGet(45742, "/stats/nudges?window=7d", null);
check("nudges: outcomes joined", nu2.compliance && nu2.compliance.outcomes === 2, JSON.stringify(nu2.compliance));
check("nudges: complied count", nu2.compliance && nu2.compliance.complied === 1, JSON.stringify(nu2.compliance));
check("nudges: rate = complied/outcomes", nu2.compliance && approx(nu2.compliance.rate, 0.5), JSON.stringify(nu2.compliance));
check("nudges: base rate carried through", nu2.compliance && nu2.compliance.base_rate === 0.3, JSON.stringify(nu2.compliance));
check("nudges: keep misassign counted", nu2.compliance && nu2.compliance.keep_misassign === 1, JSON.stringify(nu2.compliance));
check("nudges: judgment n=2 with outcomes", nu2.judgment && nu2.judgment.n === 2, JSON.stringify(nu2.judgment));
const recB = (nu2.recent || []).find((r) => r.kind === "branch-cleanup");
check("nudges: byteOffset-null fire joined by ts fallback (F3)", recB && recB.complied === false, JSON.stringify(recB));
const recA = (nu2.recent || []).find((r) => r.dropLabel === "PR #9");
check("nudges: complied fire marked ✓", recA && recA.complied === true, JSON.stringify(recA));
const recC = (nu2.recent || []).find((r) => r.costShown === "unpriced");
check("nudges: unmatched fire stays null", recC && recC.complied === null, JSON.stringify(recC));

// ══ #87 — DB query observation (/stats/db: agent-db-plugin DbQuery events) ════
process.stdout.write("\n# db query observation (/stats/db)\n");
const DBT = Date.now();
{
  const db = new DatabaseSync(DB_PATH);
  const insD = db.prepare(`INSERT INTO events (seq,id,source_app,session_id,hook_event_type,tool_name,received_at,payload) VALUES (?,?,?,?,?,?,?,?)`);
  const dq = (seq, alias, tool, sql, elapsedMs, oraError, at) =>
    insD.run(seq, "d" + seq, "agent-db-plugin", "agent-db", "DbQuery", tool, at, JSON.stringify({
      alias, tool, sql, elapsedMs, rowCount: oraError ? null : 1, truncated: oraError ? null : false, oraError }));
  dq(250, "erp-prod", "run_query", "SELECT * FROM gl_accounts WHERE id = 1", 120, null, DBT);
  dq(251, "erp-prod", "run_query", "SELECT a.* FROM gl_accounts a JOIN gl_periods p ON a.pid = p.id", 350, null, DBT + 1); // slowest
  dq(252, "erp-prod", "run_query", "SELECT * FROM missing_tbl", 5, "ORA-00942: table or view does not exist", DBT + 2);
  dq(253, "hr-stg", "describe_table", "SELECT column_name FROM all_tab_columns WHERE table_name = 'EMP'", 30, null, DBT + 3);
  dq(254, "hr-stg", "run_query", "SELECT * FROM employees", 60, null, DBT + 4);
  dq(255, "erp-prod", "run_query", "SELECT * FROM another_missing", 8, "ORA-00942: table or view does not exist", DBT + 5);
  db.close();
}
const dbs = await statGet(45760, "/stats/db?window=7d", null);
check("db: rows counted", dbs.count === 6, JSON.stringify(dbs.count));
check("db: errors counted", dbs.errors === 2, JSON.stringify(dbs.errors));
const aErp = (dbs.by_alias || []).find((a) => a.alias === "erp-prod");
check("db: by_alias totals + errors", aErp && aErp.total === 4 && aErp.errors === 2, JSON.stringify(aErp));
check("db: by_alias slowest_ms", aErp && aErp.slowest_ms === 350, JSON.stringify(aErp));
const tRun = (dbs.by_tool || []).find((t) => t.tool === "run_query");
const tDesc = (dbs.by_tool || []).find((t) => t.tool === "describe_table");
check("db: by_tool groups (run_query vs catalog reads)", tRun && tRun.count === 5 && tDesc && tDesc.count === 1, JSON.stringify(dbs.by_tool));
const e942 = (dbs.by_error || []).find((e) => e.code === "ORA-00942");
check("db: ORA code aggregated", e942 && e942.count === 2, JSON.stringify(dbs.by_error));
check("db: slowest first, non-error", (dbs.slow || [])[0] && dbs.slow[0].elapsedMs === 350 && dbs.slow[0].oraError === null, JSON.stringify((dbs.slow || [])[0]));
const errRow = (dbs.slow || []).find((s) => s.oraError);
check("db: errored query carries oraError", errRow && /ORA-00942/.test(errRow.oraError), JSON.stringify(errRow));
const tGl = (dbs.top_tables || []).find((t) => t.table === "GL_ACCOUNTS");
check("db: top_tables from FROM/JOIN (approx)", tGl && tGl.count === 2, JSON.stringify(dbs.top_tables));
const tPer = (dbs.top_tables || []).find((t) => t.table === "GL_PERIODS");
check("db: JOIN table extracted", tPer && tPer.count === 1, JSON.stringify(tPer));

// ══ #73 — Turn Inspector (/stats/turns: grouping, pairing, time split, flags) ═
process.stdout.write("\n# turn inspector (/stats/turns)\n");
{
  const db = new DatabaseSync(DB_PATH);
  const ins = db.prepare(`INSERT INTO events
    (seq,id,source_app,session_id,hook_event_type,tool_name,tool_use_id,agent_id,error,received_at,payload)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const ev = (seq, sess, type, at, o = {}) =>
    ins.run(seq, "e" + seq, "testapp", sess, type, o.tool ?? null, o.tid ?? null,
      o.agent ?? null, o.err ?? null, at, JSON.stringify(o.payload ?? {}));
  const BT = Date.now() - 3_600_000; // 1h ago → sessions idle, un-Posted Pres are orphans

  // sess-turn T1: normal turn — Read then a 40s Bash (long-tail)
  ev(300, "sess-turn", "UserPromptSubmit", BT, { payload: { prompt: "첫 질문" } });
  ev(301, "sess-turn", "PreToolUse", BT + 1000, { tool: "Read", tid: "tu-a", payload: { tool_input: { file_path: "/tmp/a.txt" } } });
  ev(302, "sess-turn", "PostToolUse", BT + 1400, { tool: "Read", tid: "tu-a" });
  ev(303, "sess-turn", "PreToolUse", BT + 2000, { tool: "Bash", tid: "tu-b", payload: { tool_input: { command: "npm test" } } });
  ev(304, "sess-turn", "PostToolUse", BT + 42000, { tool: "Bash", tid: "tu-b" });
  ev(305, "sess-turn", "Stop", BT + 45000);
  // T2: dup Read + Edit-exempted re-Read + one error + stop-hook double Stop
  ev(310, "sess-turn", "UserPromptSubmit", BT + 60000, { payload: { prompt: "둘째" } });
  ev(311, "sess-turn", "PreToolUse", BT + 61000, { tool: "Read", tid: "tu-r1", payload: { tool_input: { file_path: "/tmp/b.txt" } } });
  ev(312, "sess-turn", "PostToolUse", BT + 61200, { tool: "Read", tid: "tu-r1" });
  ev(313, "sess-turn", "PreToolUse", BT + 62000, { tool: "Read", tid: "tu-r2", payload: { tool_input: { file_path: "/tmp/b.txt" } } });
  ev(314, "sess-turn", "PostToolUse", BT + 62200, { tool: "Read", tid: "tu-r2" });
  ev(315, "sess-turn", "PreToolUse", BT + 63000, { tool: "Edit", tid: "tu-e1", payload: { tool_input: { file_path: "/tmp/b.txt", old_string: "x", new_string: "y" } } });
  ev(316, "sess-turn", "PostToolUse", BT + 63200, { tool: "Edit", tid: "tu-e1" });
  ev(317, "sess-turn", "PreToolUse", BT + 64000, { tool: "Read", tid: "tu-r3", payload: { tool_input: { file_path: "/tmp/b.txt" } } });
  ev(318, "sess-turn", "PostToolUse", BT + 64200, { tool: "Read", tid: "tu-r3" });
  ev(319, "sess-turn", "PreToolUse", BT + 65000, { tool: "Bash", tid: "tu-x1", payload: { tool_input: { command: "false" } } });
  ev(320, "sess-turn", "PostToolUse", BT + 65500, { tool: "Bash", tid: "tu-x1", err: "exit 1" });
  ev(321, "sess-turn", "Stop", BT + 66000);
  ev(322, "sess-turn", "Stop", BT + 67000); // stop-hook loop → LAST Stop is the end
  // T3: queued prompt mid-turn — in-flight tu-q1 pairs AFTER the second prompt → merge
  ev(330, "sess-turn", "UserPromptSubmit", BT + 120000, { payload: { prompt: "셋째" } });
  ev(331, "sess-turn", "PreToolUse", BT + 121000, { tool: "Bash", tid: "tu-q1", payload: { tool_input: { command: "sleep 5" } } });
  ev(332, "sess-turn", "UserPromptSubmit", BT + 123000, { payload: { prompt: "큐잉 질문" } });
  ev(333, "sess-turn", "PostToolUse", BT + 125000, { tool: "Bash", tid: "tu-q1" });
  ev(334, "sess-turn", "Stop", BT + 126000);
  // T4: Esc interrupt — orphan Pre + GuardDecision within 3s, then a new prompt → SPLIT
  ev(340, "sess-turn", "UserPromptSubmit", BT + 180000, { payload: { prompt: "넷째" } });
  ev(341, "sess-turn", "PreToolUse", BT + 181000, { tool: "Grep", tid: "tu-g1", payload: { tool_input: { pattern: "foo" } } });
  ev(342, "sess-turn", "GuardDecision", BT + 181500, { payload: { guard: "bash-guard", rule: "rm-scan", decision: "deny" } });
  ev(343, "sess-turn", "UserPromptSubmit", BT + 185000, { payload: { prompt: "다섯째" } });
  ev(344, "sess-turn", "PreToolUse", BT + 186000, { tool: "Read", tid: "tu-z1", payload: { tool_input: { file_path: "/tmp/c.txt" } } });
  ev(345, "sess-turn", "PostToolUse", BT + 186300, { tool: "Read", tid: "tu-z1" });
  ev(346, "sess-turn", "Stop", BT + 187000);
  // T6: permission wait inside a call + subagent lane + post-stop tail + late main Post
  ev(350, "sess-turn", "UserPromptSubmit", BT + 240000, { payload: { prompt: "여섯째" } });
  ev(351, "sess-turn", "PreToolUse", BT + 241000, { tool: "Bash", tid: "tu-w1", payload: { tool_input: { command: "deploy prod" } } });
  ev(352, "sess-turn", "Notification", BT + 242000, { payload: { message: "Claude needs your permission to use Bash" } });
  ev(353, "sess-turn", "PostToolUse", BT + 250000, { tool: "Bash", tid: "tu-w1" });
  ev(354, "sess-turn", "PreToolUse", BT + 251000, { tool: "Task", tid: "tu-s1", payload: { tool_input: { description: "verify diff", subagent_type: "general-purpose" } } });
  ev(355, "sess-turn", "PreToolUse", BT + 252000, { tool: "Grep", tid: "tu-sub1", agent: "agentA", payload: { tool_input: { pattern: "x" } } });
  ev(356, "sess-turn", "PostToolUse", BT + 253000, { tool: "Grep", tid: "tu-sub1", agent: "agentA" });
  ev(357, "sess-turn", "Stop", BT + 254000);
  ev(358, "sess-turn", "PreToolUse", BT + 255000, { tool: "Read", tid: "tu-sub2", agent: "agentA", payload: { tool_input: { file_path: "/tmp/d.txt" } } });
  ev(359, "sess-turn", "PostToolUse", BT + 255400, { tool: "Read", tid: "tu-sub2", agent: "agentA" });
  ev(360, "sess-turn", "SubagentStop", BT + 256000, { agent: "agentA" });
  ev(361, "sess-turn", "PostToolUse", BT + 257000, { tool: "Task", tid: "tu-s1" }); // late main Post = tail, must NOT extend the end

  // sess-race: Stop arrives 300ms AFTER the queued prompt (hook POST race) —
  // it must end turn A (else A looks interrupted and B "completes" with 0 calls)
  const RT = Date.now() - 1_800_000;
  ev(400, "sess-race", "UserPromptSubmit", RT, { payload: { prompt: "레이스 A" } });
  ev(401, "sess-race", "PreToolUse", RT + 1000, { tool: "Read", tid: "tu-ra", payload: { tool_input: { file_path: "/tmp/r.txt" } } });
  ev(402, "sess-race", "PostToolUse", RT + 1200, { tool: "Read", tid: "tu-ra" });
  ev(403, "sess-race", "UserPromptSubmit", RT + 10000, { payload: { prompt: "레이스 B" } });
  ev(404, "sess-race", "Stop", RT + 10300);
  ev(405, "sess-race", "PreToolUse", RT + 11000, { tool: "Read", tid: "tu-rb", payload: { tool_input: { file_path: "/tmp/r2.txt" } } });
  ev(406, "sess-race", "PostToolUse", RT + 11300, { tool: "Read", tid: "tu-rb" });
  ev(407, "sess-race", "Stop", RT + 12000);

  // sess-par: two overlapping Greps — tool_ms must be the interval UNION (4200),
  // not the naive duration sum (8000)
  const PT = Date.now() - 1_700_000;
  ev(420, "sess-par", "UserPromptSubmit", PT, { payload: { prompt: "병렬" } });
  ev(421, "sess-par", "PreToolUse", PT + 1000, { tool: "Grep", tid: "tu-pa", payload: { tool_input: { pattern: "aaa" } } });
  ev(422, "sess-par", "PreToolUse", PT + 1200, { tool: "Grep", tid: "tu-pb", payload: { tool_input: { pattern: "bbb" } } });
  ev(423, "sess-par", "PostToolUse", PT + 5000, { tool: "Grep", tid: "tu-pa" });
  ev(424, "sess-par", "PostToolUse", PT + 5200, { tool: "Grep", tid: "tu-pb" });
  ev(425, "sess-par", "Stop", PT + 6000);

  // sess-cross: bg Bash spawned in turn 1, Post lands in turn 2's window —
  // session-wide pairing keeps it turn 1's call (crosses_turn), NOT an orphan,
  // and turn 2 must not count the stray Post as unpaired
  const CT = Date.now() - 1_600_000;
  ev(440, "sess-cross", "UserPromptSubmit", CT, { payload: { prompt: "크로스" } });
  ev(441, "sess-cross", "PreToolUse", CT + 1000, { tool: "Bash", tid: "tu-bg", payload: { tool_input: { command: "long build", run_in_background: true } } });
  ev(442, "sess-cross", "Stop", CT + 2000);
  ev(443, "sess-cross", "UserPromptSubmit", CT + 10000, { payload: { prompt: "다음" } });
  ev(444, "sess-cross", "PostToolUse", CT + 12000, { tool: "Bash", tid: "tu-bg" });
  ev(445, "sess-cross", "Stop", CT + 13000);

  // sess-storm: five sequential Greps 3s apart before any Read → 5 batches
  const ST = Date.now() - 1_500_000;
  ev(460, "sess-storm", "UserPromptSubmit", ST, { payload: { prompt: "폭풍" } });
  for (let i = 0; i < 5; i++) {
    ev(461 + i * 2, "sess-storm", "PreToolUse", ST + 1000 + i * 3000, { tool: "Grep", tid: "tu-st" + i, payload: { tool_input: { pattern: "p" + i } } });
    ev(462 + i * 2, "sess-storm", "PostToolUse", ST + 1200 + i * 3000, { tool: "Grep", tid: "tu-st" + i });
  }
  ev(471, "sess-storm", "Stop", ST + 16000);

  // sess-batch: five PARALLEL Greps (one probe) → 1 batch, no storm
  const BT2 = Date.now() - 1_400_000;
  ev(480, "sess-batch", "UserPromptSubmit", BT2, { payload: { prompt: "배치" } });
  for (let i = 0; i < 5; i++)
    ev(481 + i, "sess-batch", "PreToolUse", BT2 + 1000 + i * 10, { tool: "Grep", tid: "tu-ba" + i, payload: { tool_input: { pattern: "q" + i } } });
  for (let i = 0; i < 5; i++)
    ev(486 + i, "sess-batch", "PostToolUse", BT2 + 3000 + i * 10, { tool: "Grep", tid: "tu-ba" + i });
  ev(491, "sess-batch", "Stop", BT2 + 4000);

  // sess-retry: the same Bash erroring 3× with one Read between → retry-loop
  const RT2 = Date.now() - 1_300_000;
  ev(500, "sess-retry", "UserPromptSubmit", RT2, { payload: { prompt: "재시도" } });
  ev(501, "sess-retry", "PreToolUse", RT2 + 1000, { tool: "Bash", tid: "tu-f1", payload: { tool_input: { command: "flaky-cmd" } } });
  ev(502, "sess-retry", "PostToolUse", RT2 + 1500, { tool: "Bash", tid: "tu-f1", err: "exit 1" });
  ev(503, "sess-retry", "PreToolUse", RT2 + 2000, { tool: "Read", tid: "tu-rr", payload: { tool_input: { file_path: "/tmp/log.txt" } } });
  ev(504, "sess-retry", "PostToolUse", RT2 + 2100, { tool: "Read", tid: "tu-rr" });
  ev(505, "sess-retry", "PreToolUse", RT2 + 3000, { tool: "Bash", tid: "tu-f2", payload: { tool_input: { command: "flaky-cmd" } } });
  ev(506, "sess-retry", "PostToolUse", RT2 + 3500, { tool: "Bash", tid: "tu-f2", err: "exit 1" });
  ev(507, "sess-retry", "PreToolUse", RT2 + 4000, { tool: "Bash", tid: "tu-f3", payload: { tool_input: { command: "flaky-cmd" } } });
  ev(508, "sess-retry", "PostToolUse", RT2 + 4500, { tool: "Bash", tid: "tu-f3", err: "exit 1" });
  ev(509, "sess-retry", "Stop", RT2 + 5000);

  // sess-open: active session, un-Posted Pre is PENDING (not orphan), turn OPEN
  const OT = Date.now() - 5000;
  ev(520, "sess-open", "UserPromptSubmit", OT, { payload: { prompt: "진행중" } });
  ev(521, "sess-open", "PreToolUse", OT + 1000, { tool: "Bash", tid: "tu-o1", payload: { tool_input: { command: "work" } } });

  // sess-zero: residue before the first prompt folds into virtual turn #0
  const ZT = Date.now() - 1_200_000;
  ev(540, "sess-zero", "SessionStart", ZT, { payload: { source: "resume" } });
  ev(541, "sess-zero", "UserPromptSubmit", ZT + 1000, { payload: { prompt: "제로" } });
  ev(542, "sess-zero", "Stop", ZT + 3000);

  // sess-auto: a harness-injected prompt (background task-notification) starts
  // the turn — classified `auto`, not a human question (#73 stage 2)
  const AT = Date.now() - 1_100_000;
  ev(550, "sess-auto", "UserPromptSubmit", AT, { payload: { prompt: "<task-notification>\n<task-id>abc123def</task-id>\n<status>completed</status>\n</task-notification>" } });
  ev(551, "sess-auto", "PreToolUse", AT + 1000, { tool: "Read", tid: "tu-au1", payload: { tool_input: { file_path: "/tmp/out.txt" } } });
  ev(552, "sess-auto", "PostToolUse", AT + 1300, { tool: "Read", tid: "tu-au1" });
  ev(553, "sess-auto", "Stop", AT + 2000);

  // sess-gexact (#99): two orphan Pres in one turn; the GuardDecision carries the
  // BLOCKED call's tool_use_id in its payload (tu-m1), not the top-level column.
  // The ±3s time window would grab tu-m2 (Pre only 100ms from the deny); the
  // exact id-match must instead correlate to tu-m1 (1100ms away) and count it.
  const GX = Date.now() - 1_000_000; // idle → un-Posted Pres are orphans
  ev(560, "sess-gexact", "UserPromptSubmit", GX, { payload: { prompt: "가드" } });
  ev(561, "sess-gexact", "PreToolUse", GX + 1000, { tool: "Bash", tid: "tu-m1", payload: { tool_input: { command: "git commit --no-verify" } } });
  ev(562, "sess-gexact", "PreToolUse", GX + 2000, { tool: "Grep", tid: "tu-m2", payload: { tool_input: { pattern: "x" } } });
  ev(563, "sess-gexact", "GuardDecision", GX + 2100, { payload: { guard: "git-guard", rule: "no-verify", decision: "deny", tool_use_id: "tu-m1" } });
  ev(564, "sess-gexact", "Stop", GX + 5000);

  // #73 stage 3 — usage rows for sess-turn (opus-4-8: in $5/M · out $25/M).
  // One row → one bucket: u1 emitted→T1($0.5), u2 follows-with-empty-emitted→T1
  // ($0.5), u3 id-less ts inside T2→T2($1.0), u4 id-less inter-turn ts→
  // unattributed($0.5), u5 emitted(T5)+follows(T4)→emitted wins→T5($1.0).
  // #81: u6 sidechain row, emitted = T6's subagent call → cost_subagent_usd($1.0).
  const insU = db.prepare(`INSERT INTO usage
    (session_id, msg_id, source_app, ts, model, input, output, cache_create, cache_read, cache_create_1h, sidechain, emitted_tool_ids, follows_tool_ids)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const uMODEL = "claude-opus-4-8";
  insU.run("sess-turn", "u1", "testapp", BT + 500, uMODEL, 100000, 0, 0, 0, 0, 0, '["tu-a"]', "[]");
  insU.run("sess-turn", "u2", "testapp", BT + 2500, uMODEL, 0, 20000, 0, 0, 0, 0, "[]", '["tu-b"]');
  insU.run("sess-turn", "u3", "testapp", BT + 61000, uMODEL, 200000, 0, 0, 0, 0, 0, "[]", "[]");
  insU.run("sess-turn", "u4", "testapp", BT + 100000, uMODEL, 100000, 0, 0, 0, 0, 0, "[]", "[]");
  insU.run("sess-turn", "u5", "testapp", BT + 186100, uMODEL, 0, 40000, 0, 0, 0, 0, '["tu-z1"]', '["tu-g1"]');
  insU.run("sess-turn", "u6", "testapp", BT + 252500, uMODEL, 0, 40000, 0, 0, 0, 1, '["tu-sub1"]', "[]");
  db.close();
}

// list view: grouping, boundaries, statuses, flags
const tu = await statGet(45745, "/stats/turns?session_id=sess-turn", null);
check("turns: sess-turn has 6 turns (queued merged, interrupt split)", tu.count === 6, JSON.stringify(tu.count));
const [T1, T2, T3, T4, T5, T6] = tu.turns || [];
check("turns: keyed by the prompt's seq", T1 && T1.turn_seq === 300 && T4 && T4.turn_seq === 340, JSON.stringify((tu.turns || []).map((t) => t.turn_seq)));
check("T1 complete, 2 calls, 45s wall", T1 && T1.status === "complete" && T1.calls === 2 && T1.duration_ms === 45000, JSON.stringify(T1));
check("T1 tool_ms 40400 / gap 4600", T1 && T1.tool_ms === 40400 && T1.gap_ms === 4600, T1 && `${T1.tool_ms}/${T1.gap_ms}`);
check("T1 long-tail (40s Bash ≥ 50% of tool time)", T1 && T1.flags.includes("long-tail"), T1 && JSON.stringify(T1.flags));
check("T1 longest = Bash 40s", T1 && T1.longest && T1.longest.tool_name === "Bash" && T1.longest.duration_ms === 40000, T1 && JSON.stringify(T1.longest));
check("T2 last Stop wins (ended at 2nd Stop)", T2 && T2.ended_at - T2.started_at === 7000, T2 && String(T2.ended_at - T2.started_at));
check("T2 dup-call: identical re-Read counted once (Edit exempts the 3rd)", T2 && T2.dup_calls === 1 && T2.flags.includes("dup-call"), T2 && JSON.stringify({ d: T2.dup_calls, f: T2.flags }));
check("T2 re-read: 3 overlapping full-range Reads of one file", T2 && T2.flags.includes("re-read"), T2 && JSON.stringify(T2.flags));
check("T2 errors = 1", T2 && T2.errors === 1, T2 && String(T2.errors));
check("T3 queued prompt merged (1 turn, queued_prompts=1)", T3 && T3.turn_seq === 330 && T3.queued_prompts === 1 && T3.status === "complete", JSON.stringify(T3));
check("T4 interrupted (Esc: no Stop, no in-flight pairing)", T4 && T4.status === "interrupted", T4 && T4.status);
check("T4 orphan + guard-deny correlated + flagged", T4 && T4.orphans === 1 && T4.guard_denies === 1 && T4.flags.includes("orphaned"), JSON.stringify(T4));
check("T5 split off as its own turn", T5 && T5.turn_seq === 343 && T5.status === "complete" && T5.calls === 1, JSON.stringify(T5));
check("T6 permission wait carved out: wait 8000, tool 4000, gap 2000", T6 && T6.wait_ms === 8000 && T6.tool_ms === 4000 && T6.gap_ms === 2000, T6 && `${T6.wait_ms}/${T6.tool_ms}/${T6.gap_ms}`);
check("T6 late main Post is tail, does NOT extend the end", T6 && T6.duration_ms === 14000, T6 && String(T6.duration_ms));
check("T6 subagent lane: 2 calls, 1 agent, union 1400ms", T6 && T6.subagent_calls === 2 && T6.subagents === 1 && T6.subagent_ms === 1400, T6 && JSON.stringify({ c: T6.subagent_calls, a: T6.subagents, ms: T6.subagent_ms }));
check("T6 post_stop_events = 4", T6 && T6.post_stop_events === 4, T6 && String(T6.post_stop_events));
check("T6 identity: wall = tool + wait + gap", T6 && T6.duration_ms === T6.tool_ms + T6.wait_ms + T6.gap_ms, T6 && JSON.stringify(T6));

// detail view: calls timeline + markers
const td = await statGet(45746, "/stats/turns?session_id=sess-turn&turn=350", null);
check("detail: turn echoed with 4 calls", td.turn && td.turn.turn_seq === 350 && (td.calls || []).length === 4, JSON.stringify(td.turn && td.turn.calls));
const dw1 = (td.calls || []).find((c) => c.tool_use_id === "tu-w1");
const ds1 = (td.calls || []).find((c) => c.tool_use_id === "tu-s1");
const dsub2 = (td.calls || []).find((c) => c.tool_use_id === "tu-sub2");
check("detail: permission wait attributed to the enclosing call", dw1 && dw1.wait_ms === 8000, JSON.stringify(dw1));
check("detail: input_summary from the whitelist (Bash command)", dw1 && dw1.input_summary === "deploy prod", dw1 && dw1.input_summary);
check("detail: subagent tail call marked (lane+tail)", dsub2 && dsub2.lane === "subagent" && dsub2.tail === true, JSON.stringify(dsub2));
check("detail: late Task Post stays ok, not crossing (no next turn)", ds1 && ds1.status === "ok" && ds1.crosses_turn === false, JSON.stringify(ds1));
const mkP = (td.markers || []).find((m) => m.type === "Notification");
const mkS = (td.markers || []).filter((m) => m.type === "Stop");
check("detail: permission marker with wait", mkP && mkP.kind === "permission" && mkP.wait_ms === 8000, JSON.stringify(mkP));
check("detail: Stop + SubagentStop markers present", mkS.length === 1 && (td.markers || []).some((m) => m.type === "SubagentStop"), JSON.stringify(td.markers));
const tg = await statGet(45747, "/stats/turns?session_id=sess-turn&turn=340", null);
const mkG = (tg.markers || []).find((m) => m.type === "GuardDecision");
check("detail: GuardDecision marker correlated to the orphan Pre", mkG && mkG.guard === "bash-guard" && mkG.correlated_tool_use_id === "tu-g1", JSON.stringify(mkG));

// #99 exact id-match beats the time window: two orphans, the deny names tu-m1 in
// its payload though tu-m2's Pre is 11× closer in time.
const tgx = await statGet(45772, "/stats/turns?session_id=sess-gexact", null);
const GX1 = (tgx.turns || [])[0];
check("gexact: one turn, 2 orphans, exactly 1 guard-deny, orphaned", GX1 && tgx.count === 1 && GX1.orphans === 2 && GX1.guard_denies === 1 && GX1.flags.includes("orphaned"), JSON.stringify(GX1));
const tgxd = await statGet(45773, "/stats/turns?session_id=sess-gexact&turn=560", null);
const mkGx = (tgxd.markers || []).find((m) => m.type === "GuardDecision");
check("gexact: exact tool_use_id match picks tu-m1, not time-nearest tu-m2", mkGx && mkGx.correlated_tool_use_id === "tu-m1", JSON.stringify(mkGx));

// boundary race: the late Stop ends turn A; turn B keeps its own call
const tr = await statGet(45748, "/stats/turns?session_id=sess-race", null);
check("race: 2 turns, A complete via the raced Stop", tr.count === 2 && tr.turns[0].status === "complete" && tr.turns[0].ended_at - tr.turns[0].started_at === 10300, JSON.stringify(tr.turns && tr.turns[0]));
check("race: B unaffected (1 call, complete)", tr.turns && tr.turns[1].calls === 1 && tr.turns[1].status === "complete", JSON.stringify(tr.turns && tr.turns[1]));

// parallel: union not sum; second call flagged parallel with gap 0
const tp = await statGet(45749, "/stats/turns?session_id=sess-par", null);
check("parallel: tool_ms = union 4200 (not 8000)", tp.turns && tp.turns[0].tool_ms === 4200, JSON.stringify(tp.turns && tp.turns[0].tool_ms));
const tpd = await statGet(45750, "/stats/turns?session_id=sess-par&turn=420", null);
check("parallel: overlap badge + zero gap on the 2nd call", tpd.calls && tpd.calls[1].parallel === true && tpd.calls[1].gap_before_ms === 0, JSON.stringify(tpd.calls && tpd.calls[1]));

// crosses-turn: bg call owned by its Pre's turn; no fake orphan/unpaired
const tc = await statGet(45751, "/stats/turns?session_id=sess-cross", null);
check("cross: turn1 owns the call, clipped tool 1000ms", tc.turns && tc.turns[0].calls === 1 && tc.turns[0].tool_ms === 1000 && tc.turns[0].orphans === 0, JSON.stringify(tc.turns && tc.turns[0]));
check("cross: turn2 has 0 calls and 0 unpaired (stray Post is paired)", tc.turns && tc.turns[1].calls === 0 && tc.turns[1].unpaired === 0, JSON.stringify(tc.turns && tc.turns[1]));
const tcd = await statGet(45752, "/stats/turns?session_id=sess-cross&turn=" + tc.turns[0].turn_seq, null);
check("cross: crosses_turn + bg badges on the call", tcd.calls && tcd.calls[0].crosses_turn === true && tcd.calls[0].bg === true && tcd.calls[0].status === "ok", JSON.stringify(tcd.calls && tcd.calls[0]));

// search-storm fires on sequential probing, folds on a parallel batch
const ts1 = await statGet(45753, "/stats/turns?session_id=sess-storm", null);
check("storm: 5 sequential Greps → search-storm", ts1.turns && ts1.turns[0].flags.includes("search-storm"), JSON.stringify(ts1.turns && ts1.turns[0].flags));
const ts2 = await statGet(45754, "/stats/turns?session_id=sess-batch", null);
check("storm: 5 parallel Greps = one probe → no flag", ts2.turns && !ts2.turns[0].flags.includes("search-storm"), JSON.stringify(ts2.turns && ts2.turns[0].flags));

// retry-loop: same command erroring 3× (one Read between keeps the chain)
const tt = await statGet(45755, "/stats/turns?session_id=sess-retry", null);
check("retry: 3 same-input errors → retry-loop", tt.turns && tt.turns[0].flags.includes("retry-loop"), JSON.stringify(tt.turns && tt.turns[0].flags));

// open turn: recent un-Posted Pre is pending, not orphan
const to = await statGet(45756, "/stats/turns?session_id=sess-open", null);
check("open: active session turn is open, no orphan", to.turns && to.turns[0].status === "open" && to.turns[0].orphans === 0, JSON.stringify(to.turns && to.turns[0]));
const tod = await statGet(45757, "/stats/turns?session_id=sess-open&turn=520", null);
check("open: the in-flight call is pending", tod.calls && tod.calls[0].status === "pending", JSON.stringify(tod.calls && tod.calls[0]));

// virtual #0 folds pre-prompt residue, never judged
const tz = await statGet(45758, "/stats/turns?session_id=sess-zero", null);
check("zero: virtual #0 + real turn", tz.count === 2 && tz.turns[0].turn_seq === 0 && tz.turns[0].n === 0 && tz.turns[0].status === "virtual" && tz.turns[0].flags.length === 0, JSON.stringify(tz.turns && tz.turns[0]));
check("zero: human prompt is not auto", tz.turns && tz.turns[1].auto === null, JSON.stringify(tz.turns && tz.turns[1] && tz.turns[1].auto));

// harness-injected prompt classified as auto (#73 stage 2)
const ta = await statGet(45762, "/stats/turns?session_id=sess-auto", null);
check("auto: task-notification prompt classified", ta.turns && ta.turns[0].auto === "task-notification" && ta.turns[0].status === "complete", JSON.stringify(ta.turns && ta.turns[0] && { auto: ta.turns[0].auto, st: ta.turns[0].status }));

// #73 stage 3 — per-turn cost: one usage row lands in exactly one bucket
check("cost: emitted→T1 + follows(empty emitted)→T1 = $1.0", T1 && approx(T1.cost_usd, 1.0), T1 && String(T1.cost_usd));
check("cost: id-less row falls to the ts window (T2 $1.0)", T2 && approx(T2.cost_usd, 1.0), T2 && String(T2.cost_usd));
check("cost: zero attributed rows → null, never $0.00", T3 && T3.cost_usd === null && T4 && T4.cost_usd === null && T6 && T6.cost_usd === null, JSON.stringify([T3 && T3.cost_usd, T4 && T4.cost_usd, T6 && T6.cost_usd]));
check("cost: emitted wins over follows (T5 $1.0, not T4)", T5 && approx(T5.cost_usd, 1.0), T5 && String(T5.cost_usd));
check("cost: session total 4.5 (sub 포함) / unattributed 0.5 (inter-turn ts)", approx(tu.usage_cost_usd, 4.5) && approx(tu.unattributed_cost_usd, 0.5), JSON.stringify({ t: tu.usage_cost_usd, u: tu.unattributed_cost_usd }));
check("cost: sidechain row → cost_subagent_usd (T6 sub $1.0, main null 유지)", T6 && approx(T6.cost_subagent_usd, 1.0) && T6.cost_usd === null, T6 && JSON.stringify({ sub: T6.cost_subagent_usd, main: T6.cost_usd }));
check("cost: session without usage → totals null + turn cost null", tr.usage_cost_usd === null && tr.unattributed_cost_usd === null && tr.turns[0].cost_usd === null, JSON.stringify({ t: tr.usage_cost_usd, c: tr.turns && tr.turns[0].cost_usd }));

// API contract: session_id required; unknown turn → error body
const tbad = await statGet(45759, "/stats/turns", null);
check("turns without session_id → error", !!tbad.error, JSON.stringify(tbad));
const tmiss = await statGet(45760, "/stats/turns?session_id=sess-turn&turn=99999", null);
check("unknown turn → not-found error", !!tmiss.error, JSON.stringify(tmiss));

// config override: a huge storm threshold suppresses the sess-storm flag
const tcfg = await statGet(45761, "/stats/turns?session_id=sess-storm", { turns: { storm: 99 } });
check("config {turns:{storm}} overrides the threshold", tcfg.turns && !tcfg.turns[0].flags.includes("search-storm"), JSON.stringify(tcfg.turns && tcfg.turns[0].flags));

// ══ #81 — subagent usage (subagents/agent-*.jsonl ingestion, schema v6) ══════
process.stdout.write("\n# subagent usage (#81)\n");
{
  // subagent transcripts live at <dir(main transcript)>/<sessionId>/subagents/
  const subDir = path.join(DATA_DIR, SESSION, "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  const subMsg = (id, out, ids) => JSON.stringify({
    type: "assistant", timestamp: NOW, isSidechain: true, sessionId: SESSION,
    message: {
      id, model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: ids ? ids.map((x) => ({ type: "tool_use", id: x })) : [],
    },
  });
  fs.writeFileSync(path.join(subDir, "agent-agsub1.jsonl"),
    subMsg("ms1", 100, ["tu-sub-x"]) + "\n" + subMsg("ms2", 200, null) + "\n");
}
cli("ingest-usage");
{
  const db2 = new DatabaseSync(DB_PATH, { readOnly: true });
  const subRows = db2.prepare("SELECT msg_id, sidechain, agent_id, output FROM usage WHERE msg_id IN ('ms1','ms2') ORDER BY msg_id").all();
  const curs = db2.prepare("SELECT COUNT(*) c FROM transcript_cursor WHERE session_id = ?").get(SESSION);
  const ver = db2.prepare("SELECT * FROM pragma_user_version").get();
  db2.close();
  check("sub: v3 DB migrated to schema v7 (cursor PK rebuild + usage.agent_id/inserted_at)", ver && Object.values(ver)[0] === 7, JSON.stringify(ver));
  check("sub: agent file ingested — sidechain=1 + agent_id from filename",
    subRows.length === 2 && subRows.every((r) => r.sidechain === 1 && r.agent_id === "agsub1"), JSON.stringify(subRows));
  check("sub: per-(session,path) cursors — main + 1 agent file = 2", curs && curs.c === 2, JSON.stringify(curs));
}
cli("ingest-usage"); // cursors at EOF → nothing re-ingested
{
  const db2 = new DatabaseSync(DB_PATH, { readOnly: true });
  const n = db2.prepare("SELECT COUNT(*) c FROM usage WHERE msg_id IN ('ms1','ms2')").get();
  db2.close();
  check("sub: idempotent re-run (still 2 rows)", n && n.c === 2, JSON.stringify(n));
}

// ══ #82 — fleet turn materialization (turns table: gating, reconcile, freeze) ══
process.stdout.write("\n# fleet turn materialization (#82)\n");
cli("materialize-turns"); // backfill from the seeded events
{
  const db2 = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = (sid) => db2.prepare("SELECT * FROM turns WHERE session_id=? ORDER BY turn_seq").all(sid);
  const cur = (sid) => db2.prepare("SELECT * FROM turn_cursor WHERE session_id=?").get(sid);
  const ver = db2.prepare("SELECT * FROM pragma_user_version").get();
  const stRows = rows("sess-turn");
  const t1 = stRows.find((r) => r.turn_seq === 300), t6 = stRows.find((r) => r.turn_seq === 350);
  const stCur = cur("sess-turn");
  const openRows = rows("sess-open").length;
  const virt = rows("sess-zero").find((r) => r.turn_seq === 0);
  db2.close();
  check("mat: v7 turns/turn_cursor live", ver && Object.values(ver)[0] === 7, JSON.stringify(ver));
  check("mat: sess-turn — all 6 settled turns materialized (idle session)", stRows.length === 6, JSON.stringify(stRows.map((r) => r.turn_seq)));
  check("mat: row mirrors buildTurns (T1 tool_ms 40400 + long-tail flag+mask)",
    t1 && t1.tool_ms === 40400 && JSON.parse(t1.flags).includes("long-tail") && (t1.flags_mask & 16) !== 0,
    t1 && JSON.stringify({ m: t1.tool_ms, f: t1.flags, mask: t1.flags_mask }));
  check("mat: per-turn cost persisted (T1 $1.0 main, T6 $1.0 sub)",
    t1 && approx(t1.cost_usd, 1.0) && t6 && approx(t6.cost_subagent_usd, 1.0),
    JSON.stringify({ t1: t1 && t1.cost_usd, t6sub: t6 && t6.cost_subagent_usd }));
  check("mat: [residual] cursor unattributed = total − Σsettled = 0.5", stCur && approx(stCur.unattributed_cost_usd, 0.5), stCur && String(stCur.unattributed_cost_usd));
  check("mat: [gate] open last turn NOT materialized (sess-open → 0 rows)", openRows === 0, String(openRows));
  check("mat: virtual #0 materialized (n=0, status virtual)", virt && virt.n === 0 && virt.status === "virtual", JSON.stringify(virt));
  check("mat: cursor healthy (not frozen, config_ver set)", stCur && stCur.frozen === 0 && stCur.config_ver !== 0, stCur && JSON.stringify({ f: stCur.frozen, cv: stCur.config_ver }));
}
// [reconcile] a turn_seq that buildTurns no longer produces must be deleted, not left as a ghost
{
  const dbw = new DatabaseSync(DB_PATH);
  dbw.prepare(`INSERT INTO turns (session_id,turn_seq,source_app,n,status,started_at,ended_at,duration_ms,tool_ms,wait_ms,gap_ms,calls,subagent_calls,distinct_tools,errors,orphans,dup_calls,guard_denies,queued_prompts,precompacts,flags,flags_mask,config_ver,materialized_at)
    VALUES ('sess-turn',99999,'x',9,'complete',0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,'[]',0,0,0)`).run();
  dbw.prepare("UPDATE usage SET inserted_at=? WHERE session_id='sess-turn' AND msg_id='u1'").run(Date.now()); // bump arrival → candidate again (no cost change)
  dbw.close();
}
cli("materialize-turns");
{
  const db2 = new DatabaseSync(DB_PATH, { readOnly: true });
  const ghost = db2.prepare("SELECT COUNT(*) c FROM turns WHERE session_id='sess-turn' AND turn_seq=99999").get();
  const n = db2.prepare("SELECT COUNT(*) c FROM turns WHERE session_id='sess-turn'").get();
  db2.close();
  check("mat: [reconcile] vanished turn_seq deleted (ghost 99999 gone)", ghost.c === 0, JSON.stringify(ghost));
  check("mat: idempotent re-run keeps exactly 6 rows", n.c === 6, JSON.stringify(n));
}
// [freeze] trimming early events must NOT re-derive over the truncated stream
{
  const dbw = new DatabaseSync(DB_PATH);
  dbw.prepare("DELETE FROM events WHERE session_id='sess-turn' AND seq <= 305").run(); // drop T1's events → MIN(seq) rises
  dbw.prepare("UPDATE usage SET inserted_at=? WHERE session_id='sess-turn' AND msg_id='u1'").run(Date.now() + 1000); // force candidacy
  dbw.close();
}
cli("materialize-turns");
{
  const db2 = new DatabaseSync(DB_PATH, { readOnly: true });
  const c = db2.prepare("SELECT frozen FROM turn_cursor WHERE session_id='sess-turn'").get();
  const n = db2.prepare("SELECT COUNT(*) c FROM turns WHERE session_id='sess-turn'").get();
  db2.close();
  check("mat: [freeze] trimmed session frozen, historical rows preserved", c && c.frozen === 1 && n.c === 6, JSON.stringify({ frozen: c && c.frozen, rows: n.c }));
}
// stage 2: /stats/fleet-turns aggregates over the materialized table
const ft = await statGet(45770, "/stats/fleet-turns?window=7d", null);
check("fleet: totals over materialized turns", ft.totals && ft.totals.settled_turns > 0, JSON.stringify(ft.totals && ft.totals.settled_turns));
check("fleet: by_app rolls up (Σ app turns = settled_turns)", (ft.by_app || []).reduce((s, a) => s + a.turns, 0) === ft.totals.settled_turns, JSON.stringify(ft.by_app));
const ftFlags = (ft.by_flag || []).map((f) => f.flag);
check("fleet: by_flag surfaces seeded inefficiencies (long-tail/search-storm/retry-loop)",
  ["long-tail", "search-storm", "retry-loop"].every((f) => ftFlags.indexOf(f) >= 0), JSON.stringify(ftFlags));
check("fleet: series + unattributed present", (ft.series || []).length > 0 && ft.totals.unattributed_cost_usd != null,
  JSON.stringify({ series: (ft.series || []).length, unatt: ft.totals && ft.totals.unattributed_cost_usd }));

// ══ #92 — keyword-docs corpus viewer (/docs + /docs/content) ═════════════════
process.stdout.write("\n# keyword-docs corpus viewer (/docs)\n");
function getRaw(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p, headers: { Host: "127.0.0.1" } }, (res) => {
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => { let body = {}; try { body = JSON.parse(Buffer.concat(c).toString()); } catch {} resolve({ status: res.statusCode, body }); });
    }).on("error", reject);
  });
}
{
  const H = fs.mkdtempSync(path.join(os.tmpdir(), "obs-docs-"));
  fs.mkdirSync(path.join(H, ".claude", "docs", "db"), { recursive: true });
  // keyword-docs instance: one plain doc + one entry whose file is missing
  fs.writeFileSync(path.join(H, ".claude", "context-docs.json"),
    JSON.stringify([{ keywords: ["alpha"], path: ".claude/docs/alpha.md" },
                    { keywords: ["gone"], path: ".claude/docs/missing.md" }]));
  // db-schema instance: one dbdoc-marked doc
  fs.writeFileSync(path.join(H, ".claude", "context-docs.db-schema.json"),
    JSON.stringify([{ keywords: ["orders"], path: ".claude/docs/db/orders.md" }]));
  // msg-format instance: a BROKEN index → must fail-soft (contribute nothing, no 500)
  fs.writeFileSync(path.join(H, ".claude", "context-docs.msg-format.json"), "{ not json ]");
  fs.writeFileSync(path.join(H, ".claude", "docs", "alpha.md"), "# Alpha\n\nplain doc, no markers.\n");
  fs.writeFileSync(path.join(H, ".claude", "docs", "db", "orders.md"),
    "# ORDERS\n\n용도: 추정) 주문 원장 [근거: OrderMapper.java:12]\n\n컬럼 status: {{설명 미작성}}\n");
  fs.writeFileSync(path.join(H, "secret.md"), "under home but not indexed, not under docs\n");
  const outside = path.join(os.tmpdir(), "obs-docs-outside-" + path.basename(H) + ".md");
  fs.writeFileSync(outside, "outside the home entirely\n");

  const srv = spawn("node", [...NODE_ARGS, SERVER], { env: { ...baseEnv, OBS_PORT: "45780", OBS_DOCS_HOME: H }, stdio: "ignore" });
  try {
    await waitHealth(45780);
    const list = await get(45780, "/docs");
    check("docs: lists user-layer docs across instances (broken index skipped)", list.count === 3, JSON.stringify(list.count));
    const alpha = (list.docs || []).find((d) => d.display.endsWith("alpha.md"));
    const orders = (list.docs || []).find((d) => d.display.endsWith("orders.md"));
    const missing = (list.docs || []).find((d) => d.display.endsWith("missing.md"));
    check("docs: instances labelled (keyword-docs / db-schema)",
      alpha && alpha.instance === "keyword-docs" && orders && orders.instance === "db-schema",
      JSON.stringify([alpha && alpha.instance, orders && orders.instance]));
    check("docs: broken index contributes nothing (fail-soft)", !(list.docs || []).some((d) => d.instance === "msg-format"), JSON.stringify(list.docs.map((d) => d.instance)));
    check("docs: plain doc → no tier chrome", alpha && alpha.exists && alpha.tiers.dbdoc === false, JSON.stringify(alpha && alpha.tiers));
    check("docs: dbdoc doc tiers counted", orders && orders.tiers.dbdoc === true && orders.tiers.scaffold === 1 && orders.tiers.inferred === 1, JSON.stringify(orders && orders.tiers));
    check("docs: missing file flagged exists:false", missing && missing.exists === false, JSON.stringify(missing));

    const good = await getRaw(45780, "/docs/content?path=" + encodeURIComponent(orders.path));
    check("docs/content: serves an indexed doc verbatim", good.status === 200 && /추정\)/.test(good.body.content || ""), JSON.stringify(good.status));
    const sec = await getRaw(45780, "/docs/content?path=" + encodeURIComponent(path.join(H, "secret.md")));
    check("docs/content: refuses a non-indexed file (under home, not under docs)", sec.status === 403, JSON.stringify(sec.status));
    const out = await getRaw(45780, "/docs/content?path=" + encodeURIComponent(outside));
    check("docs/content: refuses a path outside home", out.status === 403, JSON.stringify(out.status));
    const trav = await getRaw(45780, "/docs/content?path=" + encodeURIComponent(path.join(H, ".claude", "docs", "..", "..", "secret.md")));
    check("docs/content: `..` traversal collapses out of the allowlist → 403", trav.status === 403, JSON.stringify(trav.status));
    const gone = await getRaw(45780, "/docs/content?path=" + encodeURIComponent(path.join(H, ".claude", "docs", "missing.md")));
    check("docs/content: missing file → 404", gone.status === 404, JSON.stringify(gone.status));
  } finally {
    srv.kill("SIGTERM");
    await new Promise((r) => { srv.on("exit", r); setTimeout(r, 2000); });
    try { fs.rmSync(H, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(outside, { force: true }); } catch {}
  }
}

// ══ #90 — enrich apply/promote activity log (/stats/schema-docs, events only) ══
// The review "queue" folded into the keyword-docs corpus table's 추정) column: a
// live /docs file scan whose tiers.inferred is asserted in the docs-viewer test
// above. This endpoint is now the events-only apply/promote HISTORY under it.
process.stdout.write("\n# enrich apply/promote log (/stats/schema-docs)\n");
{
  // seed apply/promote events into the shared DB
  const db = new DatabaseSync(DB_PATH);
  const insSD = db.prepare(`INSERT INTO events (seq,id,source_app,session_id,hook_event_type,received_at,payload) VALUES (?,?,?,?,?,?,?)`);
  const SDT = Date.now();
  insSD.run(90001, "sd0", "db-schema-enrich", "enrich", "SchemaDocApply", SDT,
    JSON.stringify({ doc: "sensor.md", filled: [{ slot: "purpose" }, { slot: "column:SNSR_ID" }], skipped: [] }));
  insSD.run(90002, "sd1", "db-schema-enrich", "enrich", "SchemaDocPromote", SDT + 1,
    JSON.stringify({ doc: "sensor.md", promoted: ["purpose"] }));
  db.close();

  const srv = spawn("node", [...NODE_ARGS, SERVER], { env: { ...baseEnv, OBS_PORT: "45781" }, stdio: "ignore" });
  try {
    await waitHealth(45781);
    const sd = await get(45781, "/stats/schema-docs?window=90d");
    check("schema-docs: events-only now (no file-scan queue)", sd.queue === undefined, JSON.stringify(Object.keys(sd)));
    check("schema-docs: history totals from apply/promote events",
      sd.totals.applies === 1 && sd.totals.promotes === 1 && sd.totals.promoted_slots === 1 && sd.totals.filled_slots === 2,
      JSON.stringify(sd.totals));
    const ap = (sd.history || []).find((h) => h.type === "apply");
    const pr = (sd.history || []).find((h) => h.type === "promote");
    check("schema-docs: history entries carry doc + counts", ap && ap.doc === "sensor.md" && ap.filled === 2 && pr && pr.promoted === 1, JSON.stringify({ ap, pr }));
  } finally {
    srv.kill("SIGTERM");
    await new Promise((r) => { srv.on("exit", r); setTimeout(r, 2000); });
  }
}

// ══ #112 — dashboard promote (POST /actions/schema-docs/promote, stage 2) ══════
// The write half: a human clicks 승격 → the collector delegates to the
// db-schema-apply CLI (`promote --all --write`), which rewrites the doc and emits
// SchemaDocPromote. Assert the gate (allowlist / method / body), the file rewrite,
// idempotency, and that the emit lands in the activity log.
process.stdout.write("\n# dashboard promote (POST /actions/schema-docs/promote)\n");
{
  // fixture: one indexed doc with 2 inferred slots — a manual purpose region and
  // the 5th (설명) cell of a column row, the exact shape apply.mjs promote rewrites.
  const H = fs.mkdtempSync(path.join(os.tmpdir(), "obs-promote-"));
  fs.mkdirSync(path.join(H, ".claude", "docs", "db"), { recursive: true });
  fs.writeFileSync(path.join(H, ".claude", "context-docs.db-schema.json"),
    JSON.stringify([{ keywords: ["sensor"], path: ".claude/docs/db/sensor.md" }]));
  const docPath = path.join(H, ".claude", "docs", "db", "sensor.md");
  fs.writeFileSync(docPath,
    "# TESTUSER.SENSOR\n\n" +
    "<!-- dbdoc:manual:purpose -->\n추정) 센서 원장 [근거: repo/schema.ts:24]\n<!-- dbdoc:end:purpose -->\n\n" +
    "<!-- dbdoc:auto:columns -->\n| 컬럼 | 타입 | 널 | 기본값 | 설명 |\n| --- | --- | --- | --- | --- |\n" +
    "| SNSR_ID | VARCHAR2(20) | N | - | 추정) 센서 ID [근거: repo/schema.ts:27] |\n<!-- dbdoc:end:columns -->\n");

  const srv = spawn("node", [...NODE_ARGS, SERVER], { env: { ...baseEnv, OBS_PORT: "45782", OBS_DOCS_HOME: H }, stdio: "ignore" });
  try {
    await waitHealth(45782);
    const before = (fs.readFileSync(docPath, "utf8").match(/추정\)/g) || []).length;
    check("promote: fixture has 2 inferred before", before === 2, String(before));

    const g = await get(45782, "/actions/schema-docs/promote").catch(() => null);
    check("promote: GET is rejected (POST-only)", g && g.error, JSON.stringify(g));

    const outside = await postJson(45782, "/actions/schema-docs/promote", { path: path.join(H, "secret.md") });
    check("promote: path outside doc allowlist → 403/404", outside.status === 403 || outside.status === 404, JSON.stringify(outside.status));

    const nopath = await postJson(45782, "/actions/schema-docs/promote", {});
    check("promote: missing path → 400", nopath.status === 400, JSON.stringify(nopath.status));

    const ok = await postJson(45782, "/actions/schema-docs/promote", { path: docPath });
    check("promote: 200 + promoted purpose+column, remaining 0",
      ok.status === 200 && ok.body && ok.body.ok && ok.body.promoted_count === 2 && ok.body.remaining_inferred === 0,
      JSON.stringify(ok.body));

    const after = fs.readFileSync(docPath, "utf8");
    check("promote: file rewritten, 추정) stripped (evidence kept)", !/추정\)/.test(after) && /센서 원장 \[근거:/.test(after), String((after.match(/추정\)/g) || []).length));

    const again = await postJson(45782, "/actions/schema-docs/promote", { path: docPath });
    check("promote: idempotent second run → 0 promoted", again.status === 200 && again.body.promoted_count === 0, JSON.stringify(again.body));

    // the CLI emitted SchemaDocPromote → appears in history (poll for the async commit)
    let sawPromote = false;
    for (let i = 0; i < 20 && !sawPromote; i++) {
      const sd = await get(45782, "/stats/schema-docs?window=90d").catch(() => ({}));
      if ((sd.history || []).some((h) => h.type === "promote" && /sensor\.md$/.test(h.doc || ""))) sawPromote = true;
      else await new Promise((r) => setTimeout(r, 100));
    }
    check("promote: emitted SchemaDocPromote lands in history", sawPromote, "polled 2s");
  } finally {
    srv.kill("SIGTERM");
    await new Promise((r) => { srv.on("exit", r); setTimeout(r, 2000); });
    try { fs.rmSync(H, { recursive: true, force: true }); } catch {}
  }
}

// ── done ─────────────────────────────────────────────────────────────────────
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
process.stdout.write(`\n${failures ? "FAILED " + failures : "ALL PASS"}\n`);
process.exit(failures ? 1 : 0);
