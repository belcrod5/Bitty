import { formatCodexAuthRateLimits, parseCodexAuthRateLimits, parseCodexStatusLimit } from "./codexAuthRateLimits";

describe("Codex status remaining limits", () => {
  it.each([
    [0, "danger"],
    [1, "warning"],
    [10, "warning"],
    [11, "neutral"],
    [50, "neutral"],
    [100, "neutral"],
    [0.4, "danger"],
    [10.4, "warning"],
    [10.5, "neutral"],
  ] as const)("classifies the displayed remaining %s%% as %s", (percent, tone) => {
    expect(parseCodexStatusLimit(`5h limit: [██░░] ${percent}% left\nWeekly limit: 80% left`, "5h")).toEqual({
      remainingPercent: Math.round(percent),
      tone,
    });
  });

  it("reads each window independently and tolerates label case", () => {
    const status = "5h limit: 0% left\nweekly limit: [██░░] 10% left (resets tomorrow)";
    expect(parseCodexStatusLimit(status, "5h")).toEqual({ remainingPercent: 0, tone: "danger" });
    expect(parseCodexStatusLimit(status, "Weekly")).toEqual({ remainingPercent: 10, tone: "warning" });
  });

  it.each(["", "5h limit: unavailable\nWeekly limit: 0% left", "5h limit: -1% left", "5h limit: 101% left"])(
    "keeps missing or invalid remaining percentages neutral: %s", (status) => {
      expect(parseCodexStatusLimit(status, "5h")).toEqual({ remainingPercent: null, tone: "neutral" });
    }
  );
});

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
