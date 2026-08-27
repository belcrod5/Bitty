import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  deriveCodexSessionStateFromSnapshot,
  startCodexAppServerTurnRelayObserver,
} from "../../codex/codexAppServerClient";
import type { ApprovalAction, ApprovalRequest } from "../../codex/approvalFlow";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { ConversationMessage, SessionRuntimeStatus } from "../types/appTypes";
import { codexItemMessageId } from "../utils/codexItemMessageId";
import {
  findLatestAssistantMessageIndex,
  upsertCommandExecutionMessage,
} from "../utils/sessionRuntimeStatus";
import { resolveCodexItemRuntimeStatus } from "../utils/statusIcons";
import type { LlmUiStatus } from "./useLlmRequestStatus";

type CodexRelayObserverRef = MutableRefObject<{
  threadId: string;
  panelId?: string;
  close: () => void;
  interrupt?: () => Promise<void>;
} | null>;

// threadIdごとの実受信済みrelay位置(メモリのみ、永続化しない)。
// observer再生成時にresumeFromSeqへ解決し、現行turn全イベントの再送を避ける。
export type CodexRelayWatermark = { relayId: string; seq: number };

type StartCodexRelayObserverOptions = {
  agentBackendId?: string;
  directory?: string;
  startedAtMs?: number | null;
  resumeFromSeq?: number;
  // trueならwatermarkを使わずseq=0(サーバーの現行turn補正)でresumeする。
  // pending approvalはseq≦replayAfterSeqだとサーバーが再送しないため、
  // 承認待ち再開・承認待ち復元の経路は必ずtrueにすること。
  ignoreWatermark?: boolean;
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
  codexRelayWatermarkByThreadRef: MutableRefObject<Record<string, CodexRelayWatermark>>;
  // relay作り直し検出(attachedのrelayId不一致 or latestSeq後退)時に1回呼ばれる。
  // watermarkはリセット済み。呼び出し側はHTTP差分同期(requestSessionResync相当)で
  // 欠落分を穴埋めする。
  onRelayWatermarkGap?: (threadId: string) => void;
  llmRequestStartedAtRef: MutableRefObject<number>;
  reply: string;
  codexWsUrl: string;
  runnerToken: string;
  runnerWebSocketManager?: RunnerWebSocketManager;
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
  // 別スレッドのobserver起動で既存observerをclean closeする(=強奪)直前に呼ぶ。
  // 奪われた側のセッションはresume_missを出せずライブ経路を失うため、呼び出し側が
  // 再同期マーカーへの登録などの補償を行う。
  onObserverPreempted?: (previousThreadId: string) => void;
  onAssistantTurnCompleted?: (params: {
    threadId: string;
    panelId?: string;
    messageId: string;
    text: string;
    directory: string;
    reason: string;
  }) => void | Promise<void>;
  onRuntimeStatus?: (threadId: string, status: LlmUiStatus, detail: string) => void;
  ensureRuntimeRequestForRelay?: (params: {
    sessionId: string;
    sourcePanelId?: string;
    startedAtMs: number;
    reason: string;
  }) => unknown;
  onSessionStreamBoundary?: (sessionId: string) => void | Promise<void>;
};

