#!/usr/bin/env node
// Main-branch protection hook (PreToolUse).
//
// Blocks DIRECT work on the protected branches (main/master) — the one thing a
// stateless command guard can't do, because it needs the current branch:
//   - Write/Edit/MultiEdit: block file edits while HEAD is a protected branch
//                           (forces "make a branch first" before any work).
//   - Bash:                 block `git commit` while on a protected branch, and
//                           `git push` targeting a protected branch.
//
// Mechanism: structured `permissionDecision:"deny"` + a typed reason (stdout
// JSON + exit 0), same as bash-guard. A clean action passes silently (NOT an
// auto-approve — it defers to the normal permission flow). Not-a-git-repo /
// no-git / any internal error fails open, so the guard never wedges a session.
//
// Scope: main-branch protection ONLY. Destructive commands (push --force,
// reset --hard, clean -fd, …) are bash-guard's job — keep that boundary.

import { spawnSync } from "node:child_process";
import { readHookInput, denyPreToolUse, pass, failOpen } from "../../lib/hook-io.mjs";

const PROTECTED = new Set(["main", "master"]);

// Current branch name at `cwd`; "" when detached, not a repo, or git is absent.
function currentBranch(cwd) {
  const r = spawnSync("git", ["-C", cwd, "branch", "--show-current"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.error || r.status !== 0) return "";
  return (r.stdout || "").trim();
}

// A protected branch named as a push target: `... main`, `HEAD:master`, etc.
const PUSH_TO_PROTECTED = /(^|\s|:)(main|master)(\s|$|:)/;

// Conservative split so `... && git commit` can't smuggle past a clean prefix
// (mirrors bash-guard's per-segment scan).
function splitCommands(cmd) {
  return cmd
    .split(/(?:&&|\|\||[;\n|])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function checkBash(command, branch) {
  for (const seg of [command, ...splitCommands(command)]) {
    if (/\bgit\b[^|]*\bpush\b/.test(seg) && PUSH_TO_PROTECTED.test(seg)) {
      denyPreToolUse("main/master로 직접 push 거부 — 브랜치를 만들어 PR로 머지해라.");
    }
    if (/\bgit\b[^|]*\bcommit\b/.test(seg) && PROTECTED.has(branch)) {
      denyPreToolUse(
        `'${branch}'에 직접 커밋 거부 — feature/* 또는 fix/* 브랜치를 먼저 만들어라.`
      );
    }
  }
}

try {
  const input = await readHookInput();
  const tool = input?.tool_name;
  const isEdit = tool === "Write" || tool === "Edit" || tool === "MultiEdit";
  if (tool !== "Bash" && !isEdit) pass(); // not our concern

  const cwd = input?.cwd ?? process.cwd();
  const branch = currentBranch(cwd);

  if (isEdit) {
    if (PROTECTED.has(branch)) {
      denyPreToolUse(
        `'${branch}' 브랜치에서 파일 수정 거부 — 작업용 feature/* 또는 fix/* 브랜치를 ` +
          "먼저 만들고(git switch -c) 진행해라."
      );
    }
    pass();
  }

  // tool === "Bash" from here.
  const command = input?.tool_input?.command;
  if (!command || !command.trim()) pass();
  checkBash(command, branch);

  pass(); // clean — defer to the normal permission flow
} catch (err) {
  failOpen(`[claude-hooks/git-guard] internal error, skipping: ${err?.message ?? err}`);
}
