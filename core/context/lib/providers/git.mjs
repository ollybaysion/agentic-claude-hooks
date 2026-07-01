// git context provider (SessionStart, prio 90).
//
// Volatile git facts live here because SessionStart re-runs on resume/compact
// and refreshes, whereas per-turn events replay stale text. Emits compact
// STRUCTURED fields, never raw diffs (§10 injection surface). See DESIGN.md §8.

import { spawnSync } from "node:child_process";

// not-a-repo / git-absent / hang -> "" (fail open into an empty section).
function safeGit(cwd, args) {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3000 });
    return r.error || r.status !== 0 ? "" : r.stdout.trim();
  } catch {
    return "";
  }
}

export default {
  id: "git",
  events: ["SessionStart"],
  defaultPriority: 90,
  async run({ cwd }) {
    const branch = safeGit(cwd, ["branch", "--show-current"]);
    if (!branch) return null; // not a git repo -> inject nothing
    const sha = safeGit(cwd, ["rev-parse", "--short", "HEAD"]);
    const dirty = safeGit(cwd, ["status", "--porcelain"]).split("\n").filter(Boolean);
    const log = safeGit(cwd, ["log", "--oneline", "-5"]);

    const out = [`branch: ${branch}${sha ? ` @ ${sha}` : ""}`];
    if (dirty.length) {
      out.push(`uncommitted: ${dirty.length} files`);
      out.push(...dirty.slice(0, 20).map((l) => `  ${l}`)); // head 20 + count
    }
    if (log) {
      out.push("recent:");
      out.push(...log.split("\n").map((l) => `  ${l}`));
    }
    return { text: out.join("\n") };
  },
};
