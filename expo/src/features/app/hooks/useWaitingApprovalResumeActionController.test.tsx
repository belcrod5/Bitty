import { act, renderHook } from "@testing-library/react-native";
import { useWaitingApprovalResumeActionController } from "./useWaitingApprovalResumeActionController";

test("waiting approval resume preserves the selected Agent backend", async () => {
  const startObserver = jest.fn(() => true);
  const selectedSessionBackendId = jest.fn(() => "claude");
  const args = {
    parseOptionalSessionId: (raw: unknown) => String(raw || "").trim(),
    selectedSessionId: () => "session-1",
    selectedSessionBackendId,
    waitingApprovalResumeLoading: false,
    waitingApprovalResumeCooldownUntilMsRef: { current: 0 },
    showChatBottomToast: jest.fn(),
    formatElapsedMmSs: jest.fn(() => "00:00"),
    normalizedLlmDirectoryForRequest: () => "/workspace",
    sessionRuntimeStatusByIdRef: {
      current: {
        "session-1": {
          hasRunningTurn: true,
          hasPendingAssistant: false,
          restoredInFlight: false,
          waitingApproval: true,
          updatedAtMs: Date.now(),
        },
      },
    },
    selectedSessionWaitingApproval: true,
    reloadActiveSession: jest.fn(),
    rememberSessionRuntimeStatus: jest.fn(),
    setWaitingApprovalResumeLoading: jest.fn(),
    setWaitingApprovalResumeStatusText: jest.fn(),
    waitingApprovalResumePendingSessionIdRef: { current: "" },
    clearWaitingApprovalResumeAttachTimer: jest.fn(),
    waitingApprovalResumeAttachTimerRef: { current: null },
    finishWaitingApprovalResumeAttempt: jest.fn(() => true),
    logSessionDiag: jest.fn(),
    waitingApprovalResumeAttachTimeoutMs: 5_000,
    setReplyDebug: jest.fn(),
    closeCodexRelayObserver: jest.fn(),
    startCodexRelayObserverForSession: startObserver,
    selectedSessionExecutionFactStartedAtMs: 1234,
  };
  const { result } = await renderHook(() => useWaitingApprovalResumeActionController(args));

  await act(async () => result.current.resumeWaitingApprovalForActiveSession());

  expect(selectedSessionBackendId).toHaveBeenCalledWith("session-1");
  expect(startObserver).toHaveBeenCalledWith("session-1", expect.objectContaining({
    directory: "/workspace",
    agentBackendId: "claude",
    startedAtMs: 1234,
    ignoreWatermark: true,
  }));
});
