import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import type { ConversationMessage } from "../types/appTypes";
import { parseOptionalSessionId } from "../utils/llmSession";
import {
  cloneConversationMessages,
  normalizeRuntimePanelId,
  type PanelRuntimeSnapshotPatch,
} from "../utils/panelRuntimeSnapshot";
import {
  isConversationRuntimeRequestResponding,
  type ConversationRuntimeSnapshot,
} from "./useConversationRuntimeStoreController";
import type { PanelRuntimeEntry } from "./usePanelNewSessionController";

export type PanelConversationWriteOptions = {
  isResponding?: boolean;
  selectedThreadStatusType?: string;
  sessionId?: string;
  sessionMaterialized?: boolean;
  clearRespondingRequestStartedAtMs?: number | null;
  contextUsedPct?: number | null;
  adoptFromSessionId?: string;
};

type UsePanelConversationWriteControllerArgs = {
  resolvePanelSnapshotForDisplay: (panelId: string) => PanelRuntimeSnapshot;
  createPanelRuntimeSnapshot: (
    panelIdRaw: string,
    baseSnapshot: PanelRuntimeSnapshot,
    patch?: PanelRuntimeSnapshotPatch
  ) => PanelRuntimeSnapshot;
  getConversationRuntimeSnapshot: (sessionId: string) => ConversationRuntimeSnapshot | null;
  upsertConversationRuntimeSnapshot: (input: {
    sessionId: string;
    conversationMessages: ConversationMessage[];
    contextUsedPct: number | null;
    isResponding: boolean;
    selectedThreadStatusType: string;
    clearRespondingRequestStartedAtMs?: number | null;
  }) => unknown;
  setPanelRuntimeEntriesById: Dispatch<SetStateAction<Record<string, PanelRuntimeEntry>>>;
  getVisibleSessionId: () => string;
  setVisibleConversationMessages: (messages: ConversationMessage[]) => unknown;
  setVisibleReplyLoading: (loading: boolean) => void;
  setVisibleThreadStatusType: (statusType: string) => void;
  setVisibleContextUsedPct: (contextUsedPct: number | null) => void;
  logSessionDiag: (
    event: string,
    payload?: Record<string, unknown>,
    options?: { throttleMs?: number; throttleKey?: string; detailed?: boolean }
  ) => void;
};

