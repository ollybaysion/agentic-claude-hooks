#!/usr/bin/env node
// Offline regression tests for db-schema-propose-codebase.
// Run: node skills/db-schema-propose-codebase/test.mjs
//
// Pure — no DB, no codebase, no server. What's tested is the deterministic rim
// of the producer: proposal shape lint and the akg slot translation. The
// load-bearing cases are the silent-drop hazards: a typo'd key must be an
// ERROR here, and anything that cannot cross into akg's address space must be
// REPORTED, not dropped. Doc-side cross-checks (no-such-column, frozen slot)
// are the akg server's submit-time validation, not this module's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lintProposal, toAkgSlots } from "./propose.mjs";

const goodProposal = {
  purpose: { text: "주문 헤더", evidence: ["OrderService.java:20"] },
  columns: {
    STATUS: { text: "주문 상태('N'=신규)", evidence: ["OrderStatus.java:12"] },
  },
};

test("lint: a well-formed proposal is clean", () => {
  const res = lintProposal(goodProposal);
  assert.deepEqual(res, { ok: true, errors: [], warnings: [] });
});

test("lint: unknown keys are ERRORs at both levels (silent-drop hazard)", () => {
  const typoTop = lintProposal({ column: goodProposal.columns });
  assert.equal(typoTop.ok, false);
  assert.match(typoTop.errors.join("\n"), /알 수 없는 키: column /);

  const typoEntry = lintProposal({
    purpose: { text: "x", evidences: ["a:1"] },
  });
  assert.match(typoEntry.errors.join("\n"), /purpose 에 알 수 없는 키: evidences/);
});

test("lint: type violations and missing evidence are caught", () => {
  const res = lintProposal({
    purpose: { text: "  " },
    columns: { GUBUN: { text: "구분", evidence: "OrderType.java:8" } },
  });
  assert.equal(res.ok, false);
  assert.match(res.errors.join("\n"), /purpose\.text 는 비어 있지 않은 문자열/);
  assert.match(res.errors.join("\n"), /columns\.GUBUN\.evidence 는 배열/);
  assert.match(res.warnings.join("\n"), /purpose: evidence 없음/);
});

test("lint: non-object proposal and empty proposal fail/warn loudly", () => {
  const notObj = lintProposal([]);
  assert.equal(notObj.ok, false);
  assert.match(notObj.errors.join("\n"), /객체가 아닙니다/);

  const empty = lintProposal({});
  assert.equal(empty.ok, true);
  assert.match(empty.warnings.join("\n"), /빈 제안/);
});

// --- akg exit (issue #125) -------------------------------------------------
// The hazard here is the mirror of lint's: anything that cannot cross into
// akg's address space must be REPORTED, not dropped. akg would reject a
// filled slot carrying no evidence, so that check has to happen here where it
// can be shown, not there where it is an opaque failure.

test("toAkgSlots: addresses are renamed, tier is stamped inferred", () => {
  const { slots, unmapped } = toAkgSlots(goodProposal);
  assert.deepEqual(unmapped, []);
  assert.deepEqual(Object.keys(slots).sort(), ["columnDescs.STATUS", "purpose"]);
  assert.deepEqual(slots["columnDescs.STATUS"], {
    text: "주문 상태('N'=신규)",
    tier: "inferred",
    evidence: ["OrderStatus.java:12"],
  });
  assert.equal(slots.purpose.tier, "inferred");
});

test("toAkgSlots: column names are upper-cased into the address", () => {
  const { slots } = toAkgSlots({
    columns: { status: { text: "주문 상태", evidence: ["a.java:1"] } },
  });
  assert.deepEqual(Object.keys(slots), ["columnDescs.STATUS"]);
});

test("toAkgSlots: queries has no akg address and is reported, not dropped", () => {
  const { slots, unmapped } = toAkgSlots({
    queries: { text: "SELECT ...", evidence: ["a.java:1"] },
    purpose: { text: "주문 헤더", evidence: ["b.java:2"] },
  });
  assert.deepEqual(Object.keys(slots), ["purpose"]);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].key, "queries");
  assert.match(unmapped[0].reason, /sql/);
});

test("toAkgSlots: an entry akg would reject is withheld and reported", () => {
  const { slots, unmapped } = toAkgSlots({
    purpose: { text: "근거 없음" },
    columns: {
      GUBUN: { text: "빈 근거", evidence: [] },
      STATUS: { text: "  ", evidence: ["a.java:1"] },
    },
  });
  assert.deepEqual(slots, {});
  assert.deepEqual(unmapped.map((u) => u.key).sort(), [
    "columns.GUBUN",
    "columns.STATUS",
    "purpose",
  ]);
  assert.match(unmapped[0].reason, /invalid_slot_value/);
});

test("toAkgSlots: a producer cannot stamp confirmed (promotion is human-only)", () => {
  assert.throws(() => toAkgSlots(goodProposal, { tier: "confirmed" }), /승격은 사람 전용/);
  assert.throws(() => toAkgSlots([]), /객체가 아닙니다/);
});
