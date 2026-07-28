// claude-hooks → opencode adapter (#74).
//
// One opencode plugin that gives an opencode session the two things claude-hooks
// gives a Claude Code session:
//   1. GUARDS — bash-guard + git-guard, blocking destructive commands
//      (`rm -rf`, disk/format, curl|sh, secret reads) and protected-branch /
//      force-push / PR-merge attempts, via `throw` in `tool.execute.before`
//      (opencode's equivalent of CC's PreToolUse deny).
//   2. OBSERVATION — every prompt / tool call / session lifecycle event POSTed
//      to the local collector, so opencode sessions show up in the same
//      dashboard as the Claude Code ones (tagged `runtime: "opencode"`).
//
// The RULES are not duplicated here. This file imports the runtime-neutral
// decision cores (core/bash-guard/decide.mjs, core/git-guard/decide.mjs) that
// the Claude Code hooks also use — so a rule fixed in one place is fixed for
// both harnesses. This file is I/O only: opencode's hook shapes in, throw /
// envelope out.
//
// Fail-open discipline (same as the CC hooks): every hook body swallows its own
// errors. The ONLY exception that ever escapes is the deliberate guard block.
// A bug here must never wedge an opencode session.
//
// Install: see docs/opencode.md, or run `node adapters/opencode/install.mjs`.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { decideBash } from "../../core/bash-guard/decide.mjs";
import { decideGit } from "../../core/git-guard/decide.mjs";
import { postEnvelope, sourceApp } from "../../lib/obs-client.mjs";
import { dataDir } from "../../lib/obs-paths.mjs";

const RUNTIME = "opencode";

// ── switches (env, all optional) ────────────────────────────────────────────
//   CLAUDE_HOOKS_OC_GUARD=off     no blocking at all (observation only)
//   CLAUDE_HOOKS_OC_NUDGES=off    safety blocks only — drop the house-style
//                                 nudges (grep→rg, find→fd, cat→read, …)
//   CLAUDE_HOOKS_OC_ASK=allow     let the "ask" class (git reset --hard,
//                                 clean -f, checkout .) through instead of
//                                 blocking it — opencode has no ask channel in
//                                 tool.execute.before, so the default is block
//   CLAUDE_HOOKS_OC_OBSERVE=off   no events sent to the collector
//   CLAUDE_HOOKS_OC_AUTOSTART=off never spawn the collector
//   CLAUDE_HOOKS_NODE=/path/node  node binary used to spawn the collector
//   CLAUDE_HOOKS_OC_DEBUG=1       print internal errors to stderr
const off = (name) => String(process.env[name] ?? "").toLowerCase() === "off";
const GUARD_ON = !off("CLAUDE_HOOKS_OC_GUARD");
const STYLE_NUDGES = !off("CLAUDE_HOOKS_OC_NUDGES");
const BLOCK_ASK = String(process.env.CLAUDE_HOOKS_OC_ASK ?? "").toLowerCase() !== "allow";
const OBSERVE = !off("CLAUDE_HOOKS_OC_OBSERVE");
const AUTOSTART = !off("CLAUDE_HOOKS_OC_AUTOSTART");
const DEBUG = !!process.env.CLAUDE_HOOKS_OC_DEBUG;

const debug = (where, err) => {
  if (DEBUG) try { process.stderr.write(`[claude-hooks/opencode] ${where}: ${err?.message ?? err}\n`); } catch {}
};

// ── opencode tool ids → guard input ─────────────────────────────────────────
// opencode's built-ins are lower-case (`bash`, `edit`, `write`, `patch`).
// Matched case-insensitively so a renamed/aliased tool still lands right.
const BASH_TOOLS = new Set(["bash", "shell"]);
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"]);

const commandOf = (args) => args?.command ?? args?.cmd ?? null;
const filePathOf = (args) => args?.filePath ?? args?.file_path ?? args?.path ?? null;

// ── collector plumbing ──────────────────────────────────────────────────────
const OBS_HOST = process.env.OBS_HOST || "127.0.0.1";
const OBS_PORT = Number.isInteger(Number(process.env.OBS_PORT)) && Number(process.env.OBS_PORT) > 0
  ? Number(process.env.OBS_PORT) : 4090;
