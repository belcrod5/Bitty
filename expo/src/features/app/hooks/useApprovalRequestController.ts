import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  createApprovalQueueController,
  type ApprovalAction,
  type ApprovalQueueItem,
  type ApprovalRequest,
  type ApprovalQueueController,
} from "../../codex/approvalFlow";
import { buildApprovalCommandLabel, normalizeApprovalKey } from "../utils/tooling";
import type { LlmUiStatus } from "./useLlmRequestStatus";
import type { ToolAutoApprovalMap, ToolCallEntry, UiSfxKey } from "../types/appTypes";

type UseApprovalRequestControllerArgs = {
  setReplyDebug: Dispatch<SetStateAction<string>>;
  updateLlmStatus: (status: LlmUiStatus, detail?: string) => void;
  appendAssistantEventMessage: (line: string, request?: ApprovalRequest) => void;
  setLlmLastToolCall: Dispatch<SetStateAction<ToolCallEntry | null>>;
  playUiSfx: (key: UiSfxKey, options?: { minIntervalMs?: number }) => void;
  toolAutoApprovalMapRef: MutableRefObject<ToolAutoApprovalMap>;
  setToolAutoApprovalMap: Dispatch<SetStateAction<ToolAutoApprovalMap>>;
  speakApprovalReason?: (reason: string) => void | Promise<void>;
  shouldUpdateLlmStatusForApproval?: (request: ApprovalRequest) => boolean;
};

export type ApprovalDialogViewState = {
  visible: boolean;
  title: string;
  sessionContext?: string;
  commandLabel: string;
  message: string;
  commandText: string;
};

type ActiveApprovalDialog = {
  item: ApprovalQueueItem;
  route: string;
  command: string;
  commandLabel: string;
};

function formatApprovalArg(raw: unknown) {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) return "";
    if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(value)) return value;
    return JSON.stringify(value);
  }
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw || "").trim();
  }
}

function buildApprovalCommandText(request: ApprovalRequest, commandLabel: string) {
  const command = String(request.command || "").trim();
  const args = Array.isArray(request.args) ? request.args.map(formatApprovalArg).filter(Boolean) : [];
  const text = [command, ...args].filter(Boolean).join(" ").trim();
  return text || commandLabel || "(unknown)";
}

function buildApprovalMessage(request: ApprovalRequest, commandLabel: string) {
  const message = String(request.reason || request.message || "").replace(/\s+/g, " ").trim();
  if (message) return message.length > 72 ? `${message.slice(0, 72)}...` : message;
  return `${commandLabel} を実行します`;
}

