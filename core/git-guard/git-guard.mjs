#!/usr/bin/env node
// Main-branch protection + force-push guard hook (PreToolUse).
//
// Blocks, via deny:
//   - Write/Edit/MultiEdit: file edits while HEAD is a protected branch (main/master).
//   - Bash: `git commit` on a protected branch, `git push` to a protected branch,
//           and force push (`--force`/`-f`) on ANY branch. `--force-with-lease`
//           is the safe variant and is intentionally allowed.
//
// Mechanism: structured `permissionDecision:"deny"` + a typed reason (stdout
// JSON + exit 0), same as bash-guard. A clean action passes silently (NOT an
// auto-approve — defers to the normal permission flow). Not-a-git-repo / no-git
// / any internal error fails open, so the guard never wedges a session.
//
// Scope: main-branch protection + force-push. Other destructive commands
// (reset --hard, clean -fd, checkout .) are bash-guard's job — keep that boundary.

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
// Plain force push (history rewrite). `--force-with-lease` is the safe variant
// and is deliberately NOT matched here (allowed).
const PLAIN_FORCE = /(^|\s)--force(\s|$)|(^|\s)-f(\s|$)/;
const FORCE_WITH_LEASE = /--force-with-lease/;

// Conservative split so `... && git push -f` can't smuggle past a clean prefix.
function splitCommands(cmd) {
  return cmd
    .split(/(?:&&|\|\||[;\n|])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function checkBash(command, branch) {
  for (const seg of [command, ...splitCommands(command)]) {
    if (/\bgit\b[^|]*\bpush\b/.test(seg)) {
      if (PLAIN_FORCE.test(seg) && !FORCE_WITH_LEASE.test(seg)) {
        denyPreToolUse(
          "force push 거부 — 히스토리를 덮어쓴다. 안전한 `git push --force-with-lease`를 " +
            "쓰거나, 정말 필요하면 사용자가 직접 실행해라."
        );
      }
      if (PUSH_TO_PROTECTED.test(seg)) {
        denyPreToolUse("main/master로 직접 push 거부 — 브랜치를 만들어 PR로 머지해라.");
      }
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
