# markdown-lint

PostToolUse hook that enforces a bundled Markdown rule set on every Markdown
file Claude writes or edits.

## How it works

- **Event / matcher:** `PostToolUse` on `Write|Edit|MultiEdit`.
- **Scope:** only files ending in `.md` / `.markdown`; everything else passes.
- **Behaviour:** block-and-feedback only (no auto-fix). On a violation the hook
  exits `2` and writes the findings plus a fix instruction to stderr, which
  Claude receives and acts on — a self-correction loop. The file is already
  written (PostToolUse cannot undo it), so Claude re-edits it until clean.
- **Rules:** `config/.markdownlint-cli2.jsonc`, applied via `--config` so it is
  independent of any config in the user's project.

## Requirement

`markdownlint-cli2` must be installed and on `PATH`:

```bash
npm i -g markdownlint-cli2
```

If it is missing the hook **fails open** (exits 0 with a note) so it never
breaks the session.

## Rule summary

| Rule | Setting | Why |
| --- | --- | --- |
| MD040 | on | code fences must declare a language |
| MD041 | on | first line is a top-level heading |
| MD003 | atx | headings use `#` |
| MD004 | dash | unordered lists use `-` |
| MD022 / MD031 / MD032 | on | blank lines around headings / code / lists |
| MD047 | on | single trailing newline |
| MD001 | on | heading levels increment by one |
| MD013 | off | line length is noise for generated docs |
| MD024 | siblings_only | duplicate headings allowed across sections |
| MD033 | br/details/summary | limited inline HTML allowed |
