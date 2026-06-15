import { useCallback, useRef } from "react";
import type { ApprovalRequest } from "../../codex/approvalFlow";
import type { ConversationMessage } from "../types/appTypes";
import { deriveSessionExecutionStatusType } from "../utils/sessionExecutionStatus";

export type ConversationRuntimeSnapshot = {
  sessionId: string;
  events: SessionRuntimeEvent[];
  pendingApproval: ApprovalRequest | null;
  conversationMessages: ConversationMessage[];
  contextUsedPct: number | null;
  isResponding: boolean;
  selectedThreadStatusType: string;
  request: ConversationRuntimeRequestSnapshot | null;
  updatedAtMs: number;
};

export type SessionRuntimeEvent =
  | {
      kind: "text";
      sessionId: string;
      seq: number;
      text: string;
      atMs: number;
    }
  | {
      kind: "think";
      sessionId: string;
      seq: number;
      text: string;
      atMs: number;
    }
  | {
      kind: "tool";
      sessionId: string;
      seq: number;
      text: string;
      atMs: number;
    }
  | {
      kind: "approval_request";
      sessionId: string;
      seq: number;
      text: string;
      approvalId: string;
      state: "pending" | "approved" | "declined" | "cancelled";
      request: ApprovalRequest;
      atMs: number;
    };

export type ConversationRuntimeRequestLifecycle =
  | "active"
  | "suspended"
  | "completed"
  | "cancelled"
  | "interrupted"
  | "error";

export type ConversationRuntimeRequestSnapshot = {
  requestId: string;
  requestSeq: number;
  sessionId: string;
  sourcePanelId: string;
  threadId: string;
  lifecycle: ConversationRuntimeRequestLifecycle;
  status: string;
  statusDetail: string;
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
};

export type ConversationRuntimeRequestSnapshotInput = {
  requestId: string;
  requestSeq: number;
  sessionId: string;
  sourcePanelId: string;
  threadId?: string;
  lifecycle: ConversationRuntimeRequestLifecycle;
  status: string;
  statusDetail?: string;
  startedAtMs: number;
  updatedAtMs?: number;
  completedAtMs?: number | null;
};

export function isConversationRuntimeRequestResponding(
  request: ConversationRuntimeRequestSnapshot | ConversationRuntimeRequestSnapshotInput | null | undefined
) {
  return request?.lifecycle === "active" || request?.lifecycle === "suspended";
}

function isTerminalConversationRuntimeRequest(
  request: ConversationRuntimeRequestSnapshot | null | undefined
) {
  return !!request && !isConversationRuntimeRequestResponding(request);
}

function shouldKeepPreviousRequestSnapshot(
  previous: ConversationRuntimeRequestSnapshot | null | undefined,
  next: ConversationRuntimeRequestSnapshot | null | undefined
) {
  if (!previous || !next) return false;
  if (previous.requestSeq > next.requestSeq) return true;
  return (
    previous.requestSeq === next.requestSeq &&
    isTerminalConversationRuntimeRequest(previous) &&
    isConversationRuntimeRequestResponding(next)
  );
}

function isTerminalThreadStatusForRuntimeSnapshot(raw: unknown) {
  const status = String(raw || "").trim();
  return status === "idle" || status === "notLoaded" || status === "systemError" || status === "error";
}

type ConversationRuntimeSnapshotInput = {
  sessionId: string;
  events?: SessionRuntimeEvent[];
  pendingApproval?: ApprovalRequest | null;
  conversationMessages?: ConversationMessage[];
  contextUsedPct?: number | null;
  isResponding?: boolean;
  selectedThreadStatusType?: string;
  clearRespondingRequestStartedAtMs?: number | null;
  request?: ConversationRuntimeRequestSnapshotInput | null;
};

function normalizeSessionId(raw: unknown) {
  return String(raw || "").trim();
}

function normalizeContextUsedPct(raw: unknown) {
  if (raw === null || typeof raw === "undefined") return null;
  if (!Number.isFinite(Number(raw))) return null;
  return Math.max(0, Math.min(100, Math.round(Number(raw))));
}

function normalizeStartedAtMs(raw: unknown) {
  if (!Number.isFinite(Number(raw))) return null;
  const value = Math.floor(Number(raw));
  return value > 0 ? value : null;
}

