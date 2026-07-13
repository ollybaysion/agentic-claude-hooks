#!/usr/bin/env node
// Offline regression tests for db-schema-apply.
// Run: node skills/db-schema-apply/test.mjs
//
// Pure — no DB, no codebase, no MCP. The agent's codebase analysis is upstream
// and produces the "semantics proposal" object these tests feed in directly;
// what's tested here is the deterministic substrate: filling meaning slots with
// confidence tiers, freezing confirmed content, and promotion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDoc } from "../db-schema-docs/render.mjs";
import {
  applyProposal,
  promote,
  editSlot,
  slotState,
  formatEvidence,
  INFERRED_PREFIX,
} from "./apply.mjs";
import { buildSchemaDocEnvelope } from "./cli.mjs";

// A freshly generated db-schema doc: structure filled, meaning slots scaffolded.
function freshDoc() {
  return renderDoc({
    owner: "ERP",
    table: "ORDERS",
    columns: [
      { name: "ORDER_ID", type: "NUMBER(12,0)", nullable: false, default: null, comment: null },
      { name: "STATUS", type: "VARCHAR2(1)", nullable: false, default: "'N'", comment: null },
      { name: "GUBUN", type: "VARCHAR2(2)", nullable: true, default: null, comment: null },
    ],
    primaryKey: ["ORDER_ID"],
    foreignKeys: [],
    indexes: [],
  }).markdown;
}

const proposal = {
  purpose: { text: "주문 헤더", evidence: ["OrderService.java:20"] },
  columns: {
    STATUS: { text: "주문 상태('N'=신규,'P'=처리중,'D'=완료)", evidence: ["OrderStatus.java:12", "OrderMapper.xml:45"] },
    GUBUN: { text: "주문 구분 코드", evidence: ["OrderType.java:8"] },
  },
};

test("slotState: classifies scaffold / inferred / confirmed / empty", () => {
  assert.equal(slotState("{{설명}}"), "scaffold");
  assert.equal(slotState("{{용도 한 줄}}. {{쓰기 주체}}"), "scaffold");
  assert.equal(slotState(`${INFERRED_PREFIX}주문 상태 [근거: a:1]`), "inferred");
  assert.equal(slotState("배치가 쓰고 리포트가 읽는다"), "confirmed");
  assert.equal(slotState("-"), "empty");
  assert.equal(slotState(null), "empty");
});

test("formatEvidence: appends 근거 and escapes pipes/newlines", () => {
  assert.equal(formatEvidence("설명", ["a.java:1", "b.xml:2"]), "설명 [근거: a.java:1; b.xml:2]");
  assert.equal(formatEvidence("설명", []), "설명");
  assert.equal(formatEvidence("a|b\nc", ["x|y:1"]), "a\\|b c [근거: x\\|y:1]");
});

test("applyProposal: fills scaffold prose + column cells as inferred, with evidence", () => {
  const res = applyProposal(freshDoc(), proposal);
  assert.equal(res.status, "applied");
  // purpose filled, tagged inferred, evidence present
  assert.match(res.markdown, /미확인\) 주문 헤더 \[근거: OrderService\.java:20\]/);
  // column 설명 cells filled inside the auto columns table
  assert.match(res.markdown, /\| STATUS \| VARCHAR2\(1\) \| N \| 'N' \| 미확인\) 주문 상태.*OrderStatus\.java:12; OrderMapper\.xml:45\] \|/);
  assert.match(res.markdown, /\| GUBUN \|.*미확인\) 주문 구분 코드 \[근거: OrderType\.java:8\] \|/);
  // structure (auto) untouched
  assert.match(res.markdown, /- PK: ORDER_ID/);
  assert.deepEqual(res.filled.map((f) => f.slot).sort(), ["column:GUBUN", "column:STATUS", "purpose"]);
});

