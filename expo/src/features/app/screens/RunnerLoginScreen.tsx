import { Alert, Platform, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import { useEffect, useRef } from "react";
import { Ionicons } from "@expo/vector-icons";
import { RunnerLoginSettings } from "../components/RunnerLoginSettings";
import { useAppShell } from "../contexts/AppShellContext";
import { KeyboardAvoidingView } from "../keyboardController";
import { CloudflareTunnelMonitorScreen } from "./CloudflareTunnelMonitorScreen";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { isRunnerSessionToken } from "../utils/runnerLogin";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { runnerLoginStylesByTheme } from "../styles/runnerLoginStyles";

// Connection setup is the only navigation available before verification.
export function RunnerLoginScreen({ onRetry }: { onRetry: () => void }) {
  const { activeScreen, openCloudflareTunnelMonitorScreen } = useAppShell();
  const { runnerUrl, runnerToken, saveRunnerToken } = useAppSettings();
  const current = useRef({ runnerUrl, runnerToken });
  current.current = { runnerUrl, runnerToken };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { theme, themeId } = useVisualTheme();
  const styles = runnerLoginStylesByTheme[themeId];
  if (activeScreen === "cloudflare_tunnel_monitor") return <CloudflareTunnelMonitorScreen setupOnly />;

  const clearLogin = () => {
    Alert.alert("ログインをやり直しますか？", "この端末のログイン情報を消去します。", [
      { text: "キャンセル", style: "cancel" },
      { text: "やり直す", style: "destructive", onPress: () => {
        if (!mounted.current || current.current.runnerToken !== runnerToken || current.current.runnerUrl !== runnerUrl) return;
        void saveRunnerToken("").then(() => Alert.alert("ログイン情報を消去しました", "サーバー側の解除は未確認です。他の端末かMacから確認してください。"))
          .catch(() => Alert.alert("消去できませんでした", "キーチェーンへのアクセスを確認してください。"));
      } },
    ]);
  };

  return <SafeAreaView style={styles.screen}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}
      automaticOffset={Platform.OS === "ios"}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
        <View style={styles.container}>
          <View style={styles.brand}><Ionicons name="chatbubble-ellipses" size={24} color={theme.colors.controlAccent} />
            <Text style={styles.brandText}>Bitty</Text></View>
          {isRunnerSessionToken(runnerToken) ? <View style={styles.card}>
            <View style={styles.header}>
              <View style={styles.iconTile}><Ionicons name="cloud-outline" size={25} color={theme.colors.controlAccent} /></View>
              <Text accessibilityRole="header" style={styles.title}>接続を確認しています</Text>
              <Text style={styles.description}>Macが起動し、ネットワークにつながっているか確認してください。</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="接続を再確認" onPress={onRetry} style={styles.primary}>
              <Ionicons name="refresh-outline" size={18} color={theme.colors.textOnAccent} />
              <Text style={styles.primaryText}>もう一度接続</Text>
            </Pressable>
            <View style={styles.actions}>
              <Pressable accessibilityRole="button" accessibilityLabel="接続先を設定" onPress={openCloudflareTunnelMonitorScreen} style={styles.secondary}>
                <Ionicons name="qr-code-outline" size={16} color={theme.colors.controlAccent} /><Text style={styles.secondaryText}>接続先を設定</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="ログインをやり直す" onPress={clearLogin} style={styles.secondary}>
                <Text style={[styles.secondaryText, styles.mutedText]}>ログインをやり直す</Text>
              </Pressable>
            </View>
          </View> : <RunnerLoginSettings />}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
