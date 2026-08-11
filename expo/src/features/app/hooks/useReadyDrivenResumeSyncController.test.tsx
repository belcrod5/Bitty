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
    activeScreen: "skia_board" as const,
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
    hasActiveClientTurnForSession: jest.fn().mockReturnValue(false),
    selectSpecificLlmSession: jest.fn().mockResolvedValue(true),
    hydratePanelFromSessionHistoryRef: { current: jest.fn().mockResolvedValue("applied" as const) },
    fetchLatestSessionIdForDirectory: jest.fn().mockResolvedValue(""),
    markSessionReadAsync: jest.fn(),
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

// 実機のAppRootでは selectSpecificLlmSession 等が毎レンダー新規生成される。
// その再レンダーを模擬するため、同じmockへ委譲する新しい関数identityでpropsを作り直す。
function unstableClone(args: ReturnType<typeof baseArgs>): ReturnType<typeof baseArgs> {
  return {
    ...args,
    selectSpecificLlmSession: ((...params: unknown[]) => (
      (args.selectSpecificLlmSession as unknown as (...p: unknown[]) => Promise<boolean>)(...params)
    )) as never,
    fetchLatestSessionIdForDirectory: ((...params: unknown[]) => (
      (args.fetchLatestSessionIdForDirectory as unknown as (...p: unknown[]) => Promise<string>)(...params)
    )) as never,
    normalizedLlmDirectoryForRequest: () => args.normalizedLlmDirectoryForRequest(),
    logSessionDiag: ((...params: unknown[]) => (
      (args.logSessionDiag as unknown as (...p: unknown[]) => void)(...params)
    )) as never,
  };
}

