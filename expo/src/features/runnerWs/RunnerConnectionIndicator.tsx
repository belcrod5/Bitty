import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Keyboard, SafeAreaView, StyleSheet, View } from "react-native";
import { useRunnerWebSocketSnapshot } from "./RunnerWebSocketContext";
import { useVisualTheme } from "../app/theme/VisualThemeContext";
import { AppModal } from "../app/components/AppModal";

export function RunnerConnectionRecovery({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { connectionState, appState } = useRunnerWebSocketSnapshot();
  const unavailable = enabled && appState === "active" && connectionState !== "ready" && connectionState !== "background";
  const [showRecovery, setShowRecovery] = useState(false);
  useEffect(() => {
    setShowRecovery(false);
    if (!unavailable) return;
    const timer = setTimeout(() => { Keyboard.dismiss(); setShowRecovery(true); }, 10_000);
    return () => clearTimeout(timer);
  }, [unavailable]);
  if (!unavailable || !showRecovery) return null;
  return <AppModal visible>
    <View style={styles.recovery} accessibilityViewIsModal>{children}</View>
  </AppModal>;
}

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
  recovery: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 20_000, elevation: 20_000 },
  corner: { marginTop: 4, marginLeft: 4, width: 12, height: 12 },
  spinner: { width: 12, height: 12, transform: [{ scale: 0.6 }] },
});