test("applyProposal: never overwrites a confirmed slot (frozen), reports it skipped", () => {
  const confirmed = applyProposal(freshDoc(), {
    purpose: { text: "사람이 확인한 용도" },
  }).markdown;
  // promote purpose so it becomes confirmed (no 미확인) prefix)
  const promoted = promote(confirmed, { slots: ["purpose"] }).markdown;
  assert.equal(slotState(regionOf(promoted, "purpose")), "confirmed");

  // a new proposal must NOT clobber the confirmed purpose
  const res = applyProposal(promoted, { purpose: { text: "에이전트 재추론" } });
  assert.match(res.markdown, /사람이 확인한 용도/);
  assert.doesNotMatch(res.markdown, /에이전트 재추론/);
  assert.deepEqual(res.skipped, [{ slot: "purpose", reason: "confirmed" }]);
  assert.equal(res.status, "nochange");
});

test("applyProposal: refreshes an existing inferred value by default, keeps it with --keep-inferred", () => {
  const once = applyProposal(freshDoc(), { columns: { STATUS: { text: "구버전 추론" } } }).markdown;
  assert.match(once, /미확인\) 구버전 추론/);

  // default: overwrite the inferred value
  const refreshed = applyProposal(once, { columns: { STATUS: { text: "신버전 추론", evidence: ["x:1"] } } }).markdown;
  assert.match(refreshed, /미확인\) 신버전 추론 \[근거: x:1\]/);
  assert.doesNotMatch(refreshed, /구버전 추론/);

  // keep-inferred: leave the existing inferred value alone
  const kept = applyProposal(once, { columns: { STATUS: { text: "신버전 추론" } } }, { overwriteInferred: false });
  assert.match(kept.markdown, /미확인\) 구버전 추론/);
  assert.deepEqual(kept.skipped, [{ slot: "column:STATUS", reason: "inferred" }]);
});

test("applyProposal: a doc without markers is a conflict (apply only runs on generated docs)", () => {
  const res = applyProposal("# 손으로 쓴 문서\n마커 없음", proposal);
  assert.equal(res.status, "conflict");
  assert.equal(res.markdown, undefined);
  assert.match(res.reason, /마커가 없는/);
});

test("promote: strips 미확인) prefix (keeps evidence) for targeted slots only", () => {
  const applied = applyProposal(freshDoc(), proposal).markdown;
  // promote only STATUS column + purpose
  const res = promote(applied, { columns: ["status"], slots: ["purpose"] });
  assert.deepEqual(res.promoted.sort(), ["column:STATUS", "purpose"]);
  // purpose is now confirmed (prefix gone, evidence stays)
  assert.match(res.markdown, /purpose -->\n주문 헤더 \[근거: OrderService\.java:20\]/);
  // STATUS promoted, GUBUN still inferred (not targeted)
  assert.match(res.markdown, /\| STATUS \|.*\| 주문 상태[^|]*\|/);
  assert.match(res.markdown, /\| GUBUN \|.*미확인\) 주문 구분 코드/);
});

test("promote: --all promotes every inferred slot", () => {
  const applied = applyProposal(freshDoc(), proposal).markdown;
  const res = promote(applied, { all: true });
  assert.doesNotMatch(res.markdown, /미확인\)/); // nothing inferred remains
  assert.equal(res.promoted.length, 3); // purpose + STATUS + GUBUN
});

