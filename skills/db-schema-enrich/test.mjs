#!/usr/bin/env node
// Offline regression tests for db-schema-enrich.
// Run: node skills/db-schema-enrich/test.mjs
//
// Pure — no DB, no codebase, no MCP. The agent's codebase analysis is upstream
// and produces the "semantics proposal" object these tests feed in directly;
// what's tested here is the deterministic substrate: filling meaning slots with
// confidence tiers, freezing confirmed content, and promotion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDoc } from "../db-schema-docs/render.mjs";
import {
  applyEnrichment,
  promote,
  slotState,
  formatEvidence,
  INFERRED_PREFIX,
} from "./enrich.mjs";

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

test("applyEnrichment: fills scaffold prose + column cells as inferred, with evidence", () => {
  const res = applyEnrichment(freshDoc(), proposal);
  assert.equal(res.status, "enriched");
  // purpose filled, tagged inferred, evidence present
  assert.match(res.markdown, /추정\) 주문 헤더 \[근거: OrderService\.java:20\]/);
  // column 설명 cells filled inside the auto columns table
  assert.match(res.markdown, /\| STATUS \| VARCHAR2\(1\) \| N \| 'N' \| 추정\) 주문 상태.*OrderStatus\.java:12; OrderMapper\.xml:45\] \|/);
  assert.match(res.markdown, /\| GUBUN \|.*추정\) 주문 구분 코드 \[근거: OrderType\.java:8\] \|/);
  // structure (auto) untouched
  assert.match(res.markdown, /- PK: ORDER_ID/);
  assert.deepEqual(res.filled.map((f) => f.slot).sort(), ["column:GUBUN", "column:STATUS", "purpose"]);
});

test("applyEnrichment: never overwrites a confirmed slot (frozen), reports it skipped", () => {
  const confirmed = applyEnrichment(freshDoc(), {
    purpose: { text: "사람이 확인한 용도" },
  }).markdown;
  // promote purpose so it becomes confirmed (no 추정) prefix)
  const promoted = promote(confirmed, { slots: ["purpose"] }).markdown;
  assert.equal(slotState(regionOf(promoted, "purpose")), "confirmed");

  // a new proposal must NOT clobber the confirmed purpose
  const res = applyEnrichment(promoted, { purpose: { text: "에이전트 재추론" } });
  assert.match(res.markdown, /사람이 확인한 용도/);
  assert.doesNotMatch(res.markdown, /에이전트 재추론/);
  assert.deepEqual(res.skipped, [{ slot: "purpose", reason: "confirmed" }]);
  assert.equal(res.status, "nochange");
});

test("applyEnrichment: refreshes an existing inferred value by default, keeps it with --keep-inferred", () => {
  const once = applyEnrichment(freshDoc(), { columns: { STATUS: { text: "구버전 추론" } } }).markdown;
  assert.match(once, /추정\) 구버전 추론/);

  // default: overwrite the inferred value
  const refreshed = applyEnrichment(once, { columns: { STATUS: { text: "신버전 추론", evidence: ["x:1"] } } }).markdown;
  assert.match(refreshed, /추정\) 신버전 추론 \[근거: x:1\]/);
  assert.doesNotMatch(refreshed, /구버전 추론/);

  // keep-inferred: leave the existing inferred value alone
  const kept = applyEnrichment(once, { columns: { STATUS: { text: "신버전 추론" } } }, { overwriteInferred: false });
  assert.match(kept.markdown, /추정\) 구버전 추론/);
  assert.deepEqual(kept.skipped, [{ slot: "column:STATUS", reason: "inferred" }]);
});

test("applyEnrichment: a doc without markers is a conflict (enrich only runs on generated docs)", () => {
  const res = applyEnrichment("# 손으로 쓴 문서\n마커 없음", proposal);
  assert.equal(res.status, "conflict");
  assert.equal(res.markdown, undefined);
  assert.match(res.reason, /마커가 없는/);
});

test("promote: strips 추정) prefix (keeps evidence) for targeted slots only", () => {
  const enriched = applyEnrichment(freshDoc(), proposal).markdown;
  // promote only STATUS column + purpose
  const res = promote(enriched, { columns: ["status"], slots: ["purpose"] });
  assert.deepEqual(res.promoted.sort(), ["column:STATUS", "purpose"]);
  // purpose is now confirmed (prefix gone, evidence stays)
  assert.match(res.markdown, /purpose -->\n주문 헤더 \[근거: OrderService\.java:20\]/);
  // STATUS promoted, GUBUN still inferred (not targeted)
  assert.match(res.markdown, /\| STATUS \|.*\| 주문 상태[^|]*\|/);
  assert.match(res.markdown, /\| GUBUN \|.*추정\) 주문 구분 코드/);
});

test("promote: --all promotes every inferred slot", () => {
  const enriched = applyEnrichment(freshDoc(), proposal).markdown;
  const res = promote(enriched, { all: true });
  assert.doesNotMatch(res.markdown, /추정\)/); // nothing inferred remains
  assert.equal(res.promoted.length, 3); // purpose + STATUS + GUBUN
});

test("enrich fills survive a db-schema-docs structural regeneration (compose with sibling)", () => {
  // enrich then confirm the STATUS description
  const enriched = applyEnrichment(freshDoc(), proposal).markdown;
  const confirmed = promote(enriched, { columns: ["STATUS"] }).markdown;

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
  assert.match(regen, /추정\) 주문 헤더/); // inferred purpose preserved (manual region)
  assert.match(regen, /\| CREATED_AT \| DATE \| N \| - \| \{\{설명\}\} \|/); // new column scaffolded
});

// helper: read a region body out of a doc for assertions
function regionOf(content, id) {
  const m = content.match(new RegExp(`<!-- dbdoc:(?:auto|manual):${id} -->\\n([\\s\\S]*?)\\n<!-- dbdoc:end:${id} -->`));
  return m ? m[1] : null;
}
