import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  cancelGoogleCloudAuth,
  disconnectGoogleCloud,
  getGoogleCloudStatus,
  saveGoogleCloudSettings,
  startGoogleCloudAuth,
  type GoogleSttModel,
  type GoogleSttRegion,
  type GoogleCloudStatus,
} from "../../stt/googleCloudClient";
import type { StreamingSttUsage } from "../../stt/streamingSttClient";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useAppStyles } from "../styles";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { SettingsSelect } from "./SettingsSelect";

const STT_REGIONS = [
  { value: "us", label: "米国 (us)" },
  { value: "asia-northeast1", label: "東京 (asia-northeast1) · 検証中", description: "このリージョンで各モデルが使えるかは実際の録音で確認してください。" },
] as const;
const STT_MODELS = [
  { value: "chirp_3", label: "chirp_3" },
  { value: "long", label: "long" },
  { value: "short", label: "short" },
] as const;

function duration(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}分${String(safe % 60).padStart(2, "0")}秒`;
}

function usageSummary(usage?: StreamingSttUsage) {
  if (!usage) return "利用状況を取得できません";
  return `今月 ${duration(usage.usedSeconds)} / ${Math.ceil(usage.limitSeconds / 60)}分`;
}

export function GoogleCloudSettings() {
  const styles = useAppStyles();
  const { theme } = useVisualTheme();
  const { runnerUrl, runnerToken } = useAppSettings();
  const [status, setStatus] = useState<GoogleCloudStatus>({ status: "idle" });
  const [projectId, setProjectId] = useState("");
  const [limitMinutes, setLimitMinutes] = useState("60");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draftRegion, setDraftRegion] = useState<GoogleSttRegion>("us");
  const [draftModel, setDraftModel] = useState<GoogleSttModel>("chirp_3");
  const [pendingSettings, setPendingSettings] = useState<{ region: GoogleSttRegion; model: GoogleSttModel } | null>(null);
  const latestSelection = useRef(pendingSettings);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const savedSettingsVersion = useRef(0);

  const refresh = useCallback(async () => {
    if (!runnerUrl.trim() || !runnerToken.trim()) return;
    const version = savedSettingsVersion.current;
    try {
      const next = await getGoogleCloudStatus(runnerUrl, runnerToken);
      setStatus((current) => version === savedSettingsVersion.current ? next : {
        ...next,
        sttRegion: current.sttRegion,
        sttModel: current.sttModel,
      });
      if (next.projectId) setProjectId(next.projectId);
      if (next.usage?.limitSeconds) setLimitMinutes(String(Math.ceil(next.usage.limitSeconds / 60)));
    } catch (error) {
      if (version === savedSettingsVersion.current) {
        setStatus({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }, [runnerToken, runnerUrl]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (status.status !== "authenticating") return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh, status.status]);

  const save = useCallback(async () => {
    const project = projectId.trim();
    const limit = Number(limitMinutes);
    if (!project) throw new Error("Google Cloud project IDを入力してください。");
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("月間上限は1以上の整数で入力してください。");
    await saveGoogleCloudSettings(runnerUrl, runnerToken, { projectId: project, monthlyLimitMinutes: limit });
  }, [limitMinutes, projectId, runnerToken, runnerUrl]);

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await action();
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(message);
      Alert.alert("Google Cloud", message);
    } finally {
      setBusy(false);
    }
  };

  const beginAuth = () => run(async () => {
    await save();
    await startGoogleCloudAuth(runnerUrl, runnerToken);
    setStatus((current) => ({ ...current, status: "authenticating", message: undefined }));
  });
  const connected = status.status === "connected";
  const usedCost = ((status.usage?.usedSeconds || 0) / 60) * 0.016;
  const savedRegion = status.sttRegion || "us";
  const savedModel = status.sttModel || "chirp_3";

  useEffect(() => {
    if (!pendingSettings || busy) return;
    setBusy(true);
    setActionError("");
    void saveGoogleCloudSettings(runnerUrl, runnerToken, {
      sttRegion: pendingSettings.region,
      sttModel: pendingSettings.model,
    }).then(() => {
      savedSettingsVersion.current += 1;
      setStatus((current) => ({ ...current, sttRegion: pendingSettings.region, sttModel: pendingSettings.model }));
      if (latestSelection.current === pendingSettings) latestSelection.current = null;
      setPendingSettings((current) => current === pendingSettings ? null : current);
    }).catch((error) => {
      if (latestSelection.current === pendingSettings) {
        latestSelection.current = null;
        setDraftRegion(savedRegion);
        setDraftModel(savedModel);
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        Alert.alert("Google Cloud", message);
      }
      setPendingSettings((current) => current === pendingSettings ? null : current);
    }).finally(() => setBusy(false));
  }, [busy, pendingSettings, runnerToken, runnerUrl, savedModel, savedRegion]);

  const selectAdvanced = (region: GoogleSttRegion, model: GoogleSttModel) => {
    setDraftRegion(region);
    setDraftModel(model);
    const next = { region, model };
    latestSelection.current = next;
    setPendingSettings(next);
  };

  const toggleAdvanced = () => {
    if (!advancedOpen && !pendingSettings) {
      setDraftRegion(savedRegion);
      setDraftModel(savedModel);
    }
    setAdvancedOpen(!advancedOpen);
  };

  return (
    <View style={styles.settingsSection}>
      <View style={styles.settingsSectionHeader}>
        <Text style={styles.settingsSectionTitle}>Google Cloud 音声サービス</Text>
      </View>
      <View style={styles.settingsGroup}>
        <View style={[styles.settingsInputRow, styles.settingsRowDivider]}>
          <Ionicons name="cloud-outline" size={22} color={theme.colors.controlTextPrimary} />
          <View style={styles.settingsInputContent}>
            <Text style={styles.settingsRowLabel}>
              {connected ? "接続済み" : status.status === "authenticating" ? "Continue on Runner Mac" : "未接続"}
            </Text>
            <Text style={styles.settingsRowDescription}>
              {status.message || (connected
                ? `${status.account || "Google Cloud認証済み"} · STTは録音時に確認します。`
                : "認証ブラウザはRunner Macで開きます。")}
            </Text>
            <TextInput
              style={styles.settingsInlineInput}
              value={projectId}
              onChangeText={setProjectId}
              placeholder="Google Cloud project ID"
              autoCapitalize="none"
              autoCorrect={false}
              editable={status.status !== "authenticating" && !busy}
            />
            <View style={styles.settingsButtonRow}>
              {status.status === "authenticating" ? (
                <TouchableOpacity onPress={() => void run(() => cancelGoogleCloudAuth(runnerUrl, runnerToken))}>
                  <Text style={styles.settingsDangerText}>認証を取消</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.settingsPrimaryButton, busy && styles.buttonDisabled]}
                  disabled={busy}
                  onPress={() => void beginAuth()}
                >
                  <Text style={styles.settingsPrimaryButtonText}>{connected ? "再認証" : "Google Cloudに接続"}</Text>
                </TouchableOpacity>
              )}
              {connected ? (
                <TouchableOpacity
                  disabled={busy}
                  onPress={() => Alert.alert(
                    "接続解除",
                    "Google Cloud TTSとSTTの両方が利用できなくなります。Runner専用の接続だけを解除します。",
                    [
                      { text: "キャンセル", style: "cancel" },
                      { text: "解除", style: "destructive", onPress: () => void run(() => disconnectGoogleCloud(runnerUrl, runnerToken)) },
                    ]
                  )}
                >
                  <Text style={styles.settingsDangerText}>接続解除</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        </View>
        <View style={[styles.settingsInputRow, styles.settingsRowDivider]}>
          <Ionicons name="timer-outline" size={22} color={theme.colors.controlTextPrimary} />
          <View style={styles.settingsInputContent}>
            <Text style={styles.settingsRowLabel}>{usageSummary(status.usage)}</Text>
            <Text style={styles.settingsRowDescription}>
              残り {duration(status.usage?.remainingSeconds || 0)} · 概算 ${usedCost.toFixed(2)} · UTC {status.usage?.resetAt || "--"} リセット
            </Text>
            <View style={styles.settingsButtonRow}>
              <TextInput
                style={[styles.settingsInlineInput, { width: 90 }]}
                value={limitMinutes}
                onChangeText={setLimitMinutes}
                keyboardType="number-pad"
                accessibilityLabel="月間利用上限（分）"
              />
              <Text style={styles.settingsRowDescription}>分/月</Text>
              <TouchableOpacity disabled={busy} onPress={() => void run(save)}>
                <Text style={styles.settingsActionText}>上限を保存</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.settingsRowDescription}>
              Google Cloud STTへ送信した音声の安全側の推定値です。60分は無料枠ではなく、概算上限は$0.96です。
            </Text>
          </View>
        </View>
        <TouchableOpacity
          style={[styles.settingsRow, advancedOpen && styles.settingsRowDivider]}
          onPress={toggleAdvanced}
          accessibilityRole="button"
          accessibilityLabel="Google Cloud STT 詳細設定"
          accessibilityState={{ expanded: advancedOpen }}
        >
          <Ionicons name="options-outline" size={22} color={theme.colors.controlTextPrimary} />
          <View style={styles.settingsRowLabelWrap}>
            <Text style={styles.settingsRowLabel}>詳細設定</Text>
            <Text style={styles.settingsRowDescription}>リージョン: {savedRegion} · 認識モデル: {savedModel}</Text>
          </View>
          <Ionicons name={advancedOpen ? "chevron-up-outline" : "chevron-down-outline"} size={20} color={theme.colors.iconMuted} />
        </TouchableOpacity>
        {advancedOpen ? (
          <>
            <SettingsSelect
              icon="globe-outline"
              label="リージョン"
              options={STT_REGIONS}
              selectedValue={draftRegion}
              onSelect={(region) => selectAdvanced(region, draftModel)}
            />
            <SettingsSelect
              icon="mic-outline"
              label="認識モデル"
              options={STT_MODELS}
              selectedValue={draftModel}
              onSelect={(model) => selectAdvanced(draftRegion, model)}
              showDivider={false}
            />
            <View style={styles.settingsInputRow}>
              <Text style={styles.settingsRowDescription}>選択すると自動保存され、次の録音から反映されます。東京は検証中です。</Text>
            </View>
          </>
        ) : null}
        {actionError ? <Text style={styles.settingsErrorText}>{actionError}</Text> : null}
      </View>
    </View>
  );
}
