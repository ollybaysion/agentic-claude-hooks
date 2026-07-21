// db-schema-propose-codebase — the default PRODUCER of db-schema meaning proposals.
//
// The actual codebase reading (finding sites, deriving meanings, cross-
// checking) is agent judgment work defined in SKILL.md. This module is the
// deterministic rim around that judgment:
//
//   listSlots(doc)          — inventory which slots are fillable vs frozen,
//                             so the agent works from a list, not a guess
//   lintProposal(doc, p)    — check a finished proposal.json against the
//                             contract shape AND the target doc BEFORE it is
//                             handed to db-schema-apply (the write gateway)
//   toAkgSlots(proposal)    — translate the same proposal into akg's slot
//                             address form, for the other exit: `akg propose`
//                             instead of a local file (issue #125)
//
// Lint philosophy mirrors forge's spec validation: unknown keys are rejected,
// not ignored. apply-side merging skips what it doesn't recognize, so a typo
// ("column" for "columns") or a column that doesn't exist in the doc would
// otherwise vanish silently — the producer must fail loudly here instead.

import { extractRegion, extractColumnDescriptions, hasMarkers } from "../db-schema-docs/render.mjs";
import { slotState, PROSE_SLOTS } from "../db-schema-apply/apply.mjs";

const TOP_KEYS = [...PROSE_SLOTS, "columns"];
const ENTRY_KEYS = ["text", "evidence"];

// States apply will fill (inferred only via the default refresh behavior).
const FILLABLE = new Set(["empty", "scaffold", "inferred"]);

/**
 * Inventory the meaning slots of a generated doc.
 * @returns {{slots: Array<{slot:string, state:string, fillable:boolean}>,
 *            counts: Record<string, number>}}
 * @throws on a markerless doc (not a db-schema-docs product).
 */
export function listSlots(content) {
  if (!hasMarkers(content))
    throw new Error("dbdoc 마커가 없는 문서입니다 — db-schema-docs 산출물에만 제안할 수 있습니다");
  const slots = [];
  for (const id of PROSE_SLOTS) {
    const body = extractRegion(content, id);
    if (body == null) continue;
    const state = slotState(body);
    slots.push({ slot: id, state, fillable: FILLABLE.has(state) });
  }
  for (const [name, desc] of extractColumnDescriptions(content)) {
    const state = slotState(desc);
    slots.push({ slot: `column:${name}`, state, fillable: FILLABLE.has(state) });
  }
  const counts = {};
  for (const s of slots) counts[s.state] = (counts[s.state] ?? 0) + 1;
  return { slots, counts };
}

function checkEntry(entry, ctx, errors, warnings) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`${ctx} 가 객체({text, evidence?})가 아닙니다`);
    return;
  }
  for (const k of Object.keys(entry)) {
    if (!ENTRY_KEYS.includes(k)) errors.push(`${ctx} 에 알 수 없는 키: ${k} (허용: ${ENTRY_KEYS.join(", ")})`);
  }
  if (typeof entry.text !== "string" || !entry.text.trim())
    errors.push(`${ctx}.text 는 비어 있지 않은 문자열이어야 합니다`);
  if (entry.evidence === undefined) {
    warnings.push(`${ctx}: evidence 없음 — 근거 없는 항목은 넣지 않는 게 규약입니다`);
  } else if (!Array.isArray(entry.evidence)) {
    errors.push(`${ctx}.evidence 는 배열이어야 합니다`);
  } else if (entry.evidence.length === 0) {
    warnings.push(`${ctx}: evidence 가 비어 있습니다 — 근거 없는 항목은 넣지 않는 게 규약입니다`);
  } else {
    entry.evidence.forEach((e, i) => {
      if (typeof e !== "string" || !e.trim())
        errors.push(`${ctx}.evidence[${i}] 는 비어 있지 않은 문자열이어야 합니다`);
    });
  }
}

