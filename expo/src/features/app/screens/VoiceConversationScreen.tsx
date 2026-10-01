import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Platform, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, { FadeIn, FadeInDown, FadeOut, FadeOutDown, runOnJS } from "react-native-reanimated";
import { useStreamingStt } from "../../stt/useStreamingStt";
import { StreamingSttFooter, type StreamingSttFooterHandle } from "../components/StreamingSttFooter";
import { VoiceHistoryBackdrop } from "../components/VoiceHistoryBackdrop";
import { CodexStatusSummaryMenu } from "../components/CodexStatusSummaryMenu";
import { VoiceOrchestratorIcon, type VoiceOrchestrator } from "../components/VoiceOrchestratorIcon";
import { VoiceOrchestratorManager } from "../components/VoiceOrchestratorManager";
import { useChatScreen } from "../contexts/ChatScreenContext";
import { useConversation } from "../contexts/ConversationContext";
import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import { KeyboardAvoidingView } from "../keyboardController";
import { useVoiceConversation } from "../hooks/useVoiceConversation";
import { useVoiceApprovals } from "../hooks/useVoiceApprovals";
import { useRunnerWebSocketManager, useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { formatMessageTimestampLabel } from "../utils/formatting";
import { formatOutputTokens } from "../utils/messageTokens";
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

export function VoiceConversationScreen(props: VoiceConversationPlayback & { onClose: () => void }) {
  const manager = useRunnerWebSocketManager();
  const { connected, generation } = useRunnerWebSocketSnapshot();
  const [list, setList] = useState<{ orchestrators: VoiceOrchestrator[]; selectedId: string } | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [revision, setRevision] = useState(0);
  const [managerOpen, setManagerOpen] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [loadError, setLoadError] = useState("");
  useVoiceApprovals(props.onApprovalRequest, props.onApprovalResolved, list?.orchestrators || []);

  useEffect(() => {
    let current = true;
    void manager.connect().then(() => manager.request({ channel: "agent", op: "voice.orchestrators.list" }))
      .then((response) => {
        if (!current) return;
        const value = response.payload as { orchestrators?: VoiceOrchestrator[]; selectedId?: string } | undefined;
        if (response.op !== "voice.orchestrators.list.result" || !Array.isArray(value?.orchestrators)
          || typeof value.selectedId !== "string" || !value.orchestrators.some((item) => item.id === value.selectedId)) {
          throw new Error("オーケストレータを読み込めません。");
        }
        setList({ orchestrators: value.orchestrators, selectedId: value.selectedId });
        setSelectedId(value.selectedId);
        setLoadError("");
      }).catch((cause) => { if (current) setLoadError(cause instanceof Error ? cause.message : "接続できません。"); });
    return () => { current = false; };
  }, [connected, generation, manager]);

  const select = useCallback(async (id: string) => {
    const response = await manager.request({ channel: "agent", op: "voice.orchestrators.select",
      payload: { orchestratorId: id } });
    if (response.op !== "voice.orchestrators.select.result") throw new Error("切り替えられません。");
    const value = response.payload as { orchestrators: VoiceOrchestrator[]; selectedId: string };
    setList(value);
    setSelectedId(value.selectedId);
  }, [manager]);

  const listChanged = useCallback((value: { orchestrators: VoiceOrchestrator[]; selectedId: string }) => {
    setList(value);
    setSelectedId(value.selectedId);
  }, []);
  const conversationChanged = useCallback((id: string) => {
    if (id === selectedId || !list?.orchestrators.some((item) => item.id === selectedId)) {
      setRevision((current) => current + 1);
    }
  }, [list, selectedId]);
  const selected = list?.orchestrators.find((item) => item.id === selectedId);

  return <>
    {selected && list ? <VoiceConversationSession key={`${selected.id}-${revision}`} {...props}
      orchestrator={selected} orchestrators={list.orchestrators} onSelect={select}
      onManage={() => setManagerOpen(true)} paused={managerOpen}
      historyExpanded={historyExpanded} setHistoryExpanded={setHistoryExpanded} /> : (
      <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: "#ffffff" }}>{loadError || "音声会話を読み込み中…"}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="音声会話を閉じる"
          onPress={props.onClose} style={{ marginTop: 20, padding: 12 }}>
          <Text style={{ color: "#ffffff" }}>閉じる</Text>
        </Pressable>
      </View>
    )}
    {list ? <VoiceOrchestratorManager visible={managerOpen} list={list}
      onListChanged={listChanged} onConversationChanged={conversationChanged}
      onClose={() => setManagerOpen(false)} /> : null}
  </>;
}

