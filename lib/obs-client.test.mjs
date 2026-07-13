#!/usr/bin/env node
// Unit tests for lib/obs-client.mjs buildGuardEnvelope (#99). Run:
//   node lib/obs-client.test.mjs
// No framework — exit 1 on the first failure so it can gate a commit. Pure: no
// network, no collector (emitGuardDecision's POST path is exercised end-to-end
// by the guards themselves against a dead port).

import { buildGuardEnvelope } from "./obs-client.mjs";

let failed = 0;
function check(name, ok, detail = "") {
  const tag = ok ? "ok  " : "FAIL";
  console.log(`${tag} ${name}${ok ? "" : "  → " + detail}`);
  if (!ok) failed++;
}

const OPTS = { guard: "bash-guard", rule: "rm-scan", decision: "deny", reason: "dangerous rm" };

// tool_use_id present on a PreToolUse input → lands in the PAYLOAD (correlation key)
const withId = buildGuardEnvelope(
  { session_id: "s1", tool_name: "Bash", tool_use_id: "toolu_abc", tool_input: { command: "rm -rf /" } },
  OPTS,
);
check("tool_use_id copied into payload", withId.payload.tool_use_id === "toolu_abc", JSON.stringify(withId.payload));
check("tool_use_id NOT promoted to top-level (dedup-index safety)", withId.tool_use_id === undefined, JSON.stringify(Object.keys(withId)));
check("core fields preserved", withId.payload.guard === "bash-guard" && withId.payload.rule === "rm-scan" && withId.payload.decision === "deny", JSON.stringify(withId.payload));
check("command captured, file_path not (command wins)", withId.payload.command === "rm -rf /" && withId.payload.file_path === undefined, JSON.stringify(withId.payload));
check("tool_name still indexed at top level", withId.tool_name === "Bash", JSON.stringify(withId));
check("hook_event_type is GuardDecision", withId.hook_event_type === "GuardDecision", withId.hook_event_type);

// no tool_use_id on input → payload carries none (legacy/older harness)
const noId = buildGuardEnvelope({ session_id: "s2", tool_name: "Bash", tool_input: { command: "ls" } }, OPTS);
check("absent tool_use_id → key omitted", !("tool_use_id" in noId.payload), JSON.stringify(noId.payload));

// non-string tool_use_id → ignored (never coerced)
const badId = buildGuardEnvelope({ session_id: "s3", tool_name: "Read", tool_use_id: 12345, tool_input: { file_path: "/x" } }, OPTS);
check("non-string tool_use_id ignored", !("tool_use_id" in badId.payload), JSON.stringify(badId.payload));
check("file_path captured when no command", badId.payload.file_path === "/x" && badId.payload.command === undefined, JSON.stringify(badId.payload));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall obs-client checks passed");
