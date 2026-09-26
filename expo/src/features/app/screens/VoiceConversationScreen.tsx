import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, SafeAreaView, View } from "react-native";
import Reanimated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useStreamingStt } from "../../stt/useStreamingStt";
import { StreamingSttFooter, type StreamingSttFooterHandle } from "../components/StreamingSttFooter";
import { useChatScreen } from "../contexts/ChatScreenContext";
import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import { KeyboardAvoidingView } from "../keyboardController";
import { useVoiceConversation } from "../hooks/useVoiceConversation";
import type { ApprovalAction, ApprovalRequest } from "../../codex/approvalFlow";

const voicePanelFadeIn = FadeIn.duration(220);
const voicePanelFadeOut = FadeOut.duration(220);

export type VoiceConversationPlayback = {
  synthesizeSpeechStream: (text: string, target: { messageId: string }) => Promise<void>;
  stopTtsPlayback: (options?: { interruptStream?: boolean; reason?: string; expectedMessageId?: string }) => Promise<void>;
  isTtsPlaybackActive: boolean;
  ttsUiStatus: "idle" | "queued" | "synthesizing" | "playing" | "error";
  onApprovalRequest?: (request: ApprovalRequest) => Promise<ApprovalAction>;
  onApprovalResolved?: (request: ApprovalRequest) => void;
};

export function VoiceConversationScreen({
  synthesizeSpeechStream,
  stopTtsPlayback,
  isTtsPlaybackActive,
  ttsUiStatus,
  onApprovalRequest,
  onApprovalResolved,
  onClose,
}: VoiceConversationPlayback & { onClose: () => void }) {
  const { runnerUrl, runnerToken } = useChatScreen();
  const reduceMotion = useReduceMotionEnabled();
  const [transcript, setTranscript] = useState("");
  const [editingTranscript, setEditingTranscript] = useState(false);
  const [initialStartPending, setInitialStartPending] = useState(true);
  const [synthesisStarting, setSynthesisStarting] = useState(false);
  const [synthesisRequestSettled, setSynthesisRequestSettled] = useState(false);
  const [statusAnimation, setStatusAnimation] = useState<{ status?: "responding" | "speaking"; frame: number }>({ frame: 0 });
  const footerRef = useRef<StreamingSttFooterHandle>(null);
  const mountedRef = useRef(true);
  const voicePlaybackMessageIdRef = useRef("");

  const playReply = useCallback(async (text: string, operationId: string) => {
    if (!mountedRef.current) return;
    setSynthesisStarting(true);
    setSynthesisRequestSettled(false);
    voicePlaybackMessageIdRef.current = operationId;
    try {
      await synthesizeSpeechStream(text, { messageId: operationId });
    } catch {
      if (mountedRef.current) setSynthesisStarting(false);
    } finally {
      if (mountedRef.current) setSynthesisRequestSettled(true);
    }
  }, [synthesizeSpeechStream]);
  const voice = useVoiceConversation(playReply, onApprovalRequest, onApprovalResolved);
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
    ? undefined : replyLoading ? "responding" : playbackActive ? "speaking" : undefined;
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
                await streamingStt.sendManualTranscript(text, () => {
                  if (!onAccepted()) return false;
                  setEditingTranscript(false);
                  return true;
                });
              }}
              onStop={() => {
                streamingStt.stop();
                onClose();
              }}
              voiceContextStats={voice.contextStats}
            />
          </View>
        </SafeAreaView>
      </Reanimated.View>
    </KeyboardAvoidingView>
  );
}
