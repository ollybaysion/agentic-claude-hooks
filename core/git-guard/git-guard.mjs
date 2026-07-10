#!/usr/bin/env node
// Main-branch protection + force-push + no-verify guard hook (PreToolUse).
//
// Blocks, via deny:
//   - Write/Edit/MultiEdit: file edits when the repo the TARGET FILE lives in
//     has a protected branch (main/master) checked out. Judged by
//     tool_input.file_path, not the session cwd (#71) — a session parked in a
//     main checkout may still write outside that repo, and a feature-branch
//     session must not slip edits into another main checkout.
//   - Bash: `git commit` on a protected branch, `git push` to a protected branch,
//           force push (`--force`/`-f`) on any branch, and any git `--no-verify`
//           (skipping pre-commit/pre-push hooks). `--force-with-lease` is the safe
//           variant and is allowed.
//   - Bash: agent-initiated PR merges — `gh pr merge`, a `gh api` PUT to a
//           `pulls/<n>/merge` endpoint, and `git merge` while on a protected
//           branch. Merging a PR is a human decision (solo PR-only review); the
//           agent stops at "PR created" and hands the merge back to the user.
//
// Detection is argv-based, NOT substring-based: a Bash command is split into
// segments and each is tokenized into argv, so a rule fires only when `git`/`gh`
// is the actually-invoked command with the matching subcommand — never because
// the words "git"/"push"/"main"/"merge" merely co-occur in some argument or
// message text (e.g. `git show main:push.txt`, or `gh pr create --title "merge"`).
// Branch-dependent rules judge the repo each invocation actually touches:
// Write/Edit at the target file's repo (#71), Bash git at the session cwd
// re-anchored by any `-C <dir>` (#78).
//
// Mechanism: structured `permissionDecision:"deny"` + a typed reason (stdout
// JSON + exit 0), same as bash-guard. A clean action passes silently (NOT an
// auto-approve — defers to the normal permission flow). Not-a-git-repo / no-git
// / any internal error fails open, so the guard never wedges a session.
//
// Scope: main-branch protection + force-push + no-verify + PR-merge block. Other
// destructive commands (reset --hard, clean -fd, checkout .) are bash-guard's job.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { readHookInput, denyPreToolUse, pass, failOpen } from "../../lib/hook-io.mjs";
import { lexSegments, skipWrappers } from "../../lib/shell-lex.mjs";
import { emitGuardDecision } from "../../lib/obs-client.mjs";

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

// Nearest existing ancestor of `dir` (inclusive), or null when even the root
// doesn't exist. `git -C` demands an existing directory, and a Write may
// target a not-yet-created subtree — without the walk, a new-directory Write
// inside a protected checkout would fail open on `git -C <missing>` (exit 128).
function nearestExistingDir(dir) {
  let d = dir;
  while (!existsSync(d)) {
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  return d;
}

// git *global* options that consume the following token as their value, e.g.
// `git -C <dir> push …`. Needed so their value isn't mistaken for the subcommand.
const GIT_GLOBAL_VALUE_OPTS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix",
]);
// `git push` options that consume the following token as their value, so that
// value isn't mistaken for a refspec (e.g. `--repo main` is a repo, not a target).
const PUSH_VALUE_OPTS = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);

// The quote-aware segment/argv lexer and wrapper skipping live in the shared
// lib/shell-lex.mjs (extracted from this module for #36 so bash-guard's
// dangerous-delete scan reads the same tokens).

// Parse one segment's argv as a git invocation. Returns { subcommand, args,
// chdirs } (args = tokens after the subcommand, options included; chdirs = the
// `-C <dir>` values in order) or null when the segment isn't `git` (after
// skipping wrappers/env-assignments and git's own global options). Only the
// real subcommand drives the rules — not word matches. `-C` is both skipped
// (so its value isn't mistaken for the subcommand) and captured (#78): the
// command runs THERE, so branch-dependent rules must judge that repo, not the
// session cwd. `--git-dir`/`--work-tree` stay skip-only (rare, out of scope).
function parseGit(tokens) {
  let i = skipWrappers(tokens);
  if (i >= tokens.length) return null;
  const argv0 = tokens[i];
  if (argv0.slice(argv0.lastIndexOf("/") + 1) !== "git") return null;
  i++;
  const chdirs = [];
  while (i < tokens.length && tokens[i].startsWith("-")) {
    if (!tokens[i].includes("=") && GIT_GLOBAL_VALUE_OPTS.has(tokens[i])) {
      if (tokens[i] === "-C" && tokens[i + 1] !== undefined) chdirs.push(tokens[i + 1]);
      i++; // skip its value too
    }
    i++;
  }
  if (i >= tokens.length) return null; // no subcommand (e.g. `git --version`)
  return { subcommand: tokens[i], args: tokens.slice(i + 1), chdirs };
}

