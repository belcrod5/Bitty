import { act, renderHook } from "@testing-library/react-native";
import { useSessionRelayLossRecoveryController } from "./useSessionRelayLossRecoveryController";
import type { LlmUiStatus } from "./useLlmRequestStatus";

function baseArgs(overrides: Partial<Parameters<typeof useSessionRelayLossRecoveryController>[0]> = {}) {
  return {
    finalizeConversationRuntimeAfterRelayLoss: jest.fn(() => null),
    setSessionConversationMessagesForCodexRef: { current: jest.fn() },
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
    relayLossResyncMinIntervalMs: 5000,
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
});
