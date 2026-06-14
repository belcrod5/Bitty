import type { ConversationMessage, LlmSessionMessage } from "../types/appTypes";
import type { RunnerSessionMessagesResult } from "../hooks/useLlmSessionExplorer";
import {
  hasPendingAssistantReplyInConversation,
  inferLatestToolLabelFromAssistantMessages,
  parseIsoTimestampMs,
} from "./sessionRuntimeStatus";
import { deriveSessionExecutionStatusType } from "./sessionExecutionStatus";

type BuildRestoredSessionRuntimeSnapshotArgs = {
  restored: RunnerSessionMessagesResult;
  restoredMessages: LlmSessionMessage[];
  nextConversation: ConversationMessage[];
  nextSessionId: string;
  sessionResumeAutoSignalMaxAgeMs: number;
  restoreReplyRequestForThread: (sessionIdRaw: unknown, options?: { panelId?: string }) => boolean;
  panelId?: string;
};

export type RestoredSessionRuntimeSnapshot = {
  hasPendingAssistant: boolean;
  hasRunningTurn: boolean;
  latestAssistantText: string;
  restoredThreadId: string;
  rawRestoredInFlight: boolean;
  restoredInFlight: boolean;
  runningTurnStatus: string;
  runningTurnSummary: string;
  latestToolLabelOnRestore: string;
  waitingApprovalOnRestore: boolean;
  hasApprovalRequiredMessage: boolean;
  hasApprovalBlockedErrorMessage: boolean;
  runningStartedAtMs: number | null;
  runningUpdatedAtMs: number | null;
  runningSignalUpdatedAtMs: number | null;
  runningSignalAgeMs: number | null;
  hasFreshResumeSignal: boolean;
  hasStalePendingAssistantGhost: boolean;
  effectiveHasPendingAssistant: boolean;
};

type BuildConversationMessage = (
  role: "user" | "assistant",
  content: string,
  extra?: Omit<Partial<ConversationMessage>, "id" | "role" | "content">
) => ConversationMessage;

export function deriveRestoredSessionThreadStatusType(restored: Pick<RunnerSessionMessagesResult, "hasRunningTurn" | "threadStatusType" | "runningTurn">) {
  const runningTurnStatus = String(restored.runningTurn?.status || "").trim().toLowerCase();
  const runningTurnSummary = String(restored.runningTurn?.summary || "").trim();
  if (
    restored.hasRunningTurn &&
    (
      runningTurnStatus.includes("approval") ||
      runningTurnSummary.includes("承認待ち")
    )
  ) {
    return "waiting_approval";
  }
  const executionStatus = deriveSessionExecutionStatusType({
    threadStatusType: restored.threadStatusType,
    hasRunningTurn: restored.hasRunningTurn,
  });
  return executionStatus === "unknown" ? "idle" : executionStatus;
}

export function projectRestoredRuntimeStatusToConversation(params: {
  conversation: ConversationMessage[];
  restored: Pick<RunnerSessionMessagesResult, "hasRunningTurn" | "threadStatusType" | "runningTurn">;
  fallbackMessageId: string;
  buildConversationMessage: BuildConversationMessage;
}) {
  const {
    conversation,
    restored,
    fallbackMessageId,
    buildConversationMessage,
  } = params;
  if (!restored.hasRunningTurn) return conversation;
  const llmStatus: ConversationMessage["llmStatus"] = deriveRestoredSessionThreadStatusType(restored) === "waiting_approval"
    ? "tool_waiting_approval"
    : "model_processing";
  const llmStatusDetail = llmStatus === "tool_waiting_approval"
    ? "thread active: waiting_on_approval"
    : "thread active";
  let liveAssistantIndex = -1;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (message.role !== "assistant") continue;
    liveAssistantIndex = index;
    break;
  }
  if (liveAssistantIndex >= 0) {
    return conversation.map((message, index) => (
      index === liveAssistantIndex
        ? {
          ...message,
          llmStatus,
          llmStatusDetail,
        }
        : message
    ));
  }
  return [
    ...conversation,
    {
      ...buildConversationMessage("assistant", "", {
        llmStatus,
        llmStatusDetail,
      }),
      id: fallbackMessageId,
    },
  ];
}

