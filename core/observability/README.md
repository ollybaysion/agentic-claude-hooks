# observability (collector)

Single-file HTTP collector that receives every Claude Code hook event (sent by
the [`send-event`](../send-event/README.md) hook), stores it, and streams it
live to a dashboard. Full design: [`docs/agent-dashboard-collector-design.md`](../../docs/agent-dashboard-collector-design.md).

> **Status:** Stages 0–8 implemented — lifecycle + non-blocking ingest (0–1),
> SQLite(WAL) storage + retention (2), redaction (3), live SSE (4), query API +
> dashboard (5), auto-start via [`obs-lazy-start`](../obs-lazy-start/README.md)
> (6), the read-only stats aggregation API (7), the tabbed analysis UI (8),
> and token analytics from CC transcripts (10a collection + 10b Tokens UI —
> one row per API message, numbers only, never content; design:
> [`docs/agent-dashboard-analysis-design.md`](../../docs/agent-dashboard-analysis-design.md)
> and the issue #38 comment). Next: guard observability (stage 9).

This is **code, bundled in the plugin**, but all **state** (db / config / pid)
lives under `$XDG_STATE_HOME/claude-observability` (never under
`${CLAUDE_PLUGIN_ROOT}` — it changes on every plugin update). Paths resolve via
[`lib/obs-paths.mjs`](../../lib/obs-paths.mjs), shared with the hooks.

## Run

```bash
node --disable-warning=ExperimentalWarning core/observability/server.mjs   # start (binds 127.0.0.1:4090)
node core/observability/server.mjs status    # probe /health, print it (no token)
node core/observability/server.mjs stop      # verify ours via /health, then SIGTERM
node core/observability/server.mjs retain     # run one retention pass (ops)
node core/observability/server.mjs ingest-usage           # backfill token usage from transcripts, main + subagent files (idempotent)
node core/observability/server.mjs ingest-usage --rescan  # drop cursors + re-read ALL transcripts (e.g. after the TTL-split or subagent (#81) migration)
node core/observability/server.mjs title-sessions         # batch: LLM-summarise idle sessions into short titles (--all re-titles, --limit N caps, --idle SEC lowers the quiet-gate)
node core/observability/server.mjs materialize-turns      # #82: backfill/refresh the fleet `turns` table from events (--rebuild re-derives non-frozen sessions). Also runs in-process on a timer + before retention trims.
```

Then open the dashboard at **<http://127.0.0.1:4090/>**. Node 24+ emits an
experimental-SQLite warning (node:sqlite); the start paths pass
`--disable-warning=ExperimentalWarning`.

## Endpoints

| Method | Path | Use |
| --- | --- | --- |
| POST | `/events` | ingest one envelope; **202** `{seq,id}` (or **200** duplicate) |
| GET | `/events` | keyset history: `source_app`/`session_id`/`hook_event_type`, `since`, `limit` (≤1000), `order` |
| GET | `/events/:id` | one row by `seq` (numeric) or `id` (uuid); **404** if missing |
| GET | `/stream` | live SSE; `Last-Event-ID`/`?since` resume, same filters as `/events` |
| GET | `/stats/overview` | window totals: events / errors / sessions (+active) per type + time buckets |
| GET | `/stats/sessions` | per-session rollup: turns / tool_calls / errors / precompacts / subagents / active + `title` (auto-titled on a timer, or the `title-sessions` batch) and `first_prompt` (earliest `UserPromptSubmit`, the fallback label) |
| GET | `/stats/tools` | per-tool calls / errors / orphans / pending + p50/p95/max ms (Pre↔Post pairs) |
| GET | `/stats/tokens` | token usage from CC transcripts: `group=session\|app\|bucket\|tool\|model\|anatomy\|timeline` (tool attribution is a documented approximation); every row carries `cost_usd` (est., official per-MTok rates; cache writes billed per TTL — 5m 1.25× / 1h 2× input, from the transcript's `ephemeral_5m`/`ephemeral_1h` split) + `unpriced` (tokens of models missing from the pricing table). `group=session` rows also carry per-session diagnostics: `avg_ctx`/`peak_ctx` (context = input+cache), `model_switches` + `switch_rewrite_est` (the cache rewrite a mid-session model change forces), `mega` (hot-spot flag). `group=anatomy` returns per-model + `(all)` cost split into 4 components (`input`/`write`/`read`/`output` USD + `pct`) with `baseline_ctx` (est. harness fixed cost). `group=timeline&session_id=X` returns one session's main-chain context `series` + `compact_markers` (sharp ctx drops) + `whatif` (cache-read $ a 200k/300k cap would have saved) |
| GET | `/stats/guards` | GuardDecision rollup: `by_guard` / `by_rule` (guard×rule×decision) / `by_app` / `top_commands`. Reads `payload` (json_extract) — GuardDecision rows are few |
| GET | `/stats/nudges` | ctx-budget boundary-nudge rollup: `by_kind` (kind×template) / `by_cost_shown` / `by_app` / `series` / `recent` fires, plus `compliance` (rate + base rate + keep-misassign, when `NudgeOutcome` events are present — acp#29) and kill-judgment progress (`n`/20 outcomes over `days`/30). Joins `NudgeFired`↔`NudgeOutcome` on `(transcriptHash, byteOffset)`, degrading to `(transcriptHash, ts)` when byteOffset is null. Reads `payload`; nudge rows are few. Counts are an observed lower bound (a fire while the collector is down leaves a ledger line but no event) — acp's ledger report owns the exact rate |
| GET | `/stats/turns` | Turn Inspector (#73, `docs/agent-dashboard-turn-inspector-design.md`): one session's events grouped into **turns** (`UserPromptSubmit` → last `Stop`; arrival-race repair, queued-prompt merge only when an in-flight Pre pairs after the prompt, post-stop tail kept but excluded from timing). `session_id` required, `limit` = latest N (≤500, no window — retention bounds it). Per turn: tool/wait/gap time split (main-lane interval **union**; permission-wait carved out of the enclosing call; capped), calls/errors/orphans/`guard_denies` (orphans' top cause is a hook-guard deny, time-correlated ±3s), subagent lane, and inefficiency `flags` (`dup-call`/`re-read`/`retry-loop`/`search-storm`/`long-tail`/`gap-heavy`/`orphaned`/`mega-turn` — thresholds via `{"turns":{…}}`). `&turn=<seq>` adds the call timeline + markers. Each turn carries `cost_usd` (main chain) and `cost_subagent_usd` (#81 — the subagent spend that turn triggered, id-joined via the agents' own tool calls; `null` = zero usage rows attributed, never $0.00; compact API calls aren't in usage → the UI badges PreCompact turns). Attribution is single-bucket per usage row — emitted-id match first, `follows` only when emitted is empty, ts-window fallback — and the response totals `usage_cost_usd` / `unattributed_cost_usd` (rows landing in no turn) keep the sum honest. Reads `payload` for ONE session only (`prompt`/`tool_input`/`message`/guard fields) |
| GET | `/health` | liveness + counters (single-instance probe) |
| GET | `/` + `/app.js` | dependency-free dashboard: Live tail, Sessions (rollup + tokens + cost + avg/peak ctx + mega badge + a human session title — generated title, else first prompt, else hash — and the **Turn Inspector drill-down** (#73 stage 2): context-growth curve & compact what-if, then a `/stats/turns`-backed turn list with flags badges + a `[⚑ flags만]` filter, harness-injected turns labeled `⚙` (raw prompt on hover), per-turn lazy detail = tool/wait/gap stack bar + call timeline (gap/`∥`, input summaries, status colors, dup/bg/→next badges, `└ sub:` lanes, dimmed post-stop tail, ⚠ permission / ⛔ guard-deny / ✂ compact markers, row click → raw event JSON)), Tools (latency/error bars), Tokens (cost anatomy stack + baseline/turn-tax/switch-rewrite cards + daily/by app/by model/by tool + trend), Guards (what the git/bash guards blocked), Nudges (ctx-budget `/compact` boundary nudges + compliance), fleet strip with per-session context size, per-screen `(?)` help tooltips for derived metrics (strict CSP, same-origin, inline-SVG charts) |

**#82 turn materialization (stage 1):** `/stats/turns` derives turns per session
on-read, which can't answer fleet-wide questions ("avg calls/turn trend", "which
projects run gap-heavy") without scanning every session's payload. So SETTLED
turns are materialised — the same `buildTurns`/`attachTurnCosts` are re-run and
their output persisted to a `turns` table (schema v7, one summary row per turn) +
a `turn_cursor` watermark. `buildTurns` stays the single source of truth (drill and
fleet agree by construction). The table **outlives `events`** (retention never
trims it), so fleet history survives. Only settled turns are stored — never the
open last turn, and never a turn with an unresolved main-lane Pre (§ design's
settle gate); reconcile-delete removes turn_seqs a re-segmentation dropped; a
`frozen` flag protects sessions whose early events were trimmed from being
re-derived over a truncated stream; `unattributed = session total − Σ settled`
keeps the cost identity exact. The fleet aggregate endpoint + UI are stages 2-3.
See `docs/agent-dashboard-fleet-turns-design.md`.

`/stats/*` params: `window=1h|6h|24h|7d|30d` (whitelist; defaults 24h, sessions 7d),
`source_app` (sessions/tools), `limit` (sessions, ≤200). Aggregates avoid the
`payload` column except four documented, bounded cases — `/stats/guards` and
`/stats/nudges` (rare custom rows), `/stats/sessions`' `first_prompt` (one row
per session), and `/stats/turns` (one session per request) — and answer
empty-but-200 when the DB backend is degraded. The git/bash guards emit a `GuardDecision` event on every
deny/ask (never on allow) via `lib/obs-client.mjs` — fire-and-forget, so a slow or
absent collector never changes a guard's ruling. ctx-budget emits `NudgeFired` on
each boundary `/compact` nudge (and later `NudgeOutcome` with acp's compliance
verdict — acp#29); both are custom events kept but not dropped by ingest.
Cost pricing can be extended/corrected via `{"pricing": {"<model prefix>":
{"input", "output", "cache_write", "cache_write_1h", "cache_read"}}}` (USD per
MTok) in config.json — longest prefix wins, loaded at boot. `cache_write` is the
5m-TTL rate; `cache_write_1h` is the 1h rate (defaults to `input × 2` if omitted).
A partial override **merges** onto the base entry (missing keys keep their
defaults), so overriding just `cache_write` no longer wipes the other rates; set a
prefix to `null` to unprice it. The `mega` session flag defaults to ≥300 main-chain
messages OR ≥300k average context; tune with `{"mega": {"turns": N, "ctx": N}}` in
config.json (or `OBS_MEGA_TURNS`/`OBS_MEGA_CTX`). `baseline_ctx`, `turn tax`,
`switch_rewrite_est` and the compact `whatif` are deliberate **approximations**
(harness-overhead floor / average per-turn context / cache rewrite at switch
boundaries / cache-read a cap would avoid) — diagnostic signals, not exact bills.

## Config (env `OBS_*` > config.json > default)

| env | default | meaning |
| --- | --- | --- |
| `OBS_HOST` | `127.0.0.1` | loopback only; non-loopback bind is refused unless `OBS_ALLOW_NONLOOPBACK=1` |
| `OBS_PORT` | `4090` | listen port (validated as int) |
| `OBS_DATA_DIR` | `$XDG_STATE_HOME/claude-observability` | state directory (0700) |
| `OBS_TOKEN` | _(unset → auth off)_ | bearer secret; empty = off. Loopback is trusted by default |
| `OBS_REDACT` | `1` | redact secrets on the post-ack path |
| `OBS_DURABLE` | `0` | `1` = store synchronously before the ack |
| `OBS_MAX_BODY` | `5 MiB` | request body cap (413 over) |
| `OBS_SHUTDOWN_GRACE_MS` | `3000` | graceful-teardown budget |
| `OBS_MAX_AGE_DAYS` | `7` | retention: drop events older than this |
| `OBS_MAX_ROWS` | `500000` | retention: keep at most this many rows |
| `OBS_MAX_DB_MB` | `1024` | retention: size cap (freelist-aware) |
| `OBS_ACTIVE_MS` | `600000` | stats idle threshold: session "active" + orphan-Pre cutoff |
| `OBS_TURN_ORPHAN_MS` | `OBS_ACTIVE_MS` | `/stats/turns`: a Pre with no Post anywhere in the session older than this is `orphan` (younger = `pending`); config `{turns:{orphan_after_ms}}` wins |
| `OBS_TURN_WAIT_CAP_MS` | `1800000` | `/stats/turns`: cap on a single permission-wait span (an overnight prompt must not devour the split); config `{turns:{wait_cap_ms}}` wins |
| `OBS_MEGA_TURNS` | `300` | mega-session flag: main-chain messages at/above this (config.json `{mega:{turns}}` wins) |
| `OBS_MEGA_CTX` | `300000` | mega-session flag: average context at/above this (config.json `{mega:{ctx}}` wins) |
| `OBS_TITLE_MODEL` | `claude-haiku-4-5-20251001` | model the `title-sessions` batch calls (via the `claude` CLI) to summarise a session |
| `OBS_TITLE_MIN_GROWTH` | `3` | `title-sessions`: re-title a session only after this many new prompts |
| `OBS_TITLE_AUTO` | `1` | auto-titler: the running collector titles recently-idle sessions on a timer (spawns a detached `title-sessions` child so the blocking `claude` call never stalls ingest) → the fleet strip shows the summary, not the raw first prompt. `0` disables |
| `OBS_TITLE_INTERVAL_SEC` | `180` | auto-titler tick interval |
| `OBS_TITLE_IDLE_SEC` | `30` | auto-titler quiet-gate: a session must be idle this long before it's titled (short, so active sessions get a title during natural pauses; avoids titling mid-turn) |
| `OBS_TITLE_LIMIT` | `8` | auto-titler: max sessions titled per tick (caps `claude` spawns) |
| `OBS_TURN_MAT` | `1` | #82 auto-materializer: the running collector persists SETTLED turns into the `turns` table on a timer (in-process on the shared connection — buildTurns is cheap, so no detached child and no write contention). `0` disables |
| `OBS_TURN_MAT_INTERVAL_SEC` | `120` | auto-materializer tick interval |
| `OBS_TURN_MAT_LIMIT` | `50` | auto-materializer: max sessions materialized per tick (bounds the event-loop stall) |

## Guarantees (held from stage 0)

- **Never blocks the agent**: 202 is sent before any store/stream work
  (`setImmediate`). The send-event hook already has its answer.
- **Single instance**: the listening socket is the lock; `EADDRINUSE` probes
  `/health` (ours → exit 0, foreign → exit 3). The pidfile is a locator, not a lock.
- **Fail-open**: process-level `uncaughtException` / `unhandledRejection` guards;
  byte-bounded in-memory queue with drop-oldest.
- **Loopback boundary**: `127.0.0.1` bind + `Host` allowlist (421 otherwise) +
  `umask(0o077)` + 0600/0700 state.
