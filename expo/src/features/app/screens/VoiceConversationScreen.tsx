import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, { FadeIn, FadeInDown, FadeOut, FadeOutDown, runOnJS,
  useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useStreamingStt } from "../../stt/useStreamingStt";
import { StreamingSttFooter, type StreamingSttFooterHandle } from "../components/StreamingSttFooter";
import { useChatScreen } from "../contexts/ChatScreenContext";
import { useConversation } from "../contexts/ConversationContext";
import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import { KeyboardAvoidingView } from "../keyboardController";
import { useVoiceConversation } from "../hooks/useVoiceConversation";
import { useVisualTheme } from "../theme/VisualThemeContext";
import type { ApprovalAction, ApprovalRequest } from "../../codex/approvalFlow";

const voicePanelFadeIn = FadeIn.duration(220);
const voicePanelFadeOut = FadeOut.duration(220);
const historyFadeIn = FadeInDown.duration(240);
const historyFadeOut = FadeOutDown.duration(200);

export type VoiceConversationPlayback = {
  synthesizeSpeechStream: (text: string, target: { messageId: string; jobId?: string }) => Promise<void>;
  stopTtsPlayback: (options?: { interruptStream?: boolean; reason?: string; expectedMessageId?: string }) => Promise<void>;
  isTtsPlaybackActive: boolean;
  isTtsPlaying?: boolean;
  ttsUiStatus: "idle" | "queued" | "synthesizing" | "playing" | "error";
  ttsProvider?: string;
  selectedVoiceId?: string;
  ttsSpeed?: number;
  onApprovalRequest?: (request: ApprovalRequest) => Promise<ApprovalAction>;
  onApprovalResolved?: (request: ApprovalRequest) => void;
};

