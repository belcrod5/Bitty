import {
  createResyncRateLimiter,
  planResumeSyncTargets,
  shouldHandleReadyTransition,
} from "./resumeSync";

describe("createResyncRateLimiter", () => {
  it("enforces the per-session minimum interval", () => {
    const limiter = createResyncRateLimiter({
      perSessionMinIntervalMs: 5000,
      globalWindowMs: 10_000,
      globalMaxPerWindow: 10,
    });
    expect(limiter.canResync("session-1", 1000)).toBe(true);
    limiter.recordResync("session-1", 1000);
    expect(limiter.canResync("session-1", 3000)).toBe(false);
    // 別セッションはセッション単位間隔の影響を受けない。
    expect(limiter.canResync("session-2", 3000)).toBe(true);
    expect(limiter.canResync("session-1", 6001)).toBe(true);
  });

  it("enforces the global all-sessions budget within the window", () => {
    const limiter = createResyncRateLimiter({
      perSessionMinIntervalMs: 0,
      globalWindowMs: 10_000,
      globalMaxPerWindow: 2,
    });
    limiter.recordResync("session-1", 1000);
    limiter.recordResync("session-2", 1500);
    // 合算2回で窓内の枠を使い切っているため、3セッション目は抑止される。
    expect(limiter.canResync("session-3", 2000)).toBe(false);
    // 窓が過ぎれば回復する。
    expect(limiter.canResync("session-3", 11_600)).toBe(true);
  });

  it("rejects empty session ids", () => {
    const limiter = createResyncRateLimiter();
    expect(limiter.canResync("", 1000)).toBe(false);
  });
});

describe("shouldHandleReadyTransition", () => {
  it("fires once per ready generation", () => {
    expect(shouldHandleReadyTransition({
      connectionState: "ready",
      generation: 2,
      lastHandledGeneration: 1,
    })).toBe(true);
    expect(shouldHandleReadyTransition({
      connectionState: "ready",
      generation: 2,
      lastHandledGeneration: 2,
    })).toBe(false);
    expect(shouldHandleReadyTransition({
      connectionState: "reconnecting",
      generation: 3,
      lastHandledGeneration: 2,
    })).toBe(false);
  });
});

describe("planResumeSyncTargets", () => {
  const basePanel = (overrides: Partial<{
    panelId: string;
    sessionId: string;
    directory: string;
    isResponding: boolean;
  }> = {}) => ({
    panelId: "panel-1",
    sessionId: "session-2",
    directory: "/repo",
    isResponding: false,
    ...overrides,
  });

  it("targets the selected session and skips it when its live relay observer is alive", () => {
    const withoutObserver = planResumeSyncTargets({
      selectedSessionId: "session-1",
      observerThreadId: "",
      popupPanelId: "",
      panelEntries: [],
      respondingSessionIds: [],
    });
    expect(withoutObserver.targets).toEqual([{ kind: "selected", sessionId: "session-1" }]);

    const withObserver = planResumeSyncTargets({
      selectedSessionId: "session-1",
      observerThreadId: "session-1",
      popupPanelId: "",
      panelEntries: [],
      respondingSessionIds: [],
    });
    // observerのseq resumeが第一経路のため、全文再取得はしない(G1)。
    expect(withObserver.targets).toEqual([]);
    expect(withObserver.skipped).toEqual([{ sessionId: "session-1", reason: "live_observer" }]);
  });

  it("targets the popup panel and responding panels but not idle panels", () => {
    const plan = planResumeSyncTargets({
      selectedSessionId: "session-1",
      observerThreadId: "",
      popupPanelId: "drawer_session_popup",
      panelEntries: [
        basePanel({ panelId: "drawer_session_popup", sessionId: "session-2" }),
        basePanel({ panelId: "panel-a", sessionId: "session-3", isResponding: true }),
        basePanel({ panelId: "panel-b", sessionId: "session-4", isResponding: false }),
      ],
      respondingSessionIds: [],
    });
    expect(plan.targets).toEqual([
      { kind: "selected", sessionId: "session-1" },
      { kind: "panel", sessionId: "session-2", panelId: "drawer_session_popup", directory: "/repo" },
      { kind: "panel", sessionId: "session-3", panelId: "panel-a", directory: "/repo" },
    ]);
  });

  it("includes panels whose session was responding when the app went to background", () => {
    const plan = planResumeSyncTargets({
      selectedSessionId: "",
      observerThreadId: "",
      popupPanelId: "",
      panelEntries: [
        basePanel({ panelId: "panel-a", sessionId: "session-3", isResponding: false }),
      ],
      respondingSessionIds: ["session-3"],
    });
    expect(plan.targets).toEqual([
      { kind: "panel", sessionId: "session-3", panelId: "panel-a", directory: "/repo" },
    ]);
  });

  it("resyncs each session once, preferring the selected scope", () => {
    const plan = planResumeSyncTargets({
      selectedSessionId: "session-1",
      observerThreadId: "",
      popupPanelId: "drawer_session_popup",
      panelEntries: [
        basePanel({ panelId: "drawer_session_popup", sessionId: "session-1" }),
        basePanel({ panelId: "panel-a", sessionId: "session-2", isResponding: true }),
        basePanel({ panelId: "panel-b", sessionId: "session-2", isResponding: true }),
      ],
      respondingSessionIds: [],
    });
    expect(plan.targets).toEqual([
      { kind: "selected", sessionId: "session-1" },
      { kind: "panel", sessionId: "session-2", panelId: "panel-a", directory: "/repo" },
    ]);
    expect(plan.skipped).toEqual([
      { sessionId: "session-1", panelId: "drawer_session_popup", reason: "session_already_covered" },
      { sessionId: "session-2", panelId: "panel-b", reason: "session_already_covered" },
    ]);
  });

  it("skips observer-owned panel sessions and panels without a directory", () => {
    const plan = planResumeSyncTargets({
      selectedSessionId: "",
      observerThreadId: "session-2",
      popupPanelId: "",
      panelEntries: [
        basePanel({ panelId: "panel-a", sessionId: "session-2", isResponding: true }),
        basePanel({ panelId: "panel-b", sessionId: "session-3", isResponding: true, directory: "" }),
      ],
      respondingSessionIds: [],
    });
    expect(plan.targets).toEqual([]);
    expect(plan.skipped).toEqual([
      { sessionId: "session-2", panelId: "panel-a", reason: "live_observer" },
      { sessionId: "session-3", panelId: "panel-b", reason: "missing_directory" },
    ]);
  });
});
