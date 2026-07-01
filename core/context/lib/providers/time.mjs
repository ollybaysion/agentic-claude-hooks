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
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return { text: `Current date/time: ${new Date().toISOString()} (timezone: ${tz})` };
  },
};
