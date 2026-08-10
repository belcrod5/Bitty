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
  it("updates an active request status without replacing its panel conversation", async () => {
    const { result } = await renderHook(() => useConversationRuntimeStoreController());
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1",
        conversationMessages: [message("existing", "existing response")],
        isResponding: true,
        selectedThreadStatusType: "active",
        request: activeRequest(100),
      });
      result.current.updateConversationRuntimeRequestStatus(
        "session-1",
        "tool_running",
        "tool start: web_search"
      );
    });

    expect(result.current.getConversationRuntimeSnapshot("session-1")).toMatchObject({
      isResponding: true,
      conversationMessages: [message("existing", "existing response")],
      request: {
        status: "tool_running",
        statusDetail: "tool start: web_search",
        startedAtMs: 100,
      },
      activityTrail: ["thinking", "web"],
    });
  });

  it("keeps the latest four activity transitions and preserves them after completion", async () => {
    const { result } = await renderHook(() => useConversationRuntimeStoreController());
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1",
        isResponding: true,
        selectedThreadStatusType: "active",
        request: activeRequest(100),
      });
      result.current.updateConversationRuntimeRequestStatus(
        "session-1",
        "tool_running",
        "tool start: file_open"
      );
      result.current.updateConversationRuntimeRequestStatus(
        "session-1",
        "tool_running",
        "tool start: read_file"
      );
      result.current.updateConversationRuntimeRequestStatus(
        "session-1",
        "model_generating",
        "delta:native"
      );
      result.current.updateConversationRuntimeRequestStatus(
        "session-1",
        "tool_running",
        "tool start: web_search"
      );
      result.current.updateConversationRuntimeRequestStatus(
        "session-1",
        "model_processing",
        "agent message completed"
      );
    });

    expect(result.current.getConversationRuntimeSnapshot("session-1")?.activityTrail).toEqual([
      "reading",
      "writing",
      "web",
      "thinking",
    ]);

    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1",
        isResponding: false,
        selectedThreadStatusType: "idle",
        expectedRequestStartedAtMs: 100,
        clearRespondingRequestStartedAtMs: 100,
      });
    });

    expect(result.current.getConversationRuntimeSnapshot("session-1")).toMatchObject({
      isResponding: false,
      request: null,
      activityTrail: ["reading", "writing", "web", "thinking"],
    });
  });

  it("starts a fresh trail for a new request", async () => {
    const { result } = await renderHook(() => useConversationRuntimeStoreController());
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1",
        isResponding: true,
        selectedThreadStatusType: "active",
        request: activeRequest(100),
      });
      result.current.updateConversationRuntimeRequestStatus(
        "session-1",
        "tool_running",
        "tool start: web_search"
      );
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1",
        isResponding: true,
        selectedThreadStatusType: "active",
        request: {
          ...activeRequest(200),
          status: "model_generating",
        },
      });
    });

    expect(result.current.getConversationRuntimeSnapshot("session-1")?.activityTrail).toEqual(["writing"]);
  });

  it("creates a shared request for a restored relay and keeps newer identities", async () => {
    const { result } = await renderHook(() => useConversationRuntimeStoreController());
    await act(() => {
      result.current.ensureConversationRuntimeRequestForRelay({
        sessionId: "session-1",
        startedAtMs: 200,
        reason: "session_restored_running_turn",
      });
      result.current.updateConversationRuntimeRequestStatus(
        "session-1",
        "tool_running",
        "tool start: web_search"
      );
      result.current.ensureConversationRuntimeRequestForRelay({
        sessionId: "session-1",
        startedAtMs: 100,
        reason: "stale relay",
      });
    });

    expect(result.current.getConversationRuntimeSnapshot("session-1")).toMatchObject({
      isResponding: true,
      activityTrail: ["thinking", "web"],
      request: {
        requestId: "relay-session-1-200-1",
        startedAtMs: 200,
      },
    });
  });

  it("reactivates a terminal relay when the same running turn is reattached", async () => {
    const { result } = await renderHook(() => useConversationRuntimeStoreController());
    await act(() => {
      result.current.ensureConversationRuntimeRequestForRelay({
        sessionId: "session-1",
        startedAtMs: 200,
        reason: "session_restored_running_turn",
      });
      result.current.updateConversationRuntimeRequestStatus(
        "session-1",
        "tool_running",
        "tool start: web_search"
      );
      result.current.finalizeConversationRuntimeAfterRelayLoss("session-1", "relay lost");
      result.current.ensureConversationRuntimeRequestForRelay({
        sessionId: "session-1",
        startedAtMs: 200,
        reason: "session_restored_running_turn",
      });
    });

    expect(result.current.getConversationRuntimeSnapshot("session-1")).toMatchObject({
      isResponding: true,
      activityTrail: ["thinking", "web", "thinking"],
      request: {
        requestId: "relay-session-1-200-2",
        requestSeq: 2,
        lifecycle: "active",
        startedAtMs: 200,
      },
    });
  });

  it("terminalizes relay loss so every retained activity becomes completed", async () => {
    const { result } = await renderHook(() => useConversationRuntimeStoreController());
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1",
        isResponding: true,
        selectedThreadStatusType: "active",
        request: activeRequest(100),
      });
      result.current.updateConversationRuntimeRequestStatus(
        "session-1",
        "tool_running",
        "tool start: web_search"
      );
      result.current.finalizeConversationRuntimeAfterRelayLoss("session-1", "relay lost");
    });

    expect(result.current.getConversationRuntimeSnapshot("session-1")).toMatchObject({
      isResponding: false,
      selectedThreadStatusType: "idle",
      activityTrail: ["thinking", "web"],
      request: {
        lifecycle: "error",
        status: "error",
        statusDetail: "relay lost",
      },
    });
  });

  it("advances executionGeneration for execution changes but not message-only updates", async () => {
    const { result } = await renderHook(() => useConversationRuntimeStoreController());

    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1",
        conversationMessages: [message("first", "first")],
      });
    });
    const first = result.current.getConversationRuntimeSnapshot("session-1");
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1",
        conversationMessages: [message("second", "second")],
      });
    });
    const second = result.current.getConversationRuntimeSnapshot("session-1");
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1",
        conversationMessages: [message("third", "third")],
        isResponding: true,
        selectedThreadStatusType: "active",
        request: activeRequest(100),
      });
    });
    const running = result.current.getConversationRuntimeSnapshot("session-1");
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1",
        isResponding: false,
        selectedThreadStatusType: "idle",
        expectedRequestStartedAtMs: 100,
        clearRespondingRequestStartedAtMs: 100,
      });
    });
    const completed = result.current.getConversationRuntimeSnapshot("session-1");

    expect(first?.executionGeneration).toBe(0);
    expect(second?.executionGeneration).toBe(0);
    expect(running?.executionGeneration).toBe(1);
    expect(completed?.request).toBeNull();
    expect(completed?.executionGeneration).toBe(2);
  });

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
