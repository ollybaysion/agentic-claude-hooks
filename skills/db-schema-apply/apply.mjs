// db-schema-apply — fills the MEANING slots of a db-schema doc from evidence
// mined out of a codebase, and manages the confidence lifecycle of those fills.
//
// db-schema-docs (sibling skill) generates the STRUCTURE (columns/PK/index from
// the live catalog) and leaves the meaning slots as {{scaffold}}. This module
// takes an already-generated doc plus a "semantics proposal" (produced by an
// agent that read the codebase — ORM entities, MyBatis mappers, value enums,
// SQL literals) and writes those meanings back, each tagged with its confidence.
//
// The whole point is to NOT poison trusted context: a wrong guess that reads as
// authoritative is worse than an empty scaffold. So every filled value carries
// its tier inline, visibly:
//
//   scaffold   {{설명}}                        — unknown, fillable (표시: 미작성)
//   inferred   자동) <text> [근거: a.java:12]   — agent-derived, LOW trust,
//                                                 carries evidence, regeneratable,
//                                                 injected AS a hedge ("자동)")
//   confirmed  <text> [근거: a.java:12]         — human-reviewed (채택됨), HIGH trust,
//                                                 FROZEN (never overwritten)
//
// The prefix "자동) " is the only thing that distinguishes inferred from
// confirmed, so 채택/promotion (§promote) is just stripping it. ("추정) " is the
// pre-#115 prefix, still recognised for un-migrated docs.) Confidence is NOT a
// fake numeric score — it's the tier plus the length of the evidence list (how
// many independent code sites corroborate). Promotion is human-only by design:
// an agent must never flip its own inference to confirmed.
//
// Reuses db-schema-docs/render.mjs for the marker convention (extractRegion,
// extractColumnDescriptions, hasMarkers). This module only WRITES back into the
// meaning slots; it never touches the auto structure regions. And because
// render.mjs preserves non-scaffold column 설명 and manual regions across a
// structural regeneration, these fills survive a later db-schema-docs run.

import { extractRegion, hasMarkers } from "../db-schema-docs/render.mjs";

// The prefix new fills are WRITTEN with ("자동) " = auto-derived, awaiting human
// 채택). "추정) " is the legacy prefix (pre-#115 rename); we still RECOGNISE it so
// un-migrated docs keep working — `migrate` (cli) rewrites old → new in place.
export const INFERRED_PREFIX = "자동) ";
export const INFERRED_PREFIXES = ["자동) ", "추정) "];

// Meaning slots this module manages. Column 설명 cells are handled separately
// (they live inside the auto:columns table, keyed by column name).
export const PROSE_SLOTS = ["purpose", "queries"];

// A cell/region value can't carry a raw pipe or newline without breaking a row.
function escapeInline(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** Render "<text> [근거: a:1; b:2]" (evidence optional), pipe/newline-safe. */
export function formatEvidence(text, evidence) {
  const body = escapeInline(text);
  const cites = Array.isArray(evidence) ? evidence.map((e) => escapeInline(e)).filter(Boolean) : [];
  return cites.length ? `${body} [근거: ${cites.join("; ")}]` : body;
}

/** Classify a slot's current value. Empty/"-"/scaffold are fillable. */
export function slotState(value) {
  if (value == null) return "empty";
  const s = String(value).trim();
  if (s === "" || s === "-") return "empty";
  if (INFERRED_PREFIXES.some((p) => s.startsWith(p))) return "inferred";
  if (s.includes("{{")) return "scaffold";
  return "confirmed";
}

const FILLABLE = new Set(["empty", "scaffold"]);

function isFillable(state, overwriteInferred) {
  return FILLABLE.has(state) || (state === "inferred" && overwriteInferred);
}

// Replace the inner body of one marked region. Returns null if the region is
// absent (caller decides whether that's an error).
function replaceRegion(content, id, newBody) {
  const re = new RegExp(`(<!-- dbdoc:(?:auto|manual):${id} -->\\n)([\\s\\S]*?)(\\n<!-- dbdoc:end:${id} -->)`);
  if (!re.test(content)) return null;
  return content.replace(re, (_, open, _body, close) => `${open}${newBody}${close}`);
}

function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  return t.slice(1, t.endsWith("|") ? -1 : undefined).split("|").map((s) => s.trim());
}

function isDataRow(cells) {
  if (!cells || cells.length < 5) return false;
  const name = cells[0];
  return name !== "컬럼" && !/^-+$/.test(name);
}

