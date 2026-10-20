import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import type { VoiceResetConfirmation } from "../hooks/useVoiceConversation";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";
import { AppModal } from "./AppModal";

export function VoiceResetConfirmationModal({ request }: { request: VoiceResetConfirmation | null }) {
  const { themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    progress.setValue(request?.deadlineMs ? Math.max(0, 1 - (request.deadlineMs - Date.now()) / 10_000) : 0);
    if (!request?.deadlineMs) return;
    const animation = Animated.timing(progress, {
      toValue: 1, duration: Math.max(0, request.deadlineMs - Date.now()), easing: Easing.linear, useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, request]);

  if (!request) return null;

  return (
    <AppModal visible transparent animationType="fade" onRequestClose={() => {}}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <Text style={styles.title}>{request.required ? "セッションのリセットが必要です" : "セッションをリセットしていいですか？"}</Text>
          <Text style={styles.body}>最近の会話は引き継ぎます。</Text>
          {!request.required && <Text style={styles.body}>10秒後にリセットせず続けます。</Text>}
          <View style={styles.actions}>
            {!request.required && <Pressable accessibilityRole="button" accessibilityLabel="続ける"
              accessibilityHint="10秒後にリセットせず自動で続けます"
              style={styles.continueButton} onPress={() => request.decide("continue")}>
              <Animated.View testID="voice-reset-countdown" pointerEvents="none" style={[styles.meter, {
                width: progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
              }]} />
              <Text style={styles.action}>続ける</Text>
            </Pressable>}
            <Pressable accessibilityRole="button" style={styles.button} onPress={() => request.decide("reset")}>
              <Text style={styles.action}>リセットする</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </AppModal>
  );
}

function createStyles(theme: VisualTheme) {
  return StyleSheet.create({
    backdrop: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: theme.approval.backdrop },
    card: { padding: 20, gap: 16, borderRadius: 12, backgroundColor: theme.colors.surface,
      borderWidth: theme.approval.borderWidth, borderColor: theme.colors.borderStrong },
    title: { color: theme.colors.textPrimary, fontSize: theme.typography.title.fontSize, fontWeight: "700" },
    body: { color: theme.colors.textPrimary, fontSize: theme.typography.body.fontSize },
    actions: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 12 },
    button: { padding: 12 },
    continueButton: { overflow: "hidden", padding: 12, minWidth: 110, alignItems: "center",
      borderRadius: 8, borderWidth: 1, borderColor: theme.colors.controlAccent },
    meter: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: theme.colors.controlAccent, opacity: 0.25 },
    action: { color: theme.colors.controlAccent, fontSize: theme.typography.body.fontSize, fontWeight: "700" },
  });
}

const stylesByTheme = createStylesByTheme(createStyles);
