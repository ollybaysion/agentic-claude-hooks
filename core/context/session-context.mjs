#!/usr/bin/env node
// SessionStart — inject project orientation context (git snapshot).
import { runContext } from "./lib/runner.mjs";

await runContext("SessionStart");
