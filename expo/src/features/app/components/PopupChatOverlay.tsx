import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { usePanelRuntimeController } from "../contexts/PanelRuntimeControllerContext";
import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import { ChatScreen } from "../screens/ChatScreen";
import { CHAT_CONTENT_MAX_WIDTH } from "../styles/layoutConstants";
import type { PopupChatPresentation, PopupChatSourceRect } from "./popupChatTypes";
import { useVisualTheme } from "../theme/VisualThemeContext";
import {
  createStylesByTheme,
  type VisualTheme,
  type VisualThemeSoundEvent,
} from "../theme/visualThemes";
import {
  startCyberpunkPopupTransition,
  startStandardPopupTransition,
} from "./popupChatTransitions";

type PopupChatOverlayProps = {
  visible: boolean;
  panelId: string;
  cycleId?: string;
  sourceRect?: PopupChatSourceRect | null;
  onClose: () => void;
  onRequestClose: () => void;
  playThemeSfx: (event: VisualThemeSoundEvent) => Promise<void>;
};

const POPUP_MARGIN_HORIZONTAL = 12;
const POPUP_MARGIN_TOP = 40;
const POPUP_MARGIN_BOTTOM = 28;
const POPUP_BORDER_RADIUS = 18;
const FULLSCREEN_PADDING_TOP = 32;
const FULLSCREEN_PADDING_BOTTOM = 16;
const HEADER_DISMISS_DISTANCE = 96;
const HEADER_DISMISS_VELOCITY = 0.85;
const ANIMATION_FAIL_OPEN_BUFFER_MS = 250;

