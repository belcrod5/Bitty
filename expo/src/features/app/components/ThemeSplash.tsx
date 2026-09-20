import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useVisualTheme } from "../theme/VisualThemeContext";
import {
  createStylesByTheme,
  type VisualTheme,
  type VisualThemeTransitionEvent,
} from "../theme/visualThemes";
import { SPLASH_FAIL_OPEN_MS } from "../theme/themeSplashTiming";

type ThemeSplashProps = {
  ready: boolean;
  onReady?: () => void;
  playThemeSfx: (event: VisualThemeTransitionEvent) => Promise<void>;
};

const ANIMATION_FAIL_OPEN_BUFFER_MS = 250;

export function ThemeSplash({ ready, onReady, playThemeSfx }: ThemeSplashProps) {
  const { theme, themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  const markOpacity = useSharedValue(1);
  const dismissedRef = useRef(false);
  const readySignaledRef = useRef(false);
  const soundPlayedRef = useRef(false);
  const animationGenerationRef = useRef(0);
  const failOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [visible, setVisible] = useState(true);

  const signalReady = useCallback(() => {
    if (readySignaledRef.current) return;
    readySignaledRef.current = true;
    onReadyRef.current?.();
  }, []);

  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    if (failOpenTimerRef.current) clearTimeout(failOpenTimerRef.current);
    setVisible(false);
  }, []);

  const completeAnimation = useCallback((generation: number) => {
    if (animationGenerationRef.current !== generation) return;
    dismiss();
  }, [dismiss]);

  useEffect(() => {
    const timer = setTimeout(() => {
      signalReady();
      dismiss();
    }, SPLASH_FAIL_OPEN_MS);
    failOpenTimerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (failOpenTimerRef.current === timer) failOpenTimerRef.current = null;
    };
  }, [dismiss, signalReady]);

  useEffect(() => {
    if (ready) signalReady();
  }, [ready, signalReady]);

  useEffect(() => {
    if (!ready || !visible || dismissedRef.current || soundPlayedRef.current) return;
    const timer = setTimeout(() => {
      if (!visible || dismissedRef.current || soundPlayedRef.current) return;
      soundPlayedRef.current = true;
      void playThemeSfx("splash");
    }, 0);
    return () => clearTimeout(timer);
  }, [playThemeSfx, ready, visible]);

  useEffect(() => {
    if (!ready || !visible || dismissedRef.current) return;
    const generation = ++animationGenerationRef.current;
    opacity.value = 1;
    markOpacity.value = 1;

    const motion = theme.motion.splash;
    const animationTimer = setTimeout(
      () => completeAnimation(generation),
      motion.durationMs + ANIMATION_FAIL_OPEN_BUFFER_MS
    );
    const finish = (finished?: boolean) => {
      "worklet";
      if (finished) runOnJS(completeAnimation)(generation);
    };

    if (reduceMotion) {
      opacity.value = withTiming(0, { duration: 140 }, finish);
    } else {
      const flashDuration = motion.flashDurationMs * motion.flashCount * 2;
      const fadeDuration = Math.max(120, motion.durationMs - flashDuration);
      if (motion.flashCount > 0) {
        markOpacity.value = withRepeat(
          withTiming(motion.flashOpacity, {
            duration: motion.flashDurationMs,
            easing: Easing.linear,
          }),
          motion.flashCount * 2,
          true
        );
        opacity.value = withDelay(
          flashDuration,
          withTiming(0, { duration: fadeDuration, easing: Easing.out(Easing.quad) }, finish)
        );
      } else {
        const holdDuration = Math.min(180, Math.floor(motion.durationMs / 3));
        opacity.value = withDelay(holdDuration, withTiming(0, {
          duration: Math.max(120, motion.durationMs - holdDuration),
          easing: Easing.out(Easing.quad),
        }, finish));
      }
    }

    return () => {
      if (animationGenerationRef.current === generation) {
        animationGenerationRef.current += 1;
      }
      clearTimeout(animationTimer);
      cancelAnimation(opacity);
      cancelAnimation(markOpacity);
    };
  }, [completeAnimation, markOpacity, opacity, ready, reduceMotion, theme.motion.splash, visible]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const animatedMarkStyle = useAnimatedStyle(() => ({ opacity: markOpacity.value }));

  if (!visible) return null;

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="auto"
      style={[styles.root, animatedStyle]}
      testID="theme-splash"
    >
      <Animated.View style={[styles.mark, animatedMarkStyle]}>
        <View style={styles.markLine} />
        <Text style={styles.title}>BITTY</Text>
        <View style={styles.markLine} />
      </Animated.View>
    </Animated.View>
  );
}

function createStyles(theme: VisualTheme) {
  return StyleSheet.create({
    root: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 10_000,
      elevation: 10_000,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.canvas,
    },
    mark: {
      width: 176,
      gap: 12,
      alignItems: "center",
    },
    markLine: {
      width: "100%",
      height: theme.borders.thin,
      backgroundColor: theme.colors.accent,
    },
    title: {
      color: theme.colors.textPrimary,
      fontSize: 30,
      lineHeight: 36,
      fontWeight: "800",
      letterSpacing: 8,
    },
  });
}

const stylesByTheme = createStylesByTheme(createStyles);
