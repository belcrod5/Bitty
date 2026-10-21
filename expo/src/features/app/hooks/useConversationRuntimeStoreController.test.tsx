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
  it("accepts a newer owned execution after a relay counter has advanced, including its completion", async () => {
    const { result } = await renderHook(useConversationRuntimeStoreController);
    await act(() => {
      result.current.ensureConversationRuntimeRequestForRelay({ sessionId: "session-1", startedAtMs: 100, reason: "restore" });
      result.current.finalizeConversationRuntimeAfterRelayLoss("session-1", "reconnect");
      result.current.ensureConversationRuntimeRequestForRelay({ sessionId: "session-1", startedAtMs: 100, reason: "reconnect" });
    });
    expect(result.current.getConversationRuntimeSnapshot("session-1")?.request?.requestSeq).toBe(2);
    const owned = { ...activeRequest(200), requestId: "owned", requestSeq: 1 };
    await act(() => { result.current.upsertConversationRuntimeSnapshot({ sessionId: "session-1", request: owned }); });
    expect(result.current.getConversationRuntimeSnapshot("session-1")?.request?.requestId).toBe("owned");
    expect(result.current.getConversationRuntimePreview("session-1")?.isResponding).toBe(true);
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1", request: { ...owned, lifecycle: "completed", status: "completed" },
      });
    });
    expect(result.current.getConversationRuntimePreview("session-1")?.isResponding).toBe(false);
  });

  it("rejects an older terminal execution even when its independent counter is higher", async () => {
    const { result } = await renderHook(useConversationRuntimeStoreController);
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({ sessionId: "session-1", request: { ...activeRequest(200), requestSeq: 1 } });
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1", request: { ...activeRequest(100), requestSeq: 9, lifecycle: "completed", status: "completed" },
      });
    });
    expect(result.current.getConversationRuntimeSnapshot("session-1")).toMatchObject({
      isResponding: true, request: { startedAtMs: 200, requestSeq: 1 },
    });
  });

  it("returns a bounded preview without retaining history or waveform arrays", async () => {
    const { result } = await renderHook(useConversationRuntimeStoreController);
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1", conversationMessages: Array.from({ length: 200 }, (_, i) => ({
          id: String(i), role: "assistant", content: `message ${i}`, ttsWaveform: Array(192).fill(0.5),
        })),
      });
    });
    const preview = result.current.getConversationRuntimePreview("session-1")!;
    expect(preview).toEqual({ isResponding: false, lastMessageContent: "message 199", messageCount: 200, activityTrail: [] });
    preview.activityTrail.push("writing");
    expect(result.current.getConversationRuntimePreview("session-1")?.activityTrail).toEqual([]);
  });

  it("only publishes relevant display changes while preserving request freshness", async () => {
    const { result } = await renderHook(useConversationRuntimeStoreController);
    const listener = jest.fn();
    const unsubscribe = result.current.subscribeConversationRuntime(["session-1"], listener);
    const request = { ...activeRequest(100), updatedAtMs: 1000 };
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({ sessionId: "session-1", request });
    });
    const revision = result.current.getConversationRuntimeRevision("session-1");
    listener.mockClear();
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({ sessionId: "unrelated", isResponding: true });
      result.current.upsertConversationRuntimeSnapshot({ sessionId: "session-1" });
      result.current.upsertConversationRuntimeSnapshot({ sessionId: "session-1", request: { ...request, updatedAtMs: 2000 } });
    });
    expect(listener).not.toHaveBeenCalled();
    expect(result.current.getConversationRuntimeRevision("session-1")).toBe(revision);
    expect(result.current.getConversationRuntimeSnapshot("session-1")).toMatchObject({
      executionGeneration: 1, request: { updatedAtMs: 2000 },
    });
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({
        sessionId: "session-1", request: { ...request, lifecycle: "completed", status: "completed", updatedAtMs: 3000 },
      });
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(result.current.getConversationRuntimeRevision("session-1")).toBe(revision + 1);
    unsubscribe();
    listener.mockClear();
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({ sessionId: "session-1", contextUsedPct: 20 });
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("stores event, approval, and request detail updates without notifying display readers", async () => {
    const { result } = await renderHook(useConversationRuntimeStoreController);
    const request = { ...activeRequest(100), statusDetail: "detail one" };
    await act(() => { result.current.upsertConversationRuntimeSnapshot({ sessionId: "session-1", request }); });
    const listener = jest.fn();
    result.current.subscribeConversationRuntime(["session-1"], listener);
    const event = { kind: "text" as const, sessionId: "session-1", seq: 1, text: "event", atMs: 100 };
    const approval = {
      requestId: "approval", source: "codex-app-server" as const, command: "command", args: [],
      reason: "reason", approvalKey: "key", message: "approval", threadId: "session-1", turnId: "turn",
    };
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({ sessionId: "session-1", events: [event] });
      result.current.upsertConversationRuntimeSnapshot({ sessionId: "session-1", pendingApproval: approval });
      result.current.upsertConversationRuntimeSnapshot({ sessionId: "session-1", request: { ...request, statusDetail: "detail two" } });
    });
    expect(listener).not.toHaveBeenCalled();
    expect(result.current.getConversationRuntimeSnapshot("session-1")).toMatchObject({
      events: [event], pendingApproval: approval, request: { statusDetail: "detail two" },
    });
    await act(() => {
      result.current.upsertConversationRuntimeSnapshot({ sessionId: "session-1", request: { ...request, startedAtMs: 200 } });
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps defensive copies when omitted collections are reused internally", async () => {
    const { result } = await renderHook(useConversationRuntimeStoreController);
    const input = [{ ...message("owned", "original"), youtubeVideoIds: ["original-id"] }];
    const first = result.current.upsertConversationRuntimeSnapshot({ sessionId: "session-1", conversationMessages: input })!;
    input[0].content = "changed input";
    input[0].youtubeVideoIds[0] = "changed input id";
    first.conversationMessages[0].content = "changed output";
    first.conversationMessages[0].youtubeVideoIds![0] = "changed output id";
    const next = result.current.upsertConversationRuntimeSnapshot({ sessionId: "session-1", contextUsedPct: 20 })!;
    next.conversationMessages[0].content = "changed reused output";
    const read = result.current.getConversationRuntimeSnapshot("session-1")!;
    read.conversationMessages[0].youtubeVideoIds![0] = "changed read";
    expect(result.current.getConversationRuntimeSnapshot("session-1")?.conversationMessages).toEqual([
      { ...message("owned", "original"), youtubeVideoIds: ["original-id"] },
    ]);
  });

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
