import { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";

import type { VisualThemeSoundEvent } from "../theme/visualThemes";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { startCyberpunkFlashBlinkTransition } from "./cyberpunkFlashBlinkTransition";

export type DrawerTransitionEvent = {
  direction: "open" | "close";
  sequence: number;
};

export function useDrawerTransitionEvent(open: boolean) {
  const previousOpenRef = useRef(open);
  const sequenceRef = useRef(0);
  const [event, setEvent] = useState<DrawerTransitionEvent | null>(null);

  useEffect(() => {
    if (previousOpenRef.current === open) return;
    previousOpenRef.current = open;
    setEvent({
      direction: open ? "open" : "close",
      sequence: ++sequenceRef.current,
    });
  }, [open]);

  return event;
}

export function DrawerThemeTransitionSurface({
  children,
  event,
  playThemeSfx,
}: {
  children: ReactNode;
  event: DrawerTransitionEvent | null;
  playThemeSfx: (event: VisualThemeSoundEvent) => Promise<void>;
}) {
  const { theme } = useVisualTheme();
  const reduceMotion = useReducedMotion();
  const handledSequenceRef = useRef(0);
  const contentOpacity = useSharedValue(1);
  const contentScaleY = useSharedValue(1);
  const flashOpacity = useSharedValue(0);

  useEffect(() => {
    if (!event || handledSequenceRef.current === event.sequence) return;
    handledSequenceRef.current = event.sequence;
    void playThemeSfx(event.direction === "open" ? "drawerOpen" : "drawerClose");

    cancelAnimation(contentOpacity);
    cancelAnimation(contentScaleY);
    cancelAnimation(flashOpacity);
    contentOpacity.value = 1;
    contentScaleY.value = 1;
    flashOpacity.value = 0;

    if (theme.motion.drawerTransition !== "flash-blink" || reduceMotion) return;

    contentOpacity.value = event.direction === "open" ? 0 : 1;
    startCyberpunkFlashBlinkTransition({
      direction: event.direction,
      durationMs: event.direction === "open"
        ? theme.motion.popupOpen.durationMs
        : theme.motion.popupClose.durationMs,
      contentOpacity,
      contentScaleY,
      flashOpacity,
      onFinish: () => {
        "worklet";
      },
    });
  }, [event, playThemeSfx, reduceMotion, theme.motion]);

  useEffect(() => () => {
    cancelAnimation(contentOpacity);
    cancelAnimation(contentScaleY);
    cancelAnimation(flashOpacity);
  }, [contentOpacity, contentScaleY, flashOpacity]);

  const contentStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.value,
    transform: [{ scaleY: contentScaleY.value }],
  }));
  const flashStyle = useAnimatedStyle(() => ({ opacity: flashOpacity.value }));

  return (
    <Animated.View style={styles.root}>
      <Animated.View style={[styles.content, contentStyle]}>{children}</Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[styles.flash, { backgroundColor: theme.colors.accent }, flashStyle]}
        testID="drawer-theme-transition-flash"
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: "hidden",
  },
  content: {
    flex: 1,
  },
  flash: {
    ...StyleSheet.absoluteFillObject,
  },
});
