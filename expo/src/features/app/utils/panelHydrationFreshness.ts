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

// 復元メッセージとパネル表示中メッセージはitemId由来の決定的IDを共有する
// (codexItemMessageId)。同一IDのメッセージはpanel-localな表示メタデータ
// (ttsWaveform)を引き継ぎ、ttsPlaybackMessageId は復元後も存在するIDに限り残す。
function reconcileRestoredPanelConversation(params: {
  restoredConversation: ConversationMessage[];
  panelConversation: ConversationMessage[];
  ttsPlaybackMessageId: string;
}) {
  const panelMessagesById = new Map(
    params.panelConversation.map((message) => [message.id, message])
  );
  let ttsPlaybackMessageId = "";
  const conversationMessages = params.restoredConversation.map((restoredMessage) => {
    if (restoredMessage.id === params.ttsPlaybackMessageId) {
      ttsPlaybackMessageId = params.ttsPlaybackMessageId;
    }
    const panelMessage = panelMessagesById.get(restoredMessage.id);
    if (!panelMessage || !Array.isArray(panelMessage.ttsWaveform)) return restoredMessage;
    return { ...restoredMessage, ttsWaveform: [...panelMessage.ttsWaveform] };
  });
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
  const reconciled = reconcileRestoredPanelConversation({
    restoredConversation: params.restoredConversation,
    panelConversation: params.panelConversation,
    ttsPlaybackMessageId: params.ttsPlaybackMessageId,
  });
  return {
    ...reconciled,
    isResponding: params.restoredHasRunningTurn,
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
