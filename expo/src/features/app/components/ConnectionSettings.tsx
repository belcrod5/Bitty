import { Ionicons } from "@expo/vector-icons";
import { useCallback } from "react";
import { Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { styles } from "../styles";
import {
  suggestCodexWsUrlFromRunnerUrl,
  suggestRunnerWsUrlFromRunnerUrl,
} from "../utils/urlResolvers";
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
    codexWsUrl,
    codexWsToken,
    runnerToken,
    codexApprovalPolicy,
    selectedModelLabel,
    reasoningEffort,
    modelOptions,
    thinkOptions,
    changeRunnerUrl,
    changeCodexWsUrl,
    changeCodexWsToken,
    changeRunnerToken,
    selectCodexApprovalPolicy,
    selectModel,
    selectThinkOption,
    faceIdRequiredForApproval,
    toggleFaceIdRequiredForApproval,
  } = useAppSettings();

  const codexRouteUrl = suggestCodexWsUrlFromRunnerUrl(runnerUrl);
  const runnerRouteUrl = suggestRunnerWsUrlFromRunnerUrl(runnerUrl);
  const normalizedCodexWsUrl = codexWsUrl.trim().replace(/\/$/, "");
  const codexRouteSelected = Boolean(codexRouteUrl) && normalizedCodexWsUrl === codexRouteUrl;
  const runnerRouteSelected = Boolean(runnerRouteUrl) && normalizedCodexWsUrl === runnerRouteUrl;

  const applyCodexWsRoute = useCallback(() => {
    if (codexRouteUrl) changeCodexWsUrl(codexRouteUrl);
  }, [changeCodexWsUrl, codexRouteUrl]);

  const applyRunnerWsRoute = useCallback(() => {
    if (runnerRouteUrl) changeCodexWsUrl(runnerRouteUrl);
  }, [changeCodexWsUrl, runnerRouteUrl]);

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

        <View style={[styles.settingsInputRow, styles.settingsRowDivider]}>
          <Ionicons name="git-network-outline" size={22} color="#111827" />
          <View style={styles.settingsInputContent}>
            <Text style={styles.settingsRowLabel}>Codex WebSocket URL</Text>
            <TextInput
              style={styles.settingsInlineInput}
              value={codexWsUrl}
              onChangeText={changeCodexWsUrl}
              accessibilityLabel="Codex WebSocket URL"
              placeholder="wss://runner.example.com/runner-ws"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <View style={styles.settingsRouteActions}>
              <TouchableOpacity
                style={[
                  styles.settingsCompactButton,
                  codexRouteSelected && styles.settingsCompactButtonSelected,
                ]}
                onPress={applyCodexWsRoute}
                accessibilityRole="button"
                accessibilityState={{ selected: codexRouteSelected }}
              >
                <Text
                  style={[
                    styles.settingsCompactButtonText,
                    codexRouteSelected && styles.settingsCompactButtonTextSelected,
                  ]}
                >
                  Codex経路
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.settingsCompactButton,
                  runnerRouteSelected && styles.settingsCompactButtonSelected,
                ]}
                onPress={applyRunnerWsRoute}
                accessibilityRole="button"
                accessibilityState={{ selected: runnerRouteSelected }}
              >
                <Text
                  style={[
                    styles.settingsCompactButtonText,
                    runnerRouteSelected && styles.settingsCompactButtonTextSelected,
                  ]}
                >
                  Runner経路
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <View style={[styles.settingsInputRow, styles.settingsRowDivider]}>
          <Ionicons name="key-outline" size={22} color="#111827" />
          <View style={styles.settingsInputContent}>
            <Text style={styles.settingsRowLabel}>Codexトークン（任意）</Text>
            <TextInput
              style={styles.settingsInlineInput}
              value={codexWsToken}
              onChangeText={changeCodexWsToken}
              accessibilityLabel="Codexトークン"
              placeholder="Bearer token"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
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