test("applied fills survive a db-schema-docs structural regeneration (compose with sibling)", () => {
  // apply then confirm the STATUS description
  const applied = applyProposal(freshDoc(), proposal).markdown;
  const confirmed = promote(applied, { columns: ["STATUS"] }).markdown;

  // regenerate structure: STATUS widened, GUBUN dropped, a new column added
  const regen = renderDoc(
    {
      owner: "ERP",
      table: "ORDERS",
      columns: [
        { name: "ORDER_ID", type: "NUMBER(12,0)", nullable: false, default: null, comment: null },
        { name: "STATUS", type: "VARCHAR2(2)", nullable: false, default: "'N'", comment: null },
        { name: "CREATED_AT", type: "DATE", nullable: false, default: null, comment: null },
      ],
      primaryKey: ["ORDER_ID"],
      foreignKeys: [],
      indexes: [],
    },
    { existing: confirmed },
  ).markdown;

  assert.match(regen, /\| STATUS \| VARCHAR2\(2\) \|.*주문 상태/); // confirmed 설명 preserved, type refreshed
  assert.match(regen, /미확인\) 주문 헤더/); // inferred purpose preserved (manual region)
  assert.match(regen, /\| CREATED_AT \| DATE \| N \| - \| \{\{설명\}\} \|/); // new column scaffolded
});

test("buildSchemaDocEnvelope: emit envelope shape for apply / promote (#90)", () => {
  const a = buildSchemaDocEnvelope("SchemaDocApply", "/home/u/.claude/docs/db/fdc_sensor.md", {
    filled: [{ slot: "purpose" }, { slot: "column:STATUS" }],
    skipped: [],
  });
  assert.equal(a.hook_event_type, "SchemaDocApply");
  assert.equal(a.payload.doc, "fdc_sensor.md"); // basename, not the full path
  assert.equal(a.payload.path, "/home/u/.claude/docs/db/fdc_sensor.md");
  assert.equal(a.payload.filled.length, 2);
  assert.equal(typeof a.timestamp, "number");
  assert.ok(a.source_app); // labelled for the fleet

  const p = buildSchemaDocEnvelope("SchemaDocPromote", "x/erp_orders.md", { promoted: ["purpose"] });
  assert.equal(p.hook_event_type, "SchemaDocPromote");
  assert.deepEqual(p.payload.promoted, ["purpose"]);
});

test("editSlot: writes a human value as confirmed (no prefix) to a slot / column (#115 수정)", () => {
  const doc = applyProposal(freshDoc(), proposal).markdown; // 미확인) purpose + STATUS/GUBUN
  const r1 = editSlot(doc, { slot: "purpose" }, "사람이 고친 용도", ["Doc.java:1"]);
  assert.deepEqual(r1.edited, ["purpose"]);
  assert.equal(slotState(regionOf(r1.markdown, "purpose")), "confirmed"); // no 미확인) prefix
  assert.match(r1.markdown, /사람이 고친 용도 \[근거: Doc\.java:1\]/);

  const r2 = editSlot(doc, { column: "STATUS" }, "손으로 고친 상태", []);
  assert.deepEqual(r2.edited, ["column:STATUS"]);
  assert.match(r2.markdown, /\| STATUS \|.*\| 손으로 고친 상태 \|/);

  assert.deepEqual(editSlot(doc, { column: "NOPE" }, "x", []).edited, []); // unknown → no-op
});

test("legacy 추정) prefix is still recognised + promotable (un-migrated pre-#115 docs)", () => {
  // apply now WRITES 미확인), but a doc filled before the rename still has 추정) —
  // it must classify as inferred and 채택/promote must strip it just the same.
  assert.equal(slotState("추정) 옛 추론 [근거: a:1]"), "inferred");
  const doc = "<!-- dbdoc:manual:purpose -->\n추정) 옛 추론 [근거: a:1]\n<!-- dbdoc:end:purpose -->\n";
  const res = promote(doc, { slots: ["purpose"] });
  assert.deepEqual(res.promoted, ["purpose"]);
  assert.doesNotMatch(res.markdown, /추정\)/);         // prefix stripped
  assert.match(res.markdown, /옛 추론 \[근거: a:1\]/);  // text + evidence kept
});

// helper: read a region body out of a doc for assertions
function regionOf(content, id) {
  const m = content.match(new RegExp(`<!-- dbdoc:(?:auto|manual):${id} -->\\n([\\s\\S]*?)\\n<!-- dbdoc:end:${id} -->`));
  return m ? m[1] : null;
}