const SERVER = fileURLToPath(new URL("../../core/observability/server.mjs", import.meta.url));
const PAYLOAD_MAX = 32 * 1024; // per-event payload cap (the collector takes 5 MiB, but noise is noise)
const TEXT_MAX = 4000;         // per-string cap for prompts / tool output

const clip = (s, n = TEXT_MAX) =>
  typeof s === "string" && s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s;

// Drop a payload that got out of hand rather than shipping megabytes per call.
function boundPayload(payload) {
  try {
    if (JSON.stringify(payload).length <= PAYLOAD_MAX) return payload;
  } catch { /* circular / unserializable → fall through */ }
  return { truncated: true, runtime: RUNTIME };
}

/**
 * Fire-and-forget one envelope at the collector. Never awaited on the hot path,
 * never throws, never writes to stdout — a down collector costs ~7ms of a
 * background promise (loopback ECONNREFUSED) and changes nothing.
 */
function emit(type, { cwd, sessionID, tool, callID, error, payload }) {
  if (!OBSERVE) return Promise.resolve();
  try {
    const env = {
      source_app: sourceApp({ cwd }),
      session_id: typeof sessionID === "string" && sessionID ? sessionID : "unknown",
      hook_event_type: type,
      runtime: RUNTIME, // the collector promotes this to its own column (schema v8)
      payload: boundPayload({ ...(payload ?? {}), runtime: RUNTIME, cwd }),
      timestamp: Date.now(),
    };
    if (tool) env.tool_name = tool;
    if (callID) env.tool_use_id = callID;
    if (error) env.error = typeof error === "string" ? clip(error) : clip(JSON.stringify(error));
    return postEnvelope(env, { timeoutMs: 2000 }).catch(() => {});
  } catch (err) {
    debug("emit", err);
    return Promise.resolve();
  }
}

// A session's first event doubles as its SessionStart, so the dashboard always
// has a session row (and a runtime tag) even when the plugin loads mid-session
// or the bus event shape changes under us. Bounded so a long-lived opencode
// process can't grow the set without limit.
const started = new Set();
function touchSession(sessionID, cwd, extra) {
  if (!OBSERVE || !sessionID || started.has(sessionID)) return;
  if (started.size > 500) started.clear();
  started.add(sessionID);
  emit("SessionStart", { cwd, sessionID, payload: { source: "startup", ...extra } });
}

function portOpen(host, port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false)); // ECONNREFUSED → not running
  });
}

// obs-lazy-start's job, done from inside opencode: if the collector isn't up,
// spawn it detached so it outlives this session. Deliberately spawns NODE, not
// process.execPath — inside opencode that is the Bun binary, and the collector
// wants node's sqlite. Any failure is silent: observation is best-effort.
async function lazyStartCollector() {
  if (!OBSERVE || !AUTOSTART) return;
  try {
    if (await portOpen(OBS_HOST, OBS_PORT)) return;
    const dir = dataDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const logFd = fs.openSync(path.join(dir, "server.log"), "a", 0o600);
    const child = spawn(
      process.env.CLAUDE_HOOKS_NODE || "node",
      ["--disable-warning=ExperimentalWarning", SERVER],
      { detached: true, stdio: ["ignore", logFd, logFd] }
    );
    child.on("error", (err) => debug("collector spawn", err)); // node not on PATH → ignore
    child.unref();
    try { fs.closeSync(logFd); } catch {}
  } catch (err) {
    debug("lazyStart", err);
  }
}

// ── the guard verdict, for one tool call ────────────────────────────────────
// Returns { action, rule, reason, guard } or null. Pure routing: which decide
// core owns this tool, and what did it say. bash-guard runs first (it owns the
// catastrophic deletes), then git-guard (branch policy).
function verdictFor(tool, args, cwd) {
  const id = String(tool ?? "").toLowerCase();
  if (BASH_TOOLS.has(id)) {
    const command = commandOf(args);
    if (typeof command !== "string" || !command.trim()) return null;
    const bash = decideBash(command, { styleNudges: STYLE_NUDGES });
    if (bash) return { ...bash, guard: "bash-guard" };
    const git = decideGit({ kind: "bash", command, cwd });
    if (git) return { ...git, guard: "git-guard" };
    return null;
  }
  if (EDIT_TOOLS.has(id)) {
    const git = decideGit({ kind: "edit", filePath: filePathOf(args), cwd });
    if (git) return { ...git, guard: "git-guard" };
  }
  return null;
}

