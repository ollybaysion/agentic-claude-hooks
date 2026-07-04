#!/usr/bin/env node
// send-event — the SENDING side of the observability collector.
//
// Fires on every Claude Code hook event, wraps the raw hook JSON in the
// collector envelope (design appendix A / §4.1), and POSTs it to the local
// collector. This hook is pure observation: it NEVER blocks the session.
//   • always exits 0 (even on connection refused / timeout / any error)
//   • hard 5s request timeout; loopback ECONNREFUSED returns in ~7ms
//   • reads the bearer token from config.json only if the collector set one
//
// The collector validates leniently: only hook_event_type (string) is required;
// everything else is best-effort. We promote the few fields the collector
// indexes (tool_name, tool_use_id, …) to the top level when present.

import { readHookInput, pass, failOpen } from "../../lib/hook-io.mjs";
import { sourceApp, postEnvelope } from "../../lib/obs-client.mjs";

function buildEnvelope(input) {
  const env = {
    source_app: sourceApp(input),
    session_id: typeof input.session_id === "string" ? input.session_id : "unknown",
    hook_event_type: input.hook_event_name, // guaranteed a string by the caller
    payload: input, // the raw hook JSON
    timestamp: Date.now(), // kept as client_ts; the server stamps its own order
  };
  const promote = (k, v) => { if (typeof v === "string" && v) env[k] = v; };
  promote("tool_name", input.tool_name);
  promote("tool_use_id", input.tool_use_id);
  promote("agent_id", input.agent_id);
  promote("agent_type", input.agent_type);
  promote("source", input.source); // SessionStart: startup/resume/clear
  promote("reason", input.reason); // SessionEnd
  // error may sit at the top level or inside a tool_response object.
  const err = input.error ?? input?.tool_response?.error;
  if (typeof err === "string" && err) env.error = err;
  else if (err != null && typeof err !== "string") env.error = JSON.stringify(err);
  return env;
}

try {
  const input = await readHookInput();
  // Only forward real hook events. An empty/garbled stdin (no hook_event_name)
  // is dropped silently rather than POSTed as noise.
  if (!input || typeof input.hook_event_name !== "string" || !input.hook_event_name) pass();
  await postEnvelope(buildEnvelope(input));
  pass(); // observation is best-effort — never block the session
} catch (err) {
  failOpen(`[claude-hooks/send-event] ${err?.message ?? err}`);
}
