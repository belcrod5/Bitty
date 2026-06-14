import { useCallback } from "react";
import type {
  ReplyRequestSessionSnapshot,
  SessionSwitchQueuedSend,
} from "../types/appTypes";
import { normalizeModelRef } from "../utils/settingsParsers";

type ReplyRequestOptions<TSttMeta> = {
  sttMeta?: TSttMeta;
  panelId?: string;
  sessionSnapshot?: ReplyRequestSessionSnapshot;
};

type SessionDiagLogOptions = {
  detailed?: boolean;
  throttleMs?: number;
  throttleKey?: string;
};

const LEGACY_MAIN_PANEL_ID = "main";

function normalizeWritePanelId(panelIdRaw: unknown) {
  const panelId = String(panelIdRaw || "").trim();
  if (!panelId || panelId === LEGACY_MAIN_PANEL_ID) return "";
  return panelId;
}

type UseSendReplyRequestControllerArgs<TSttMeta> = {
  queueSendReplyAfterSessionRestore: (
    transcriptOverride?: string,
    options?: ReplyRequestOptions<TSttMeta>,
    source?: SessionSwitchQueuedSend["source"]
  ) => boolean;
  showChatBottomToast: (role: "user" | "assistant", textRaw: string) => void;
  normalizedLlmDirectoryForRequest: () => string;
  closeCodexRelayObserver: (reason: string) => void;
  logSessionDiag: (
    event: string,
    payload?: Record<string, unknown>,
    options?: SessionDiagLogOptions
  ) => void;
  sendReplyRequestFromCodex: (
    transcriptOverride?: string,
    options?: ReplyRequestOptions<TSttMeta>
  ) => Promise<void>;
  llmBackend: string;
  cancelReplyRequestFromCodex: (options?: { panelId?: string }) => Promise<boolean>;
  suspendReplyRequestFromCodex: (reason?: string, options?: { panelId?: string }) => boolean;
};

export function useSendReplyRequestController<TSttMeta>({
  queueSendReplyAfterSessionRestore,
  showChatBottomToast,
  normalizedLlmDirectoryForRequest,
  closeCodexRelayObserver,
  logSessionDiag,
  sendReplyRequestFromCodex,
  llmBackend,
  cancelReplyRequestFromCodex,
  suspendReplyRequestFromCodex,
}: UseSendReplyRequestControllerArgs<TSttMeta>) {
  const sendReplyRequestWithSessionGuard = useCallback(async (
    transcriptOverride?: string,
    options?: ReplyRequestOptions<TSttMeta>
  ) => {
    const writePanelId = normalizeWritePanelId(options?.panelId);
    const forcedSnapshot = options?.sessionSnapshot;
    const forcedSessionId = String(forcedSnapshot?.sessionId || "").trim();
    const forcedThreadId = String(forcedSnapshot?.threadId || "").trim();
    const forcedDirectory = String(forcedSnapshot?.directory || "").trim();
    const forcedModelRef = normalizeModelRef(forcedSnapshot?.modelRef);
    const forcedReasoningEffort = String(forcedSnapshot?.reasoningEffort || "").trim();
    const forcedSource = String(forcedSnapshot?.source || "").trim();
    const panelThreadId = forcedThreadId;
    const hasForcedSnapshot = Boolean(forcedSessionId || forcedThreadId || forcedDirectory);
    logSessionDiag("reply_send_guard_enter", {
      panelId: writePanelId,
      transcriptChars: typeof transcriptOverride === "string" ? transcriptOverride.trim().length : null,
      hasForcedSnapshot,
      forcedSessionId: forcedSessionId || undefined,
      forcedThreadId: forcedThreadId || undefined,
      forcedDirectory: forcedDirectory || undefined,
    }, { throttleMs: 0 });
    if (queueSendReplyAfterSessionRestore(transcriptOverride, options, "send_reply_request")) {
      logSessionDiag("reply_send_guard_queued_after_session_restore", {
        panelId: writePanelId,
      }, { throttleMs: 0 });
      return;
    }
    if (!hasForcedSnapshot) {
      logSessionDiag("reply_send_guard_blocked_missing_panel_snapshot", {
        panelId: writePanelId,
      }, { throttleMs: 0 });
      showChatBottomToast("assistant", "パネルの送信先情報が未同期です。少し待って再送してください。");
      return;
    }
    if (!forcedSessionId) {
      logSessionDiag("reply_send_guard_blocked_missing_panel_session_snapshot", {
        panelId: writePanelId,
        forcedThreadId: forcedThreadId || undefined,
        forcedDirectory: forcedDirectory || undefined,
      }, { throttleMs: 0 });
      showChatBottomToast("assistant", "パネルのセッション情報を準備中です。少し待って再送してください。");
      return;
    }
    closeCodexRelayObserver("new_request");
    logSessionDiag("reply_send_guard_dispatch_panel_snapshot", {
      panelId: writePanelId,
      sessionId: forcedSessionId,
      threadId: panelThreadId || undefined,
      directory: forcedDirectory || normalizedLlmDirectoryForRequest(),
      modelRef: forcedModelRef || undefined,
      reasoningEffort: forcedReasoningEffort || undefined,
      source: forcedSource || `send_guard_panel_snapshot:panel=${writePanelId}`,
    }, { throttleMs: 0 });
    await sendReplyRequestFromCodex(transcriptOverride, {
      ...options,
      sessionSnapshot: {
        sessionId: forcedSessionId,
        threadId: panelThreadId,
        directory: forcedDirectory || normalizedLlmDirectoryForRequest(),
        directoryDisplayName: String(forcedSnapshot?.directoryDisplayName || "").trim() || undefined,
        sessionTitle: String(forcedSnapshot?.sessionTitle || "").trim() || undefined,
        modelRef: forcedModelRef || undefined,
        reasoningEffort: forcedReasoningEffort || undefined,
        source: forcedSource || `send_guard_panel_snapshot:panel=${writePanelId}`,
      },
    });
  }, [
    closeCodexRelayObserver,
    normalizedLlmDirectoryForRequest,
    queueSendReplyAfterSessionRestore,
    sendReplyRequestFromCodex,
    logSessionDiag,
    showChatBottomToast,
  ]);

  const cancelCodexTurnRequestGuarded = useCallback(async (options?: { panelId?: string }) => {
    if (llmBackend !== "codex_app_server") return;
    const targetPanelId = normalizeWritePanelId(options?.panelId);
    if (!targetPanelId) return;
    await cancelReplyRequestFromCodex(options);
  }, [cancelReplyRequestFromCodex, llmBackend]);

  const suspendCodexTurnRequestForSessionSwitchGuarded = useCallback((options?: { panelId?: string }) => {
    if (llmBackend !== "codex_app_server") return false;
    const targetPanelId = normalizeWritePanelId(options?.panelId);
    if (!targetPanelId) return false;
    return suspendReplyRequestFromCodex("session_switch", options);
  }, [llmBackend, suspendReplyRequestFromCodex]);

  return {
    sendReplyRequestWithSessionGuard,
    cancelCodexTurnRequestGuarded,
    suspendCodexTurnRequestForSessionSwitchGuarded,
  };
}
