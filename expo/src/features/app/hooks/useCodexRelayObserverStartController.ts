import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  deriveCodexSessionStateFromSnapshot,
  startCodexAppServerTurnRelayObserver,
} from "../../codex/codexAppServerClient";
import type { ApprovalAction, ApprovalRequest } from "../../codex/approvalFlow";
import type { ConversationMessage, SessionRuntimeStatus } from "../types/appTypes";
import type { LlmUiStatus } from "./useLlmRequestStatus";

type CodexRelayObserverRef = MutableRefObject<{ threadId: string; panelId?: string; close: () => void } | null>;

type StartCodexRelayObserverOptions = {
  directory?: string;
  startedAtMs?: number | null;
  resumeFromSeq?: number;
  reason?: string;
  panelId?: string;
};

type BuildConversationMessageLike = (
  role: "user" | "assistant",
  content: string,
  options?: Omit<Partial<ConversationMessage>, "id" | "role" | "content">
) => ConversationMessage;

type ConversationWriteOptions = {
  isResponding?: boolean;
  selectedThreadStatusType?: string;
  sessionId?: string;
  clearRespondingRequestStartedAtMs?: number | null;
};

type UseCodexRelayObserverStartControllerArgs = {
  parseOptionalSessionId: (raw: unknown) => string;
  parseLlmDirectory: (raw: unknown) => string;
  normalizedLlmDirectoryForRequest: () => string;
  codexRelayObserverRef: CodexRelayObserverRef;
  codexRelayObserverReplyByThreadRef: MutableRefObject<Record<string, string>>;
  codexRelayObserverStartedAtMsByThreadRef: MutableRefObject<Record<string, number>>;
  llmRequestStartedAtRef: MutableRefObject<number>;
  reply: string;
  codexWsUrl: string;
  codexWsToken: string;
  logSessionDiag: (
    event: string,
    payload?: Record<string, unknown>,
    options?: {
      detailed?: boolean;
      throttleMs?: number;
      throttleKey?: string;
    }
  ) => void;
  waitingApprovalResumePendingSessionIdRef: MutableRefObject<string>;
  setWaitingApprovalResumeStatusText: Dispatch<SetStateAction<string>>;
  finishWaitingApprovalResumeAttempt: (sessionIdRaw: unknown, reason: string) => boolean;
  clearCodexRelayObserverForMiss: (threadId: string, directory: string) => void;
  applyAssistantReply: (textRaw: string) => string;
  buildConversationMessage: BuildConversationMessageLike;
  getPanelConversationMessagesForCodexRef: MutableRefObject<(panelId: string) => ConversationMessage[]>;
  setPanelConversationMessagesForCodexRef: MutableRefObject<(
    panelId: string,
    messages: ConversationMessage[],
    options?: { contextUsedPct?: number | null; isResponding?: boolean; selectedThreadStatusType?: string; sessionId?: string }
  ) => void>;
  getActiveConversationMessagesForCodex: () => ConversationMessage[];
  setActiveConversationMessagesForCodex: (
    messages: ConversationMessage[],
    options?: ConversationWriteOptions
  ) => void;
  getSessionConversationMessagesForCodex: (sessionId: string) => ConversationMessage[];
  setSessionConversationMessagesForCodex: (
    sessionId: string,
    messages: ConversationMessage[],
    options?: ConversationWriteOptions
  ) => void;
  rememberSessionRuntimeStatus: (
    sessionIdRaw: unknown,
    status: Omit<SessionRuntimeStatus, "updatedAtMs">
  ) => void;
  finalizeSessionRuntimeAfterRelayLoss: (sessionIdRaw: unknown, reason: string) => void;
  closeCodexRelayObserver: (reason: string) => void;
  shouldProjectRelayConversation?: (params: {
    threadId: string;
    reason: string;
    panelId?: string;
  }) => boolean;
  completeRuntimeRequestForRelayCompletion?: (params: {
    threadId: string;
    startedAtMs: number | null;
    reason: string;
  }) => void;
  onApprovalRequest: (request: ApprovalRequest) => ApprovalAction | Promise<ApprovalAction>;
  onApprovalRequestResolved?: (request: ApprovalRequest) => void;
  onAssistantTurnCompleted?: (params: {
    threadId: string;
    panelId?: string;
    messageId: string;
    text: string;
    directory: string;
    reason: string;
  }) => void | Promise<void>;
};