function VoiceConversationSession({
  synthesizeSpeechStream,
  stopTtsPlayback,
  isTtsPlaybackActive,
  isTtsPlaying,
  ttsUiStatus,
  ttsProvider,
  selectedVoiceId,
  ttsSpeed,
  onClose,
  orchestrator,
  orchestrators,
  onSelect,
  onManage,
  paused,
  historyExpanded,
  setHistoryExpanded,
}: VoiceConversationPlayback & { onClose: () => void; orchestrator: VoiceOrchestrator;
  orchestrators: VoiceOrchestrator[]; onSelect: (id: string) => Promise<void>; onManage: () => void;
  paused: boolean; historyExpanded: boolean; setHistoryExpanded: (value: boolean | ((current: boolean) => boolean)) => void }) {
  const { runnerUrl, runnerToken } = useChatScreen();
  const { logSessionDiag } = useConversation();
  const reduceMotion = useReduceMotionEnabled();
  const { theme } = useVisualTheme();
  const [transcript, setTranscript] = useState("");
  const [editingTranscript, setEditingTranscript] = useState(false);
  const [initialStartPending, setInitialStartPending] = useState(true);
  const [synthesisStarting, setSynthesisStarting] = useState(false);
  const [synthesisRequestSettled, setSynthesisRequestSettled] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [statusAnimation, setStatusAnimation] = useState<{ status?: "responding" | "speaking"; frame: number }>({ frame: 0 });
  const footerRef = useRef<StreamingSttFooterHandle>(null);
  const historyScrollRef = useRef<ScrollView>(null);
  const historyAtBottomRef = useRef(true);
  const mountedRef = useRef(true);
  const transitioningRef = useRef(false);
  const wasPausedRef = useRef(paused);
  const voicePlaybackMessageIdRef = useRef("");

  const playReply = useCallback(async (text: string, operationId: string, jobId?: string) => {
    if (!mountedRef.current || paused || transitioningRef.current) return;
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
  }, [paused, synthesizeSpeechStream]);
  const voice = useVoiceConversation(
    playReply,
    (jobId, operationId) => { void playReply("", operationId, jobId); },
    ttsProvider && typeof ttsSpeed === "number"
      ? { ttsProvider, voiceId: selectedVoiceId?.trim() || undefined, speedScale: ttsSpeed }
      : undefined,
    orchestrator.id,
  );
  useEffect(() => {
    if (historyExpanded && voice.ready) void voice.refreshHistory();
  }, [historyExpanded, voice.logicalConversationId, voice.ready, voice.refreshHistory, voice.turnStatus]);
  useEffect(() => {
    historyAtBottomRef.current = true;
  }, [historyExpanded, voice.logicalConversationId]);
  const footerSwipe = useMemo(() => Gesture.Pan()
    .enabled(!editingTranscript)
    .activeOffsetY([-24, 24])
    .failOffsetX([-32, 32])
    .onEnd(({ translationY }) => {
      if (translationY < -50) runOnJS(setHistoryExpanded)(true);
    }), [editingTranscript]);
  const replyLoading = voice.turnStatus === "accepted" || voice.turnStatus === "running";
  const playbackActive = synthesisStarting || isTtsPlaybackActive;
  const canStart = !paused && !transitioning && voice.ready && !replyLoading && voice.turnStatus !== "sending" && !playbackActive;
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

  const quietAudio = useCallback(async () => {
    await streamingStt.abort();
    setTranscript("");
    setEditingTranscript(false);
    const messageId = voicePlaybackMessageIdRef.current;
    if (messageId) {
      voicePlaybackMessageIdRef.current = "";
      await stopTtsPlayback({ interruptStream: true, reason: "voice_orchestrator_changed",
        expectedMessageId: messageId });
    }
  }, [stopTtsPlayback, streamingStt.abort]);

  const switchTo = useCallback(async (id: string) => {
    if (id === orchestrator.id || transitioningRef.current) return;
    transitioningRef.current = true;
    setTransitioning(true);
    try { await quietAudio(); await onSelect(id); }
    catch (cause) {
      transitioningRef.current = false;
      setTransitioning(false);
      voice.setError(cause instanceof Error ? cause.message : "切り替えられません。");
    }
  }, [onSelect, orchestrator.id, quietAudio, voice.setError]);

  const openManager = useCallback(async () => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    setTransitioning(true);
    try { await quietAudio(); onManage(); }
    catch (cause) {
      transitioningRef.current = false;
      setTransitioning(false);
      voice.setError(cause instanceof Error ? cause.message : "管理画面を開けません。");
    }
  }, [onManage, quietAudio, voice.setError]);

  useEffect(() => {
    if (wasPausedRef.current && !paused) {
      transitioningRef.current = false;
      setTransitioning(false);
      setInitialStartPending(true);
    }
    wasPausedRef.current = paused;
  }, [paused]);

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

  const cancelSpeaking = useCallback(() => {
    const messageId = voicePlaybackMessageIdRef.current;
    if (!messageId) return;
    setSynthesisStarting(false);
    setSynthesisRequestSettled(true);
    void stopTtsPlayback({
      interruptStream: true,
      reason: "voice_speaking_tapped",
      expectedMessageId: messageId,
    });
  }, [stopTtsPlayback]);

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
  const historyMessages = useMemo(() => {
    if (!voice.ready) return [];
    const reply = voice.reply;
    if (!reply?.text || voice.history.some((message) =>
      message.role === "assistant" && message.clientOperationId === reply.operationId)) return voice.history;
    return [...voice.history, { role: "assistant" as const, text: reply.text, clientOperationId: reply.operationId,
      outputTokens: reply.outputTokens }];
  }, [voice.history, voice.ready, voice.reply]);

  return (
    <KeyboardAvoidingView
      testID="voice-conversation-keyboard-avoiding"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      automaticOffset={Platform.OS === "ios"}
      pointerEvents="box-none"
      style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, justifyContent: "flex-end" }}
    >
      <VoiceHistoryBackdrop expanded={historyExpanded} reduceMotion={reduceMotion === true} />
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
                <View style={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8,
                  flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <Pressable testID="voice-orchestrator-strip" style={{ flex: 1 }}
                    onLongPress={() => void openManager()}
                    onPointerDown={(event) => { if (event.nativeEvent.button === 2) void openManager(); }}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}
                      contentContainerStyle={{ alignItems: "center", paddingRight: 12 }}>
                      {orchestrators.map((item) => (
                        <Pressable key={item.id} testID={`voice-orchestrator-${item.id}`}
                          accessibilityRole="button" accessibilityLabel={`${item.name}に切り替え`}
                          style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
                          onPress={() => void switchTo(item.id)} onLongPress={() => void openManager()}>
                          <VoiceOrchestratorIcon orchestrator={item} size={34} active={item.id === orchestrator.id} />
                        </Pressable>
                      ))}
                    </ScrollView>
                  </Pressable>
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
                  contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 64, gap: 12 }}>
                  {!voice.ready
                    ? <Text style={{ color: "#ffffff", textAlign: "center" }}>履歴を読み込み中…</Text>
                    : voice.historyError
                      ? <Text style={{ color: "#fecaca" }}>{voice.historyError}</Text>
                      : !historyMessages.length
                        ? <Text style={{ color: "#ffffff", textAlign: "center" }}>履歴はまだありません</Text>
                        : null}
                  {historyMessages.map((message, index) => {
                    const user = message.role === "user";
                    const textColor = user ? theme.colors.textOnAccent : theme.colors.textPrimary;
                    const time = formatMessageTimestampLabel(message.at);
                    const tokenLabel = !user && Number.isSafeInteger(message.outputTokens)
                      && Number(message.outputTokens) >= 0
                      ? formatOutputTokens(message.outputTokens)
                      : "";
                    return (
                      <View key={`${message.clientOperationId}-${message.role}-${index}`}
                        style={{ alignSelf: user ? "flex-end" : "flex-start",
                          maxWidth: "90%", padding: 12, borderRadius: 12,
                          backgroundColor: user ? theme.colors.accent : theme.colors.surfaceMuted }}>
                        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                          <Text style={{ color: textColor, fontSize: 11 }}>{user ? "あなた" : "AI"}</Text>
                          {time || tokenLabel ? (
                            <Text style={{ color: textColor, fontSize: 11 }}>
                              {[time, tokenLabel].filter(Boolean).join("  ")}
                            </Text>
                          ) : null}
                        </View>
                        <Text style={{ color: textColor, fontSize: 15, lineHeight: 21 }}>{message.text}</Text>
                      </View>
                    );
                  })}
                </ScrollView>
                {voice.ready ? (
                  <View testID="voice-history-account-menu"
                    style={{ position: "absolute", right: 20, bottom: 12, zIndex: 1 }}>
                    <CodexStatusSummaryMenu />
                  </View>
                ) : null}
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
                    onCancelSpeaking={cancelSpeaking}
                    onStop={() => {
                      voice.interrupt();
                      streamingStt.stop();
                      onClose();
                    }}
                    voiceContextStats={voice.contextStats}
                    historyExpanded={historyExpanded}
                    onHistoryToggle={() => setHistoryExpanded((expanded) => !expanded)}
                    leadingAccessory={!historyExpanded ? (
                      <Pressable testID="voice-orchestrator-floating" accessibilityRole="button"
                        accessibilityLabel={`${orchestrator.name}・履歴を開く`}
                        onPress={() => setHistoryExpanded(true)} onLongPress={() => void openManager()}
                        onPointerDown={(event) => { if (event.nativeEvent.button === 2) void openManager(); }}
                        style={{ width: 30, height: 30 }}>
                        <VoiceOrchestratorIcon orchestrator={orchestrator} size={30} active />
                      </Pressable>
                    ) : undefined}
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
