#!/usr/bin/env node
// UserPromptSubmit — inject fresh per-turn context (current time).
import { runContext } from "./lib/runner.mjs";

await runContext("UserPromptSubmit");
