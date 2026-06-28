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
 * Fail open: an infrastructure problem (missing tool, internal error) that
 * should NOT block the user. Note is recorded in the transcript only.
 */
export function failOpen(note) {
  if (note) process.stderr.write(note.endsWith("\n") ? note : note + "\n");
  process.exit(0);
}
