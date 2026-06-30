// Shared path resolution for the observability collector and its hooks.
//
// The collector server, the send-event hook, and the obs-lazy-start hook must
// all agree on WHERE state lives. State (db / config / pidfile) never goes under
// ${CLAUDE_PLUGIN_ROOT} (AGENTS.md: the plugin path changes on every update).
// Resolution order: OBS_DATA_DIR > $XDG_STATE_HOME/claude-observability >
// ~/.claude/observability.

import os from "node:os";
import path from "node:path";

/** Absolute path of the state directory (created with mode 0700 by the server). */
export function dataDir() {
  if (process.env.OBS_DATA_DIR) return process.env.OBS_DATA_DIR;
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return path.join(xdg, "claude-observability");
  return path.join(os.homedir(), ".claude", "observability");
}

/** {token} — created lazily on first boot, mode 0600. The token lives ONLY here
 *  (never in the pidfile, so `status` can dump the pidfile without leaking it). */
export const configFile = (dir = dataDir()) => path.join(dir, "config.json");

/** {pid,host,port,startedAt,version} — a locator, NOT a lock (the listening
 *  socket is the real single-instance lock). No secrets. */
export const pidFile = (dir = dataDir()) => path.join(dir, "server.pid");
