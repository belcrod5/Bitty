import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { parseOptionalSessionId } from "../utils/llmSession";
import { isLlmActiveStatus } from "../utils/statusText";
import type { ConversationMessage, SelectSpecificLlmSessionOptions, SessionRuntimeStatus } from "../types/appTypes";
import type { ConversationRuntimeSnapshot } from "./useConversationRuntimeStoreController";
import type { LlmUiStatus } from "./useLlmRequestStatus";
import type { PanelRuntimeEntry } from "./usePanelNewSessionController";

type UseSessionRelayLossRecoveryControllerArgs = {
  finalizeConversationRuntimeAfterRelayLoss: (sessionIdRaw: unknown, reasonRaw: string) => {
    snapshot: ConversationRuntimeSnapshot;
    reason: string;
    cancelledPendingApprovals: number;
  } | null;
  setSessionConversationMessagesForCodexRef: MutableRefObject<(
    sessionId: string,
    messages: ConversationMessage[],
    options?: { isResponding?: boolean; selectedThreadStatusType?: string; sessionId?: string }
  ) => void>;
  panelRuntimeEntriesByIdRef: MutableRefObject<Record<string, PanelRuntimeEntry>>;
  hydratePanelFromSessionHistoryRef: MutableRefObject<(params: {
    panelId: string;
    sessionId: string;
    directory: string;
    diagnosticCycleId?: string;
  }) => Promise<"applied" | "superseded" | "failed">>;
  rememberSessionRuntimeStatus: (
    sessionIdRaw: unknown,
    status: Omit<SessionRuntimeStatus, "updatedAtMs">
  ) => void;
  clearPendingApprovalsForSession: (sessionIdRaw: unknown) => void;
  clearToolAutoApprovalsForSession: (sessionIdRaw: unknown) => void;
  selectedLlmSessionId: string;
  selectedLlmSessionIdRef: MutableRefObject<string>;
  llmConversationSessionIdRef: MutableRefObject<string>;
  setReplyLoadingWithRef: (next: boolean) => void;
  setSelectedThreadStatusType: Dispatch<SetStateAction<string>>;
  llmUiStatusRef: MutableRefObject<LlmUiStatus>;
  updateLlmStatus: (next: LlmUiStatus, detail?: string) => void;
  normalizedLlmDirectoryForRequest: () => string;
  selectSpecificLlmSession: (
    nextSessionIdRaw: unknown,
    opts?: SelectSpecificLlmSessionOptions
  ) => Promise<boolean>;
  relayLossResyncMinIntervalMs: number;
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

// Relay continuity loss (resume_miss / relay_closed) leaves the chat body stale:
// the relay event log is the only live feed, so once it is gone the session must
// be resynced from the source of truth (session JSONL + live meta).
// - Visible (main chat) session: selectSpecificLlmSession; stale/duplicate
//   applies are prevented by its restoreRequestSeq mechanism, and a still-running
//   turn restarts the relay through applyLateActiveSessionLiveState.
// - Session shown only in panels (skia board / mini board / drawer popup):
//   hydratePanelFromSessionHistory per panel; dedup is delegated to the panel
//   hydration generation guard (beginPanelHydration / superseded).
export function useSessionRelayLossRecoveryController({
  finalizeConversationRuntimeAfterRelayLoss,
  setSessionConversationMessagesForCodexRef,
  panelRuntimeEntriesByIdRef,
  hydratePanelFromSessionHistoryRef,
  rememberSessionRuntimeStatus,
  clearPendingApprovalsForSession,
  clearToolAutoApprovalsForSession,
  selectedLlmSessionId,
  selectedLlmSessionIdRef,
  llmConversationSessionIdRef,
  setReplyLoadingWithRef,
  setSelectedThreadStatusType,
  llmUiStatusRef,
  updateLlmStatus,
  normalizedLlmDirectoryForRequest,
  selectSpecificLlmSession,
  relayLossResyncMinIntervalMs,
  logSessionDiag,
}: UseSessionRelayLossRecoveryControllerArgs) {
  // Guards the resync->relay restart->loss loop: one resync per session per interval.
  const relayLossResyncLastAtBySessionIdRef = useRef<Record<string, number>>({});

  const finalizeSessionRuntimeAfterRelayLoss = useCallback((sessionIdRaw: unknown, reasonRaw: string) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return;
    const finalized = finalizeConversationRuntimeAfterRelayLoss(sessionId, reasonRaw);
    const detail = finalized?.reason || String(reasonRaw || "relay unavailable").trim() || "relay unavailable";
    const messages = finalized?.snapshot.conversationMessages || [];
    const now = Date.now();
    const lastResyncAtMs = relayLossResyncLastAtBySessionIdRef.current[sessionId] || 0;
    const canResync = now - lastResyncAtMs >= relayLossResyncMinIntervalMs;

    const pinFinalizedMessagesToRuntime = () => {
      if (messages.length === 0) return;
      setSessionConversationMessagesForCodexRef.current(sessionId, messages, {
        isResponding: false,
        selectedThreadStatusType: "idle",
        sessionId,
      });
    };
    const panelsShowingSession = Object.entries(panelRuntimeEntriesByIdRef.current).filter(([, entry]) => (
      parseOptionalSessionId(entry?.snapshot?.selectedSessionId || entry?.sessionId) === sessionId
    ));
    const panelResyncScheduled = canResync && panelsShowingSession.length > 0;
    if (panelResyncScheduled) {
      // パネル表示中は喪失時点のruntimeメッセージで固定せず、JSONLから再hydrateする。
      // 失敗時のみ従来どおりのidle固定へフォールバックし、応答中表示のまま残さない。
      const diagnosticCycleId = `relay-loss-${Date.now().toString(36)}`;
      for (const [panelId, entry] of panelsShowingSession) {
        void hydratePanelFromSessionHistoryRef.current({
          panelId,
          sessionId,
          directory: String(entry?.snapshot?.selectedDirectoryPath || "").trim(),
          diagnosticCycleId,
        }).then((result) => {
          logSessionDiag("session_runtime_relay_loss_panel_resync_done", {
            sessionId,
            panelId,
            reason: detail,
            result,
          }, {
            throttleMs: 0,
            throttleKey: `session_runtime_relay_loss_panel_resync_done:${sessionId}:${panelId}`,
          });
          if (result === "failed") pinFinalizedMessagesToRuntime();
        }).catch(() => pinFinalizedMessagesToRuntime());
      }
    } else {
      pinFinalizedMessagesToRuntime();
    }
    rememberSessionRuntimeStatus(sessionId, {
      hasRunningTurn: false,
      hasPendingAssistant: false,
      restoredInFlight: false,
      waitingApproval: false,
    });
    clearPendingApprovalsForSession(sessionId);
    clearToolAutoApprovalsForSession(sessionId);
    const visibleSessionId = parseOptionalSessionId(
      selectedLlmSessionIdRef.current || selectedLlmSessionId || llmConversationSessionIdRef.current
    );
    let resyncScheduled = false;
    if (visibleSessionId === sessionId) {
      setReplyLoadingWithRef(false);
      setSelectedThreadStatusType("idle");
      resyncScheduled = canResync;
      const markRelayLossError = () => {
        if (isLlmActiveStatus(llmUiStatusRef.current)) {
          updateLlmStatus("error", detail);
        }
      };
      if (resyncScheduled) {
        void selectSpecificLlmSession(sessionId, {
          source: "all",
          directory: normalizedLlmDirectoryForRequest(),
        }).then((restored) => {
          logSessionDiag("session_runtime_relay_loss_resync_done", {
            sessionId,
            reason: detail,
            restored,
          }, {
            throttleMs: 0,
            throttleKey: `session_runtime_relay_loss_resync_done:${sessionId}`,
          });
          if (!restored) markRelayLossError();
        }).catch(markRelayLossError);
      } else {
        markRelayLossError();
      }
    }
    if (resyncScheduled || panelResyncScheduled) {
      relayLossResyncLastAtBySessionIdRef.current[sessionId] = now;
    }
    logSessionDiag("session_runtime_relay_unavailable", {
      sessionId,
      reason: detail,
      cancelledPendingApprovals: finalized?.cancelledPendingApprovals || 0,
      messageCount: messages.length,
      resyncScheduled,
      panelResyncScheduled,
      panelIds: panelsShowingSession.map(([panelId]) => panelId),
    }, {
      throttleMs: 0,
      throttleKey: `session_runtime_relay_unavailable:${sessionId}:${detail}`,
    });
  }, [
    clearPendingApprovalsForSession,
    clearToolAutoApprovalsForSession,
    finalizeConversationRuntimeAfterRelayLoss,
    hydratePanelFromSessionHistoryRef,
    logSessionDiag,
    llmConversationSessionIdRef,
    llmUiStatusRef,
    normalizedLlmDirectoryForRequest,
    panelRuntimeEntriesByIdRef,
    relayLossResyncMinIntervalMs,
    rememberSessionRuntimeStatus,
    selectSpecificLlmSession,
    selectedLlmSessionId,
    selectedLlmSessionIdRef,
    setReplyLoadingWithRef,
    setSelectedThreadStatusType,
    setSessionConversationMessagesForCodexRef,
    updateLlmStatus,
  ]);

  return {
    finalizeSessionRuntimeAfterRelayLoss,
  };
}
