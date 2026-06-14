import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { SessionSwitchQueuedSend } from "../types/appTypes";

type BeginSessionRestoreResult = {
  restoreRequestSeq: number;
  prevSessionId: string;
  prevSelectedSessionId: string;
  prevEffectiveSessionId: string;
  isLatestRestoreRequest: () => boolean;
};

type UseSessionRestoreTransitionControllerArgs = {
  selectedLlmSessionId: string;
  llmConversationSessionIdRef: MutableRefObject<string>;
  selectedLlmSessionIdRef: MutableRefObject<string>;
  llmSessionRestoreInFlightRef: MutableRefObject<boolean>;
  llmSessionRestoreLoadingRef: MutableRefObject<boolean>;
  llmSessionRestoreRequestSeqRef: MutableRefObject<number>;
  sessionSwitchQueuedSendRef: MutableRefObject<SessionSwitchQueuedSend | null>;
  setSelectedLlmSessionId: Dispatch<SetStateAction<string>>;
  setLlmSessionRestoreLoadingWithRef: (next: boolean) => void;
  setLlmSessionRestoreTargetId: Dispatch<SetStateAction<string>>;
  setLlmSessionRestoreError: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string>>;
  clearQueuedSendAfterSessionRestore: (restoreRequestSeq: number, reason: string) => void;
  flushQueuedSendAfterSessionRestore: (restoreRequestSeq: number, nextSessionId: string) => void;
  logSessionDiag: (
    event: string,
    payload?: Record<string, unknown>,
    options?: { throttleMs?: number; throttleKey?: string; detailed?: boolean }
  ) => void;
};

type FinalizeSessionRestoreArgs = {
  isLatestRestoreRequest: () => boolean;
  restoreSucceeded: boolean;
  restoreRequestSeq: number;
  switchedSessionId: string;
  nextSessionId: string;
};

