import { useCallback, useRef, type RefObject } from "react";
import type { LegendListRef, OnViewableItemsChanged } from "@legendapp/list";
import type { ConversationMessage } from "../types/appTypes";
import { findPreviousUserMessageIndex } from "../utils/chatScroll";

type ChatScrollNavigationParams = {
  messages: readonly ConversationMessage[];
  listRef: RefObject<LegendListRef | null>;
  pauseAutoScroll: () => void;
  resumeAutoScroll: () => void;
  scrollToBottom: (animated?: boolean) => void;
};

export function useChatScrollNavigation({
  messages,
  listRef,
  pauseAutoScroll,
  resumeAutoScroll,
  scrollToBottom,
}: ChatScrollNavigationParams) {
  const firstVisibleMessageRef = useRef<{ id: string; index: number } | null>(null);
  const previousUserNavigationPendingRef = useRef(false);

  const handleViewableItemsChanged = useCallback<NonNullable<OnViewableItemsChanged<ConversationMessage>>>(({
    viewableItems,
  }) => {
    if (previousUserNavigationPendingRef.current) return;
    const firstVisibleItem = viewableItems.reduce<(typeof viewableItems)[number] | null>((firstItem, item) => {
      if (!item.isViewable || item.index < 0) return firstItem;
      return firstItem === null || item.index < firstItem.index ? item : firstItem;
    }, null);
    if (!firstVisibleItem) return;
    firstVisibleMessageRef.current = {
      id: firstVisibleItem.item.id,
      index: firstVisibleItem.index,
    };
  }, []);

  const scrollToPreviousUser = useCallback(() => {
    if (messages.length === 0) return;
    previousUserNavigationPendingRef.current = true;
    pauseAutoScroll();
    const firstVisibleMessage = firstVisibleMessageRef.current;
    const currentIndexForVisibleMessage = firstVisibleMessage
      ? messages.findIndex((message) => message.id === firstVisibleMessage.id)
      : -1;
    const firstVisibleIndex = currentIndexForVisibleMessage >= 0
      ? currentIndexForVisibleMessage
      : (firstVisibleMessage?.index ?? messages.length);
    const targetIndex = findPreviousUserMessageIndex(messages, firstVisibleIndex);
    if (targetIndex === null) {
      const firstMessage = messages[0];
      firstVisibleMessageRef.current = firstMessage ? { id: firstMessage.id, index: 0 } : null;
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
      return;
    }
    firstVisibleMessageRef.current = { id: messages[targetIndex].id, index: targetIndex };
    listRef.current?.scrollToIndex({ index: targetIndex, animated: true, viewPosition: 0 });
  }, [listRef, messages, pauseAutoScroll]);

  const scrollToBottomAndResume = useCallback(() => {
    previousUserNavigationPendingRef.current = false;
    resumeAutoScroll();
    scrollToBottom(true);
  }, [resumeAutoScroll, scrollToBottom]);

  const shouldKeepAutoScrollPaused = useCallback((isAtBottom: boolean) => {
    if (!previousUserNavigationPendingRef.current) return false;
    if (!isAtBottom) previousUserNavigationPendingRef.current = false;
    return isAtBottom;
  }, []);

  const resetNavigation = useCallback(() => {
    firstVisibleMessageRef.current = null;
    previousUserNavigationPendingRef.current = false;
  }, []);

  return {
    handleViewableItemsChanged,
    resetNavigation,
    scrollToBottomAndResume,
    scrollToPreviousUser,
    shouldKeepAutoScrollPaused,
  };
}