function compactInlineText(raw: unknown, maxChars: number) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3))}...` : text;
}

function directoryNameFromPath(raw: unknown) {
  const normalized = String(raw || "").replace(/\\/g, "/").trim();
  if (!normalized) return "";
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] || "";
}

function buildApprovalSessionContext(request: ApprovalRequest) {
  const info = request.sessionInfo;
  if (!info) return "";
  const directoryName = compactInlineText(
    info.directoryDisplayName || directoryNameFromPath(info.directoryPath),
    24
  );
  const sessionTitle = compactInlineText(info.sessionTitle, 34);
  return [directoryName, sessionTitle].filter(Boolean).join(" · ");
}

function getApprovalRequestSessionId(request: ApprovalRequest) {
  return String(request.sessionInfo?.sessionId || request.threadId || "").trim();
}

export function useApprovalRequestController({
  setReplyDebug,
  updateLlmStatus,
  appendAssistantEventMessage,
  setLlmLastToolCall,
  playUiSfx,
  toolAutoApprovalMapRef,
  setToolAutoApprovalMap,
  speakApprovalReason,
  shouldUpdateLlmStatusForApproval,
}: UseApprovalRequestControllerArgs) {
  const approvalQueueControllerRef = useRef<ApprovalQueueController>(createApprovalQueueController());
  const approvalDialogActiveRef = useRef(false);
  const activeApprovalDialogRef = useRef<ActiveApprovalDialog | null>(null);
  const [approvalDialog, setApprovalDialog] = useState<ApprovalDialogViewState | null>(null);

  const rememberToolAutoApproval = useCallback((key: string) => {
    const normalized = normalizeApprovalKey(key);
    if (!normalized) return;
    setToolAutoApprovalMap((prev) => {
      if (prev[normalized]) return prev;
      return { ...prev, [normalized]: true };
    });
  }, [setToolAutoApprovalMap]);

  const clearToolAutoApprovals = useCallback(() => {
    setToolAutoApprovalMap({});
  }, [setToolAutoApprovalMap]);

  const processApprovalQueue = useCallback(() => {
    if (approvalDialogActiveRef.current) return;
    const next = approvalQueueControllerRef.current.shift();
    if (!next) return;
    approvalDialogActiveRef.current = true;
    const request = next.request;
    const route = "codex_app_server";
    const command = String(request.command || "").trim();
    const commandLabel = buildApprovalCommandLabel(request.command, request.args);
    const reason = String(request.reason || "").trim();
    const approvalKey = normalizeApprovalKey(request.approvalKey);
    const shouldProjectToMainStatus = shouldUpdateLlmStatusForApproval?.(request) ?? true;

    appendAssistantEventMessage(`tool_approval_required : ${commandLabel}`, request);
    if (shouldProjectToMainStatus) {
      updateLlmStatus("tool_waiting_approval", `approval required: ${commandLabel}`);
      setLlmLastToolCall({
        at: Date.now(),
        phase: "start",
        toolName: commandLabel,
        summary: reason || undefined,
      });
    }

    if (approvalKey && toolAutoApprovalMapRef.current[approvalKey]) {
      if (shouldProjectToMainStatus) {
        setReplyDebug(`route=${route} approval=auto command=${command || "-"} key=${approvalKey}`);
      }
      if (shouldProjectToMainStatus) {
        updateLlmStatus("tool_running", `auto-approved: ${commandLabel}`);
      }
      appendAssistantEventMessage(`tool_approval_auto : ${commandLabel}`, request);
      void Promise.resolve(next.respond("approve_for_session")).finally(() => {
        approvalDialogActiveRef.current = false;
        processApprovalQueue();
      });
      return;
    }

    if (shouldProjectToMainStatus) {
      setReplyDebug(`route=${route} approval=pending command=${command || "-"}`);
    }
    activeApprovalDialogRef.current = {
      item: next,
      route,
      command,
      commandLabel,
    };
    playUiSfx("approval");
    setApprovalDialog({
      visible: true,
      title: "このコマンドを実行しますか？",
      sessionContext: buildApprovalSessionContext(request) || undefined,
      commandLabel,
      message: buildApprovalMessage(request, commandLabel),
      commandText: buildApprovalCommandText(request, commandLabel),
    });
    if (reason && speakApprovalReason) {
      void Promise.resolve(speakApprovalReason(`承認理由。${reason}`)).catch(() => {});
    }
  }, [
    appendAssistantEventMessage,
    playUiSfx,
    setLlmLastToolCall,
    setReplyDebug,
    shouldUpdateLlmStatusForApproval,
    speakApprovalReason,
    toolAutoApprovalMapRef,
    updateLlmStatus,
  ]);

  const respondToApprovalDialog = useCallback((action: ApprovalAction) => {
    const active = activeApprovalDialogRef.current;
    if (!active) return;
    const approvalKey = normalizeApprovalKey(active.item.request.approvalKey);
    const finish = (
      nextAction: ApprovalAction,
      debugSuffix: string,
      status: LlmUiStatus,
      statusDetailPrefix: string
    ) => {
      const shouldProjectToMainStatus = shouldUpdateLlmStatusForApproval?.(active.item.request) ?? true;
      setApprovalDialog(null);
      if (shouldProjectToMainStatus) {
        setReplyDebug(`${debugSuffix} command=${active.command || "-"}`);
      }
      if (shouldProjectToMainStatus) {
        updateLlmStatus(status, `${statusDetailPrefix}: ${active.commandLabel}`);
      }
      appendAssistantEventMessage(
        `${status === "tool_running" ? "tool_approval_granted" : "tool_approval_denied"} : ${active.commandLabel}`,
        active.item.request
      );
      const item = active.item;
      activeApprovalDialogRef.current = null;
      void Promise.resolve(item.respond(nextAction)).finally(() => {
        approvalDialogActiveRef.current = false;
        processApprovalQueue();
      });
    };
    if (action === "approve_for_session") {
      if (approvalKey) {
        rememberToolAutoApproval(approvalKey);
        finish(
          "approve_for_session",
          `route=${active.route} approval=approved+remembered key=${approvalKey}`,
          "tool_running",
          "approval granted"
        );
        return;
      }
      finish("approve_once", `route=${active.route} approval=approved`, "tool_running", "approval granted");
      return;
    }
    if (action === "approve_once") {
      finish("approve_once", `route=${active.route} approval=approved`, "tool_running", "approval granted");
      return;
    }
    finish(action, `route=${active.route} approval=denied`, "model_processing", "approval denied");
  }, [
    appendAssistantEventMessage,
    processApprovalQueue,
    rememberToolAutoApproval,
    setReplyDebug,
    shouldUpdateLlmStatusForApproval,
    updateLlmStatus,
  ]);

  const handleApprovalRequest = useCallback((request: ApprovalRequest) => {
    return new Promise<ApprovalAction>((resolve) => {
      approvalQueueControllerRef.current.enqueue(request, resolve);
      processApprovalQueue();
    });
  }, [processApprovalQueue]);

  const clearPendingApprovals = useCallback(() => {
    activeApprovalDialogRef.current = null;
    setApprovalDialog(null);
    approvalDialogActiveRef.current = false;
    approvalQueueControllerRef.current.discard();
  }, []);

  const clearPendingApprovalsMatching = useCallback((matches: (request: ApprovalRequest) => boolean) => {
    const active = activeApprovalDialogRef.current;
    approvalQueueControllerRef.current.discard(matches);
    if (!active || !matches(active.item.request)) return false;

    activeApprovalDialogRef.current = null;
    setApprovalDialog(null);
    approvalDialogActiveRef.current = false;
    processApprovalQueue();
    return true;
  }, [processApprovalQueue]);

  const clearPendingApprovalsForSession = useCallback((sessionIdRaw: unknown) => {
    const sessionId = String(sessionIdRaw || "").trim();
    if (!sessionId) return;
    clearPendingApprovalsMatching(
      (request) => getApprovalRequestSessionId(request) === sessionId
    );
  }, [clearPendingApprovalsMatching]);

  const clearResolvedApproval = useCallback((resolved: ApprovalRequest) => {
    const requestId = String(resolved.requestId || "").trim();
    const sessionId = getApprovalRequestSessionId(resolved);
    if (!requestId || !sessionId) return false;
    return clearPendingApprovalsMatching((request) => (
      request.source === resolved.source &&
      request.requestId === requestId &&
      getApprovalRequestSessionId(request) === sessionId
    ));
  }, [clearPendingApprovalsMatching]);

  return {
    handleApprovalRequest,
    clearToolAutoApprovals,
    clearPendingApprovals,
    clearPendingApprovalsForSession,
    clearResolvedApproval,
    approvalDialog,
    respondToApprovalDialog,
  };
}
