#!/usr/bin/env node
// Dangerous-command guard hook (PreToolUse / Bash) — Claude Code adapter.
//
// The rules live in the runtime-neutral ./decide.mjs (#74); this file is only
// the Claude Code I/O: read the hook event, ask decide.mjs, and translate the
// verdict into CC's permission protocol — structured `permissionDecision:
// "deny"` for destructive or secret-leaking commands, `"ask"` for
// destructive-but-sometimes-legitimate git commands. A clean command passes
// silently (NOT an auto-approve — it falls through to the normal permission
// flow). Any internal error fails open so a bug in the guard never wedges the
// session. The opencode adapter (adapters/opencode/plugin.js) calls the same
// decide.mjs, so both harnesses block the same commands for the same reasons.

import { readHookInput, denyPreToolUse, askPreToolUse, pass, failOpen } from "../../lib/hook-io.mjs";
import { emitGuardDecision } from "../../lib/obs-client.mjs";
import { decideBash } from "./decide.mjs";

try {
  const input = await readHookInput();
  if (input?.tool_name !== "Bash") pass(); // not our concern

  const command = input?.tool_input?.command;
  if (!command || !command.trim()) pass();

  const verdict = decideBash(command);
  if (!verdict) pass(); // clean — defer to the normal permission flow

  // Emit a GuardDecision (best-effort, never blocks) then act on the verdict.
  // The emit failing/hanging/absent can NEVER change the outcome — the deny/ask
  // always runs after. `allow`/pass is never emitted (design §6: volume/noise).
  await emitGuardDecision(input, {
    guard: "bash-guard", rule: verdict.rule, decision: verdict.action, reason: verdict.reason,
  });
  if (verdict.action === "ask") askPreToolUse(verdict.reason);
  denyPreToolUse(verdict.reason);
} catch (err) {
  // Fail open: a guard bug must never wedge the session.
  failOpen(`[claude-hooks/bash-guard] internal error, skipping: ${err?.message ?? err}`);
}
