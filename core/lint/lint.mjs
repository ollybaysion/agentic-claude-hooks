#!/usr/bin/env node
// Unified lint / format-check hook (PostToolUse / Write|Edit|MultiEdit).
//
// One PostToolUse hook dispatches by file extension to the matching tool.
// On a violation it relays the tool's output plus a fix instruction via stderr
// and exits 2 (block-and-feedback; no auto-fix). Missing or unrunnable tools
// fail open (exit 0) so a partial toolchain never breaks the session.
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
  failOpen,
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
];

const input = await readHookInput();
const file = toolFilePath(input);
if (!file) pass();

const ext = extname(file).toLowerCase();
const linter = LINTERS.find((l) => l.exts.includes(ext));
if (!linter) pass(); // extension we don't enforce

const result = spawnSync(linter.cmd, linter.args(file), { encoding: "utf8" });

// Tool not installed / not on PATH -> don't break the user's flow.
if (result.error) {
  failOpen(
    `[claude-hooks/lint] ${linter.cmd} not found; skipping ${ext} check. ` +
      `Install it to enable enforcement for this file type.`
  );
}

const classify = linter.classify ?? NONZERO_IS_VIOLATION;
const verdict = classify(result.status);

if (verdict === "clean") pass();

if (verdict === "infra") {
  failOpen(
    `[claude-hooks/lint] ${linter.cmd} could not run on ${file} ` +
      `(exit ${result.status}); skipping. Usually a missing/invalid config, not a violation.`
  );
}

const findings = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
blockWithFeedback(
  `[claude-hooks/lint] ${linter.cmd} reported issues in ${file}:\n\n` +
    `${findings}\n\n` +
    `${linter.fix} and write the file again. ` +
    `Do not proceed until ${linter.cmd} passes.`
);
