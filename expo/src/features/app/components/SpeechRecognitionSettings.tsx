import { useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { getSttProvider, saveSttProvider, type SttProvider } from "../../stt/sttSettingsClient";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useAppStyles } from "../styles";
import { SettingsSelect } from "./SettingsSelect";

const PROVIDERS = [
  { value: "google", label: "Google Cloud", description: "RunnerのGoogle Cloud認証と月間上限を使用します。" },
  { value: "macos", label: "macOS標準", description: "Runner Mac上で日本語を文字起こしします。初回はMacの音声認識許可が必要です。" },
] as const;

export function SpeechRecognitionSettings() {
  const styles = useAppStyles();
  const { runnerUrl, runnerToken } = useAppSettings();
  const [provider, setProvider] = useState<SttProvider>("google");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    if (!runnerUrl.trim() || !runnerToken.trim()) {
      setError("Runnerに接続すると選択できます。");
      setLoading(false);
      return;
    }
    void getSttProvider(runnerUrl, runnerToken).then((saved) => {
      if (!active) return;
      setProvider(saved);
      setError("");
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "設定を取得できませんでした。");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [runnerUrl, runnerToken]);

  const selectProvider = async (next: SttProvider) => {
    if (loading || next === provider) return;
    setLoading(true);
    setError("");
    try {
      await saveSttProvider(runnerUrl, runnerToken, next);
      setProvider(next);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "音声認識の設定を保存できませんでした。";
      setError(message);
      Alert.alert("音声認識", message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.settingsSection}>
      <View style={styles.settingsSectionHeader}>
        <Text style={styles.settingsSectionTitle}>音声入力 · 文字起こし</Text>
      </View>
      <View style={styles.settingsGroup}>
        <SettingsSelect
          icon="mic-outline"
          label="文字起こし方式"
          options={PROVIDERS}
          selectedValue={provider}
          onSelect={(next) => void selectProvider(next)}
          loading={loading}
          description="チャットとSkiaボードの次の録音から反映されます。"
          showDivider={false}
        />
        {error ? <Text style={styles.settingsErrorText}>{error}</Text> : null}
      </View>
    </View>
  );
}