function cloneConversationMessages(messages: ConversationMessage[]) {
  return messages.map((message) => ({
    ...message,
    youtubeVideoIds: Array.isArray(message.youtubeVideoIds) ? [...message.youtubeVideoIds] : undefined,
    ttsWaveform: Array.isArray(message.ttsWaveform) ? [...message.ttsWaveform] : undefined,
    sttMeta: message.sttMeta ? { ...message.sttMeta } : undefined,
  }));
}

function cloneApprovalRequest(request: ApprovalRequest | null | undefined) {
  return request
    ? {
      ...request,
      args: Array.isArray(request.args) ? [...request.args] : [],
      sessionInfo: request.sessionInfo ? { ...request.sessionInfo } : undefined,
    }
    : null;
}

function cloneRuntimeEvent(event: SessionRuntimeEvent): SessionRuntimeEvent {
  if (event.kind === "approval_request") {
    return {
      ...event,
      request: cloneApprovalRequest(event.request) as ApprovalRequest,
    };
  }
  return { ...event };
}

function cloneRuntimeEvents(events: SessionRuntimeEvent[]) {
  return events.map(cloneRuntimeEvent);
}

function cloneRequestSnapshot(request: ConversationRuntimeRequestSnapshot | null | undefined) {
  return request ? { ...request } : null;
}

function normalizeRequestSnapshot(
  input: ConversationRuntimeRequestSnapshotInput,
  fallbackSessionId: string
): ConversationRuntimeRequestSnapshot | null {
  const sessionId = normalizeSessionId(input.sessionId || fallbackSessionId);
  const requestId = String(input.requestId || "").trim();
  const sourcePanelId = String(input.sourcePanelId || "").trim();
  if (!sessionId || !requestId || !sourcePanelId) return null;
  const updatedAtMs = Number.isFinite(Number(input.updatedAtMs))
    ? Math.max(0, Number(input.updatedAtMs))
    : Date.now();
  return {
    requestId,
    requestSeq: Math.max(0, Math.floor(Number(input.requestSeq) || 0)),
    sessionId,
    sourcePanelId,
    threadId: normalizeSessionId(input.threadId || sessionId),
    lifecycle: input.lifecycle,
    status: String(input.status || "").trim() || "unknown",
    statusDetail: String(input.statusDetail || "").trim(),
    startedAtMs: Number.isFinite(Number(input.startedAtMs))
      ? Math.max(0, Number(input.startedAtMs))
      : updatedAtMs,
    updatedAtMs,
    completedAtMs: input.completedAtMs === null || typeof input.completedAtMs === "undefined"
      ? null
      : (Number.isFinite(Number(input.completedAtMs)) ? Math.max(0, Number(input.completedAtMs)) : null),
  };
}

