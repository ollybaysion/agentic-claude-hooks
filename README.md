# claude-hooks

A personal, portable collection of [Claude Code](https://code.claude.com)
hooks and skills, bundled as a single installable plugin. Install once per
machine; each hook lives as a self-contained module under `core/`, each skill
under `skills/`.

## Modules

| Module | Event | Status | Purpose |
| --- | --- | --- | --- |
| [`lint`](core/lint/README.md) | PostToolUse | ✅ active | Lint/format-check files by extension (md, json/yaml, js/ts, sh, html, py) |
| [`bash-guard`](core/bash-guard/README.md) | PreToolUse | ✅ active | Block dangerous shell commands (rm -rf, disk destruction, secret leaks) + style nudges (grep→rg, find→fd, cat→Read, …) |
| [`git-guard`](core/git-guard/README.md) | PreToolUse | ✅ active | Block direct work on main/master (edits, commits, pushes) + force push + --no-verify + agent-initiated PR merges (`gh pr merge`, `gh api` PUT merge, `git merge` on main) |
| [`tdd-guard`](core/tdd-guard/README.md) | PreToolUse | 🚧 placeholder | (developed elsewhere — slot reserved) |
| [`context`](core/context/README.md) | SessionStart + UserPromptSubmit | ✅ active | Inject dynamic project context — git state (SessionStart) + current time (UserPromptSubmit) |
| [`send-event`](core/send-event/README.md) | all 9 events | ✅ active | Forward every hook event to the local observability collector (never blocks) |
| [`obs-lazy-start`](core/obs-lazy-start/README.md) | SessionStart | ✅ active | Spawn the collector (detached) if it isn't already running |
| [`observability`](core/observability/README.md) | _(server)_ | ✅ active | Collector server: receives, stores (SQLite), redacts & streams hook events to a dashboard |

## Skills

User-invoked procedural skills (not hooks). Live under `skills/<name>/SKILL.md`
and are auto-discovered by the plugin loader.

| Skill | Invoke | Status | Purpose |
| --- | --- | --- | --- |
| [`agentic-coding-git-workflow`](skills/agentic-coding-git-workflow/README.md) | `/claude-hooks:agentic-coding-git-workflow` | ✅ active | Personal issue→PR→cleanup flow in one skill, from an existing issue (`#N`, never creates issues): view issue → plan → update main → feat branch + worktree (`setup`), commit → push → PR (`finish`), then remove worktree → update main after merge (`cleanup`). The happy-path for what `git-guard` enforces. |

## Layout

```text
claude-hooks/
├── .claude-plugin/
│   ├── plugin.json        # plugin manifest
│   └── marketplace.json   # this repo doubles as a 1-plugin marketplace
├── hooks/
│   └── hooks.json         # central wiring: every hook, grouped by event
├── core/<module>/         # one self-contained module per hook
├── skills/<name>/         # one self-contained skill (SKILL.md) per workflow
├── lib/hook-io.mjs        # shared stdin/decision helpers
└── README.md
```

Adding a hook = create `core/<name>/`, then add one entry to `hooks/hooks.json`.
Modules reference their own bundled files via `${CLAUDE_PLUGIN_ROOT}` and never
touch the user's project config.

## Requirements

- **Node.js** on `PATH` (hooks are written as `.mjs`).
- Per-module tools — see each module's README. Currently:
  - `lint` → `npm i -g markdownlint-cli2 prettier eslint html-validate` (+ `shellcheck`/`shfmt` static binaries, + `ruff` for Python)

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
> _is_ the plugin (relative paths resolve against the cloned marketplace repo,
> so this works once it's on GitHub). Alternatives per plugin entry:
>
> - subfolder of a repo → `{ "source": "git-subdir", "url": "owner/repo", "path": "sub/dir" }`
> - another GitHub repo, optionally pinned → `{ "source": "github", "repo": "owner/repo", "ref": "v1.0.0" }`
>
> A single marketplace may mix these, so it can catalog plugins from several repos.

## Notes on hook semantics

Captured from `claude-hooks-syntax.md` / `claude-hooks-10-patterns.md`:

- **Exit codes:** `exit 2` = blocking (stderr fed back to Claude); any other
  non-zero = _fail open_. Never mix `exit 2` with stdout JSON.
- **PostToolUse can't undo** an edit — it runs after the tool. The `exit 2` +
  imperative-stderr pattern turns errors into a correction loop instead.
- `decision:"block"` means **opposite things per event** (PostToolUse: stop the
  loop; Stop: keep going). The lint hook therefore uses `exit 2`, not
  `decision:block`.
