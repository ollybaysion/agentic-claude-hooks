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

## Rule references

- Markdown rules and which our bundle enables: [markdown-rules.md](markdown-rules.md)
- Shell (shellcheck) rule categories: [shellcheck-rules.md](shellcheck-rules.md)

## Requirements (install what you want enforced)

The hook dispatches by extension and **fails open on missing tools**, so
enabling a supported type is just installing its tool — there is no code change.
A tool listed in `LINTERS` but not on `PATH` is simply skipped; install it and
the same file type starts being enforced. Install only what you want.

The Node-based tools come from npm:

```bash
npm i -g markdownlint-cli2 prettier eslint
```

`shellcheck` ships as a dependency-free static binary, so it needs no package
manager or `sudo` — install it system-wide, or just drop the binary on your
`PATH`:

```bash
# Option A — package manager
sudo apt install shellcheck     # Debian/Ubuntu
brew install shellcheck         # macOS

# Option B — no sudo: static binary into ~/.local/bin (linux x86_64 / aarch64)
ver=$(curl -fsSL https://api.github.com/repos/koalaman/shellcheck/releases/latest | grep -m1 tag_name | cut -d'"' -f4)
curl -fsSL "https://github.com/koalaman/shellcheck/releases/download/${ver}/shellcheck-${ver}.linux.$(uname -m).tar.xz" | tar xJ
install -Dm755 "shellcheck-${ver}/shellcheck" ~/.local/bin/shellcheck
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
