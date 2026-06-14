import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

type CodexRelayObserverRef = MutableRefObject<{ threadId: string; panelId?: string; close: () => void } | null>;

type UseCodexRelayObserverLifecycleControllerArgs = {
  codexRelayObserverRef: CodexRelayObserverRef;
  codexRelayObserverReplyByThreadRef: MutableRefObject<Record<string, string>>;
  codexRelayObserverStartedAtMsByThreadRef: MutableRefObject<Record<string, number>>;
  finishWaitingApprovalResumeAttempt: (sessionIdRaw: unknown, reason: string) => boolean;
  setWaitingApprovalResumeStatusText: Dispatch<SetStateAction<string>>;
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

export function useCodexRelayObserverLifecycleController({
  codexRelayObserverRef,
  codexRelayObserverReplyByThreadRef,
  codexRelayObserverStartedAtMsByThreadRef,
  finishWaitingApprovalResumeAttempt,
  setWaitingApprovalResumeStatusText,
  logSessionDiag,
}: UseCodexRelayObserverLifecycleControllerArgs) {
  const closeCodexRelayObserver = useCallback((reason: string) => {
    const active = codexRelayObserverRef.current;
    if (!active) return;
    codexRelayObserverRef.current = null;
    try {
      active.close();
    } catch {}
    const threadId = String(active.threadId || "").trim();
    if (threadId) {
      delete codexRelayObserverReplyByThreadRef.current[threadId];
      delete codexRelayObserverStartedAtMsByThreadRef.current[threadId];
      const closeReason = String(reason || "").trim();
      const shouldFinalizePendingResume = closeReason !== "manual_waiting_approval_resume";
      if (
        shouldFinalizePendingResume &&
        finishWaitingApprovalResumeAttempt(threadId, `observer_closed:${closeReason || "manual"}`)
      ) {
        setWaitingApprovalResumeStatusText("承認待ち再開の接続が閉じられました。再試行してください。");
      }
    }
    logSessionDiag("session_relay_observer_closed", {
      reason: reason || "manual",
      threadId: threadId || undefined,
    }, {
      throttleMs: 0,
      throttleKey: `session_relay_observer_closed:${threadId || "-"}`,
    });
  }, [
    codexRelayObserverRef,
    codexRelayObserverReplyByThreadRef,
    codexRelayObserverStartedAtMsByThreadRef,
    finishWaitingApprovalResumeAttempt,
    logSessionDiag,
    setWaitingApprovalResumeStatusText,
  ]);

  const clearCodexRelayObserverForMiss = useCallback((threadId: string, directory: string) => {
    const active = codexRelayObserverRef.current;
    if (active && active.threadId === threadId) {
      closeCodexRelayObserver("resume_miss");
    }
    logSessionDiag("session_relay_observer_resume_miss", {
      threadId,
      directory,
    }, { throttleMs: 0 });
  }, [
    closeCodexRelayObserver,
    codexRelayObserverRef,
    logSessionDiag,
  ]);

  return {
    closeCodexRelayObserver,
    clearCodexRelayObserverForMiss,
  };
}
