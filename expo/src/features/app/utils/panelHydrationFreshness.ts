import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import type { ConversationMessage } from "../types/appTypes";

export const RUNTIME_CONVERSATION_FRESHNESS_GRACE_MS = 30_000;

type HydratedPanelRuntimeEntry = {
  sessionId?: string;
  snapshot: PanelRuntimeSnapshot;
};

export function applyPanelHydrationStart(params: {
  entries: Record<string, HydratedPanelRuntimeEntry>;
  panelId: string;
  sessionId: string;
  emptySnapshot: PanelRuntimeSnapshot;
  directory: string;
  directoryDisplayName: string;
  titleHint: string;
  updatedAtHint: string;
  modelRefHint: string;
  reasoningEffortHint: string;
  contextUsedPctHint: number | null;
}) {
  const current = params.entries[params.panelId];
  const currentSessionId = String(current?.snapshot.selectedSessionId || current?.sessionId || "").trim();
  const isSameSession = currentSessionId === params.sessionId;
  const base = isSameSession && current ? current.snapshot : params.emptySnapshot;
  const snapshot: PanelRuntimeSnapshot = {
    ...base,
    selectedSessionId: params.sessionId,
    selectedDirectoryPath: params.directory,
    selectedDirectoryDisplayName: params.directoryDisplayName,
    selectedSessionTitle: params.titleHint || base.selectedSessionTitle || "（ユーザーメッセージなし）",
    selectedSessionUpdatedAt: params.updatedAtHint || base.selectedSessionUpdatedAt,
    selectedThreadStatusType: isSameSession ? base.selectedThreadStatusType : "loading",
    modelRef: params.modelRefHint || base.modelRef,
    reasoningEffort: params.reasoningEffortHint || base.reasoningEffort,
    contextUsedPct: params.contextUsedPctHint ?? base.contextUsedPct,
    isResponding: isSameSession && base.isResponding,
    isHydrating: true,
    conversationMessages: isSameSession ? base.conversationMessages : [],
  };
  return {
    ...params.entries,
    [params.panelId]: { sessionId: params.sessionId, snapshot },
  };
}

export type RuntimeConversationFreshnessInput = {
  runtimeMessageCount: number;
  runtimeUpdatedAtMs: number;
  runtimeIsResponding: boolean;
  runtimeRequestStartedAtMs: number | null;
  requestStartedAtMsAtHydrationStart: number | null;
  requestCompletedAtMs: number | null;
  restoredHasRunningTurn: boolean;
  restoredUpdatedAtMs: number | null;
  restoredMessageCount: number;
  nowMs: number;
};

export function shouldPreserveRuntimeConversationOnHydrate(
  input: RuntimeConversationFreshnessInput
): boolean {
  const runtimeRequestChangedDuringHydration = (
    input.runtimeRequestStartedAtMs !== null &&
    input.runtimeRequestStartedAtMs !== input.requestStartedAtMsAtHydrationStart
  );
  if (!input.restoredHasRunningTurn) return runtimeRequestChangedDuringHydration;
  if (input.runtimeMessageCount <= 0) return false; // (a) ランタイム空 → 従来どおり置換
  if (input.runtimeIsResponding) return true; // (b) ライブターン進行中 → 保持
  const completedAtMs = input.requestCompletedAtMs || 0; // (c) このクライアントで完了直後 → 保持
  if (completedAtMs > 0 && input.nowMs - completedAtMs <= RUNTIME_CONVERSATION_FRESHNESS_GRACE_MS) {
    return true;
  }
  if (input.restoredUpdatedAtMs !== null && input.restoredUpdatedAtMs > 0) {
    return input.runtimeUpdatedAtMs >= input.restoredUpdatedAtMs; // (d) タイムスタンプ比較（同値は保持）
  }
  return input.runtimeMessageCount >= input.restoredMessageCount; // (e) 欠落時フォールバック
}

function hasSameHydratedContent(left: ConversationMessage, right: ConversationMessage) {
  const leftCommand = left.commandExecution;
  const rightCommand = right.commandExecution;
  return (
    left.role === right.role &&
    left.content === right.content &&
    (
      (!leftCommand && !rightCommand) ||
      (
        leftCommand?.command === rightCommand?.command &&
        leftCommand?.status === rightCommand?.status &&
        leftCommand?.exitCode === rightCommand?.exitCode
      )
    )
  );
}