// パネル向け会話メッセージ書込の単一経路。
// panelRuntimeEntriesById(パネル表示state)とconversation runtime snapshot(セッション別ref store)に加え、
// 書込対象セッションが現在表示中(アクティブ)のセッションと一致する場合はトップレベルの会話表示state
// (conversationMessages / replyLoading / selectedThreadStatusType / contextUsedPct)へも必ず伝播させる。
// この伝播が無いとアクティブ会話stateが古いまま残り、activeConversationSnapshot同期がruntime snapshotを
// 巻き戻して、/compact開始メッセージのようなローカル追記が表示から消える。
export function usePanelConversationWriteController({
  resolvePanelSnapshotForDisplay,
  createPanelRuntimeSnapshot,
  getConversationRuntimeSnapshot,
  upsertConversationRuntimeSnapshot,
  setPanelRuntimeEntriesById,
  getVisibleSessionId,
  setVisibleConversationMessages,
  setVisibleReplyLoading,
  setVisibleThreadStatusType,
  setVisibleContextUsedPct,
  logSessionDiag,
}: UsePanelConversationWriteControllerArgs) {
  const setPanelConversationMessagesForCodex = useCallback((
    panelIdRaw: string,
    messagesRaw: ConversationMessage[],
    options?: PanelConversationWriteOptions
  ) => {
    const panelId = normalizeRuntimePanelId(panelIdRaw);
    if (!panelId) return;
    const optionSessionId = parseOptionalSessionId(options?.sessionId);
    const baseSnapshot = resolvePanelSnapshotForDisplay(panelId);
    const hasContextUpdate = options?.contextUsedPct !== null &&
      typeof options?.contextUsedPct !== "undefined" &&
      Number.isFinite(Number(options?.contextUsedPct));
    const contextUsedPct = hasContextUpdate
      ? Math.max(0, Math.min(100, Math.round(Number(options?.contextUsedPct))))
      : baseSnapshot.contextUsedPct;
    const isResponding = typeof options?.isResponding === "boolean"
      ? options.isResponding
      : Boolean(baseSnapshot.isResponding);
    const selectedThreadStatusTypeForPanel = typeof options?.selectedThreadStatusType === "string"
      ? String(options?.selectedThreadStatusType || "unknown").trim() || "unknown"
      : String(baseSnapshot.selectedThreadStatusType || "unknown").trim() || "unknown";
    const selectedSessionId = String(optionSessionId || baseSnapshot.selectedSessionId || "").trim();
    const runtimeSnapshot = selectedSessionId ? getConversationRuntimeSnapshot(selectedSessionId) : null;
    const runtimeRequestStartedAtMs = runtimeSnapshot?.isResponding &&
      runtimeSnapshot.request &&
      isConversationRuntimeRequestResponding(runtimeSnapshot.request) &&
      runtimeSnapshot.request.startedAtMs > 0
      ? runtimeSnapshot.request.startedAtMs
      : undefined;
    const shouldSyncSameSession = !!selectedSessionId;
    const previousMessageCount = Array.isArray(baseSnapshot.conversationMessages)
      ? baseSnapshot.conversationMessages.length
      : 0;
    const nextMessageCount = Array.isArray(messagesRaw) ? messagesRaw.length : 0;
    const lastMessage = nextMessageCount > 0 ? messagesRaw[nextMessageCount - 1] : null;
    const selectedSessionUpdatedAt = String(lastMessage?.at || "").trim() || new Date().toISOString();
    const nextSnapshot = createPanelRuntimeSnapshot(panelId, baseSnapshot, {
      selectedSessionId,
      sessionMaterialized: options?.sessionMaterialized,
      selectedSessionUpdatedAt,
      contextUsedPct,
      isResponding,
      requestStartedAtMs: runtimeRequestStartedAtMs,
      selectedThreadStatusType: selectedThreadStatusTypeForPanel,
      conversationMessages: messagesRaw,
    });
    const currentPanelSessionId = parseOptionalSessionId(resolvePanelSnapshotForDisplay(panelId).selectedSessionId);
    const adoptFromSessionId = parseOptionalSessionId(options?.adoptFromSessionId);
    const shouldAdoptSourcePanelSession = Boolean(
      optionSessionId &&
      adoptFromSessionId &&
      currentPanelSessionId === adoptFromSessionId
    );
    const shouldUpdateSourcePanel = (
      !optionSessionId ||
      !currentPanelSessionId ||
      currentPanelSessionId === selectedSessionId ||
      shouldAdoptSourcePanelSession
    );
    if (nextSnapshot.selectedSessionId) {
      upsertConversationRuntimeSnapshot({
        sessionId: nextSnapshot.selectedSessionId,
        conversationMessages: nextSnapshot.conversationMessages,
        contextUsedPct: nextSnapshot.contextUsedPct,
        isResponding: nextSnapshot.isResponding,
        selectedThreadStatusType: nextSnapshot.selectedThreadStatusType,
        clearRespondingRequestStartedAtMs: options?.clearRespondingRequestStartedAtMs,
      });
    }
    const visibleSessionId = parseOptionalSessionId(getVisibleSessionId());
    const shouldSyncVisibleConversation = Boolean(
      nextSnapshot.selectedSessionId &&
      visibleSessionId &&
      visibleSessionId === nextSnapshot.selectedSessionId
    );
    if (shouldSyncVisibleConversation) {
      setVisibleConversationMessages(cloneConversationMessages(nextSnapshot.conversationMessages));
      setVisibleReplyLoading(nextSnapshot.isResponding);
      setVisibleThreadStatusType(nextSnapshot.selectedThreadStatusType);
      if (hasContextUpdate) {
        setVisibleContextUsedPct(nextSnapshot.contextUsedPct);
      }
    }
    const syncedPanelIds: string[] = [];
    setPanelRuntimeEntriesById((prev) => {
      const next: Record<string, PanelRuntimeEntry> = { ...prev };
      if (shouldUpdateSourcePanel) {
        next[panelId] = {
          sessionId: nextSnapshot.selectedSessionId,
          snapshot: nextSnapshot,
        };
      }
      if (shouldSyncSameSession) {
        for (const [entryPanelId, entry] of Object.entries(prev)) {
          if (entryPanelId === panelId) continue;
          const entrySessionId = String(entry.snapshot.selectedSessionId || entry.sessionId || "").trim();
          if (entrySessionId !== selectedSessionId) continue;
          next[entryPanelId] = {
            ...entry,
            sessionId: entry.sessionId || selectedSessionId,
            snapshot: createPanelRuntimeSnapshot(entryPanelId, entry.snapshot, {
              modelRef: entry.snapshot.modelRef || baseSnapshot.modelRef,
              reasoningEffort: entry.snapshot.reasoningEffort || baseSnapshot.reasoningEffort,
              sessionMaterialized: options?.sessionMaterialized,
              selectedSessionUpdatedAt,
              contextUsedPct,
              isResponding,
              requestStartedAtMs: runtimeRequestStartedAtMs,
              selectedThreadStatusType: selectedThreadStatusTypeForPanel,
              conversationMessages: messagesRaw,
            }),
          };
          syncedPanelIds.push(entryPanelId);
        }
      }
      return next;
    });
    logSessionDiag("panel_runtime_messages_updated", {
      panelId,
      sessionId: nextSnapshot.selectedSessionId || undefined,
      contextUsedPct: nextSnapshot.contextUsedPct,
      isResponding: nextSnapshot.isResponding,
      selectedThreadStatusType: nextSnapshot.selectedThreadStatusType,
      syncedSameSessionPanelIds: syncedPanelIds,
      sourcePanelUpdated: shouldUpdateSourcePanel,
      sourcePanelSessionAdopted: shouldAdoptSourcePanelSession,
      visibleConversationSynced: shouldSyncVisibleConversation,
      adoptFromSessionId: adoptFromSessionId || undefined,
      currentPanelSessionId: currentPanelSessionId || undefined,
      previousMessageCount,
      messageCount: nextSnapshot.conversationMessages.length,
      messageCountDelta: nextMessageCount - previousMessageCount,
      lastMessageId: String(lastMessage?.id || "").trim(),
      lastMessageRole: String(lastMessage?.role || "").trim(),
      lastMessageContentLength: String(lastMessage?.content || "").length,
      lastMessagePreview: String(lastMessage?.content || "").slice(0, 80),
      source: "codex_reply_request",
      updateKind: hasContextUpdate ? "final" : "stream",
    }, {
      throttleMs: hasContextUpdate ? 0 : 1000,
      throttleKey: hasContextUpdate
        ? `panel_runtime_messages_updated:${panelId}:${Date.now()}`
        : `panel_runtime_messages_updated:${panelId}:stream`,
    });
  }, [
    createPanelRuntimeSnapshot,
    getConversationRuntimeSnapshot,
    getVisibleSessionId,
    logSessionDiag,
    resolvePanelSnapshotForDisplay,
    setPanelRuntimeEntriesById,
    setVisibleContextUsedPct,
    setVisibleConversationMessages,
    setVisibleReplyLoading,
    setVisibleThreadStatusType,
    upsertConversationRuntimeSnapshot,
  ]);

  return {
    setPanelConversationMessagesForCodex,
  };
}
