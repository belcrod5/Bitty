import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import { useVisualTheme } from "../theme/VisualThemeContext";
import type { DirectorySessionSyncState } from "../types/directorySessions";
import { USE_NATIVE_ANIMATION_DRIVER } from "../utils/animationDriver";

type Props = {
  phase: DirectorySessionSyncState["phase"] | undefined;
  variant: "bar" | "ring";
};

export function SessionSyncIndicator({ phase, variant }: Props) {
  const { theme } = useVisualTheme();
  const reduceMotion = useReduceMotionEnabled();
  const progress = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);
  const active = phase === "loading" || phase === "refreshing";

  useEffect(() => {
    progress.setValue(0);
    if (!active || reduceMotion !== false) return;
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: variant === "bar" ? 1300 : 1000,
        easing: Easing.linear,
        useNativeDriver: USE_NATIVE_ANIMATION_DRIVER,
        isInteraction: false,
      })
    );
    loop.start();
    return () => {
      loop.stop();
      progress.setValue(0);
    };
  }, [active, progress, reduceMotion, variant]);

  if (!active) return null;
  const moving = reduceMotion === false;
  return variant === "bar" ? (
    <View
      pointerEvents="none"
      style={[styles.bar, { backgroundColor: theme.colors.primaryActionMuted }]}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessibilityRole="progressbar"
      accessibilityLabel="登録ディレクトリのセッション同期"
      testID="session-sync-bar"
    >
      <Animated.View style={{
        height: 2,
        backgroundColor: theme.colors.primaryAction,
        width: width * 0.35,
        transform: [{ translateX: moving ? progress.interpolate({
          inputRange: [0, 1],
          outputRange: [-width * 0.35, width],
        }) : width * 0.325 }],
      }} />
    </View>
  ) : (
    <Animated.View
      pointerEvents="none"
      accessibilityRole="progressbar"
      accessibilityLabel="登録ディレクトリのセッション同期"
      testID="session-sync-ring"
      style={[
        styles.ring,
        {
          borderColor: theme.colors.primaryActionMuted,
          borderTopColor: theme.colors.primaryAction,
          transform: [{ rotate: moving ? progress.interpolate({
            inputRange: [0, 1],
            outputRange: ["0deg", "360deg"],
          }) : "0deg" }],
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  bar: { height: 2, overflow: "hidden" },
  ring: {
    position: "absolute",
    top: -2,
    bottom: -2,
    left: -2,
    right: -2,
    borderWidth: 1.5,
    borderRadius: 999,
  },
});
