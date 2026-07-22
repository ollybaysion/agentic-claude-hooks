// db-schema-propose-codebase — the default PRODUCER of db-schema meaning proposals.
//
// The actual codebase reading (finding sites, deriving meanings, cross-
// checking) is agent judgment work defined in SKILL.md. This module is the
// deterministic rim around that judgment:
//
//   lintProposal(p)      — check a finished proposal.json against the contract
//                          shape BEFORE it is translated for the akg exit
//   toAkgSlots(proposal) — translate the proposal into akg's slot address
//                          form, the file shape `akg propose` reads (#125)
//
// The single exit is akg (user decision 2026-07-23: doc creation belongs to
// akg-collector, review/promote to the akg dashboard — the local md pipeline
// of db-schema-docs/apply is gone). Doc-side cross-checks (does this column
// exist, is that slot frozen) therefore moved server-side: akg validates
// slot addresses against the target document at submit time (akg #21).
//
// Lint philosophy mirrors forge's spec validation: unknown keys are rejected,
// not ignored — a typo ("column" for "columns") must fail loudly at the
// producer, not evaporate downstream.

// Prose slots a db-schema doc carries besides per-column descriptions.
// (Formerly imported from db-schema-apply; the format's owner is akg now —
// schemas/db-schema/v1 — and these are the two prose regions it models.)
export const PROSE_SLOTS = ["purpose", "queries"];

const TOP_KEYS = [...PROSE_SLOTS, "columns"];
const ENTRY_KEYS = ["text", "evidence"];

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
 * Lint a proposal against the contract shape.
 * errors  — contract violations (unknown keys, wrong types) that would
 *           otherwise strand or corrupt the proposal downstream
 * warnings — hygiene (evidence missing/empty — akg refuses these at adopt)
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function lintProposal(proposal) {
  const errors = [];
  const warnings = [];

  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    return { ok: false, errors: ["proposal 이 객체가 아닙니다"], warnings };
  }
  for (const k of Object.keys(proposal)) {
    if (!TOP_KEYS.includes(k)) errors.push(`알 수 없는 키: ${k} (허용: ${TOP_KEYS.join(", ")})`);
  }
  if (Object.keys(proposal).length === 0) warnings.push("빈 제안입니다 — 넘길 내용이 없습니다");

  for (const id of PROSE_SLOTS) {
    if (!(id in proposal)) continue;
    checkEntry(proposal[id], id, errors, warnings);
  }

  if (proposal.columns !== undefined) {
    if (!proposal.columns || typeof proposal.columns !== "object" || Array.isArray(proposal.columns)) {
      errors.push("columns 가 객체({컬럼명: {text, evidence?}})가 아닙니다");
    } else {
      for (const [name, entry] of Object.entries(proposal.columns)) {
        checkEntry(entry, `columns.${name}`, errors, warnings);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// akg exit (issue #125)
//
// Only the address form differs between the proposal contract and akg's slots
// — both sides carry the same tiers (scaffold/inferred/confirmed) and both
// refuse a filled slot without evidence, so this is a rename, not a
// reinterpretation.
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

// Why evidence is checked HERE even though akg now validates at submit time
// (akg #21): a producer that ships a knowingly-rejectable slot forces a round
// trip through the server to learn what this function already knows. Withhold
// it at the producer and report it instead.
const NO_EVIDENCE =
  "근거가 없습니다 — akg 는 이런 슬롯을 제출/채택 검증에서 invalid_slot_value 로 거부합니다";

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
 *   is human-only. Note the server does not take this on trust: adopt pins
 *   tier to "inferred" itself regardless of what the proposal says. The field
 *   records producer intent and agrees with what the server will write; it
 *   does not decide it.
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
