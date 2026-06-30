# claude-hooks

A personal, portable collection of [Claude Code](https://code.claude.com)
hooks, bundled as a single installable plugin. Install once per machine; each
hook lives as a self-contained module under `core/`.

## Modules

| Module | Event | Status | Purpose |
| --- | --- | --- | --- |
| [`lint`](core/lint/README.md) | PostToolUse | ✅ active | Lint/format-check files by extension (md, json/yaml, js/ts, sh) |
| [`bash-guard`](core/bash-guard/README.md) | PreToolUse | ✅ active | Block dangerous shell commands (rm -rf, disk destruction, secret leaks) + style nudges (grep→rg, find→fd, cat→Read, …) |
| [`git-guard`](core/git-guard/README.md) | PreToolUse | ✅ active | Block direct work on main/master (edits, commits, pushes) + force push + --no-verify |
| [`tdd-guard`](core/tdd-guard/README.md) | PreToolUse | 🚧 placeholder | (developed elsewhere — slot reserved) |

## Layout

```text
claude-hooks/
├── .claude-plugin/
│   ├── plugin.json        # plugin manifest
│   └── marketplace.json   # this repo doubles as a 1-plugin marketplace
├── hooks/
│   └── hooks.json         # central wiring: every hook, grouped by event
├── core/<module>/         # one self-contained module per hook
├── lib/hook-io.mjs        # shared stdin/decision helpers
└── README.md
```

Adding a hook = create `core/<name>/`, then add one entry to `hooks/hooks.json`.
Modules reference their own bundled files via `${CLAUDE_PLUGIN_ROOT}` and never
touch the user's project config.

## Requirements

- **Node.js** on `PATH` (hooks are written as `.mjs`).
- Per-module tools — see each module's README. Currently:
  - `lint` → `npm i -g markdownlint-cli2 prettier eslint` (+ `shellcheck` system pkg)

Missing per-module tools cause that hook to **fail open** (it logs a note and
does nothing), so a partial install never breaks your session.

## Install

### Local (development / single machine)

```bash
claude --plugin-dir /path/to/claude-hooks
# reload after edits within a session:
/reload-plugins
```

### Via marketplace (other machines)

Push this repo to GitHub, then on each machine:

```bash
/plugin marketplace add <owner>/claude-hooks
/plugin install claude-hooks@claude-hooks
```

> The `source` in `.claude-plugin/marketplace.json` is `"./"` because this repo
> *is* the plugin (relative paths resolve against the cloned marketplace repo,
> so this works once it's on GitHub). Alternatives per plugin entry:
>
> - subfolder of a repo → `{ "source": "git-subdir", "url": "owner/repo", "path": "sub/dir" }`
> - another GitHub repo, optionally pinned → `{ "source": "github", "repo": "owner/repo", "ref": "v1.0.0" }`
>
> A single marketplace may mix these, so it can catalog plugins from several repos.

## Notes on hook semantics

Captured from `claude-hooks-syntax.md` / `claude-hooks-10-patterns.md`:

- **Exit codes:** `exit 2` = blocking (stderr fed back to Claude); any other
  non-zero = *fail open*. Never mix `exit 2` with stdout JSON.
- **PostToolUse can't undo** an edit — it runs after the tool. The `exit 2` +
  imperative-stderr pattern turns errors into a correction loop instead.
- `decision:"block"` means **opposite things per event** (PostToolUse: stop the
  loop; Stop: keep going). The lint hook therefore uses `exit 2`, not
  `decision:block`.
