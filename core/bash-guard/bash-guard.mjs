#!/usr/bin/env node
// Dangerous-command guard hook (PreToolUse / Bash).
//
// Inspects the Bash command before it runs and denies destructive or
// secret-leaking commands with a typed reason (structured `permissionDecision:
// "deny"`), or routes destructive-but-sometimes-legitimate git commands to the
// user for confirmation (`"ask"`). A clean command passes silently (NOT an
// auto-approve — it falls through to the normal permission flow). Any internal
// error fails open so a bug in the guard never wedges the session.
//
// Add a rule == add one [regex, reason] entry to BLOCK_RULES (safety, deny),
// ASK_RULES (destructive git, ask), or STYLE_RULES (house-style nudges, deny).
// Scope: categories 1-5 block, category 6 (destructive git) asks. global-install
// (7) is still out of scope. Force-push / protected-branch policy lives in the
// separate git-guard module — keep that boundary.

import { readHookInput, denyPreToolUse, askPreToolUse, pass, failOpen } from "../../lib/hook-io.mjs";
import { lexSegments, skipWrappers } from "../../lib/shell-lex.mjs";
import { emitGuardDecision } from "../../lib/obs-client.mjs";

const basename = (tok) => tok.slice(tok.lastIndexOf("/") + 1);

// Shells whose `-c STRING` argument is itself a command line — recursed into,
// and `eval`, whose every argument may be. Beyond these one level of indirection
// the evasion game is unwinnable by design (see #30); this guard targets the
// agent's own mistakes, not a determined adversary.
const SHELL_CMDS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

// `rm -rf` and friends are too easy to evade with a single regex (-rf, -fr,
// -r -f, --recursive --force, reordered flags) — and, scanned as substrings,
// too easy to hallucinate out of unrelated fragments (#36: `git … rm` plus a
// `-F` flag plus a hyphenated path combined into a phantom `rm -rf`). So the
// check is argv-based on one lexed segment:
//   - a segment whose real command is `git` is skipped entirely — `git rm` is
//     an index-level delete (recoverable), and git deletion policy is
//     git-guard's domain, not this rule's;
//   - otherwise the recursive AND force intents are read only from option
//     tokens AFTER an actual `rm` word (`--` ends option parsing), so quoted
//     message text and path fragments can never contribute a flag.
function dangerousRm(tokens) {
  const start = skipWrappers(tokens);
  if (start >= tokens.length) return false;
  const cmd = basename(tokens[start]);
  if (cmd === "git") return false;
  if (cmd === "eval") {
    if (tokens.slice(start + 1).some((t) => dangerousRmCommand(t))) return true;
  } else if (SHELL_CMDS.has(cmd)) {
    const ci = tokens.findIndex((t, i) => i > start && /^-[a-z]*c$/.test(t)); // -c, -lc, -euc …
    if (ci >= 0 && tokens[ci + 1] && dangerousRmCommand(tokens[ci + 1])) return true;
  }
  const rm = tokens.findIndex((t, i) => i >= start && basename(t.toLowerCase()) === "rm");
  if (rm < 0) return false;
  let recursive = false;
  let force = false;
  for (let i = rm + 1; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (t === "--") break; // operands only from here on
    if (t === "--recursive") recursive = true;
    else if (t === "--force") force = true;
    else if (/^-[a-z]+$/.test(t)) {
      if (t.includes("r")) recursive = true;
      if (t.includes("f")) force = true;
    }
  }
  return recursive && force;
}

// A whole command line (e.g. the string handed to `bash -c`) is dangerous when
// any of its lexed segments is.
function dangerousRmCommand(command) {
  return lexSegments(command).some(dangerousRm);
}

