# send-event

The **sending side** of the observability dashboard. Fires on every Claude Code
hook event, wraps the raw hook JSON in the collector envelope, and POSTs it to
the local [`observability`](../observability/README.md) collector.

| | |
| --- | --- |
| **Events** | all 9 (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `SessionStart`, `SessionEnd`) |
| **Blocks?** | never — always exits 0 (observation is best-effort) |
| **Requirement** | none. If the collector is down, the loopback `ECONNREFUSED` is swallowed (~7ms) |

## Behaviour

- Builds the envelope (design appendix A / §4.1): `source_app`, `session_id`,
  `hook_event_type` (= the event's `hook_event_name`), `payload` (the raw hook
  JSON), `timestamp`, plus `tool_name` / `tool_use_id` / `agent_id` /
  `agent_type` / `source` / `reason` / `error` promoted to the top level when
  present.
- POSTs to `http://127.0.0.1:4090/events` with a hard 5s timeout. Connection
  errors and timeouts are swallowed — the session is never blocked.
- Sends `Authorization: Bearer <token>` only if the collector wrote a token to
  `config.json` (or `OBS_TOKEN` is set). By default the collector trusts
  loopback and no token is needed.
- An empty or garbled stdin (no `hook_event_name`) is dropped silently rather
  than POSTed as noise.

## Config (env)

| env | default | meaning |
| --- | --- | --- |
| `OBS_HOST` / `OBS_PORT` | `127.0.0.1` / `4090` | collector address |
| `OBS_SOURCE_APP` | _(unset)_ | explicit `source_app` label override |

`source_app` resolution order (issue #45 — several sessions can share one cwd):
`OBS_SOURCE_APP` → **tmux window name** (best-effort `tmux display-message` when
`$TMUX_PANE` is set; 200 ms cap, silent fallthrough) → basename of `cwd`.
Existing stored rows are not backfilled.
| `OBS_TOKEN` | _(unset)_ | bearer token, if the collector requires one |

## Test locally

```bash
echo '{"hook_event_name":"PreToolUse","session_id":"s1","cwd":"/tmp/demo","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"ls"}}' \
  | node core/send-event/send-event.mjs ; echo "exit=$?"
```

Exit is always `0`. With the collector running, watch its `/health` counters
climb; with it stopped, the command still returns immediately.