// Destination ref of a push refspec: `+src:dst` → dst, `main` → main,
// `refs/heads/main` → main. Used to match a push *target* against PROTECTED.
function refDst(ref) {
  const r = ref.replace(/^\+/, "");
  const colon = r.lastIndexOf(":");
  return (colon >= 0 ? r.slice(colon + 1) : r).replace(/^refs\/heads\//, "");
}

// True if this `git push`'s argv is a plain force (history rewrite). The safe
// `--force-with-lease` / `--force-if-includes` are distinct tokens and allowed.
function hasForce(args) {
  return args.some((t) => t === "--force" || /^-[A-Za-z]*f[A-Za-z]*$/.test(t));
}

// True if this `git push` writes a protected branch. With an explicit
// `remote refspec…`, checks each refspec destination. With no refspec (bare
// `git push` / remote-only), it pushes the *current* branch — protected iff we
// are on one. (`--delete origin main` falls out of the general refspec check.)
function pushTargetsProtected(args, branch) {
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t.startsWith("-")) {
      if (!t.includes("=") && PUSH_VALUE_OPTS.has(t)) i++; // skip its value
      continue;
    }
    positionals.push(t);
  }
  if (positionals.length >= 2) {
    return positionals.slice(1).some((ref) => PROTECTED.has(refDst(ref)));
  }
  return PROTECTED.has(branch); // no refspec → current branch is the target
}

// `gh` options that consume the following token as their value (global + the
// api / pr-merge-relevant ones). Skipped-with-value so a value can't masquerade
// as a positional (the subcommand path). `-X`/`--method` is handled separately.
const GH_VALUE_OPTS = new Set([
  "-R", "--repo", "--hostname",                                       // global
  "-f", "--field", "-F", "--raw-field", "--input", "-H", "--header",
  "-q", "--jq", "-t", "--template", "--cache",                        // api
  "-b", "--body", "--body-file", "--subject", "--match-head-commit",  // pr merge
]);
// A REST path that merges a pull request: `…/pulls/<n>/merge` (query stripped).
// Only a PUT actually merges; a GET on it is a "is it merged?" status check.
const MERGE_ENDPOINT = /(^|\/)pulls\/[^/]+\/merge$/;
// `git merge` recovery/finish flags — not a new merge, so left alone even on main.
const MERGE_RECOVERY = new Set(["--abort", "--continue", "--quit"]);
// Shared deny reason for PR merges (gh pr merge / gh api PUT merge).
const PR_MERGE_DENY =
  "PR 머지 거부 — 에이전트는 PR 생성까지만. 머지는 사람이 리뷰 후 직접 한다. 사용자에게 머지를 요청해라.";

// Parse one segment's argv as a `gh` invocation. Returns { positionals, help,
// method } or null when it isn't `gh`. `positionals` are the non-option tokens in
// order (so [0]=group, [1]=command / api-path); value-opt values are consumed so
// they can't masquerade as positionals. `method` is the `-X`/`--method` value.
function parseGh(tokens) {
  let i = skipWrappers(tokens);
  if (i >= tokens.length) return null;
  const argv0 = tokens[i];
  if (argv0.slice(argv0.lastIndexOf("/") + 1) !== "gh") return null;
  const positionals = [];
  let help = false;
  let method = null;
  for (i++; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--help" || t === "-h") { help = true; continue; }
    if (t === "-X" || t === "--method") { method = tokens[i + 1] ?? null; i++; continue; }
    if (t.startsWith("-X") && t.length > 2) { method = t.slice(2); continue; } // -XPUT
    if (t.startsWith("--method=")) { method = t.slice(9); continue; }
    if (t.startsWith("-")) {
      if (!t.includes("=") && GH_VALUE_OPTS.has(t)) i++; // skip its value
      continue;
    }
    positionals.push(t);
  }
  return { positionals, help, method };
}