export function useSessionRestoreTransitionController({
  selectedLlmSessionId,
  llmConversationSessionIdRef,
  selectedLlmSessionIdRef,
  llmSessionRestoreInFlightRef,
  llmSessionRestoreLoadingRef,
  llmSessionRestoreRequestSeqRef,
  sessionSwitchQueuedSendRef,
  setSelectedLlmSessionId,
  setLlmSessionRestoreLoadingWithRef,
  setLlmSessionRestoreTargetId,
  setLlmSessionRestoreError,
  setError,
  clearQueuedSendAfterSessionRestore,
  flushQueuedSendAfterSessionRestore,
  logSessionDiag,
}: UseSessionRestoreTransitionControllerArgs) {
  const beginSessionRestore = useCallback((
    nextSessionId: string,
    diag?: { source?: string; directory?: string; silent?: boolean }
  ): BeginSessionRestoreResult | null => {
    if (llmSessionRestoreInFlightRef.current || llmSessionRestoreLoadingRef.current) {
      const rejectReason = llmSessionRestoreInFlightRef.current ? "in_flight" : "loading";
      logSessionDiag("session_restore_begin_rejected", {
        reason: rejectReason,
        targetSessionId: nextSessionId,
        source: String(diag?.source || "unknown"),
        directory: String(diag?.directory || ""),
        currentSessionId: String(llmConversationSessionIdRef.current || ""),
        selectedSessionId: String(selectedLlmSessionIdRef.current || selectedLlmSessionId || ""),
        inFlight: llmSessionRestoreInFlightRef.current,
        loading: llmSessionRestoreLoadingRef.current,
        restoreRequestSeq: llmSessionRestoreRequestSeqRef.current,
      }, {
        throttleMs: 0,
      });
      return null;
    }
    llmSessionRestoreInFlightRef.current = true;
    const restoreRequestSeq = llmSessionRestoreRequestSeqRef.current + 1;
    llmSessionRestoreRequestSeqRef.current = restoreRequestSeq;
    const isLatestRestoreRequest = () => llmSessionRestoreRequestSeqRef.current === restoreRequestSeq;
    const prevSessionId = String(llmConversationSessionIdRef.current || "").trim();
    const prevSelectedSessionId = String(selectedLlmSessionId || "").trim();
    const prevEffectiveSessionId = prevSelectedSessionId || prevSessionId;
    logSessionDiag("session_restore_begin_accepted", {
      restoreRequestSeq,
      targetSessionId: nextSessionId,
      source: String(diag?.source || "unknown"),
      directory: String(diag?.directory || ""),
      silent: diag?.silent === true,
      prevSessionId,
      prevSelectedSessionId,
      prevEffectiveSessionId,
    }, {
      throttleMs: 0,
    });
    const queuedAtSwitchStart = sessionSwitchQueuedSendRef.current;
    if (queuedAtSwitchStart && queuedAtSwitchStart.restoreRequestSeq !== restoreRequestSeq) {
      clearQueuedSendAfterSessionRestore(queuedAtSwitchStart.restoreRequestSeq, "new_session_switch_started");
    }
    const beforeCurrentSessionId = String(llmConversationSessionIdRef.current || "").trim();
    const beforeSelectedSessionId = String(selectedLlmSessionIdRef.current || selectedLlmSessionId || "").trim();
    llmConversationSessionIdRef.current = nextSessionId;
    selectedLlmSessionIdRef.current = nextSessionId;
    setSelectedLlmSessionId(nextSessionId);
    logSessionDiag("session_id_updated", {
      source: "session_restore_begin",
      reason: "restore_target_selected",
      directory: String(diag?.directory || ""),
      restoreRequestSeq,
      prevCurrentSessionId: beforeCurrentSessionId,
      prevSelectedSessionId: beforeSelectedSessionId,
      nextSessionId,
    }, {
      throttleMs: 0,
      throttleKey: `session_id_updated:session_restore_begin:${restoreRequestSeq}`,
    });
    if (diag?.silent !== true) {
      setLlmSessionRestoreLoadingWithRef(true);
      setLlmSessionRestoreTargetId(nextSessionId);
      setLlmSessionRestoreError("");
      setError("");
    }
    return {
      restoreRequestSeq,
      prevSessionId,
      prevSelectedSessionId,
      prevEffectiveSessionId,
      isLatestRestoreRequest,
    };
  }, [
    clearQueuedSendAfterSessionRestore,
    logSessionDiag,
    llmConversationSessionIdRef,
    llmSessionRestoreInFlightRef,
    llmSessionRestoreLoadingRef,
    llmSessionRestoreRequestSeqRef,
    selectedLlmSessionId,
    selectedLlmSessionIdRef,
    sessionSwitchQueuedSendRef,
    setError,
    setLlmSessionRestoreError,
    setLlmSessionRestoreLoadingWithRef,
    setLlmSessionRestoreTargetId,
    setSelectedLlmSessionId,
  ]);

  const rollbackSessionRestoreOnError = useCallback((prevSessionId: string, prevSelectedSessionId: string) => {
    const beforeCurrentSessionId = String(llmConversationSessionIdRef.current || "").trim();
    const beforeSelectedSessionId = String(selectedLlmSessionIdRef.current || selectedLlmSessionId || "").trim();
    llmConversationSessionIdRef.current = prevSessionId;
    selectedLlmSessionIdRef.current = prevSelectedSessionId;
    setSelectedLlmSessionId(prevSelectedSessionId);
    logSessionDiag("session_id_updated", {
      source: "session_restore_rollback",
      reason: "restore_failed_restore_previous",
      prevCurrentSessionId: beforeCurrentSessionId,
      prevSelectedSessionId: beforeSelectedSessionId,
      nextSessionId: prevSessionId,
      nextSelectedSessionId: prevSelectedSessionId,
    }, {
      throttleMs: 0,
      throttleKey: `session_id_updated:session_restore_rollback:${Date.now()}`,
    });
  }, [llmConversationSessionIdRef, logSessionDiag, selectedLlmSessionId, selectedLlmSessionIdRef, setSelectedLlmSessionId]);

  const finalizeSessionRestore = useCallback(({
    isLatestRestoreRequest,
    restoreSucceeded,
    restoreRequestSeq,
    switchedSessionId,
    nextSessionId,
  }: FinalizeSessionRestoreArgs) => {
    llmSessionRestoreInFlightRef.current = false;
    logSessionDiag("session_restore_finalize", {
      restoreRequestSeq,
      restoreSucceeded,
      switchedSessionId,
      nextSessionId,
      latest: isLatestRestoreRequest(),
    }, {
      throttleMs: 0,
    });
    if (!isLatestRestoreRequest()) return;
    setLlmSessionRestoreLoadingWithRef(false);
    setLlmSessionRestoreTargetId("");
    if (restoreSucceeded) {
      flushQueuedSendAfterSessionRestore(restoreRequestSeq, switchedSessionId || nextSessionId);
      return;
    }
    clearQueuedSendAfterSessionRestore(restoreRequestSeq, "session_restore_failed_or_aborted");
  }, [
    clearQueuedSendAfterSessionRestore,
    flushQueuedSendAfterSessionRestore,
    logSessionDiag,
    llmSessionRestoreInFlightRef,
    setLlmSessionRestoreLoadingWithRef,
    setLlmSessionRestoreTargetId,
  ]);

  return {
    beginSessionRestore,
    rollbackSessionRestoreOnError,
    finalizeSessionRestore,
  };
}
