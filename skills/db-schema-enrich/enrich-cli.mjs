#!/usr/bin/env node
// db-schema-enrich CLI — the side-effecting wrapper around enrich.mjs.
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

import { readFile, writeFile } from "node:fs/promises";
import { applyEnrichment, promote } from "./enrich.mjs";

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
  const res = applyEnrichment(existing, proposal, { overwriteInferred: !args.keepInferred });

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
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (sub === "apply") await cmdApply(args);
  else if (sub === "promote") await cmdPromote(args);
  else throw new Error(`서브커맨드가 필요합니다: apply | promote (받음: ${sub ?? "없음"})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
