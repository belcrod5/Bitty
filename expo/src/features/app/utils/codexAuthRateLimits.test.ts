import { formatCodexAuthRateLimits, parseCodexAuthRateLimits } from "./codexAuthRateLimits";

describe("Codex auth account helpers", () => {
  it("parses rate limit objects and arrays safely", () => {
    expect(parseCodexAuthRateLimits({ primary: { windowDurationMins: 300, usedPercent: 25, resetsAt: "2026-01-01" }, secondary: { window_duration_mins: 10080, used_percent: 101 } })).toEqual([
      { windowDurationMins: 300, usedPercent: 25, resetsAt: "2026-01-01" },
      { windowDurationMins: 10080, usedPercent: 100 },
    ]);
  });

  it("formats windows", () => {
    expect(formatCodexAuthRateLimits({ rateLimits: [{ windowDurationMins: 300, usedPercent: 25 }, { windowDurationMins: 10080, usedPercent: 50 }] })).toBe("5h 75% | 週 50%");
  });

});
