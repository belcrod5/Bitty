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

  it("reports the wait until a session resync becomes allowed", () => {
    const limiter = createResyncRateLimiter({
      perSessionMinIntervalMs: 5000,
      globalWindowMs: 10_000,
      globalMaxPerWindow: 2,
    });
    expect(limiter.msUntilAllowed("session-1", 1000)).toBe(0);
    limiter.recordResync("session-1", 1000);
    // セッション単位: 5000ms - 経過2000ms = 残り3000ms。
    expect(limiter.msUntilAllowed("session-1", 3000)).toBe(3000);
    limiter.recordResync("session-2", 1500);
    // グローバル枠(2件): 最古(1000)+窓10s=11000で1枠空く。
    expect(limiter.msUntilAllowed("session-3", 2000)).toBe(9000);
    expect(limiter.canResync("session-3", 11_100)).toBe(true);
    expect(limiter.msUntilAllowed("session-3", 11_100)).toBe(0);
  });

  it("distinguishes session cooldown from global budget exhaustion", () => {
    const limiter = createResyncRateLimiter({
      perSessionMinIntervalMs: 5000,
      globalWindowMs: 10_000,
      globalMaxPerWindow: 1,
    });
    limiter.recordResync("session-1", 1000);
    // session-1自身はクールダウン中、session-2はグローバル枠超過のみ。
    expect(limiter.isSessionCoolingDown("session-1", 2000)).toBe(true);
    expect(limiter.isSessionCoolingDown("session-2", 2000)).toBe(false);
    expect(limiter.canResync("session-2", 2000)).toBe(false);
  });

  it("rejects empty session ids", () => {
    const limiter = createResyncRateLimiter();
    expect(limiter.canResync("", 1000)).toBe(false);
    expect(limiter.msUntilAllowed("", 1000)).toBe(Number.POSITIVE_INFINITY);
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
    expect(withoutObserver.targets).toEqual([
      { sessionId: "session-1", selected: true, panels: [] },
    ]);

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
      { sessionId: "session-1", selected: true, panels: [] },
      { sessionId: "session-2", selected: false, panels: [{ panelId: "drawer_session_popup", directory: "/repo" }] },
      { sessionId: "session-3", selected: false, panels: [{ panelId: "panel-a", directory: "/repo" }] },
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
      { sessionId: "session-3", selected: false, panels: [{ panelId: "panel-a", directory: "/repo" }] },
    ]);
  });

  it("groups every visible panel of a session into one target (one rate-limit slot, all panels applied)", () => {
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
    // 同一セッションの全可視パネルへ反映する(#40 relay-loss回復経路と同じ扱い)。
    // popupがselectedと同一セッションでもpanel hydrateは省略しない。
    expect(plan.targets).toEqual([
      {
        sessionId: "session-1",
        selected: true,
        panels: [{ panelId: "drawer_session_popup", directory: "/repo" }],
      },
      {
        sessionId: "session-2",
        selected: false,
        panels: [
          { panelId: "panel-a", directory: "/repo" },
          { panelId: "panel-b", directory: "/repo" },
        ],
      },
    ]);
    expect(plan.skipped).toEqual([]);
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
