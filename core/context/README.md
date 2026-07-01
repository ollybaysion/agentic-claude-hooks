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

`project-files`, `keyword-docs`, `db-schema`, and tool-time providers are
designed in [DESIGN.md](DESIGN.md) and tracked as issues — not yet shipped.

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
