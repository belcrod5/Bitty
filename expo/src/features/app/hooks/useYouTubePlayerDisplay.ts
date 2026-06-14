import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { Animated, PanResponder } from "react-native";
import type { View } from "react-native";
import { clampYouTubeFloatingPlayerPosition, normalizeYouTubeVideoIds, resolveDefaultYouTubeFloatingPlayerPosition } from "../utils/youtube";

type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  youtubeVideoIds?: string[];
};

type UseYouTubePlayerDisplayOptions = {
  activeScreen: string;
  conversationMessages: ConversationMessage[];
  replyLoading: boolean;
  streamReplyYouTubeVideoIds: string[];
  youtubeEmbedHtml: string;
  youtubePlayerVideoId: string;
  youtubePlayerMessageId: string;
  chatScrollOffsetY: number;
  chatViewportHeight: number;
  chatScreenLayout: { width: number; height: number };
  youtubeInlineLayout: { x: number; y: number; width: number; height: number } | null;
  youtubeFloatingPosition: { x: number; y: number } | null;
  setYoutubeInlineLayout: Dispatch<SetStateAction<{ x: number; y: number; width: number; height: number } | null>>;
  setYoutubeFloatingPosition: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  clearYouTubeControlToDragTimer: () => void;
  scheduleYouTubeControlToDrag: () => void;
  setYouTubeFloatingInteractionModeWithRef: (next: "drag" | "control") => void;
  youtubeFloatingInteractionMode: "drag" | "control";
  youtubeFloatingInteractionModeRef: MutableRefObject<"drag" | "control">;
  chatContentRef: MutableRefObject<View | null>;
  dragActivatePx: number;
  floatingPlayerMargin: number;
};

