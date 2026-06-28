#!/usr/bin/env node
// Dangerous-command guard hook (PreToolUse / Bash).
//
// Inspects the Bash command before it runs and denies destructive or
// secret-leaking commands with a typed reason (structured `permissionDecision:
// "deny"`). A clean command passes silently (NOT an auto-approve — it falls
// through to the normal permission flow). Any internal error fails open so a
// bug in the guard never wedges the session.
//
// Add a rule == add one [regex, reason] entry to BLOCK_RULES below.
// Scope: blocks categories 1-5 (see README). git / global-install (6-7) are
// intentionally out of scope for now.

import { readHookInput, denyPreToolUse, pass, failOpen } from "../../lib/hook-io.mjs";

// `rm -rf` and friends are too easy to evade with a single regex (-rf, -fr,
// -r -f, --recursive --force, reordered flags). Detect the recursive AND force
// intents independently on a lowercased copy.
function dangerousRm(seg) {
  const c = seg.toLowerCase();
  if (!/\brm\b/.test(c)) return false;
  const recursive = /-[a-z]*r|--recursive/.test(c);
  const force = /-[a-z]*f|--force/.test(c);
  return recursive && force;
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

  // Full command first (keeps pipes intact), then each segment.
  const targets = [command, ...splitCommands(command)];
  for (const target of targets) {
    if (dangerousRm(target)) {
      denyPreToolUse("파괴적 'rm -rf' 거부. 대상을 좁히거나 trash CLI를 써라.");
    }
    for (const [pattern, reason] of BLOCK_RULES) {
      if (pattern.test(target)) denyPreToolUse(reason);
    }
  }

  pass(); // clean — defer to the normal permission flow
} catch (err) {
  // Fail open: a guard bug must never wedge the session.
  failOpen(`[claude-hooks/bash-guard] internal error, skipping: ${err?.message ?? err}`);
}