export function buildRestoredSessionRuntimeSnapshot({
  restored,
  restoredMessages,
  nextConversation,
  nextSessionId,
  sessionResumeAutoSignalMaxAgeMs,
  restoreReplyRequestForThread,
  panelId,
}: BuildRestoredSessionRuntimeSnapshotArgs): RestoredSessionRuntimeSnapshot {
  const hasPendingAssistant = hasPendingAssistantReplyInConversation(nextConversation);
  const hasRunningTurn = Boolean(restored.hasRunningTurn);
  let latestAssistantText = "";
  for (let i = restoredMessages.length - 1; i >= 0; i -= 1) {
    if (restoredMessages[i].role === "assistant") {
      latestAssistantText = String(restoredMessages[i].content || "").trim();
      break;
    }
  }
  const restoredThreadId = restored.threadId || nextSessionId;
  const runtimePanelId = String(panelId || "").trim();
  const rawRestoredInFlight = runtimePanelId
    ? (
      restoreReplyRequestForThread(restoredThreadId, { panelId: runtimePanelId }) ||
      restoreReplyRequestForThread(nextSessionId, { panelId: runtimePanelId })
    )
    : false;
  const runningTurnStatus = String(restored.runningTurn?.status || "").trim().toLowerCase();
  const runningTurnSummary = String(restored.runningTurn?.summary || "").trim();
  const latestToolLabelOnRestore = (
    inferLatestToolLabelFromAssistantMessages(nextConversation) ||
    String(restored.latestToolLabel || "").trim()
  );
  const waitingApprovalOnRestore = (
    hasRunningTurn &&
    (
      runningTurnStatus.includes("approval") ||
      runningTurnSummary.includes("承認待ち")
    )
  );
  const hasAssistantMessageWithPrefix = (prefix: string) => (
    nextConversation.some((item) => (
      item.role === "assistant" &&
      String(item.content || "").trim().startsWith(prefix)
    ))
  );
  const hasApprovalRequiredMessage = hasAssistantMessageWithPrefix("tool_approval_required :");
  const hasApprovalBlockedErrorMessage = hasAssistantMessageWithPrefix("tool_error : 承認待ちで停止中");
  const runningStartedAtMs = parseIsoTimestampMs(restored.runningTurn?.startedAt);
  const runningUpdatedAtMs = parseIsoTimestampMs(
    restored.runningTurn?.updatedAt || restored.updatedAt
  );
  const runningSignalUpdatedAtMs = runningUpdatedAtMs ?? parseIsoTimestampMs(restored.updatedAt);
  const runningSignalAgeMs = runningSignalUpdatedAtMs === null
    ? null
    : Math.max(0, Date.now() - runningSignalUpdatedAtMs);
  const hasFreshResumeSignal = (
    runningSignalAgeMs !== null &&
    runningSignalAgeMs <= sessionResumeAutoSignalMaxAgeMs
  );
  const hasStalePendingAssistantGhost = false;
  const restoredInFlight = (
    rawRestoredInFlight &&
    (hasRunningTurn || hasPendingAssistant)
  );
  const effectiveHasPendingAssistant = (hasRunningTurn || restoredInFlight)
    ? hasPendingAssistant
    : false;

  return {
    hasPendingAssistant,
    hasRunningTurn,
    latestAssistantText,
    restoredThreadId,
    rawRestoredInFlight,
    restoredInFlight,
    runningTurnStatus,
    runningTurnSummary,
    latestToolLabelOnRestore,
    waitingApprovalOnRestore,
    hasApprovalRequiredMessage,
    hasApprovalBlockedErrorMessage,
    runningStartedAtMs,
    runningUpdatedAtMs,
    runningSignalUpdatedAtMs,
    runningSignalAgeMs,
    hasFreshResumeSignal,
    hasStalePendingAssistantGhost,
    effectiveHasPendingAssistant,
  };
}