export function useYouTubePlayerDisplay(options: UseYouTubePlayerDisplayOptions) {
  const {
    activeScreen,
    conversationMessages,
    replyLoading,
    streamReplyYouTubeVideoIds,
    youtubeEmbedHtml,
    youtubePlayerVideoId,
    youtubePlayerMessageId,
    chatScrollOffsetY,
    chatViewportHeight,
    chatScreenLayout,
    youtubeInlineLayout,
    youtubeFloatingPosition,
    setYoutubeInlineLayout,
    setYoutubeFloatingPosition,
    clearYouTubeControlToDragTimer,
    scheduleYouTubeControlToDrag,
    setYouTubeFloatingInteractionModeWithRef,
    youtubeFloatingInteractionMode,
    youtubeFloatingInteractionModeRef,
    chatContentRef,
    dragActivatePx,
    floatingPlayerMargin,
  } = options;

  const youtubeInlineAnchorRef = useRef<View | null>(null);
  const youtubeFloatingPositionRef = useRef<{ x: number; y: number } | null>(null);
  const youtubeFloatingAnimatedPositionRef = useRef(new Animated.ValueXY({
    x: floatingPlayerMargin,
    y: floatingPlayerMargin,
  }));
  const youtubeFloatingDragStartRef = useRef<{ x: number; y: number }>({
    x: floatingPlayerMargin,
    y: floatingPlayerMargin,
  });
  const youtubeFloatingDragMovedRef = useRef(false);

  const conversationInlineAnchorMessageId = useMemo(() => {
    if (!youtubePlayerVideoId) return "";
    let latestCandidateId = "";
    let strictMatched = false;
    for (let i = conversationMessages.length - 1; i >= 0; i -= 1) {
      const item = conversationMessages[i];
      if (item.role !== "assistant") continue;
      const ids = normalizeYouTubeVideoIds(item.youtubeVideoIds);
      if (!ids.includes(youtubePlayerVideoId)) continue;
      if (!latestCandidateId) {
        latestCandidateId = item.id;
      }
      if (item.id === youtubePlayerMessageId) {
        strictMatched = true;
        break;
      }
    }
    if (strictMatched) return youtubePlayerMessageId;
    return latestCandidateId;
  }, [conversationMessages, youtubePlayerMessageId, youtubePlayerVideoId]);

  const hasConversationInlineYouTubeTarget = !!conversationInlineAnchorMessageId;
  const hasStreamInlineYouTubeTarget = useMemo(
    () => (
      replyLoading &&
      youtubePlayerMessageId === "__stream__" &&
      streamReplyYouTubeVideoIds.includes(youtubePlayerVideoId)
    ),
    [replyLoading, streamReplyYouTubeVideoIds, youtubePlayerMessageId, youtubePlayerVideoId]
  );
  const hasInlineYouTubeTarget = hasConversationInlineYouTubeTarget || hasStreamInlineYouTubeTarget;

  const showFloatingYouTubePlayer = useMemo(() => {
    if (activeScreen !== "mini_board") return false;
    if (!youtubeEmbedHtml) return false;
    if (!youtubePlayerVideoId) return false;
    if (!hasInlineYouTubeTarget) return false;
    if (!youtubeInlineLayout) return false;
    if (chatViewportHeight <= 0) return false;
    const viewportTop = chatScrollOffsetY;
    const viewportBottom = chatScrollOffsetY + chatViewportHeight;
    const playerTop = youtubeInlineLayout.y;
    const playerBottom = youtubeInlineLayout.y + youtubeInlineLayout.height;
    const outsideBuffer = 24;
    return playerBottom <= viewportTop - outsideBuffer || playerTop >= viewportBottom + outsideBuffer;
  }, [
    activeScreen,
    chatScrollOffsetY,
    chatViewportHeight,
    hasInlineYouTubeTarget,
    youtubeInlineLayout,
    youtubeEmbedHtml,
    youtubePlayerVideoId,
  ]);

  const showYouTubeOverlayPlayer = useMemo(
    () => (
      activeScreen === "mini_board" &&
      !!youtubeEmbedHtml &&
      !!youtubePlayerVideoId &&
      (showFloatingYouTubePlayer || !hasInlineYouTubeTarget)
    ),
    [
      activeScreen,
      hasInlineYouTubeTarget,
      showFloatingYouTubePlayer,
      youtubeEmbedHtml,
      youtubePlayerVideoId,
    ]
  );

  const resolvedYouTubeFloatingPosition = useMemo(() => {
    const base = youtubeFloatingPosition || resolveDefaultYouTubeFloatingPlayerPosition(chatScreenLayout);
    return clampYouTubeFloatingPlayerPosition(base, chatScreenLayout);
  }, [chatScreenLayout, youtubeFloatingPosition]);

  const setYouTubeFloatingPositionClamped = useCallback((
    nextPosition: { x: number; y: number },
    options?: { commitState?: boolean }
  ) => {
    const clamped = clampYouTubeFloatingPlayerPosition(nextPosition, chatScreenLayout);
    youtubeFloatingPositionRef.current = clamped;
    youtubeFloatingAnimatedPositionRef.current.setValue(clamped);
    if (options?.commitState === false) return;
    setYoutubeFloatingPosition((prev) => {
      if (prev && Math.abs(prev.x - clamped.x) < 0.5 && Math.abs(prev.y - clamped.y) < 0.5) {
        return prev;
      }
      return clamped;
    });
  }, [chatScreenLayout, setYoutubeFloatingPosition]);

  const markYouTubeFloatingControlInteraction = useCallback(() => {
    if (youtubeFloatingInteractionModeRef.current !== "control") return;
    scheduleYouTubeControlToDrag();
  }, [scheduleYouTubeControlToDrag, youtubeFloatingInteractionModeRef]);

  const youtubeFloatingPanResponder = useMemo(
    () => PanResponder.create({
      onStartShouldSetPanResponder: () => youtubeFloatingInteractionModeRef.current === "drag",
      onStartShouldSetPanResponderCapture: () => youtubeFloatingInteractionModeRef.current === "drag",
      onMoveShouldSetPanResponder: () => youtubeFloatingInteractionModeRef.current === "drag",
      onMoveShouldSetPanResponderCapture: () => youtubeFloatingInteractionModeRef.current === "drag",
      onPanResponderGrant: () => {
        clearYouTubeControlToDragTimer();
        setYouTubeFloatingInteractionModeWithRef("drag");
        youtubeFloatingDragMovedRef.current = false;
        const start = youtubeFloatingPositionRef.current || resolvedYouTubeFloatingPosition;
        youtubeFloatingDragStartRef.current = start;
        setYouTubeFloatingPositionClamped(start, { commitState: false });
      },
      onPanResponderMove: (_evt, gestureState) => {
        const dx = Number(gestureState?.dx || 0);
        const dy = Number(gestureState?.dy || 0);
        const dragging = (
          Math.abs(dx) > dragActivatePx ||
          Math.abs(dy) > dragActivatePx
        );
        if (!dragging) return;
        youtubeFloatingDragMovedRef.current = true;
        const start = youtubeFloatingDragStartRef.current;
        setYouTubeFloatingPositionClamped({
          x: start.x + dx,
          y: start.y + dy,
        }, { commitState: false });
      },
      onPanResponderRelease: (_evt, gestureState) => {
        const dx = Number(gestureState?.dx || 0);
        const dy = Number(gestureState?.dy || 0);
        const start = youtubeFloatingDragStartRef.current;
        if (youtubeFloatingDragMovedRef.current) {
          setYouTubeFloatingPositionClamped({
            x: start.x + dx,
            y: start.y + dy,
          });
          youtubeFloatingDragMovedRef.current = false;
          return;
        }
        setYouTubeFloatingInteractionModeWithRef("control");
        scheduleYouTubeControlToDrag();
      },
      onPanResponderTerminate: (_evt, gestureState) => {
        const dx = Number(gestureState?.dx || 0);
        const dy = Number(gestureState?.dy || 0);
        const start = youtubeFloatingDragStartRef.current;
        if (!youtubeFloatingDragMovedRef.current) return;
        setYouTubeFloatingPositionClamped({
          x: start.x + dx,
          y: start.y + dy,
        });
        youtubeFloatingDragMovedRef.current = false;
      },
      onPanResponderTerminationRequest: () => true,
    }),
    [
      clearYouTubeControlToDragTimer,
      dragActivatePx,
      resolvedYouTubeFloatingPosition,
      scheduleYouTubeControlToDrag,
      setYouTubeFloatingInteractionModeWithRef,
      setYouTubeFloatingPositionClamped,
      youtubeFloatingInteractionModeRef,
    ]
  );

  const updateYouTubeInlineLayoutFromAnchor = useCallback(() => {
    const anchor = youtubeInlineAnchorRef.current;
    const content = chatContentRef.current;
    if (
      !anchor ||
      !content ||
      typeof anchor.measureInWindow !== "function" ||
      typeof content.measureInWindow !== "function"
    ) {
      return;
    }
    content.measureInWindow((contentX, contentY) => {
      anchor.measureInWindow((anchorX, anchorY, width, height) => {
        if (
          !Number.isFinite(contentX) ||
          !Number.isFinite(contentY) ||
          !Number.isFinite(anchorX) ||
          !Number.isFinite(anchorY) ||
          !Number.isFinite(width) ||
          !Number.isFinite(height)
        ) {
          return;
        }
        if (width <= 0 || height <= 0) return;
        const x = anchorX - contentX;
        const yInViewport = anchorY - contentY;
        const y = yInViewport + chatScrollOffsetY;
        setYoutubeInlineLayout((prev) => {
          if (
            prev &&
            Math.abs(prev.x - x) < 1 &&
            Math.abs(prev.y - y) < 1 &&
            Math.abs(prev.width - width) < 1 &&
            Math.abs(prev.height - height) < 1
          ) {
            return prev;
          }
          return { x, y, width, height };
        });
      });
    });
  }, [chatContentRef, chatScrollOffsetY, setYoutubeInlineLayout]);

  const setYoutubeInlineAnchor = useCallback((node: View | null) => {
    youtubeInlineAnchorRef.current = node;
    if (!node) return;
    requestAnimationFrame(() => {
      updateYouTubeInlineLayoutFromAnchor();
    });
  }, [updateYouTubeInlineLayoutFromAnchor]);

  useEffect(() => {
    if (youtubePlayerVideoId && hasInlineYouTubeTarget) return;
    setYoutubeInlineLayout(null);
  }, [hasInlineYouTubeTarget, setYoutubeInlineLayout, youtubePlayerVideoId]);

  useEffect(() => {
    if (!youtubePlayerVideoId || !hasInlineYouTubeTarget) return;
    const frame = requestAnimationFrame(() => {
      updateYouTubeInlineLayoutFromAnchor();
    });
    return () => cancelAnimationFrame(frame);
  }, [
    conversationMessages.length,
    hasInlineYouTubeTarget,
    showFloatingYouTubePlayer,
    updateYouTubeInlineLayoutFromAnchor,
    youtubePlayerVideoId,
  ]);

  useEffect(() => {
    if (youtubeFloatingPosition) {
      youtubeFloatingPositionRef.current = youtubeFloatingPosition;
      youtubeFloatingAnimatedPositionRef.current.setValue(youtubeFloatingPosition);
      return;
    }
    youtubeFloatingPositionRef.current = null;
    youtubeFloatingAnimatedPositionRef.current.setValue(resolvedYouTubeFloatingPosition);
  }, [resolvedYouTubeFloatingPosition, youtubeFloatingPosition]);

  useEffect(() => {
    if (!youtubeFloatingPositionRef.current) return;
    const clamped = clampYouTubeFloatingPlayerPosition(youtubeFloatingPositionRef.current, chatScreenLayout);
    if (
      Math.abs(clamped.x - youtubeFloatingPositionRef.current.x) < 0.5 &&
      Math.abs(clamped.y - youtubeFloatingPositionRef.current.y) < 0.5
    ) {
      return;
    }
    setYouTubeFloatingPositionClamped(clamped);
  }, [chatScreenLayout, setYouTubeFloatingPositionClamped]);

  return {
    conversationInlineAnchorMessageId,
    showFloatingYouTubePlayer,
    showYouTubeOverlayPlayer,
    youtubeFloatingAnimatedPosition: youtubeFloatingAnimatedPositionRef.current,
    markYouTubeFloatingControlInteraction,
    youtubeFloatingPanResponder,
    setYoutubeInlineAnchor,
    updateYouTubeInlineLayoutFromAnchor,
    youtubeFloatingInteractionMode,
  };
}
