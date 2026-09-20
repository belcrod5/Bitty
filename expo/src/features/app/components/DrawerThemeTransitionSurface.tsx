import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, StyleSheet } from "react-native";

import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import type { VisualThemeSoundEvent } from "../theme/visualThemes";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { createCyberpunkFlashBlinkTransition } from "./cyberpunkFlashBlinkTransition";

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
  const reduceMotion = useReduceMotionEnabled();
  const handledSequenceRef = useRef(0);
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const contentOpacity = useRef(new Animated.Value(1)).current;
  const flashOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!event || reduceMotion === null || handledSequenceRef.current === event.sequence) return;
    handledSequenceRef.current = event.sequence;
    void playThemeSfx(event.direction === "open" ? "drawerOpen" : "drawerClose");

    animationRef.current?.stop();
    contentOpacity.setValue(1);
    flashOpacity.setValue(0);

    if (theme.motion.drawerTransition !== "flash-blink" || reduceMotion) return;

    contentOpacity.setValue(event.direction === "open" ? 0 : 1);
    const animation = createCyberpunkFlashBlinkTransition({
      direction: event.direction,
      durationMs: event.direction === "open"
        ? theme.motion.popupOpen.durationMs
        : theme.motion.popupClose.durationMs,
      contentOpacity,
      flashOpacity,
    });
    animationRef.current = animation;
    animation.start();
  }, [event, playThemeSfx, reduceMotion, theme.motion]);

  useEffect(() => () => animationRef.current?.stop(), []);

  return (
    <Animated.View style={styles.root}>
      <Animated.View style={[styles.content, { opacity: contentOpacity }]}>{children}</Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[styles.flash, { backgroundColor: theme.colors.accent, opacity: flashOpacity }]}
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
