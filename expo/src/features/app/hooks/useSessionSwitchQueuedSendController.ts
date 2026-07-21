import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type {
  ReplyRequestSessionSnapshot,
  SessionSwitchQueuedSend,
  SttMessageMeta,
} from "../types/appTypes";

type UseSessionSwitchQueuedSendControllerArgs = {
  llmSessionRestoreInFlightRef: MutableRefObject<boolean>;
  llmSessionRestoreLoadingRef: MutableRefObject<boolean>;
  llmSessionRestoreRequestSeqRef: MutableRefObject<number>;
  sessionSwitchQueuedSendRef: MutableRefObject<SessionSwitchQueuedSend | null>;
  transcript: string;
  setTranscript: Dispatch<SetStateAction<string>>;
  setReplyDebug: Dispatch<SetStateAction<string>>;
  showChatBottomToast: (role: "user" | "assistant", rawText: string) => void;
  shouldProjectQueuedSendDebug: (panelId: string) => boolean;
  sendReplyRequest: (
    transcriptOverride?: string,
    options?: {
      sttMeta?: SttMessageMeta;
      panelId?: string;
      sessionSnapshot?: ReplyRequestSessionSnapshot;
    }
  ) => Promise<void>;
};

export function useSessionSwitchQueuedSendController({
  llmSessionRestoreInFlightRef,
  llmSessionRestoreLoadingRef,
  llmSessionRestoreRequestSeqRef,
  sessionSwitchQueuedSendRef,
  transcript,
  setTranscript,
  setReplyDebug,
  showChatBottomToast,
  shouldProjectQueuedSendDebug,
  sendReplyRequest,
}: UseSessionSwitchQueuedSendControllerArgs) {
  const isSessionRestoreSwitching = useCallback(() => (
    llmSessionRestoreInFlightRef.current || llmSessionRestoreLoadingRef.current
  ), [llmSessionRestoreInFlightRef, llmSessionRestoreLoadingRef]);

  const queueSendReplyAfterSessionRestore = useCallback((
    transcriptOverride?: string,
    options?: {
      sttMeta?: SttMessageMeta;
      panelId?: string;
      sessionSnapshot?: ReplyRequestSessionSnapshot;
    },
    source: SessionSwitchQueuedSend["source"] = "send_reply_request"
  ) => {
    const writePanelId = String(options?.panelId || "").trim();
    if (writePanelId && writePanelId !== "main") return false;
    if (!isSessionRestoreSwitching()) return false;
    const normalized = String((transcriptOverride ?? transcript) || "").trim();
    if (!normalized) return true;
    const restoreRequestSeq = llmSessionRestoreRequestSeqRef.current;
    if (restoreRequestSeq <= 0) return false;
    const sessionSnapshot = options?.sessionSnapshot
      ? {
        sessionId: String(options.sessionSnapshot.sessionId || "").trim() || undefined,
        threadId: String(options.sessionSnapshot.threadId || "").trim() || undefined,
        directory: String(options.sessionSnapshot.directory || "").trim() || undefined,
        source: String(options.sessionSnapshot.source || "").trim() || undefined,
      }
      : undefined;
    sessionSwitchQueuedSendRef.current = {
      transcript: normalized,
      sttMeta: options?.sttMeta,
      panelId: writePanelId,
      sessionSnapshot,
      restoreRequestSeq,
      queuedAt: Date.now(),
      source,
    };
    if (typeof transcriptOverride === "undefined") {
      setTranscript("");
    }
    if (shouldProjectQueuedSendDebug(writePanelId)) {
      setReplyDebug((prev) => (
        prev
          ? `${prev} | send_queued_during_session_switch seq=${restoreRequestSeq} source=${source} panel=${writePanelId}`
          : `send_queued_during_session_switch seq=${restoreRequestSeq} source=${source} panel=${writePanelId}`
      ));
    }
    showChatBottomToast("user", "セッション切替完了後に自動送信します");
    return true;
  }, [
    isSessionRestoreSwitching,
    llmSessionRestoreRequestSeqRef,
    sessionSwitchQueuedSendRef,
    setReplyDebug,
    setTranscript,
    showChatBottomToast,
    shouldProjectQueuedSendDebug,
    transcript,
  ]);

  const clearQueuedSendAfterSessionRestore = useCallback((restoreRequestSeq: number, reason: string) => {
    const queued = sessionSwitchQueuedSendRef.current;
    if (!queued || queued.restoreRequestSeq !== restoreRequestSeq) return;
    sessionSwitchQueuedSendRef.current = null;
    if (!shouldProjectQueuedSendDebug(queued.panelId)) return;
    setReplyDebug((prev) => (
      prev
        ? `${prev} | queued_send_dropped seq=${restoreRequestSeq} reason=${reason}`
        : `queued_send_dropped seq=${restoreRequestSeq} reason=${reason}`
    ));
  }, [sessionSwitchQueuedSendRef, setReplyDebug, shouldProjectQueuedSendDebug]);

  const flushQueuedSendAfterSessionRestore = useCallback((restoreRequestSeq: number, nextSessionId: string) => {
    const queued = sessionSwitchQueuedSendRef.current;
    if (!queued || queued.restoreRequestSeq !== restoreRequestSeq) return;
    sessionSwitchQueuedSendRef.current = null;
    const queuedAgeMs = Math.max(0, Date.now() - queued.queuedAt);
    if (shouldProjectQueuedSendDebug(queued.panelId)) {
      setReplyDebug((prev) => (
        prev
          ? `${prev} | queued_send_flushed seq=${restoreRequestSeq} session=${nextSessionId} ageMs=${queuedAgeMs}`
          : `queued_send_flushed seq=${restoreRequestSeq} session=${nextSessionId} ageMs=${queuedAgeMs}`
      ));
    }
    setTimeout(() => {
      void sendReplyRequest(queued.transcript, {
        sttMeta: queued.sttMeta,
        panelId: queued.panelId,
        sessionSnapshot: queued.sessionSnapshot,
      });
    }, 0);
  }, [sendReplyRequest, sessionSwitchQueuedSendRef, setReplyDebug, shouldProjectQueuedSendDebug]);

  return {
    queueSendReplyAfterSessionRestore,
    clearQueuedSendAfterSessionRestore,
    flushQueuedSendAfterSessionRestore,
  };
}