function findLatestAssistantMessage(messages: ConversationMessage[]) {
  const index = findLatestAssistantMessageIndex(messages);
  return index >= 0 ? messages[index] : null;
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
  codexRelayWatermarkByThreadRef,
  onRelayWatermarkGap,
  llmRequestStartedAtRef,
  reply,
  codexWsUrl,
  runnerToken,
  runnerWebSocketManager,
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
  onObserverPreempted,
  onAssistantTurnCompleted,
  onRuntimeStatus,
  ensureRuntimeRequestForRelay,
  onSessionStreamBoundary,
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
      try {
        onObserverPreempted?.(existing.threadId);
      } catch {}
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
        // 1つ目のitemは表示中のassistantバブルのIDを引き継いで重複表示を防ぐ。
        // それ以外はuseCodexReplyRequestと同じ決定的ID(codexItemMessageId)にし、
        // ライブ経路間で同一itemが同一IDにupsertされるようにする。
        agentMessageUiIdByItemId.set(
          itemId,
          isFirstItem && initialPanelAssistant
            ? defaultRelayAssistantMessageId
            : itemId !== "__agent_message__"
              ? codexItemMessageId(threadId, itemId)
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
      messageIdRaw?: string,
      terminalQueueStatus?: "completed" | "failed" | "cancelled"
    ) => {
      if (!shouldProjectRelayToTarget()) return;
      const latestConversation = relayPanelConversationDraft.length > 0
        ? relayPanelConversationDraft
        : readTargetConversation();
      const content = applyAssistantReply(String(contentRaw || ""));
      const queueStatus: NonNullable<ConversationMessage["codexQueue"]>["status"] = isResponding
        ? "running"
        : terminalQueueStatus || "completed";
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
    const upsertRelayCommandMessage = (itemRaw: unknown, phase: "started" | "completed") => {
      if (!shouldProjectRelayToTarget()) return;
      const item = itemRaw && typeof itemRaw === "object" ? itemRaw as Record<string, unknown> : {};
      const itemId = String(item.id || "").trim();
      if (!itemId) return;
      const latestConversation = relayPanelConversationDraft.length > 0
        ? relayPanelConversationDraft
        : readTargetConversation();
      const nextConversation = upsertCommandExecutionMessage(
        latestConversation,
        item,
        phase,
        codexItemMessageId(threadId, itemId),
        (commandExecution) => buildConversationMessage("assistant", "", { commandExecution })
      );
      relayPanelConversationDraft = nextConversation;
      writeTargetConversation(nextConversation, {
        isResponding: true,
        selectedThreadStatusType: "active",
        sessionId: threadId,
      });
    };
    const settleRelayAgentMessages = (
      status: LlmUiStatus,
      detail: string,
      isResponding: boolean,
      selectedThreadStatusType: string,
      terminalQueueStatus?: "completed" | "failed" | "cancelled"
    ) => {
      const liveMessageIds = new Set(Array.from(agentMessageUiIdByItemId.values()));
      if (liveMessageIds.size === 0) {
        updateRelayPanelLiveAssistantMessage(
          codexRelayObserverReplyByThreadRef.current[threadId] || "",
          status,
          detail,
          isResponding,
          selectedThreadStatusType,
          undefined,
          terminalQueueStatus
        );
        return;
      }
      const latestConversation = relayPanelConversationDraft.length > 0
        ? relayPanelConversationDraft
        : readTargetConversation();
      const queueStatus: NonNullable<ConversationMessage["codexQueue"]>["status"] = isResponding
        ? "running"
        : terminalQueueStatus || "completed";
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
    // resumeFromSeq未指定(または0)ならwatermark(実受信済みseq)から差分再開する。
    // replayAfterSeq=0はサーバー側で「現行turn全イベント再送」に補正されるため、
    // observer再生成のたびに全再送となるのを避ける。
    // 例外: ignoreWatermark時(承認待ち再開など、pending approvalの再送が必要)と、
    // relayId不明のwatermark(relay作り直し照合が素通りになり無音欠落リスク)は使わない。
    const requestedResumeFromSeq = Number.isFinite(Number(options?.resumeFromSeq))
      ? Math.max(0, Math.floor(Number(options?.resumeFromSeq)))
      : 0;
    const watermark = options?.ignoreWatermark === true
      ? undefined
      : codexRelayWatermarkByThreadRef.current[threadId];
    const watermarkRelayId = String(watermark?.relayId || "").trim();
    const watermarkSeq = watermarkRelayId
      ? Math.max(0, Math.floor(Number(watermark?.seq) || 0))
      : 0;
    const usingWatermark = requestedResumeFromSeq === 0 && watermarkSeq > 0;
    const resumeFromSeq = usingWatermark ? watermarkSeq : requestedResumeFromSeq;
    const resumeFromRelayId = usingWatermark ? watermarkRelayId : "";
    logSessionDiag("session_relay_observer_start", {
      threadId,
      reason: observerReason,
      directory,
      panelId: isSessionRuntimeObserver ? undefined : targetPanelId || undefined,
      requestedPanelId: targetPanelId || undefined,
      observerScope: isSessionRuntimeObserver ? "session" : "panel",
      resumeFromSeq,
      resumeSource: options?.ignoreWatermark === true
        ? "ignored"
        : requestedResumeFromSeq > 0
          ? "explicit"
          : usingWatermark
            ? "watermark"
            : "none",
    }, {
      throttleMs: 0,
      throttleKey: `session_relay_observer_start:${threadId}`,
    });
    try {
      const observer = startCodexAppServerTurnRelayObserver({
        wsUrl: codexWsUrl.trim(),
        wsToken: runnerToken.trim(),
        runnerWebSocketManager,
        backendId: options?.agentBackendId,
        preferNeutralAgent: Boolean(options?.agentBackendId),
        rawFallbackBackendId: "codex",
        threadId,
        resumeFromSeq,
        resumeFromRelayId,
        onRelaySeqAdvance: ({ relayId, seq }) => {
          const active = codexRelayObserverRef.current;
          if (!active || active.threadId !== threadId) return;
          const prev = codexRelayWatermarkByThreadRef.current[threadId];
          const prevRelayId = String(prev?.relayId || "");
          const nextRelayId = String(relayId || "").trim();
          const prevSeq = Math.max(0, Math.floor(Number(prev?.seq) || 0));
          const nextSeq = Math.max(0, Math.floor(Number(seq) || 0));
          // seqはrelayインスタンススコープ。別relayのseqをmaxすると古い大seqが残り
          // 無音欠落(または後退reset→不要なgapマーカー)につながるため、relayIdが
          // 変わったら置き換える。relayId未確定("")の残留watermarkに初めてrelayIdが
          // 付くときも、旧seqの出所relayは不明なので置き換える。
          const relayChanged = nextRelayId !== "" && nextRelayId !== prevRelayId;
          codexRelayWatermarkByThreadRef.current[threadId] = {
            relayId: nextRelayId || prevRelayId,
            seq: relayChanged ? nextSeq : Math.max(prevSeq, nextSeq),
          };
        },
        onRelayReset: ({ relayId, seq }) => {
          const active = codexRelayObserverRef.current;
          if (!active || active.threadId !== threadId) return;
          const nextSeq = Math.max(0, Math.floor(Number(seq) || 0));
          codexRelayWatermarkByThreadRef.current[threadId] = {
            relayId: String(relayId || "").trim(),
            seq: nextSeq,
          };
          // latestSeq=0の新relayは「まだ何も流れていない」= 欠落ゼロ確定。
          // relay完了TTL明けの新turnごとにHTTP全文fetchが走るのを防ぐため、
          // watermark上書きのみ行い穴埋め同期は要求しない。
          const gapResync = nextSeq > 0;
          logSessionDiag("session_relay_watermark_reset", {
            threadId,
            reason: observerReason,
            relayId: String(relayId || "").trim() || undefined,
            seq: nextSeq,
            gapResync,
          }, {
            throttleMs: 0,
            throttleKey: `session_relay_watermark_reset:${threadId}`,
          });
          // relay作り直しの間に流れたイベントはreplayで埋まらないため、
          // 既存の再同期経路に欠落分の回収を要求する。
          if (gapResync) {
            try {
              onRelayWatermarkGap?.(threadId);
            } catch {}
          }
        },
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
            // eventLogトリム起因のmissは同じwatermarkで再attachしても再びmissする
            // (恒久ループ)ため、watermarkを破棄して次回はseq=0へ落とす。
            delete codexRelayWatermarkByThreadRef.current[threadId];
            // relay喪失(replay不能)。セッション実行中の復元observerは
            // finalizeSessionRuntimeAfterRelayLoss経由でJSONLから本文を再同期する。
            if (isSessionRuntimeObserver) {
              finalizeSessionRuntimeAfterRelayLoss(threadId, "relay が見つからないため、ライブ再開できません。");
            }
            clearCodexRelayObserverForMiss(threadId, directory);
            return;
          } else if (stage === "relay_observer_relay_closed") {
            if (finishWaitingApprovalResumeAttempt(threadId, stage)) {
              setWaitingApprovalResumeStatusText("承認待ち再開の relay が切断されました。再接続を待機しています。");
            }
            // サーバー側でrelayが破棄された(turn完了未受信のまま配信終了)。
            // resume_missと同じ回復経路に合流し、JSONLから本文を再同期する。
            if (isSessionRuntimeObserver) {
              finalizeSessionRuntimeAfterRelayLoss(threadId, "relay が切断されたため、ライブ配信を継続できません。");
              closeCodexRelayObserver("relay_closed");
              return;
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
          if (method === "item/completed") {
            void onSessionStreamBoundary?.(threadId);
          }
          const payload = params && typeof params === "object" ? params as Record<string, unknown> : {};
          if (
            (method === "item/started" || method === "item/completed") &&
            String((payload as any)?.item?.type || "") === "commandExecution"
          ) {
            upsertRelayCommandMessage(
              (payload as any).item,
              method === "item/started" ? "started" : "completed"
            );
          }
          const itemRuntimeStatus = method === "item/started" || method === "item/completed"
            ? resolveCodexItemRuntimeStatus(
              (payload as any)?.item,
              method === "item/started" ? "started" : "completed"
            )
            : null;
          if (itemRuntimeStatus) {
            settleRelayAgentMessages(itemRuntimeStatus.status, itemRuntimeStatus.detail, true, "active");
            onRuntimeStatus?.(threadId, itemRuntimeStatus.status, itemRuntimeStatus.detail);
          }
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
          onRuntimeStatus?.(threadId, "model_processing", "agent message completed");
        },
        onTurnCompleted: (terminalRaw) => {
          const active = codexRelayObserverRef.current;
          if (!active || active.threadId !== threadId) return;
          const terminal = terminalRaw && typeof terminalRaw === "object"
            ? terminalRaw as Record<string, unknown>
            : {};
          const outcome = String(terminal.outcome || "completed");
          const failed = outcome === "failed";
          const interrupted = outcome === "interrupted";
          if (shouldWaitForAgentMessageBeforeFinalize && !observedAgentMessage && !failed && !interrupted) {
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
              failed || interrupted ? "error" : "completed",
              failed
                ? String((terminal.error as any)?.message || "turn failed")
                : interrupted ? "turn interrupted" : "turn completed",
              false,
              "idle",
              failed ? "failed" : interrupted ? "cancelled" : "completed"
            );
          }
          if (failed || interrupted) {
            onRuntimeStatus?.(
              threadId,
              "error",
              failed ? String((terminal.error as any)?.message || "turn failed") : "turn interrupted",
            );
          }
          const finalAgentMessage = getLastAgentMessage();
          if (!failed && !interrupted && !relayProjectionSuppressed) {
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
            closeCodexRelayObserver(failed ? "turn_failed" : interrupted ? "turn_interrupted" : "turn_completed");
            return;
          }
          closeCodexRelayObserver(failed ? "turn_failed" : interrupted ? "turn_interrupted" : "turn_completed");
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
      if (startedAtMs && startedAtMs > 0) {
        ensureRuntimeRequestForRelay?.({
          sessionId: threadId,
          sourcePanelId: targetPanelId || undefined,
          startedAtMs: Math.floor(startedAtMs),
          reason: observerReason,
        });
      }
      codexRelayObserverRef.current = {
        threadId,
        panelId: isSessionRuntimeObserver ? undefined : targetPanelId || undefined,
        close: observer.close,
        interrupt: observer.interrupt,
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
    codexRelayWatermarkByThreadRef,
    onRelayWatermarkGap,
    runnerToken,
    codexWsUrl,
    runnerWebSocketManager,
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
    onObserverPreempted,
    onAssistantTurnCompleted,
    onRuntimeStatus,
    ensureRuntimeRequestForRelay,
    onSessionStreamBoundary,
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
