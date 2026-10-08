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
import { CircularProgressRing } from "./CircularProgressRing";
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
  onEditCorrection?: () => void;
  onChangeCorrectionText?: (text: string) => void;
  trailingAccessory?: ReactNode;
}>(function StreamingSttFooter({ transcript, phase, onStop, voiceStatus, reduceMotion, voiceContextStats, statusText,
  onChangeText, onFocus, onBlur, onSubmit, onCancelSpeaking, historyExpanded, onHistoryToggle,
  leadingAccessory, trailingAccessory, correctionPreview, onSendCorrection, onEditCorrection,
  onChangeCorrectionText }, ref) {
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
  const correctionInputRef = useRef<TextInput>(null);
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
    if (!correctionPreview || correctionPreview.deadlineMs === null || correctionPreview.editing) return;
    const interval = setInterval(() => tickProgress((value) => value + 1), 250);
    return () => clearInterval(interval);
  }, [correctionPreview?.deadlineMs]);

  React.useEffect(() => {
    if (!correctionPreview || correctionPreview.deadlineMs === null
      || correctionPreview.editing || motionReduced) return;
    const remaining = Math.max(0, correctionPreview.deadlineMs - Date.now());
    progress.setValue(Math.min(1, remaining / 3000));
    const animation = Animated.timing(progress, { toValue: 0, duration: remaining, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [correctionPreview?.deadlineMs, motionReduced, progress]);

  React.useEffect(() => {
    if (correctionPreview?.editing) correctionInputRef.current?.focus();
  }, [correctionPreview?.editing]);

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
  const removedText = correctionPreview?.parts.filter((part) => part.kind === "delete")
    .map((part) => part.text).join(" · ");
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
          marginBottom: 14, padding: 16, borderRadius: 16, backgroundColor: "#152130",
          borderWidth: 1, borderColor: "#365267", zIndex: 2 }}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            const path = Skia.Path.Make();
            path.addRRect(Skia.RRectXY(Skia.XYWHRect(GLOW_SPACE - 2, GLOW_SPACE - 2,
              width + 4, height + 4), 16, 16));
            previewBorder.value = path;
            previewCenter.value = vec(GLOW_SPACE + width / 2, GLOW_SPACE + height / 2);
          }}>
          {renderGlow(previewBorder, previewCenter, "streaming-stt-preview-glow")}
          <View style={{ zIndex: 1 }}>
            <Text style={{ color: "#8fb2c7", fontSize: 11, fontWeight: "600", letterSpacing: 1,
              marginBottom: 9 }}>{correctionPreview.editing ? "補正を編集" : "音声の補正"}</Text>
            {correctionPreview.editing ? (
              <TextInput ref={correctionInputRef} testID="streaming-stt-correction-editor"
                value={correctionPreview.text} onChangeText={onChangeCorrectionText}
                multiline autoFocus selectionColor="#8fe8f2" accessibilityLabel="補正した文字起こしを編集"
                style={{ color: "#f4f7ff", fontSize: 17, lineHeight: 25, minHeight: 60, maxHeight: 160,
                  textAlignVertical: "top", padding: 0 }} />
            ) : (
              <TouchableOpacity testID="streaming-stt-correction-text" onPress={onSendCorrection}
                accessibilityRole="button"
                accessibilityLabel={`補正後: ${correctionPreview.text}。変更: ${correctionPreview.parts
                  .filter((part) => part.kind !== "same")
                  .map((part) => `${part.kind === "delete" ? "削除" : "追加"} ${part.text}`).join("、")}`}
                accessibilityHint="ダブルタップで今すぐ送信">
                <Text style={{ color: "#f4f7ff", fontSize: 17, lineHeight: 25 }}>
                  {correctionPreview.parts.filter((part) => part.kind !== "delete").map((part, index) => (
                    <Text key={index} style={part.kind === "insert" ? {
                      color: "#9ee9f2", textDecorationLine: "underline",
                      textDecorationColor: "#61bfd1",
                    } : undefined}>{part.text}</Text>
                  ))}
                </Text>
              </TouchableOpacity>
            )}
            {!correctionPreview.editing && removedText ? (
              <Text testID="streaming-stt-correction-deleted" numberOfLines={1}
                style={{ color: "#899bab", fontSize: 12, marginTop: 9 }}>
                {`削除: ${removedText}`}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center",
              marginTop: 10, gap: 10 }}>
              {!correctionPreview.editing ? (
                <TouchableOpacity onPress={onEditCorrection} accessibilityRole="button"
                  accessibilityLabel="補正した文字起こしをこのカードで編集"
                  style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#2b3c51",
                    alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="pencil" size={19} color="#dce9f2" />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity onPress={onSendCorrection} accessibilityRole="button"
                accessibilityLabel={correctionPreview.editing ? "編集した文字起こしを送信" : "補正した文字起こしを今すぐ送信"}
                accessibilityValue={correctionPreview.editing ? undefined : { min: 0, max: 3000,
                  now: Math.min(3000, remainingMs), text: `あと${Math.ceil(remainingMs / 1000)}秒で自動送信` }}
                disabled={!correctionPreview.text.trim()}
                style={{ width: 52, height: 52, alignItems: "center", justifyContent: "center",
                  opacity: correctionPreview.text.trim() ? 1 : 0.45 }}>
                {!correctionPreview.editing ? (
                  <View testID="streaming-stt-correction-ring" pointerEvents="none"
                    style={{ position: "absolute" }}>
                    <CircularProgressRing size={52} strokeWidth={3} progress={remainingMs / 3000}
                      animatedProgress={motionReduced || correctionPreview.deadlineMs === null ? undefined : progress}
                      trackColor="#3b5365" progressColor="#85e5ee" />
                  </View>
                ) : null}
                <View style={{ position: "absolute", width: 42, height: 42, borderRadius: 21,
                  backgroundColor: "#2a7187", alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="send" size={19} color="#ffffff" />
                </View>
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
