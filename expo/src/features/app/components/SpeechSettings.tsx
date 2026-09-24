import { Ionicons } from "@expo/vector-icons";
import { Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useAppStyles } from "../styles";
import { useVisualTheme } from "../theme/VisualThemeContext";
import {
  TTS_PROVIDERS,
} from "../utils/audioConfig";
import { SettingsSelect } from "./SettingsSelect";

const TTS_PROVIDER_LABELS = {
  elevenlabs: "ElevenLabs",
  google: "Google",
  aivisspeech: "AivisSpeech",
} as const;

const SETTING_ICONS = [
  "paper-plane-outline",
  "volume-mute-outline",
  "volume-high-outline",
] as const;

export function SpeechSettings() {
  const styles = useAppStyles();
  const { theme } = useVisualTheme();
  const {
    ttsProvider,
    voicesLoading,
    filteredVoices,
    ttsSpeedInput,
    ttsSpeed,
    voiceFilter,
    selectedVoiceId,
    autoReplyAfterStt,
    autoBargeInEnabled,
    autoSpeakerPriorityEnabled,
    autoSpeakAfterReply,
    toolAutoApprovalRuleCount,
    selectTtsProvider,
    loadVoices,
    changeTtsSpeedInput,
    commitTtsSpeedInput,
    decreaseTtsSpeed,
    increaseTtsSpeed,
    changeVoiceFilter,
    selectVoiceId,
    toggleAutoReplyAfterStt,
    toggleAutoBargeInEnabled,
    toggleAutoSpeakerPriorityEnabled,
    toggleAutoSpeakAfterReply,
    exportSettingsJson,
    importSettingsJson,
    clearToolAutoApprovals,
  } = useAppSettings();

  const behaviorSettings = [
    { label: "文字起こし後に送信", value: autoReplyAfterStt, onChange: toggleAutoReplyAfterStt },
    { label: "再生中の割り込み発話", value: autoBargeInEnabled, onChange: toggleAutoBargeInEnabled },
    { label: "再生中は録音を停止", value: autoSpeakerPriorityEnabled, onChange: toggleAutoSpeakerPriorityEnabled },
    { label: "返答後に読み上げ", value: autoSpeakAfterReply, onChange: toggleAutoSpeakAfterReply },
  ];
  const ttsOptions = TTS_PROVIDERS.map((provider) => ({
    value: provider,
    label: TTS_PROVIDER_LABELS[provider],
  }));
  const voiceOptions = filteredVoices.map((voice) => ({
    value: voice.voiceId,
    label: voice.name || "名称なし",
    description: voice.voiceId,
  }));

  return (
    <>
      <View style={styles.settingsSection}>
        <View style={styles.settingsSectionHeader}>
          <Text style={styles.settingsSectionTitle}>音声</Text>
        </View>

        <View style={styles.settingsGroup}>
          <SettingsSelect
            icon="headset-outline"
            label="読み上げサービス"
            options={ttsOptions}
            selectedValue={ttsProvider}
            onSelect={selectTtsProvider}
          />

          <View style={[styles.settingsRow, styles.settingsRowDivider]}>
            <Ionicons name="speedometer-outline" size={22} color={theme.colors.controlTextPrimary} />
            <View style={styles.settingsRowLabelWrap}>
              <Text style={styles.settingsRowLabel}>読み上げ速度</Text>
              <Text style={styles.settingsRowDescription}>0.5〜2.0（現在 {ttsSpeed.toFixed(1)}）</Text>
            </View>
            <View style={styles.settingsStepper}>
              <TouchableOpacity
                style={styles.settingsStepperButton}
                onPress={decreaseTtsSpeed}
                accessibilityRole="button"
                accessibilityLabel="速度を下げる"
              >
                <Ionicons name="remove" size={18} color={theme.colors.controlAccent} />
              </TouchableOpacity>
              <TextInput
                style={styles.settingsStepperInput}
                value={ttsSpeedInput}
                onChangeText={changeTtsSpeedInput}
                onBlur={() => commitTtsSpeedInput(ttsSpeedInput)}
                keyboardType="decimal-pad"
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="読み上げ速度"
              />
              <TouchableOpacity
                style={styles.settingsStepperButton}
                onPress={increaseTtsSpeed}
                accessibilityRole="button"
                accessibilityLabel="速度を上げる"
              >
                <Ionicons name="add" size={18} color={theme.colors.controlAccent} />
              </TouchableOpacity>
            </View>
          </View>

          <SettingsSelect
            icon="person-circle-outline"
            label="声"
            options={voiceOptions}
            selectedValue={selectedVoiceId}
            onSelect={selectVoiceId}
            placeholder="未選択"
            loading={voicesLoading}
            searchValue={voiceFilter}
            onSearchChange={changeVoiceFilter}
            searchPlaceholder="声の名前で検索"
            onOpen={loadVoices}
          />
        </View>
      </View>

      <View style={styles.settingsSection}>
        <View style={styles.settingsSectionHeader}>
          <Text style={styles.settingsSectionTitle}>音声の動作</Text>
        </View>
        <View style={styles.settingsGroup}>
          {behaviorSettings.map(({ label, value, onChange }, index) => (
            <View
              style={[styles.settingsRow, index < behaviorSettings.length - 1 && styles.settingsRowDivider]}
              key={label}
            >
              <Ionicons name={SETTING_ICONS[index]} size={22} color={theme.colors.controlTextPrimary} />
              <Text style={[styles.settingsRowLabel, styles.settingsRowLabelWrap]}>{label}</Text>
              <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
            </View>
          ))}
        </View>
      </View>

      <View style={styles.settingsSection}>
        <View style={styles.settingsSectionHeader}>
          <Text style={styles.settingsSectionTitle}>設定の移行と承認ルール</Text>
        </View>
        <View style={styles.settingsGroup}>
          <TouchableOpacity
            style={[styles.settingsRow, styles.settingsRowDivider]}
            onPress={exportSettingsJson}
            accessibilityRole="button"
          >
            <Ionicons name="copy-outline" size={22} color={theme.colors.controlAccent} />
            <Text style={[styles.settingsActionText, styles.settingsRowLabelWrap]}>設定をクリップボードへ書き出す</Text>
            <Ionicons name="chevron-forward" size={18} color={theme.colors.disclosure} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.settingsRow, styles.settingsRowDivider]}
            onPress={importSettingsJson}
            accessibilityRole="button"
          >
            <Ionicons name="download-outline" size={22} color={theme.colors.controlAccent} />
            <Text style={[styles.settingsActionText, styles.settingsRowLabelWrap]}>クリップボードから設定を読み込む</Text>
            <Ionicons name="chevron-forward" size={18} color={theme.colors.disclosure} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.settingsRow, toolAutoApprovalRuleCount === 0 && styles.buttonDisabled]}
            onPress={clearToolAutoApprovals}
            disabled={toolAutoApprovalRuleCount === 0}
            accessibilityRole="button"
            accessibilityState={{ disabled: toolAutoApprovalRuleCount === 0 }}
          >
            <Ionicons name="trash-outline" size={22} color={theme.colors.controlDanger} />
            <Text style={[styles.settingsDangerText, styles.settingsRowLabelWrap]}>
              保存済み承認ルールを削除（{toolAutoApprovalRuleCount}件）
            </Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.settingsFooterText}>
          認証トークン、Cloudflare認証情報、保存済み承認ルールは移行に含まれません。移行先で再設定してください。
        </Text>
      </View>
    </>
  );
}
