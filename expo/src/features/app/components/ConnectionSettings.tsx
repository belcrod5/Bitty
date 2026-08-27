import { Ionicons } from "@expo/vector-icons";
import { Switch, Text, TextInput, View } from "react-native";
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
    runnerUrl,
    llmBackend,
    modelRef,
    runnerToken,
    codexApprovalPolicy,
    selectedModelLabel,
    reasoningEffort,
    modelOptions,
    thinkOptions,
    changeRunnerUrl,
    changeRunnerToken,
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

  return (
    <View style={styles.settingsSection}>
      <View style={styles.settingsSectionHeader}>
        <Text style={styles.settingsSectionTitle}>接続とエージェント</Text>
      </View>

      <View style={styles.settingsGroup}>
        <View style={[styles.settingsInputRow, styles.settingsRowDivider]}>
          <Ionicons name="server-outline" size={22} color="#111827" />
          <View style={styles.settingsInputContent}>
            <Text style={styles.settingsRowLabel}>Runner URL</Text>
            <TextInput
              style={styles.settingsInlineInput}
              value={runnerUrl}
              onChangeText={changeRunnerUrl}
              accessibilityLabel="Runner URL"
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
              value={runnerToken}
              onChangeText={changeRunnerToken}
              accessibilityLabel="Runnerトークン"
              placeholder="Runner token"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
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
