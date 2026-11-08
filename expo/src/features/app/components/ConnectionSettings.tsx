import { Ionicons } from "@expo/vector-icons";
import { Platform, Pressable, Switch, Text, TextInput, View } from "react-native";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { effortOptionsForModel } from "../modelOptions";
import { useAppStyles } from "../styles";
import { useVisualTheme } from "../theme/VisualThemeContext";
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
  const styles = useAppStyles();
  const { theme } = useVisualTheme();
  const {
    cloudflareRunnerUrl,
    localRunnerUrl,
    llmBackend,
    modelRef,
    codexApprovalPolicy,
    selectedModelLabel,
    reasoningEffort,
    modelOptions,
    titleModelId,
    titleReasoningEffort,
    selectTitleSettings,
    thinkOptions,
    changeCloudflareRunnerUrl,
    changeLocalRunnerUrl,
    selectCodexApprovalPolicy,
    selectModel,
    selectThinkOption,
    faceIdRequiredForApproval,
    toggleFaceIdRequiredForApproval,
  } = useAppSettings();
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
  const titleModels = modelOptions.filter((option) => option.backendId === "codex" &&
    option.selectable !== false && option.supportsReasoningEffort &&
    (!option.effortOptions || option.effortOptions.length > 0));
  const selectedTitleModel = titleModels.find((option) => option.modelId === titleModelId);
  const titleEfforts = selectedTitleModel
    ? effortOptionsForModel(selectedTitleModel) : (["low"] as const);

  return (
    <>
    <View style={styles.settingsSection}>
      <View style={styles.settingsSectionHeader}>
        <Text style={styles.settingsSectionTitle}>接続</Text>
      </View>

      <Text style={styles.hint}>接続先を変えるとログアウトします。Cloudflare接続はQRを読み直してください。</Text>
      <View style={styles.settingsGroup}>
        <View style={[styles.settingsInputRow, styles.settingsRowDivider]}>
          <Ionicons name="server-outline" size={22} color={theme.colors.controlTextPrimary} />
          <View style={styles.settingsInputContent}>
            <Text style={styles.settingsRowLabel}>ローカルURL</Text>
            <TextInput
              style={styles.settingsInlineInput}
              value={localRunnerUrl}
              onChangeText={changeLocalRunnerUrl}
              accessibilityLabel="ローカルURL"
              placeholder={Platform.OS === "macos" ? "http://127.0.0.1:8788" : "https://mac.local:8789"}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
        </View>

        <View style={[styles.settingsInputRow, styles.settingsRowDivider]}>
          <Ionicons name="cloud-outline" size={22} color={theme.colors.controlTextPrimary} />
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

      </View>
    </View>

    <View style={styles.settingsSection}>
      <View style={styles.settingsSectionHeader}>
        <Text style={styles.settingsSectionTitle}>通常チャット</Text>
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
          <Ionicons name="scan-outline" size={22} color={theme.colors.controlTextPrimary} />
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
    <View style={styles.settingsSection}>
      <View style={styles.settingsSectionHeader}>
        <Text style={styles.settingsSectionTitle}>タイトル生成</Text>
      </View>
      <View style={styles.settingsGroup}>
        <SettingsSelect
          icon="text-outline"
          label="タイトル生成モデル"
          description="新しいチャットの初回送信からタイトルを作成します"
          options={titleModels.map((option) => ({ value: option.modelId, label: option.label }))}
          selectedValue={titleModelId}
          selectedLabel={selectedTitleModel?.label || (titleModelId === "gpt-6-luna" ? "GPT-6 Luna" : titleModelId)}
          onSelect={(modelId) => {
            const model = titleModels.find((option) => option.modelId === modelId);
            const supportedEfforts = effortOptionsForModel(model);
            const effort = supportedEfforts.includes(titleReasoningEffort)
              ? titleReasoningEffort : supportedEfforts[0] || "low";
            selectTitleSettings(modelId, effort);
          }}
        />
        <SettingsSelect
          icon="bulb-outline"
          label="タイトル生成の推論レベル"
          description="選択したモデルに対応する推論レベル"
          options={titleEfforts.map((effort) => ({ value: effort, label: REASONING_LABELS[effort] }))}
          selectedValue={titleReasoningEffort}
          onSelect={(effort) => selectTitleSettings(titleModelId, effort)}
        />
      </View>
    </View>
    </>
  );
}
