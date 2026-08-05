import { act, renderHook } from "@testing-library/react-native";
import { createResyncRateLimiter } from "../utils/resumeSync";
import { useSessionRelayLossRecoveryController } from "./useSessionRelayLossRecoveryController";
import type { LlmUiStatus } from "./useLlmRequestStatus";

function baseArgs(overrides: Partial<Parameters<typeof useSessionRelayLossRecoveryController>[0]> = {}) {
  return {
    finalizeConversationRuntimeAfterRelayLoss: jest.fn(() => null),
    setSessionConversationMessagesForCodexRef: { current: jest.fn() },
    panelRuntimeEntriesByIdRef: { current: {} },
    hydratePanelFromSessionHistoryRef: { current: jest.fn().mockResolvedValue("applied" as const) },
    rememberSessionRuntimeStatus: jest.fn(),
    clearPendingApprovalsForSession: jest.fn(),
    clearToolAutoApprovalsForSession: jest.fn(),
    selectedLlmSessionId: "session-1",
    selectedLlmSessionIdRef: { current: "session-1" },
    llmConversationSessionIdRef: { current: "session-1" },
    setReplyLoadingWithRef: jest.fn(),
    setSelectedThreadStatusType: jest.fn(),
    llmUiStatusRef: { current: "model_generating" as LlmUiStatus },
    updateLlmStatus: jest.fn(),
    normalizedLlmDirectoryForRequest: () => "/workspace",
    selectSpecificLlmSession: jest.fn().mockResolvedValue(true),
    resyncRateLimiter: createResyncRateLimiter({ perSessionMinIntervalMs: 5000 }),
    logSessionDiag: jest.fn(),
    ...overrides,
  };
}

