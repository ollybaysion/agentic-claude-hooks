// time context provider (UserPromptSubmit, prio 40).
//
// One fresh line per turn to counteract the model's stale knowledge cutoff and
// cue web search for recent info. Lives on the per-turn event so it is
// recomputed each turn (a SessionStart value would go stale). See DESIGN.md §8.

export default {
  id: "time",
  events: ["UserPromptSubmit"],
  defaultPriority: 40,
  async run() {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Local wall-clock (in the resolved tz) FIRST, then UTC. Never label a UTC
    // ISO string with the local tz — that reads as N hours off (the whole point
    // of this line is to be unambiguously "now").
    const local = now.toLocaleString("sv-SE", { timeZone: tz }); // YYYY-MM-DD HH:MM:SS
    return { text: `Current date/time: ${local} (${tz}) | ${now.toISOString()} (UTC)` };
  },
};
