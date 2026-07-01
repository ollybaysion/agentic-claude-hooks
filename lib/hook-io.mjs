// Shared I/O helpers for claude-hooks command hooks.
// Hooks receive a JSON event on stdin and signal decisions via exit code + stderr.
// Exit-code contract (see claude-hooks-syntax.md):
//   exit 2          -> blocking; stderr is fed back to Claude (correction loop)
//   exit 0          -> pass; stdout (if any) is processed
//   any other non-0 -> "fail open" (non-blocking); stderr only lands in transcript
// IMPORTANT: never mix `exit 2` with stdout JSON — when exiting 2, stdout is ignored.

/** Read the full hook event from stdin and parse it as JSON. */
export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Path of the file a Write/Edit/MultiEdit tool acted on, or undefined. */
export function toolFilePath(input) {
  return input?.tool_input?.file_path;
}

/**
 * Block the current step and feed `message` back to Claude as a correction
 * instruction. The trailing imperative is load-bearing: without an explicit
 * "fix it" line, Claude tends to read the errors and move on.
 */
export function blockWithFeedback(message) {
  process.stderr.write(message.endsWith("\n") ? message : message + "\n");
  process.exit(2);
}

/** Pass silently (no findings, or not applicable to this hook). */
export function pass() {
  process.exit(0);
}

/**
 * PreToolUse-only structured denial: refuse the tool call before it runs and
 * hand Claude a typed reason. Emitted as stdout JSON with exit 0 — do NOT mix
 * with `exit 2` (when exiting 2, stdout is discarded). A silent `pass()` is the
 * opposite of this: it is NOT an auto-approve, it just defers to the normal
 * permission flow. `permissionDecision` must be exactly allow|deny|ask.
 */
export function denyPreToolUse(reason) {
  emitDecision("deny", reason);
}

/**
 * PreToolUse-only: route the tool call to the user for confirmation instead of
 * auto-allowing it. For destructive-but-sometimes-legitimate actions (e.g.
 * `git reset --hard`) where a hard `deny` would be too blunt. Note: unlike
 * `deny`, an `ask` does not survive bypass-permissions mode — it is a
 * confirmation gate, not a hard block. stdout JSON + exit 0.
 */
export function askPreToolUse(reason) {
  emitDecision("ask", reason);
}

/** Shared emitter for PreToolUse permission decisions (allow|deny|ask). */
function emitDecision(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

/**
 * Fail open: an infrastructure problem (missing tool, internal error) that
 * should NOT block the user. Note is recorded in the transcript only.
 */
export function failOpen(note) {
  if (note) process.stderr.write(note.endsWith("\n") ? note : note + "\n");
  process.exit(0);
}

/**
 * Inject text into Claude's context via the canonical nested schema (exit 0 +
 * stdout JSON). Used by context-provider hooks (SessionStart / UserPromptSubmit
 * and other additionalContext-capable events). NEVER use on a path that also
 * needs `exit 2` — on exit 2 stdout is discarded. Empty/whitespace text is a
 * silent `pass()` (nothing to inject). `event` must be the firing hook event
 * name (e.g. "SessionStart"), so the payload's hookEventName is correct.
 */
export function injectContext(event, text) {
  if (!text || !text.trim()) pass();
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: text,
      },
    })
  );
  process.exit(0);
}
