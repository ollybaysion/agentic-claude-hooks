# lint

A single PostToolUse hook that lint/format-checks files **by extension**,
dispatching each type to the right tool. Add a file type by adding one entry to
the `LINTERS` table in `lint.mjs`.

## How it works

- **Event / matcher:** `PostToolUse` on `Write|Edit|MultiEdit`.
- **Dispatch:** the file's extension selects a tool from `LINTERS`. Unlisted
  extensions pass untouched.
- **Behaviour:** block-and-feedback only (no auto-fix). On a violation the hook
  exits `2` and writes the tool output plus a fix instruction to stderr, which
  Claude receives and acts on — a self-correction loop.
- **Fail open:** if a tool is missing (not installed) or cannot run (e.g. no
  project config), that file type is skipped (exit 0) instead of blocking.

## Supported types and tools

| Extensions | Tool | Verdict from exit code |
| --- | --- | --- |
| `.md` `.markdown` | `markdownlint-cli2` (with bundled `config/`) | non-zero = violation |
| `.json` `.yaml` `.yml` | `prettier --check` | non-zero = violation |
| `.js` `.jsx` `.cjs` `.mjs` `.ts` `.tsx` | `eslint` | 1 = violation, 2+ = infra (skip) |
| `.sh` `.bash` | `shellcheck` | non-zero = violation |

## Requirements (install what you want enforced)

```bash
npm i -g markdownlint-cli2 prettier eslint   # node-based tools
# shellcheck is a system package:
sudo apt install shellcheck                   # Debian/Ubuntu  (brew install shellcheck on macOS)
```

Anything not installed is simply skipped (fail open).

## Path templates (per-directory rules)

Markdown files can get extra rules based on their **path** — e.g. enforcing a
required heading structure (MD043) on ADRs under `docs/adr/`. Matched files use
a template config that `extends` the base; unmatched files use the base as
usual. See [templates.md](templates.md) for how to add one.

## Caveats

- **ESLint is best-effort.** It needs a resolvable config in the project being
  edited. Where the (global) `eslint` can't load the project's config/plugins it
  exits `2`, which this hook treats as *infra* and skips — so files in projects
  without ESLint set up are not blocked.
- **Prettier `--check`** only reports *that* a file isn't formatted, not the
  diff. The fix message tells Claude to reformat; running `prettier --write`
  shows the exact changes.
