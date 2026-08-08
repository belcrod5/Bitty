import {
  buildPanelAssignmentSignature,
  buildPanelHydrationRequestMark,
  decidePanelHydration,
  parsePanelUpdatedAtMs,
  snapshotHoldsAssignedSession,
} from "./panelAssignmentHydration";

const OLDER_AT = "2026-08-07T00:00:00.000Z";
const NEWER_AT = "2026-08-07T00:05:00.000Z";

function candidate(overrides: Partial<Parameters<typeof decidePanelHydration>[0]["candidate"]> = {}) {
  return {
    sessionId: "session-1",
    directory: "/workspace",
    updatedAt: OLDER_AT,
    ...overrides,
  };
}

function snapshot(overrides: Partial<NonNullable<Parameters<typeof decidePanelHydration>[0]["snapshot"]>> = {}) {
  return {
    selectedSessionId: "session-1",
    selectedSessionUpdatedAt: OLDER_AT,
    isResponding: false,
    isHydrating: false,
    conversationMessages: [{ id: "m1" }],
    ...overrides,
  };
}

describe("buildPanelAssignmentSignature", () => {
  it("uses only the assignment identity (no updatedAt)", () => {
    expect(buildPanelAssignmentSignature("panel_1", candidate())).toBe("panel_1:session-1:/workspace");
    expect(buildPanelAssignmentSignature("panel_1", candidate({ updatedAt: NEWER_AT })))
      .toBe("panel_1:session-1:/workspace");
    expect(buildPanelAssignmentSignature("panel_1", null)).toBe("panel_1:");
  });
});

describe("parsePanelUpdatedAtMs", () => {
  it("parses ISO timestamps and falls back to 0", () => {
    expect(parsePanelUpdatedAtMs(OLDER_AT)).toBe(new Date(OLDER_AT).getTime());
    expect(parsePanelUpdatedAtMs("")).toBe(0);
    expect(parsePanelUpdatedAtMs("not-a-date")).toBe(0);
    expect(parsePanelUpdatedAtMs(undefined)).toBe(0);
  });
});

describe("snapshotHoldsAssignedSession", () => {
  it("matches only non-empty equal session ids", () => {
    expect(snapshotHoldsAssignedSession(snapshot(), "session-1")).toBe(true);
    expect(snapshotHoldsAssignedSession(snapshot(), "session-2")).toBe(false);
    expect(snapshotHoldsAssignedSession(snapshot({ selectedSessionId: "" }), "")).toBe(false);
    expect(snapshotHoldsAssignedSession(null, "session-1")).toBe(false);
  });
});

describe("decidePanelHydration", () => {
  it("hydrates when the panel has no snapshot yet", () => {
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate(),
      snapshot: null,
    })).toEqual({ action: "hydrate", reason: "assignment_changed" });
  });

  it("hydrates when the snapshot holds a different session", () => {
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate(),
      snapshot: snapshot({ selectedSessionId: "session-2" }),
    })).toEqual({ action: "hydrate", reason: "assignment_changed" });
  });

  it("skips when the snapshot already holds the fresh session (reentry)", () => {
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate(),
      snapshot: snapshot(),
    })).toEqual({ action: "skip", reason: "snapshot_fresh" });
  });

  it("skips when the snapshot updatedAt is newer than the candidate", () => {
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate(),
      snapshot: snapshot({ selectedSessionUpdatedAt: NEWER_AT }),
    })).toEqual({ action: "skip", reason: "snapshot_fresh" });
  });

  it("re-hydrates only when the candidate updatedAt advances", () => {
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate({ updatedAt: NEWER_AT }),
      snapshot: snapshot(),
    })).toEqual({ action: "hydrate", reason: "updated_at_advanced" });
  });

  it("skips a live responding session even when updatedAt advances", () => {
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate({ updatedAt: NEWER_AT }),
      snapshot: snapshot({ isResponding: true }),
    })).toEqual({ action: "skip", reason: "live_session" });
  });

  it("hydrates a live session when it is newly assigned to the panel", () => {
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate(),
      snapshot: snapshot({ selectedSessionId: "session-2", isResponding: true }),
    })).toEqual({ action: "hydrate", reason: "assignment_changed" });
  });

  it("hydrates when the snapshot has no known updatedAt", () => {
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate(),
      snapshot: snapshot({ selectedSessionUpdatedAt: "" }),
    })).toEqual({ action: "hydrate", reason: "snapshot_stale" });
  });

  it("hydrates when the snapshot has no messages or is mid-hydration", () => {
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate(),
      snapshot: snapshot({ conversationMessages: [] }),
    })).toEqual({ action: "hydrate", reason: "snapshot_stale" });
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate(),
      snapshot: snapshot({ isHydrating: true }),
    })).toEqual({ action: "hydrate", reason: "snapshot_stale" });
  });

  it("skips a repeated request for the same assignment and updatedAt", () => {
    const lastRequested = buildPanelHydrationRequestMark("panel_1", candidate());
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate(),
      lastRequested,
      snapshot: snapshot({ isHydrating: true }),
    })).toEqual({ action: "skip", reason: "already_requested" });
    // 失敗でsnapshotがクリアされてもupdatedAtが進むまでは再要求しない
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate(),
      lastRequested,
      snapshot: null,
    })).toEqual({ action: "skip", reason: "already_requested" });
  });

  it("re-hydrates a previously requested assignment when updatedAt advances", () => {
    const lastRequested = buildPanelHydrationRequestMark("panel_1", candidate());
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate({ updatedAt: NEWER_AT }),
      lastRequested,
      snapshot: null,
    })).toEqual({ action: "hydrate", reason: "snapshot_lost" });
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate({ updatedAt: NEWER_AT }),
      lastRequested,
      snapshot: snapshot(),
    })).toEqual({ action: "hydrate", reason: "updated_at_advanced" });
  });

  it("hydrates a new assignment even when the previous one was requested", () => {
    expect(decidePanelHydration({
      panelId: "panel_1",
      candidate: candidate({ sessionId: "session-2" }),
      lastRequested: buildPanelHydrationRequestMark("panel_1", candidate()),
      snapshot: snapshot(),
    })).toEqual({ action: "hydrate", reason: "assignment_changed" });
  });
});
