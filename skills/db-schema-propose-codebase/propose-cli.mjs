#!/usr/bin/env node
// db-schema-propose-codebase CLI — deterministic helpers around the producer skill.
// Read-only: this CLI never writes a doc (writing is akg adopt's job).
//
//   lint --proposal <json>
//     Check a finished proposal.json against the contract shape. ERRORs are
//     contract violations (unknown keys, wrong types); WARNs are hygiene
//     (evidence missing — akg refuses those slots).
//
//   akg-slots --proposal <json>
//     Lint, then translate the proposal into akg slot-address form and print
//     {"slots": {...}} to STDOUT — the file shape `akg propose` reads
//     (issue #125). Anything that could not be translated goes to STDERR, so
//     stdout stays pipeable. Lint ERRORs refuse the translation.
//
// Doc-side cross-checks (no-such-column, frozen slot) are akg's — the server
// validates slot addresses against the target document at submit time.
//
// Exit: 0 ok (warnings allowed), 1 fatal/usage or lint errors.

import { readFile } from "node:fs/promises";
import { lintProposal, toAkgSlots } from "./propose.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--proposal") args.proposal = argv[++i];
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  return args;
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!args.proposal) throw new Error(`${sub ?? "?"}: --proposal <json> 이 필요합니다`);
  const proposal = JSON.parse(await readFile(args.proposal, "utf8"));

  if (sub === "lint") {
    const res = lintProposal(proposal);
    for (const e of res.errors) console.log(`ERROR: ${e}`);
    for (const w of res.warnings) console.log(`WARN:  ${w}`);
    console.error(`[lint] errors=${res.errors.length} warnings=${res.warnings.length}`);
    if (!res.ok) process.exitCode = 1;
  } else if (sub === "akg-slots") {
    const res = lintProposal(proposal);
    for (const e of res.errors) console.error(`ERROR: ${e}`);
    if (!res.ok) {
      console.error("[akg-slots] lint ERROR 가 있어 변환하지 않습니다 — 고치고 다시 실행하세요");
      process.exitCode = 1;
      return;
    }
    const { slots, unmapped } = toAkgSlots(proposal);
    for (const u of unmapped) console.error(`UNMAPPED: ${u.key} — ${u.reason}`);
    console.error(`[akg-slots] slots=${Object.keys(slots).length} unmapped=${unmapped.length}`);
    if (!Object.keys(slots).length) {
      console.error("변환된 슬롯이 없습니다 — akg propose 는 빈 slots 를 거부합니다");
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ slots }, null, 2));
  } else {
    throw new Error(`서브커맨드가 필요합니다: lint | akg-slots (받음: ${sub ?? "없음"})`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
