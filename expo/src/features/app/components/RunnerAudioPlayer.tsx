import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AVPlaybackStatus } from "expo-av";
import { Audio } from "../audio";
import type { RunnerMediaSource } from "../utils/runnerFileResources";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";

export function RunnerAudioPlayer({ source }: { source: RunnerMediaSource }) {
  const { theme, themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const soundRef = useRef<Audio.Sound | null>(null);
  const [status, setStatus] = useState<AVPlaybackStatus>({ isLoaded: false });
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    setStatus({ isLoaded: false });
    setError("");
    void Audio.Sound.createAsync(source, { shouldPlay: false }).then(async ({ sound }) => {
      if (disposed) {
        await sound.unloadAsync();
        return;
      }
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((nextStatus) => {
        if (disposed) return;
        setStatus(nextStatus);
        if (!nextStatus.isLoaded && nextStatus.error) setError(nextStatus.error);
      });
      await sound.playAsync();
    }).catch((err: unknown) => {
      if (!disposed) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      disposed = true;
      const sound = soundRef.current;
      soundRef.current = null;
      sound?.setOnPlaybackStatusUpdate(null);
      void sound?.unloadAsync().catch(() => undefined);
    };
  }, [source.uri, source.headers?.authorization, source.headers?.["CF-Access-Client-Id"], source.headers?.["CF-Access-Client-Secret"]]);

  const loaded = status.isLoaded;
  const playing = loaded && status.isPlaying && !status.didJustFinish;
  const togglePlayback = async () => {
    const sound = soundRef.current;
    if (!sound || !loaded) return;
    try {
      if (playing) await sound.setStatusAsync({ shouldPlay: false });
      else if (status.didJustFinish || (status.durationMillis && status.positionMillis >= status.durationMillis)) await sound.replayAsync();
      else await sound.playAsync();
    } catch (err) {
      if (soundRef.current === sound) setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <View style={styles.player}>
      <Ionicons name="musical-notes" size={64} color={theme.dark.textMuted} />
      <TouchableOpacity
        style={styles.playButton}
        accessibilityRole="button"
        accessibilityLabel={playing ? "音声を一時停止" : "音声を再生"}
        disabled={!loaded || Boolean(error)}
        onPress={() => { void togglePlayback(); }}
      >
        <Ionicons name={playing ? "pause" : "play"} size={32} color={theme.dark.text} />
      </TouchableOpacity>
      <Text style={styles.position}>
        {error ? "音声を再生できませんでした。" : loaded
          ? `${(status.positionMillis / 1000).toFixed(1)} / ${((status.durationMillis ?? 0) / 1000).toFixed(1)} 秒`
          : "読み込み中…"}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function createStyles(theme: VisualTheme) {
  return StyleSheet.create({
    player: { flex: 1, alignItems: "center", justifyContent: "center", gap: 20, padding: 24 },
    playButton: { padding: 16, borderRadius: 40, backgroundColor: theme.dark.surfaceRaised },
    position: { color: theme.dark.textMuted, fontSize: theme.typography.control.fontSize },
    error: { color: theme.dark.danger, textAlign: "center" },
  });
}
const stylesByTheme = createStylesByTheme(createStyles);
