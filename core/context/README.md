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
`<project>/.claude/context.json`:

```json
{
  "charBudget": { "SessionStart": 8000, "UserPromptSubmit": 1500 },
  "providers": [
    { "id": "git", "priority": 90 },
    { "id": "time", "priority": 40 }
  ]
}
```

- Missing or invalid file → built-in defaults (`git` + `time`).
- `{ "providers": [] }` → kill switch (inject nothing, exit 0).
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
stats — lines carry an `index` field for per-instance analysis). Keywords are
lowercased before matching, so `TSUM` in a prompt matches keyword `"tsum"`.
**Adding a doc = appending one index entry — it takes effect on the next turn,
no reload.** Adding a whole new category = one thin provider file calling
`makeKeywordDocsProvider` + one registry line.

### Injection stats (false-positive pruning, layer 1)

Every actual injection appends one JSON line to
`~/.claude/context-stats/<project-hash>.jsonl`:

```json
{ "ts": 1751600000000, "session": "abc", "keywords": ["mcp"], "path": "docs/x.md", "mode": "full", "index": ".claude/context-docs.json" }
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
