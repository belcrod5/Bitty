import { useEffect, useState } from "react";
import { Image, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { styles } from "../styles";
import { CircularProgressRing } from "./CircularProgressRing";
import { getNetworkUsageSnapshot } from "../../ws/networkUsageMetrics";
import { formatBytesCompact } from "../utils/formatting";

const WAVEFORM_DOT_GIF = require("../../../../assets/images/waveform-dots.gif");

export type TtsWaveformPlayerProps = {
  isPlaybackActive: boolean;
  playButtonDisabled: boolean;
  onPressPlayStop: () => void;
  playbackRingProgress?: number;
  statusRingProgress?: number;
};

function formatBytesOrZero(bytes: number) {
  return formatBytesCompact(bytes) || "0B";
}

export function TtsWaveformPlayer(props: TtsWaveformPlayerProps) {
  const {
    isPlaybackActive,
    playButtonDisabled,
    onPressPlayStop,
    playbackRingProgress = 0,
    statusRingProgress = 0,
  } = props;
  const [usageOpen, setUsageOpen] = useState(false);
  const [networkUsage, setNetworkUsage] = useState(getNetworkUsageSnapshot);
  useEffect(() => {
    if (!usageOpen) return;
    setNetworkUsage(getNetworkUsageSnapshot());
    const timer = setInterval(() => setNetworkUsage(getNetworkUsageSnapshot()), 1000);
    return () => clearInterval(timer);
  }, [usageOpen]);

  const usageRows: Array<[string, string]> = [
    ["stream-tts WS 送信", formatBytesOrZero(networkUsage.streamTts.sentBytes)],
    ["stream-tts WS 受信", formatBytesOrZero(networkUsage.streamTts.receivedBytes)],
    ["音声DL(tts-media・推定)", formatBytesOrZero(networkUsage.httpByCategory["tts-media"].receivedBytes)],
    ["runner WS 受信(TTSイベント含む)", formatBytesOrZero(networkUsage.runnerWs.receivedBytes)],
  ];

  return (
    <View style={styles.chatAudioBubble}>
      <Pressable
        style={styles.chatTtsWaveformCard}
        onPress={() => setUsageOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="TTS通信量を開く"
      >
        {isPlaybackActive ? (
          <Image source={WAVEFORM_DOT_GIF} style={styles.chatWaveformGif} />
        ) : null}
        <View style={styles.chatTtsPlayFloatingWrap}>
          <View style={styles.chatTtsGenerationRingWrap}>
            <CircularProgressRing
              size={36}
              strokeWidth={2}
              progress={statusRingProgress}
              trackColor="#dbeafe"
              progressColor="#0ea5e9"
            />
          </View>
          <View style={styles.chatTtsPlaybackRingWrap}>
            <CircularProgressRing
              size={32}
              strokeWidth={2}
              progress={playbackRingProgress}
              trackColor="#fecaca"
              progressColor="#dc2626"
            />
          </View>
          <TouchableOpacity
            style={[
              styles.chatAudioIconButton,
              isPlaybackActive && styles.chatAudioIconButtonActive,
              playButtonDisabled && styles.buttonDisabled,
            ]}
            onPress={onPressPlayStop}
            disabled={playButtonDisabled}
          >
            <Ionicons
              name={isPlaybackActive ? "stop" : "volume-high"}
              size={14}
              color="#1e293b"
            />
          </TouchableOpacity>
        </View>
      </Pressable>
      <Modal
        visible={usageOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setUsageOpen(false)}
      >
        <View style={usageStyles.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setUsageOpen(false)} />
          <View style={usageStyles.sheet}>
            <View style={usageStyles.header}>
              <Text style={usageStyles.title}>TTS通信量</Text>
              <Pressable onPress={() => setUsageOpen(false)} accessibilityLabel="TTS通信量を閉じる">
                <Text style={usageStyles.close}>×</Text>
              </Pressable>
            </View>
            {usageRows.map(([rowLabel, value]) => (
              <View key={rowLabel} style={usageStyles.row}>
                <Text style={usageStyles.rowLabel}>{rowLabel}</Text>
                <Text style={usageStyles.rowValue}>{value}</Text>
              </View>
            ))}
            <Text style={usageStyles.note}>
              runner WS経由のTTSイベントはrunner WSの通信量に含まれます。
            </Text>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const usageStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(15, 23, 42, 0.36)",
  },
  sheet: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 26,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: "#ffffff",
  },
  header: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  title: { fontSize: 16, fontWeight: "800", color: "#0f172a" },
  close: { fontSize: 28, lineHeight: 30, color: "#334155" },
  row: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowLabel: { fontSize: 12, color: "#64748b" },
  rowValue: { fontSize: 14, fontWeight: "700", color: "#0f172a" },
  note: { marginTop: 10, fontSize: 11, color: "#94a3b8" },
});
