#!/usr/bin/env node
// Main-branch protection + force-push + no-verify guard hook (PreToolUse) —
// Claude Code adapter.
//
// The policy lives in the runtime-neutral ./decide.mjs (#74); this file is only
// the Claude Code I/O: read the hook event, map the CC tool name to a decide
// `kind` (Write/Edit/MultiEdit → "edit", Bash → "bash"), and translate the
// verdict into a structured `permissionDecision:"deny"` with a typed reason
// (stdout JSON + exit 0), same as bash-guard. A clean action passes silently
// (NOT an auto-approve — defers to the normal permission flow). Not-a-git-repo /
// no-git / any internal error fails open, so the guard never wedges a session.
// The opencode adapter (adapters/opencode/plugin.js) calls the same decide.mjs.
//
// Scope: main-branch protection + force-push + no-verify + PR-merge block. Other
// destructive commands (reset --hard, clean -fd, checkout .) are bash-guard's job.

import { readHookInput, denyPreToolUse, pass, failOpen } from "../../lib/hook-io.mjs";
import { emitGuardDecision } from "../../lib/obs-client.mjs";
import { decideGit } from "./decide.mjs";

try {
  const input = await readHookInput();
  const tool = input?.tool_name;
  const isEdit = tool === "Write" || tool === "Edit" || tool === "MultiEdit";
  if (tool !== "Bash" && !isEdit) pass(); // not our concern

  // Bash commands execute at the session cwd, so it is the anchor for the Bash
  // rules (per-segment `-C` re-anchors inside, #78); edits are anchored at the
  // target file's own repo (#71). decide.mjs owns both.
  const verdict = decideGit({
    kind: isEdit ? "edit" : "bash",
    command: input?.tool_input?.command,
    filePath: input?.tool_input?.file_path,
    cwd: input?.cwd ?? process.cwd(),
  });
  if (!verdict) pass(); // clean — defer to the normal permission flow

  // Emit a GuardDecision (best-effort, never blocks) then hard-deny. The emit
  // failing/hanging/absent can NEVER change the decision — deny always runs.
  await emitGuardDecision(input, {
    guard: "git-guard", rule: verdict.rule, decision: verdict.action, reason: verdict.reason,
  });
  denyPreToolUse(verdict.reason);
} catch (err) {
  failOpen(`[claude-hooks/git-guard] internal error, skipping: ${err?.message ?? err}`);
}