// Rewrite the 설명 (5th) cell of each column row via `mapCell(name, current)`;
// a mapper returning null leaves that row unchanged. Header/separator rows and
// unknown columns are left alone.
function rewriteColumnCells(content, mapCell) {
  const body = extractRegion(content, "columns");
  if (body == null) return { content, changed: [] };
  const changed = [];
  const lines = body.split("\n").map((line) => {
    const cells = splitRow(line);
    if (!isDataRow(cells)) return line;
    const next = mapCell(cells[0], cells[4]);
    if (next == null || next === cells[4]) return line;
    changed.push(cells[0]);
    cells[4] = next;
    return `| ${cells.join(" | ")} |`;
  });
  if (!changed.length) return { content, changed };
  return { content: replaceRegion(content, "columns", lines.join("\n")) ?? content, changed };
}

/**
 * Fill meaning slots from a semantics proposal.
 *
 * proposal: {
 *   purpose?:   { text, evidence?: string[] },
 *   queries?:   { text, evidence? },
 *   columns?:   { [COLUMN_NAME]: { text, evidence? } },
 * }
 *
 * Each targeted slot is filled ONLY if currently fillable (scaffold/empty, or
 * inferred when overwriteInferred=true). A confirmed slot is never touched and
 * is reported in `skipped`. Filled values are written as inferred (자동) …).
 *
 * @returns {{status:"applied"|"nochange"|"conflict", markdown?:string,
 *            filled:Array<{slot,from}>, skipped:Array<{slot,reason}>, reason?:string}}
 */
export function applyProposal(existing, proposal, { overwriteInferred = true } = {}) {
  if (!hasMarkers(existing)) {
    return {
      status: "conflict",
      filled: [],
      skipped: [],
      reason: "dbdoc 마커가 없는 문서입니다 — 이 스킬은 db-schema-docs가 생성한 문서에만 적용됩니다.",
    };
  }

  let content = existing;
  const filled = [];
  const skipped = [];

  for (const id of PROSE_SLOTS) {
    const prop = proposal?.[id];
    if (!prop || typeof prop.text !== "string" || !prop.text.trim()) continue;
    const current = extractRegion(content, id);
    if (current == null) continue; // slot not present in this doc
    const state = slotState(current);
    if (!isFillable(state, overwriteInferred)) {
      skipped.push({ slot: id, reason: state });
      continue;
    }
    const next = replaceRegion(content, id, INFERRED_PREFIX + formatEvidence(prop.text, prop.evidence));
    if (next) {
      content = next;
      filled.push({ slot: id, from: state });
    }
  }

  const cols = proposal?.columns ?? {};
  if (Object.keys(cols).length) {
    const decide = (name) => {
      const key = Object.keys(cols).find((k) => k.toUpperCase() === name.toUpperCase());
      return key ? cols[key] : null;
    };
    const { content: c2 } = rewriteColumnCells(content, (name, current) => {
      const prop = decide(name);
      if (!prop || typeof prop.text !== "string" || !prop.text.trim()) return null;
      const state = slotState(current);
      if (!isFillable(state, overwriteInferred)) {
        skipped.push({ slot: `column:${name}`, reason: state });
        return null;
      }
      filled.push({ slot: `column:${name}`, from: state });
      return INFERRED_PREFIX + formatEvidence(prop.text, prop.evidence);
    });
    content = c2;
  }

  return {
    status: filled.length ? "applied" : "nochange",
    markdown: content,
    filled,
    skipped,
  };
}

// Strip the inferred prefix from a value, promoting it to confirmed. Evidence
// stays (now provenance for a confirmed fact).
function stripInferred(value) {
  for (const p of INFERRED_PREFIXES) if (value.startsWith(p)) return value.slice(p.length);
  return value;
}

/**
 * Promote inferred slots to confirmed (human action). target:
 *   { all: true }                  — every inferred slot
 *   { slots: ["purpose", ...] }    — named prose slots
 *   { columns: ["STATUS", ...] }   — named columns (case-insensitive)
 * Only slots currently in the `inferred` state change.
 *
 * @returns {{markdown:string, promoted:string[]}}
 */
export function promote(existing, target = { all: true }) {
  const all = target.all === true;
  const wantSlot = (id) => all || (Array.isArray(target.slots) && target.slots.includes(id));
  const wantColumn = (name) =>
    all ||
    (Array.isArray(target.columns) &&
      target.columns.some((c) => c.toUpperCase() === name.toUpperCase()));

  let content = existing;
  const promoted = [];

  for (const id of PROSE_SLOTS) {
    if (!wantSlot(id)) continue;
    const current = extractRegion(content, id);
    if (current == null || slotState(current) !== "inferred") continue;
    content = replaceRegion(content, id, stripInferred(current)) ?? content;
    promoted.push(id);
  }

  const { content: c2, changed } = rewriteColumnCells(content, (name, current) => {
    if (!wantColumn(name) || slotState(current) !== "inferred") return null;
    return stripInferred(current);
  });
  content = c2;
  for (const name of changed) promoted.push(`column:${name}`);

  return { markdown: content, promoted };
}