// ── repeat suppression ──────────────────────────────────────────────────────
// A blocked agent's favourite move is to run the SAME command again. The
// verdict never changes, so every retry is pure waste — and a model that reads
// "거부" without reading "왜" can burn a whole session on it. We count identical
// blocked attempts per session and escalate the wording: the first block
// explains, the second forbids the retry, the third hands the decision to the
// user. The count also rides along in the GuardDecision payload, so a session
// grinding on one command is visible in the dashboard instead of invisible.
const REPEAT_FORBID_AT = 2; // 2nd identical attempt: stop retrying
const REPEAT_ESCALATE_AT = 3; // 3rd+: go ask the human
const REPEAT_MAX_KEYS = 2000; // bound the map; a reset only forgives, never blocks

const denials = new Map(); // "session\0tool\0target" -> attempt count

// What counts as "the same attempt": the command with whitespace collapsed (so
// re-indentation or a line break isn't a new command), or the target file path.
function repeatKey(sessionID, tool, args) {
  const target = commandOf(args) ?? filePathOf(args) ?? "";
  return `${sessionID ?? "?"} ${String(tool ?? "?").toLowerCase()} ${String(target).replace(/\s+/g, " ").trim()}`;
}

function countAttempt(sessionID, tool, args) {
  const key = repeatKey(sessionID, tool, args);
  const n = (denials.get(key) ?? 0) + 1;
  if (denials.size > REPEAT_MAX_KEYS) denials.clear();
  denials.set(key, n);
  return n;
}

// The message the agent sees in place of the tool result. An "ask" verdict has
// no ask channel here, so it becomes a block that names the human as the way
// forward (unless CLAUDE_HOOKS_OC_ASK=allow).
function blockMessage(v, repeat = 1) {
  const head = v.action === "ask"
    ? `[claude-hooks/${v.guard}] 사용자 확인이 필요한 명령이다. ${v.reason} ` +
      "정말 필요하면 사용자에게 실행을 요청해라."
    : `[claude-hooks/${v.guard}] ${v.reason}`;
  if (repeat >= REPEAT_ESCALATE_AT) {
    return `${head}\n\n이 명령은 이 세션에서 ${repeat}번 거부됐다. 판정은 재시도해도 바뀌지 않는다. ` +
      "지금 즉시 재시도를 멈추고, 무엇을 하려 했는지와 왜 막혔는지를 사용자에게 설명한 뒤 지시를 받아라.";
  }
  if (repeat >= REPEAT_FORBID_AT) {
    return `${head}\n\n같은 명령을 이미 시도했다(${repeat}회). 같은 명령을 다시 실행하지 마라 — ` +
      "인자만 바꿔 재시도하는 것도 안 된다. 목적을 이루는 다른 방법을 찾거나 사용자에게 물어라.";
  }
  return head;
}

// opencode bus event → the collector's CC-shaped event type. Session lifecycle
// only: the message.* / file.* streams duplicate what the tool hooks already
// report, so forwarding them would only inflate the event table.
const EVENT_MAP = {
  "session.created": "SessionStart", // handled by touchSession (emitted once)
  "session.idle": "Stop",
  "session.compacted": "PreCompact",
  "session.deleted": "SessionEnd",
  "session.error": "Notification",
};

