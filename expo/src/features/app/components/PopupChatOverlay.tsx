import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { usePanelRuntimeController } from "../contexts/PanelRuntimeControllerContext";
import { ChatScreen } from "../screens/ChatScreen";
import type { PopupChatPresentation, PopupChatSourceRect } from "./popupChatTypes";

type PopupChatOverlayProps = {
  visible: boolean;
  panelId: string;
  cycleId?: string;
  sourceRect?: PopupChatSourceRect | null;
  onClose: () => void;
};

const POPUP_MARGIN_HORIZONTAL = 12;
const POPUP_MARGIN_TOP = 40;
const POPUP_MARGIN_BOTTOM = 28;
const POPUP_BORDER_RADIUS = 18;
const FULLSCREEN_PADDING_TOP = 32;
const FULLSCREEN_PADDING_BOTTOM = 16;
const HEADER_DISMISS_DISTANCE = 96;
const HEADER_DISMISS_VELOCITY = 0.85;

export function PopupChatOverlay({
  visible,
  panelId,
  cycleId = "",
  sourceRect,
  onClose,
}: PopupChatOverlayProps) {
  const { setPanelAutoSpeechOpen } = usePanelRuntimeController();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const rootRef = useRef<View | null>(null);
  const presentationRef = useRef<PopupChatPresentation>("popup");
  const [rendered, setRendered] = useState(false);
  const [contentReady, setContentReady] = useState(false);
  const [messageSkeletonVisible, setMessageSkeletonVisible] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: windowWidth, height: windowHeight });
  const [rootWindowOrigin, setRootWindowOrigin] = useState({ x: 0, y: 0 });

  const progress = useSharedValue(1);
  const dragTranslateY = useSharedValue(0);

  const fallbackSourceRect = useMemo(() => ({
    x: Math.max(16, Math.floor(containerSize.width / 2) - 44),
    y: Math.max(16, Math.floor(containerSize.height / 2) - 32),
    width: 88,
    height: 64,
  }), [containerSize.height, containerSize.width]);

  const initialRect = useMemo(() => {
    if (!sourceRect) return fallbackSourceRect;

    const localX = Math.max(0, Number(sourceRect.x || 0) - rootWindowOrigin.x);
    const localY = Math.max(0, Number(sourceRect.y || 0) - rootWindowOrigin.y);
    const x = Math.min(localX, Math.max(0, containerSize.width - 1));
    const y = Math.min(localY, Math.max(0, containerSize.height - 1));

    return {
      x,
      y,
      width: Math.max(1, Math.min(Number(sourceRect.width || 1), Math.max(1, containerSize.width - x))),
      height: Math.max(1, Math.min(Number(sourceRect.height || 1), Math.max(1, containerSize.height - y))),
    };
  }, [
    containerSize.height,
    containerSize.width,
    fallbackSourceRect,
    rootWindowOrigin.x,
    rootWindowOrigin.y,
    sourceRect,
  ]);

  const popupRect = useMemo(() => ({
    x: POPUP_MARGIN_HORIZONTAL,
    y: POPUP_MARGIN_TOP,
    width: Math.max(1, containerSize.width - POPUP_MARGIN_HORIZONTAL * 2),
    height: Math.max(1, containerSize.height - POPUP_MARGIN_TOP - POPUP_MARGIN_BOTTOM),
  }), [containerSize.height, containerSize.width]);

  const fullscreenRect = useMemo(() => ({
    x: 0,
    y: 0,
    width: Math.max(1, containerSize.width),
    height: Math.max(1, containerSize.height),
  }), [containerSize.height, containerSize.width]);

  const syncRootWindowOrigin = useCallback(() => {
    rootRef.current?.measureInWindow((x, y, width, height) => {
      setRootWindowOrigin((prev) => {
        if (Math.abs(prev.x - x) < 1 && Math.abs(prev.y - y) < 1) return prev;
        return { x, y };
      });
      setContainerSize((prev) => {
        if (Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1) return prev;
        return { width, height };
      });
    });
  }, []);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerSize((prev) => {
      if (Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1) return prev;
      return { width, height };
    });
    syncRootWindowOrigin();
  }, [syncRootWindowOrigin]);

  const markContentReady = useCallback(() => {
    setContentReady(true);
  }, []);

  useEffect(() => {
    if (!visible || !panelId) return;
    setPanelAutoSpeechOpen(panelId, true);
    return () => {
      setPanelAutoSpeechOpen(panelId, false);
    };
  }, [panelId, setPanelAutoSpeechOpen, visible]);

  useEffect(() => {
    if (!visible || !panelId) {
      setRendered(false);
      setContentReady(false);
      setMessageSkeletonVisible(false);
      return;
    }

    setRendered(true);
    setContentReady(false);
    setMessageSkeletonVisible(false);
    presentationRef.current = "popup";
    syncRootWindowOrigin();
    progress.value = 0;
    dragTranslateY.value = 0;
    progress.value = withTiming(1, {
      duration: 260,
      easing: Easing.out(Easing.cubic),
    }, (finished) => {
      if (finished) runOnJS(markContentReady)();
    });
  }, [cycleId, markContentReady, panelId, progress, syncRootWindowOrigin, visible]);

  const togglePresentation = () => {
    const nextPresentation = presentationRef.current === "popup" ? "fullscreen" : "popup";
    presentationRef.current = nextPresentation;
    setMessageSkeletonVisible(true);
    requestAnimationFrame(() => {
      progress.value = withTiming(nextPresentation === "fullscreen" ? 2 : 1, {
        duration: 260,
        easing: Easing.out(Easing.cubic),
      }, (finished) => {
        if (finished) runOnJS(setMessageSkeletonVisible)(false);
      });
    });
  };

  const closeWithAnimation = () => {
    setContentReady(false);
    setMessageSkeletonVisible(false);
    progress.value = withTiming(0, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
    }, (finished) => {
      if (finished) runOnJS(onClose)();
    });
  };

  const handleHeaderDragMove = (offsetY: number) => {
    dragTranslateY.value = Math.max(0, offsetY);
  };

  const handleHeaderDragEnd = (offsetY: number, velocityY: number) => {
    if (offsetY >= HEADER_DISMISS_DISTANCE || velocityY >= HEADER_DISMISS_VELOCITY) {
      closeWithAnimation();
      return;
    }
    dragTranslateY.value = withTiming(0, {
      duration: 180,
      easing: Easing.out(Easing.cubic),
    });
  };

  const animatedCardStyle = useAnimatedStyle(() => ({
    left: interpolate(progress.value, [0, 1, 2], [initialRect.x, popupRect.x, fullscreenRect.x]),
    top: interpolate(progress.value, [0, 1, 2], [initialRect.y, popupRect.y, fullscreenRect.y]),
    width: interpolate(progress.value, [0, 1, 2], [initialRect.width, popupRect.width, fullscreenRect.width]),
    height: interpolate(progress.value, [0, 1, 2], [initialRect.height, popupRect.height, fullscreenRect.height]),
    borderRadius: interpolate(progress.value, [0, 1, 2], [10, POPUP_BORDER_RADIUS, 0]),
    transform: [{ translateY: dragTranslateY.value }],
  }), [dragTranslateY, fullscreenRect, initialRect, popupRect]);

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1, 2], [0, 1, 1]),
  }));
  const animatedContentStyle = useAnimatedStyle(() => ({
    paddingTop: interpolate(progress.value, [0, 1, 2], [0, 0, FULLSCREEN_PADDING_TOP]),
    paddingBottom: interpolate(progress.value, [0, 1, 2], [0, 0, FULLSCREEN_PADDING_BOTTOM]),
  }));

  if (!rendered || !panelId) return null;

  return (
    <View
      ref={rootRef}
      pointerEvents="auto"
      style={popupChatOverlayStyles.root}
      onLayout={handleLayout}
    >
      <Animated.View
        pointerEvents="none"
        style={[popupChatOverlayStyles.backdropVisual, backdropAnimatedStyle]}
      />
      <Pressable style={popupChatOverlayStyles.backdropTouch} onPress={closeWithAnimation} />
      <Animated.View style={[popupChatOverlayStyles.card, animatedCardStyle]}>
        <Animated.View style={[popupChatOverlayStyles.content, animatedContentStyle]}>
          {contentReady ? (
            <ChatScreen
              mode="mini_board_popup"
              panelId={panelId}
              miniBoardCycleId={cycleId}
              onTogglePopupPresentation={togglePresentation}
              onMinimizePopupChat={closeWithAnimation}
              onPopupHeaderDragMove={handleHeaderDragMove}
              onPopupHeaderDragEnd={handleHeaderDragEnd}
              showPopupMessagesSkeleton={messageSkeletonVisible}
            />
          ) : (
            <View style={popupChatOverlayStyles.skeleton}>
              <View style={popupChatOverlayStyles.skeletonHeader}>
                <View style={popupChatOverlayStyles.skeletonAvatar} />
                <View style={popupChatOverlayStyles.skeletonTitle} />
              </View>
              <View style={popupChatOverlayStyles.skeletonLineWide} />
              <View style={popupChatOverlayStyles.skeletonLine} />
              <View style={popupChatOverlayStyles.skeletonLineShort} />
            </View>
          )}
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const popupChatOverlayStyles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    flex: 1,
    zIndex: 100,
    elevation: 100,
  },
  backdropVisual: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(15, 23, 42, 0.28)",
  },
  backdropTouch: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    position: "absolute",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(15, 118, 110, 0.25)",
    backgroundColor: "#f8fafc",
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  skeleton: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 12,
    backgroundColor: "#f8fafc",
  },
  skeletonHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 4,
  },
  skeletonAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#e2e8f0",
  },
  skeletonTitle: {
    width: "42%",
    height: 14,
    borderRadius: 7,
    backgroundColor: "#e2e8f0",
  },
  skeletonLineWide: {
    width: "86%",
    height: 12,
    borderRadius: 6,
    backgroundColor: "#e5e7eb",
  },
  skeletonLine: {
    width: "68%",
    height: 12,
    borderRadius: 6,
    backgroundColor: "#e5e7eb",
  },
  skeletonLineShort: {
    width: "52%",
    height: 12,
    borderRadius: 6,
    backgroundColor: "#e5e7eb",
  },
});
