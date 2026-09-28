import { useEffect, useMemo } from "react";
import { Platform, requireNativeComponent, StyleSheet, type ViewProps } from "react-native";
import Reanimated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

let macBlurView: ReturnType<typeof requireNativeComponent<ViewProps>> | null = null;

export function VoiceHistoryBackdrop({ expanded, reduceMotion }: { expanded: boolean; reduceMotion: boolean }) {
  const opacity = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const IosBlurView = useMemo(() => Platform.OS === "ios"
    ? require("expo-blur").BlurView as typeof import("expo-blur").BlurView : null, []);
  if (Platform.OS === "macos" && !macBlurView) {
    macBlurView = requireNativeComponent<ViewProps>("BittyVoiceBlur");
  }
  const MacBlurView = Platform.OS === "macos" ? macBlurView : null;

  useEffect(() => {
    opacity.value = withTiming(expanded ? 1 : 0, { duration: reduceMotion ? 0 : 240 });
  }, [expanded, opacity, reduceMotion]);

  return (
    <>
      {expanded && IosBlurView ? (
        <IosBlurView testID="voice-conversation-board-blur" pointerEvents="none"
          intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
      ) : null}
      {expanded && MacBlurView ? (
        <MacBlurView testID="voice-conversation-board-blur" pointerEvents="none"
          style={StyleSheet.absoluteFill} />
      ) : null}
      <Reanimated.View testID="voice-conversation-backdrop"
        pointerEvents={expanded ? "auto" : "none"}
        style={[StyleSheet.absoluteFill,
          { backgroundColor: IosBlurView || MacBlurView ? "rgba(0, 0, 0, 0.4)" : "rgba(0, 0, 0, 0.68)" },
          animatedStyle]} />
    </>
  );
}