// ── the plugin ──────────────────────────────────────────────────────────────
// opencode calls this once at startup and keeps the returned hooks for the
// process lifetime. Exactly ONE export: opencode registers every exported
// plugin function, so a second alias would double every guard and every event.
export const ClaudeHooksGuard = async ({ directory, worktree, project } = {}) => {
  // Tools run at the project root; `worktree` is the git anchor when opencode
  // was started inside one. Either way this is what the branch rules judge.
  const cwd = worktree || directory || process.cwd();
  const projectName = project?.id ?? project?.name ?? undefined;

  lazyStartCollector(); // not awaited — startup must not wait on a spawn

  return {
    // Guard + observe, before the tool runs. This is opencode's PreToolUse.
    "tool.execute.before": async (input, output) => {
      let verdict = null;
      let repeat = 1;
      try {
        const { tool, sessionID, callID } = input ?? {};
        const args = output?.args;
        touchSession(sessionID, cwd, { project: projectName });
        emit("PreToolUse", {
          cwd, sessionID, tool, callID,
          payload: { tool_name: tool, tool_input: args },
        });
        if (!GUARD_ON) return;
        verdict = verdictFor(tool, args, cwd);
        if (!verdict) return;
        if (verdict.action === "ask" && !BLOCK_ASK) return;
        repeat = countAttempt(sessionID, tool, args); // Nth identical blocked attempt
        // Record the block the same way the CC guards do, so it lands in the
        // dashboard's Guards rollup and correlates with the orphaned Pre by
        // tool_use_id (#99). Awaited — but bounded at 2s and never fatal.
        await emit("GuardDecision", {
          cwd, sessionID, tool, callID,
          payload: {
            guard: verdict.guard, rule: verdict.rule, decision: verdict.action,
            reason: verdict.reason, tool_name: tool, tool_use_id: callID,
            repeat, // 1 = first block; >1 = the agent is retrying a settled refusal
            command: commandOf(args) ?? undefined,
            file_path: commandOf(args) ? undefined : (filePathOf(args) ?? undefined),
          },
        });
      } catch (err) {
        debug("tool.execute.before", err);
        return; // internal error → fail OPEN, exactly like the CC hooks
      }
      // The one deliberate escape: throwing here is how opencode blocks a call.
      if (verdict) throw new Error(blockMessage(verdict, repeat));
    },

    // Observe the result. opencode's PostToolUse — pairs with the Pre above by
    // callID, which is what gives the dashboard tool durations and orphan counts.
    "tool.execute.after": async (input, output) => {
      try {
        const { tool, sessionID, callID } = input ?? {};
        emit("PostToolUse", {
          cwd, sessionID, tool, callID,
          payload: {
            tool_name: tool,
            tool_response: { title: output?.title, output: clip(output?.output) },
          },
        });
      } catch (err) { debug("tool.execute.after", err); }
    },

    // A user prompt — the turn boundary the dashboard counts (UserPromptSubmit).
    "chat.message": async (input, output) => {
      try {
        const sessionID = input?.sessionID ?? output?.message?.sessionID;
        touchSession(sessionID, cwd, { project: projectName });
        const text = (output?.parts ?? [])
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text).join("\n");
        emit("UserPromptSubmit", {
          cwd, sessionID,
          payload: {
            prompt: clip(text),
            agent: input?.agent,
            model: input?.model?.modelID ?? output?.message?.modelID,
          },
        });
      } catch (err) { debug("chat.message", err); }
    },

    // Second line of defence: if opencode routes a call through its permission
    // system, answer with the same verdict instead of whatever the config says.
    // Purely additive — untouched status means "we have no opinion".
    "permission.ask": async (input, output) => {
      try {
        if (!GUARD_ON || !output) return;
        const args = input?.metadata ?? input?.args ?? input;
        const tool = input?.type ?? input?.tool ?? (commandOf(args) ? "bash" : null);
        const verdict = verdictFor(tool, args, cwd);
        if (!verdict) return;
        output.status = verdict.action === "ask" ? "ask" : "deny";
      } catch (err) { debug("permission.ask", err); }
    },

    // Session lifecycle off the event bus. Only the few types the dashboard
    // understands are mapped; everything else is ignored (noise).
    event: async ({ event } = {}) => {
      try {
        const type = event?.type;
        const mapped = EVENT_MAP[type];
        if (!mapped) return;
        const props = event?.properties ?? {};
        const sessionID = props.sessionID ?? props.sessionId ?? props.info?.id ?? props.session?.id;
        if (!sessionID) return;
        if (type === "session.created") { touchSession(sessionID, cwd, { project: projectName }); return; }
        touchSession(sessionID, cwd, { project: projectName });
        emit(mapped, {
          cwd, sessionID,
          error: props.error ?? undefined,
          payload: { opencode_event: type, properties: props },
        });
      } catch (err) { debug("event", err); }
    },
  };
};
