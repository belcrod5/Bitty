import { useRef, useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { readCodexAppServerThread } from "../../codex/codexAppServerClient";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import type { ConversationMessage } from "../types/appTypes";
import type {
  RunnerSessionLiveState,
  RunnerSessionMessagesResult,
} from "./useLlmSessionExplorer";
import type { PanelRuntimeEntry } from "./usePanelNewSessionController";
import { useConversationRuntimeStoreController } from "./useConversationRuntimeStoreController";
import { useSessionLiveStateController } from "./useSessionLiveStateController";

jest.mock("../../codex/codexAppServerClient", () => ({
  readCodexAppServerThread: jest.fn(),
}));

const readThreadMock = jest.mocked(readCodexAppServerThread);

const disabledProbeOptions = {
  settingsLoaded: false,
  selectedSessionId: "thread-1",
  codexWsUrl: "",
  codexWsToken: "",
  backendId: "codex",
  runnerWebSocketManager: {} as any,
  resolveBackendId: () => "codex",
};

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

function activeRequest(startedAtMs: number) {
  return {
    requestId: `request-${startedAtMs}`,
    requestSeq: startedAtMs,
    sessionId: "thread-1",
    sourcePanelId: "panel-1",
    lifecycle: "active" as const,
    status: "model_processing",
    startedAtMs,
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
  const setActiveResponding = jest.fn();
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
    const controller = useSessionLiveStateController({
      ...disabledProbeOptions,
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
      setActiveResponding,
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
      return useSessionLiveStateController({
        ...disabledProbeOptions,
        activeSessionId: () => "thread-1",
        conversationMessagesRef,
        panelEntriesRef,
        applyRestoredRuntime: jest.fn(),
        getRuntime: () => null,
        upsertRuntime: jest.fn(() => ({})),
        setPanelEntries: jest.fn(),
        createPanelSnapshot: (_panelId, base, patch) => ({ ...base, ...patch }),
        setActiveResponding: jest.fn(),
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

describe("confirmed terminal live-state reconciliation", () => {
  async function buildReconciliationHarness(probeOptions = disabledProbeOptions) {
    const setActiveResponding = jest.fn();
    const setActiveThreadStatus = jest.fn();
    const log = jest.fn();
    const rendered = await renderHook(() => {
      const runtimeStore = useConversationRuntimeStoreController();
      const [entries, setEntries] = useState<Record<string, PanelRuntimeEntry>>({
        "panel-1": {
          sessionId: "thread-1",
          snapshot: {
            ...snapshot(),
            isResponding: true,
            selectedThreadStatusType: "active",
          },
        },
        "panel-2": {
          sessionId: "thread-1",
          snapshot: {
            ...snapshot(),
            panelId: "panel-2",
            isResponding: true,
            selectedThreadStatusType: "active",
          },
        },
      });
      const panelEntriesRef = useRef(entries);
      panelEntriesRef.current = entries;
      const controller = useSessionLiveStateController({
        ...probeOptions,
        activeSessionId: () => "thread-1",
        conversationMessagesRef: useRef<ConversationMessage[]>([
          { id: "message-1", role: "assistant", content: "latest" },
        ]),
        panelEntriesRef,
        applyRestoredRuntime: jest.fn(),
        getRuntime: runtimeStore.getConversationRuntimeSnapshot,
        upsertRuntime: runtimeStore.upsertConversationRuntimeSnapshot,
        setPanelEntries: setEntries,
        createPanelSnapshot: (_panelId, base, patch) => ({ ...base, ...patch }),
        setActiveResponding,
        setActiveThreadStatus,
        startRelay: jest.fn(() => true),
        log,
      });
      return { controller, entries, runtimeStore };
    });
    return { ...rendered, setActiveResponding, setActiveThreadStatus, log };
  }

  it("settles a restored running belief when the later probe confirms completion", async () => {
    const harness = await buildReconciliationHarness();
    await act(() => {
      harness.result.current.runtimeStore.upsertConversationRuntimeSnapshot({
        sessionId: "thread-1",
        conversationMessages: [{ id: "message-1", role: "assistant", content: "latest" }],
        isResponding: true,
        selectedThreadStatusType: "active",
        request: activeRequest(500),
      });
    });

    let applied = false;
    await act(() => {
      applied = harness.result.current.controller.applyProbe({
        sessionId: "thread-1",
        liveState: { threadStatusType: "idle", hasRunningTurn: false },
        probeStartedAtMs: 1_000,
      });
    });

    expect(applied).toBe(true);
    expect(harness.result.current.runtimeStore.getConversationRuntimeSnapshot("thread-1")).toMatchObject({
      isResponding: false,
      selectedThreadStatusType: "idle",
      request: null,
    });
    expect(harness.setActiveResponding).toHaveBeenCalledWith(false);
    expect(harness.setActiveThreadStatus).toHaveBeenCalledWith("idle");
    expect(harness.result.current.entries["panel-1"].snapshot).toMatchObject({
      isResponding: false,
      selectedThreadStatusType: "idle",
    });
    expect(harness.result.current.entries["panel-2"].snapshot).toMatchObject({
      isResponding: false,
      selectedThreadStatusType: "idle",
    });
  });

  it("settles the restore/probe race through the selected-session probe effect", async () => {
    let resolveProbe: ((value: Awaited<ReturnType<typeof readCodexAppServerThread>>) => void) | null = null;
    const probePromise = new Promise<Awaited<ReturnType<typeof readCodexAppServerThread>>>((resolve) => {
      resolveProbe = resolve;
    });
    readThreadMock.mockReturnValueOnce(probePromise);
    const harness = await buildReconciliationHarness({
      ...disabledProbeOptions,
      settingsLoaded: true,
      codexWsUrl: "ws://runner",
    });
    await act(() => {
      harness.result.current.runtimeStore.upsertConversationRuntimeSnapshot({
        sessionId: "thread-1",
        conversationMessages: [{ id: "message-1", role: "assistant", content: "latest" }],
        isResponding: true,
        selectedThreadStatusType: "active",
        request: activeRequest(500),
      });
    });

    await act(async () => {
      resolveProbe?.({
        threadId: "thread-1",
        preview: "",
        modelProvider: "codex",
        sourceKind: "cli",
        cwd: "/workspace",
        createdAt: "",
        updatedAt: "",
        messages: [],
        contextUsedPct: null,
        sessionState: "completed",
        threadStatusType: "idle",
        waitingOnApproval: false,
        latestTurnStatus: "completed",
        hasRunningTurn: false,
        runningTurn: null,
      });
      await probePromise;
    });

    await waitFor(() => {
      expect(harness.result.current.runtimeStore.getConversationRuntimeSnapshot("thread-1")).toMatchObject({
        isResponding: false,
        selectedThreadStatusType: "idle",
        request: null,
      });
      expect(harness.setActiveResponding).toHaveBeenCalledWith(false);
      expect(harness.result.current.entries["panel-1"].snapshot.isResponding).toBe(false);
    });
  });

  it("does not let an older terminal probe clear a request started after the probe", async () => {
    const harness = await buildReconciliationHarness();
    await act(() => {
      harness.result.current.runtimeStore.upsertConversationRuntimeSnapshot({
        sessionId: "thread-1",
        isResponding: true,
        selectedThreadStatusType: "active",
        request: activeRequest(1_100),
      });
    });

    let applied = true;
    await act(() => {
      applied = harness.result.current.controller.applyProbe({
        sessionId: "thread-1",
        liveState: { threadStatusType: "idle", hasRunningTurn: false },
        probeStartedAtMs: 1_000,
      });
    });

    expect(applied).toBe(false);
    expect(harness.result.current.runtimeStore.getConversationRuntimeSnapshot("thread-1")).toMatchObject({
      isResponding: true,
      selectedThreadStatusType: "active",
      request: { startedAtMs: 1_100 },
    });
    expect(harness.setActiveResponding).not.toHaveBeenCalled();
    expect(harness.result.current.entries["panel-1"].snapshot.isResponding).toBe(true);
    expect(harness.log).toHaveBeenCalledWith(
      "session_live_terminal_state_skipped",
      expect.objectContaining({ reason: "request_started_after_probe" }),
      { throttleMs: 0 }
    );
  });

  it("does not clear a confirmed running or approval state", async () => {
    const harness = await buildReconciliationHarness();
    await act(() => {
      harness.result.current.runtimeStore.upsertConversationRuntimeSnapshot({
        sessionId: "thread-1",
        isResponding: true,
        selectedThreadStatusType: "waiting_approval",
        request: activeRequest(500),
      });
      harness.result.current.controller.applyProbe({
        sessionId: "thread-1",
        liveState: { threadStatusType: "active", hasRunningTurn: true },
        probeStartedAtMs: 1_000,
      });
      harness.result.current.controller.applyProbe({
        sessionId: "thread-1",
        liveState: {
          threadStatusType: "active",
          sessionState: "completed",
          hasRunningTurn: false,
        },
        probeStartedAtMs: 1_000,
      });
    });

    expect(harness.result.current.runtimeStore.getConversationRuntimeSnapshot("thread-1")).toMatchObject({
      isResponding: true,
      request: { startedAtMs: 500 },
    });
    expect(harness.setActiveResponding).not.toHaveBeenCalled();
    expect(harness.result.current.entries["panel-1"].snapshot.isResponding).toBe(true);
  });

  it("does not clear an ambiguous non-running result", async () => {
    const harness = await buildReconciliationHarness();
    await act(() => {
      harness.result.current.runtimeStore.upsertConversationRuntimeSnapshot({
        sessionId: "thread-1",
        isResponding: true,
        selectedThreadStatusType: "active",
        request: activeRequest(500),
      });
      harness.result.current.controller.applyProbe({
        sessionId: "thread-1",
        liveState: { threadStatusType: "unknown", hasRunningTurn: false },
        probeStartedAtMs: 1_000,
      });
    });

    expect(harness.result.current.runtimeStore.getConversationRuntimeSnapshot("thread-1")).toMatchObject({
      isResponding: true,
      request: { startedAtMs: 500 },
    });
    expect(harness.setActiveResponding).not.toHaveBeenCalled();
  });
});
