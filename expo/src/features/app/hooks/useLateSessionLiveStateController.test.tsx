import { useRef, useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import type { ConversationMessage } from "../types/appTypes";
import type {
  RunnerSessionLiveState,
  RunnerSessionMessagesResult,
} from "./useLlmSessionExplorer";
import type { PanelRuntimeEntry } from "./usePanelNewSessionController";
import { useLateSessionLiveStateController } from "./useLateSessionLiveStateController";

function snapshot(): PanelRuntimeSnapshot {
  return {
    panelId: "panel-1",
    selectedSessionId: "thread-1",
    selectedDirectoryPath: "/workspace",
    selectedDirectoryDisplayName: "workspace",
    selectedSessionTitle: "session",
    selectedSessionUpdatedAt: "",
    selectedSessionMarkerColor: "none",
    selectedThreadStatusType: "idle",
    modelRef: "",
    reasoningEffort: "",
    contextUsedPct: null,
    isResponding: false,
    inheritedConversationMessages: [],
    conversationMessages: [{ id: "message-1", role: "assistant", content: "latest" }],
  };
}

function restored(liveStatePromise: Promise<RunnerSessionLiveState | null>): RunnerSessionMessagesResult {
  return {
    threadId: "thread-1",
    sourceKind: "cli",
    cwd: "/workspace",
    updatedAt: "",
    modelRef: "",
    reasoningEffort: "",
    latestToolLabel: "",
    messages: [],
    contextUsedPct: null,
    threadStatusType: "",
    hasRunningTurn: false,
    runningTurn: null,
    olderCursor: null,
    liveStatePromise,
  };
}

it("applies late running state to active and panel runtimes and attaches the panel relay", async () => {
  let resolveActive: ((value: RunnerSessionLiveState) => void) | null = null;
  let resolvePanel: ((value: RunnerSessionLiveState) => void) | null = null;
  const activePromise = new Promise<RunnerSessionLiveState>((resolve) => { resolveActive = resolve; });
  const panelPromise = new Promise<RunnerSessionLiveState>((resolve) => { resolvePanel = resolve; });
  const applyRestoredRuntime = jest.fn();
  const setActiveThreadStatus = jest.fn();
  const upsertRuntime = jest.fn(() => ({}));
  const startRelay = jest.fn(() => true);
  let runtimeStartedAtMs: number | null = null;
  let executionGeneration = 0;
  const { result } = await renderHook(() => {
    const conversationMessagesRef = useRef<ConversationMessage[]>([
      { id: "message-1", role: "assistant", content: "latest" },
    ]);
    const [entries, setEntries] = useState<Record<string, PanelRuntimeEntry>>({
      "panel-1": { sessionId: "thread-1", snapshot: snapshot() },
    });
    const panelEntriesRef = useRef(entries);
    panelEntriesRef.current = entries;
    const controller = useLateSessionLiveStateController({
      activeSessionId: () => "thread-1",
      conversationMessagesRef,
      panelEntriesRef,
      applyRestoredRuntime,
      getRuntime: () => ({
        conversationMessages: conversationMessagesRef.current,
        request: runtimeStartedAtMs ? { startedAtMs: runtimeStartedAtMs } : null,
        executionGeneration,
      }),
      upsertRuntime,
      setPanelEntries: setEntries,
      createPanelSnapshot: (_panelId, base, patch) => ({ ...base, ...patch }),
      setActiveThreadStatus,
      startRelay,
      log: jest.fn(),
    });
    return { controller, entries };
  });

  result.current.controller.applyActive({
    restored: restored(activePromise),
    restoredMessages: [],
    nextSessionId: "thread-1",
    directory: "/workspace",
    effectiveContextUsedPct: null,
    restoreReplyRequestForThread: () => false,
    setReply: jest.fn(),
    requestStartedAtMsAtRestoreApply: null,
    executionGenerationAtRestoreApply: 0,
    isCurrent: () => true,
  });
  result.current.controller.applyPanel({
    restored: restored(panelPromise),
    snapshot: result.current.entries["panel-1"].snapshot,
    panelId: "panel-1",
    directory: "/workspace",
    requestStartedAtMsAtHydrationStart: null,
    executionGenerationAtHydrationApply: 0,
    isCurrent: () => true,
  });

  const liveState: RunnerSessionLiveState = {
    threadId: "thread-1",
    threadStatusType: "active",
    hasRunningTurn: true,
    runningTurn: {
      status: "running",
      summary: "working",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    },
  };
  await act(async () => {
    resolveActive?.(liveState);
    resolvePanel?.(liveState);
    await Promise.all([activePromise, panelPromise]);
  });

  await waitFor(() => {
    expect(applyRestoredRuntime).toHaveBeenCalledWith(expect.objectContaining({
      restored: expect.objectContaining({ hasRunningTurn: true }),
    }));
    expect(setActiveThreadStatus).toHaveBeenCalledWith("active");
    expect(result.current.entries["panel-1"].snapshot.isResponding).toBe(true);
    expect(startRelay).toHaveBeenCalledWith("thread-1", expect.objectContaining({
      reason: "session_restored_running_turn",
    }));
  });

  applyRestoredRuntime.mockClear();
  runtimeStartedAtMs = null;
  executionGeneration = 2;
  result.current.controller.applyActive({
    restored: restored(Promise.resolve(liveState)),
    restoredMessages: [],
    nextSessionId: "thread-1",
    directory: "/workspace",
    effectiveContextUsedPct: null,
    restoreReplyRequestForThread: () => false,
    setReply: jest.fn(),
    requestStartedAtMsAtRestoreApply: null,
    executionGenerationAtRestoreApply: 0,
    isCurrent: () => true,
  });
  await act(async () => { await Promise.resolve(); });
  expect(applyRestoredRuntime).not.toHaveBeenCalled();
});

describe("onLiveStateNotRunning", () => {
  function buildController(onLiveStateNotRunning: jest.Mock) {
    return renderHook(() => {
      const conversationMessagesRef = useRef<ConversationMessage[]>([]);
      const panelEntriesRef = useRef<Record<string, PanelRuntimeEntry>>({
        "panel-1": { sessionId: "thread-1", snapshot: snapshot() },
      });
      return useLateSessionLiveStateController({
        activeSessionId: () => "thread-1",
        conversationMessagesRef,
        panelEntriesRef,
        applyRestoredRuntime: jest.fn(),
        getRuntime: () => null,
        upsertRuntime: jest.fn(() => ({})),
        setPanelEntries: jest.fn(),
        createPanelSnapshot: (_panelId, base, patch) => ({ ...base, ...patch }),
        setActiveThreadStatus: jest.fn(),
        startRelay: jest.fn(() => true),
        onLiveStateNotRunning,
        log: jest.fn(),
      });
    });
  }

  it("notifies with the running belief when the active live state resolves idle", async () => {
    const onLiveStateNotRunning = jest.fn();
    const { result } = await buildController(onLiveStateNotRunning);

    result.current.applyActive({
      restored: restored(Promise.resolve({
        threadId: "thread-1",
        threadStatusType: "idle",
        hasRunningTurn: false,
        runningTurn: null,
      })),
      restoredMessages: [],
      nextSessionId: "thread-1",
      directory: "/workspace",
      effectiveContextUsedPct: null,
      restoreReplyRequestForThread: () => false,
      setReply: jest.fn(),
      requestStartedAtMsAtRestoreApply: 1234,
      executionGenerationAtRestoreApply: 0,
      isCurrent: () => true,
    });
    await act(async () => { await Promise.resolve(); });

    // restore適用時点でrunningと信じていた(request registered)のにidleで解決した
    // 完了レース窓。呼び出し側がJSONL再取得で閉じる(G2)。
    expect(onLiveStateNotRunning).toHaveBeenCalledWith({
      sessionId: "thread-1",
      panelId: "",
      hadRunningBelief: true,
      reason: "idle",
    });
  });

  it("notifies when the live state fetch fails (unavailable)", async () => {
    const onLiveStateNotRunning = jest.fn();
    const { result } = await buildController(onLiveStateNotRunning);

    result.current.applyPanel({
      restored: restored(Promise.resolve(null)),
      snapshot: snapshot(),
      panelId: "panel-1",
      directory: "/workspace",
      requestStartedAtMsAtHydrationStart: null,
      executionGenerationAtHydrationApply: 0,
      isCurrent: () => true,
    });
    await act(async () => { await Promise.resolve(); });

    expect(onLiveStateNotRunning).toHaveBeenCalledWith({
      sessionId: "thread-1",
      panelId: "panel-1",
      hadRunningBelief: false,
      reason: "unavailable",
    });
  });

  it("does not notify when the restore was superseded", async () => {
    const onLiveStateNotRunning = jest.fn();
    const { result } = await buildController(onLiveStateNotRunning);

    result.current.applyActive({
      restored: restored(Promise.resolve(null)),
      restoredMessages: [],
      nextSessionId: "thread-1",
      directory: "/workspace",
      effectiveContextUsedPct: null,
      restoreReplyRequestForThread: () => false,
      setReply: jest.fn(),
      requestStartedAtMsAtRestoreApply: 1234,
      executionGenerationAtRestoreApply: 0,
      isCurrent: () => false,
    });
    await act(async () => { await Promise.resolve(); });

    expect(onLiveStateNotRunning).not.toHaveBeenCalled();
  });
});