function findLatestAssistantMessage(messages: ConversationMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") return message;
  }
  return null;
}

function splitDeltaAfterRestoredPrefix(prefixRaw: string, deltaRaw: string) {
  const prefix = String(prefixRaw || "");
  const delta = String(deltaRaw || "");
  if (!prefix || !delta) return { remainingPrefix: "", deltaToAppend: delta };
  if (prefix.startsWith(delta)) {
    return { remainingPrefix: prefix.slice(delta.length), deltaToAppend: "" };
  }
  if (delta.startsWith(prefix)) {
    return { remainingPrefix: "", deltaToAppend: delta.slice(prefix.length) };
  }
  const maxOverlap = Math.min(prefix.length, delta.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (prefix.endsWith(delta.slice(0, size))) {
      return { remainingPrefix: "", deltaToAppend: delta.slice(size) };
    }
  }
  return { remainingPrefix: "", deltaToAppend: delta };
}

export function useCodexRelayObserverStartController({
  parseOptionalSessionId,
  parseLlmDirectory,
  normalizedLlmDirectoryForRequest,
  codexRelayObserverRef,
  codexRelayObserverReplyByThreadRef,
  codexRelayObserverStartedAtMsByThreadRef,
  llmRequestStartedAtRef,
  reply,
  codexWsUrl,
  codexWsToken,
  logSessionDiag,
  waitingApprovalResumePendingSessionIdRef,
  setWaitingApprovalResumeStatusText,
  finishWaitingApprovalResumeAttempt,
  clearCodexRelayObserverForMiss,
  applyAssistantReply,
  buildConversationMessage,
  getPanelConversationMessagesForCodexRef,
  setPanelConversationMessagesForCodexRef,
  getActiveConversationMessagesForCodex,
  setActiveConversationMessagesForCodex,
  getSessionConversationMessagesForCodex,
  setSessionConversationMessagesForCodex,
  rememberSessionRuntimeStatus,
  finalizeSessionRuntimeAfterRelayLoss,
  closeCodexRelayObserver,
  shouldProjectRelayConversation,
  completeRuntimeRequestForRelayCompletion,
  onApprovalRequest,
  onApprovalRequestResolved,
  onAssistantTurnCompleted,
}: UseCodexRelayObserverStartControllerArgs) {
  const startCodexRelayObserverForSession = useCallback((threadIdRaw: unknown, options?: StartCodexRelayObserverOptions) => {
    const threadId = parseOptionalSessionId(threadIdRaw);
    if (!threadId) return false;
    const targetPanelId = String(options?.panelId || "").trim();
    const observerReason = String(options?.reason || "session_restore").trim();
    const isSessionRuntimeObserver = observerReason === "session_restored_running_turn";
    const existing = codexRelayObserverRef.current;
    if (existing && existing.threadId === threadId) {
      if (isSessionRuntimeObserver) {
        logSessionDiag("session_relay_observer_reused", {
          threadId,
          reason: observerReason,
          requestedPanelId: targetPanelId || undefined,
          existingPanelId: String(existing.panelId || "").trim() || undefined,
          observerScope: "session",
        }, {
          throttleMs: 0,
          throttleKey: `session_relay_observer_reused:${threadId}:${targetPanelId || "session"}`,
        });
        return true;
      }
      const existingPanelId = String(existing.panelId || "").trim();
      if (!targetPanelId || existingPanelId === targetPanelId) {
        if (targetPanelId) {
          existing.panelId = targetPanelId;
        }
        return true;
      }
      closeCodexRelayObserver("switch_panel");
    } else if (existing) {
      closeCodexRelayObserver("switch_thread");
    }
    const directory = parseLlmDirectory(options?.directory || normalizedLlmDirectoryForRequest());
    const startedAtMs = Number.isFinite(Number(options?.startedAtMs))
      ? Number(options?.startedAtMs)
      : null;
    if (startedAtMs && startedAtMs > 0) {
      codexRelayObserverStartedAtMsByThreadRef.current[threadId] = Math.floor(startedAtMs);
      llmRequestStartedAtRef.current = Math.floor(startedAtMs);
    } else if (!llmRequestStartedAtRef.current) {
      llmRequestStartedAtRef.current = Date.now();
    }
    const shouldDiscardRestoredReplyPrefix = (
      observerReason === "manual_waiting_approval_resume" ||
      observerReason === "codex_queue_turn"
    );
    const shouldWaitForAgentMessageBeforeFinalize = observerReason === "codex_queue_turn";
    let observedAgentMessage = false;
    let ignoredPreAgentTurnCompleted = false;
    let relayPanelConversationDraft: ConversationMessage[] = [];
    const isQueueTurnObserver = observerReason === "codex_queue_turn";
    const canProjectRelayToTarget = (
      observerReason === "codex_queue_turn" ||
      isSessionRuntimeObserver
    );
    let relayProjectionSuppressed = false;
    let relayProjectionSuppressedLogged = false;
    const shouldProjectRelayToTarget = () => {
      if (!canProjectRelayToTarget) return false;
      if (relayProjectionSuppressed) return false;
      const allowed = shouldProjectRelayConversation
        ? shouldProjectRelayConversation({
          threadId,
          reason: observerReason,
          panelId: targetPanelId || undefined,
        })
        : true;
      if (!allowed && !relayProjectionSuppressedLogged) {
        relayProjectionSuppressedLogged = true;
        logSessionDiag("session_relay_observer_projection_suppressed", {
          threadId,
          reason: observerReason,
          panelId: targetPanelId || undefined,
        }, {
          throttleMs: 0,
          throttleKey: `session_relay_observer_projection_suppressed:${threadId}:${observerReason}`,
        });
      }
      if (!allowed) {
        relayProjectionSuppressed = true;
      }
      return allowed;
    };
    const readTargetConversation = () => (
      !shouldProjectRelayToTarget()
        ? []
        : isSessionRuntimeObserver
        ? getSessionConversationMessagesForCodex(threadId)
        : targetPanelId
        ? getPanelConversationMessagesForCodexRef.current(targetPanelId)
        : getActiveConversationMessagesForCodex()
    );
    const writeTargetConversation = (
      messages: ConversationMessage[],
      writeOptions?: ConversationWriteOptions
    ) => {
      if (!shouldProjectRelayToTarget()) return;
      if (isSessionRuntimeObserver) {
        setSessionConversationMessagesForCodex(threadId, messages, writeOptions);
      } else if (targetPanelId) {
        setPanelConversationMessagesForCodexRef.current(targetPanelId, messages, writeOptions);
      } else {
        setActiveConversationMessagesForCodex(messages, writeOptions);
      }
    };
    const initialTargetConversation = shouldProjectRelayToTarget()
      ? readTargetConversation()
      : [];
    const initialPanelAssistant = shouldProjectRelayToTarget() && observerReason === "session_restored_running_turn"
      ? findLatestAssistantMessage(initialTargetConversation)
      : null;
    const defaultRelayAssistantMessageId = String(initialPanelAssistant?.id || "").trim() ||
      `assistant-stream-relay-${threadId}-${Date.now()}`;
    let restoredReplayPrefixRemaining = observerReason === "session_restored_running_turn"
      ? String(initialPanelAssistant?.content || "")
      : "";
    const initialRelayReply = restoredReplayPrefixRemaining ||
      String(codexRelayObserverReplyByThreadRef.current[threadId] || reply || "");
    let currentAgentMessageItemId = "";
    const agentMessageOrder: string[] = [];
    const agentMessageContentById = new Map<string, string>();
    const agentMessageUiIdByItemId = new Map<string, string>();
    const extractAgentMessageItemId = (paramsRaw: unknown) => {
      const params = paramsRaw && typeof paramsRaw === "object" ? paramsRaw as any : {};
      return String(params?.item?.id || params?.itemId || "").trim();
    };
    const rememberAgentMessageItemId = (itemIdRaw: string) => {
      const itemId = String(itemIdRaw || "").trim() || "__agent_message__";
      if (!agentMessageContentById.has(itemId)) {
        const isFirstItem = agentMessageOrder.length === 0;
        agentMessageOrder.push(itemId);
        agentMessageContentById.set(
          itemId,
          isFirstItem ? String(initialPanelAssistant?.content || "") : ""
        );
        agentMessageUiIdByItemId.set(
          itemId,
          isFirstItem && initialPanelAssistant
            ? defaultRelayAssistantMessageId
            : `assistant-stream-relay-${threadId}-${itemId}`
        );
      }
      currentAgentMessageItemId = itemId;
      return itemId;
    };
    const resolveAgentMessageItemId = (paramsRaw: unknown) => (
      rememberAgentMessageItemId(
        extractAgentMessageItemId(paramsRaw) || currentAgentMessageItemId || "__agent_message__"
      )
    );
    const rebuildRelayReply = () => {
      const combined = agentMessageOrder
        .map((itemId) => String(agentMessageContentById.get(itemId) || "").trim())
        .filter(Boolean)
        .join("\n\n");
      codexRelayObserverReplyByThreadRef.current[threadId] = combined;
      return combined;
    };
    const getLastAgentMessage = () => {
      for (let index = agentMessageOrder.length - 1; index >= 0; index -= 1) {
        const itemId = agentMessageOrder[index];
        const content = String(agentMessageContentById.get(itemId) || "").trim();
        const messageId = String(agentMessageUiIdByItemId.get(itemId) || "").trim();
        if (content && messageId) return { content, messageId };
      }
      return null;
    };
    const updateQueueStatusForRelay = (
      message: ConversationMessage,
      queueStatus: NonNullable<ConversationMessage["codexQueue"]>["status"]
    ) => {
      if (!isQueueTurnObserver || message.role !== "user" || !message.codexQueue) return message;
      const currentStatus = String(message.codexQueue.status || "").trim();
      if (currentStatus === queueStatus) return message;
      if (currentStatus !== "queued" && currentStatus !== "waiting_compact" && currentStatus !== "running") {
        return message;
      }
      return {
        ...message,
        codexQueue: {
          ...message.codexQueue,
          status: queueStatus,
        },
      };
    };
    const hasRenderableRelayAssistantMessage = (contentRaw: string, status: LlmUiStatus) => (
      !!String(contentRaw || "").trim() || status === "error"
    );
    const updateRelayPanelLiveAssistantMessage = (
      contentRaw: string,
      status: LlmUiStatus,
      detail: string,
      isResponding: boolean,
      selectedThreadStatusType?: string,
      messageIdRaw?: string
    ) => {
      if (!shouldProjectRelayToTarget()) return;
      const latestConversation = relayPanelConversationDraft.length > 0
        ? relayPanelConversationDraft
        : readTargetConversation();
      const content = applyAssistantReply(String(contentRaw || ""));
      const queueStatus: NonNullable<ConversationMessage["codexQueue"]>["status"] = isResponding
        ? "running"
        : "completed";
      const conversationWithQueueStatus = latestConversation.map((message) => updateQueueStatusForRelay(message, queueStatus));
      if (!hasRenderableRelayAssistantMessage(content, status)) {
        relayPanelConversationDraft = conversationWithQueueStatus;
        writeTargetConversation(conversationWithQueueStatus, {
          isResponding,
          selectedThreadStatusType: selectedThreadStatusType ||
            (status === "tool_waiting_approval" ? "waiting_approval" : (isResponding ? "active" : "idle")),
          sessionId: threadId,
          clearRespondingRequestStartedAtMs: isResponding ? null : startedAtMs,
        });
        return;
      }
      const elapsedMs = llmRequestStartedAtRef.current > 0
        ? Date.now() - llmRequestStartedAtRef.current
        : undefined;
      const messageId = String(messageIdRaw || defaultRelayAssistantMessageId).trim() ||
        defaultRelayAssistantMessageId;
      const assistantMessage = {
        ...buildConversationMessage("assistant", content, {
          llmStatus: status,
          llmStatusDetail: detail,
          llmElapsedMs: elapsedMs,
        }),
        id: messageId,
      };
      let replaced = false;
      const nextConversation = conversationWithQueueStatus.map((message) => {
        if (String(message.id || "") === messageId) {
          replaced = true;
          return assistantMessage;
        }
        return message;
      });
      if (!replaced) {
        nextConversation.push(assistantMessage);
      }
      relayPanelConversationDraft = nextConversation;
      writeTargetConversation(nextConversation, {
        isResponding,
        selectedThreadStatusType: selectedThreadStatusType ||
          (status === "tool_waiting_approval" ? "waiting_approval" : (isResponding ? "active" : "idle")),
        sessionId: threadId,
        clearRespondingRequestStartedAtMs: isResponding ? null : startedAtMs,
      });
    };
    const settleRelayAgentMessages = (
      status: LlmUiStatus,
      detail: string,
      isResponding: boolean,
      selectedThreadStatusType: string
    ) => {
      const liveMessageIds = new Set(Array.from(agentMessageUiIdByItemId.values()));
      if (liveMessageIds.size === 0) {
        updateRelayPanelLiveAssistantMessage(
          codexRelayObserverReplyByThreadRef.current[threadId] || "",
          status,
          detail,
          isResponding,
          selectedThreadStatusType
        );
        return;
      }
      const latestConversation = relayPanelConversationDraft.length > 0
        ? relayPanelConversationDraft
        : readTargetConversation();
      const queueStatus: NonNullable<ConversationMessage["codexQueue"]>["status"] = isResponding
        ? "running"
        : "completed";
      const nextConversation = latestConversation.map((message) => {
        const withQueueStatus = updateQueueStatusForRelay(message, queueStatus);
        if (!liveMessageIds.has(String(withQueueStatus.id || ""))) return withQueueStatus;
        return {
          ...withQueueStatus,
          llmStatus: status,
          llmStatusDetail: status === "completed" ? "" : detail,
        };
      });
      relayPanelConversationDraft = nextConversation;
      writeTargetConversation(nextConversation, {
        isResponding,
        selectedThreadStatusType,
        sessionId: threadId,
      });
    };
    codexRelayObserverReplyByThreadRef.current[threadId] = shouldDiscardRestoredReplyPrefix
      ? ""
      : initialRelayReply;
    logSessionDiag("session_relay_observer_start", {
      threadId,
      reason: observerReason,
      directory,
      panelId: isSessionRuntimeObserver ? undefined : targetPanelId || undefined,
      requestedPanelId: targetPanelId || undefined,
      observerScope: isSessionRuntimeObserver ? "session" : "panel",
      resumeFromSeq: Number.isFinite(Number(options?.resumeFromSeq))
        ? Math.max(0, Math.floor(Number(options?.resumeFromSeq)))
        : 0,
    }, {
      throttleMs: 0,
      throttleKey: `session_relay_observer_start:${threadId}`,
    });
    try {
      const observer = startCodexAppServerTurnRelayObserver({
        wsUrl: codexWsUrl.trim(),
        wsToken: codexWsToken.trim(),
        threadId,
        resumeFromSeq: Number.isFinite(Number(options?.resumeFromSeq))
          ? Math.max(0, Math.floor(Number(options?.resumeFromSeq)))
          : 0,
        onLog: (entry) => {
          const active = codexRelayObserverRef.current;
          if (!active || active.threadId !== threadId) return;
          const stage = String(entry.stage || "").trim();
          if (!stage) return;
          if (stage === "relay_observer_open") {
            if (parseOptionalSessionId(waitingApprovalResumePendingSessionIdRef.current) === threadId) {
              setWaitingApprovalResumeStatusText("承認待ち再開の接続を開始しました。");
            }
          } else if (stage === "relay_observer_attached") {
            if (parseOptionalSessionId(waitingApprovalResumePendingSessionIdRef.current) === threadId) {
              setWaitingApprovalResumeStatusText("再接続済み。承認イベントを待機しています。");
            }
          } else if (stage === "relay_observer_approval_required") {
            if (finishWaitingApprovalResumeAttempt(threadId, stage)) {
              setWaitingApprovalResumeStatusText("承認要求を再表示しました。");
            }
          } else if (stage === "relay_observer_resume_miss") {
            if (finishWaitingApprovalResumeAttempt(threadId, stage)) {
              setWaitingApprovalResumeStatusText("relay が見つからないため、承認待ちを再開できません。");
            }
            if (isSessionRuntimeObserver) {
              finalizeSessionRuntimeAfterRelayLoss(threadId, "relay が見つからないため、ライブ再開できません。");
            }
            clearCodexRelayObserverForMiss(threadId, directory);
            return;
          } else if (stage === "relay_observer_relay_closed") {
            if (finishWaitingApprovalResumeAttempt(threadId, stage)) {
              setWaitingApprovalResumeStatusText("承認待ち再開の relay が切断されました。再接続を待機しています。");
            }
          } else if (stage === "relay_observer_error" || stage === "relay_observer_close") {
            if (finishWaitingApprovalResumeAttempt(threadId, stage)) {
              setWaitingApprovalResumeStatusText("承認待ち再開の接続が切断されました。再試行してください。");
            }
          }
          logSessionDiag("session_relay_observer_event", {
            threadId,
            stage,
            message: String(entry.message || "").trim() || undefined,
          }, {
            throttleMs: 0,
            throttleKey: `session_relay_observer_event:${threadId}:${stage}`,
          });
        },
        onEvent: (method, params) => {
          const active = codexRelayObserverRef.current;
          if (!active || active.threadId !== threadId) return;
          const payload = params && typeof params === "object" ? params as Record<string, unknown> : {};
          const threadStatus = method === "thread/status/changed"
            ? deriveCodexSessionStateFromSnapshot({
              status: payload.status ?? (payload as any)?.thread?.status,
            })
            : null;
          if (method === "item/started" && String((payload as any)?.item?.type || "") === "agentMessage") {
            rememberAgentMessageItemId(extractAgentMessageItemId(payload));
          }
          if (method === "thread/status/changed" && threadStatus?.sessionState === "waiting_on_approval") {
            settleRelayAgentMessages(
              "tool_waiting_approval",
              "thread active: waiting_on_approval",
              true,
              "waiting_approval"
            );
          } else if (method === "thread/status/changed" && threadStatus?.sessionState === "running") {
            settleRelayAgentMessages(
              "model_processing",
              "thread active",
              true,
              threadStatus.threadStatusType
            );
          } else if (
            method === "item/commandExecution/requestApproval" ||
            method === "item/fileChange/requestApproval"
          ) {
            settleRelayAgentMessages(
              "tool_waiting_approval",
              "approval required",
              true,
              "waiting_approval"
            );
            rememberSessionRuntimeStatus(threadId, {
              hasRunningTurn: true,
              hasPendingAssistant: true,
              restoredInFlight: false,
              waitingApproval: true,
            });
          }
          if (!isQueueTurnObserver) return;
          if (method === "turn/started") {
            if (!ignoredPreAgentTurnCompleted) return;
            settleRelayAgentMessages(
              "model_processing",
              "turn started",
              true,
              "active"
            );
          }
        },
        onDelta: (delta, params) => {
          const active = codexRelayObserverRef.current;
          if (!active || active.threadId !== threadId) return;
          const normalizedDelta = String(delta || "");
          if (!normalizedDelta) return;
          observedAgentMessage = true;
          const itemId = resolveAgentMessageItemId(params);
          const replaySplit = splitDeltaAfterRestoredPrefix(restoredReplayPrefixRemaining, normalizedDelta);
          restoredReplayPrefixRemaining = replaySplit.remainingPrefix;
          const nextItemContent = `${String(agentMessageContentById.get(itemId) || "")}${replaySplit.deltaToAppend}`;
          agentMessageContentById.set(itemId, nextItemContent);
          rebuildRelayReply();
          updateRelayPanelLiveAssistantMessage(
            nextItemContent,
            "model_generating",
            "delta:native",
            true,
            "active",
            agentMessageUiIdByItemId.get(itemId)
          );
        },
        onAgentMessageCompleted: (text, params) => {
          const active = codexRelayObserverRef.current;
          if (!active || active.threadId !== threadId) return;
          const normalizedText = String(text || "");
          if (!normalizedText) return;
          observedAgentMessage = true;
          const itemId = resolveAgentMessageItemId(params);
          agentMessageContentById.set(itemId, normalizedText);
          rebuildRelayReply();
          restoredReplayPrefixRemaining = "";
          updateRelayPanelLiveAssistantMessage(
            normalizedText,
            "model_generating",
            "agent message completed",
            true,
            "active",
            agentMessageUiIdByItemId.get(itemId)
          );
        },
        onTurnCompleted: () => {
          const active = codexRelayObserverRef.current;
          if (!active || active.threadId !== threadId) return;
          if (shouldWaitForAgentMessageBeforeFinalize && !observedAgentMessage) {
            ignoredPreAgentTurnCompleted = true;
            logSessionDiag("session_relay_observer_turn_completed_ignored", {
              threadId,
              reason: observerReason,
              panelId: active.panelId || targetPanelId || undefined,
            }, {
              throttleMs: 0,
              throttleKey: `session_relay_observer_turn_completed_ignored:${threadId}`,
            });
            return;
          }
          if (finishWaitingApprovalResumeAttempt(threadId, "turn_completed")) {
            setWaitingApprovalResumeStatusText("承認待ちは解消済みでした（完了イベントを受信）。");
          }
          rememberSessionRuntimeStatus(threadId, {
            hasRunningTurn: false,
            hasPendingAssistant: false,
            restoredInFlight: false,
            waitingApproval: false,
          });
          completeRuntimeRequestForRelayCompletion?.({
            threadId,
            startedAtMs,
            reason: observerReason,
          });
          const canProjectCompletion = shouldProjectRelayToTarget();
          if (canProjectCompletion) {
            settleRelayAgentMessages(
              "completed",
              "turn completed",
              false,
              "idle"
            );
          }
          const finalAgentMessage = getLastAgentMessage();
          if (!relayProjectionSuppressed) {
            void onAssistantTurnCompleted?.({
              threadId,
              panelId: isSessionRuntimeObserver ? undefined : targetPanelId || undefined,
              messageId: finalAgentMessage?.messageId || defaultRelayAssistantMessageId,
              text: applyAssistantReply(finalAgentMessage?.content || ""),
              directory,
              reason: observerReason,
            });
          }
          if (isQueueTurnObserver) {
            closeCodexRelayObserver("turn_completed");
            return;
          }
          closeCodexRelayObserver("turn_completed");
        },
        onApprovalRequest: (request) => {
          const nextRequest = targetPanelId && !isSessionRuntimeObserver
            ? {
              ...request,
              sessionInfo: {
                ...request.sessionInfo,
                panelId: targetPanelId,
                sessionId: String(request.sessionInfo?.sessionId || request.threadId || threadId).trim(),
              },
            }
            : request;
          return onApprovalRequest(nextRequest);
        },
        onApprovalRequestResolved,
      });
      codexRelayObserverRef.current = {
        threadId,
        panelId: isSessionRuntimeObserver ? undefined : targetPanelId || undefined,
        close: observer.close,
      };
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSessionDiag("session_relay_observer_start_error", {
        threadId,
        reason: String(options?.reason || "session_restore"),
        message,
      }, {
        throttleMs: 0,
        throttleKey: `session_relay_observer_start_error:${threadId}`,
      });
      return false;
    }
  }, [
    applyAssistantReply,
    buildConversationMessage,
    clearCodexRelayObserverForMiss,
    closeCodexRelayObserver,
    codexRelayObserverRef,
    codexRelayObserverReplyByThreadRef,
    codexRelayObserverStartedAtMsByThreadRef,
    codexWsToken,
    codexWsUrl,
    finishWaitingApprovalResumeAttempt,
    finalizeSessionRuntimeAfterRelayLoss,
    getActiveConversationMessagesForCodex,
    getPanelConversationMessagesForCodexRef,
    getSessionConversationMessagesForCodex,
    llmRequestStartedAtRef,
    logSessionDiag,
    normalizedLlmDirectoryForRequest,
    onApprovalRequest,
    onApprovalRequestResolved,
    onAssistantTurnCompleted,
    parseLlmDirectory,
    parseOptionalSessionId,
    rememberSessionRuntimeStatus,
    reply,
    setActiveConversationMessagesForCodex,
    setPanelConversationMessagesForCodexRef,
    setSessionConversationMessagesForCodex,
    shouldProjectRelayConversation,
    completeRuntimeRequestForRelayCompletion,
    setWaitingApprovalResumeStatusText,
    waitingApprovalResumePendingSessionIdRef,
  ]);

  return {
    startCodexRelayObserverForSession,
  };
}
