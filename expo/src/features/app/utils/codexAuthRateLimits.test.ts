import { formatCodexAuthRateLimits, parseCodexAuthRateLimits } from "./codexAuthRateLimits";

describe("Codex auth account helpers", () => {
  it("parses rate limit objects and arrays safely", () => {
    expect(parseCodexAuthRateLimits({ primary: { windowDurationMins: 300, usedPercent: 25, resetsAt: "2026-01-01" }, secondary: { window_duration_mins: 10080, used_percent: 101 } })).toEqual([
      { windowDurationMins: 300, usedPercent: 25, resetsAt: "2026-01-01" },
      { windowDurationMins: 10080, usedPercent: 100 },
    ]);
  });

  it("formats the standard windows and one weekly reset countdown", () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const weeklyResetSeconds = (nowMs / 1000) + ((2 * 1440 + 21 * 60 + 24) * 60);
    expect(formatCodexAuthRateLimits({
      rateLimits: [
        { windowDurationMins: 10080, usedPercent: 50, resetsAt: String(weeklyResetSeconds) },
        { windowDurationMins: 300, usedPercent: 25, resetsAt: String((nowMs / 1000) + 3600) },
      ],
    }, nowMs)).toBe("5h 75% | 週 50% | 2日21:24");
  });

  it("ignores non-standard windows instead of leaking them into the account summary", () => {
    expect(formatCodexAuthRateLimits({
      rateLimits: [
        { windowDurationMins: 60, usedPercent: 10 },
        { windowDurationMins: 300, usedPercent: 25 },
      ],
    })).toBe("5h 75%");
  });

});
