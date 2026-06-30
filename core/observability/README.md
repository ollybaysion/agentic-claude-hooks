# observability (collector)

Single-file HTTP collector that receives every Claude Code hook event (sent by
the [`send-event`](../send-event/README.md) hook), stores it, and streams it
live to a dashboard. Full design: [`docs/agent-dashboard-collector-design.md`](../../docs/agent-dashboard-collector-design.md).

> **Status: 🚧 in progress.** Stages 0–1 (lifecycle + non-blocking ingest) are
> implemented. SQLite storage (2), redaction (3), SSE (4), and the query API +
> dashboard (5) are marked as TODO seams in `server.mjs`.

This is **code, bundled in the plugin**, but all **state** (db / config / pid)
lives under `$XDG_STATE_HOME/claude-observability` (never under
`${CLAUDE_PLUGIN_ROOT}` — it changes on every plugin update). Paths resolve via
[`lib/obs-paths.mjs`](../../lib/obs-paths.mjs), shared with the hooks.

## Run

```bash
node core/observability/server.mjs           # start (binds 127.0.0.1:4090)
node core/observability/server.mjs status    # probe /health, print it (no token)
node core/observability/server.mjs stop      # verify ours via /health, then SIGTERM
```

Node 24+ emits an experimental-SQLite warning once stage 2 lands; the start
paths pass `--disable-warning=ExperimentalWarning`.

## Endpoints (current)

| Method | Path | Use |
| --- | --- | --- |
| POST | `/events` | ingest one envelope; **202** `{seq,id}` (or **200** duplicate) |
| GET | `/health` | liveness + counters (single-instance probe) |

Stages 4–5 add `GET /stream` (SSE), `GET /events`, `GET /events/:id`, `GET /`.

## Config (env `OBS_*` > config.json > default)

| env | default | meaning |
| --- | --- | --- |
| `OBS_HOST` | `127.0.0.1` | loopback only; non-loopback bind is refused unless `OBS_ALLOW_NONLOOPBACK=1` |
| `OBS_PORT` | `4090` | listen port (validated as int) |
| `OBS_DATA_DIR` | `$XDG_STATE_HOME/claude-observability` | state directory (0700) |
| `OBS_TOKEN` | _(unset → auth off)_ | bearer secret; empty = off. Loopback is trusted by default |
| `OBS_REDACT` | `1` | redact secrets on the post-ack path (stage 3) |
| `OBS_DURABLE` | `0` | `1` = store before ack (stage 2) |
| `OBS_MAX_BODY` | `5 MiB` | request body cap (413 over) |
| `OBS_SHUTDOWN_GRACE_MS` | `3000` | graceful-shutdown budget |

## Guarantees (held from stage 0)

- **Never blocks the agent**: 202 is sent before any store/stream work
  (`setImmediate`). The send-event hook already has its answer.
- **Single instance**: the listening socket is the lock; `EADDRINUSE` probes
  `/health` (ours → exit 0, foreign → exit 3). The pidfile is a locator, not a lock.
- **Fail-open**: process-level `uncaughtException` / `unhandledRejection` guards;
  byte-bounded in-memory queue with drop-oldest.
- **Loopback boundary**: `127.0.0.1` bind + `Host` allowlist (421 otherwise) +
  `umask(0o077)` + 0600/0700 state.
