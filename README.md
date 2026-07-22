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
| [`context`](core/context/README.md) | SessionStart + UserPromptSubmit | ✅ active | Inject dynamic project context — git state (SessionStart), current time, and opt-in keyword→doc providers: `keyword-docs` + named instances `msg-format` / `db-schema` / `domain-docs` (UserPromptSubmit). Indexes layer project / user-designated / plugin-bundled, so docs work from any cwd and can ship with the plugin |
| [`send-event`](core/send-event/README.md) | all 9 events | ✅ active | Forward every hook event to the local observability collector (never blocks) |
| [`obs-lazy-start`](core/obs-lazy-start/README.md) | SessionStart | ✅ active | Spawn the collector (detached) if it isn't already running |
| [`observability`](core/observability/README.md) | _(server)_ | ✅ active | Collector server: receives, stores (SQLite), redacts & streams hook events to a dashboard |

## Skills

User-invoked procedural skills (not hooks). Live under `skills/<name>/SKILL.md`
and are auto-discovered by the plugin loader.

| Skill | Invoke | Status | Purpose |
| --- | --- | --- | --- |
| [`agentic-coding-git-workflow`](skills/agentic-coding-git-workflow/README.md) | `/claude-hooks:agentic-coding-git-workflow` | ✅ active | Personal issue→PR→cleanup flow in one skill, from an existing issue (`#N`, never creates issues): view issue → plan → update main → feat branch + worktree (`setup`), commit → push → PR (`finish`), then remove worktree → update main after merge (`cleanup`). The happy-path for what `git-guard` enforces. |
| [`keyword-docs-prune`](skills/keyword-docs-prune/SKILL.md) | `/claude-hooks:keyword-docs-prune [days]` | ✅ active | Analyze keyword-docs injection stats, join transcripts for follow-up rates, and propose index pruning (remove/narrow noisy keywords). User-invoked only (`disable-model-invocation`); applies changes only after explicit approval. |
| [`keyword-docs-add-index`](skills/keyword-docs-add-index/SKILL.md) | `/claude-hooks:keyword-docs-add-index [doc-path]` | ✅ active | Register a doc into a keyword-docs index: read the doc → pick the instance (from the project's actual config) → propose trigger keywords → collision-check every index file → set precision → append after approval. The pair of `keyword-docs-prune` (add-index = 넣기, prune = 빼기). |
| [`keyword-docs-new-docs`](skills/keyword-docs-new-docs/SKILL.md) | `/claude-hooks:keyword-docs-new-docs [category] [name]` | ✅ active | Generate a keyword-docs doc from a per-category template (`msg-format` / `db-schema` / `domain`): fill slots by interview or code extraction → approve draft → save → chain into `keyword-docs-add-index` for registration. Creation to registration in one pass; templates front-load the 1200-char injection window. |
| [`db-schema-propose-codebase`](skills/db-schema-propose-codebase/SKILL.md) | `/claude-hooks:db-schema-propose-codebase [table]` | ✅ active | Produce db-schema meaning proposals (proposal.json) from codebase evidence and submit them to the akg review queue (`akg propose`). Producer-only: doc creation is akg-collector's, review/adopt/promote is the akg dashboard's — the local md write pipeline (former `db-schema-docs`/`db-schema-apply` skills) was removed in 0.46.0 (#123/#124/#125). |
| [`html-doc`](skills/html-doc/SKILL.md) | `/claude-hooks:html-doc [소스.md \| 주제] [--artifact]` | ✅ active | Produce design docs / reports / deliverables as a self-contained single-file HTML: zero external requests (offline + Artifact-CSP safe), light/dark via `prefers-color-scheme` + `data-theme` toggle, sticky TOC, print CSS — all fixed by `template.html`. Three modes: md→HTML conversion (render-only, source md stays the truth, `data-derived-from` footer), authoring a new design doc in HTML, and general-purpose pages. Model-invocable; local file by default, Artifact publish opt-in. Every render must pass the static checker (`check.mjs`). |

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
├── lib/shell-lex.mjs      # shared quote-aware argv lexer (git-guard, bash-guard)
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
