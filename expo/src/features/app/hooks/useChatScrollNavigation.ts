import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { LegendListRef, OnViewableItemsChanged } from "@legendapp/list";
import type { ConversationMessage } from "../types/appTypes";
import { findPreviousUserMessageIndex } from "../utils/chatScroll";
import type { SessionDeepLinkJumpTarget } from "../utils/sessionDeepLink";

type ChatScrollNavigationParams = {
  messages: readonly ConversationMessage[];
  listRef: RefObject<LegendListRef | null>;
  isAtBottomRef: RefObject<boolean>;
  interactionActiveRef: RefObject<boolean>;
  pauseAutoScroll: () => void;
  resumeAutoScroll: () => void;
  scrollToBottom: (animated?: boolean) => void;
  onTouchStart?: () => void;
  onTouchEnd?: () => void;
  deepLinkTarget?: SessionDeepLinkJumpTarget | null;
  sessionId?: string;
  onDeepLinkHandled?: (requestId: number) => void;
};
type PendingPreviousUserTarget = {
  id: string;
  index: number;
  leftBottom: boolean;
  visible: boolean;
};

export function useChatScrollNavigation({
  messages,
  listRef,
  isAtBottomRef,
  interactionActiveRef,
  pauseAutoScroll,
  resumeAutoScroll,
  scrollToBottom,
  onTouchStart,
  onTouchEnd,
  deepLinkTarget,
  sessionId = "",
  onDeepLinkHandled,
}: ChatScrollNavigationParams) {
  const firstVisibleMessageRef = useRef<{ id: string; index: number } | null>(null);
  const pendingPreviousUserTargetRef = useRef<PendingPreviousUserTarget | null>(null);

  useEffect(() => {
    if (!deepLinkTarget || deepLinkTarget.sessionId !== sessionId) return;
    const index = messages.findIndex((message) => message.id === deepLinkTarget.messageId);
    const item = messages[index];
    if (!item || !listRef.current) return;
    const frame = requestAnimationFrame(() => {
      try {
        pauseAutoScroll();
        listRef.current?.scrollItemIntoView({ item, animated: true });
        onDeepLinkHandled?.(deepLinkTarget.requestId);
      } catch {
        // Keep the target pending so the next list render can retry it.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [deepLinkTarget, listRef, messages, onDeepLinkHandled, pauseAutoScroll, sessionId]);

  const handleViewableItemsChanged = useCallback<NonNullable<OnViewableItemsChanged<ConversationMessage>>>(({
    viewableItems,
  }) => {
    const pendingTarget = pendingPreviousUserTargetRef.current;
    if (pendingTarget) {
      const targetIsVisible = viewableItems.some((item) => (
        item.isViewable && item.item.id === pendingTarget.id
      ));
      if (!targetIsVisible) return;
      firstVisibleMessageRef.current = { id: pendingTarget.id, index: pendingTarget.index };
      pendingTarget.visible = true;
      if (pendingTarget.leftBottom) pendingPreviousUserTargetRef.current = null;
      return;
    }
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
      const target = firstMessage ? { id: firstMessage.id, index: 0 } : null;
      firstVisibleMessageRef.current = target;
      pendingPreviousUserTargetRef.current = target ? { ...target, leftBottom: false, visible: false } : null;
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
      return;
    }
    const target = { id: messages[targetIndex].id, index: targetIndex };
    firstVisibleMessageRef.current = target;
    pendingPreviousUserTargetRef.current = { ...target, leftBottom: false, visible: false };
    listRef.current?.scrollToIndex({ index: targetIndex, animated: true, viewPosition: 0 });
  }, [listRef, messages, pauseAutoScroll]);

  const scrollToBottomAndResume = useCallback(() => {
    pendingPreviousUserTargetRef.current = null;
    resumeAutoScroll();
    scrollToBottom(true);
  }, [resumeAutoScroll, scrollToBottom]);

  const shouldKeepAutoScrollPaused = useCallback((isAtBottom: boolean) => {
    const pendingTarget = pendingPreviousUserTargetRef.current;
    if (!pendingTarget) return false;
    if (!isAtBottom) {
      pendingTarget.leftBottom = true;
      if (pendingTarget.visible) pendingPreviousUserTargetRef.current = null;
      return false;
    }
    return true;
  }, []);

  const resumeIfSettledAtBottom = useCallback(() => {
    if (isAtBottomRef.current && !shouldKeepAutoScrollPaused(true)) resumeAutoScroll();
  }, [isAtBottomRef, resumeAutoScroll, shouldKeepAutoScrollPaused]);

  const handleTouchStart = useCallback(() => {
    pauseAutoScroll();
    onTouchStart?.();
  }, [onTouchStart, pauseAutoScroll]);

  const handleTouchEnd = useCallback(() => {
    onTouchEnd?.();
    if (!interactionActiveRef.current) resumeIfSettledAtBottom();
  }, [interactionActiveRef, onTouchEnd, resumeIfSettledAtBottom]);

  const handleTouchCancel = useCallback(() => {
    interactionActiveRef.current = false;
    onTouchEnd?.();
    resumeIfSettledAtBottom();
  }, [interactionActiveRef, onTouchEnd, resumeIfSettledAtBottom]);

  const handleScrollInteractionBegin = useCallback(() => {
    interactionActiveRef.current = true;
    pauseAutoScroll();
  }, [interactionActiveRef, pauseAutoScroll]);

  const handleScrollInteractionEnd = useCallback(() => {
    interactionActiveRef.current = false;
    resumeIfSettledAtBottom();
  }, [interactionActiveRef, resumeIfSettledAtBottom]);

  const resetNavigation = useCallback(() => {
    firstVisibleMessageRef.current = null;
    pendingPreviousUserTargetRef.current = null;
  }, []);

  return {
    handleScrollInteractionBegin,
    handleScrollInteractionEnd,
    handleTouchCancel,
    handleTouchEnd,
    handleTouchStart,
    handleViewableItemsChanged,
    resetNavigation,
    scrollToBottomAndResume,
    scrollToPreviousUser,
    shouldKeepAutoScrollPaused,
  };
}
