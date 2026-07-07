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

// ── done ─────────────────────────────────────────────────────────────────────
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
process.stdout.write(`\n${failures ? "FAILED " + failures : "ALL PASS"}\n`);
process.exit(failures ? 1 : 0);
