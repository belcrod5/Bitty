import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { randomUUID } from "expo-crypto";
import { AppState, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, { FadeIn, FadeOut, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useControlledStreamingStt } from "../../appControl/useControlledStreamingStt";
import { getVoiceControl } from "../../appControl/voiceControl";
import { StreamingSttFooter, type StreamingSttFooterHandle } from "../components/StreamingSttFooter";
import { VoiceHistoryBackdrop, getMacVoiceBlurView } from "../components/VoiceHistoryBackdrop";
import { ContextUsageIndicator } from "../components/ContextUsageIndicator";
import { CodexStatusSummaryMenu } from "../components/CodexStatusSummaryMenu";
import { VoiceOrchestratorIcon, type VoiceOrchestrator } from "../components/VoiceOrchestratorIcon";
import { VoiceOrchestratorManager } from "../components/VoiceOrchestratorManager";
import { VoiceResetConfirmationModal } from "../components/VoiceResetConfirmationModal";
import { UserInputModal } from "../components/UserInputModal";
import { useVoiceUserInput } from "../hooks/useVoiceUserInput";
import { useChatScreen } from "../contexts/ChatScreenContext";
import { useConversation } from "../contexts/ConversationContext";
import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import { KeyboardAvoidingView } from "../keyboardController";
import { useVoiceConversation } from "../hooks/useVoiceConversation";
import { useRunnerWebSocketManager, useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { formatMessageTimestampLabel } from "../utils/formatting";
import { formatOutputTokens } from "../utils/messageTokens";
import { dismissReadVoiceNotifications } from "../utils/sessionReadNotifications";
import { parseChecklistFile } from "../utils/checklistFile";
import { DEFAULT_TTS_PROVIDER } from "../utils/audioConfig";
import type { TtsPlaybackTarget } from "../types/appTypes";

const voicePanelFadeIn = FadeIn.duration(220);
const voicePanelFadeOut = FadeOut.duration(220);

export type VoiceConversationPlayback = {
  synthesizeSpeechStream: (text: string, target: TtsPlaybackTarget & { messageId: string }) => Promise<void>;
  stopTtsPlayback: (options?: { interruptStream?: boolean; reason?: string; expectedMessageId?: string }) => Promise<void>;
  isTtsPlaybackActive: boolean;
  isTtsPlaying?: boolean;
  ttsUiStatus: "idle" | "queued" | "synthesizing" | "playing" | "error";
  ttsSpeed?: number;
  runnerBaseUrl?: string;
  runnerToken?: string;
};

export function VoiceConversationScreen(props: VoiceConversationPlayback & { onClose: () => void; initialOrchestratorId?: string; initialControlSignal?: AbortSignal }) {
  const manager = useRunnerWebSocketManager();
  const { connected, generation } = useRunnerWebSocketSnapshot();
  const [list, setList] = useState<{ orchestrators: VoiceOrchestrator[]; selectedId: string } | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [revision, setRevision] = useState(0);
  const [managerOpen, setManagerOpen] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(Boolean(props.initialOrchestratorId));
  const consumedInitialTargetRef = useRef("");
  useEffect(() => { if (props.initialOrchestratorId) setHistoryExpanded(true); }, [props.initialOrchestratorId]);
  const [loadError, setLoadError] = useState("");
  const listRevisionRef = useRef(0);
  const userInput = useVoiceUserInput(manager, managerOpen ? "" : selectedId);

  const applyList = useCallback((value: { orchestrators: VoiceOrchestrator[]; selectedId: string }) => {
    setList(value);
    if (props.initialOrchestratorId) {
      const target = props.initialOrchestratorId;
      const newTarget = consumedInitialTargetRef.current !== target;
      consumedInitialTargetRef.current = target;
      setSelectedId((current) => {
        if (newTarget || current === target || !current) {
          return value.orchestrators.some((item) => item.id === target) ? target : "";
        }
        return value.orchestrators.some((item) => item.id === current) ? current : value.selectedId;
      });
    } else {
      setSelectedId((current) => value.orchestrators.some((item) => item.id === current)
        ? current : value.selectedId);
    }
  }, [props.initialOrchestratorId]);

  useEffect(() => {
    let current = true;
    const revision = listRevisionRef.current;
    void manager.connect().then(() => manager.request({ channel: "agent", op: "voice.orchestrators.list" }))
      .then((response) => {
        if (!current || revision !== listRevisionRef.current) return;
        const value = response.payload as { orchestrators?: VoiceOrchestrator[]; selectedId?: string } | undefined;
        if (response.op !== "voice.orchestrators.list.result" || !Array.isArray(value?.orchestrators)
          || typeof value.selectedId !== "string" || !value.orchestrators.some((item) => item.id === value.selectedId)) {
          throw new Error("オーケストレータを読み込めません。");
        }
        applyList({ orchestrators: value.orchestrators, selectedId: value.selectedId });
        setLoadError("");
      }).catch((cause) => { if (current) setLoadError(cause instanceof Error ? cause.message : "接続できません。"); });
    return () => { current = false; };
  }, [applyList, connected, generation, manager]);

  useEffect(() => manager.subscribe({ channel: "agent", op: "voice.unread.changed" }, (message) => {
    const value = message.payload as { orchestrators?: VoiceOrchestrator[]; selectedId?: string } | undefined;
    if (Array.isArray(value?.orchestrators) && typeof value.selectedId === "string") {
      listRevisionRef.current += 1;
      applyList({ orchestrators: value.orchestrators, selectedId: value.selectedId });
    }
  }), [applyList, manager]);

  const select = useCallback(async (id: string) => {
    const response = await manager.request({ channel: "agent", op: "voice.orchestrators.select",
      payload: { orchestratorId: id } });
    if (response.op !== "voice.orchestrators.select.result") throw new Error("切り替えられません。");
    const value = response.payload as { orchestrators: VoiceOrchestrator[]; selectedId: string };
    listRevisionRef.current += 1;
    setList(value);
    setSelectedId(value.selectedId);
  }, [manager]);

  const listChanged = useCallback((value: { orchestrators: VoiceOrchestrator[]; selectedId: string }) => {
    listRevisionRef.current += 1;
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
    <UserInputModal request={userInput.request} onDecide={userInput.decide} />
    {selected && list ? <VoiceConversationSession key={`${selected.id}-${revision}`} {...props}
      orchestrator={selected} orchestrators={list.orchestrators} onSelect={select}
      onManage={() => setManagerOpen(true)} paused={managerOpen}
      historyExpanded={historyExpanded} setHistoryExpanded={setHistoryExpanded} /> : (
      <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: "#ffffff" }}>{loadError || (list
          ? "指定したオーケストレータが見つかりません。" : "音声会話を読み込み中…")}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="音声会話を閉じる"
          onPress={props.onClose} style={{ marginTop: 20, padding: 12 }}>
          <Text style={{ color: "#ffffff" }}>閉じる</Text>
        </Pressable>
      </View>
    )}
    {list ? <VoiceOrchestratorManager visible={managerOpen} list={list}
      onListChanged={listChanged} onConversationChanged={conversationChanged}
      runnerBaseUrl={props.runnerBaseUrl} runnerToken={props.runnerToken}
      onClose={() => setManagerOpen(false)} /> : null}
  </>;
}

function VoiceConversationSession({
  initialControlSignal,
  synthesizeSpeechStream,
  stopTtsPlayback,
  isTtsPlaybackActive,
  isTtsPlaying,
  ttsUiStatus,
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
  initialControlSignal?: AbortSignal;
  paused: boolean; historyExpanded: boolean; setHistoryExpanded: (value: boolean | ((current: boolean) => boolean)) => void }) {
  const { runnerUrl, runnerToken } = useChatScreen();
  const { logSessionDiag } = useConversation();
  const reduceMotion = useReduceMotionEnabled();
  const { theme } = useVisualTheme();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const IosBlurView = useMemo(() => Platform.OS === "ios"
    ? require("expo-blur").BlurView as typeof import("expo-blur").BlurView : null, []);
  const MacBlurView = Platform.OS === "macos" ? getMacVoiceBlurView() : null;
  const [taskChecklistOpen, setTaskChecklistOpen] = useState(true);
  const [taskChecklistOriginal, setTaskChecklistOriginal] = useState(false);
  const [checklistCompletionBusy, setChecklistCompletionBusy] = useState(false);
  const [checklistCompletionError, setChecklistCompletionError] = useState("");
  const [transcript, setTranscript] = useState("");
  const [editingTranscript, setEditingTranscript] = useState(false);
  const [historyMounted, setHistoryMounted] = useState(historyExpanded);
  const historyHeight = useSharedValue(historyExpanded ? screenHeight : 0);
  const historyDragActive = useSharedValue(false);
  const historyStyle = useAnimatedStyle(() => ({ height: historyHeight.value }));
  const [initialStartPending, setInitialStartPending] = useState(!initialControlSignal);
  const [synthesisStarting, setSynthesisStarting] = useState(false);
  const [synthesisRequestSettled, setSynthesisRequestSettled] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  const [statusAnimation, setStatusAnimation] = useState<{ status?: "responding" | "speaking"; frame: number }>({ frame: 0 });
  const footerRef = useRef<StreamingSttFooterHandle>(null);
  const historyScrollRef = useRef<ScrollView>(null);
  const historyAtBottomRef = useRef(true);
  const mountedRef = useRef(true);
  const voiceSurfaceIdRef = useRef("");
  const manager = useRunnerWebSocketManager();
  const transitioningRef = useRef(false);
  const wasPausedRef = useRef(paused);
  const startAnnouncedRef = useRef(Boolean(initialControlSignal));
  const voicePlaybackMessageIdRef = useRef("");

  useEffect(() => {
    if (historyExpanded) setHistoryMounted(true);
    historyHeight.value = withTiming(historyExpanded ? screenHeight : 0,
      { duration: reduceMotion === true ? 0 : 240 }, (finished) => {
        if (finished && !historyExpanded) runOnJS(setHistoryMounted)(false);
      });
  }, [historyExpanded, historyHeight, reduceMotion, screenHeight]);

  const playSpeech = useCallback(async (text: string, operationId: string, jobId?: string) => {
    if (!mountedRef.current || paused || transitioningRef.current
      || (voiceSurfaceIdRef.current && !getVoiceControl(manager).allowsSpeech(voiceSurfaceIdRef.current, { kind: "orchestrator", orchestratorId: orchestrator.id }))) return;
    setSynthesisStarting(true);
    setSynthesisRequestSettled(false);
    voicePlaybackMessageIdRef.current = operationId;
    try {
      await synthesizeSpeechStream(text, { scope: "voice", orchestratorId: orchestrator.id, messageId: operationId, ...(jobId ? { jobId } : {}),
        ttsProvider: orchestrator.ttsProvider || DEFAULT_TTS_PROVIDER, voiceId: orchestrator.voiceId || "" });
    } catch {
      if (mountedRef.current) setSynthesisStarting(false);
    } finally {
      if (mountedRef.current) setSynthesisRequestSettled(true);
    }
  }, [paused, synthesizeSpeechStream, orchestrator.id, orchestrator.ttsProvider, orchestrator.voiceId]);
  const voice = useVoiceConversation(
    playSpeech,
    (jobId, operationId) => { void playSpeech("", operationId, jobId); },
    typeof ttsSpeed === "number" ? { speedScale: ttsSpeed } : undefined,
    orchestrator.id,
  );
  const isOverviewMode = voice.taskChecklist?.status === "present"
    && Boolean(voice.taskChecklist.markdown.trim()) && Boolean(voice.taskChecklistOverview)
    && !taskChecklistOriginal;
  const taskChecklistRows = useMemo(() => {
    if (voice.taskChecklist?.status !== "present") return [];
    if (isOverviewMode && voice.taskChecklistOverview?.status !== "present") return [];
    const markdown = isOverviewMode && voice.taskChecklistOverview?.status === "present"
      ? voice.taskChecklistOverview.markdown : voice.taskChecklist.markdown;
    return markdown.split(/\r?\n/u).flatMap<
      { kind: "item"; checked: boolean; text: string } | { kind: "text"; text: string }
    >((line) => {
      if (!line.trim()) return [];
      try {
        const [item] = parseChecklistFile(line);
        return [{ kind: "item" as const, ...item }];
      } catch {
        return [{ kind: "text" as const, text: line }];
      }
    });
  }, [isOverviewMode, voice.taskChecklist, voice.taskChecklistOverview]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setAppActive(state === "active"));
    return () => subscription.remove();
  }, []);
  useEffect(() => manager.subscribe({ channel: "agent", op: "voice.unread.changed" }, (message) => {
    if (historyExpanded && appActive && !paused && (message.payload as { orchestrators?: VoiceOrchestrator[] })
      ?.orchestrators?.some((item) => item.id === orchestrator.id)) void voice.refreshHistory();
  }), [appActive, historyExpanded, manager, orchestrator.id, paused, voice.refreshHistory]);
  useEffect(() => {
    if (!appActive || paused || !voice.ready) return;
    const historyOrdinal = historyExpanded
      ? voice.history.reduce((max, message) => Math.max(max, message.completedOrdinal || 0), 0) : 0;
    const ordinal = Math.max(historyOrdinal, voice.reply?.completedOrdinal || 0);
    if (!ordinal) return;
    void manager.request({ channel: "agent", op: "voice.read", payload: {
      orchestratorId: orchestrator.id, logicalConversationId: voice.logicalConversationId,
      completedOrdinal: ordinal,
    } }).then((response) => {
      if (response.op === "voice.read.result") void dismissReadVoiceNotifications(
        orchestrator.id, voice.logicalConversationId, ordinal).catch(() => undefined);
    }).catch(() => undefined);
  }, [appActive, historyExpanded, manager, orchestrator.id, paused, voice.history,
    voice.logicalConversationId, voice.ready, voice.reply?.completedOrdinal]);
  useEffect(() => {
    historyAtBottomRef.current = true;
  }, [historyExpanded, voice.logicalConversationId]);
  const replyLoading = voice.turnStatus === "accepted" || voice.turnStatus === "running";
  const playbackActive = synthesisStarting || isTtsPlaybackActive;
  const canStart = appActive && !paused && !transitioning && voice.ready && !replyLoading && voice.turnStatus !== "sending" && !playbackActive;
  const streamingStt = useControlledStreamingStt({
    target: { kind: "orchestrator", orchestratorId: orchestrator.id },
    busy: replyLoading || voice.turnStatus === "sending",
    announce: async (signal) => {
      const messageId = `voice-start-${randomUUID()}`;
      const cancel = () => { void stopTtsPlayback({ interruptStream: true, expectedMessageId: messageId, reason: "voice_control_cancelled" }); };
      signal.addEventListener("abort", cancel, { once: true });
      try { if (!signal.aborted) await playSpeech(`${orchestrator.name}に切り替えました。合図の後に話してください。`, messageId); }
      finally { signal.removeEventListener("abort", cancel); }
    },
    runnerUrl,
    runnerToken,
    transcript,
    autoReplyAfterStt: true,
    correctionContext: [
      ...voice.history.filter((message) => message.text.trim()),
      ...(voice.reply?.text && !voice.history.some((message) => message.role === "assistant"
        && message.clientOperationId === voice.reply?.operationId)
        ? [{ role: "assistant" as const, text: voice.reply.text }] : []),
    ].slice(-12).map((message) => ({ role: message.role, text: message.text.slice(0, 2000) })),
    correctionIdentity: `${orchestrator.id}:${voice.logicalConversationId}`,
    setTranscript,
    sendTranscript: voice.sendTranscript,
    onUsage: (usage) => footerRef.current?.updateUsage(usage),
    onSample: (sample) => footerRef.current?.pushSample(sample),
    onError: voice.setError,
    onDiagnostic: (event, payload) => logSessionDiag(event, {
      source: "voice_conversation",
      paused, transitioning, ready: voice.ready, replyLoading, turnStatus: voice.turnStatus, playbackActive,
      ...payload,
    }, { throttleMs: 0 }),
    canStart,
    onSpeechBegin: () => undefined,
    replyLoading,
    ttsPlaybackActive: playbackActive,
    voiceInputDuringTtsAllowed: false,
  });
  voiceSurfaceIdRef.current = streamingStt.surfaceId;
  useEffect(() => {
    if (streamingStt.phase !== "connecting" || canStart) return;
    logSessionDiag("stt_start_gate_changed", {
      source: "voice_conversation", paused, transitioning, ready: voice.ready,
      replyLoading, turnStatus: voice.turnStatus, playbackActive,
    }, { throttleMs: 0 });
  }, [streamingStt.phase, canStart, paused, transitioning, voice.ready, replyLoading, voice.turnStatus, playbackActive]);
  const footerSwipe = useMemo(() => Gesture.Pan()
    .enabled(!editingTranscript && !streamingStt.correctionPreview?.editing)
    .activeOffsetY([-24, 24])
    .failOffsetX([-32, 32])
    .onStart(() => {
      if (!historyExpanded) {
        historyDragActive.value = true;
        historyHeight.value = 0;
        runOnJS(setHistoryMounted)(true);
      }
    })
    .onUpdate(({ translationY }) => {
      if (!historyExpanded) historyHeight.value = Math.min(screenHeight, Math.max(0, -translationY));
    })
    .onFinalize(({ translationY }, success) => {
      if (!historyDragActive.value) return;
      historyDragActive.value = false;
      if (historyExpanded) return;
      if (success && translationY < -50) {
        runOnJS(setHistoryExpanded)(true);
      } else {
        historyHeight.value = withTiming(0, { duration: reduceMotion === true ? 0 : 200 }, (finished) => {
          if (finished) runOnJS(setHistoryMounted)(false);
        });
      }
    }), [editingTranscript, historyDragActive, historyExpanded, historyHeight, reduceMotion,
      screenHeight, setHistoryExpanded, streamingStt.correctionPreview?.editing]);

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
    if (streamingStt.active) { setInitialStartPending(false); return; }
    if (!initialStartPending || !canStart || streamingStt.remotePending()) return;
    if (!startAnnouncedRef.current) {
      startAnnouncedRef.current = true;
      void streamingStt.claim().then((claimed) => {
        if (claimed) return playSpeech(`${orchestrator.name}で音声入力を準備します`, `voice-start-${randomUUID()}`);
      }).catch(() => voice.setError("音声入力を準備できませんでした。"));
      return;
    }
    setInitialStartPending(false);
    streamingStt.start();
  }, [canStart, initialStartPending, orchestrator.name, playSpeech, streamingStt.start, synthesisRequestSettled, initialControlSignal]);

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
          : initialStartPending ? "録音を準備しています…" : !streamingStt.active ? "音声入力は停止しています。再開するには画面を開き直してください。" : "");
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
      <VoiceResetConfirmationModal request={voice.resetConfirmation} />
      <VoiceHistoryBackdrop expanded={historyExpanded} visible={historyMounted}
        height={historyHeight} />
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
            {historyMounted ? (
              <Reanimated.View testID="voice-conversation-history"
                pointerEvents={historyExpanded ? "auto" : "none"}
                accessibilityElementsHidden={!historyExpanded}
                importantForAccessibility={historyExpanded ? "auto" : "no-hide-descendants"}
                style={[{ flexShrink: 1, width: "100%", overflow: "hidden" }, historyStyle]}>
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
                  <ContextUsageIndicator
                    contextPctText={voice.contextStats?.contextUsagePercent == null ? "--" : `${voice.contextStats.contextUsagePercent}%`}
                    progress={(voice.contextStats?.contextUsagePercent ?? 0) / 100}
                    trackColor={theme.colors.infoMuted} progressColor={theme.colors.contextProgress}
                    textColor="#ffffff" />
                  <Pressable testID="voice-history-close" accessibilityRole="button"
                    accessibilityLabel="履歴を閉じる" hitSlop={8}
                    onPress={() => setHistoryExpanded(false)}
                    style={{ width: 44, height: 44, borderRadius: 22,
                      alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0, 0, 0, 0.4)" }}>
                    <Ionicons name="close" size={24} color="#ffffff" />
                  </Pressable>
                </View>
                <View style={{ flex: 1 }}>
                <ScrollView ref={historyScrollRef} testID="voice-history-messages" style={{ flex: 1 }}
                  onScroll={(event) => {
                    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
                    historyAtBottomRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
                  }}
                  scrollEventThrottle={16}
                  onContentSizeChange={() => {
                    if (historyAtBottomRef.current) historyScrollRef.current?.scrollToEnd({ animated: false });
                  }}
                  contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, gap: 12 }}>
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
                {taskChecklistOpen ? (
                  <View testID="voice-task-checklist-panel" style={{ position: "absolute", right: 0, top: 0,
                    maxWidth: Math.min(260, Math.max(0, screenWidth - 64)), maxHeight: "65%",
                    backgroundColor: "transparent", borderTopLeftRadius: 14,
                    borderBottomLeftRadius: 14, borderWidth: 1,
                    borderColor: isOverviewMode ? theme.colors.borderTranslucent : theme.colors.borderStrong,
                    shadowColor: theme.colors.shadow, shadowOffset: { width: -3, height: 6 },
                    shadowOpacity: 0.24, shadowRadius: 12, elevation: 9, overflow: "hidden" }}>
                    {IosBlurView ? <IosBlurView testID="voice-task-checklist-blur"
                      pointerEvents="none" intensity={65} tint={theme.colorScheme}
                      style={StyleSheet.absoluteFill} /> : null}
                    {MacBlurView ? <MacBlurView testID="voice-task-checklist-blur"
                      pointerEvents="none" style={StyleSheet.absoluteFill} /> : null}
                    <View testID="voice-task-checklist-tint" pointerEvents="none" style={[StyleSheet.absoluteFill,
                      { backgroundColor: IosBlurView || MacBlurView
                        ? theme.colorScheme === "dark" ? "rgba(10, 16, 24, 0.52)" : "rgba(255, 255, 255, 0.42)"
                        : theme.colors.surfaceTranslucent }]} />
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end",
                      borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle }}>
                      {voice.taskChecklist?.status === "present" && voice.taskChecklistOverview
                        ? <Pressable testID="voice-task-checklist-source-toggle"
                        accessibilityRole="button" accessibilityLabel={isOverviewMode ? "To Do原本を表示" : "To Do概要を表示"}
                        onPress={() => setTaskChecklistOriginal((current) => !current)}
                        style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
                        <Ionicons name={isOverviewMode ? "document-text-outline" : "list-outline"} size={19}
                          color={isOverviewMode ? theme.colors.accentStrong : theme.colors.textSecondary} />
                      </Pressable> : null}
                      {voice.historyError || voice.taskChecklist?.status === "unavailable" ? <Pressable
                        testID="voice-task-checklist-refresh" accessibilityRole="button"
                        accessibilityLabel="To Doを更新" onPress={() => void voice.refreshHistory()}
                        style={{ width: 38, height: 38, alignItems: "center", justifyContent: "center" }}>
                        <Ionicons name="refresh" size={18} color={theme.colors.accentStrong} />
                      </Pressable> : null}
                      {voice.taskChecklistCompletion ? <Pressable testID="voice-task-checklist-clear"
                        accessibilityRole="button" accessibilityLabel="完了した To Do を履歴に保存して空にする"
                        disabled={checklistCompletionBusy}
                        onPress={() => {
                          setChecklistCompletionBusy(true);
                          setChecklistCompletionError("");
                          void voice.respondToChecklistCompletion(voice.taskChecklistCompletion!.sourceHash,
                            voice.taskChecklistCompletion!.version, "clear")
                            .catch((cause) => setChecklistCompletionError(cause instanceof Error
                              ? cause.message : "To Do の完了確認を保存できませんでした。"))
                            .finally(() => setChecklistCompletionBusy(false));
                        }}
                        style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
                        <Ionicons name="trash-outline" size={20} color={theme.colors.accentStrong} />
                      </Pressable> : null}
                      <Pressable testID="voice-task-checklist-collapse" accessibilityRole="button"
                        accessibilityLabel="To Doを右に折りたたむ" onPress={() => setTaskChecklistOpen(false)}
                        style={{ width: 38, height: 38, alignItems: "center", justifyContent: "center" }}>
                        <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
                      </Pressable>
                    </View>
                    <ScrollView testID="voice-task-checklist-content"
                      style={{ flexGrow: 0, flexShrink: 1, alignSelf: "flex-start", maxWidth: "100%" }}
                      contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10, alignItems: "flex-start", gap: 8 }}>
                      {!voice.ready || !voice.taskChecklist
                        ? <Text style={{ color: theme.colors.textPrimary }}>To Doを読み込み中…</Text>
                        : voice.taskChecklist.status === "missing"
                          ? <Text style={{ color: theme.colors.textPrimary }}>To Doはまだ作成されていません</Text>
                          : voice.taskChecklist.status === "unavailable"
                            ? <Text style={{ color: theme.colors.textPrimary }}>To Doを読み込めませんでした</Text>
                            : !voice.taskChecklist.markdown.trim()
                              ? <Text style={{ color: theme.colors.textSecondary }}>To Doは空です</Text>
                            : isOverviewMode && voice.taskChecklistOverview
                              && voice.taskChecklistOverview.status !== "present"
                              ? <Text style={{ color: theme.colors.textSecondary }}>
                                {voice.taskChecklistOverview?.status === "pending"
                                  ? "概要を作成中…" : "概要を作成できませんでした"}
                              </Text>
                            : taskChecklistRows.length ? taskChecklistRows.map((row, index) => row.kind === "item"
                              ? <View key={index} testID={`voice-task-checklist-item-${index}`}
                                  accessible accessibilityRole="checkbox"
                                  accessibilityState={{ checked: row.checked, disabled: true }} accessibilityLabel={row.text}
                                  style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, maxWidth: "100%" }}>
                                  <Ionicons name={row.checked ? "checkbox" : "square-outline"} size={19}
                                    color={row.checked ? theme.colors.accentStrong : theme.colors.textSecondary} />
                                  <Text style={{ color: row.checked
                                    ? theme.colors.textSecondary : theme.colors.textPrimary,
                                    fontSize: 14, lineHeight: 20, flexShrink: 1,
                                    textDecorationLine: row.checked ? "line-through" : "none" }}>{row.text}</Text>
                                </View>
                              : <Text key={index} style={{ color: theme.colors.textSecondary,
                                  fontSize: 13, lineHeight: 18, flexShrink: 1 }}>{row.text}</Text>)
                              : <Text style={{ color: theme.colors.textSecondary }}>To Doは空です</Text>}
                    </ScrollView>
                    {checklistCompletionError ? <Text style={{ color: theme.colors.textPrimary,
                      fontSize: 12, paddingHorizontal: 12, paddingBottom: 10 }}>
                      {checklistCompletionError}</Text> : null}
                  </View>
                ) : (
                  <Pressable testID="voice-task-checklist-expand" accessibilityRole="button"
                    accessibilityLabel="To Doを開く" onPress={() => setTaskChecklistOpen(true)}
                    style={{ position: "absolute", right: 0, top: 12, width: 44, minHeight: 88,
                      alignItems: "center", justifyContent: "center", gap: 4,
                      borderTopLeftRadius: 12, borderBottomLeftRadius: 12,
                      backgroundColor: theme.colors.floatingSurface, borderWidth: 1,
                      borderColor: theme.colors.borderStrong, borderRightWidth: 0,
                      borderLeftWidth: 3, borderLeftColor: theme.colors.accent }}>
                    <Ionicons name="chevron-back" size={20} color={theme.colors.accentStrong} />
                    <Text style={{ color: theme.colors.textPrimary, fontSize: 11 }}>To Do</Text>
                  </Pressable>
                )}
                </View>
              </Reanimated.View>
            ) : null}
            <View testID="voice-footer-inset"
              style={{ paddingLeft: historyExpanded ? 20 : 12, paddingRight: 20, paddingBottom: 20 }}>
              <GestureDetector gesture={footerSwipe}>
                <View testID="voice-history-swipe-area">
                  <StreamingSttFooter
                    ref={footerRef}
                    transcript={transcript}
                    statusText={statusText}
                    voiceStatus={voiceStatus}
                    reduceMotion={reduceMotion !== false}
                    phase={streamingStt.phase}
                    correctionPreview={streamingStt.correctionPreview}
                    onSendCorrection={streamingStt.sendCorrectionPreview}
                    onEditCorrection={streamingStt.beginCorrectionEdit}
                    onDiscardCorrection={streamingStt.discardCorrection}
                    onChangeCorrectionText={streamingStt.setCorrectionText}
                    onChangeText={(text) => { streamingStt.cancelCorrection(); setTranscript(text); }}
                    onFocus={() => {
                      streamingStt.cancelCorrection();
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
                        style={{ width: 44, height: 44 }}>
                        <View style={{ position: "absolute", left: 0, top: 0 }}>
                          <VoiceOrchestratorIcon orchestrator={orchestrator} size={30} active />
                        </View>
                      </Pressable>
                    ) : undefined}
                    trailingAccessory={<CodexStatusSummaryMenu />}
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
