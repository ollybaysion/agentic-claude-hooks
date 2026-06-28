#!/usr/bin/env node
// markdown-lint hook (PostToolUse / Write|Edit|MultiEdit)
//
// Behaviour: block-and-feedback only (no auto-fix). When a freshly written
// Markdown file violates the bundled rule set, relay the findings plus an
// explicit fix instruction via stderr and exit 2 so Claude re-edits the file.
//
// Dependency: markdownlint-cli2 is assumed to be installed globally
// (`npm i -g markdownlint-cli2`). If it is missing we fail open (exit 0).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  readHookInput,
  toolFilePath,
  blockWithFeedback,
  pass,
  failOpen,
} from "../../lib/hook-io.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, "config", ".markdownlint-cli2.jsonc");

const input = await readHookInput();
const file = toolFilePath(input);

// Only act on Markdown files; everything else passes untouched.
if (!file || !/\.(md|markdown)$/i.test(file)) pass();

const result = spawnSync(
  "markdownlint-cli2",
  ["--config", CONFIG, file],
  { encoding: "utf8" }
);

// Tool not installed / not on PATH -> don't break the user's flow.
if (result.error) {
  failOpen(
    "[claude-hooks/markdown-lint] markdownlint-cli2 not found. " +
      "Install it with `npm i -g markdownlint-cli2` to enable Markdown enforcement."
  );
}

// Exit 0 from the linter == clean.
if (result.status === 0) pass();

// Violations found: surface them and tell Claude to fix and re-save.
const findings = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
blockWithFeedback(
  `[claude-hooks/markdown-lint] Markdown rule violations in ${file}:\n\n` +
    `${findings}\n\n` +
    `Fix every violation above and write the file again. ` +
    `Do not proceed until markdownlint-cli2 reports no errors.`
);
