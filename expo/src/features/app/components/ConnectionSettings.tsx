import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Switch, Text, TextInput, View } from "react-native";
import * as Clipboard from "../clipboard";
import { tokenFingerprint, tokenLength } from "../../ws/tokenFingerprint";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { styles } from "../styles";
import { SettingsSelect } from "./SettingsSelect";

const APPROVAL_OPTIONS = [
  { value: "on-request", label: "必要時に確認" },
  { value: "never", label: "確認しない" },
] as const;

const REASONING_LABELS = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "非常に高い",
  max: "最大",
  ultra: "Ultra",
} as const;

export function ConnectionSettings() {
  const {
    cloudflareRunnerUrl,
    localRunnerUrl,
    llmBackend,
    modelRef,
    runnerToken,
    codexApprovalPolicy,
    selectedModelLabel,
    reasoningEffort,
    modelOptions,
    thinkOptions,
    changeCloudflareRunnerUrl,
    changeLocalRunnerUrl,
    saveRunnerToken,
    selectCodexApprovalPolicy,
    selectModel,
    selectThinkOption,
    faceIdRequiredForApproval,
    toggleFaceIdRequiredForApproval,
  } = useAppSettings();
  const [runnerTokenDraft, setRunnerTokenDraft] = useState(runnerToken);
  const [runnerTokenSaving, setRunnerTokenSaving] = useState(false);
  const [runnerTokenStatus, setRunnerTokenStatus] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    setRunnerTokenDraft(runnerToken);
  }, [runnerToken]);

  // macOSではTextInputへの⌘V貼り付けがdraftへ反映されないことがある(RN macOSの
  // 既知不具合領域)。クリップボードを直接読むこのボタンがtoken入力の正攻法。
  const pasteRunnerTokenFromClipboard = async () => {
    setRunnerTokenStatus(null);
    try {
      const value = String(await Clipboard.getStringAsync() || "").trim();
      if (!value) {
        setRunnerTokenStatus({ kind: "error", message: "クリップボードが空です。" });
        return;
      }
      setRunnerTokenDraft(value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setRunnerTokenStatus({ kind: "error", message: `クリップボードを読めませんでした。${detail ? ` (${detail})` : ""}` });
    }
  };

  const commitRunnerToken = async () => {
    setRunnerTokenSaving(true);
    setRunnerTokenStatus(null);
    try {
      await saveRunnerToken(runnerTokenDraft);
      setRunnerTokenStatus({ kind: "success", message: "保存を確認し、接続に反映しました。" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = detail.includes("secure_credentials_readback_mismatch")
        ? "保存後の読み戻し結果が一致しません。接続トークンは変更していません。"
        : detail.includes("secure_credentials_rollback_failed")
          ? "保存に失敗し、以前のキーチェーン値も復元できませんでした。アプリを再起動せず、再度保存してください。"
          : detail === "runner_token_required"
            ? "Runnerトークンを入力してください。"
            : `キーチェーンへの保存に失敗しました。接続トークンは変更していません。${detail ? ` (${detail})` : ""}`;
      setRunnerTokenStatus({ kind: "error", message });
    } finally {
      setRunnerTokenSaving(false);
    }
  };

  const selectableModels = modelOptions
    .filter((option) => option.selectable !== false)
    .map((option) => ({ value: option.selectionKey, label: option.label }));
  const selectedModel = modelOptions.find(
    (option) => option.backendId === llmBackend && option.modelId === modelRef,
  );
  const selectedModelKey = selectedModel?.selectionKey ?? (`${llmBackend}::${modelRef}` as const);
  const reasoningOptions = thinkOptions.map((effort) => ({
    value: effort,
    label: REASONING_LABELS[effort],
  }));

  return (
    <View style={styles.settingsSection}>
      <View style={styles.settingsSectionHeader}>
        <Text style={styles.settingsSectionTitle}>接続とエージェント</Text>
      </View>

      <View style={styles.settingsGroup}>
        <View style={[styles.settingsInputRow, styles.settingsRowDivider]}>
          <Ionicons name="server-outline" size={22} color="#111827" />
          <View style={styles.settingsInputContent}>
            <Text style={styles.settingsRowLabel}>ローカルURL</Text>
            <TextInput
              style={styles.settingsInlineInput}
              value={localRunnerUrl}
              onChangeText={changeLocalRunnerUrl}
              accessibilityLabel="ローカルURL"
              placeholder="http://mac.local:8788"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
        </View>

        <View style={[styles.settingsInputRow, styles.settingsRowDivider]}>
          <Ionicons name="cloud-outline" size={22} color="#111827" />
          <View style={styles.settingsInputContent}>
            <Text style={styles.settingsRowLabel}>Cloudflare経由URL</Text>
            <TextInput
              style={styles.settingsInlineInput}
              value={cloudflareRunnerUrl}
              onChangeText={changeCloudflareRunnerUrl}
              accessibilityLabel="Cloudflare経由URL"
              placeholder="https://runner.example.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
        </View>

        <View style={styles.settingsInputRow}>
          <Ionicons name="shield-checkmark-outline" size={22} color="#111827" />
          <View style={styles.settingsInputContent}>
            <Text style={styles.settingsRowLabel}>Runnerトークン</Text>
            <TextInput
              style={styles.settingsInlineInput}
              value={runnerTokenDraft}
              onChangeText={(value) => {
                setRunnerTokenDraft(value);
                setRunnerTokenStatus(null);
              }}
              accessibilityLabel="Runnerトークン"
              placeholder="Runner token"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              editable={!runnerTokenSaving}
            />
            <Text style={styles.runnerTokenFingerprintText}>
              {runnerTokenDraft.trim()
                ? `入力中: ${tokenLength(runnerTokenDraft)}文字・指紋 ${tokenFingerprint(runnerTokenDraft)}`
                : "入力中: なし"}
              {`  /  保存済み: ${runnerToken.trim() ? `指紋 ${tokenFingerprint(runnerToken)}` : "なし"}`}
            </Text>
            <View style={styles.runnerTokenButtonRow}>
              <Pressable
                style={[styles.runnerTokenPasteButton, runnerTokenSaving && styles.buttonDisabled]}
                onPress={() => void pasteRunnerTokenFromClipboard()}
                disabled={runnerTokenSaving}
                accessibilityRole="button"
                accessibilityLabel="クリップボードからRunnerトークンを貼り付け"
              >
                <Text style={styles.runnerTokenPasteButtonText}>クリップボードから貼り付け</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.runnerTokenSaveButton,
                  (!runnerTokenDraft.trim() || runnerTokenSaving) && styles.buttonDisabled,
                ]}
                onPress={() => void commitRunnerToken()}
                disabled={!runnerTokenDraft.trim() || runnerTokenSaving}
                accessibilityRole="button"
                accessibilityLabel="Runnerトークンを保存して接続"
              >
                {runnerTokenSaving ? <ActivityIndicator size="small" color="#ffffff" /> : null}
                <Text style={styles.runnerTokenSaveButtonText}>
                  {runnerTokenSaving ? "保存中" : "保存して接続"}
                </Text>
              </Pressable>
            </View>
            {runnerTokenStatus ? (
              <Text
                style={runnerTokenStatus.kind === "error" ? styles.runnerTokenErrorText : styles.runnerTokenSuccessText}
                accessibilityRole="alert"
              >
                {runnerTokenStatus.message}
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      <View style={styles.settingsGroup}>
        <SettingsSelect
          icon="cube-outline"
          label="モデル"
          options={selectableModels}
          selectedValue={selectedModelKey}
          selectedLabel={selectedModelLabel}
          onSelect={selectModel}
        />
        <SettingsSelect
          icon="bulb-outline"
          label="推論レベル"
          options={reasoningOptions}
          selectedValue={reasoningEffort}
          onSelect={selectThinkOption}
        />
        <SettingsSelect
          icon="checkmark-circle-outline"
          label="承認ポリシー"
          options={APPROVAL_OPTIONS}
          selectedValue={codexApprovalPolicy}
          onSelect={selectCodexApprovalPolicy}
        />
        <View style={styles.settingsRow}>
          <Ionicons name="scan-outline" size={22} color="#111827" />
          <View style={styles.settingsRowLabelWrap}>
            <Text style={styles.settingsRowLabel}>承認時にFace IDを要求</Text>
            <Text style={styles.settingsRowDescription}>ツール実行の確認をこの端末で保護</Text>
          </View>
          <Switch
            value={faceIdRequiredForApproval}
            onValueChange={toggleFaceIdRequiredForApproval}
            accessibilityLabel="承認時にFace IDを要求"
          />
        </View>
      </View>
    </View>
  );
}
