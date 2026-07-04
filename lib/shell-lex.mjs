// Shared quote-aware shell lexer for the guard hooks (git-guard, bash-guard).
//
// Guards must match COMMAND STRUCTURE, not substrings: a rule may only fire
// when the suspect word is the actually-invoked command with the matching
// arguments — never because fragments merely co-occur somewhere in the string
// (a word in a commit message, a hyphen run inside a path). This lexer is the
// shared argv layer that #27 / #30 / #36 converged on; it was extracted from
// git-guard so bash-guard's dangerous-delete scan uses the same tokens.

// Command wrappers that precede the real command (`sudo git push …`). Skipped,
// along with leading `VAR=val` env assignments, before reading argv[0].
const WRAPPERS = new Set(["sudo", "command", "env", "nice", "nohup", "time"]);

// Split a shell command line into segments (chained by `; & && | || newline` and
// command substitution `$( … )` / backticks) and tokenize each into argv. A
// single quote-aware pass: operators and word boundaries are only honoured
// OUTSIDE quotes, and quoted spans stay inside their token — so a commit message
// like `-m "push to main; --force"` becomes ONE argument token and can never be
// read as command structure. Returns an array of token arrays (one per segment).
export function lexSegments(command) {
  const segments = [];
  let tokens = [];
  let cur = "";
  let started = false; // current token has content (guards empty-token flushes)
  let quote = null; // "'" or '"' while inside a quoted span

  const endTok = () => { if (started) { tokens.push(cur); cur = ""; started = false; } };
  const endSeg = () => { endTok(); if (tokens.length) { segments.push(tokens); tokens = []; } };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      started = true; // even an empty "" is a real (empty) token
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === "\\") { if (i + 1 < command.length) { cur += command[++i]; started = true; } continue; }
    if (ch === "$" && command[i + 1] === "(") { endSeg(); i++; continue; } // $( … )
    if (ch === "`" || ch === "(" || ch === ")") { endSeg(); continue; }    // subst / subshell
    if (ch === "&") { endSeg(); if (command[i + 1] === "&") i++; continue; }
    if (ch === "|") { endSeg(); if (command[i + 1] === "|") i++; continue; }
    if (ch === ";" || ch === "\n" || ch === "\r") { endSeg(); continue; }
    if (ch === " " || ch === "\t") { endTok(); continue; }
    cur += ch; started = true;
  }
  endSeg();
  return segments;
}

// Skip leading command wrappers (`sudo git …`) and `VAR=val` env assignments;
// return the index of the real argv[0].
export function skipWrappers(tokens) {
  let i = 0;
  while (i < tokens.length &&
    (WRAPPERS.has(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
  return i;
}