describe("useSessionRelayLossRecoveryController", () => {
  it("resyncs the visible session from the source of truth instead of pinning an error", async () => {
    const args = baseArgs();
    const { result } = await renderHook(() => useSessionRelayLossRecoveryController(args));

    await act(async () => {
      result.current.finalizeSessionRuntimeAfterRelayLoss("session-1", "relay lost");
    });

    expect(args.selectSpecificLlmSession).toHaveBeenCalledWith("session-1", {
      source: "all",
      directory: "/workspace",
    });
    expect(args.updateLlmStatus).not.toHaveBeenCalled();
    expect(args.rememberSessionRuntimeStatus).toHaveBeenCalledWith("session-1", {
      hasRunningTurn: false,
      hasPendingAssistant: false,
      restoredInFlight: false,
      waitingApproval: false,
    });
    expect(args.setReplyLoadingWithRef).toHaveBeenCalledWith(false);
    expect(args.setSelectedThreadStatusType).toHaveBeenCalledWith("idle");
  });

  it("pins the error status only when the resync fails", async () => {
    const args = baseArgs({
      selectSpecificLlmSession: jest.fn().mockResolvedValue(false),
    });
    const { result } = await renderHook(() => useSessionRelayLossRecoveryController(args));

    await act(async () => {
      result.current.finalizeSessionRuntimeAfterRelayLoss("session-1", "relay lost");
    });

    expect(args.selectSpecificLlmSession).toHaveBeenCalledTimes(1);
    expect(args.updateLlmStatus).toHaveBeenCalledWith("error", "relay lost");
  });

  it("throttles repeated losses per session to prevent a resync/relay-restart loop", async () => {
    const args = baseArgs();
    const { result } = await renderHook(() => useSessionRelayLossRecoveryController(args));

    await act(async () => {
      result.current.finalizeSessionRuntimeAfterRelayLoss("session-1", "relay lost");
    });
    await act(async () => {
      result.current.finalizeSessionRuntimeAfterRelayLoss("session-1", "relay lost again");
    });

    // 2度目はクールダウン内なので再同期せず、従来どおりエラー固定に落とす。
    expect(args.selectSpecificLlmSession).toHaveBeenCalledTimes(1);
    expect(args.updateLlmStatus).toHaveBeenCalledWith("error", "relay lost again");
  });

  it("does not resync or touch the visible chat state for non-visible sessions", async () => {
    const args = baseArgs();
    const { result } = await renderHook(() => useSessionRelayLossRecoveryController(args));

    await act(async () => {
      result.current.finalizeSessionRuntimeAfterRelayLoss("session-other", "relay lost");
    });

    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();
    expect(args.updateLlmStatus).not.toHaveBeenCalled();
    expect(args.setReplyLoadingWithRef).not.toHaveBeenCalled();
    // ランタイム側の後始末は可視性に関係なく行う。
    expect(args.rememberSessionRuntimeStatus).toHaveBeenCalledWith("session-other", {
      hasRunningTurn: false,
      hasPendingAssistant: false,
      restoredInFlight: false,
      waitingApproval: false,
    });
    expect(args.clearPendingApprovalsForSession).toHaveBeenCalledWith("session-other");
  });

  it("rehydrates panels showing the lost session instead of pinning stale runtime messages", async () => {
    const args = baseArgs({
      finalizeConversationRuntimeAfterRelayLoss: jest.fn(() => ({
        snapshot: { conversationMessages: [{ id: "m1", role: "assistant", content: "stale" }] },
        reason: "relay lost",
        cancelledPendingApprovals: 0,
      })) as never,
      panelRuntimeEntriesByIdRef: {
        current: {
          skia_mini_preview_1: {
            sessionId: "session-2",
            snapshot: { selectedSessionId: "session-2", selectedDirectoryPath: "/repo" },
          } as never,
        },
      },
    });
    const { result } = await renderHook(() => useSessionRelayLossRecoveryController(args));

    await act(async () => {
      result.current.finalizeSessionRuntimeAfterRelayLoss("session-2", "relay lost");
    });

    expect(args.hydratePanelFromSessionHistoryRef.current).toHaveBeenCalledWith({
      panelId: "skia_mini_preview_1",
      sessionId: "session-2",
      directory: "/repo",
      diagnosticCycleId: expect.any(String),
    });
    // パネル表示中は喪失時点のruntimeメッセージで固定しない。
    expect(args.setSessionConversationMessagesForCodexRef.current).not.toHaveBeenCalled();
    // 非可視セッションなのでメインチャットの再同期は走らない。
    expect(args.selectSpecificLlmSession).not.toHaveBeenCalled();
  });

  it("falls back to pinning the finalized messages when the panel rehydrate fails", async () => {
    const staleMessages = [{ id: "m1", role: "assistant", content: "stale" }];
    const args = baseArgs({
      finalizeConversationRuntimeAfterRelayLoss: jest.fn(() => ({
        snapshot: { conversationMessages: staleMessages },
        reason: "relay lost",
        cancelledPendingApprovals: 0,
      })) as never,
      hydratePanelFromSessionHistoryRef: { current: jest.fn().mockResolvedValue("failed" as const) },
      panelRuntimeEntriesByIdRef: {
        current: {
          skia_mini_preview_1: {
            sessionId: "session-2",
            snapshot: { selectedSessionId: "session-2", selectedDirectoryPath: "/repo" },
          } as never,
        },
      },
    });
    const { result } = await renderHook(() => useSessionRelayLossRecoveryController(args));

    await act(async () => {
      result.current.finalizeSessionRuntimeAfterRelayLoss("session-2", "relay lost");
    });

    // 応答中表示のまま残さないよう、従来どおりのidle固定へフォールバックする。
    expect(args.setSessionConversationMessagesForCodexRef.current).toHaveBeenCalledWith(
      "session-2",
      staleMessages,
      { isResponding: false, selectedThreadStatusType: "idle", sessionId: "session-2" }
    );
  });

  it("throttles repeated panel rehydrates per session", async () => {
    const args = baseArgs({
      finalizeConversationRuntimeAfterRelayLoss: jest.fn(() => ({
        snapshot: { conversationMessages: [{ id: "m1", role: "assistant", content: "stale" }] },
        reason: "relay lost",
        cancelledPendingApprovals: 0,
      })) as never,
      panelRuntimeEntriesByIdRef: {
        current: {
          skia_mini_preview_1: {
            sessionId: "session-2",
            snapshot: { selectedSessionId: "session-2", selectedDirectoryPath: "/repo" },
          } as never,
        },
      },
    });
    const { result } = await renderHook(() => useSessionRelayLossRecoveryController(args));

    await act(async () => {
      result.current.finalizeSessionRuntimeAfterRelayLoss("session-2", "relay lost");
    });
    await act(async () => {
      result.current.finalizeSessionRuntimeAfterRelayLoss("session-2", "relay lost again");
    });

    expect(args.hydratePanelFromSessionHistoryRef.current).toHaveBeenCalledTimes(1);
    // クールダウン内の2度目は従来どおりの固定に落とす。
    expect(args.setSessionConversationMessagesForCodexRef.current).toHaveBeenCalledTimes(1);
  });

  it("skips the error pin when the visible status is not active", async () => {
    const args = baseArgs({
      llmUiStatusRef: { current: "idle" as LlmUiStatus },
      selectSpecificLlmSession: jest.fn().mockResolvedValue(false),
    });
    const { result } = await renderHook(() => useSessionRelayLossRecoveryController(args));

    await act(async () => {
      result.current.finalizeSessionRuntimeAfterRelayLoss("session-1", "relay lost");
    });

    expect(args.updateLlmStatus).not.toHaveBeenCalled();
  });

  it("retries a resync deferred by the global budget once a slot frees up", async () => {
    jest.useFakeTimers();
    try {
      const limiter = createResyncRateLimiter({
        perSessionMinIntervalMs: 5000,
        globalWindowMs: 10_000,
        globalMaxPerWindow: 1,
      });
      // 他セッションが直前に合算枠を使い切った状態(多数セッション同時lossの7個目以降)。
      limiter.recordResync("session-other");
      const args = baseArgs({
        resyncRateLimiter: limiter,
        finalizeConversationRuntimeAfterRelayLoss: jest.fn(() => ({
          snapshot: { conversationMessages: [{ id: "m1", role: "assistant", content: "stale" }] },
          reason: "relay lost",
          cancelledPendingApprovals: 0,
        })) as never,
        panelRuntimeEntriesByIdRef: {
          current: {
            skia_mini_preview_1: {
              sessionId: "session-2",
              snapshot: { selectedSessionId: "session-2", selectedDirectoryPath: "/repo" },
            } as never,
          },
        },
      });
      const { result } = await renderHook(() => useSessionRelayLossRecoveryController(args));

      await act(async () => {
        result.current.finalizeSessionRuntimeAfterRelayLoss("session-2", "relay lost");
      });
      // 枠超過なので即時の再同期はなし(従来どおりの固定にフォールバック)。
      expect(args.hydratePanelFromSessionHistoryRef.current).not.toHaveBeenCalled();

      // 枠が空く時刻(グローバル窓経過)にone-shot再試行が走り、古いままにならない(M-6)。
      await act(async () => {
        jest.advanceTimersByTime(10_200);
      });
      await act(async () => {});
      expect(args.hydratePanelFromSessionHistoryRef.current).toHaveBeenCalledWith(
        expect.objectContaining({
          panelId: "skia_mini_preview_1",
          sessionId: "session-2",
          directory: "/repo",
        })
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
