#!/usr/bin/env node
// Regression tests for git-guard. Run: node core/git-guard/test.mjs
//
// Same harness as core/bash-guard/test.mjs: spawn the real hook, feed a
// synthetic event, assert the decision. Two sections:
//   - Bash rules, branch-independent slice (cwd is "/", not a repo, so the
//     current branch resolves to "") — protects the argv lexer shared via
//     lib/shell-lex.mjs (#36) against refactor regressions.
//   - protected-edit (#71): throwaway git repos under a temp dir pin the
//     branch, asserting Write/Edit is judged by the repo the TARGET FILE
//     lives in, not by the session cwd.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "git-guard.mjs");

// The guard now emits a GuardDecision to the collector on deny (stage 9). Point
// it at a dead port so these hermetic unit tests never POST into a real running
// collector (the production one listens on 4090) — the emit ECONNREFUSEs fast
// and the decision is unchanged, which is exactly what we're asserting.
const ENV = { ...process.env, OBS_PORT: "59999" };

function decideEvent(event) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(event),
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

function decide(command) {
  return decideEvent({ tool_name: "Bash", cwd: "/", tool_input: { command } });
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

// ---- protected-edit (#71): branch judged where the target file lives ------
// Empty repos suffice: `git branch --show-current` reads the HEAD symref, so
// no commit is needed to pin the branch name.
const FIX = mkdtempSync(path.join(os.tmpdir(), "git-guard-test-"));
function initRepo(name, branch) {
  const dir = path.join(FIX, name);
  const r = spawnSync("git", ["init", "-q", "-b", branch, dir], { encoding: "utf8", timeout: 10_000 });
  if (r.error || r.status !== 0) {
    console.error(`fixture git init failed: ${r.stderr || r.error}`);
    process.exit(1);
  }
  return dir;
}
const MAIN_REPO = initRepo("main-repo", "main");
const FEAT_REPO = initRepo("feat-repo", "feat/x");
const PLAIN = path.join(FIX, "plain");
mkdirSync(PLAIN);

// [expected, event, note]
const EDIT_CASES = [
  ["pass",
    { tool_name: "Write", cwd: MAIN_REPO, tool_input: { file_path: path.join(PLAIN, "doc.md"), content: "x" } },
    "#71: cwd=main repo, file OUTSIDE any repo (the false positive)"],
  ["deny",
    { tool_name: "Write", cwd: PLAIN, tool_input: { file_path: path.join(MAIN_REPO, "a.txt"), content: "x" } },
    "#71: cwd=non-repo, file inside a main checkout (the protection gap)"],
  ["deny",
    { tool_name: "Edit", cwd: MAIN_REPO, tool_input: { file_path: path.join(MAIN_REPO, "b.txt"), old_string: "a", new_string: "b" } },
    "cwd=main repo, file in the same repo (pre-#71 behaviour kept)"],
  ["deny",
    { tool_name: "Write", cwd: PLAIN, tool_input: { file_path: path.join(MAIN_REPO, "new", "deep", "c.txt"), content: "x" } },
    "new file in a not-yet-created subdir of a main checkout (ancestor walk)"],
  ["deny",
    { tool_name: "Write", cwd: MAIN_REPO, tool_input: { content: "x" } },
    "no file_path → falls back to the session cwd"],
  ["deny",
    { tool_name: "Write", cwd: MAIN_REPO, tool_input: { file_path: "sub/rel.txt", content: "x" } },
    "relative file_path resolves against the session cwd"],
  ["pass",
    { tool_name: "Write", cwd: MAIN_REPO, tool_input: { file_path: path.join(FEAT_REPO, "d.txt"), content: "x" } },
    "cwd=main repo, file in a feature-branch checkout (worktree flow)"],
  ["pass",
    { tool_name: "MultiEdit", cwd: FEAT_REPO, tool_input: { file_path: path.join(FEAT_REPO, "e.txt"), edits: [] } },
    "MultiEdit on a feature branch stays allowed"],
];

for (const [expected, event, note] of EDIT_CASES) {
  const got = decideEvent(event);
  const ok = got === expected;
  if (!ok) failed++;
  const where = `${event.tool_name} cwd=${event.cwd} file=${event.tool_input?.file_path ?? "(none)"}`;
  console.log(`${ok ? "ok  " : "FAIL"} ${expected.padEnd(4)} ${note}\n     ${where}${ok ? "" : ` → got ${got}`}`);
}

rmSync(FIX, { recursive: true, force: true });

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
