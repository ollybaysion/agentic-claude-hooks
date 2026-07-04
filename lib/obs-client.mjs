// Shared client for the observability collector (the SENDING side).
//
// Extracted from send-event.mjs (stage 9) so both the send-event hook and the
// guards can POST to the local collector through one code path: token lookup,
// source-app labelling, and a fire-and-forget POST that NEVER throws and is
// bounded by a timeout. The collector validates leniently and redacts on its
// own post-ack path — callers send raw envelopes and never block on the result.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configFile } from "./obs-paths.mjs";

const HOST = process.env.OBS_HOST || "127.0.0.1";
const PORT = Number.isInteger(Number(process.env.OBS_PORT)) && Number(process.env.OBS_PORT) > 0
  ? Number(process.env.OBS_PORT) : 4090;
const DEFAULT_TIMEOUT_MS = 5000;

// Token: env wins; else config.json (written 0600 by the collector when auth is
// on). Absent → POST without auth (collector trusts loopback by default).
export function readToken() {
  if (process.env.OBS_TOKEN) return process.env.OBS_TOKEN;
  try {
    const c = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    if (typeof c.token === "string" && c.token) return c.token;
  } catch {}
  return null;
}

// The tmux window name for the current pane, or null. Several claude sessions
// often run from the SAME directory (issue #45): basename(cwd) collapses them
// into one label, while the tmux window name is per task. Best-effort only —
// any failure (no tmux, dead pane, timeout) falls through silently.
function tmuxWindowName() {
  if (!process.env.TMUX || !process.env.TMUX_PANE) return null;
  try {
    const r = spawnSync(
      "tmux",
      ["display-message", "-p", "-t", process.env.TMUX_PANE, "#{window_name}"],
      { encoding: "utf8", timeout: 200 }
    );
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}

// A human-friendly label for the source: explicit override, else the tmux
// window name, else the project directory name, else a constant. Shared so a
// session's GuardDecision rows carry the SAME app label as its other events.
export function sourceApp(input) {
  if (process.env.OBS_SOURCE_APP) return process.env.OBS_SOURCE_APP;
  const win = tmuxWindowName();
  if (win) return win;
  const cwd = input && typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  return path.basename(cwd) || "claude-code";
}

// POST one envelope to the collector. Resolves ALWAYS (never rejects): on the
// end of the response, on any socket error (ECONNREFUSED when the collector is
// down), or on timeout. Writes nothing to stdout/stderr — a guard's stdout is
// its permission-decision JSON and must not be corrupted.
export function postEnvelope(envelope, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let body;
    try { body = JSON.stringify(envelope); } catch { return resolve(); }
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Host: "127.0.0.1", // collector requires a loopback Host (421 otherwise)
    };
    const token = readToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      { host: HOST, port: PORT, path: "/events", method: "POST", headers, timeout: timeoutMs },
      (res) => { res.resume(); res.on("end", resolve); res.on("error", resolve); }
    );
    req.on("error", resolve); // ECONNREFUSED (collector down) etc. — swallow
    req.on("timeout", () => { req.destroy(); resolve(); });
    req.end(body);
  });
}

// Emit a GuardDecision event when a guard denies/asks/warns (design §6). Builds
// the envelope directly from the hook `input` — it does NOT go through the
// send-event hook. Fire-and-forget: swallows every error and is bounded by a
// short timeout, so a slow/absent collector can NEVER delay or change the
// guard's decision. `allow` is intentionally never emitted (volume/noise).
// The command may contain secrets; redaction is the collector's job (post-ack
// path), exactly as for every other event.
export function emitGuardDecision(input, { guard, rule, decision, reason, timeoutMs = 2000 }) {
  try {
    const tool_name = typeof input?.tool_name === "string" ? input.tool_name : undefined;
    const command = input?.tool_input?.command;
    const file_path = input?.tool_input?.file_path;
    const payload = { guard, rule, decision, reason };
    if (tool_name) payload.tool_name = tool_name;
    if (typeof command === "string" && command) payload.command = command;
    else if (typeof file_path === "string" && file_path) payload.file_path = file_path;
    const envelope = {
      source_app: sourceApp(input),
      session_id: typeof input?.session_id === "string" ? input.session_id : "unknown",
      hook_event_type: "GuardDecision",
      payload,
      timestamp: Date.now(),
    };
    if (tool_name) envelope.tool_name = tool_name; // collector indexes it; harmless
    return postEnvelope(envelope, { timeoutMs });
  } catch {
    return Promise.resolve(); // an emit bug must never wedge a deny
  }
}
