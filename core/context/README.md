# context

Inject **dynamic project context** into Claude via hooks, so each session and
prompt starts oriented instead of cold. A provider-registry module: small
composable context providers are selected per event, budgeted under the 10k
character cap, and injected as one `additionalContext` block.

Full architecture, verified mechanism, and roadmap: [DESIGN.md](DESIGN.md).

## Events

- `SessionStart` (`startup|resume|clear|compact`) — project snapshot, once per
  session; refreshes on resume and re-hydrates after compaction.
- `UserPromptSubmit` — genuinely fresh per-turn signals.

The hook only ever injects context; it never blocks (always exits 0).

## Providers (v1)

| id | event | default | injects |
| --- | --- | --- | --- |
| `git` | SessionStart | on | branch, short SHA, uncommitted files (head 20), recent commits |
| `time` | UserPromptSubmit | on | current date/time (counteracts the model's knowledge cutoff) |
| `keyword-docs` | UserPromptSubmit | off (opt-in) | docs whose keywords match the prompt, from `.claude/context-docs.json` (local, deterministic) |
| `msg-format` | UserPromptSubmit | off (opt-in) | equipment command message-format docs, keyed by command name (`.claude/context-docs.msg-format.json`) |
| `db-schema` | UserPromptSubmit | off (opt-in) | DB schema docs, keyed by DB/table name (`.claude/context-docs.db-schema.json`) — file-based v1 of #22 |
| `domain-docs` | UserPromptSubmit | off (opt-in) | domain-concept docs (e.g. TSUM, Interlock), keyed by term (`.claude/context-docs.domain.json`) |

Tool-time providers (per-file-rules, tool-failure-coach) are designed in
[DESIGN.md](DESIGN.md) and tracked as issues — not yet shipped. `db-schema`
above is the file-based v1 of #22; live introspection stays future scope there.
(A `project-files` provider was considered and rejected — CLAUDE.md `@imports`
cover it; see DESIGN.md §12.)

## Requirement

- `git` on `PATH` for the `git` provider. If it is missing (or the directory is
  not a repo), that provider is silently skipped and the hook still runs.

## Configuration (optional)

Zero config required — the defaults above work out of the box. To customize, add
`<project>/.claude/context.json` (project layer) and/or `~/.claude/context.json`
(user layer, same schema — for cwd-independent personal setup):

```json
{
  "charBudget": { "SessionStart": 8000, "UserPromptSubmit": 1500 },
  "providers": [
    { "id": "git", "priority": 90 },
    { "id": "time", "priority": 40 }
  ]
}
```

- `providers` merge **by id** across defaults → user → project (later layer
  wins per id), so a user file never silently disables `git`/`time` elsewhere.
  Disable one provider with `{ "id": "...", "enabled": false }`.
- Missing or invalid files → built-in defaults (`git` + `time`).
- Project-level `{ "providers": [] }` → kill switch (inject nothing, exit 0,
  all layers including bundled). A user-level empty array contributes nothing.
- Unknown provider ids are ignored, so referencing a not-yet-shipped provider is
  a harmless no-op.

### `keyword-docs` (opt-in)

Enable it, then create the index it reads:

```json
{
  "id": "keyword-docs",
  "priority": 50,
  "params": { "index": ".claude/context-docs.json", "maxDocs": 2, "maxCharsEach": 1200 }
}
```

`<project>/.claude/context-docs.json` maps keywords to a doc, injected only when
the prompt mentions them:

```json
[
  { "keywords": ["migration", "schema", "alembic"], "path": "docs/db-schema.md" },
  { "keywords": ["auth", "jwt", "session"], "path": "docs/auth.md", "precision": 0.5 }
]
```

- `params.match`: `"word"` (default — word-boundary and plural-tolerant, so
  `migration` also matches `migrations`; multi-word keywords match as phrases),
  `"exact"`, or `"substring"`.
- `params.dedup` (default on): a doc injected this session is not re-injected
  within `params.dedupTtlMs` (default 15m); it returns after the TTL or in a new
  session. No match injects nothing (no tokens).
- `precision` (per index entry, default `1`): how confident the keyword→doc
  mapping is. `1` injects the doc slice; `< 1` (e.g. `0.5`) injects only a
  one-line pointer (`→ docs/auth.md — related doc …; Read it if relevant`,
  ~20 tokens) so the model pulls the doc itself only when actually relevant.
  Use it for broad keywords you don't want to delete but don't fully trust.

#### Named instances: `msg-format`, `db-schema`, `domain-docs`

Three inherited instances of the same engine, each with its own index file and
its own `## <id>` header — enable any subset:

```json
{
  "providers": [
    { "id": "msg-format" },
    { "id": "db-schema" },
    { "id": "domain-docs" },
    { "id": "time", "priority": 40 }
  ]
}
```

| instance | index file (default, override via `params.index`) | keywords are |
| --- | --- | --- |
| `msg-format` | `.claude/context-docs.msg-format.json` | equipment command names (`cmd_start_lot`) |
| `db-schema` | `.claude/context-docs.db-schema.json` | DB / table names |
| `domain-docs` | `.claude/context-docs.domain.json` | domain terms (`tsum`, `interlock`) |

All engine features apply per instance (match modes, dedup, `precision`,
stats — lines carry `index` + `layer` fields for per-instance / per-layer
analysis). Keywords are lowercased before matching, so `TSUM` in a prompt
matches keyword `"tsum"`.
**Adding a doc = appending one index entry — it takes effect on the next turn,
no reload.** Adding a whole new category = one thin provider file calling
`makeKeywordDocsProvider` + one registry line.

#### Index layers — project / user-designated / plugin-bundled

Each instance reads up to three indexes per turn, in precedence order (a
keyword claimed by a higher layer is shadowed in lower ones):

| layer | index location | ships via |
| --- | --- | --- |
| project | `<cwd>`-resolved `params.index` (defaults above) | committed to the repo |
| user | `params.index` in `~/.claude/context.json` (absolute / `~` paths OK; default `~/.claude/context-docs*.json`) | stays on the machine — private docs never touch git |
| bundle | `${CLAUDE_PLUGIN_ROOT}/context-docs/<id>.json` | installed/updated with the plugin |

A doc entry's `path` resolves against **the folder containing its index file**
(a folder named `.claude` delegates to its parent, so the classic
`<cwd>/.claude` layout is unchanged). An index + docs folder is therefore
self-contained: point `params.index` at e.g. `~/eqp-docs/msg-format.json` and
injection works from any directory you launch Claude in.

A bundled index **auto-enables its instance** with zero config (that is the
point of shipping docs with the plugin); opt out per id with
`{ "enabled": false }`, or entirely with the project kill switch. Without
`CLAUDE_PLUGIN_ROOT` (non-plugin execution) the bundle layer is skipped.

#### Hub (B모드, opt-in) — freshness from a remote akg server

`params.hub` backs the **user layer's** index (or `sources[0]` on a direct call
with no `layers`) with a remote [akg](https://github.com/ollybaysion/agent-knowledge-governance)
server, so injection can reflect the server's latest doc instead of the last
`akg sync`:

```json
{
  "id": "db-schema",
  "params": {
    "index": "~/.claude/akg/db-schema/index.json",
    "hub": { "url": "https://akg.internal", "type": "db-schema", "timeoutMs": 400, "indexTtlMs": 300000 }
  }
}
```

- **Index refresh** is TTL-gated (`indexTtlMs`, default 5m) and bounded by
  `timeoutMs` (default 400ms) — a slow/down server just means this turn
  matches against whatever `index.json` was already on disk; it never stalls
  the turn past the cap.
- **Once a doc matches** (full or pointer `precision` — a pointer match fetches
  too, so a later model-initiated `Read` finds the file even on a first-ever,
  empty mirror), that one doc is fetched fresh: same `timeoutMs` cap,
  ETag-aware (an unchanged doc costs a 304, ~0 bytes), fail-open to whatever
  copy is already cached. A doc with neither a fresh fetch nor a local copy is
  skipped silently — same as a missing file today.
- **Auth**: `hub.token`, else `AKG_TOKEN`, else `~/.claude/akg/token` — the
  same token file the akg CLI's `akg sync` (A모드) uses, since both talk to
  the same server.
- A hub-backed instance shares its mirror directory with `akg sync` (same
  `index.json` / `docs/*.md` layout) and can be pointed at the exact same path
  A모드 already syncs into — the two modes are interchangeable by config alone.
  Hub bookkeeping (ETags, last-fetch times) lives in a sidecar
  `.hub-cache.json` next to the index and never touches A모드's own
  `meta.json`.
- Everything else (matching, dedup, `maxDocs`/`maxCharsEach`, stats) is
  unchanged — `hub` only decides where a matched doc's BODY comes from.

### Injection stats (false-positive pruning, layer 1)

Every actual injection appends one JSON line to
`~/.claude/context-stats/<project-hash>.jsonl`:

```json
{ "ts": 1751600000000, "session": "abc", "keywords": ["mcp"], "path": "docs/x.md", "mode": "full", "index": "/home/u/proj/.claude/context-docs.json", "layer": "project" }
```

`keywords` holds the keyword(s) that fired — accumulate a few weeks and
repeated false positives become visible ("`mcp` fired 14 times, never
relevant"), so index pruning is data-driven. Recording only (best-effort,
never blocks injection; rolling cap ~4000 lines).

To act on the data, run `/claude-hooks:keyword-docs-prune [days]` — it
aggregates per keyword, joins transcripts for follow-up rates, and proposes
removals/narrowings; changes apply only after your approval.

To register a new doc the guided way, run
`/claude-hooks:keyword-docs-add-index [doc-path]` — it picks the right instance from
your config, proposes keywords, collision-checks every index file, and appends
only after your approval.

To create the doc itself from a template (and register it in the same pass),
run `/claude-hooks:keyword-docs-new-docs [category] [name]` — per-category
templates (`msg-format` / `db-schema` / `domain`) front-load the injection
window, slots are filled by interview or code extraction, and the add-index
flow runs at the end.

## Testing locally

```bash
# SessionStart — git snapshot
echo '{"cwd":"'"$PWD"'","source":"startup"}' \
  | node core/context/session-context.mjs ; echo "exit=$?"

# UserPromptSubmit — current time
echo '{"cwd":"'"$PWD"'","prompt":"hello"}' \
  | node core/context/prompt-context.mjs ; echo "exit=$?"
```

Each prints a `hookSpecificOutput.additionalContext` payload and exits 0. In a
non-repo directory, or with `{ "providers": [] }`, the hook prints nothing and
exits 0.
