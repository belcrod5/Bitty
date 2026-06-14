import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

type UseWaitingApprovalResumeControllerArgs = {
  waitingApprovalResumeAttachTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  waitingApprovalResumePendingSessionIdRef: MutableRefObject<string>;
  waitingApprovalResumeCooldownUntilMsRef: MutableRefObject<number>;
  waitingApprovalResumeRetryCooldownMs: number;
  parseOptionalSessionId: (raw: unknown) => string;
  setWaitingApprovalResumeLoading: Dispatch<SetStateAction<boolean>>;
  logSessionDiag: (
    event: string,
    payload?: Record<string, unknown>,
    options?: {
      detailed?: boolean;
      throttleMs?: number;
      throttleKey?: string;
    }
  ) => void;
};

export function useWaitingApprovalResumeController({
  waitingApprovalResumeAttachTimerRef,
  waitingApprovalResumePendingSessionIdRef,
  waitingApprovalResumeCooldownUntilMsRef,
  waitingApprovalResumeRetryCooldownMs,
  parseOptionalSessionId,
  setWaitingApprovalResumeLoading,
  logSessionDiag,
}: UseWaitingApprovalResumeControllerArgs) {
  const clearWaitingApprovalResumeAttachTimer = useCallback(() => {
    if (waitingApprovalResumeAttachTimerRef.current) {
      clearTimeout(waitingApprovalResumeAttachTimerRef.current);
    }
    waitingApprovalResumeAttachTimerRef.current = null;
  }, [waitingApprovalResumeAttachTimerRef]);

  const finishWaitingApprovalResumeAttempt = useCallback((sessionIdRaw: unknown, reason: string) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    const pendingSessionId = parseOptionalSessionId(waitingApprovalResumePendingSessionIdRef.current);
    if (!sessionId || sessionId !== pendingSessionId) return false;
    clearWaitingApprovalResumeAttachTimer();
    waitingApprovalResumePendingSessionIdRef.current = "";
    waitingApprovalResumeCooldownUntilMsRef.current = Date.now() + waitingApprovalResumeRetryCooldownMs;
    setWaitingApprovalResumeLoading(false);
    logSessionDiag("session_waiting_approval_resume_finalized", {
      sessionId,
      reason: String(reason || "unknown"),
    }, {
      throttleMs: 0,
      throttleKey: `session_waiting_approval_resume_finalized:${sessionId}:${String(reason || "unknown")}`,
    });
    return true;
  }, [
    clearWaitingApprovalResumeAttachTimer,
    logSessionDiag,
    parseOptionalSessionId,
    setWaitingApprovalResumeLoading,
    waitingApprovalResumeCooldownUntilMsRef,
    waitingApprovalResumePendingSessionIdRef,
    waitingApprovalResumeRetryCooldownMs,
  ]);

  return {
    clearWaitingApprovalResumeAttachTimer,
    finishWaitingApprovalResumeAttempt,
  };
}

