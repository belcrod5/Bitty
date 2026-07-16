import { act, renderHook } from "@testing-library/react-native";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsConnectionSnapshot, RunnerWsConnectionState } from "../../runnerWs/types";
import { useSessionStartupRecoveryController } from "./useSessionStartupRecoveryController";

class FakeRunnerWebSocketManager {
  private handlers = new Set<() => void>();
  private snapshot = { connectionState: "connecting" } as RunnerWsConnectionSnapshot;

  subscribeSnapshot = (handler: () => void) => {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  };

  getSnapshot = () => this.snapshot;

  setConnectionState(connectionState: RunnerWsConnectionState) {
    this.snapshot = { ...this.snapshot, connectionState };
    for (const handler of this.handlers) {
      handler();
    }
  }
}

function baseArgs(overrides: Partial<Parameters<typeof useSessionStartupRecoveryController>[0]> = {}) {
  return {
    settingsLoaded: true,
    runnerWebSocketManager: new FakeRunnerWebSocketManager() as unknown as RunnerWebSocketManager,
    startupSessionRestoreAttemptedRef: { current: false },
    conversationMessagesRef: { current: [] },
    codexWsUrl: "ws://127.0.0.1:8788/runner-ws",
    normalizedLlmDirectoryForRequest: () => "/workspace",
    parseOptionalSessionId: (raw: unknown) => String(raw || "").trim(),
    selectedLlmSessionId: "session-1",
    getLlmConversationSessionId: () => "",
    selectSpecificLlmSession: jest.fn().mockResolvedValue(true),
    fetchLatestSessionIdForDirectory: jest.fn().mockResolvedValue(""),
    clearSelectedLlmSession: jest.fn(),
    setLlmSessionRestoreError: jest.fn(),
    activeScreen: "mini_board" as const,
    llmSessionRestoreLoading: false,
    replyLoadingRef: { current: false },
    streamSocketRef: { current: null },
    streamTtsControlRef: { current: null },
    appResumeSessionSyncInFlightRef: { current: false },
    appResumeSessionSyncLastAtRef: { current: 0 },
    setReplyDebug: jest.fn(),
    logSessionDiag: jest.fn(),
    llmDirectory: "/workspace",
    llmBackend: "codex_app_server" as const,
    codexWsToken: "runner-token",
    ...overrides,
  };
}

describe("useSessionStartupRecoveryController startup restore", () => {
  it("waits for the runner WebSocket ready barrier before restoring the session", async () => {
    const args = baseArgs();
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    await renderHook(() => useSessionStartupRecoveryController(args));

    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();
    expect(args.startupSessionRestoreAttemptedRef.current).toBe(false);

    await act(async () => {
      manager.setConnectionState("ready");
    });

    expect(args.selectSpecificLlmSession).toHaveBeenCalledWith("session-1", {
      source: "all",
      directory: "/workspace",
    });
    expect(args.startupSessionRestoreAttemptedRef.current).toBe(true);
  });

  it("re-runs a failed startup restore on the next ready transition until it succeeds", async () => {
    const selectSpecificLlmSession = jest.fn()
      .mockRejectedValueOnce(new Error("runner_ws_request_timeout"))
      .mockResolvedValue(true);
    const args = baseArgs({ selectSpecificLlmSession });
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    await renderHook(() => useSessionStartupRecoveryController(args));

    await act(async () => {
      manager.setConnectionState("ready");
    });
    expect(selectSpecificLlmSession).toHaveBeenCalledTimes(1);
    expect(args.setLlmSessionRestoreError).toHaveBeenCalledWith("runner_ws_request_timeout");
    expect(args.startupSessionRestoreAttemptedRef.current).toBe(false);

    await act(async () => {
      manager.setConnectionState("reconnecting");
    });
    await act(async () => {
      manager.setConnectionState("ready");
    });

    expect(selectSpecificLlmSession).toHaveBeenCalledTimes(2);
    expect(args.startupSessionRestoreAttemptedRef.current).toBe(true);

    // Later ready transitions must not restore again once it succeeded.
    await act(async () => {
      manager.setConnectionState("reconnecting");
    });
    await act(async () => {
      manager.setConnectionState("ready");
    });
    expect(selectSpecificLlmSession).toHaveBeenCalledTimes(2);
  });

  it("marks restore done without fetching when the conversation already has messages", async () => {
    const args = baseArgs({
      conversationMessagesRef: { current: [{ id: "m1" }] as never },
    });
    const manager = args.runnerWebSocketManager as unknown as FakeRunnerWebSocketManager;

    await renderHook(() => useSessionStartupRecoveryController(args));
    await act(async () => {
      manager.setConnectionState("ready");
    });

    expect(args.startupSessionRestoreAttemptedRef.current).toBe(true);
    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();
  });
});
