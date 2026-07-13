#!/usr/bin/env node
// Offline regression tests for db-schema-propose.
// Run: node skills/db-schema-propose/test.mjs
//
// Pure — no DB, no codebase. What's tested is the deterministic rim of the
// producer: slot inventory and proposal lint (contract shape + doc cross-
// checks). The load-bearing cases are the silent-drop hazards: a typo'd top
// key or a column absent from the doc must be an ERROR here, because apply
// would ignore them without a trace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDoc } from "../db-schema-docs/render.mjs";
import { applyProposal, promote } from "../db-schema-apply/apply.mjs";
import { listSlots, lintProposal } from "./propose.mjs";

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

const goodProposal = {
  purpose: { text: "주문 헤더", evidence: ["OrderService.java:20"] },
  columns: {
    STATUS: { text: "주문 상태('N'=신규)", evidence: ["OrderStatus.java:12"] },
  },
};

test("listSlots: fresh doc is all scaffold and fillable; counts add up", () => {
  const { slots, counts } = listSlots(freshDoc());
  assert.ok(slots.every((s) => s.fillable));
  assert.equal(counts.scaffold, slots.length);
  const names = slots.map((s) => s.slot);
  assert.ok(names.includes("purpose") && names.includes("column:STATUS"));
});

test("listSlots: confirmed slots surface as frozen; markerless doc throws", () => {
  const applied = applyProposal(freshDoc(), goodProposal).markdown;
  const confirmed = promote(applied, { columns: ["STATUS"] }).markdown;
  const { slots } = listSlots(confirmed);
  const status = slots.find((s) => s.slot === "column:STATUS");
  assert.equal(status.state, "confirmed");
  assert.equal(status.fillable, false);
  const purpose = slots.find((s) => s.slot === "purpose");
  assert.equal(purpose.state, "inferred"); // still fillable via refresh
  assert.equal(purpose.fillable, true);

  assert.throws(() => listSlots("# 손문서"), /마커가 없는/);
});

test("lint: a well-formed proposal against a fresh doc is clean", () => {
  const res = lintProposal(freshDoc(), goodProposal);
  assert.deepEqual(res, { ok: true, errors: [], warnings: [] });
});

test("lint: unknown keys are ERRORs at both levels (silent-drop hazard)", () => {
  const typoTop = lintProposal(freshDoc(), { column: goodProposal.columns });
  assert.equal(typoTop.ok, false);
  assert.match(typoTop.errors.join("\n"), /알 수 없는 키: column /);

  const typoEntry = lintProposal(freshDoc(), {
    purpose: { text: "x", evidences: ["a:1"] },
  });
  assert.match(typoEntry.errors.join("\n"), /purpose 에 알 수 없는 키: evidences/);
});

test("lint: a column absent from the doc is an ERROR, confirmed targets are WARNs", () => {
  const applied = applyProposal(freshDoc(), goodProposal).markdown;
  const confirmed = promote(applied, { columns: ["STATUS"] }).markdown;
  const res = lintProposal(confirmed, {
    columns: {
      STATSU: { text: "오타 컬럼", evidence: ["a:1"] },
      STATUS: { text: "재추론", evidence: ["a:1"] },
    },
  });
  assert.equal(res.ok, false);
  assert.match(res.errors.join("\n"), /columns\.STATSU: 문서에 없는 컬럼/);
  assert.match(res.warnings.join("\n"), /columns\.STATUS: confirmed 동결/);
});

test("lint: type violations and missing evidence are caught", () => {
  const res = lintProposal(freshDoc(), {
    purpose: { text: "  " },
    columns: { GUBUN: { text: "구분", evidence: "OrderType.java:8" } },
  });
  assert.equal(res.ok, false);
  assert.match(res.errors.join("\n"), /purpose\.text 는 비어 있지 않은 문자열/);
  assert.match(res.errors.join("\n"), /columns\.GUBUN\.evidence 는 배열/);
  assert.match(res.warnings.join("\n"), /purpose: evidence 없음/);
});

test("lint: markerless doc and non-object proposal fail loudly", () => {
  const markerless = lintProposal("# 손문서", goodProposal);
  assert.equal(markerless.ok, false);
  assert.match(markerless.errors.join("\n"), /dbdoc 마커가 없습니다/);

  const notObj = lintProposal(freshDoc(), []);
  assert.equal(notObj.ok, false);
  assert.match(notObj.errors.join("\n"), /객체가 아닙니다/);
});
