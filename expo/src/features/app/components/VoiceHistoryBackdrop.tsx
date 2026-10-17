import { useMemo } from "react";
import { Platform, requireNativeComponent, StyleSheet, type ViewProps } from "react-native";
import Reanimated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";

let macBlurView: ReturnType<typeof requireNativeComponent<ViewProps>> | null = null;

export function getMacVoiceBlurView() {
  if (!macBlurView) macBlurView = requireNativeComponent<ViewProps>("BittyVoiceBlur");
  return macBlurView;
}

export function VoiceHistoryBackdrop({ expanded, visible, height }: {
  expanded: boolean; visible: boolean; height: SharedValue<number>;
}) {
  const animatedStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, height.value / 240) }));
  const IosBlurView = useMemo(() => Platform.OS === "ios"
    ? require("expo-blur").BlurView as typeof import("expo-blur").BlurView : null, []);
  const MacBlurView = Platform.OS === "macos" ? getMacVoiceBlurView() : null;

  return (
    <>
      {visible && IosBlurView ? (
        <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, animatedStyle]}>
          <IosBlurView testID="voice-conversation-board-blur" pointerEvents="none"
            intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
        </Reanimated.View>
      ) : null}
      {visible && MacBlurView ? (
        <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, animatedStyle]}>
          <MacBlurView testID="voice-conversation-board-blur" pointerEvents="none"
            style={StyleSheet.absoluteFill} />
        </Reanimated.View>
      ) : null}
      <Reanimated.View testID="voice-conversation-backdrop"
        pointerEvents={expanded ? "auto" : "none"}
        style={[StyleSheet.absoluteFill,
          { backgroundColor: IosBlurView || MacBlurView ? "rgba(0, 0, 0, 0.4)" : "rgba(0, 0, 0, 0.68)" },
          animatedStyle]} />
    </>
  );
}
