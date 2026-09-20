import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";

import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";
import { SPLASH_FAIL_OPEN_MS } from "../theme/themeSplashTiming";

type ThemeSplashProps = {
  ready: boolean;
  onReady?: () => void;
};

const ANIMATION_FAIL_OPEN_BUFFER_MS = 250;

export function ThemeSplash({ ready, onReady }: ThemeSplashProps) {
  const { theme, themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const reduceMotion = useReduceMotionEnabled();
  const opacity = useRef(new Animated.Value(1)).current;
  const markOpacity = useRef(new Animated.Value(1)).current;
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const dismissedRef = useRef(false);
  const readySignaledRef = useRef(false);
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
    if (!ready || !visible || dismissedRef.current || reduceMotion === null) return;
    const generation = ++animationGenerationRef.current;
    animationRef.current?.stop();
    opacity.setValue(1);
    markOpacity.setValue(1);

    const motion = theme.motion.splash;
    const animationTimer = setTimeout(
      () => completeAnimation(generation),
      motion.durationMs + ANIMATION_FAIL_OPEN_BUFFER_MS
    );
    let animation: Animated.CompositeAnimation;

    if (reduceMotion) {
      animation = Animated.timing(opacity, {
        toValue: 0,
        duration: 140,
        useNativeDriver: false,
      });
    } else {
      const flashDuration = motion.flashDurationMs * motion.flashCount * 2;
      const fadeDuration = Math.max(120, motion.durationMs - flashDuration);
      if (motion.flashCount > 0) {
        animation = Animated.parallel([
          Animated.loop(
            Animated.sequence([
              Animated.timing(markOpacity, {
                toValue: motion.flashOpacity,
                duration: motion.flashDurationMs,
                easing: Easing.linear,
                useNativeDriver: false,
              }),
              Animated.timing(markOpacity, {
                toValue: 1,
                duration: motion.flashDurationMs,
                easing: Easing.linear,
                useNativeDriver: false,
              }),
            ]),
            { iterations: motion.flashCount }
          ),
          Animated.sequence([
            Animated.delay(flashDuration),
            Animated.timing(opacity, {
              toValue: 0,
              duration: fadeDuration,
              easing: Easing.out(Easing.quad),
              useNativeDriver: false,
            }),
          ]),
        ]);
      } else {
        const holdDuration = Math.min(180, Math.floor(motion.durationMs / 3));
        animation = Animated.sequence([
          Animated.delay(holdDuration),
          Animated.timing(opacity, {
            toValue: 0,
            duration: Math.max(120, motion.durationMs - holdDuration),
            easing: Easing.out(Easing.quad),
            useNativeDriver: false,
          }),
        ]);
      }
    }
    animationRef.current = animation;
    animation.start(({ finished }) => {
      if (finished) completeAnimation(generation);
    });

    return () => {
      if (animationGenerationRef.current === generation) {
        animationGenerationRef.current += 1;
      }
      clearTimeout(animationTimer);
      animation.stop();
    };
  }, [completeAnimation, markOpacity, opacity, ready, reduceMotion, theme.motion.splash, visible]);

  if (!visible) return null;

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="auto"
      style={[styles.root, { opacity }]}
      testID="theme-splash"
    >
      <Animated.View style={[styles.mark, { opacity: markOpacity }]}>
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