export function PopupChatOverlay({
  visible,
  panelId,
  cycleId = "",
  sourceRect,
  onClose,
  onRequestClose,
  playThemeSfx,
}: PopupChatOverlayProps) {
  const { theme, themeId } = useVisualTheme();
  const popupChatOverlayStyles = popupChatOverlayStylesByTheme[themeId];
  const reduceMotion = useReduceMotionEnabled();
  const { setPanelAutoSpeechOpen } = usePanelRuntimeController();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const rootRef = useRef<View | null>(null);
  const presentationRef = useRef<PopupChatPresentation>("popup");
  const closingRef = useRef(false);
  const transitionGenerationRef = useRef(0);
  const completedCloseEventRef = useRef("");
  const playedSoundEventRef = useRef({ popupOpen: "", popupClose: "" });
  const pendingSoundEventRef = useRef({
    popupOpen: { base: "", id: "" },
    popupClose: { base: "", id: "" },
  });
  const soundEventSequenceRef = useRef(0);
  const mountedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const playThemeSfxRef = useRef(playThemeSfx);
  const popupTransitionRef = useRef<Animated.CompositeAnimation | null>(null);
  const presentationTransitionRef = useRef<Animated.CompositeAnimation | null>(null);
  const dragResetTransitionRef = useRef<Animated.CompositeAnimation | null>(null);
  onCloseRef.current = onClose;
  playThemeSfxRef.current = playThemeSfx;
  const [rendered, setRendered] = useState(false);
  const [contentReady, setContentReady] = useState(false);
  const [messageSkeletonVisible, setMessageSkeletonVisible] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: windowWidth, height: windowHeight });
  const [rootWindowOrigin, setRootWindowOrigin] = useState({ x: 0, y: 0 });

  const progress = useRef(new Animated.Value(1)).current;
  const dragTranslateY = useRef(new Animated.Value(0)).current;
  const cardOpacity = useRef(new Animated.Value(1)).current;
  const cardScaleY = useRef(new Animated.Value(1)).current;
  const transitionFlashOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  const popupRect = useMemo(() => {
    const availableWidth = Math.max(1, containerSize.width - POPUP_MARGIN_HORIZONTAL * 2);
    const width = Platform.OS === "macos"
      ? Math.min(CHAT_CONTENT_MAX_WIDTH, availableWidth)
      : availableWidth;
    return {
      x: (containerSize.width - width) / 2,
      y: POPUP_MARGIN_TOP,
      width,
      height: Math.max(1, containerSize.height - POPUP_MARGIN_TOP - POPUP_MARGIN_BOTTOM),
    };
  }, [containerSize.height, containerSize.width]);

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

  const playPopupSoundOnce = useCallback((event: "popupOpen" | "popupClose", eventKey: string) => {
    if (playedSoundEventRef.current[event] === eventKey) return;
    playedSoundEventRef.current[event] = eventKey;
    void playThemeSfxRef.current(event);
  }, []);

  const getSoundEventId = useCallback((event: "popupOpen" | "popupClose", base: string) => {
    const pending = pendingSoundEventRef.current[event];
    if (pending.base === base) return pending.id;
    const id = `${base}:${event}:${++soundEventSequenceRef.current}`;
    pendingSoundEventRef.current[event] = { base, id };
    return id;
  }, []);

  const completeOpen = useCallback((generation: number, soundEventId: string) => {
    if (transitionGenerationRef.current !== generation || closingRef.current) return;
    playPopupSoundOnce("popupOpen", soundEventId);
    setContentReady(true);
  }, [playPopupSoundOnce]);

  const completeClose = useCallback((generation: number, eventKey: string, soundEventId: string) => {
    if (transitionGenerationRef.current !== generation || !closingRef.current) return;
    playPopupSoundOnce("popupClose", soundEventId);
    transitionGenerationRef.current += 1;
    completedCloseEventRef.current = eventKey;
    onCloseRef.current();
  }, [playPopupSoundOnce]);

  useEffect(() => {
    if (!visible || !panelId) return;
    setPanelAutoSpeechOpen(panelId, true);
    return () => {
      setPanelAutoSpeechOpen(panelId, false);
    };
  }, [panelId, setPanelAutoSpeechOpen, visible]);

  useEffect(() => {
    if (panelId) return;
    closingRef.current = false;
    completedCloseEventRef.current = "";
    pendingSoundEventRef.current = {
      popupOpen: { base: "", id: "" },
      popupClose: { base: "", id: "" },
    };
    setRendered(false);
    setContentReady(false);
    setMessageSkeletonVisible(false);
  }, [panelId]);

  useEffect(() => {
    if (!visible || !panelId || reduceMotion === null) return;

    const eventId = `${panelId}:${cycleId}`;
    closingRef.current = false;
    completedCloseEventRef.current = "";
    pendingSoundEventRef.current.popupClose = { base: "", id: "" };
    const soundEventId = getSoundEventId("popupOpen", eventId);
    const generation = ++transitionGenerationRef.current;

    setRendered(true);
    setContentReady(false);
    setMessageSkeletonVisible(false);
    presentationRef.current = "popup";
    syncRootWindowOrigin();
    popupTransitionRef.current?.stop();
    presentationTransitionRef.current?.stop();
    dragResetTransitionRef.current?.stop();
    progress.setValue(theme.motion.popupTransition === "flash-blink" ? 1 : 0);
    dragTranslateY.setValue(0);
    cardOpacity.setValue(0);
    cardScaleY.setValue(1);
    transitionFlashOpacity.setValue(0);
    const motion = theme.motion.popupOpen;
    setTimeout(() => {
      if (mountedRef.current) playPopupSoundOnce("popupOpen", soundEventId);
    }, 0);
    const startTransition = theme.motion.popupTransition === "flash-blink"
      ? startCyberpunkPopupTransition
      : startStandardPopupTransition;
    popupTransitionRef.current = startTransition({
      direction: "open",
      durationMs: motion.durationMs,
      reduceMotion,
      progress,
      cardOpacity,
      cardScaleY,
      flashOpacity: transitionFlashOpacity,
      onFinish: (finished) => {
        if (finished) completeOpen(generation, soundEventId);
      },
    });

    return () => {
      if (transitionGenerationRef.current === generation) {
        transitionGenerationRef.current += 1;
      }
      popupTransitionRef.current?.stop();
      presentationTransitionRef.current?.stop();
      dragResetTransitionRef.current?.stop();
    };
  }, [
    cycleId,
    completeOpen,
    getSoundEventId,
    panelId,
    playPopupSoundOnce,
    reduceMotion,
    syncRootWindowOrigin,
    visible,
  ]);

  const togglePresentation = () => {
    const nextPresentation = presentationRef.current === "popup" ? "fullscreen" : "popup";
    presentationRef.current = nextPresentation;
    setMessageSkeletonVisible(true);
    requestAnimationFrame(() => {
      presentationTransitionRef.current?.stop();
      const animation = Animated.timing(progress, {
        toValue: nextPresentation === "fullscreen" ? 2 : 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      });
      presentationTransitionRef.current = animation;
      animation.start(({ finished }) => {
        if (finished) setMessageSkeletonVisible(false);
      });
    });
  };

  useEffect(() => {
    if (visible || !panelId || reduceMotion === null) return;
    const eventId = `${panelId}:${cycleId}`;
    pendingSoundEventRef.current.popupOpen = { base: "", id: "" };
    const soundEventId = getSoundEventId("popupClose", eventId);
    if (completedCloseEventRef.current === eventId) return;
    if (!rendered) {
      completedCloseEventRef.current = eventId;
      onCloseRef.current();
      return;
    }

    closingRef.current = true;
    const generation = ++transitionGenerationRef.current;
    setContentReady(false);
    setMessageSkeletonVisible(false);
    popupTransitionRef.current?.stop();
    presentationTransitionRef.current?.stop();
    dragResetTransitionRef.current?.stop();
    cardOpacity.setValue(1);
    cardScaleY.setValue(1);
    transitionFlashOpacity.setValue(0);
    const motion = theme.motion.popupClose;
    setTimeout(() => {
      if (mountedRef.current) playPopupSoundOnce("popupClose", soundEventId);
    }, 0);
    const durationMs = reduceMotion ? 0 : motion.durationMs;
    const closeTimer = setTimeout(
      () => completeClose(generation, eventId, soundEventId),
      durationMs + ANIMATION_FAIL_OPEN_BUFFER_MS
    );
    const startTransition = theme.motion.popupTransition === "flash-blink"
      ? startCyberpunkPopupTransition
      : startStandardPopupTransition;
    popupTransitionRef.current = startTransition({
      direction: "close",
      durationMs,
      reduceMotion,
      progress,
      cardOpacity,
      cardScaleY,
      flashOpacity: transitionFlashOpacity,
      onFinish: (finished) => {
        if (finished) completeClose(generation, eventId, soundEventId);
      },
    });

    return () => {
      if (transitionGenerationRef.current === generation) {
        transitionGenerationRef.current += 1;
      }
      closingRef.current = false;
      clearTimeout(closeTimer);
      popupTransitionRef.current?.stop();
    };
  }, [
    completeClose,
    cycleId,
    getSoundEventId,
    panelId,
    playPopupSoundOnce,
    reduceMotion,
    rendered,
    visible,
  ]);

  const handleHeaderDragMove = (offsetY: number) => {
    dragResetTransitionRef.current?.stop();
    dragTranslateY.setValue(Math.max(0, offsetY));
  };

  const handleHeaderDragEnd = (offsetY: number, velocityY: number) => {
    if (offsetY >= HEADER_DISMISS_DISTANCE || velocityY >= HEADER_DISMISS_VELOCITY) {
      onRequestClose();
      return;
    }
    const animation = Animated.timing(dragTranslateY, {
      toValue: 0,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    dragResetTransitionRef.current = animation;
    animation.start();
  };

  const animatedCardStyle = useMemo(() => ({
    left: progress.interpolate({ inputRange: [0, 1, 2], outputRange: [initialRect.x, popupRect.x, fullscreenRect.x] }),
    top: progress.interpolate({ inputRange: [0, 1, 2], outputRange: [initialRect.y, popupRect.y, fullscreenRect.y] }),
    width: progress.interpolate({ inputRange: [0, 1, 2], outputRange: [initialRect.width, popupRect.width, fullscreenRect.width] }),
    height: progress.interpolate({ inputRange: [0, 1, 2], outputRange: [initialRect.height, popupRect.height, fullscreenRect.height] }),
    borderRadius: progress.interpolate({ inputRange: [0, 1, 2], outputRange: [10, POPUP_BORDER_RADIUS, 0] }),
    opacity: cardOpacity,
    transform: [
      { translateY: dragTranslateY },
      { scaleY: cardScaleY },
    ],
  }), [cardOpacity, cardScaleY, dragTranslateY, fullscreenRect, initialRect, popupRect]);

  const backdropAnimatedStyle = useMemo(() => ({
    opacity: progress.interpolate({ inputRange: [0, 1, 2], outputRange: [0, 1, 1] }),
  }), [progress]);
  const animatedContentStyle = useMemo(() => ({
    paddingTop: progress.interpolate({ inputRange: [0, 1, 2], outputRange: [0, 0, FULLSCREEN_PADDING_TOP] }),
    paddingBottom: progress.interpolate({ inputRange: [0, 1, 2], outputRange: [0, 0, FULLSCREEN_PADDING_BOTTOM] }),
  }), [progress]);
  const transitionFlashStyle = useMemo(() => ({
    opacity: transitionFlashOpacity,
  }), [transitionFlashOpacity]);

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
      <Pressable
        style={popupChatOverlayStyles.backdropTouch}
        testID="popup-chat-backdrop"
        onPress={() => onRequestClose()}
      />
      <Animated.View style={[popupChatOverlayStyles.card, animatedCardStyle]}>
        <Animated.View style={[popupChatOverlayStyles.content, animatedContentStyle]}>
          {contentReady ? (
            <ChatScreen
              mode="mini_board_popup"
              panelId={panelId}
              miniBoardCycleId={cycleId}
              onTogglePopupPresentation={togglePresentation}
              onMinimizePopupChat={onRequestClose}
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
        <Animated.View
          pointerEvents="none"
          style={[popupChatOverlayStyles.transitionFlash, transitionFlashStyle]}
        />
      </Animated.View>
    </View>
  );
}

function createPopupChatOverlayStyles(theme: VisualTheme) {
  return StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    flex: 1,
    zIndex: 100,
    elevation: 100,
  },
  backdropVisual: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.backdrop,
  },
  backdropTouch: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    position: "absolute",
    overflow: "hidden",
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.primaryActionOutlineSoft,
    backgroundColor: theme.colors.surfaceRaised,
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  transitionFlash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.accent,
  },
  skeleton: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 12,
    backgroundColor: theme.colors.surfaceRaised,
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
    backgroundColor: theme.colors.surfaceSubtle,
  },
  skeletonTitle: {
    width: "42%",
    height: 14,
    borderRadius: 7,
    backgroundColor: theme.colors.surfaceSubtle,
  },
  skeletonLineWide: {
    width: "86%",
    height: 12,
    borderRadius: 6,
    backgroundColor: theme.colors.skeleton,
  },
  skeletonLine: {
    width: "68%",
    height: 12,
    borderRadius: 6,
    backgroundColor: theme.colors.skeleton,
  },
  skeletonLineShort: {
    width: "52%",
    height: 12,
    borderRadius: 6,
    backgroundColor: theme.colors.skeleton,
  },
  });
}

const popupChatOverlayStylesByTheme = createStylesByTheme(createPopupChatOverlayStyles);