// `deny(rule, reason)` emits a GuardDecision (best-effort) then hard-denies via
// denyPreToolUse — which exits. Sites `return deny(...)` so the scan halts.
async function checkBash(command, cwd, deny) {
  // Analyse each real sub-command in isolation so a token in one segment can't
  // cross-trigger a rule meant for another, and so only an actual git/gh
  // subcommand — not a co-occurring word — fires a rule.
  const branchCache = new Map();
  const branchAt = (dir) => {
    if (!branchCache.has(dir)) branchCache.set(dir, currentBranch(dir));
    return branchCache.get(dir);
  };
  for (const tokens of lexSegments(command)) {
    const git = parseGit(tokens);
    if (git) {
      const { subcommand, args, chdirs } = git;
      // Branch-dependent rules judge where THIS git invocation runs: the
      // session cwd, re-anchored by each `-C` in order (git semantics — a
      // later relative -C is relative to the preceding one; an absolute -C
      // resets). An unresolvable -C (unexpanded $VAR, missing dir) makes
      // currentBranch fail → "" → fail-open, NOT a cwd fallback: guessing
      // the wrong repo would deny legitimate work.
      const branch = branchAt(chdirs.reduce((d, c) => path.resolve(d, c), cwd));

      if (args.includes("--no-verify")) {
        return deny("no-verify",
          "`--no-verify` 거부 — pre-commit/pre-push 훅(검사)을 건너뛰지 마라. 훅이 실패하면 원인을 고쳐라."
        );
      }
      if (subcommand === "push") {
        if (hasForce(args)) {
          return deny("force-push",
            "force push 거부 — 히스토리를 덮어쓴다. 안전한 `git push --force-with-lease`를 " +
              "쓰거나, 정말 필요하면 사용자가 직접 실행해라."
          );
        }
        if (pushTargetsProtected(args, branch)) {
          return deny("protected-push", "main/master로 직접 push 거부 — 브랜치를 만들어 PR로 머지해라.");
        }
      }
      if (subcommand === "commit" && PROTECTED.has(branch)) {
        return deny("protected-commit",
          `'${branch}'에 직접 커밋 거부 — feature/* 또는 fix/* 브랜치를 먼저 만들어라.`
        );
      }
      // Low-level merge into a protected branch (recovery flags are not a merge).
      if (subcommand === "merge" && PROTECTED.has(branch) &&
        !args.some((t) => MERGE_RECOVERY.has(t))) {
        return deny("protected-merge",
          `'${branch}'에서 merge 거부 — 보호 브랜치 병합은 사람 몫이다. feature 브랜치에서 ` +
            "작업하거나, PR 머지는 사용자에게 요청해라."
        );
      }
      continue;
    }

    const gh = parseGh(tokens);
    if (!gh) continue;
    const [p0, p1] = gh.positionals;
    // `gh pr merge` (every flag variant); `--help` is a query, not a merge.
    if (p0 === "pr" && p1 === "merge" && !gh.help) return deny("pr-merge", PR_MERGE_DENY);
    // `gh api` PUT to a `pulls/<n>/merge` endpoint (a GET is a status check).
    if (p0 === "api" && p1 && MERGE_ENDPOINT.test(p1.split("?")[0]) &&
      (gh.method || "").toUpperCase() === "PUT") {
      return deny("pr-merge", PR_MERGE_DENY);
    }
  }
}

try {
  const input = await readHookInput();
  const tool = input?.tool_name;
  const isEdit = tool === "Write" || tool === "Edit" || tool === "MultiEdit";
  if (tool !== "Bash" && !isEdit) pass(); // not our concern

  const cwd = input?.cwd ?? process.cwd();

  // Emit a GuardDecision (best-effort, never blocks) then hard-deny. The emit
  // failing/hanging/absent can NEVER change the decision — deny always runs.
  const deny = async (rule, reason) => {
    await emitGuardDecision(input, { guard: "git-guard", rule, decision: "deny", reason });
    denyPreToolUse(reason);
  };

  if (isEdit) {
    // Judge by the repo the target file lives in, not the session cwd (#71).
    // `path.dirname` alone is wrong twice over: a missing file_path must fall
    // back to cwd BEFORE dirname (dirname("") is "." = the hook process's cwd,
    // not the session's), and a relative file_path must be anchored at the
    // session cwd first (resolve), or `git -C` reads it against the hook
    // process's cwd.
    const fp = input?.tool_input?.file_path;
    const anchor = fp
      ? nearestExistingDir(path.dirname(path.resolve(cwd, String(fp)))) ?? cwd
      : cwd;
    const branch = currentBranch(anchor);
    if (PROTECTED.has(branch)) {
      await deny("protected-edit",
        `'${branch}' 브랜치에서 파일 수정 거부 — 작업용 feature/* 또는 fix/* 브랜치를 ` +
          "먼저 만들고(git switch -c) 진행해라."
      );
    }
    pass();
  }

  // tool === "Bash" from here — commands execute at the session cwd, so it is
  // the anchor for the Bash rules; per-segment `-C` re-anchors inside (#78).
  const command = input?.tool_input?.command;
  if (!command || !command.trim()) pass();
  await checkBash(command, cwd, deny);

  pass(); // clean — defer to the normal permission flow
} catch (err) {
  failOpen(`[claude-hooks/git-guard] internal error, skipping: ${err?.message ?? err}`);
}
