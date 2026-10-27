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
| [`git-guard`](core/git-guard/README.md) | PreToolUse | ✅ active | Block direct work on main/master (edits, commits, pushes) + force push + --no-verify + agent-initiated PR merges (`gh pr merge`, `gh api` PUT merge, `git merge` / `git pull <other>` / `git rebase` on main). Within one command line, earlier `cd` / `git checkout` / `git switch` segments decide where the later ones are judged, so `git checkout main && git merge feat && git push` is blocked |
| [`tdd-guard`](core/tdd-guard/README.md) | PreToolUse | 🚧 placeholder | (developed elsewhere — slot reserved) |
| [`context`](core/context/README.md) | SessionStart + UserPromptSubmit | ✅ active | Inject dynamic project context — git state (SessionStart), current time, and opt-in keyword→doc providers: `keyword-docs` + named instances `msg-format` / `db-schema` / `domain-docs` (UserPromptSubmit). Indexes layer project / user-designated / plugin-bundled, so docs work from any cwd and can ship with the plugin |
| [`send-event`](core/send-event/README.md) | all 9 events | ✅ active | Forward every hook event to the local observability collector (never blocks) |
| [`obs-lazy-start`](core/obs-lazy-start/README.md) | SessionStart | ✅ active | Spawn the collector (detached) if it isn't already running |
| [`observability`](core/observability/README.md) | _(server)_ | ✅ active | Collector server: receives, stores (SQLite), redacts & streams hook events to a dashboard |

## Adapters

The guards' rules live in runtime-neutral cores (`core/bash-guard/decide.mjs`,
`core/git-guard/decide.mjs`) that know nothing about a harness. Each adapter is
thin I/O around them, so a rule fixed once is fixed everywhere.

