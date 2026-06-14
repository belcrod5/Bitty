import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useAppShell } from "../contexts/AppShellContext";
import { useAudioLab } from "../contexts/AudioLabContext";
import { styles } from "../styles";

export function AudioLabScreen() {
  const {
  audioLabFlatlineDb,
  audioLabRunning,
  audioLabRecordingActive,
  audioLabPlaybackActive,
  audioLabInputName,
  audioLabAirPodsInput,
  audioLabElapsedMs,
  audioLabCallbackIntervalMs,
  audioLabLastDb,
  audioLabMinDb,
  audioLabMaxDb,
  audioLabFlatlineMs,
  audioLabPlaybackPositionMs,
  audioLabPlaybackStallMs,
  audioLabLoopCount,
  audioLabUnexpectedStopCount,
  audioLabPlaybackRecoverCount,
  audioLabLogQueuedCount,
  audioLabLogSentCount,
  audioLabLogStatus,
  audioLabRecentLogs,
  audioLabLogSendDisabled,
  errorMessage,
  startProbe,
  stopProbe,
  startPlaybackOnly,
  stopPlaybackOnly,
  sendLogs,
  clearLogs,
} = useAudioLab();
  const { openDebugScreen } = useAppShell();
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.debugHeaderRow}>
        <TouchableOpacity style={styles.debugBackButton} onPress={openDebugScreen}>
          <Text style={styles.debugBackButtonText}>← Debug</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.title}>Audio Lab (Playback + Recording)</Text>
      <Text style={styles.hint}>
        ローカル音源をループ再生しながら録音し、経路・metering・callback間隔を可視化します。
      </Text>

      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.buttonSecondary, audioLabRunning && styles.buttonDisabled]}
          onPress={startProbe}
          disabled={audioLabRunning}
        >
          <Text style={styles.buttonText}>{audioLabRunning ? "Running..." : "同時テスト開始"}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.buttonSecondary, !audioLabRunning && styles.buttonDisabled]}
          onPress={stopProbe}
          disabled={!audioLabRunning}
        >
          <Text style={styles.buttonText}>同時テスト停止</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.row}>
        <TouchableOpacity
          style={[
            styles.buttonSecondary,
            (!audioLabRunning || audioLabPlaybackActive) && styles.buttonDisabled,
          ]}
          onPress={startPlaybackOnly}
          disabled={!audioLabRunning || audioLabPlaybackActive}
        >
          <Text style={styles.buttonText}>再生のみ開始（復帰）</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.buttonSecondary, !audioLabPlaybackActive && styles.buttonDisabled]}
          onPress={stopPlaybackOnly}
          disabled={!audioLabPlaybackActive}
        >
          <Text style={styles.buttonText}>再生のみ停止（割り込み模擬）</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.audioLabCard}>
        <Text style={styles.audioLabLine}>
          状態: {audioLabRunning ? "running" : "idle"} / 録音: {audioLabRecordingActive ? "on" : "off"} / 再生:{" "}
          {audioLabPlaybackActive ? "on" : "off"}
        </Text>
        <Text style={styles.audioLabLine}>
          入力: {audioLabInputName || "-"} / AirPods判定: {audioLabAirPodsInput ? "ON" : "OFF"}
        </Text>
        <Text style={styles.audioLabLine}>
          経過: {audioLabElapsedMs}ms / callback間隔:{" "}
          {audioLabCallbackIntervalMs !== null ? `${audioLabCallbackIntervalMs}ms` : "-"}
        </Text>
        <Text style={styles.audioLabLine}>
          meter: last {audioLabLastDb !== null ? `${audioLabLastDb.toFixed(1)}dB` : "-"} / min{" "}
          {audioLabMinDb !== null ? `${audioLabMinDb.toFixed(1)}dB` : "-"} / max{" "}
          {audioLabMaxDb !== null ? `${audioLabMaxDb.toFixed(1)}dB` : "-"}
        </Text>
        <Text style={styles.audioLabLine}>
          flatline (≤{audioLabFlatlineDb}dB): {audioLabFlatlineMs}ms
        </Text>
        <Text style={styles.audioLabLine}>
          再生位置: {audioLabPlaybackPositionMs}ms / stall: {audioLabPlaybackStallMs}ms
        </Text>
        <Text style={styles.audioLabLine}>
          loop: {audioLabLoopCount} / unexpectedStop: {audioLabUnexpectedStopCount} / recover:{" "}
          {audioLabPlaybackRecoverCount}
        </Text>
      </View>

      <Text style={styles.hint}>
        活ログ: queued {audioLabLogQueuedCount} / sent {audioLabLogSentCount} / status {audioLabLogStatus}
      </Text>
      <View style={styles.row}>
        <TouchableOpacity
          style={[
            styles.buttonSecondary,
            audioLabLogSendDisabled && styles.buttonDisabled,
          ]}
          onPress={sendLogs}
          disabled={audioLabLogSendDisabled}
        >
          <Text style={styles.buttonText}>Audio Labログ送信</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.buttonSecondary, audioLabLogQueuedCount <= 0 && styles.buttonDisabled]}
          onPress={clearLogs}
          disabled={audioLabLogQueuedCount <= 0}
        >
          <Text style={styles.buttonText}>ログクリア</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.audioLabLogBox}>
        {audioLabRecentLogs.length === 0 ? (
          <Text style={styles.hint}>Audio Labログはまだありません。</Text>
        ) : (
          audioLabRecentLogs.map((line, index) => (
            <Text key={`lab-log-${index}`} style={styles.audioLabLogLine}>{line}</Text>
          ))
        )}
      </View>
      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
    </ScrollView>
  );
}