// [regex (case-insensitive), reason]. Categories 1-5 from the module README.
const BLOCK_RULES = [
  // 1. file / disk destruction
  [/rm\s+-[a-z]*\s*\/(\s|$)/i, "루트('/') 삭제 거부. 대상을 좁혀라."],
  [/rm\s+-[a-z]*\s*~(\/|\s|$)/i, "홈 디렉토리 통삭제 거부."],
  [/>\s*\/dev\/sd[a-z]/i, "디스크 장치에 직접 쓰기 거부."],
  [/\bdd\b.*\bof=\/dev\//i, "dd로 디스크 덮어쓰기 거부."],
  [/\bmkfs(\.\w+)?\b/i, "파일시스템 포맷 거부."],
  [/\bshred\b/i, "복구 불가능한 shred 삭제 거부."],
  [/:\s*\(\s*\)\s*\{.*\|\s*:\s*&\s*\}\s*;\s*:/i, "fork bomb 거부."],
  // 2. permission / ownership
  [/chmod\s+(-[a-z]*\s+)*0?777\b/i, "chmod 777 거부 — 권한을 좁혀라."],
  [/chmod\s+-[a-z]*r[a-z]*\s+.*\s\/(\s|$)/i, "루트 재귀 chmod 거부."],
  [/chown\s+-[a-z]*r[a-z]*\s+.*\s\/(\s|$)/i, "루트 재귀 chown 거부."],
  // 3. remote code execution (download -> shell)
  [/\b(curl|wget)\b.*\|\s*(sudo\s+)?(ba)?sh\b/i, "다운로드한 스크립트를 셸로 파이프하는 실행 거부."],
  [/\bcurl\b.*\|\s*sudo\b/i, "다운로드 후 sudo 실행 거부."],
  [/\b(eval|exec)\b.*\$\(\s*curl\b/i, "eval/exec $(curl ...) 거부."],
  // 4. system control / power
  [/\b(shutdown|poweroff|halt|reboot)\b/i, "전원 차단/재부팅 명령 거부."],
  [/\bsystemctl\s+(stop|disable|mask)\b/i, "systemctl 서비스 중단 거부."],
  [/\bkill(all)?\s+-9\s+-1\b/i, "전체 프로세스 강제 종료(kill -9 -1) 거부."],
  // 5. credential / secret exfiltration
  [/\b(cat|less|head|tail)\b[^|]*\.env(\.\w+)?(\s|$)/i, ".env 파일 노출 거부."],
  [/\b(cat|less|head|tail)\b[^|]*(\.ssh\/|\bid_rsa\b|\bid_ed25519\b|\.pem\b)/i, "SSH 개인키 노출 거부."],
  [/\b(cat|less|head|tail)\b[^|]*\.aws\/credentials/i, "AWS 자격증명 노출 거부."],
  [/\benv\b\s*\|\s*(curl|nc)\b/i, "환경변수 외부 전송 거부."],
  [/\bgit\b[^|]*\|\s*curl\b/i, "git 데이터 외부 전송 거부."],
];

// Style nudges, not safety blocks. Same deny mechanism — Claude reads the reason
// and re-runs with the suggested tool. Anchored to the START of a segment so
// `git grep`, `pgrep`/`egrep`, `ripgrep`, and "grep" inside a filename don't
// trigger (the per-segment scan still catches `... | grep x`). Several nudge
// toward the harness's own built-in tools (Read/Edit) instead of a shell command.
// External-tool nudges require that tool on PATH (rg, fd, nc); if it is absent
// Claude has no alternative, so drop that rule rather than wedge it. See
// style-nudge-candidates.md for the full analysis behind this set.
const STYLE_RULES = [
  // search -> ripgrep / fd  (faster, .gitignore-aware)
  [/^\s*grep\b/i, "'grep' 대신 'rg'(ripgrep)를 써라 — 빠르고 .gitignore를 인식한다."],
  // find … -exec grep / find … | xargs grep -> rg  (one recursive, gitignore-aware
  // search instead of spawning grep per file). MUST come before the find->fd rule
  // so it wins on the whole command (find->fd would otherwise fire on the find
  // part before the pipe). Skipped when find uses metadata predicates rg can't
  // replicate (-mtime/-size/-perm/-newer/…), which are left to find.
  [/^\s*find\b(?![^|]*\s-(?:(?:a|c)?newer|[acm]time|[acm]min|size|perm|user|group|uid|gid|inum|links|empty)\b)[^|]*(?:-exec\s+[ef]?grep\b|\|\s*xargs(?:\s+-\S+)*\s+[ef]?grep\b)/i,
    "'find … -exec grep' / 'find … | xargs grep' 대신 'rg <패턴>'(필요시 -g '*.ext')를 써라 — 한 번에 재귀 검색하고 .gitignore를 인식하며 file:line:match로 출력한다."],
  // find -> fd, except for predicates fd can't cleanly replace (left to find).
  [/^\s*find\b(?![^|]*\s-(?:exec|ok|delete|newer|[acm]time|[acm]min|size|perm|inum|links|user|group|uid|gid|i?regex)\b)/i,
    "find 대신 fd를 써라 — 문법이 간결하고 .gitignore를 인식하며 빠르다. 이름검색 fd PATTERN, 확장자 fd -e js, 타입 fd -t f, 숨김포함 fd -H."],
  // in-place sed -> Edit tool  (reviewable diff, tracked)
  [/^\s*sed\s+(?:-[a-z]*i|--in-place)/i,
    "sed -i 인플레이스 치환 대신 Edit 도구를 써라 — 변경이 diff로 보여 리뷰 가능하고 하네스가 파일을 추적한다. 다중 파일 스트림 치환이 꼭 필요하면 sd."],
  // telnet -> nc -z  (telnet hangs waiting for input in a non-TTY shell)
  [/^\s*telnet\b/i,
    "telnet은 대화형이라 비-TTY 셸에서 멈춘다. 포트 점검은 nc -z -w3 HOST PORT (종료코드 0=열림/1=닫힘), 상세는 nc -vz."],
  // interactive monitors -> batch snapshot  (htop/top hang or spew control chars)
  [/^\s*(?:[hbga]top\b|top\b(?![^|;&]*\s-b))/i,
    "대화형 모니터(htop/top)는 TTY 없는 Bash에서 멈추거나 제어문자만 쏟아낸다. 스냅샷은 top -b -n1, CPU 상위는 ps aux --sort=-%cpu | head."],
  // cd X && CMD -> tool path arg  (cwd resets between calls; can prompt for permission)
  // `[^&|;\n]` stops at a newline so an unrelated `cd` on one line and `&&` on
  // the next (a multi-line script) don't get matched as a single `cd … &&`.
  [/^\s*cd\s+[^&|;\n]+&&/i,
    "'cd X && 명령' 대신 도구 경로인자를 써라 — rg PATH · git -C DIR · make -C DIR · ls DIR, 또는 절대경로. 에이전트는 호출 사이 cwd가 리셋되고 cd가 작업폴더 밖이면 권한 프롬프트를 유발한다. 상대경로 스크립트가 꼭 필요하면 서브셸 '(cd X && ./script)'로 감싸라."],
];

// File-viewing nudge — checked against the WHOLE command only (not split
// segments). cat/head/tail viewing a FILE -> Read; but `... | tail -3`
// (truncating a pipe's output) is stream processing, not file viewing, and
// Read can't replace it. The `(?!.*[<>|])` lookahead suppresses any piped /
// redirected / heredoc usage, and `(?!.*\s--?[fF])` leaves `tail -f`/`-F`
// alone — but both only work when matched against the FULL command, because a
// per-segment scan would strip the pipe and wrongly fire on `tail -3`.
const FILE_VIEW_RULE = [
  /^\s*(?:cat|head|tail)(?=\s)(?!.*[<>|])(?!.*\s--?[fF])\s+\S/i,
  "파일 보기는 cat/head/tail 대신 Read 도구를 써라 — 줄번호와 offset/limit 페이지네이션을 주고 이미지/PDF/노트북도 읽으며, 하네스가 파일 상태를 추적한다.",
];

// Category 6 — destructive-but-sometimes-legitimate git commands. These ASK the
// user to confirm (permissionDecision "ask") rather than hard-deny, since they
// are occasionally exactly what you want. Force-push and protected-branch policy
// deliberately live in the separate git-guard module, not here.
// [regex (case-insensitive), reason]
const ASK_RULES = [
  // git reset --hard  (also `reset HEAD~1 --hard`)
  [/\bgit\s+reset\b[^|]*\s--hard\b/i,
    "git reset --hard는 커밋 안 된 변경을 되돌릴 수 없게 버린다. 보존하려면 먼저 git stash를 써라."],
  // git clean -f / -fd / --force  (clean -n dry-run is left alone)
  [/\bgit\s+clean\b[^|]*\s(?:-[a-z]*f|--force)/i,
    "git clean -f는 untracked 파일을 영구 삭제한다. 먼저 git clean -n으로 무엇이 지워지는지 확인하라."],
  // git checkout . / checkout -- . / restore .  (discard ALL working-tree changes)
  [/\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.\s*$/i,
    "git checkout/restore .는 워킹트리의 모든 변경을 폐기한다. 일부만 되돌리려면 경로를 지정하라."],
];

// Split a compound command into segments so `echo x && rm -rf /` can't smuggle
// a banned command past a clean-looking prefix. We check BOTH the whole command
// (so pipe-based rules like `curl | sh` keep their context) AND each segment
// (so a smuggled `rm -rf` is caught even when split off a clean prefix).
// Conservative split on the shell operators ; && || | and newlines.
function splitCommands(cmd) {
  return cmd
    .split(/(?:&&|\|\||[;\n|])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

try {
  const input = await readHookInput();
  if (input?.tool_name !== "Bash") pass(); // not our concern

  const command = input?.tool_input?.command;
  if (!command || !command.trim()) pass();

  // Emit a GuardDecision (best-effort, never blocks) then decide. The emit
  // failing/hanging/absent can NEVER change the outcome — the deny/ask always
  // runs after. `allow`/pass is never emitted (design §6: volume/noise).
  const deny = async (rule, reason) => {
    await emitGuardDecision(input, { guard: "bash-guard", rule, decision: "deny", reason });
    denyPreToolUse(reason);
  };
  const ask = async (rule, reason) => {
    await emitGuardDecision(input, { guard: "bash-guard", rule, decision: "ask", reason });
    askPreToolUse(reason);
  };

  // Whole command first (keeps pipes intact), then each segment.
  const targets = [command, ...splitCommands(command)];

  // 1. Safety blocks — these take precedence over nudges, so `cat .env` is
  //    denied as a secret leak before the file-view nudge. The rm scan is
  //    argv-based per lexed segment, NEVER on the whole string (#36): fragments
  //    from different segments must not combine, while the per-segment scan
  //    still catches smuggling (`echo x && rm -rf ~`, `$( … )`, `bash -c`).
  if (dangerousRmCommand(command)) {
    await deny("dangerous-rm", "파괴적 'rm -rf' 거부. 대상을 좁히거나 trash CLI를 써라.");
  }
  for (const target of targets) {
    for (const [pattern, reason] of BLOCK_RULES) {
      if (pattern.test(target)) await deny("safety", reason);
    }
  }

  // 2. Destructive git (category 6) -> ask for confirmation. After hard blocks
  //    (so a genuine safety violation still wins) and before style nudges.
  for (const target of targets) {
    for (const [pattern, reason] of ASK_RULES) {
      if (pattern.test(target)) await ask("destructive-git", reason);
    }
  }

  // 3. Style nudges across every target (so `... | grep x` still fires).
  for (const target of targets) {
    for (const [pattern, reason] of STYLE_RULES) {
      if (pattern.test(target)) await deny("style-nudge", reason);
    }
  }

  // 4. File-viewing nudge — whole command only (see FILE_VIEW_RULE note).
  if (FILE_VIEW_RULE[0].test(command)) await deny("file-view", FILE_VIEW_RULE[1]);

  pass(); // clean — defer to the normal permission flow
} catch (err) {
  // Fail open: a guard bug must never wedge the session.
  failOpen(`[claude-hooks/bash-guard] internal error, skipping: ${err?.message ?? err}`);
}
