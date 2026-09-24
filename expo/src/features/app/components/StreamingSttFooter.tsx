import { Ionicons } from "@expo/vector-icons";
import { BlurMask, Canvas, Group, Path, Skia, SweepGradient, vec } from "@shopify/react-native-skia";
import React, { forwardRef, memo, useImperativeHandle, useRef, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useFrameCallback, useSharedValue, withTiming } from "react-native-reanimated";
import { useAppStyles } from "../styles";
import { useVisualTheme } from "../theme/VisualThemeContext";
import type { StreamingSttUsage } from "../../stt/streamingSttClient";
import type { StreamingSttPhase } from "../../stt/useStreamingStt";

const GLOW_SPACE = 48;
const RAINBOW = ["#ff505f", "#ffae3d", "#f9ee56", "#56e89c", "#4cc9ff", "#987aff", "#ff505f"];

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
}>(function StreamingSttFooter({ transcript, phase, onStop }, ref) {
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

  useFrameCallback((frame) => {
    const elapsed = Math.min(frame.timeSincePreviousFrame ?? 0, 50);
    const start = (gradientStart.value + elapsed * (0.072 + audioLevel.value * 0.168)) % 360;
    gradientStart.value = start;
    gradientEnd.value = start + 360;
  });

  useImperativeHandle(ref, () => ({
    pushSample(sample) {
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
  }), [audioLevel, glowBlur, glowOpacity, glowWidth]);

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
            <SweepGradient c={center} colors={RAINBOW} mode="repeat" start={gradientStart} end={gradientEnd} />
            <BlurMask blur={glowBlur} style="normal" />
          </Path>
        </Group>
        <Path path={border} style="stroke" strokeWidth={2}>
          <SweepGradient c={center} colors={RAINBOW} mode="repeat" start={gradientStart} end={gradientEnd} />
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
              onLayout={(event) => {
                const height = Math.min(66, Math.max(22, event.nativeEvent.layout.height));
                setTranscriptHeight((current) => current === height ? current : height);
              }}
              style={{ color: "#f4f7ff", fontSize: 16, lineHeight: 22 }}
            >
              {transcript || (phase === "finalizing" ? "文字起こしを確定中…" : "音声を聞いています…")}
            </Text>
          </ScrollView>
          <Text style={{ color: "#8e9bad", fontSize: 11, marginTop: 2 }}>
            {phase === "finalizing" ? "FINALIZING" : usageLabel(usage)}
          </Text>
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
