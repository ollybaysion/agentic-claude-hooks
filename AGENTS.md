# Adding a hook to claude-hooks

Read this before adding a new hook module. The plugin is a collection of
independent hooks; adding one must not change any existing module.

## The contract (4 steps)

1. **Create a self-contained module** at `core/<name>/`:

   ```
   core/<name>/
   ├── <name>.mjs        # hook logic (Node ESM)
   ├── config/...        # optional: bundled config, applied explicitly
   └── README.md         # what it does, event, requirement, behaviour
   ```

2. **Write the logic in `<name>.mjs`** using the shared helpers — do not
   re-implement stdin parsing or exit-code handling:

   ```js
   import { readHookInput, toolFilePath, blockWithFeedback, pass, failOpen }
     from "../../lib/hook-io.mjs";

   const input = await readHookInput();
   // ...decide, then call exactly one of: pass() / blockWithFeedback(msg) / failOpen(note)
   ```

   Reference bundled files relative to the script (`import.meta.url` +
   `node:path`), never via absolute or project paths. `${CLAUDE_PLUGIN_ROOT}`
   is only for the `command` string in `hooks.json` (and it changes on every
   plugin update — never persist state under it).

3. **Wire it into `hooks/hooks.json`** — add one entry under the right event,
   grouped with any existing matcher for that event:

   ```jsonc
   { "type": "command",
     "command": "node \"${CLAUDE_PLUGIN_ROOT}/core/<name>/<name>.mjs\"",
     "timeout": 60 }
   ```

4. **Document it**: write `core/<name>/README.md`, and add a row to the
   Modules table in the top-level `README.md`.

## Rules every module must follow

- **Pick the event by what you need** (see `claude-hooks-syntax.md`):
  - *truly block before it happens* → **PreToolUse** (`exit 2`, or
    `hookSpecificOutput.permissionDecision: "deny"`).
  - *check the result / correction loop after the fact* → **PostToolUse**
    (`exit 2` + stderr instruction; the file is already written).
  - Note `decision:"block"` means opposite things per event — prefer the
    documented mechanism for your event, not a copied snippet.
- **Exit-code discipline:** only `exit 2` blocks. Any other non-zero "fails
  open" (non-blocking). Wrap risky logic so infra errors (missing tool,
  parse failure) end in `failOpen()` / `pass()`, never an unhandled throw that
  exits 1 and is silently ignored.
- **Never mix `exit 2` with stdout JSON** — on `exit 2`, stdout is discarded.
- **Scope tightly:** filter on `tool_name` / file path early and `pass()` for
  anything outside your module's concern. PostToolUse runs on *every* edit, so
  keep it fast (no full test suites / type-checks inline; push heavy work to
  `Stop` or CI).
- **Fail open on missing external tools** so a partial install never breaks a
  session; document the tool as a requirement in your README.

## Test locally before wiring

Drive the script directly with a synthetic event on stdin:

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"/path/to/test.md"}}' \
  | node core/<name>/<name>.mjs ; echo "exit=$?"
```

Cover: applicable-and-clean (exit 0), applicable-and-violating (exit 2 +
message), not-applicable (exit 0), and missing-tool (exit 0). Then load the
whole plugin with `claude --plugin-dir .` and `/reload-plugins`.
