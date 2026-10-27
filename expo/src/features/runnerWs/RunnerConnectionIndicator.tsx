import { ActivityIndicator, SafeAreaView, StyleSheet, View } from "react-native";
import { useRunnerWebSocketSnapshot } from "./RunnerWebSocketContext";
import { useVisualTheme } from "../app/theme/VisualThemeContext";

export function RunnerConnectionIndicator({ enabled, connectionInterrupted }: {
  enabled: boolean;
  connectionInterrupted: boolean;
}) {
  const { connectionState } = useRunnerWebSocketSnapshot();
  const { theme } = useVisualTheme();
  const connecting = connectionState === "connecting" || connectionState === "handshaking" || connectionState === "reconnecting";
  if (!enabled || (!connectionInterrupted && !connecting)) return null;

  return (
    <SafeAreaView pointerEvents="none" style={styles.overlay} testID="runner-connection-indicator">
      <View style={styles.corner}>
        <ActivityIndicator
          size="small"
          color={theme.colors.iconSecondary}
          style={styles.spinner}
          accessibilityLabel="Runner に接続中"
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 20_000, elevation: 20_000 },
  corner: { marginTop: 4, marginLeft: 4, width: 12, height: 12 },
  spinner: { width: 12, height: 12, transform: [{ scale: 0.6 }] },
});
