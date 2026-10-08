import { Ionicons } from "@expo/vector-icons";
import { BlurMask, Canvas, Group, Path, Skia, SweepGradient, vec } from "@shopify/react-native-skia";
import React, { forwardRef, memo, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { Animated, Platform, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useFrameCallback, useSharedValue, withTiming } from "react-native-reanimated";
import { useAppStyles } from "../styles";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import type { StreamingSttUsage } from "../../stt/streamingSttClient";
import type { StreamingSttPhase } from "../../stt/useStreamingStt";
import type { SttCorrectionPreview } from "../../stt/sttTranscriptDiff";
import type { VoiceContextStats } from "../types/appTypes";
import { RAINBOW_GLOW_COLORS, RAINBOW_GLOW_DEGREES_PER_MS } from "./rainbowGlow";

const GLOW_SPACE = 48;
const RESPONDING_COLORS = ["#46f6ff", "#537dff", "#ab67ff", "#5fffc8", "#46f6ff"];
const SPEAKING_COLORS = ["#ff79cf", "#ffb263", "#ffe779", "#ff79cf"];

export type StreamingSttFooterHandle = {
  pushSample: (sample: number) => void;
  updateUsage: (usage: StreamingSttUsage) => void;
};

function usageLabel(usage: StreamingSttUsage | null) {
  if (!usage) return "";
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
  statusText?: string;
  onChangeText?: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onSubmit?: (text: string, onAccepted: () => boolean) => Promise<void>;
  onCancelSpeaking?: () => void;
  historyExpanded?: boolean;
  onHistoryToggle?: () => void;
  leadingAccessory?: ReactNode;
  correctionPreview?: SttCorrectionPreview | null;
  onSendCorrection?: () => void;
  onCancelCorrection?: () => void;
  trailingAccessory?: ReactNode;
}>(function StreamingSttFooter({ transcript, phase, onStop, voiceStatus, reduceMotion, voiceContextStats, statusText,
  onChangeText, onFocus, onBlur, onSubmit, onCancelSpeaking, historyExpanded, onHistoryToggle,
  leadingAccessory, trailingAccessory, correctionPreview, onSendCorrection, onCancelCorrection }, ref) {
  const styles = useAppStyles();
  const { themeId } = useVisualTheme();
  const systemReduceMotion = useReduceMotionEnabled();
  const motionReduced = reduceMotion ?? systemReduceMotion !== false;
  const [usage, setUsage] = useState<StreamingSttUsage | null>(null);
  const [, tickProgress] = useState(0);
  const remainingMs = correctionPreview?.deadlineMs == null ? 3000
    : Math.max(0, correctionPreview.deadlineMs - Date.now());
  const progress = useRef(new Animated.Value(1)).current;
  const lastUsageUpdateRef = useRef(0);
  const pendingUsageRef = useRef<StreamingSttUsage | null>(null);
  const usageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);
  const latestTranscriptRef = useRef(transcript);
  latestTranscriptRef.current = transcript;
  const submittingRef = useRef(false);
  const lastGlowUpdateRef = useRef(0);
  const border = useSharedValue(Skia.Path.Make());
  const center = useSharedValue(vec(0, 0));
  const glowWidth = useSharedValue(4);
  const glowBlur = useSharedValue(3);
  const glowOpacity = useSharedValue(0.25);
  const audioLevel = useSharedValue(0);
  const gradientStart = useSharedValue(0);
  const gradientEnd = useSharedValue(360);
  const previewBorder = useSharedValue(Skia.Path.Make());
  const previewCenter = useSharedValue(vec(0, 0));
  const glowStatus = phase === "correcting" || phase === "preview" ? undefined : voiceStatus;
  const glowColors = glowStatus === "responding" ? RESPONDING_COLORS
    : glowStatus === "speaking" ? SPEAKING_COLORS : RAINBOW_GLOW_COLORS;

  React.useEffect(() => {
    if (phase !== "connecting") return;
    if (usageTimerRef.current) clearTimeout(usageTimerRef.current);
    usageTimerRef.current = null;
    pendingUsageRef.current = null;
    lastUsageUpdateRef.current = 0;
    setUsage(null);
  }, [phase]);

  React.useEffect(() => {
    if (!correctionPreview || correctionPreview.deadlineMs === null) return;
    const interval = setInterval(() => tickProgress((value) => value + 1), 250);
    return () => clearInterval(interval);
  }, [correctionPreview?.deadlineMs]);

  React.useEffect(() => {
    if (!correctionPreview || correctionPreview.deadlineMs === null || motionReduced) return;
    const remaining = Math.max(0, correctionPreview.deadlineMs - Date.now());
    progress.setValue(Math.min(1, remaining / 3000));
    const animation = Animated.timing(progress, { toValue: 0, duration: remaining, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [correctionPreview?.deadlineMs, motionReduced, progress]);

  useFrameCallback((frame) => {
    if (motionReduced) return;
    const elapsed = Math.min(frame.timeSincePreviousFrame ?? 0, 50);
    const speed = glowStatus === "responding" ? 0.28
      : glowStatus === "speaking" ? 0.12 : RAINBOW_GLOW_DEGREES_PER_MS + audioLevel.value * 0.168;
    const start = (gradientStart.value + elapsed * speed) % 360;
    gradientStart.value = start;
    gradientEnd.value = start + 360;
    if (glowStatus) {
      const pulse = (Math.sin(start * Math.PI / 90) + 1) / 2;
      glowWidth.value = (glowStatus === "responding" ? 8 : 6) + pulse * 9;
      glowBlur.value = 5 + pulse * 4;
      glowOpacity.value = 0.55 + pulse * 0.3;
    }
  });

  React.useEffect(() => {
    if (!glowStatus) return;
    glowWidth.value = 10;
    glowBlur.value = 6;
    glowOpacity.value = 0.7;
    return () => {
      glowWidth.value = 4;
      glowBlur.value = 3;
      glowOpacity.value = 0.25;
    };
  }, [glowBlur, glowOpacity, glowWidth, glowStatus]);

  useImperativeHandle(ref, () => ({
    pushSample(sample) {
      if (glowStatus) return;
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
  }), [audioLevel, glowBlur, glowOpacity, glowWidth, glowStatus]);

  React.useEffect(() => () => {
    if (usageTimerRef.current) clearTimeout(usageTimerRef.current);
  }, []);

  const submit = (text: string) => {
    if (!onSubmit || submittingRef.current) return;
    if (text !== latestTranscriptRef.current) {
      latestTranscriptRef.current = text;
      onChangeText?.(text);
    }
    if (!text.trim()) return;
    submittingRef.current = true;
    void onSubmit(text, () => {
      if (latestTranscriptRef.current !== text) return false;
      latestTranscriptRef.current = "";
      onChangeText?.("");
      inputRef.current?.blur();
      return true;
    }).catch(() => undefined).finally(() => { submittingRef.current = false; });
  };
  const historyAccessibility = onHistoryToggle ? {
    accessibilityActions: [{ name: "toggleHistory", label: historyExpanded ? "履歴を閉じる" : "履歴を開く" }],
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
      if (event.nativeEvent.actionName === "toggleHistory") onHistoryToggle();
    },
  } : {};
  const panelTop = trailingAccessory ? 32 : leadingAccessory ? 8 : 0;
  const metadataTop = leadingAccessory ? (trailingAccessory ? 8 : 19) : 0;
  const renderGlow = (path: typeof border, glowCenter: typeof center, testID: string) => (
    <Canvas pointerEvents="none" testID={testID}
      style={{ position: "absolute", left: -GLOW_SPACE, right: -GLOW_SPACE,
        top: -GLOW_SPACE, bottom: -GLOW_SPACE }}>
      {themeId === "standard" ? (
        <Path path={path} color="#101827" opacity={0.35} style="stroke" strokeWidth={26}>
          <BlurMask blur={9} style="normal" />
        </Path>
      ) : null}
      <Group opacity={glowOpacity}>
        <Path path={path} style="stroke" strokeWidth={glowWidth}>
          <SweepGradient c={glowCenter} colors={glowColors} mode="repeat"
            start={gradientStart} end={gradientEnd} />
          <BlurMask blur={glowBlur} style="normal" />
        </Path>
      </Group>
      <Path path={path} style="stroke" strokeWidth={2}>
        <SweepGradient c={glowCenter} colors={glowColors} mode="repeat"
          start={gradientStart} end={gradientEnd} />
      </Path>
    </Canvas>
  );

  return (
    <View>
      {correctionPreview ? (
        <View testID="streaming-stt-correction-preview" style={{ position: "relative", overflow: "visible",
          marginBottom: 10, padding: 12, borderRadius: 12, backgroundColor: "#17273b", zIndex: 2 }}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            const path = Skia.Path.Make();
            path.addRRect(Skia.RRectXY(Skia.XYWHRect(GLOW_SPACE - 2, GLOW_SPACE - 2,
              width + 4, height + 4), 12, 12));
            previewBorder.value = path;
            previewCenter.value = vec(GLOW_SPACE + width / 2, GLOW_SPACE + height / 2);
          }}>
          {renderGlow(previewBorder, previewCenter, "streaming-stt-preview-glow")}
          <View style={{ zIndex: 1 }}>
            <TouchableOpacity testID="streaming-stt-correction-text" onPress={onSendCorrection}
              accessibilityRole="button"
              accessibilityLabel={`補正後: ${correctionPreview.text}。変更: ${correctionPreview.parts
                .filter((part) => part.kind !== "same")
                .map((part) => `${part.kind === "delete" ? "削除" : "追加"} ${part.text}`).join("、")}`}
              accessibilityHint="ダブルタップで今すぐ送信">
              <Text style={{ color: "#f4f7ff", fontSize: 16 }}>
                {correctionPreview.parts.map((part, index) => (
                  <Text key={index} accessibilityLabel={part.kind === "delete" ? `削除: ${part.text}`
                    : part.kind === "insert" ? `補正: ${part.text}` : undefined}
                    style={part.kind === "insert" ? { color: "#aaf7ff", backgroundColor: "#24516a",
                      textDecorationLine: "underline" } : part.kind === "delete" ? {
                      color: "#ffafbd", backgroundColor: "#563041", textDecorationLine: "line-through",
                    } : undefined}>{part.text}</Text>
                ))}
              </Text>
            </TouchableOpacity>
            <View testID="streaming-stt-correction-progress" accessibilityRole="progressbar"
              accessibilityLabel="自動送信まで" accessibilityValue={{ min: 0, max: 3000,
                now: Math.min(3000, remainingMs),
                text: `あと${Math.ceil(remainingMs / 1000)}秒で自動送信` }}
              style={{ height: 4, borderRadius: 2, backgroundColor: "#35465c", marginTop: 12,
                overflow: "hidden" }}>
              {correctionPreview.deadlineMs === null || motionReduced ? (
                <View style={{ height: 4, width: `${Math.min(100, remainingMs / 30)}%`,
                  backgroundColor: "#69e6f8" }} />
              ) : (
                <Animated.View style={{ height: 4, backgroundColor: "#69e6f8",
                  width: progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }} />
              )}
            </View>
            <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 8, gap: 8 }}>
              <TouchableOpacity onPress={onCancelCorrection} accessibilityRole="button"
                accessibilityLabel="自動送信をキャンセルして編集"
                style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: "#35465c",
                  alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="pencil" size={20} color="#f4f7ff" />
              </TouchableOpacity>
              <TouchableOpacity onPress={onSendCorrection} accessibilityRole="button"
                accessibilityLabel="補正した文字起こしを今すぐ送信"
                style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: "#24667e",
                  alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="send" size={20} color="#ffffff" />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}
    <View
      testID="streaming-stt-footer"
      style={{ position: "relative", overflow: "visible", paddingTop: panelTop,
        paddingLeft: leadingAccessory ? 8 : 0 }}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        const left = leadingAccessory ? 8 : 0;
        const path = Skia.Path.Make();
        path.addRRect(Skia.RRectXY(
          Skia.XYWHRect(GLOW_SPACE + left - 2, GLOW_SPACE + panelTop - 2,
            width - left + 4, height - panelTop + 4), 16, 16
        ));
        border.value = path;
        center.value = vec(GLOW_SPACE + left + (width - left) / 2,
          GLOW_SPACE + panelTop + (height - panelTop) / 2);
      }}
    >
      {renderGlow(border, center, "streaming-stt-glow")}
      <View testID="streaming-stt-panel" style={[styles.chatInputWrapper, { minHeight: 62, backgroundColor: "#070b12",
        zIndex: 1 }]}>
        {voiceStatus === "speaking" && onCancelSpeaking ? (
          <TouchableOpacity
            testID="streaming-stt-speaking-cancel"
            accessibilityRole="button"
            accessibilityLabel="読み上げを停止"
            onPress={onCancelSpeaking}
            style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, zIndex: 2 }}
          />
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          {leadingAccessory || voiceContextStats !== undefined || usage || phase === "finalizing" ? (
            <View testID="streaming-stt-metadata" style={{ flexDirection: "row", flexWrap: "wrap",
              alignItems: "center", marginTop: metadataTop,
              minHeight: leadingAccessory ? 11 : 0, marginBottom: 2 }}>
              {phase === "finalizing" || usage ? (
                <Text style={{ color: "#8e9bad", fontSize: 11 }}>
                  {phase === "finalizing" ? "FINALIZING" : usageLabel(usage)}
                </Text>
              ) : null}
              {voiceContextStats !== undefined ? (
                <Text testID="streaming-stt-voice-context-stats" style={{ color: "#8e9bad", fontSize: 11,
                  marginLeft: phase === "finalizing" || usage ? 8 : 0 }}>
                  {`文脈 ${voiceContextStats?.estimatedContextUsagePercent ?? "--"}% · 未要約 ${voiceContextStats?.unsummarizedMessageCount ?? "--"}件 · メモリー ${voiceContextStats?.memoryCharacterCount ?? "--"}字`}
                </Text>
              ) : null}
              {voiceContextStats?.subagentTotalCount !== undefined ? (
                <View testID="streaming-stt-subagent-count" style={{ flexDirection: "row", alignItems: "center", marginLeft: 8 }}>
                  <Ionicons name="people-outline" size={11} color="#8e9bad" />
                  <Text style={{ color: "#8e9bad", fontSize: 11, marginLeft: 3 }}>
                    {`${voiceContextStats.subagentRunningCount}/${voiceContextStats.subagentTotalCount}`}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {onChangeText && !voiceStatus ? (
            <TextInput
              ref={inputRef}
              testID="streaming-stt-transcript"
              value={transcript}
              onChangeText={(text) => {
                latestTranscriptRef.current = text;
                onChangeText(text);
              }}
              onFocus={onFocus}
              onBlur={onBlur}
              onSubmitEditing={(event) => submit(event.nativeEvent.text ?? latestTranscriptRef.current)}
              submitBehavior="submit"
              returnKeyType="send"
              {...(Platform.OS === "macos" ? { submitKeyEvents: [{ key: "Enter" }] } : {})}
              multiline
              scrollEnabled
              placeholder={statusText || (phase === "idle" ? "メッセージを入力" : phase === "finalizing" ? "文字起こしを確定中…"
                : phase === "correcting" ? "文字起こしを補正中…" : phase === "preview" ? "補正結果を確認中…" : "音声を聞いています…")}
              placeholderTextColor="#8e9bad"
              accessibilityLabel="文字起こしを編集"
              {...historyAccessibility}
              style={{ color: "#f4f7ff", fontSize: 16, lineHeight: 22, minHeight: 22, maxHeight: 66, padding: 0 }}
            />
          ) : (
            <Text
              testID="streaming-stt-transcript"
              accessibilityLabel={voiceStatus === "responding" ? "Responding" : voiceStatus === "speaking" ? "Speaking" : undefined}
              {...historyAccessibility}
              style={[{ color: "#f4f7ff", fontSize: 16, lineHeight: 22, maxHeight: 66 }, voiceStatus ? {
                color: voiceStatus === "responding" ? "#83f8ff" : "#ffafd9",
                fontSize: 14,
                letterSpacing: 2,
                fontWeight: "300",
              } : undefined]}
            >
              {statusText || transcript || (phase === "finalizing" ? "文字起こしを確定中…" : "音声を聞いています…")}
            </Text>
          )}
          {statusText && transcript ? (
            <Text style={{ color: "#ff9a9a", fontSize: 11, marginTop: 2 }}>{statusText}</Text>
          ) : null}
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
      {leadingAccessory ? (
        <View testID="streaming-stt-leading-accessory"
          style={{ position: "absolute", left: 0, top: 0, width: 44, height: 44, zIndex: 3 }}>
          {leadingAccessory}
        </View>
      ) : null}
      {trailingAccessory ? (
        <View testID="streaming-stt-trailing-accessory"
          style={{ position: "absolute", left: leadingAccessory ? 60 : 0, right: 0, top: 0,
            minHeight: 32, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", zIndex: 3 }}>
          <View style={{ flexShrink: 1 }}>{trailingAccessory}</View>
        </View>
      ) : null}
    </View>
    </View>
  );
}));