function reconcileTerminalPanelConversation(params: {
  restoredConversation: ConversationMessage[];
  panelConversation: ConversationMessage[];
  ttsPlaybackMessageId: string;
}) {
  let panelSearchStart = 0;
  const retainedMessageIds = new Set<string>();
  const conversationMessages = params.restoredConversation.map((restoredMessage) => {
    let matchedIndex = -1;
    for (let index = panelSearchStart; index < params.panelConversation.length; index += 1) {
      if (!hasSameHydratedContent(params.panelConversation[index], restoredMessage)) continue;
      matchedIndex = index;
      break;
    }
    if (matchedIndex < 0) return restoredMessage;
    panelSearchStart = matchedIndex + 1;
    const panelMessage = params.panelConversation[matchedIndex];
    retainedMessageIds.add(panelMessage.id);
    return {
      ...restoredMessage,
      id: panelMessage.id,
      ttsWaveform: Array.isArray(panelMessage.ttsWaveform)
        ? [...panelMessage.ttsWaveform]
        : undefined,
    };
  });
  const ttsPlaybackMessageId = retainedMessageIds.has(params.ttsPlaybackMessageId)
    ? params.ttsPlaybackMessageId
    : "";
  return { conversationMessages, ttsPlaybackMessageId };
}

export function resolvePanelConversationAfterHydration(params: {
  runtime: {
    conversationMessages: ConversationMessage[];
    updatedAtMs: number;
    isResponding: boolean;
    requestStartedAtMs: number | null;
    requestCompletedAtMs: number | null;
    selectedThreadStatusType: string;
  } | null;
  requestStartedAtMsAtHydrationStart: number | null;
  restoredConversation: ConversationMessage[];
  restoredHasRunningTurn: boolean;
  restoredThreadStatusType: string;
  restoredUpdatedAtMs: number | null;
  restoredMessageCount: number;
  panelConversation: ConversationMessage[];
  ttsPlaybackMessageId: string;
  nowMs: number;
}) {
  const preserveRuntimeConversation = shouldPreserveRuntimeConversationOnHydrate({
    runtimeMessageCount: params.runtime?.conversationMessages.length ?? 0,
    runtimeUpdatedAtMs: params.runtime?.updatedAtMs ?? 0,
    runtimeIsResponding: params.runtime?.isResponding ?? false,
    runtimeRequestStartedAtMs: params.runtime?.requestStartedAtMs ?? null,
    requestStartedAtMsAtHydrationStart: params.requestStartedAtMsAtHydrationStart,
    requestCompletedAtMs: params.runtime?.requestCompletedAtMs ?? null,
    restoredHasRunningTurn: params.restoredHasRunningTurn,
    restoredUpdatedAtMs: params.restoredUpdatedAtMs,
    restoredMessageCount: params.restoredMessageCount,
    nowMs: params.nowMs,
  });
  if (preserveRuntimeConversation && params.runtime) {
    return {
      conversationMessages: params.runtime.conversationMessages,
      isResponding: params.runtime.isResponding,
      selectedThreadStatusType: params.runtime.selectedThreadStatusType,
      ttsPlaybackMessageId: params.ttsPlaybackMessageId,
      preserveRuntimeConversation,
    };
  }
  if (params.restoredHasRunningTurn) {
    return {
      conversationMessages: params.restoredConversation,
      isResponding: true,
      selectedThreadStatusType: params.restoredThreadStatusType,
      ttsPlaybackMessageId: "",
      preserveRuntimeConversation: false,
    };
  }
  const terminal = reconcileTerminalPanelConversation({
    restoredConversation: params.restoredConversation,
    panelConversation: params.panelConversation,
    ttsPlaybackMessageId: params.ttsPlaybackMessageId,
  });
  return {
    ...terminal,
    isResponding: false,
    selectedThreadStatusType: params.restoredThreadStatusType,
    preserveRuntimeConversation: false,
  };
}

export function applyPanelHydrationSnapshot(params: {
  entries: Record<string, HydratedPanelRuntimeEntry>;
  panelId: string;
  sessionId: string;
  snapshot: PanelRuntimeSnapshot;
  expectedRequestStartedAtMs: number | null;
  currentRequestStartedAtMs: number | null;
}) {
  const current = params.entries[params.panelId];
  const currentSessionId = String(current?.snapshot.selectedSessionId || current?.sessionId || "").trim();
  if (currentSessionId !== params.sessionId) {
    return params.entries;
  }
  if (params.currentRequestStartedAtMs !== params.expectedRequestStartedAtMs) {
    if (!current.snapshot.isHydrating) return params.entries;
    return {
      ...params.entries,
      [params.panelId]: {
        ...current,
        snapshot: { ...current.snapshot, isHydrating: false },
      },
    };
  }
  return {
    ...params.entries,
    [params.panelId]: {
      sessionId: params.snapshot.selectedSessionId,
      snapshot: params.snapshot,
    },
  };
}