export function useConversationRuntimeStoreController() {
  const runtimeBySessionIdRef = useRef<Record<string, ConversationRuntimeSnapshot>>({});

  const getConversationRuntimeSnapshot = useCallback((sessionIdRaw: unknown) => {
    const sessionId = normalizeSessionId(sessionIdRaw);
    if (!sessionId) return null;
    const snapshot = runtimeBySessionIdRef.current[sessionId];
    if (!snapshot) return null;
    return {
      ...snapshot,
      events: cloneRuntimeEvents(snapshot.events),
      pendingApproval: cloneApprovalRequest(snapshot.pendingApproval),
      conversationMessages: cloneConversationMessages(snapshot.conversationMessages),
      request: cloneRequestSnapshot(snapshot.request),
    };
  }, []);

  const upsertConversationRuntimeSnapshot = useCallback((input: ConversationRuntimeSnapshotInput) => {
    const sessionId = normalizeSessionId(input.sessionId);
    if (!sessionId) return null;
    const previous = runtimeBySessionIdRef.current[sessionId];
    const hasRequestInput = Object.prototype.hasOwnProperty.call(input, "request");
    const normalizedRequestInput = hasRequestInput && input.request
      ? normalizeRequestSnapshot(input.request, sessionId)
      : null;
    const keepPreviousRequest = hasRequestInput &&
      shouldKeepPreviousRequestSnapshot(previous?.request, normalizedRequestInput);
    const clearRespondingRequestStartedAtMs = normalizeStartedAtMs(input.clearRespondingRequestStartedAtMs);
    const shouldClearRespondingRequest = !hasRequestInput &&
      isConversationRuntimeRequestResponding(previous?.request) &&
      input.isResponding === false &&
      isTerminalThreadStatusForRuntimeSnapshot(input.selectedThreadStatusType) &&
      clearRespondingRequestStartedAtMs !== null &&
      normalizeStartedAtMs(previous?.request?.startedAtMs) === clearRespondingRequestStartedAtMs;
    const nextRequest = hasRequestInput
      ? (keepPreviousRequest ? cloneRequestSnapshot(previous?.request) : normalizedRequestInput)
      : shouldClearRespondingRequest
      ? null
      : cloneRequestSnapshot(previous?.request);
    const inputIsResponding = keepPreviousRequest
      ? (previous?.isResponding ?? false)
      : (
        typeof input.isResponding === "boolean"
          ? input.isResponding
          : previous?.isResponding ?? false
      );
    const nextIsResponding = nextRequest
      ? isConversationRuntimeRequestResponding(nextRequest)
      : inputIsResponding;
    const nextThreadStatusType = keepPreviousRequest
      ? (previous?.selectedThreadStatusType ?? "unknown")
      : (input.selectedThreadStatusType ?? previous?.selectedThreadStatusType ?? "unknown");
    const next: ConversationRuntimeSnapshot = {
      sessionId,
      events: Object.prototype.hasOwnProperty.call(input, "events")
        ? cloneRuntimeEvents(Array.isArray(input.events) ? input.events : [])
        : cloneRuntimeEvents(previous?.events || []),
      pendingApproval: Object.prototype.hasOwnProperty.call(input, "pendingApproval")
        ? cloneApprovalRequest(input.pendingApproval)
        : cloneApprovalRequest(previous?.pendingApproval),
      conversationMessages: cloneConversationMessages(
        Array.isArray(input.conversationMessages) ? input.conversationMessages : previous?.conversationMessages || []
      ),
      contextUsedPct: Object.prototype.hasOwnProperty.call(input, "contextUsedPct")
        ? normalizeContextUsedPct(input.contextUsedPct)
        : previous?.contextUsedPct ?? null,
      isResponding: nextIsResponding,
      selectedThreadStatusType: deriveSessionExecutionStatusType({
        threadStatusType: nextThreadStatusType,
        isResponding: nextIsResponding,
      }),
      request: nextRequest,
      updatedAtMs: Date.now(),
    };
    runtimeBySessionIdRef.current = {
      ...runtimeBySessionIdRef.current,
      [sessionId]: next,
    };
    return {
      ...next,
      events: cloneRuntimeEvents(next.events),
      pendingApproval: cloneApprovalRequest(next.pendingApproval),
      conversationMessages: cloneConversationMessages(next.conversationMessages),
      request: cloneRequestSnapshot(next.request),
    };
  }, []);

  const finalizeConversationRuntimeAfterRelayLoss = useCallback((sessionIdRaw: unknown, reasonRaw: string) => {
    const sessionId = normalizeSessionId(sessionIdRaw);
    if (!sessionId) return null;
    const detail = String(reasonRaw || "relay unavailable").trim() || "relay unavailable";
    const previous = runtimeBySessionIdRef.current[sessionId];
    const previousEvents = previous?.events || [];
    const messages = cloneConversationMessages(previous?.conversationMessages || []);
    let latestAssistantIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant") {
        latestAssistantIndex = index;
        break;
      }
    }
    if (latestAssistantIndex >= 0) {
      messages[latestAssistantIndex] = {
        ...messages[latestAssistantIndex],
        llmStatus: "error",
        llmStatusDetail: detail,
      };
    }
    let cancelledPendingApprovals = 0;
    const nextEvents = previousEvents.map((event) => {
      if (event.kind === "approval_request" && event.state === "pending") {
        cancelledPendingApprovals += 1;
        return { ...event, state: "cancelled" as const };
      }
      return event;
    });
    const snapshot = upsertConversationRuntimeSnapshot({
      sessionId,
      events: nextEvents,
      pendingApproval: null,
      conversationMessages: messages,
      isResponding: false,
      selectedThreadStatusType: "idle",
    });
    return snapshot ? {
      snapshot,
      reason: detail,
      cancelledPendingApprovals,
    } : null;
  }, [upsertConversationRuntimeSnapshot]);

  return {
    getConversationRuntimeSnapshot,
    finalizeConversationRuntimeAfterRelayLoss,
    upsertConversationRuntimeSnapshot,
  };
}
