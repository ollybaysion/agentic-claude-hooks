#!/usr/bin/env node
// Regression tests for bash-guard. Run: node core/bash-guard/test.mjs
//
// Spawns the real hook per case with a synthetic PreToolUse event on stdin and
// asserts the resulting decision: "deny" / "ask" (from the stdout JSON) or
// "pass" (no decision emitted, exit 0). No test framework — exit 1 on any
// failure, so it can gate a commit or CI later.
//
// The dangerous-delete cases encode issue #36: the scan must fire on rm's own
// argv only — never on fragments (a `-F` flag, a hyphenated path, message
// text) combined across segments of a compound command.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "bash-guard.mjs");

// The guard now emits a GuardDecision to the collector on deny/ask (stage 9).
// Point it at a dead port so these hermetic unit tests never POST into a real
// running collector (the production one listens on 4090) — the emit ECONNREFUSEs
// fast and the decision is unchanged, which is exactly what we're asserting.
const ENV = { ...process.env, OBS_PORT: "59999" };

function decide(input) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(input),
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

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

// [expected, command, note]
const CASES = [
  // --- #36 real-world false positives: git rm + unrelated fragments → pass ---
  ["pass",
    'git -C /home/renoir/repo/agent-context-protector-plugin rm -q docs/transcript.md ' +
    '&& git add -A && git commit -m "docs: sync transcript notes, re-verify fail-open" && git push',
    "#36 case 1: git rm + hyphenated path + re-verify in message"],
  ["pass",
    'git -C "$D" rm -q docs/transcript.md\ngit -C "$D" commit -q -F /tmp/x/commit-msg-docs.txt',
    "#36 case 2: git rm on one line, commit -F on the next"],
  ["pass", "git rm cleanup.md", "plain git rm"],
  ["pass", "git rm -rf old-docs/", "git's own recursive+force is index-level (git-guard's domain)"],
  ["pass", 'git commit -m "never run rm -rf blindly"', "flag words inside a quoted message"],

  // --- dangerous rm still denied (acceptance list) ---
  ["deny", "rm -rf /", "root delete"],
  ["deny", "rm -fr build", "reversed cluster"],
  ["deny", "rm -r -f build", "split flags"],
  ["deny", "rm --recursive --force build", "long flags"],
  ["deny", "rm -Rf build", "uppercase R"],
  ["deny", "echo x && rm -rf ~", "smuggled after clean prefix"],
  ["deny", "echo hi; rm -rf build", "smuggled after semicolon"],
  ["deny", "sudo rm -rf build", "wrapper"],
  ["deny", "ls | xargs rm -rf", "xargs"],
  ["deny", "find . -name tmp -exec rm -rf {} \\;", "find -exec"],
  ["deny", "echo $(rm -rf ~)", "command substitution"],
  ["deny", "/bin/rm -rf tmp", "path-qualified rm"],
  ["deny", "git status && rm -rf node_modules", "git in another segment must not shield rm"],
  ["deny", "bash -c 'rm -rf build'", "shell -c indirection"],
  ["deny", 'eval "rm -rf build"', "eval with quoted command"],

  // --- rm without both intents → pass ---
  ["pass", "rm -r build", "recursive only"],
  ["pass", "rm -f stale.lock", "force only"],
  ["pass", "rm notes.txt", "plain rm"],
  ["pass", "rm -r -- -f", "after -- a token is an operand, not a force flag"],
  ["deny", "rm -rf -- build", "-- does not launder flags given before it"],

  // --- neighbouring rules unchanged ---
  ["deny", "cat .env", "secret leak rule"],
  ["ask", "git reset --hard", "destructive git asks"],
  ["deny", "grep foo src/", "style nudge"],
  ["pass", "ls -la", "clean command"],
];

let failed = 0;
for (const [expected, command, note] of CASES) {
  const got = decide(bash(command));
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${expected.padEnd(4)} ${note}\n     ${JSON.stringify(command)}${ok ? "" : ` → got ${got}`}`);
}

// Out-of-scope tool passes untouched.
{
  const got = decide({ tool_name: "Read", tool_input: { file_path: "/x" } });
  const ok = got === "pass";
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} pass non-Bash tool${ok ? "" : ` → got ${got}`}`);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
