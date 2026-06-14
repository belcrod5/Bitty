import type { ConversationMessage, HistoryEntry } from "../types/appTypes";

type ScheduleSessionRestoreUiSettleArgs = {
  isLatestRestoreRequest: () => boolean;
  sessionSwitchToastText: string;
  chatSessionSwitchToastDelayMs: number;
  showChatBottomToast: (role: "user" | "assistant", rawText: string) => void;
};

type ApplySessionRestoreChatOpenStateArgs = {
  chatNearBottomRef: { current: boolean };
};

type SetConversationMessagesOptionsLike = {
  resetVisibleCount?: boolean;
  totalCountOverride?: number;
};

type ApplySessionRestoreConversationStateArgs = {
  nextConversation: ConversationMessage[];
  nextHistory: HistoryEntry[];
  restoredMessageCount: number;
  effectiveContextUsedPct: number | null;
  setConversationMessagesWithLimit: (
    next: ConversationMessage[],
    options?: SetConversationMessagesOptionsLike
  ) => void;
  setHistory: (next: HistoryEntry[]) => void;
  setAcpContextUsedPct: (next: number | null) => void;
  chatNearBottomRef: { current: boolean };
};

export function applySessionRestoreChatOpenState({
  chatNearBottomRef,
}: ApplySessionRestoreChatOpenStateArgs) {
  chatNearBottomRef.current = true;
}

export function applySessionRestoreConversationState({
  nextConversation,
  nextHistory,
  restoredMessageCount,
  effectiveContextUsedPct,
  setConversationMessagesWithLimit,
  setHistory,
  setAcpContextUsedPct,
  chatNearBottomRef,
}: ApplySessionRestoreConversationStateArgs) {
  applySessionRestoreChatOpenState({
    chatNearBottomRef,
  });
  setConversationMessagesWithLimit(nextConversation, {
    resetVisibleCount: true,
    totalCountOverride: restoredMessageCount,
  });
  setHistory(nextHistory);
  setAcpContextUsedPct(effectiveContextUsedPct);
}

export function scheduleSessionRestoreUiSettle({
  isLatestRestoreRequest,
  sessionSwitchToastText,
  chatSessionSwitchToastDelayMs,
  showChatBottomToast,
}: ScheduleSessionRestoreUiSettleArgs) {
  const shouldShowSessionSwitchToast = !!sessionSwitchToastText;
  const sessionSwitchToastTextSnapshot = sessionSwitchToastText;
  setTimeout(() => {
    if (!isLatestRestoreRequest()) return;
    if (!shouldShowSessionSwitchToast) return;
    setTimeout(() => {
      if (!isLatestRestoreRequest()) return;
      requestAnimationFrame(() => {
        if (!isLatestRestoreRequest()) return;
        showChatBottomToast("assistant", sessionSwitchToastTextSnapshot);
      });
    }, chatSessionSwitchToastDelayMs);
  }, 0);
}
