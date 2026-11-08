import { Alert, Platform, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import { RunnerLoginSettings } from "../components/RunnerLoginSettings";
import { useAppShell } from "../contexts/AppShellContext";
import { KeyboardAvoidingView } from "../keyboardController";
import { CloudflareTunnelMonitorScreen } from "./CloudflareTunnelMonitorScreen";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { isRunnerSessionToken } from "../utils/runnerLogin";
import { useAppStyles } from "../styles";

// Before authentication only connection setup and login are reachable. In
// particular the normal settings screen also exposes account/workspace data.
export function RunnerLoginScreen({ onRetry }: { onRetry: () => void }) {
  const { activeScreen, openCloudflareTunnelMonitorScreen } = useAppShell();
  const { runnerToken, saveRunnerToken } = useAppSettings();
  const styles = useAppStyles();
  if (activeScreen === "cloudflare_tunnel_monitor") return <CloudflareTunnelMonitorScreen />;
  return <SafeAreaView style={{ flex: 1 }}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}
      automaticOffset={Platform.OS === "ios"}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20 }}>
        {isRunnerSessionToken(runnerToken) ? <View style={styles.settingsSection}>
          <Text style={styles.settingsSectionTitle}>ログイン状態を確認しています</Text>
          <Text style={styles.hint}>接続して本人確認が完了するまで、会話や端末情報は表示されません。</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="ログイン状態を再確認" onPress={onRetry} style={styles.settingsPrimaryButton}>
            <Text style={styles.settingsPrimaryButtonText}>接続して再確認</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={openCloudflareTunnelMonitorScreen} style={styles.settingsPrimaryButton}>
            <Text style={styles.settingsPrimaryButtonText}>接続設定QRを読み込む</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="この端末のログイン情報を消去" style={styles.settingsPrimaryButton}
            onPress={() => void saveRunnerToken("").then(() => Alert.alert("ログイン情報を消去しました", "サーバーの失効確認は行っていません。他の登録端末またはMacから、この端末を失効してください。"))
              .catch(() => Alert.alert("消去できませんでした", "キーチェーンへのアクセスを確認し、再度お試しください。"))}>
            <Text style={styles.settingsPrimaryButtonText}>この端末のログイン情報を消去する</Text>
          </Pressable>
        </View> : <RunnerLoginSettings />}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