describe("useReadyDrivenResumeSyncController", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    AppState.currentState = "active";
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

  it("coalesces multiple ready generations inside the debounce window into one pass", async () => {
    const args = baseArgs();
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    await renderHook(() => useReadyDrivenResumeSyncController(args));
    // 250ms以内にready遷移が連続(フラップ)しても、再同期パスは1回だけ走る。
    await act(async () => {
      manager.setState("ready", 1);
      manager.setState("reconnecting", 1);
      manager.setState("ready", 2);
      manager.setState("reconnecting", 2);
      manager.setState("ready", 3);
    });
    await advance(READY_DEBOUNCE_MS);

    expect(args.selectSpecificLlmSession).toHaveBeenCalledTimes(1);
  });

  it("does not resync or mark visible sessions while the app is backgrounded", async () => {
    AppState.currentState = "background";
    const args = baseArgs({
      drawerSessionPopupPanelId: "drawer_session_popup",
      panelRuntimeEntriesByIdRef: {
        current: { drawer_session_popup: panelEntry("session-2", "/repo") },
      },
    });
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;
    await renderHook(() => useReadyDrivenResumeSyncController(args));
    await act(async () => manager.setState("ready", 1));
    await advance(READY_DEBOUNCE_MS);
    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();
    expect(args.hydratePanelFromSessionHistoryRef.current).not.toHaveBeenCalled();
    expect(args.markSessionReadAsync).not.toHaveBeenCalled();
  });

  it("skips the selected session without marking a Skia board selection read", async () => {
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
    expect(args.markSessionReadAsync).not.toHaveBeenCalled();
  });

  it("skips the selected session while a turn request is in flight (turn.ts owns the seq resume)", async () => {
    const args = baseArgs({
      replyLoadingRef: { current: true },
      panelRuntimeEntriesByIdRef: {
        current: {
          "panel-a": panelEntry("session-3", "/repo", true),
        },
      },
    });
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    await renderHook(() => useReadyDrivenResumeSyncController(args));
    await act(async () => {
      manager.setState("ready", 1);
    });
    await advance(READY_DEBOUNCE_MS);

    // in-flight turnはturn.ts自身のws_reconnect_resume(seq resume)が無傷復旧する。
    // ここで全文再取得+quiesceするとストリームUI・TTSを壊す(High-2)。
    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();
    // 他セッションのパネル再同期は影響を受けない。
    expect(args.hydratePanelFromSessionHistoryRef.current).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-3", panelId: "panel-a" })
    );
  });

  it("skips panels whose session has an in-flight client turn and resyncs them after the turn ends", async () => {
    const args = baseArgs({
      drawerSessionPopupPanelId: "drawer_session_popup",
      panelRuntimeEntriesByIdRef: {
        current: {
          drawer_session_popup: panelEntry("session-3", "/repo", true),
        },
      },
      hasActiveClientTurnForSession: jest.fn((sessionId: string) => sessionId === "session-3"),
    });
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    const { result } = await renderHook(() => useReadyDrivenResumeSyncController(args));
    // observer強奪補償と同様にrespondingマーカーが積まれている状況(G2)。
    await act(async () => {
      result.current.markSessionRespondingForResync("session-3");
    });
    await act(async () => {
      manager.setState("ready", 1);
    });
    await advance(READY_DEBOUNCE_MS);

    // ストリーミング中のパネルはturn.ts自身のws_reconnect_resume(seq resume)が復旧する。
    // ready passで全文再取得するとストリーム表示を上書きしてしまう。
    expect(args.hydratePanelFromSessionHistoryRef.current).not.toHaveBeenCalled();
    // スキップではrespondingマーカー(G2)を消費しない(turn完了後の回収経路を保つ)。
    expect(result.current.wasRespondingAtBackground("session-3")).toBe(true);

    // turn終了後の次のready遷移では従来どおり再hydrateされる。
    (args.hasActiveClientTurnForSession as jest.Mock).mockReturnValue(false);
    await advance(5000);
    await act(async () => {
      manager.setState("reconnecting", 1);
      manager.setState("ready", 2);
    });
    await advance(READY_DEBOUNCE_MS);
    expect(args.hydratePanelFromSessionHistoryRef.current).toHaveBeenCalledWith(
      expect.objectContaining({ panelId: "drawer_session_popup", sessionId: "session-3" })
    );
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
    expect(args.markSessionReadAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-2",
      directory: "/repo",
      readTrigger: "visible_resume",
    }));
  });

  it("applies one rate-limit slot per session across the selected chat and all its panels", async () => {
    const args = baseArgs({
      drawerSessionPopupPanelId: "drawer_session_popup",
      panelRuntimeEntriesByIdRef: {
        current: {
          drawer_session_popup: panelEntry("session-1", "/repo"),
        },
      },
    });
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    await renderHook(() => useReadyDrivenResumeSyncController(args));
    await act(async () => {
      manager.setState("ready", 1);
    });
    await advance(READY_DEBOUNCE_MS);

    // popupがselectedと同一セッションでも、選択チャットとpopupパネルの両方へ反映する(M-5)。
    expect(args.selectSpecificLlmSession).toHaveBeenCalledWith("session-1", expect.objectContaining({
      preserveLiveObserver: true,
    }));
    expect(args.hydratePanelFromSessionHistoryRef.current).toHaveBeenCalledWith(
      expect.objectContaining({
        panelId: "drawer_session_popup",
        sessionId: "session-1",
      })
    );
    expect(args.markSessionReadAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      directory: "/repo",
      readTrigger: "visible_resume",
    }));
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
    expect(args.markSessionReadAsync).not.toHaveBeenCalled();
  });

  it("marks an actually visible popup read when its live observer resumes", async () => {
    const args = baseArgs({
      drawerSessionPopupPanelId: "drawer_session_popup",
      codexRelayObserverRef: { current: { threadId: "session-3", close: jest.fn() } },
      panelRuntimeEntriesByIdRef: {
        current: {
          drawer_session_popup: panelEntry("session-3", "/repo", true),
        },
      },
    });
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    await renderHook(() => useReadyDrivenResumeSyncController(args));
    await act(async () => {
      manager.setState("ready", 1);
    });
    await advance(READY_DEBOUNCE_MS);

    // live observer自身が内容を復旧するため履歴hydrateは不要だが、実際に開いている
    // popupは閲覧済み。Skia previewは同じlive observer経路でも既読化しない。
    expect(args.hydratePanelFromSessionHistoryRef.current).not.toHaveBeenCalled();
    expect(args.markSessionReadAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-3",
      directory: "/repo",
      readTrigger: "visible_resume",
    }));
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

  it("skips a session the relay-loss recovery just resynced (shared limiter coalesces the two paths)", async () => {
    const args = baseArgs();
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;
    // relay-loss回復(#40経路)が直前に同じlimiterでsession-1を再同期した状況。
    args.resyncRateLimiter.recordResync("session-1");

    await renderHook(() => useReadyDrivenResumeSyncController(args));
    await act(async () => {
      manager.setState("ready", 1);
    });
    await advance(READY_DEBOUNCE_MS);

    // 5秒以内のready遷移では再取得しない(直前のresyncで既に新鮮)。
    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();
    expect(args.logSessionDiag).toHaveBeenCalledWith(
      "resume_sync_rate_limited",
      expect.objectContaining({ sessionId: "session-1" }),
      expect.anything()
    );
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
  });

  it("defers a late-live refetch blocked by a just-recorded resync and fires it at unlock (no drop)", async () => {
    const args = baseArgs();
    const { result } = await renderHook(() => useReadyDrivenResumeSyncController(args));

    // ready passがselectedをrecordResyncした直後にlive metaがidle解決するのがG2の典型。
    // per-session間隔で即時拒否されても、解除時刻のone-shotリトライで必ず再取得する(High-1)。
    args.resyncRateLimiter.recordResync("session-1");
    let accepted = true;
    await act(async () => {
      accepted = result.current.requestSessionResync("session-1", { reason: "late_live_idle" });
    });
    expect(accepted).toBe(false);
    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();

    // per-session間隔(5000ms)解除後にリトライが発火する。
    await advance(5100);
    expect(args.selectSpecificLlmSession).toHaveBeenCalledWith("session-1", {
      source: "all",
      directory: "/workspace",
      preserveLiveObserver: true,
    });
  });

  it("requestSessionResync rehydrates every panel showing the session", async () => {
    const args = baseArgs({
      selectedLlmSessionIdRef: { current: "session-1" },
      panelRuntimeEntriesByIdRef: {
        current: {
          "panel-a": panelEntry("session-5", "/repo"),
          "panel-b": panelEntry("session-5", "/repo"),
        },
      },
    });
    const { result } = await renderHook(() => useReadyDrivenResumeSyncController(args));

    await act(async () => {
      result.current.requestSessionResync("session-5", { panelId: "panel-a", reason: "late_live_idle" });
    });
    // panelIdはヒント扱いで、同一セッションの全可視パネルへ反映する(#40経路と同じ扱い)。
    expect(args.hydratePanelFromSessionHistoryRef.current).toHaveBeenCalledWith(
      expect.objectContaining({ panelId: "panel-a", sessionId: "session-5", directory: "/repo" })
    );
    expect(args.hydratePanelFromSessionHistoryRef.current).toHaveBeenCalledWith(
      expect.objectContaining({ panelId: "panel-b", sessionId: "session-5", directory: "/repo" })
    );
    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();
    expect(args.markSessionReadAsync).not.toHaveBeenCalled();
  });

  it("fires the ready-driven resync even when re-renders follow the ready transition", async () => {
    const args = baseArgs();
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;
    const { rerender } = await renderHook(
      (props: ReturnType<typeof baseArgs>) => useReadyDrivenResumeSyncController(props),
      { initialProps: args }
    );

    await act(async () => {
      manager.setState("ready", 1);
    });
    // ready遷移はconnectionState変化で必ず再レンダーを伴う。毎レンダー新規生成の
    // 関数identityでもdebounceタイマーが破棄されないこと(Critical回帰テスト)。
    await act(async () => {
      rerender(unstableClone(args));
    });
    await act(async () => {
      rerender(unstableClone(args));
    });
    await advance(READY_DEBOUNCE_MS);

    expect(args.selectSpecificLlmSession).toHaveBeenCalledTimes(1);
    expect(args.selectSpecificLlmSession).toHaveBeenCalledWith("session-1", {
      source: "all",
      directory: "/workspace",
      preserveLiveObserver: true,
    });
  });

  it("keeps the deferred late-live retry alive across re-renders", async () => {
    const args = baseArgs();
    const { result, rerender } = await renderHook(
      (props: ReturnType<typeof baseArgs>) => useReadyDrivenResumeSyncController(props),
      { initialProps: args }
    );

    args.resyncRateLimiter.recordResync("session-1");
    await act(async () => {
      result.current.requestSessionResync("session-1", { reason: "late_live_idle" });
    });
    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();

    // one-shotリトライタイマーは再レンダーを跨いで生存する(unmount時のみ破棄)。
    await act(async () => {
      rerender(unstableClone(args));
    });
    await advance(5100);

    expect(args.selectSpecificLlmSession).toHaveBeenCalledWith("session-1", {
      source: "all",
      directory: "/workspace",
      preserveLiveObserver: true,
    });
  });

  it("marks observer-preempted sessions so a later pass resyncs them", async () => {
    const args = baseArgs({
      panelRuntimeEntriesByIdRef: {
        current: {
          "panel-a": panelEntry("session-7", "/repo", false),
        },
      },
    });
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;
    const { result } = await renderHook(() => useReadyDrivenResumeSyncController(args));

    // observer強奪の補償: clean closeされた側をマークしておくと、
    // 次のready遷移でパネル再同期の対象になる(M-4)。
    await act(async () => {
      result.current.markSessionRespondingForResync("session-7");
    });
    expect(result.current.wasRespondingAtBackground("session-7")).toBe(true);

    await act(async () => {
      manager.setState("ready", 1);
    });
    await advance(READY_DEBOUNCE_MS);
    expect(args.hydratePanelFromSessionHistoryRef.current).toHaveBeenCalledWith(
      expect.objectContaining({ panelId: "panel-a", sessionId: "session-7" })
    );
  });
});
