import { Ionicons } from "@expo/vector-icons";
import { useEffect } from "react";
import { StyleSheet, Text, TouchableOpacity } from "react-native";
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

export function SpeedModeButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  const { theme } = useVisualTheme();
  const reduceMotion = useReduceMotionEnabled();
  const opacity = useSharedValue(1);
  const iconStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  useEffect(() => {
    opacity.value = 1;
    if (active && reduceMotion === false) {
      // The live OS hook owns motion preferences; Reanimated caches System at startup.
      opacity.value = withRepeat(
        withTiming(0.35, { duration: 1500, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.Never }),
        -1, true, undefined, ReduceMotion.Never,
      );
    }
    return () => {
      cancelAnimation(opacity);
      opacity.value = 1;
    };
  }, [active, opacity, reduceMotion]);

  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`速度設定を開く: ${label}`}
      hitSlop={8}
      style={[styles.button, { backgroundColor: active ? theme.tones.warning.background : "transparent" }]}
    >
      <Reanimated.View style={iconStyle}>
        <Ionicons name={active ? "flash" : "flash-outline"} size={14}
          color={active ? theme.tones.warning.foreground : theme.colors.textMuted} />
      </Reanimated.View>
      <Text style={{ color: active ? theme.tones.warning.foreground : theme.colors.textMuted, fontSize: 11 }}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: "row", alignItems: "center", gap: 3, padding: 3, borderRadius: 5 },
});
