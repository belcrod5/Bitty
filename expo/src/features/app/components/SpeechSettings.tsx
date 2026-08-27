import { Ionicons } from "@expo/vector-icons";
import { Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { FORCED_STT_LANGUAGE, STT_PROVIDERS, sttProviderLabel } from "../../stt/sttConfig";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { styles } from "../styles";
import {
  RECORDING_QUALITY_PRESETS,
  TTS_PROVIDERS,
  recordingQualityPresetHint,
  recordingQualityPresetLabel,
} from "../utils/audioConfig";
import { SettingsSelect } from "./SettingsSelect";

const TTS_PROVIDER_LABELS = {
  elevenlabs: "ElevenLabs",
  google: "Google",
  aivisspeech: "AivisSpeech",
} as const;

const SETTING_ICONS = [
  "document-text-outline",
  "paper-plane-outline",
  "mic-outline",
  "volume-mute-outline",
  "volume-high-outline",
] as const;

export function SpeechSettings() {
  const {
    ttsProvider,
    sttProvider,
    voicesLoading,
    filteredVoices,
    ttsSpeedInput,
    ttsSpeed,
    voiceFilter,
    selectedVoiceId,
    recordingQualityPreset,
    autoTranscribeOnStop,
    autoReplyAfterStt,
    autoBargeInEnabled,
    autoSpeakerPriorityEnabled,
    autoSpeakAfterReply,
    toolAutoApprovalRuleCount,
    selectTtsProvider,
    selectSttProvider,
    applyRecordingQualityPreset,
    loadVoices,
    changeTtsSpeedInput,
    commitTtsSpeedInput,
    decreaseTtsSpeed,
    increaseTtsSpeed,
    changeVoiceFilter,
    selectVoiceId,
    toggleAutoTranscribeOnStop,
    toggleAutoReplyAfterStt,
    toggleAutoBargeInEnabled,
    toggleAutoSpeakerPriorityEnabled,
    toggleAutoSpeakAfterReply,
    exportSettingsJson,
    importSettingsJson,
    clearToolAutoApprovals,
  } = useAppSettings();

  const behaviorSettings = [
    { label: "録音停止後に文字起こし", value: autoTranscribeOnStop, onChange: toggleAutoTranscribeOnStop },
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
  const sttOptions = STT_PROVIDERS.map((provider) => ({
    value: provider,
    label: sttProviderLabel(provider),
  }));
  const recordingOptions = RECORDING_QUALITY_PRESETS.map((preset) => ({
    value: preset,
    label: recordingQualityPresetLabel(preset),
    description: recordingQualityPresetHint(preset),
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
            <Ionicons name="speedometer-outline" size={22} color="#111827" />
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
                <Ionicons name="remove" size={18} color="#0a84ff" />
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
                <Ionicons name="add" size={18} color="#0a84ff" />
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
          <SettingsSelect
            icon="text-outline"
            label="文字起こしサービス"
            description={`言語: ${FORCED_STT_LANGUAGE}`}
            options={sttOptions}
            selectedValue={sttProvider}
            onSelect={selectSttProvider}
          />
          <SettingsSelect
            icon="options-outline"
            label="録音品質"
            options={recordingOptions}
            selectedValue={recordingQualityPreset}
            onSelect={applyRecordingQualityPreset}
            showDivider={false}
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
              <Ionicons name={SETTING_ICONS[index]} size={22} color="#111827" />
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
            <Ionicons name="copy-outline" size={22} color="#0a84ff" />
            <Text style={[styles.settingsActionText, styles.settingsRowLabelWrap]}>設定をクリップボードへ書き出す</Text>
            <Ionicons name="chevron-forward" size={18} color="#c7c7cc" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.settingsRow, styles.settingsRowDivider]}
            onPress={importSettingsJson}
            accessibilityRole="button"
          >
            <Ionicons name="download-outline" size={22} color="#0a84ff" />
            <Text style={[styles.settingsActionText, styles.settingsRowLabelWrap]}>クリップボードから設定を読み込む</Text>
            <Ionicons name="chevron-forward" size={18} color="#c7c7cc" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.settingsRow, toolAutoApprovalRuleCount === 0 && styles.buttonDisabled]}
            onPress={clearToolAutoApprovals}
            disabled={toolAutoApprovalRuleCount === 0}
            accessibilityRole="button"
            accessibilityState={{ disabled: toolAutoApprovalRuleCount === 0 }}
          >
            <Ionicons name="trash-outline" size={22} color="#ff3b30" />
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
