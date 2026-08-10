import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import { buildPanelRuntimeSnapshot } from "./panelRuntimeSnapshot";

const base: PanelRuntimeSnapshot = {
  panelId: "panel-1",
  selectedSessionId: "session-1",
  selectedDirectoryPath: "/workspace",
  selectedDirectoryDisplayName: "workspace",
  selectedSessionTitle: "title",
  selectedSessionUpdatedAt: "",
  selectedSessionMarkerColor: "none",
  selectedThreadStatusType: "idle",
  modelRef: "gpt-5",
  reasoningEffort: "high",
  contextUsedPct: null,
  isResponding: false,
  inheritedConversationMessages: [],
  conversationMessages: [{ id: "m1", role: "assistant", content: "hello", ttsWaveform: [1, 2] }],
};

it("builds an immutable panel snapshot while preserving optional scroll state", () => {
  const snapshot = buildPanelRuntimeSnapshot({
    panelId: "panel-1",
    base: { ...base, scrollOffsetY: 42, scrollNearBottom: false },
    patch: { contextUsedPct: 120 },
    isCompactRunning: () => false,
  });

  expect(snapshot.contextUsedPct).toBe(100);
  expect(snapshot.scrollOffsetY).toBe(42);
  expect(snapshot.scrollNearBottom).toBe(false);
  expect(snapshot.conversationMessages).not.toBe(base.conversationMessages);
  expect(snapshot.conversationMessages[0]?.ttsWaveform).not.toBe(base.conversationMessages[0]?.ttsWaveform);
});

it("projects shared runtime status independently from conversation message content", () => {
  const snapshot = buildPanelRuntimeSnapshot({
    panelId: "panel-1",
    base,
    patch: {
      isResponding: true,
      runtimeStatus: "tool_running",
      runtimeStatusDetail: "tool start: file_edit",
      runtimeActivityTrail: ["thinking", "writing"],
    },
    isCompactRunning: () => false,
  });

  expect(snapshot.runtimeStatus).toBe("tool_running");
  expect(snapshot.runtimeStatusDetail).toBe("tool start: file_edit");
  expect(snapshot.runtimeActivityTrail).toEqual(["thinking", "writing"]);
  expect(snapshot.runtimeActivityTrail).not.toBe(base.runtimeActivityTrail);
  expect(snapshot.conversationMessages).toHaveLength(1);
});
