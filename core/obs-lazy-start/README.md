# obs-lazy-start

SessionStart hook that makes the [`observability`](../observability/README.md)
collector **always there**: if its port isn't open, it spawns the server
detached so it outlives the session that started it.

| | |
| --- | --- |
| **Event** | SessionStart |
| **Blocks?** | never — always exits 0 |
| **Requirement** | none (the bundled `core/observability/server.mjs`) |

## Behaviour

- Probes `127.0.0.1:4090`. If something is already listening, it does nothing.
- Otherwise `mkdir`s the data dir **first** (so the log `openSync` can't ENOENT),
  opens `server.log`, and spawns the server `detached` + `unref` with
  `--disable-warning=ExperimentalWarning`. The child keeps its own stdio, so it
  survives this hook's exit.
- Resolves the server path relative to this script (`import.meta.url`), so it
  keeps working after a plugin update moves `${CLAUDE_PLUGIN_ROOT}`.
- Single-instance is ultimately owned by the server's `EADDRINUSE` guard: if
  several tmux windows fire SessionStart at once, the first binds and the rest
  probe `/health`, see it's ours, and exit 0. The port probe here just avoids
  spawning in the common already-running case.

## Keeping it up — three levels

1. **This hook (default).** Any new session brings the collector up if it's down.
2. **tmux window.** In your restore script, add a window that *tails* the log
   (don't start the server again — this hook / systemd own it):

   ```bash
   tmux new-window -n obs "tail -F \"${XDG_STATE_HOME:-$HOME/.claude}\"/claude-observability/server.log"
   ```

3. **systemd --user** (survives logout/reboot, unattended). See
   [`config/claude-observability.service`](config/claude-observability.service)
   — note the plugin-path caveat in that file.

## Test locally

```bash
echo '{"hook_event_name":"SessionStart","session_id":"s","cwd":"/tmp/p"}' \
  | node core/obs-lazy-start/obs-lazy-start.mjs ; echo "exit=$?"
curl -s http://127.0.0.1:4090/health   # collector should be up
```
