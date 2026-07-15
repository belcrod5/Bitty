import { act, renderHook } from "@testing-library/react-native";
import { useConversationRuntimeStoreController } from "./useConversationRuntimeStoreController";
import { applyPanelHydrationSnapshot } from "../utils/panelHydrationFreshness";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import type { ConversationMessage } from "../types/appTypes";

function message(id: string, content: string): ConversationMessage {
  return { id, role: "assistant", content };
}

function activeRequest(startedAtMs: number) {
  return {
    requestId: `request-${startedAtMs}`,
    requestSeq: startedAtMs,
    sessionId: "session-1",
    sourcePanelId: "panel-1",
    lifecycle: "active" as const,
    status: "responding",
    startedAtMs,
  };
}

function panelSnapshot(
  conversationMessages: ConversationMessage[],
  isResponding: boolean,
  isHydrating: boolean
): PanelRuntimeSnapshot {
  return {
    panelId: "panel-1",
    selectedSessionId: "session-1",
    selectedDirectoryPath: "/workspace",
    selectedDirectoryDisplayName: "workspace",
    selectedSessionTitle: "session",
    selectedSessionUpdatedAt: "",
    selectedSessionMarkerColor: "none",
    selectedThreadStatusType: isResponding ? "active" : "idle",
    modelRef: "",
    reasoningEffort: "",
    contextUsedPct: null,
    isResponding,
    isHydrating,
    inheritedConversationMessages: [],
    conversationMessages,
  };
}

describe("useConversationRuntimeStoreController conditional terminal update", () => {
  it("does not replace a newer request, messages, or responding state", async () => {
    const { result } = await renderHook(() => useConversationRuntimeStoreController());
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1",
        conversationMessages: [message("old", "old response")],
        isResponding: true,
        selectedThreadStatusType: "active",
        request: activeRequest(100),
      });
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1",
        conversationMessages: [message("new", "new request")],
        isResponding: true,
        selectedThreadStatusType: "active",
        request: activeRequest(200),
      });
    });

    let rejectedUpdate: ReturnType<typeof result.current.upsertConversationRuntimeSnapshot> = null;
    await act(() => {
      rejectedUpdate = result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1",
        conversationMessages: [message("restored", "stale terminal response")],
        isResponding: false,
        selectedThreadStatusType: "idle",
        expectedRequestStartedAtMs: 100,
        clearRespondingRequestStartedAtMs: 100,
      });
    });

    const current = result.current.getConversationRuntimeSnapshot("session-1");
    expect(rejectedUpdate).toBeNull();
    expect(current?.conversationMessages).toEqual([message("new", "new request")]);
    expect(current?.isResponding).toBe(true);
    expect(current?.selectedThreadStatusType).toBe("active");
    expect(current?.request?.startedAtMs).toBe(200);

    const panelBeforeCommit = {
      sessionId: "session-1",
      snapshot: panelSnapshot([message("new", "new request")], true, true),
    };
    const panelResult = applyPanelHydrationSnapshot({
      entries: { "panel-1": panelBeforeCommit },
      panelId: "panel-1",
      sessionId: "session-1",
      snapshot: panelSnapshot([message("restored", "stale terminal response")], false, false),
      expectedRequestStartedAtMs: 100,
      currentRequestStartedAtMs: current?.request?.startedAtMs ?? null,
    });
    expect(panelResult["panel-1"].snapshot.conversationMessages).toEqual([message("new", "new request")]);
    expect(panelResult["panel-1"].snapshot.isResponding).toBe(true);
    expect(panelResult["panel-1"].snapshot.isHydrating).toBe(false);
  });
});
