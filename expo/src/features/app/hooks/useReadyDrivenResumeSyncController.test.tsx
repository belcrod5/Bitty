import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsConnectionSnapshot, RunnerWsConnectionState } from "../../runnerWs/types";
import { createResyncRateLimiter } from "../utils/resumeSync";
import { useReadyDrivenResumeSyncController } from "./useReadyDrivenResumeSyncController";

const READY_DEBOUNCE_MS = 250;

class FakeRunnerWebSocketManager {
  private handlers = new Set<() => void>();
  private snapshot = { connectionState: "connecting", generation: 0 } as RunnerWsConnectionSnapshot;

  subscribeSnapshot = (handler: () => void) => {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  };

  getSnapshot = () => this.snapshot;

  setState(connectionState: RunnerWsConnectionState, generation: number) {
    this.snapshot = { ...this.snapshot, connectionState, generation };
    for (const handler of this.handlers) {
      handler();
    }
  }
}

function panelEntry(sessionId: string, directory = "/repo", isResponding = false) {
  return {
    sessionId,
    snapshot: { selectedSessionId: sessionId, selectedDirectoryPath: directory, isResponding },
  } as never;
}

function baseArgs(overrides: Partial<Parameters<typeof useReadyDrivenResumeSyncController>[0]> = {}) {
  return {
    settingsLoaded: true,
    activeScreen: "mini_board" as const,
    codexWsUrl: "ws://127.0.0.1:8788/runner-ws",
    drawerSessionPopupPanelId: "",
    runnerWebSocketManager: new FakeRunnerWebSocketManager() as unknown as RunnerWebSocketManager,
    resyncRateLimiter: createResyncRateLimiter({
      perSessionMinIntervalMs: 5000,
      globalMaxPerWindow: 100,
    }),
    codexRelayObserverRef: { current: null },
    panelRuntimeEntriesByIdRef: { current: {} },
    selectedLlmSessionIdRef: { current: "session-1" },
    llmConversationSessionIdRef: { current: "" },
    replyLoadingRef: { current: false },
    streamSocketRef: { current: null },
    streamTtsControlRef: { current: null },
    llmSessionRestoreInFlightRef: { current: false },
    llmSessionRestoreLoadingRef: { current: false },
    startupSessionRestoreAttemptedRef: { current: true },
    normalizedLlmDirectoryForRequest: () => "/workspace",
    selectSpecificLlmSession: jest.fn().mockResolvedValue(true),
    hydratePanelFromSessionHistoryRef: { current: jest.fn().mockResolvedValue("applied" as const) },
    fetchLatestSessionIdForDirectory: jest.fn().mockResolvedValue(""),
    logSessionDiag: jest.fn(),
    ...overrides,
  };
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  // 再同期パス内のpromise連鎖をflushする。
  await act(async () => {});
}

