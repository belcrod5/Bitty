import { Ionicons } from "@expo/vector-icons";
import { BlurMask, Canvas, Group, Path, Skia, SweepGradient, vec } from "@shopify/react-native-skia";
import React, { forwardRef, memo, useImperativeHandle, useRef, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useFrameCallback, useSharedValue, withTiming } from "react-native-reanimated";
import { useAppStyles } from "../styles";
import { useVisualTheme } from "../theme/VisualThemeContext";
import type { StreamingSttUsage } from "../../stt/streamingSttClient";
import type { StreamingSttPhase } from "../../stt/useStreamingStt";
import type { VoiceContextStats } from "../types/appTypes";

const GLOW_SPACE = 48;
const RAINBOW = ["#ff505f", "#ffae3d", "#f9ee56", "#56e89c", "#4cc9ff", "#987aff", "#ff505f"];
const RESPONDING_COLORS = ["#46f6ff", "#537dff", "#ab67ff", "#5fffc8", "#46f6ff"];
const SPEAKING_COLORS = ["#ff79cf", "#ffb263", "#ffe779", "#ff79cf"];

export type StreamingSttFooterHandle = {
  pushSample: (sample: number) => void;
  updateUsage: (usage: StreamingSttUsage) => void;
};

function usageLabel(usage: StreamingSttUsage | null) {
  if (!usage) return "--:-- / --m";
  const minutes = Math.floor(usage.usedSeconds / 60);
  const seconds = Math.floor(usage.usedSeconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")} / ${Math.ceil(usage.limitSeconds / 60)}m`;
}

export const StreamingSttFooter = memo(forwardRef<StreamingSttFooterHandle, {
  transcript: string;
  phase: StreamingSttPhase;
  onStop: () => void;
  voiceStatus?: "responding" | "speaking";
  reduceMotion?: boolean;
  voiceContextStats?: VoiceContextStats | null;
}>(function StreamingSttFooter({ transcript, phase, onStop, voiceStatus, reduceMotion, voiceContextStats }, ref) {
  const styles = useAppStyles();
  const { themeId } = useVisualTheme();
  const [usage, setUsage] = useState<StreamingSttUsage | null>(null);
  const lastUsageUpdateRef = useRef(0);
  const pendingUsageRef = useRef<StreamingSttUsage | null>(null);
  const usageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptScrollRef = useRef<ScrollView>(null);
  const [transcriptHeight, setTranscriptHeight] = useState(22);
  const lastGlowUpdateRef = useRef(0);
  const border = useSharedValue(Skia.Path.Make());
  const center = useSharedValue(vec(0, 0));
  const glowWidth = useSharedValue(4);
  const glowBlur = useSharedValue(3);
  const glowOpacity = useSharedValue(0.25);
  const audioLevel = useSharedValue(0);
  const gradientStart = useSharedValue(0);
  const gradientEnd = useSharedValue(360);
  const glowColors = voiceStatus === "responding" ? RESPONDING_COLORS
    : voiceStatus === "speaking" ? SPEAKING_COLORS : RAINBOW;

  useFrameCallback((frame) => {
    if (voiceStatus && reduceMotion) return;
    const elapsed = Math.min(frame.timeSincePreviousFrame ?? 0, 50);
    const speed = voiceStatus === "responding" ? 0.28
      : voiceStatus === "speaking" ? 0.12 : 0.072 + audioLevel.value * 0.168;
    const start = (gradientStart.value + elapsed * speed) % 360;
    gradientStart.value = start;
    gradientEnd.value = start + 360;
    if (voiceStatus) {
      const pulse = (Math.sin(start * Math.PI / 90) + 1) / 2;
      glowWidth.value = (voiceStatus === "responding" ? 8 : 6) + pulse * 9;
      glowBlur.value = 5 + pulse * 4;
      glowOpacity.value = 0.55 + pulse * 0.3;
    }
  });

  React.useEffect(() => {
    if (!voiceStatus) return;
    glowWidth.value = 10;
    glowBlur.value = 6;
    glowOpacity.value = 0.7;
    return () => {
      glowWidth.value = 4;
      glowBlur.value = 3;
      glowOpacity.value = 0.25;
    };
  }, [glowBlur, glowOpacity, glowWidth, voiceStatus]);

  useImperativeHandle(ref, () => ({
    pushSample(sample) {
      if (voiceStatus) return;
      const now = Date.now();
      if (now - lastGlowUpdateRef.current < 1000 / 30) return;
      lastGlowUpdateRef.current = now;
      const level = Math.min(1, Math.sqrt(Math.max(0, sample) * 5));
      audioLevel.value = withTiming(level, { duration: 90 });
      glowWidth.value = withTiming(4 + level * 24, { duration: 90 });
      glowBlur.value = withTiming(3 + level * 7, { duration: 90 });
      glowOpacity.value = withTiming(0.25 + level * 0.75, { duration: 90 });
    },
    updateUsage(next) {
      const elapsed = Date.now() - lastUsageUpdateRef.current;
      if (elapsed >= 1000) {
        lastUsageUpdateRef.current = Date.now();
        setUsage(next);
        return;
      }
      pendingUsageRef.current = next;
      if (usageTimerRef.current) return;
      usageTimerRef.current = setTimeout(() => {
        usageTimerRef.current = null;
        lastUsageUpdateRef.current = Date.now();
        setUsage(pendingUsageRef.current);
        pendingUsageRef.current = null;
      }, 1000 - elapsed);
    },
  }), [audioLevel, glowBlur, glowOpacity, glowWidth, voiceStatus]);

  React.useEffect(() => () => {
    if (usageTimerRef.current) clearTimeout(usageTimerRef.current);
  }, []);

  return (
    <View
      testID="streaming-stt-footer"
      style={{ position: "relative", overflow: "visible" }}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        const path = Skia.Path.Make();
        path.addRRect(Skia.RRectXY(
          Skia.XYWHRect(GLOW_SPACE - 2, GLOW_SPACE - 2, width + 4, height + 4), 16, 16
        ));
        border.value = path;
        center.value = vec(GLOW_SPACE + width / 2, GLOW_SPACE + height / 2);
      }}
    >
      <Canvas
        pointerEvents="none"
        testID="streaming-stt-glow"
        style={{ position: "absolute", left: -GLOW_SPACE, right: -GLOW_SPACE, top: -GLOW_SPACE, bottom: -GLOW_SPACE }}
      >
        {themeId === "standard" ? (
          <Path path={border} color="#101827" opacity={0.35} style="stroke" strokeWidth={26}>
            <BlurMask blur={9} style="normal" />
          </Path>
        ) : null}
        <Group opacity={glowOpacity}>
          <Path path={border} style="stroke" strokeWidth={glowWidth}>
            <SweepGradient c={center} colors={glowColors} mode="repeat" start={gradientStart} end={gradientEnd} />
            <BlurMask blur={glowBlur} style="normal" />
          </Path>
        </Group>
        <Path path={border} style="stroke" strokeWidth={2}>
          <SweepGradient c={center} colors={glowColors} mode="repeat" start={gradientStart} end={gradientEnd} />
        </Path>
      </Canvas>
      <View testID="streaming-stt-panel" style={[styles.chatInputWrapper, { minHeight: 62, backgroundColor: "#070b12", zIndex: 1 }]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <ScrollView
            ref={transcriptScrollRef}
            testID="streaming-stt-transcript-scroll"
            style={{ height: transcriptHeight, maxHeight: 66, flexGrow: 0 }}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => transcriptScrollRef.current?.scrollToEnd({ animated: false })}
          >
            <Text
              testID="streaming-stt-transcript"
              accessibilityLabel={voiceStatus === "responding" ? "Responding" : voiceStatus === "speaking" ? "Speaking" : undefined}
              onLayout={(event) => {
                const height = Math.min(66, Math.max(22, event.nativeEvent.layout.height));
                setTranscriptHeight((current) => current === height ? current : height);
              }}
              style={[{ color: "#f4f7ff", fontSize: 16, lineHeight: 22 }, voiceStatus ? {
                color: voiceStatus === "responding" ? "#83f8ff" : "#ffafd9",
                fontSize: 14,
                letterSpacing: 2,
                fontWeight: "300",
              } : undefined]}
            >
              {voiceStatus ? transcript : transcript || (phase === "finalizing" ? "文字起こしを確定中…" : "音声を聞いています…")}
            </Text>
          </ScrollView>
          {voiceContextStats !== undefined ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginTop: 2 }}>
              <Text style={{ color: "#8e9bad", fontSize: 11 }}>
                {phase === "finalizing" ? "FINALIZING" : usageLabel(usage)}
              </Text>
              <Text testID="streaming-stt-voice-context-stats" style={{ color: "#8e9bad", fontSize: 11, marginLeft: 8 }}>
                {`文脈推定 ${voiceContextStats?.estimatedContextUsagePercent ?? "--"}% · 未要約 ${voiceContextStats?.unsummarizedMessageCount ?? "--"}件 · メモリー ${voiceContextStats?.memoryCharacterCount ?? "--"}字`}
              </Text>
            </View>
          ) : (
            <Text style={{ color: "#8e9bad", fontSize: 11, marginTop: 2 }}>
              {phase === "finalizing" ? "FINALIZING" : usageLabel(usage)}
            </Text>
          )}
        </View>
        <TouchableOpacity
          testID="streaming-stt-stop"
          accessibilityRole="button"
          accessibilityLabel="録音を停止"
          hitSlop={8}
          disabled={phase === "finalizing"}
          onPress={onStop}
          style={{ width: 42, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#35465c", opacity: phase === "finalizing" ? 0.5 : 1 }}
        >
          <Ionicons name="stop" size={18} color="#ffffff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}));
