import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppStyles } from "../styles";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { CircularProgressRing } from "./CircularProgressRing";
import { getNetworkUsageSnapshot } from "../../ws/networkUsageMetrics";
import { formatBytesCompact } from "../utils/formatting";
import { AppModal } from "./AppModal";
import { VISUAL_THEMES, type VisualTheme } from "../theme/visualThemes";

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
  const styles = useAppStyles();
  const { theme, themeId } = useVisualTheme();
  const usageStyles = usageStylesByTheme[themeId];
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
              trackColor={theme.colors.infoMuted}
              progressColor={theme.colors.audioGenerationProgress}
            />
          </View>
          <View style={styles.chatTtsPlaybackRingWrap}>
            <CircularProgressRing
              size={32}
              strokeWidth={2}
              progress={playbackRingProgress}
              trackColor={theme.dark.danger}
              progressColor={theme.colors.negativeText}
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
              color={theme.colors.textStrong}
            />
          </TouchableOpacity>
        </View>
      </Pressable>
      <AppModal
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
      </AppModal>
    </View>
  );
}

function createUsageStyles(theme: VisualTheme) {
  return StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: theme.colors.sheetBackdrop,
  },
  sheet: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 26,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: theme.colors.surface,
  },
  header: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  title: { ...theme.typography.control, fontWeight: "800", color: theme.colors.textPrimary },
  close: { ...theme.typography.displayLarge, color: theme.colors.textSecondary },
  row: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowLabel: { ...theme.typography.small, color: theme.colors.textMuted },
  rowValue: { ...theme.typography.body, fontWeight: "700", color: theme.colors.textPrimary },
  note: { marginTop: 10, ...theme.typography.caption, color: theme.colors.borderStrong },
  });
}

const usageStylesByTheme = {
  standard: createUsageStyles(VISUAL_THEMES.standard),
  highLegibility: createUsageStyles(VISUAL_THEMES.highLegibility),
} as const;
