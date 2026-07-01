// core/context/lib/budget.mjs — pure budgeting.
//
// Keep the highest-priority fragments that fit the character budget. The 10k
// additionalContext cap is on CHARACTERS and overflow silently spills to a
// preview+file (dropping the bulk), so we stay well under it. Triple defense:
// per-provider self-caps -> per-event budget -> this final HARD_CAP clamp.
// See DESIGN.md §7.

export const HARD_CAP = 9500; // safe headroom under the 10k char cap (JSON envelope, escaping, char↔token gap)
export const DEFAULT_BUDGET = { SessionStart: 8000, UserPromptSubmit: 1500 };

const SEP = "\n\n";
const MIN_KEEP = 200; // if the first overflow would truncate below this, drop it whole

export function budgetFragments(fragments, budget) {
  const cap = Math.min(budget ?? DEFAULT_BUDGET.SessionStart, HARD_CAP);
  const sorted = [...fragments].sort((a, b) => b.priority - a.priority); // ties keep input order
  const out = [];
  let used = 0;
  for (const f of sorted) {
    const block = `## ${f.id}\n${f.text}`;
    const cost = (out.length ? SEP.length : 0) + block.length;
    if (used + cost <= cap) {
      out.push(block);
      used += cost;
      continue;
    }
    const room = cap - used - (out.length ? SEP.length : 0);
    if (room >= MIN_KEEP) out.push(block.slice(0, room - 1).trimEnd() + "…");
    break; // after an overflow, drop all lower-priority fragments
  }
  return out.join(SEP).slice(0, HARD_CAP); // final hard clamp
}
