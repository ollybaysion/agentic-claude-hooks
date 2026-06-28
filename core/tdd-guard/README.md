# tdd-guard (placeholder)

Reserved slot for the TDD-guard hook being developed in another session.

When ready, drop the module here so it stays self-contained:

```
core/tdd-guard/
├── tdd-guard.mjs        # hook logic
├── config/...           # any bundled config
└── README.md            # this file (replace with real docs)
```

Then wire it into the central `hooks/hooks.json`. A TDD guard typically blocks
*before* an edit lands, so it will most likely use **PreToolUse** (which can
truly deny via `permissionDecision: "deny"` or `exit 2`), e.g.:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/core/tdd-guard/tdd-guard.mjs\"" }
        ]
      }
    ]
  }
}
```

Shared stdin parsing / decision helpers live in `lib/hook-io.mjs` — reuse them
(note: PreToolUse blocking semantics differ from PostToolUse; see
`hook-io.mjs` comments and `claude-hooks-syntax.md`).