/**
 * Lint a proposal against the contract shape and the target doc.
 * errors  — contract violations / entries apply would silently drop
 * warnings — entries apply will visibly skip (confirmed freeze) or hygiene
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function lintProposal(content, proposal) {
  const errors = [];
  const warnings = [];

  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    return { ok: false, errors: ["proposal 이 객체가 아닙니다"], warnings };
  }
  for (const k of Object.keys(proposal)) {
    if (!TOP_KEYS.includes(k)) errors.push(`알 수 없는 키: ${k} (허용: ${TOP_KEYS.join(", ")})`);
  }
  if (Object.keys(proposal).length === 0) warnings.push("빈 제안입니다 — 넘길 내용이 없습니다");

  const marked = hasMarkers(content);
  if (!marked) errors.push("대상 문서에 dbdoc 마커가 없습니다 — apply 가 conflict 로 거부합니다");
  const docCols = marked ? extractColumnDescriptions(content) : new Map();

  for (const id of PROSE_SLOTS) {
    if (!(id in proposal)) continue;
    checkEntry(proposal[id], id, errors, warnings);
    if (!marked) continue;
    const body = extractRegion(content, id);
    if (body == null) errors.push(`${id}: 문서에 해당 구역이 없습니다 — apply 가 조용히 버립니다`);
    else if (slotState(body) === "confirmed") warnings.push(`${id}: confirmed 동결 — apply 가 건너뜁니다(skipped)`);
  }

  if (proposal.columns !== undefined) {
    if (!proposal.columns || typeof proposal.columns !== "object" || Array.isArray(proposal.columns)) {
      errors.push("columns 가 객체({컬럼명: {text, evidence?}})가 아닙니다");
    } else {
      for (const [name, entry] of Object.entries(proposal.columns)) {
        checkEntry(entry, `columns.${name}`, errors, warnings);
        if (!marked) continue;
        if (!docCols.has(name.toUpperCase()))
          errors.push(`columns.${name}: 문서에 없는 컬럼입니다 — apply 가 조용히 버립니다`);
        else if (slotState(docCols.get(name.toUpperCase())) === "confirmed")
          warnings.push(`columns.${name}: confirmed 동결 — apply 가 건너뜁니다(skipped)`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// akg exit (issue #125)
//
// The same proposal can leave through two doors. db-schema-apply writes it into
// a local md file; `akg propose` submits it to the hub's review queue. Only the
// address form differs — both sides carry the same tiers (scaffold/inferred/
// confirmed) and both refuse a filled slot without evidence, so this is a
// rename, not a reinterpretation.
//
//   purpose          -> "purpose"
//   columns.STATUS   -> "columnDescs.STATUS"
//   queries          -> UNMAPPABLE, see below
//
// `queries` has no address. Here it is one prose region; in akg it is
// `{sql, note}[]`, addressed `queries[0].note`, and the note hangs off a
// specific sql this proposal does not carry. Rather than invent an sql to
// anchor to, it is reported as unmapped — the same "no silent evaporation"
// rule that makes lint reject unknown keys.

const AKG_UNMAPPABLE = {
  queries:
    "akg 는 queries 를 {sql, note}[] 로 모델링합니다 — note 를 매달 sql 이 제안에 없어 주소를 만들 수 없습니다. 대표 쿼리는 대시보드에서 직접 넣으세요",
};

// Why evidence is checked HERE and not left to the server: POST /api/proposals
// stores the proposal without inspecting slot values (submit-time validation is
// a known gap — scenarios R5). The rejection lands at ADOPT instead, where
// routes/proposals.mjs returns 400 invalid_slot_value on the FIRST text-less or
// evidence-less slot and abandons the whole adopt. So one sloppy entry does not
// degrade gracefully — it strands the entire proposal in the queue, discovered
// by a reviewer who cannot fix it. Withhold it at the producer instead.
const NO_EVIDENCE =
  "근거가 없습니다 — akg 는 채택(adopt) 시 이런 슬롯을 invalid_slot_value(400)로 거부하고, 그 제안 전체가 거기서 멈춥니다";

/**
 * Translate a proposal into akg `POST /api/proposals` slots.
 *
 * Lint this proposal FIRST — this function assumes the contract shape and only
 * guards what akg's schema would reject at the wire (an entry with no
 * evidence: tiered-value requires evidence minItems 1 unless tier is scaffold).
 *
 * @param {object} proposal
 * @param {{tier?: string}} [opts] tier recorded on every translated slot.
 *   Default "inferred", and a producer may never pass "confirmed" — promotion
 *   is human-only, the same rule db-schema-apply enforces locally. Note the
 *   server does not take this on trust: adopt pins tier to "inferred" itself
 *   regardless of what the proposal says. The field records producer intent
 *   and agrees with what the server will write; it does not decide it.
 * @returns {{slots: Record<string, {text: string, tier: string, evidence: string[]}>,
 *            unmapped: Array<{key: string, reason: string}>}}
 */
export function toAkgSlots(proposal, { tier = "inferred" } = {}) {
  if (tier === "confirmed")
    throw new Error("toAkgSlots: confirmed 는 생산자가 부여할 수 없습니다 — 승격은 사람 전용입니다");
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal))
    throw new Error("toAkgSlots: proposal 이 객체가 아닙니다");

  const slots = {};
  const unmapped = [];

  const put = (address, key, entry) => {
    const evidence = Array.isArray(entry?.evidence) ? entry.evidence.filter((e) => typeof e === "string" && e.trim()) : [];
    if (!entry?.text || !String(entry.text).trim() || !evidence.length) {
      unmapped.push({ key, reason: NO_EVIDENCE });
      return;
    }
    slots[address] = { text: entry.text, tier, evidence };
  };

  for (const [key, reason] of Object.entries(AKG_UNMAPPABLE)) {
    if (key in proposal) unmapped.push({ key, reason });
  }
  if ("purpose" in proposal) put("purpose", "purpose", proposal.purpose);
  for (const [name, entry] of Object.entries(proposal.columns ?? {})) {
    put(`columnDescs.${name.toUpperCase()}`, `columns.${name}`, entry);
  }

  return { slots, unmapped };
}
