import { Ionicons } from "@expo/vector-icons";
import { useEffect } from "react";
import { StyleSheet, TouchableOpacity } from "react-native";
import Reanimated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import { useVisualTheme } from "../theme/VisualThemeContext";

export function FastModeToggle({ enabled, onPress }: { enabled: boolean; onPress: () => void }) {
  const { theme } = useVisualTheme();
  const reduceMotion = useReduceMotionEnabled();
  const opacity = useSharedValue(1);
  const iconStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  useEffect(() => {
    opacity.value = 1;
    if (enabled && reduceMotion === false) {
      // The live OS hook owns motion preferences; Reanimated caches System at startup.
      opacity.value = withRepeat(
        withTiming(0.55, { duration: 1500, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.Never }),
        -1, true, undefined, ReduceMotion.Never,
      );
    }
    return () => {
      cancelAnimation(opacity);
      opacity.value = 1;
    };
  }, [enabled, opacity, reduceMotion]);

  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="switch"
      accessibilityLabel="Fast mode"
      accessibilityState={{ checked: enabled }}
      hitSlop={8}
      style={[styles.button, { backgroundColor: enabled ? theme.tones.warning.background : "transparent" }]}
    >
      <Reanimated.View style={iconStyle}>
        <Ionicons name={enabled ? "flash" : "flash-outline"} size={14}
          color={enabled ? theme.tones.warning.foreground : theme.colors.textMuted} />
      </Reanimated.View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: { padding: 3, borderRadius: 5 },
});