export function VoiceConversationScreen({
  synthesizeSpeechStream,
  stopTtsPlayback,
  isTtsPlaybackActive,
  isTtsPlaying,
  ttsUiStatus,
  ttsProvider,
  selectedVoiceId,
  ttsSpeed,
  onApprovalRequest,
  onApprovalResolved,
  onClose,
}: VoiceConversationPlayback & { onClose: () => void }) {
  const { runnerUrl, runnerToken } = useChatScreen();
  const { logSessionDiag } = useConversation();
  const reduceMotion = useReduceMotionEnabled();
  const { theme } = useVisualTheme();
  const [transcript, setTranscript] = useState("");
  const [editingTranscript, setEditingTranscript] = useState(false);
  const [initialStartPending, setInitialStartPending] = useState(true);
  const [synthesisStarting, setSynthesisStarting] = useState(false);
  const [synthesisRequestSettled, setSynthesisRequestSettled] = useState(false);
  const [statusAnimation, setStatusAnimation] = useState<{ status?: "responding" | "speaking"; frame: number }>({ frame: 0 });
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const backdropOpacity = useSharedValue(0);
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdropOpacity.value }));
  const footerRef = useRef<StreamingSttFooterHandle>(null);
  const historyScrollRef = useRef<ScrollView>(null);
  const historyAtBottomRef = useRef(true);
  const mountedRef = useRef(true);
  const voicePlaybackMessageIdRef = useRef("");

  const playReply = useCallback(async (text: string, operationId: string, jobId?: string) => {
    if (!mountedRef.current) return;
    setSynthesisStarting(true);
    setSynthesisRequestSettled(false);
    voicePlaybackMessageIdRef.current = operationId;
    try {
      await synthesizeSpeechStream(text, { messageId: operationId, ...(jobId ? { jobId } : {}) });
    } catch {
      if (mountedRef.current) setSynthesisStarting(false);
    } finally {
      if (mountedRef.current) setSynthesisRequestSettled(true);
    }
  }, [synthesizeSpeechStream]);
  const voice = useVoiceConversation(
    playReply, onApprovalRequest, onApprovalResolved,
    (jobId, operationId) => { void playReply("", operationId, jobId); },
    ttsProvider && typeof ttsSpeed === "number"
      ? { ttsProvider, voiceId: selectedVoiceId?.trim() || undefined, speedScale: ttsSpeed }
      : undefined,
  );
  useEffect(() => {
    if (historyExpanded && voice.ready) void voice.refreshHistory();
  }, [historyExpanded, voice.logicalConversationId, voice.ready, voice.refreshHistory, voice.turnStatus]);
  useEffect(() => {
    historyAtBottomRef.current = true;
  }, [historyExpanded, voice.logicalConversationId]);
  useEffect(() => {
    backdropOpacity.value = withTiming(historyExpanded ? 1 : 0, { duration: reduceMotion ? 0 : 240 });
  }, [backdropOpacity, historyExpanded, reduceMotion]);
  const footerSwipe = useMemo(() => Gesture.Pan()
    .enabled(!editingTranscript)
    .activeOffsetY([-24, 24])
    .failOffsetX([-32, 32])
    .onEnd(({ translationY }) => {
      if (translationY < -50) runOnJS(setHistoryExpanded)(true);
    }), [editingTranscript]);
  const replyLoading = voice.turnStatus === "accepted" || voice.turnStatus === "running";
  const playbackActive = synthesisStarting || isTtsPlaybackActive;
  const canStart = voice.ready && !replyLoading && voice.turnStatus !== "sending" && !playbackActive;
  const streamingStt = useStreamingStt({
    runnerUrl,
    runnerToken,
    transcript,
    autoReplyAfterStt: true,
    setTranscript,
    sendTranscript: voice.sendTranscript,
    onUsage: (usage) => footerRef.current?.updateUsage(usage),
    onSample: (sample) => footerRef.current?.pushSample(sample),
    onError: voice.setError,
    onDiagnostic: (event, payload) => logSessionDiag(event, {
      source: "voice_conversation",
      ...payload,
    }, { throttleMs: 0 }),
    canStart,
    onSpeechBegin: () => undefined,
    replyLoading,
    ttsPlaybackActive: playbackActive,
    voiceInputDuringTtsAllowed: false,
  });

  useEffect(() => {
    if (!initialStartPending || !canStart) return;
    setInitialStartPending(false);
    streamingStt.start();
  }, [canStart, initialStartPending, streamingStt.start]);

  useEffect(() => {
    if (synthesisStarting && (isTtsPlaybackActive || ttsUiStatus === "error"
      || (synthesisRequestSettled && ttsUiStatus === "idle"))) {
      setSynthesisStarting(false);
    }
  }, [isTtsPlaybackActive, synthesisRequestSettled, synthesisStarting, ttsUiStatus]);

  useEffect(() => () => {
    mountedRef.current = false;
    void streamingStt.abort();
    if (voicePlaybackMessageIdRef.current) {
      void stopTtsPlayback({
        interruptStream: true,
        reason: "voice_screen_closed",
        expectedMessageId: voicePlaybackMessageIdRef.current,
      });
    }
  }, [stopTtsPlayback, streamingStt.abort]);

  const voiceStatus = editingTranscript || voice.error || transcript || (voice.reply && ttsUiStatus === "error")
    ? undefined : isTtsPlaying || ttsUiStatus === "playing" ? "speaking" : replyLoading ? "responding" : playbackActive ? "speaking" : undefined;
  const statusLabel = voiceStatus === "responding" ? "responding..." : "speaking...";

  useEffect(() => {
    setStatusAnimation({ status: voiceStatus, frame: 0 });
    if (!voiceStatus || reduceMotion !== false) return;
    const timer = setInterval(() => setStatusAnimation((current) => ({
      status: voiceStatus,
      frame: current.status === voiceStatus ? current.frame + 1 : 1,
    })), 180);
    return () => clearInterval(timer);
  }, [voiceStatus, reduceMotion]);

  const frame = statusAnimation.status === voiceStatus ? statusAnimation.frame : 0;
  const animatedStatus = reduceMotion === true
    ? statusLabel
    : statusLabel.slice(0, frame % statusLabel.length + 1);
  const statusText = voice.error || (transcript || editingTranscript ? undefined
    : voice.reply && ttsUiStatus === "error" ? "音声再生に失敗しました。"
      : voiceStatus ? animatedStatus
          : initialStartPending || !streamingStt.active ? "録音を準備しています…" : "");

  return (
    <KeyboardAvoidingView
      testID="voice-conversation-keyboard-avoiding"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      automaticOffset={Platform.OS === "ios"}
      pointerEvents="box-none"
      style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, justifyContent: "flex-end" }}
    >
      <Reanimated.View testID="voice-conversation-backdrop"
        pointerEvents={historyExpanded ? "auto" : "none"}
        style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0, 0, 0, 0.68)" }, backdropStyle]} />
      <Reanimated.View
        testID="voice-conversation-transition"
        entering={voicePanelFadeIn}
        exiting={voicePanelFadeOut}
        pointerEvents="box-none"
        style={{ flex: 1, width: "100%" }}
      >
        <SafeAreaView testID="voice-conversation-screen" pointerEvents="box-none" style={{ flex: 1 }}>
          <View testID="voice-conversation-content" pointerEvents="box-none"
            style={{ flex: 1, justifyContent: "flex-end" }}>
            {historyExpanded ? (
              <Reanimated.View testID="voice-conversation-history"
                entering={reduceMotion ? undefined : historyFadeIn}
                exiting={reduceMotion ? undefined : historyFadeOut}
                style={{ flex: 1, width: "100%" }}>
                <View style={{ paddingHorizontal: 20, paddingTop: 12, alignItems: "flex-end" }}>
                  <Pressable testID="voice-history-close" accessibilityRole="button"
                    accessibilityLabel="履歴を閉じる" hitSlop={8}
                    onPress={() => setHistoryExpanded(false)}
                    style={{ width: 44, height: 44, borderRadius: 22,
                      alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0, 0, 0, 0.4)" }}>
                    <Ionicons name="close" size={24} color="#ffffff" />
                  </Pressable>
                </View>
                <ScrollView ref={historyScrollRef} testID="voice-history-messages" style={{ flex: 1 }}
                  onScroll={(event) => {
                    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
                    historyAtBottomRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
                  }}
                  scrollEventThrottle={16}
                  onContentSizeChange={() => {
                    if (historyAtBottomRef.current) historyScrollRef.current?.scrollToEnd({ animated: false });
                  }}
                  contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 12, gap: 12 }}>
                  {!voice.ready
                    ? <Text style={{ color: "#ffffff", textAlign: "center" }}>履歴を読み込み中…</Text>
                    : voice.historyError
                      ? <Text style={{ color: "#fecaca" }}>{voice.historyError}</Text>
                      : !voice.history.length
                        ? <Text style={{ color: "#ffffff", textAlign: "center" }}>履歴はまだありません</Text>
                        : null}
                  {(voice.ready ? voice.history : []).map((message, index) => (
                    <View key={`${message.clientOperationId}-${message.role}-${index}`}
                      style={{ alignSelf: message.role === "user" ? "flex-end" : "flex-start",
                        maxWidth: "90%", padding: 12, borderRadius: 12,
                        backgroundColor: message.role === "user" ? theme.colors.surfaceRaised : theme.colors.surfaceMuted }}>
                      <Text style={{ color: theme.colors.textMuted, fontSize: 11, marginBottom: 4 }}>
                        {message.role === "user" ? "あなた" : "AI"}
                      </Text>
                      <Text style={{ color: theme.colors.textPrimary, fontSize: 15, lineHeight: 21 }}>{message.text}</Text>
                    </View>
                  ))}
                </ScrollView>
              </Reanimated.View>
            ) : null}
            <View style={{ paddingHorizontal: 20, paddingBottom: 20 }}>
              <GestureDetector gesture={footerSwipe}>
                <View testID="voice-history-swipe-area">
                  <StreamingSttFooter
                    ref={footerRef}
                    transcript={transcript}
                    statusText={statusText}
                    voiceStatus={voiceStatus}
                    reduceMotion={reduceMotion !== false}
                    phase={streamingStt.phase}
                    onChangeText={setTranscript}
                    onFocus={() => {
                      setInitialStartPending(false);
                      setEditingTranscript(true);
                      streamingStt.stop();
                    }}
                    onBlur={() => setEditingTranscript(false)}
                    onSubmit={async (text, onAccepted) => {
                      try {
                        await streamingStt.sendManualTranscript(text, () => {
                          if (!onAccepted()) return false;
                          setEditingTranscript(false);
                          return true;
                        });
                      } catch (error) {
                        voice.setError(error instanceof Error ? error.message : String(error));
                      }
                    }}
                    onStop={() => {
                      voice.interrupt();
                      streamingStt.stop();
                      onClose();
                    }}
                    voiceContextStats={voice.contextStats}
                    historyExpanded={historyExpanded}
                    onHistoryToggle={() => setHistoryExpanded((expanded) => !expanded)}
                  />
                </View>
              </GestureDetector>
            </View>
          </View>
        </SafeAreaView>
      </Reanimated.View>
    </KeyboardAvoidingView>
  );
}
