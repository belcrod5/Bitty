import { Ionicons } from "@expo/vector-icons";
import { Image, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  FORCED_STT_LANGUAGE,
  STT_PROVIDERS,
  sttProviderLabel,
} from "../../stt/sttConfig";
import { useConversation } from "../contexts/ConversationContext";
import { useDebugSpeech } from "../contexts/DebugSpeechContext";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { styles } from "../styles";
import {
  RECORDING_BIT_RATE_MAX,
  RECORDING_BIT_RATE_MIN,
  RECORDING_PROGRESS_UPDATE_INTERVAL_MAX,
  RECORDING_PROGRESS_UPDATE_INTERVAL_MIN,
  RECORDING_QUALITY_PRESETS,
  RECORDING_SAMPLE_RATE_MAX,
  RECORDING_SAMPLE_RATE_MIN,
  TTS_PROVIDERS,
  recordingQualityPresetHint,
  recordingQualityPresetLabel,
} from "../utils/audioConfig";

export function DebugSpeechControlsPanel() {
  const {
    transcript,
    systemPrompt,
    canSend,
    replyLoading,
    sttLoading,
    setTranscript,
    setSystemPrompt,
    sendReplyRequest,
    sendReplyTranscript,
  } = useConversation();
  const {
    importSettingsJson,
    logSettingsJson,
    clearToolAutoApprovals,
    toolAutoApprovalRuleCount,
    isDirectNativeSttProvider,
    directNativeSttEnabled,
    directNativeSttActive,
    directNativeSttPreviewText,
    startDirectNativeStt,
    stopDirectNativeStt,
    autoRecordingEnabled,
    startAutoRecordingMode,
    stopAutoRecordingMode,
    autoWaveformAnimationEnabled,
    waveformDotGif,
    autoSpeechDetected,
    autoWaveformDebugOverlayEnabled,
    autoWaveformDebugText,
    autoRecordingState,
    autoMeteringDb,
    autoLastEvent,
    autoSegments,
    autoInputName,
    autoAirPodsInput,
    autoClientLogQueuedCount,
    autoClientLogSentCount,
    autoClientLogStatus,
    sendAutoClientLogs,
    clearAutoClientLogs,
    manualRecording,
    startRecording,
    stopRecording,
    recordingUri,
    transcribeRecording,
    recordingSec,
    clearRecordedClip,
  } = useDebugSpeech();
  const {
    runnerUrl,
    runnerToken,
    ttsProvider,
    sttProvider,
    voicesLoading,
    filteredVoices,
    ttsSpeedInput,
    ttsSpeed,
    voiceFilter,
    selectedVoiceId,
    recordingQualityPreset,
    recordingTuning,
    autoTranscribeOnStop,
    autoReplyAfterStt,
    autoBargeInEnabled,
    autoSpeakerPriorityEnabled,
    autoSpeakAfterReply,
    selectTtsProvider,
    selectSttProvider,
    applyRecordingQualityPreset,
    changeRecordingSampleRate,
    changeRecordingBitRate,
    changeRecordingChannels,
    changeRecordingProgressUpdateInterval,
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
  } = useAppSettings();
  return (
    <>
      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.buttonSecondary, voicesLoading && styles.buttonDisabled]}
          onPress={loadVoices}
          disabled={voicesLoading}
        >
          <Text style={styles.buttonText}>{voicesLoading ? "Loading..." : "Load Voices (/voices)"}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.label}>TTS Provider</Text>
      <View style={styles.providerRow}>
        {TTS_PROVIDERS.map((provider) => {
          const selected = ttsProvider === provider;
          return (
            <TouchableOpacity
              key={provider}
              style={[styles.providerButton, selected && styles.providerButtonSelected]}
              onPress={() => selectTtsProvider(provider)}
            >
              <Text style={[styles.providerButtonText, selected && styles.providerButtonTextSelected]}>
                {provider}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.hint}>現在のTTS: {ttsProvider}</Text>
      <Text style={styles.label}>TTS Speed (0.5 - 2.0)</Text>
      <View style={styles.speedRow}>
        <TouchableOpacity style={styles.speedButton} onPress={decreaseTtsSpeed}>
          <Text style={styles.buttonText}>-</Text>
        </TouchableOpacity>
        <TextInput
          style={[styles.input, styles.speedInput]}
          value={ttsSpeedInput}
          onChangeText={changeTtsSpeedInput}
          onBlur={() => commitTtsSpeedInput(ttsSpeedInput)}
          keyboardType="decimal-pad"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={styles.speedButton} onPress={increaseTtsSpeed}>
          <Text style={styles.buttonText}>+</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.hint}>現在の速度: {ttsSpeed.toFixed(1)}</Text>
      <Text style={styles.label}>TTS Voice</Text>
      <TextInput
        style={styles.input}
        value={voiceFilter}
        onChangeText={changeVoiceFilter}
        placeholder="音声名で絞り込み"
      />
      {selectedVoiceId ? (
        <Text style={styles.hint}>選択中 voiceId: {selectedVoiceId}</Text>
      ) : (
        <Text style={styles.hint}>`Load Voices` で音声を取得して選択してください。</Text>
      )}
      {filteredVoices.length > 0 ? (
        <View style={styles.voiceList}>
          <ScrollView style={styles.voiceListScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {filteredVoices.map((voice) => {
              const selected = selectedVoiceId === voice.voiceId;
              return (
                <TouchableOpacity
                  key={voice.voiceId}
                  style={[styles.voiceItem, selected && styles.voiceItemSelected]}
                  onPress={() => selectVoiceId(voice.voiceId)}
                >
                  <Text style={styles.voiceName}>
                    {voice.name || "(no name)"} {voice.category ? `(${voice.category})` : ""}
                  </Text>
                  <Text style={styles.voiceMeta}>{voice.voiceId}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      <Text style={styles.label}>Transcript</Text>
      <Text style={styles.label}>STT Provider</Text>
      <View style={styles.providerRow}>
        {STT_PROVIDERS.map((provider) => {
          const selected = sttProvider === provider;
          return (
            <TouchableOpacity
              key={provider}
              style={[styles.providerButton, selected && styles.providerButtonSelected]}
              onPress={() => selectSttProvider(provider)}
            >
              <Text style={[styles.providerButtonText, selected && styles.providerButtonTextSelected]}>
                {provider}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.hint}>現在のSTT: {sttProviderLabel(sttProvider)}</Text>
      {sttProvider === "ios_native" || sttProvider === "ios_native_direct" ? (
        <Text style={styles.hint}>
          iOS native STT は Expo Development Build が必要です（Expo Goでは利用不可）。
        </Text>
      ) : null}
      {sttProvider === "ios_native_runner" ? (
        <Text style={styles.hint}>
          ios_native_runner は録音後に runner STT で文字起こしします（YouTube再生優先）。
        </Text>
      ) : null}
      {sttProvider === "ios_native_direct" ? (
        <Text style={styles.hint}>
          ios_native_direct は録音ファイルを作らず、マイク入力を直接テキスト化します。
        </Text>
      ) : null}
      <Text style={styles.hint}>STT言語固定: {FORCED_STT_LANGUAGE}</Text>
      <Text style={styles.label}>録音設定</Text>
      <View style={styles.recordingSectionCard}>
        <Text style={styles.recordingSectionTitle}>プリセット</Text>
        {RECORDING_QUALITY_PRESETS.map((preset) => {
          const selected = recordingQualityPreset === preset;
          return (
            <TouchableOpacity
              key={preset}
              style={[styles.recordingRadioRow, selected && styles.recordingRadioRowSelected]}
              onPress={() => applyRecordingQualityPreset(preset)}
            >
              <Ionicons
                name={selected ? "radio-button-on" : "radio-button-off"}
                size={18}
                color={selected ? "#0f766e" : "#64748b"}
              />
              <View style={styles.recordingRadioTextWrap}>
                <Text style={[styles.recordingRadioTitle, selected && styles.recordingRadioTitleSelected]}>
                  {recordingQualityPresetLabel(preset)}
                </Text>
                <Text style={styles.recordingRadioHint}>{recordingQualityPresetHint(preset)}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
        <Text style={styles.hint}>
          現在: {recordingQualityPresetLabel(recordingQualityPreset)} / {recordingTuning.numberOfChannels}ch / {recordingTuning.sampleRate}Hz / {recordingTuning.bitRate}bps
        </Text>
      </View>
      <View style={styles.recordingSectionCard}>
        <Text style={styles.recordingSectionTitle}>詳細（細かく調整）</Text>
        <View style={styles.recordingDetailGrid}>
          <View style={styles.recordingDetailField}>
            <Text style={styles.recordingDetailLabel}>Sample Rate (Hz)</Text>
            <TextInput
              style={[styles.input, styles.recordingDetailInput]}
              value={String(recordingTuning.sampleRate)}
              onChangeText={changeRecordingSampleRate}
              keyboardType="number-pad"
            />
          </View>
          <View style={styles.recordingDetailField}>
            <Text style={styles.recordingDetailLabel}>Bit Rate (bps)</Text>
            <TextInput
              style={[styles.input, styles.recordingDetailInput]}
              value={String(recordingTuning.bitRate)}
              onChangeText={changeRecordingBitRate}
              keyboardType="number-pad"
            />
          </View>
        </View>
        <View style={styles.recordingDetailGrid}>
          <View style={styles.recordingDetailField}>
            <Text style={styles.recordingDetailLabel}>Channels</Text>
            <View style={styles.providerRow}>
              {[1, 2].map((ch) => {
                const selected = recordingTuning.numberOfChannels === ch;
                return (
                  <TouchableOpacity
                    key={`recording-ch-${ch}`}
                    style={[styles.providerButton, selected && styles.providerButtonSelected]}
                    onPress={() => changeRecordingChannels(String(ch))}
                  >
                    <Text style={[styles.providerButtonText, selected && styles.providerButtonTextSelected]}>
                      {ch}ch
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
          <View style={styles.recordingDetailField}>
            <Text style={styles.recordingDetailLabel}>Status Update (ms)</Text>
            <TextInput
              style={[styles.input, styles.recordingDetailInput]}
              value={String(recordingTuning.progressUpdateIntervalMs)}
              onChangeText={changeRecordingProgressUpdateInterval}
              keyboardType="number-pad"
            />
          </View>
        </View>
        <Text style={styles.hint}>
          推奨範囲: sampleRate {RECORDING_SAMPLE_RATE_MIN}-{RECORDING_SAMPLE_RATE_MAX} / bitRate {RECORDING_BIT_RATE_MIN}-{RECORDING_BIT_RATE_MAX} / update {RECORDING_PROGRESS_UPDATE_INTERVAL_MIN}-{RECORDING_PROGRESS_UPDATE_INTERVAL_MAX}ms
        </Text>
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>録音停止後に自動文字起こし</Text>
        <Switch value={autoTranscribeOnStop} onValueChange={toggleAutoTranscribeOnStop} />
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>文字起こし後に自動送信</Text>
        <Switch value={autoReplyAfterStt} onValueChange={toggleAutoReplyAfterStt} />
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>TTS再生中の割り込み発話</Text>
        <Switch value={autoBargeInEnabled} onValueChange={toggleAutoBargeInEnabled} />
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>TTS再生優先（TTS中は録音停止）</Text>
        <Switch value={autoSpeakerPriorityEnabled} onValueChange={toggleAutoSpeakerPriorityEnabled} />
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>返答後に自動音声再生</Text>
        <Switch value={autoSpeakAfterReply} onValueChange={toggleAutoSpeakAfterReply} />
      </View>
      {autoSpeakerPriorityEnabled ? (
        <Text style={styles.hint}>再生優先ON: AirPodsを含め、TTS中は録音を停止します。</Text>
      ) : null}
      <View style={styles.row}>
        <TouchableOpacity style={styles.buttonSecondary} onPress={logSettingsJson}>
          <Text style={styles.buttonText}>Copy Full Settings JSON</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.hint}>接続先、個人パス、セッション設定、自動許可ルールを含みます。</Text>
      <View style={styles.row}>
        <TouchableOpacity style={styles.buttonSecondary} onPress={importSettingsJson}>
          <Text style={styles.buttonText}>Import Settings from Clipboard</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.hint}>設定JSONに含まれるすべての端末設定を復元します。</Text>
      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.buttonSecondary, toolAutoApprovalRuleCount === 0 && styles.buttonDisabled]}
          onPress={clearToolAutoApprovals}
          disabled={toolAutoApprovalRuleCount === 0}
        >
          <Text style={styles.buttonText}>自動許可ルールをクリア</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.hint}>自動許可ルール数: {toolAutoApprovalRuleCount}</Text>
      <View style={styles.row}>
        <TouchableOpacity
          style={[
            styles.buttonSecondary,
            (isDirectNativeSttProvider ? directNativeSttEnabled : autoRecordingEnabled)
              ? styles.buttonDanger
              : null,
          ]}
          onPress={() => {
              if (isDirectNativeSttProvider) {
                if (directNativeSttEnabled) {
                  stopDirectNativeStt();
                } else {
                  startDirectNativeStt();
                }
                return;
              }
              if (autoRecordingEnabled) {
                stopAutoRecordingMode();
              } else {
                startAutoRecordingMode();
              }
            }}
          disabled={
            isDirectNativeSttProvider
              ? (replyLoading || (sttLoading && !directNativeSttEnabled))
              : (sttLoading || replyLoading)
          }
        >
          <Text style={styles.buttonText}>
            {isDirectNativeSttProvider
              ? (directNativeSttEnabled ? "Stop Direct STT" : "Start Direct STT")
              : (autoRecordingEnabled ? "Stop Auto Recording" : "Start Auto Recording")}
          </Text>
        </TouchableOpacity>
      </View>
      {isDirectNativeSttProvider ? (
        <View style={styles.autoWaveformCard}>
          <View style={styles.directSttDebugCard}>
            <Text style={styles.directSttDebugTitle}>
              {directNativeSttActive ? "listening" : (directNativeSttEnabled ? "waiting" : "idle")}
            </Text>
            <Text style={styles.directSttDebugBody}>
              {directNativeSttPreviewText || "話すと途中テキストがここに表示されます。"}
            </Text>
          </View>
        </View>
      ) : (
        <>
          <View style={styles.autoWaveformCard}>
            {autoWaveformAnimationEnabled ? (
              <Image
                source={waveformDotGif}
                style={[styles.autoWaveformGif, autoSpeechDetected && styles.autoWaveformGifActive]}
              />
            ) : (
              <View
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 999,
                  backgroundColor: autoSpeechDetected ? "#22c55e" : "#94a3b8",
                  opacity: autoSpeechDetected ? 1 : 0.6,
                }}
              />
            )}
            {autoWaveformDebugOverlayEnabled ? (
              <View pointerEvents="none" style={styles.autoWaveformDebugOverlay}>
                <Text style={styles.autoWaveformDebugOverlayText}>{autoWaveformDebugText}</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.hint}>
            Auto状態: {autoRecordingState}
            {autoMeteringDb !== null ? ` / meter ${autoMeteringDb.toFixed(1)}dB` : ""}
          </Text>
          <Text style={styles.hint}>Autoイベント: {autoLastEvent || "-"}</Text>
          <Text style={styles.hint}>Auto確定セグメント: {autoSegments}</Text>
          <Text style={styles.hint}>
            Auto入力: {autoInputName || "-"} / AirPods判定: {autoAirPodsInput ? "ON" : "OFF"}
          </Text>
          <Text style={styles.hint}>
            Autoログ: queued {autoClientLogQueuedCount} / sent {autoClientLogSentCount} / status {autoClientLogStatus}
          </Text>
        </>
      )}
      <View style={styles.row}>
        <TouchableOpacity
          style={[
            styles.buttonSecondary,
            (!runnerUrl.trim() || !runnerToken.trim() || autoClientLogQueuedCount <= 0) && styles.buttonDisabled,
          ]}
          onPress={sendAutoClientLogs}
          disabled={!runnerUrl.trim() || !runnerToken.trim() || autoClientLogQueuedCount <= 0}
        >
          <Text style={styles.buttonText}>Autoログ送信</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.buttonSecondary, autoClientLogQueuedCount <= 0 && styles.buttonDisabled]}
          onPress={clearAutoClientLogs}
          disabled={autoClientLogQueuedCount <= 0}
        >
          <Text style={styles.buttonText}>Autoログクリア</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.buttonSecondary, manualRecording ? styles.buttonDanger : null]}
          onPress={manualRecording ? stopRecording : startRecording}
          disabled={sttLoading || replyLoading || autoRecordingEnabled || directNativeSttEnabled}
        >
          <Text style={styles.buttonText}>{manualRecording ? "Stop Recording" : "Start Recording"}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.buttonSecondary,
            (!recordingUri || sttLoading || sttProvider === "ios_native_direct") && styles.buttonDisabled,
          ]}
          onPress={transcribeRecording}
          disabled={!recordingUri || sttLoading || sttProvider === "ios_native_direct"}
        >
          <Text style={styles.buttonText}>
            {sttProvider === "ios_native_direct"
              ? "direct modeでは不要"
              : (sttLoading ? "Transcribing..." : "録音を文字起こし")}
          </Text>
        </TouchableOpacity>
      </View>
      {sttProvider === "ios_native_direct" ? (
        <Text style={styles.hint}>direct modeは録音せず、入力中テキストをそのまま表示します。</Text>
      ) : recordingUri ? (
        <Text style={styles.hint}>録音済み: {recordingSec}s</Text>
      ) : (
        <Text style={styles.hint}>録音後に「録音を文字起こし」で transcript を反映します。</Text>
      )}
      {recordingUri ? (
        <TouchableOpacity style={styles.clearButton} onPress={clearRecordedClip}>
          <Text style={styles.clearButtonText}>録音をクリア</Text>
        </TouchableOpacity>
      ) : null}

      <TextInput
        style={[styles.input, styles.multiline]}
        value={transcript}
        onChangeText={setTranscript}
        multiline
        textAlignVertical="top"
      />

      <Text style={styles.label}>System Prompt (optional)</Text>
      <TextInput
        style={[styles.input, styles.multilineSmall]}
        value={systemPrompt}
        onChangeText={setSystemPrompt}
        multiline
        textAlignVertical="top"
      />

      <TouchableOpacity
        style={[styles.button, !canSend && styles.buttonDisabled]}
        onPress={sendReplyRequest}
        disabled={!canSend}
      >
        <Text style={styles.buttonText}>{replyLoading ? "Sending..." : "Send (Codex WS)"}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.buttonSecondary, !canSend && styles.buttonDisabled]}
        onPress={sendReplyTranscript}
        disabled={!canSend}
      >
        <Text style={styles.buttonText}>{replyLoading ? "Sending..." : "Send Transcript"}</Text>
      </TouchableOpacity>
    </>
  );
}