| Adapter | Target | Status | Purpose |
| --- | --- | --- | --- |
| _(built in)_ | Claude Code | ✅ active | `core/*/…​.mjs` — stdin event → `permissionDecision` JSON |
| [`opencode`](adapters/opencode/README.md) | [opencode](https://opencode.ai) | ✅ active | One plugin: bash-guard + git-guard via `tool.execute.before` throw, repeat-retry suppression, and session/tool observation into the same collector (tagged `runtime: "opencode"`). `install.mjs` also links every `skills/<name>` into `~/.config/opencode/skills/` so opencode's `skill` tool reads the same skills. Plus `backfill.mjs` — imports pre-install history (sessions, tool calls, per-step tokens) from `opencode.db` with its original timestamps. Install: [`docs/opencode.md`](docs/opencode.md) |

## Skills

User-invoked procedural skills (not hooks). Live under `skills/<name>/SKILL.md`
and are auto-discovered by the plugin loader; `adapters/opencode/install.mjs`
links the same folders into opencode's skills directory.

| Skill | Invoke | Status | Purpose |
| --- | --- | --- | --- |
| [`agentic-coding-git-workflow`](skills/agentic-coding-git-workflow/README.md) | `/claude-hooks:agentic-coding-git-workflow [setup <topic> [worktree-path] \| finish \| cleanup]` | ✅ active | Personal branch→PR→cleanup flow in one skill: update main → feat branch + worktree at `<main>/../worktrees/<repo>-<topic>` or a path you name (`setup`), commit → check the PR is still open → sync main → push → PR (`finish`), then remove worktree → update main after merge (`cleanup`). The happy-path for what `git-guard` enforces; runs on opencode too. |
| [`svg-diagram`](skills/svg-diagram/SKILL.md) | `/claude-hooks:svg-diagram [스펙.json] [--style KEY]` | ✅ active | Explanatory diagrams as data → generator → SVG instead of hand-placed coordinates: the spec (JSON) holds structure only (cells, order, links), `gen.mjs` computes boxes / routes / labels from the font size, and colors / strokes / fonts are CSS tokens so one of ten styles (incl. `doc`, which follows the host document's tokens) is swapped in by class. Four generators (boxflow · gridmap · sequence · swimlane); a diagram kind without a generator gets its generator first. Outputs an SVG fragment for token-based HTML / Artifact pages, a self-contained preview HTML, or a standalone `.svg` — script 0, external requests 0. |
| [`analysis-flow`](skills/analysis-flow/SKILL.md) | `/claude-hooks:analysis-flow [업무 설명 \| 지금까지 \| 스펙.json] [--shape lane\|flow] [--style KEY]` | ✅ active | Data-analysis process → flow diagram via `svg-diagram`: collects steps from a written task description or from this session's tool calls (SQL · `curl` · `rg`/`awk` on logs · read CSV/JSON), keeps them in a steps table (number · name · source · full query/command · condition · result · next), asks only the empty cells one question at a time, then writes a `swimlane` spec (lanes = source kinds DB · server log · API · file · calc/judgement · result; default) or a `boxflow` spec (source · query · result rows per box). Renders with style `product` by default, and `appendix.mjs` (dependency-free) appends each step's full query/command under the figure — script 0, external requests 0. |
| [`squash-import`](skills/squash-import/SKILL.md) | `/claude-hooks:squash-import [<topic>] [--from external/main] [--to samsung/main] [--since <sha>]` | ✅ active | Carry one remote's changes into another as a single squash commit + PR (default `external/main` → `samsung/main`): finds the last imported point by tree match (fallbacks: local ref `refs/squash-import/<remote>/<branch>`, then `--since`), applies only `<last>..<from>` with `git apply --3way` on a `feat/<topic>` worktree branched from `<to>`, writes the PR title / body / commit message as a feature list that passes a scrub check (source remote · host · owner names, `#N`, SHAs: 0 hits), pushes, opens the PR. Files the destination repo fills in on its own (in-house slots, listed per repo in the skill) keep the destination side on conflict and are left out of the tree-match check. Merging stays human — `git-guard` blocks agent-initiated PR merges and pushes to main. |
| [`setup`](skills/setup/SKILL.md) | `/claude-hooks:setup [claude \| opencode \| env \| akg \| check]` | ✅ active | First-time install on a new machine: one fixed checkout → Claude Code (marketplace or `--plugin-dir`) → opencode (`install.mjs`: plugin stub + skill links) → environment variables (`OBS_*` · `CLAUDE_HOOKS_OC_*` · `AKG_*`) → AKG CLI + server + token → a check table. User-invoked only. |
| [`akg-push`](skills/akg-push/SKILL.md) | `/claude-hooks:akg-push [<type>/<id>] [file]` | ✅ active | Push local knowledge into the AKG server via the `akg` CLI: a new md doc or a doc edit (`akg push <type>/<id> <file.md\|file.json> [--create] [--rev <rev>] [--note …] [--dry-run]`, needs AKG `feat/agent-write`; `--create` with a `.md` lands inactive, with a `.json` lands with the file's `status` (the skill writes `"inactive"`), `--rev` stops on 409 instead of overwriting a newer edit), a slot proposal (`akg propose`), a table catalog (`akg catalog-push`). Starts with how a program connects directly — one `Authorization: Bearer` header, token from the `users.yml` agent line or the Keycloak `fdc-voc-agent-a2a` service account, CSRF only on cookie sessions — then one command + check per kind, and what 401 / 403 / 409 mean. Agent-written slots land `inferred`; a human promotes them in the AKG UI. |
| [`akg-mermaid`](skills/akg-mermaid/SKILL.md) | `/claude-hooks:akg-mermaid [문서.md]` (model-invoked too) | ✅ active | Agent guide for `mermaid` fenced diagrams inside AKG md docs (skill · domain · voc …), which the AKG reading view draws since AKG #78 while the text stays text for the BE / LLM: when to draw (flow · branch · request/response · state) and to say the same in prose, where the fence goes, the diagram kinds the bundled mermaid 11.17.2 draws (flowchart TD/LR · sequenceDiagram · stateDiagram-v2 · erDiagram first), what AKG's `securityLevel: "strict"` + `htmlLabels: false` setup does to `click` (a link click breaks the figure), HTML labels, `style`/`classDef`, `%%{init}%%`, `[[ ]]`, a size cap (8 nodes · 10 arrows, from the 720px reading column) and how to read "도식 N 줄" / "N 줄" errors. `check.mjs` (no install) draws every fence with AKG's own `mermaid.min.js` and settings in headless Chrome and reports `FAIL` lines with document line numbers plus width/height and syntax warnings, before `akg push`. |
| [`akg-pull`](skills/akg-pull/SKILL.md) | `/claude-hooks:akg-pull` | 🚧 placeholder | Slot for pulling AKG docs into the local mirror `~/.claude/akg/<type>/` via `akg sync` (the same mirror `core/context`'s hub mode reads). Takes over from the retired `keyword-docs-prune` / `db-schema-docs`. |

## Layout

```text
claude-hooks/
├── .claude-plugin/
│   ├── plugin.json        # plugin manifest
│   └── marketplace.json   # this repo doubles as a 1-plugin marketplace
├── hooks/
│   └── hooks.json         # central wiring: every hook, grouped by event
├── core/<module>/         # one self-contained module per hook
│   └── decide.mjs         # (guards) runtime-neutral rules, shared by every adapter
├── adapters/<target>/     # one folder per non-Claude-Code harness (opencode)
├── skills/<name>/         # one self-contained skill (SKILL.md) per workflow
├── docs/                  # design docs + install manuals (docs/opencode.md)
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
