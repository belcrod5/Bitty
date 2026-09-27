import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, Platform, SafeAreaView, ScrollView, Text, TouchableOpacity, useWindowDimensions, View } from "react-native";
import Reanimated, { FadeIn, FadeOut } from "react-native-reanimated";
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
  const { height: windowHeight } = useWindowDimensions();
  const footerRef = useRef<StreamingSttFooterHandle>(null);
  const historyScrollRef = useRef<ScrollView>(null);
  const historyAtTopRef = useRef(true);
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
    historyAtTopRef.current = true;
    historyAtBottomRef.current = true;
  }, [historyExpanded, voice.logicalConversationId]);
  const historyPan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => !editingTranscript && Math.abs(gesture.dy) > 20
      && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.2,
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dy < -50) setHistoryExpanded(true);
      if (gesture.dy > 50) setHistoryExpanded(false);
    },
  }), [editingTranscript]);
  const historyPanelPan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => historyAtTopRef.current
      && gesture.dy > 20 && gesture.dy > Math.abs(gesture.dx) * 1.2,
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dy > 50) setHistoryExpanded(false);
    },
  }), []);
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
      <Reanimated.View
        testID="voice-conversation-transition"
        entering={voicePanelFadeIn}
        exiting={voicePanelFadeOut}
        style={{ width: "100%" }}
      >
        <SafeAreaView testID="voice-conversation-screen">
          <View testID="voice-conversation-content" style={{ paddingHorizontal: 20, paddingBottom: 20 }}>
            {historyExpanded ? (
              <View testID="voice-conversation-history" {...historyPanelPan.panHandlers}
                style={{ maxHeight: windowHeight * 0.62,
                  marginBottom: 12, borderRadius: 16, backgroundColor: theme.colors.surface,
                  overflow: "hidden" }}>
                <TouchableOpacity testID="voice-history-handle" accessibilityRole="button"
                  accessibilityLabel="音声会話の履歴を閉じる" onPress={() => setHistoryExpanded(false)}
                  style={{ paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1,
                    borderBottomColor: theme.colors.border }}>
                  <Text style={{ color: theme.colors.textPrimary, textAlign: "center", fontSize: 14 }}>音声会話の履歴  ⌄</Text>
                </TouchableOpacity>
                <ScrollView ref={historyScrollRef} testID="voice-history-messages" style={{ flexShrink: 1 }}
                  onScroll={(event) => {
                    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
                    historyAtTopRef.current = contentOffset.y <= 1;
                    historyAtBottomRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
                  }}
                  scrollEventThrottle={16}
                  onContentSizeChange={() => {
                    if (historyAtBottomRef.current) historyScrollRef.current?.scrollToEnd({ animated: false });
                  }}
                  contentContainerStyle={{ padding: 16, gap: 12 }}>
                  {!voice.ready
                    ? <Text style={{ color: theme.colors.textMuted, textAlign: "center" }}>履歴を読み込み中…</Text>
                    : voice.historyError
                      ? <Text style={{ color: theme.colors.negativeText }}>{voice.historyError}</Text>
                      : !voice.history.length
                        ? <Text style={{ color: theme.colors.textMuted, textAlign: "center" }}>履歴はまだありません</Text>
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
              </View>
            ) : null}
            <View testID="voice-history-swipe-area" {...historyPan.panHandlers}>
              <TouchableOpacity testID="voice-history-open" accessibilityRole="button"
                accessibilityLabel={historyExpanded ? "音声会話の履歴を閉じる" : "音声会話の履歴を開く"}
                onPress={() => setHistoryExpanded((expanded) => !expanded)}
                style={{ alignItems: "center", paddingBottom: 8 }}>
                <Text style={{ color: theme.colors.textMuted, fontSize: 11 }}>{historyExpanded ? "⌄ 履歴を閉じる" : "⌃ 上にスワイプして履歴"}</Text>
              </TouchableOpacity>
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
            />
            </View>
          </View>
        </SafeAreaView>
      </Reanimated.View>
    </KeyboardAvoidingView>
  );
}
