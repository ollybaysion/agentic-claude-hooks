#!/usr/bin/env node
// db-schema-apply CLI — the side-effecting wrapper around apply.mjs.
//
// Two subcommands, both DRY-RUN by default (print the result, touch nothing);
// pass --write to persist. The skill shows the dry-run for approval first, and
// promote is a HUMAN action (never run by the agent on its own inference).
//
//   apply   --doc <path> --proposal <json> [--keep-inferred] [--write]
//     Fill meaning slots from a semantics proposal (agent's codebase analysis).
//     --keep-inferred: do not overwrite existing 추정) values (default: refresh).
//
//   promote --doc <path> [--all | --column NAME ... | --slot NAME ...] [--write]
//     Flip reviewed 추정) slots to confirmed (strip the 추정) prefix).
//
// Exit: 0 ok, 1 fatal/usage, 2 apply hit a confirmed slot it left untouched.

import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { applyProposal, promote } from "./apply.mjs";
import { postEnvelope, sourceApp } from "../../lib/obs-client.mjs";

// ── observability (#90) ──────────────────────────────────────────────────────
// On a real --write, tell the collector what changed so the dashboard's
// keyword-docs review surface can show the apply/promote activity log alongside
// the file-scanned 추정) queue. Pure builder (exposed for tests); emitSchemaDoc
// POSTs it. Fire-and-forget: awaited only so a short-lived CLI actually flushes
// the socket, but postEnvelope never throws and is timeout-bounded, so a
// slow/absent collector can't fail the CLI.
export function buildSchemaDocEnvelope(type, doc, extra) {
  return {
    source_app: sourceApp(),
    session_id: process.env.CLAUDE_SESSION_ID || "db-schema-apply",
    hook_event_type: type, // "SchemaDocApply" | "SchemaDocPromote"
    payload: { doc: basename(doc), path: doc, ...extra },
    timestamp: Date.now(),
  };
}
async function emitSchemaDoc(type, doc, extra) {
  try {
    await postEnvelope(buildSchemaDocEnvelope(type, doc, extra), { timeoutMs: 2000 });
  } catch {
    /* an emit bug must never change the apply/promote outcome */
  }
}

function parseArgs(argv) {
  const args = { write: false, columns: [], slots: [], all: false, keepInferred: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") args.write = true;
    else if (a === "--keep-inferred") args.keepInferred = true;
    else if (a === "--all") args.all = true;
    else if (a === "--doc") args.doc = argv[++i];
    else if (a === "--proposal") args.proposal = argv[++i];
    else if (a === "--column") args.columns.push(argv[++i]);
    else if (a === "--slot") args.slots.push(argv[++i]);
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  return args;
}

async function readText(path) {
  return readFile(path, "utf8");
}
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function persist(doc, markdown, write, tag) {
  if (write) {
    await writeFile(doc, markdown);
    console.error(`[${tag}] WROTE ${doc}`);
  } else {
    console.log(markdown);
    console.error(`[${tag}] DRY-RUN (--write 를 붙이면 기록)`);
  }
}

async function cmdApply(args) {
  if (!args.doc || !args.proposal) throw new Error("apply: --doc 와 --proposal 이 필요합니다");
  const existing = await readText(args.doc);
  const proposal = await readJson(args.proposal);
  const res = applyProposal(existing, proposal, { overwriteInferred: !args.keepInferred });

  if (res.status === "conflict") {
    console.error(res.reason);
    process.exitCode = 1;
    return;
  }
  console.error(
    `filled=${res.filled.length} (${res.filled.map((f) => f.slot).join(", ") || "-"}) ` +
      `skipped=${res.skipped.length} (${res.skipped.map((s) => `${s.slot}:${s.reason}`).join(", ") || "-"})`,
  );
  await persist(args.doc, res.markdown, args.write, "apply");
  if (args.write && res.filled.length) {
    await emitSchemaDoc("SchemaDocApply", args.doc, { filled: res.filled, skipped: res.skipped });
  }
  if (res.skipped.some((s) => s.reason === "confirmed")) process.exitCode = 2;
}

async function cmdPromote(args) {
  if (!args.doc) throw new Error("promote: --doc 이 필요합니다");
  if (!args.all && !args.columns.length && !args.slots.length) {
    throw new Error("promote: --all 또는 --column/--slot 중 하나가 필요합니다 (안전장치)");
  }
  const existing = await readText(args.doc);
  const target = args.all ? { all: true } : { columns: args.columns, slots: args.slots };
  const res = promote(existing, target);
  console.error(`promoted=${res.promoted.length} (${res.promoted.join(", ") || "-"})`);
  await persist(args.doc, res.markdown, args.write, "promote");
  if (args.write && res.promoted.length) {
    await emitSchemaDoc("SchemaDocPromote", args.doc, { promoted: res.promoted });
  }
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (sub === "apply") await cmdApply(args);
  else if (sub === "promote") await cmdPromote(args);
  else throw new Error(`서브커맨드가 필요합니다: apply | promote (받음: ${sub ?? "없음"})`);
}

// Run only when invoked directly (`node cli.mjs …`); stay importable so tests
// can exercise buildSchemaDocEnvelope without main() firing on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
