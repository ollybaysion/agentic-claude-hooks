#!/usr/bin/env node
// Unified lint / format-check hook (PostToolUse / Write|Edit|MultiEdit).
//
// One PostToolUse hook dispatches by file extension to the matching tool(s).
// A file type may map to MORE THAN ONE tool (e.g. .sh -> shellcheck + shfmt);
// every matching tool runs and their findings are aggregated. On any violation
// it relays the tool output plus a fix instruction via stderr and exits 2
// (block-and-feedback; no auto-fix). Missing or unrunnable tools fail open
// (that tool is skipped) so a partial toolchain never breaks the session.
//
// Add a file type == add one entry to LINTERS below.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import {
  readHookInput,
  toolFilePath,
  blockWithFeedback,
  pass,
} from "../../lib/hook-io.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MD_CONFIG = join(HERE, "config", ".markdownlint-cli2.jsonc");

// Path-matched Markdown templates. A matched .md is checked with that template
// config (which `extends` the base rules and adds overrides like MD043 required
// headings); unmatched files use the base config above. First match wins, so
// put more specific patterns first. Add a template == one row here + the file
// under config/templates/. See templates.md.
const MD_TEMPLATES = [
  { match: (p) => /(^|\/)(docs\/)?adr\//i.test(p), config: "templates/adr.jsonc" },
];

function mdConfigFor(file) {
  const hit = MD_TEMPLATES.find((t) => t.match(file));
  return hit ? join(HERE, "config", hit.config) : MD_CONFIG;
}

// Map a process exit status to a verdict: "clean" | "violation" | "infra".
// Default: 0 == clean, any other non-zero == violation.
const NONZERO_IS_VIOLATION = (s) => (s === 0 ? "clean" : "violation");

const LINTERS = [
  {
    exts: [".md", ".markdown"],
    cmd: "markdownlint-cli2",
    args: (f) => ["--config", mdConfigFor(f), f],
    fix: "Fix every Markdown violation above",
  },
  {
    exts: [".json", ".yaml", ".yml"],
    cmd: "prettier",
    args: (f) => ["--check", f],
    fix: "Reformat the file to match Prettier (run `prettier --write` to see the exact changes)",
  },
  {
    exts: [".js", ".jsx", ".cjs", ".mjs", ".ts", ".tsx"],
    cmd: "eslint",
    args: (f) => [f],
    // eslint: 0 = clean, 1 = lint errors, 2+ = fatal/no-config -> treat as
    // infra so projects without a resolvable ESLint config are skipped, not
    // falsely blocked.
    classify: (s) => (s === 0 ? "clean" : s === 1 ? "violation" : "infra"),
    fix: "Fix every ESLint error above",
  },
  {
    exts: [".sh", ".bash"],
    cmd: "shellcheck",
    args: (f) => [f],
    fix: "Address every ShellCheck finding above",
  },
  {
    // Runs alongside shellcheck on the same files (lint + format).
    exts: [".sh", ".bash"],
    cmd: "shfmt",
    args: (f) => ["-d", f],
    // shfmt -d: 0 = formatted; nonzero = diff or parse error (both actionable).
    fix: "Reformat to shfmt's style (run `shfmt -w <file>` to apply)",
  },
];

const input = await readHookInput();
const file = toolFilePath(input);
if (!file) pass();

const ext = extname(file).toLowerCase();
const matched = LINTERS.filter((l) => l.exts.includes(ext));
if (!matched.length) pass(); // extension we don't enforce

// Run every tool that matches this file (a type may have several). Each tool
// fails open independently: a missing or unrunnable tool is skipped while the
// others still run. Violations are collected and reported together.
const problems = [];
for (const l of matched) {
  const result = spawnSync(l.cmd, l.args(file), { encoding: "utf8" });

  if (result.error) {
    process.stderr.write(
      `[claude-hooks/lint] ${l.cmd} not found; skipping. Install it to enable this check.\n`
    );
    continue;
  }

  // Killed by a signal (status === null, error unset): unrunnable, so fail open.
  if (result.status === null) {
    process.stderr.write(
      `[claude-hooks/lint] ${l.cmd} was killed (signal ${result.signal}) on ${file}; skipping.\n`
    );
    continue;
  }

  const verdict = (l.classify ?? NONZERO_IS_VIOLATION)(result.status);
  if (verdict === "clean") continue;
  if (verdict === "infra") {
    process.stderr.write(
      `[claude-hooks/lint] ${l.cmd} could not run on ${file} (exit ${result.status}); ` +
        `skipping. Usually a missing/invalid config, not a violation.\n`
    );
    continue;
  }

  const findings = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

  // Nonzero but produced no output: nothing actionable to relay -> fail open
  // rather than block with an empty, un-fixable message.
  if (!findings) {
    process.stderr.write(
      `[claude-hooks/lint] ${l.cmd} exited ${result.status} with no output on ${file}; skipping.\n`
    );
    continue;
  }

  problems.push(
    `[claude-hooks/lint] ${l.cmd} reported issues in ${file}:\n\n${findings}\n\n${l.fix}.`
  );
}

if (!problems.length) pass(); // clean, or every matching tool was skipped

blockWithFeedback(
  `${problems.join("\n\n———\n\n")}\n\n` +
    `Fix everything above and write the file again. Do not proceed until the lint passes.`
);
