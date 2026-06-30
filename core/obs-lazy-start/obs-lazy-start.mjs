#!/usr/bin/env node
// obs-lazy-start — SessionStart hook that makes the collector "always there".
//
// If the collector port is already open, do nothing. Otherwise spawn the server
// detached (+ unref) so it outlives the session that started it. Always exits 0
// — observation is best-effort and must never block a session.
//
// Single-instance is owned by the server's own EADDRINUSE guard: when several
// tmux windows fire SessionStart at once, the first binds and the rest probe
// /health, see it's ours, and exit 0 quietly. The port check here is just an
// optimisation to avoid spawning in the common (already-running) case.

import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHookInput, pass, failOpen } from "../../lib/hook-io.mjs";
import { dataDir } from "../../lib/obs-paths.mjs";

const HOST = process.env.OBS_HOST || "127.0.0.1";
const PORT = Number.isInteger(Number(process.env.OBS_PORT)) && Number(process.env.OBS_PORT) > 0
  ? Number(process.env.OBS_PORT) : 4090;
// Resolve the bundled server relative to THIS script (never an absolute/project
// path) so it keeps working after a plugin update moves CLAUDE_PLUGIN_ROOT.
const SERVER = fileURLToPath(new URL("../observability/server.mjs", import.meta.url));

function portOpen(host, port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false)); // ECONNREFUSED → not running
  });
}

try {
  await readHookInput(); // drain stdin (we don't need the fields)
  if (await portOpen(HOST, PORT)) pass(); // already running → nothing to do

  // mkdir the data dir BEFORE opening the log file — otherwise openSync throws
  // ENOENT, it gets swallowed, and the server never starts.
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(path.join(dir, "server.log"), "a", 0o600);

  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", SERVER],
    { detached: true, stdio: ["ignore", logFd, logFd] } // own stdio → survives our exit
  );
  child.unref();
  try { fs.closeSync(logFd); } catch {} // child kept its own dup'd fd
  pass(); // spawned (or racing a sibling) — never block the session
} catch (err) {
  failOpen(`[claude-hooks/obs-lazy-start] ${err?.message ?? err}`);
}
