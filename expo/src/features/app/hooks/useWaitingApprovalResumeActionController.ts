import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { SessionRuntimeStatus } from "../types/appTypes";

type StartCodexRelayObserverForSessionOptions = {
  directory?: string;
  startedAtMs?: number | null;
  resumeFromSeq?: number;
  reason?: string;
  panelId?: string;
};

type UseWaitingApprovalResumeActionControllerArgs = {
  parseOptionalSessionId: (raw: unknown) => string;
  selectedSessionId: () => unknown;
  waitingApprovalResumeLoading: boolean;
  waitingApprovalResumeCooldownUntilMsRef: MutableRefObject<number>;
  showChatBottomToast: (role: "user" | "assistant", textRaw: string) => void;
  formatElapsedMmSs: (elapsedMs: number) => string;
  normalizedLlmDirectoryForRequest: () => string;
  sessionRuntimeStatusByIdRef: MutableRefObject<Record<string, SessionRuntimeStatus>>;
  selectedSessionWaitingApproval: boolean;
  reloadActiveSession: (source?: "mini_board" | "drawer" | "session_modal") => void;
  rememberSessionRuntimeStatus: (
    sessionIdRaw: unknown,
    status: Omit<SessionRuntimeStatus, "updatedAtMs">
  ) => void;
  setWaitingApprovalResumeLoading: Dispatch<SetStateAction<boolean>>;
  setWaitingApprovalResumeStatusText: Dispatch<SetStateAction<string>>;
  waitingApprovalResumePendingSessionIdRef: MutableRefObject<string>;
  clearWaitingApprovalResumeAttachTimer: () => void;
  waitingApprovalResumeAttachTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  finishWaitingApprovalResumeAttempt: (sessionIdRaw: unknown, reason: string) => boolean;
  logSessionDiag: (
    event: string,
    payload?: Record<string, unknown>,
    options?: {
      detailed?: boolean;
      throttleMs?: number;
      throttleKey?: string;
    }
  ) => void;
  waitingApprovalResumeAttachTimeoutMs: number;
  setReplyDebug: Dispatch<SetStateAction<string>>;
  closeCodexRelayObserver: (reason: string) => void;
  startCodexRelayObserverForSession: (
    threadIdRaw: unknown,
    options?: StartCodexRelayObserverForSessionOptions
  ) => boolean;
  selectedSessionExecutionFactStartedAtMs: number | null | undefined;
};

export function useWaitingApprovalResumeActionController({
  parseOptionalSessionId,
  selectedSessionId,
  waitingApprovalResumeLoading,
  waitingApprovalResumeCooldownUntilMsRef,
  showChatBottomToast,
  formatElapsedMmSs,
  normalizedLlmDirectoryForRequest,
  sessionRuntimeStatusByIdRef,
  selectedSessionWaitingApproval,
  reloadActiveSession,
  rememberSessionRuntimeStatus,
  setWaitingApprovalResumeLoading,
  setWaitingApprovalResumeStatusText,
  waitingApprovalResumePendingSessionIdRef,
  clearWaitingApprovalResumeAttachTimer,
  waitingApprovalResumeAttachTimerRef,
  finishWaitingApprovalResumeAttempt,
  logSessionDiag,
  waitingApprovalResumeAttachTimeoutMs,
  setReplyDebug,
  closeCodexRelayObserver,
  startCodexRelayObserverForSession,
  selectedSessionExecutionFactStartedAtMs,
}: UseWaitingApprovalResumeActionControllerArgs) {
  const resumeWaitingApprovalForActiveSession = useCallback(() => {
    const nowMs = Date.now();
    const sessionId = parseOptionalSessionId(selectedSessionId());
    if (!sessionId || waitingApprovalResumeLoading) return;
    if (nowMs < waitingApprovalResumeCooldownUntilMsRef.current) {
      const waitMs = Math.max(0, waitingApprovalResumeCooldownUntilMsRef.current - nowMs);
      showChatBottomToast("assistant", `再試行まで ${formatElapsedMmSs(waitMs)} お待ちください。`);
      return;
    }
    const directory = normalizedLlmDirectoryForRequest();
    const resumeStatus = sessionRuntimeStatusByIdRef.current[sessionId];
    const waitingApprovalExpected = Boolean(
      resumeStatus?.waitingApproval || selectedSessionWaitingApproval
    );
    if (!waitingApprovalExpected) {
      showChatBottomToast("assistant", "承認待ち状態を再確認するため、セッションを再読み込みします。");
      reloadActiveSession("mini_board");
      return;
    }
    rememberSessionRuntimeStatus(sessionId, {
      hasRunningTurn: resumeStatus?.hasRunningTurn ?? true,
      hasPendingAssistant: resumeStatus?.hasPendingAssistant ?? false,
      restoredInFlight: false,
      waitingApproval: true,
    });
    setWaitingApprovalResumeLoading(true);
    setWaitingApprovalResumeStatusText("session runtime player を接続しています...");
    waitingApprovalResumePendingSessionIdRef.current = sessionId;
    clearWaitingApprovalResumeAttachTimer();
    logSessionDiag("session_waiting_approval_resume_requested", {
      sessionId,
      directory,
      route: "session_runtime_player",
    }, {
      throttleMs: 0,
      throttleKey: `session_waiting_approval_resume_requested:${sessionId}`,
    });
    setReplyDebug((prev) => (
      prev
        ? `${prev} | waiting_approval_resume_requested session=${sessionId}`
        : `waiting_approval_resume_requested session=${sessionId}`
    ));
    const attached = startCodexRelayObserverForSession(sessionId, {
      directory,
      startedAtMs: Number(selectedSessionExecutionFactStartedAtMs || 0) || Date.now(),
      resumeFromSeq: 0,
      reason: "session_restored_running_turn",
    });
    if (!attached) {
      finishWaitingApprovalResumeAttempt(sessionId, "observer_start_failed");
      setWaitingApprovalResumeStatusText("承認待ち再開に失敗しました。");
      showChatBottomToast("assistant", "承認再開に失敗しました。セッションを再読み込みしてください。");
      return;
    }
    finishWaitingApprovalResumeAttempt(sessionId, "runtime_player_attach_requested");
    setWaitingApprovalResumeStatusText("承認要求は session runtime player から復元します。");
    showChatBottomToast("assistant", "session runtime player を接続しました。");
  }, [
    clearWaitingApprovalResumeAttachTimer,
    closeCodexRelayObserver,
    finishWaitingApprovalResumeAttempt,
    formatElapsedMmSs,
    logSessionDiag,
    normalizedLlmDirectoryForRequest,
    parseOptionalSessionId,
    reloadActiveSession,
    rememberSessionRuntimeStatus,
    selectedSessionExecutionFactStartedAtMs,
    selectedSessionId,
    selectedSessionWaitingApproval,
    sessionRuntimeStatusByIdRef,
    setReplyDebug,
    setWaitingApprovalResumeLoading,
    setWaitingApprovalResumeStatusText,
    showChatBottomToast,
    startCodexRelayObserverForSession,
    waitingApprovalResumeAttachTimeoutMs,
    waitingApprovalResumeAttachTimerRef,
    waitingApprovalResumeCooldownUntilMsRef,
    waitingApprovalResumeLoading,
    waitingApprovalResumePendingSessionIdRef,
  ]);

  return {
    resumeWaitingApprovalForActiveSession,
  };
}