describe("useReadyDrivenResumeSyncController", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("resyncs the selected session once per ready transition, preserving the live observer path", async () => {
    const args = baseArgs();
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    await renderHook(() => useReadyDrivenResumeSyncController(args));
    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();

    await act(async () => {
      manager.setState("ready", 1);
    });
    await advance(READY_DEBOUNCE_MS);

    expect(args.selectSpecificLlmSession).toHaveBeenCalledTimes(1);
    expect(args.selectSpecificLlmSession).toHaveBeenCalledWith("session-1", {
      source: "all",
      directory: "/workspace",
      preserveLiveObserver: true,
    });

    // 同一generationのready通知が繰り返されても再同期は1回のまま(coalesce)。
    await act(async () => {
      manager.setState("ready", 1);
    });
    await advance(READY_DEBOUNCE_MS);
    expect(args.selectSpecificLlmSession).toHaveBeenCalledTimes(1);

    // 新しいgeneration(再接続)では、レート制御の窓が過ぎていれば再同期する。
    await advance(5000);
    await act(async () => {
      manager.setState("reconnecting", 1);
      manager.setState("ready", 2);
    });
    await advance(READY_DEBOUNCE_MS);
    expect(args.selectSpecificLlmSession).toHaveBeenCalledTimes(2);
  });

  it("skips the selected session while its live relay observer is alive", async () => {
    const args = baseArgs({
      codexRelayObserverRef: { current: { threadId: "session-1", close: jest.fn() } },
    });
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    await renderHook(() => useReadyDrivenResumeSyncController(args));
    await act(async () => {
      manager.setState("ready", 1);
    });
    await advance(READY_DEBOUNCE_MS);

    // observer自身がready時にlastRelaySeqでrelay/resumeを送る(第一経路)ため、
    // ここからの全文再取得はしない。
    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();
  });

  it("rehydrates the popup panel session on ready", async () => {
    const args = baseArgs({
      drawerSessionPopupPanelId: "drawer_session_popup",
      panelRuntimeEntriesByIdRef: {
        current: {
          drawer_session_popup: panelEntry("session-2", "/repo"),
        },
      },
    });
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    await renderHook(() => useReadyDrivenResumeSyncController(args));
    await act(async () => {
      manager.setState("ready", 1);
    });
    await advance(READY_DEBOUNCE_MS);

    expect(args.hydratePanelFromSessionHistoryRef.current).toHaveBeenCalledWith(
      expect.objectContaining({
        panelId: "drawer_session_popup",
        sessionId: "session-2",
        directory: "/repo",
      })
    );
  });

  it("includes sessions that were responding at background transition", async () => {
    const handlers: Array<(state: string) => void> = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation(((_type: string, handler: (state: string) => void) => {
      handlers.push(handler);
      return { remove: jest.fn() };
    }) as never);
    const args = baseArgs({
      panelRuntimeEntriesByIdRef: {
        current: {
          "panel-a": panelEntry("session-3", "/repo", true),
        },
      },
    });
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    await renderHook(() => useReadyDrivenResumeSyncController(args));

    // バックグラウンド移行時点で応答中だったセッションを記録する。
    await act(async () => {
      for (const handler of handlers) handler("background");
    });
    // バックグラウンド中に完了し、復帰時にはisRespondingがfalseでも対象に含める(G2/G3)。
    args.panelRuntimeEntriesByIdRef.current = {
      "panel-a": panelEntry("session-3", "/repo", false),
    };

    await act(async () => {
      manager.setState("ready", 1);
    });
    await advance(READY_DEBOUNCE_MS);

    expect(args.hydratePanelFromSessionHistoryRef.current).toHaveBeenCalledWith(
      expect.objectContaining({
        panelId: "panel-a",
        sessionId: "session-3",
      })
    );
  });

  it("defers while a session restore is in flight and retries", async () => {
    const args = baseArgs({
      llmSessionRestoreLoadingRef: { current: true },
    });
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    await renderHook(() => useReadyDrivenResumeSyncController(args));
    await act(async () => {
      manager.setState("ready", 1);
    });
    await advance(READY_DEBOUNCE_MS);
    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();

    // restoreが終わったら、リトライで再同期する(旧実装の恒久スキップを廃止)。
    args.llmSessionRestoreLoadingRef.current = false;
    await advance(2000);
    expect(args.selectSpecificLlmSession).toHaveBeenCalledWith("session-1", {
      source: "all",
      directory: "/workspace",
      preserveLiveObserver: true,
    });
  });

  it("falls back to the latest session when nothing is selected", async () => {
    const args = baseArgs({
      selectedLlmSessionIdRef: { current: "" },
      fetchLatestSessionIdForDirectory: jest.fn().mockResolvedValue("session-9"),
    });
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    await renderHook(() => useReadyDrivenResumeSyncController(args));
    await act(async () => {
      manager.setState("ready", 1);
    });
    await advance(READY_DEBOUNCE_MS);

    expect(args.selectSpecificLlmSession).toHaveBeenCalledWith("session-9", {
      source: "all",
      directory: "/workspace",
    });
  });

  it("requestSessionResync refetches the selected session under the shared rate limit", async () => {
    const args = baseArgs();
    const { result } = await renderHook(() => useReadyDrivenResumeSyncController(args));

    let accepted = false;
    await act(async () => {
      accepted = result.current.requestSessionResync("session-1", { reason: "late_live_idle" });
    });
    expect(accepted).toBe(true);
    expect(args.selectSpecificLlmSession).toHaveBeenCalledWith("session-1", {
      source: "all",
      directory: "/workspace",
      preserveLiveObserver: true,
    });

    // 同一セッションの連続要求はレート制御で抑止される。
    let acceptedAgain = true;
    await act(async () => {
      acceptedAgain = result.current.requestSessionResync("session-1", { reason: "late_live_idle" });
    });
    expect(acceptedAgain).toBe(false);
    expect(args.selectSpecificLlmSession).toHaveBeenCalledTimes(1);
  });

  it("requestSessionResync rehydrates panels showing the session", async () => {
    const args = baseArgs({
      selectedLlmSessionIdRef: { current: "session-1" },
      panelRuntimeEntriesByIdRef: {
        current: {
          "panel-a": panelEntry("session-5", "/repo"),
        },
      },
    });
    const { result } = await renderHook(() => useReadyDrivenResumeSyncController(args));

    await act(async () => {
      result.current.requestSessionResync("session-5", { panelId: "panel-a", reason: "late_live_idle" });
    });
    expect(args.hydratePanelFromSessionHistoryRef.current).toHaveBeenCalledWith(
      expect.objectContaining({
        panelId: "panel-a",
        sessionId: "session-5",
        directory: "/repo",
      })
    );
    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();
  });
});
