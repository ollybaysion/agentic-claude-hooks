#!/usr/bin/env node
// db-schema-propose-codebase CLI — deterministic helpers around the producer skill.
// Read-only: this CLI never writes a doc (writing is db-schema-apply's job).
//
//   slots --doc <path>
//     Inventory the doc's meaning slots (JSON to stdout): which are fillable
//     (scaffold/empty/inferred) and which are frozen (confirmed). The agent
//     uses this as its work-list before reading the codebase.
//
//   lint --doc <path> --proposal <json>
//     Check a finished proposal.json against the contract shape and the doc.
//     ERRORs are contract violations or entries apply would silently drop
//     (unknown keys, no-such-column); WARNs are visible skips / hygiene.
//
// Exit: 0 ok (warnings allowed), 1 fatal/usage or lint errors.

import { readFile } from "node:fs/promises";
import { listSlots, lintProposal } from "./propose.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--doc") args.doc = argv[++i];
    else if (a === "--proposal") args.proposal = argv[++i];
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  return args;
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!args.doc) throw new Error(`${sub ?? "?"}: --doc <path> 가 필요합니다`);
  const content = await readFile(args.doc, "utf8");

  if (sub === "slots") {
    console.log(JSON.stringify(listSlots(content), null, 2));
  } else if (sub === "lint") {
    if (!args.proposal) throw new Error("lint: --proposal <json> 이 필요합니다");
    const proposal = JSON.parse(await readFile(args.proposal, "utf8"));
    const res = lintProposal(content, proposal);
    for (const e of res.errors) console.log(`ERROR: ${e}`);
    for (const w of res.warnings) console.log(`WARN:  ${w}`);
    console.error(`[lint] errors=${res.errors.length} warnings=${res.warnings.length}`);
    if (!res.ok) process.exitCode = 1;
  } else {
    throw new Error(`서브커맨드가 필요합니다: slots | lint (받음: ${sub ?? "없음"})`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
