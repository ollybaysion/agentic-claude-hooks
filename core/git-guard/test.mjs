#!/usr/bin/env node
// Regression tests for git-guard. Run: node core/git-guard/test.mjs
//
// Same harness as core/bash-guard/test.mjs: spawn the real hook, feed a
// synthetic event, assert the decision. Only branch-INDEPENDENT rules are
// covered (cwd is "/", not a repo, so the current branch resolves to "") —
// enough to protect the argv lexer shared via lib/shell-lex.mjs (#36) against
// refactor regressions.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "git-guard.mjs");

// The guard now emits a GuardDecision to the collector on deny (stage 9). Point
// it at a dead port so these hermetic unit tests never POST into a real running
// collector (the production one listens on 4090) — the emit ECONNREFUSEs fast
// and the decision is unchanged, which is exactly what we're asserting.
const ENV = { ...process.env, OBS_PORT: "59999" };

function decide(command) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", cwd: "/", tool_input: { command } }),
    encoding: "utf8",
    timeout: 10_000,
    env: ENV,
  });
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  if (!r.stdout.trim()) return "pass";
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision ?? "pass";
  } catch {
    return `unparseable stdout: ${r.stdout}`;
  }
}

// [expected, command, note]
const CASES = [
  ["deny", "git push --force origin feat/x", "force push on any branch"],
  ["deny", "git commit --no-verify -m x", "hook skipping"],
  ["deny", "git push origin main", "push targeting a protected ref"],
  ["deny", "gh pr merge 5 --squash", "agent-initiated PR merge"],
  ["deny", "gh api -X PUT repos/o/r/pulls/5/merge", "REST merge endpoint"],
  ["pass", "git show main:push.txt", "#27: words co-occurring is not a push"],
  ["pass", 'git commit -m "push to main; --force"', "quoted message is one token"],
  ["pass", "gh pr view 5", "read-only gh"],
  ["pass", "git push origin feat/x", "feature-branch push"],
];

let failed = 0;
for (const [expected, command, note] of CASES) {
  const got = decide(command);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${expected.padEnd(4)} ${note}\n     ${JSON.stringify(command)}${ok ? "" : ` → got ${got}`}`);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
