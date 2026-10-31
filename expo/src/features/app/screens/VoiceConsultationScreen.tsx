import { getVoiceOrchestrators } from "../utils/voiceOrchestratorClient";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { randomUUID } from "expo-crypto";
import Reanimated, { FadeOut, ZoomIn } from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import { Alert, LayoutAnimation, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRunnerWebSocketManager, useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { KeyboardAvoidingView } from "../keyboardController";
import { UserInputModal } from "../components/UserInputModal";
import { VoiceResetConfirmationModal } from "../components/VoiceResetConfirmationModal";
import { StreamingSttFooter } from "../components/StreamingSttFooter";
import { useConsultationSpeech } from "../hooks/useConsultationSpeech";
import type { VoiceConversationPlayback } from "./VoiceConversationScreen";
import { MarkdownText } from "../components/MarkdownText";
import { VoiceTurnTrace } from "../components/VoiceTurnTrace";
import { useConsultationRooms, type ConsultationRoom } from "../hooks/useConsultationRooms";
export type { ConsultationRoom } from "../hooks/useConsultationRooms";
import { formatMessageTimestampLabel } from "../utils/formatting";
import { VoiceConversationMessages } from "../components/VoiceConversationMessages";
import { VoiceOrchestratorIcon, type VoiceOrchestrator } from "../components/VoiceOrchestratorIcon";
import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import { resolveTtsAudioQuality } from "../utils/ttsAudioQuality";
import { useVoiceUserInput } from "../hooks/useVoiceUserInput";

type Owner = VoiceOrchestrator;

const reasonText: Record<string, string> = {
  ended: "相談を終了しました", ready: "相談を始められます", all_pass: "今のところ、追加の発言はありません", limit: "回数または時間の上限に達しました",
  user_stopped: "停止しました", session_busy: "参加者が別の処理中です。終わってから再開できます",
  unknown: "前の返答を確認する必要があります", recovery_required: "前回の処理を確認して再開します",
  confirmation_required: "セッション切替の確認を待っています",
  instructions_too_long: "相談の進め方を短くしてから、もう一度試してください",
};

export function VoiceConsultationScreen({ onClose, playback }: { onClose: () => void; playback?: VoiceConversationPlayback }) {
  const manager = useRunnerWebSocketManager();
  const { connected, generation } = useRunnerWebSocketSnapshot();
  const { theme } = useVisualTheme();
  const reduceMotion = useReduceMotionEnabled();
  const [owners, setOwners] = useState<Owner[]>([]);
  const [selectedRoom, setSelectedRoom] = useState("");
  const [mode, setMode] = useState<"list" | "new" | "room" | "settings">("list");
  const [selected, setSelected] = useState<string[]>([]);
  const [template, setTemplate] = useState("");
  const [templateExpanded, setTemplateExpanded] = useState(false);
  const [maxTurns, setMaxTurns] = useState("9");
  const [supplement, setSupplement] = useState("");
  const [editingTranscript, setEditingTranscript] = useState(false);
  const speech = useConsultationSpeech(mode === "room" && connected ? selectedRoom : "", playback);
  const ownersRef = useRef(owners); ownersRef.current = owners;
  const speechSubscription = useRef<{ roomId: string; id: string; connect: () => Promise<unknown>; ready: Promise<unknown> | null } | null>(null);
  useEffect(() => { setEditingTranscript(false); }, [selectedRoom, mode]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [resetDeadline, setResetDeadline] = useState<number | null>(null);
  const scroll = useRef<ScrollView>(null);
  const historyAtBottom = useRef(true);
  useEffect(() => { historyAtBottom.current = true; }, [selectedRoom, mode]);
  const pendingSend = useRef<{ roomId: string; text: string; messageId: string } | null>(null);
  const send = useCallback(async (operation: string, payload: Record<string, unknown> = {}) => {
    const response = await manager.request({ channel: "agent", op: `voice.consultations.${operation}`, payload });
    if (response.op !== `voice.consultations.${operation}.result`) {
      throw new Error(String((response.payload as { message?: string })?.message || "相談の操作に失敗しました"));
    }
    return response.payload;
  }, [manager]);
  const { rooms, room, roomSnapshots, applyRoom, defaultTemplate } = useConsultationRooms({ manager, connected, generation,
    selectedRoom: mode === "room" || mode === "settings" ? selectedRoom : "", send, onError: setError });
  const userInput = useVoiceUserInput(manager, room?.run?.orchestratorId || "");
  useEffect(() => { setTemplate((existing) => existing || defaultTemplate); }, [defaultTemplate]);
  useEffect(() => manager.subscribe({ channel: "agent", op: "voice.consultations.speech" }, (message) => {
    const event = message.payload as { roomId: string; subscriptionId: string; runId: string; orchestratorId: string; jobId: string; generation: number; inputUserSeq: number; status: string };
    const subscription = speechSubscription.current;
    if (!subscription || event.roomId !== subscription.roomId || event.subscriptionId !== subscription.id) return;
    if (event.status === "cancelled") { speech.cancel(event.jobId); return; }
    const room = roomSnapshots.current[event.roomId];
    if (!room || room.generation !== event.generation || room.messages.findLast((item) => item.source === "user")?.seq !== event.inputUserSeq) return;
    const owner = ownersRef.current.find((item) => item.id === event.orchestratorId);
    if (owner && event.status === "ready") speech.enqueue({ id: event.runId, jobId: event.jobId, text: "", owner });
  }), [manager, speech.enqueue, speech.cancel]);
  const ensureSpeechReady = useCallback(async () => {
    const subscription = speechSubscription.current;
    if (!subscription) return;
    if (!subscription.ready) subscription.ready = subscription.connect().catch((cause) => { subscription.ready = null; throw cause; });
    await subscription.ready;
    if (speechSubscription.current !== subscription) throw new Error("相談画面が切り替わりました");
  }, []);
  const cancelSpeechJobs = useCallback(() => {
    const subscription = speechSubscription.current;
    if (subscription) void send("speech.cancel", { roomId: subscription.roomId, subscriptionId: subscription.id }).catch(() => {});
  }, [send]);
  const stopSpeech = useCallback(() => { speech.stop(); cancelSpeechJobs(); }, [speech.stop, cancelSpeechJobs]);
  useEffect(() => {
    if (mode !== "room" || !selectedRoom || !playback || !connected) return;
    let current = true;
    const subscription = { roomId: selectedRoom, id: randomUUID(), ready: null as Promise<unknown> | null,
      connect: async () => {
        const audioQuality = await resolveTtsAudioQuality(playback.lightweightTtsOnCellular === true);
        if (!current) return;
        return send("speech.subscribe", { roomId: selectedRoom, subscriptionId: subscription.id,
          tts: { speedScale: playback.ttsSpeed ?? 1, audioQuality } }).then((value) => {
            if (!current) void unsubscribe(); return value;
          });
      } };
    const unsubscribe = () => send("speech.unsubscribe", { roomId: subscription.roomId, subscriptionId: subscription.id }).catch(() => {});
    speechSubscription.current = subscription;
    void ensureSpeechReady().catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : "読み上げを準備できません"); });
    return () => {
      current = false; if (speechSubscription.current === subscription) speechSubscription.current = null;
      void unsubscribe();
    };
  }, [mode, selectedRoom, Boolean(playback), playback?.ttsSpeed, playback?.lightweightTtsOnCellular, connected, generation, send, ensureSpeechReady]);
  const act = useCallback(async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "接続を確認してください"); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => {
    let current = true;
    void manager.connect().then(async () => {
      const owners = await getVoiceOrchestrators(manager);
      if (current) setOwners(owners.orchestrators);
    }).catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : "相談を読み込めません"); });
    return () => { current = false; };
  }, [manager, connected, generation]);
  const decideReset = useCallback((decision: "reset" | "continue") => {
    if (!room) return;
    void act(async () => { await ensureSpeechReady(); applyRoom(await send("reset", { roomId: room.id, decision }) as ConsultationRoom); });
  }, [room, act, send, applyRoom, ensureSpeechReady]);
  const resetRunId = room?.reason === "confirmation_required" ? room.run?.id : undefined;
  const resetRequired = room?.resetConfirmation?.required === true;
  useEffect(() => {
    if (!resetRunId || resetRequired) { setResetDeadline(null); return; }
    setResetDeadline(Date.now() + 10_000);
    const timer = setTimeout(() => decideReset("continue"), 10_000);
    return () => clearTimeout(timer);
    // A room update must not restart the existing confirmation countdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetRunId, resetRequired]);
  const resetRequest = useMemo(() => resetRunId ? {
    required: resetRequired, deadlineMs: resetDeadline, decide: decideReset,
  } : null, [resetRunId, resetRequired, resetDeadline, decideReset]);
  const styles = useMemo(() => StyleSheet.create({
    root: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.canvas },
    header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12,
      width: "100%", maxWidth: 820, alignSelf: "center" },
    title: { color: theme.colors.textPrimary, fontSize: mode === "list" ? 30 : 18, fontWeight: "700", flex: 1, letterSpacing: -0.5 },
    iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22 },
    body: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 28, gap: 20, width: "100%", maxWidth: 820, alignSelf: "center", flexGrow: 1 },
    row: { flexDirection: "row", gap: 10, alignItems: "center" },
    text: { color: theme.colors.textPrimary, fontSize: 16, lineHeight: 24 },
    secondary: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 },
    input: { color: theme.colors.textPrimary, backgroundColor: theme.colors.surface, borderColor: theme.colors.border,
      borderWidth: 1, borderRadius: 16, padding: 14, fontSize: 16, textAlignVertical: "top" },
    button: { paddingHorizontal: 20, minHeight: 52, justifyContent: "center", alignItems: "center", borderRadius: 18, backgroundColor: theme.colors.accent },
    action: { color: theme.colors.textOnAccent, fontSize: 16, fontWeight: "600" },
    card: { paddingVertical: 20, borderBottomWidth: 1, borderColor: theme.colors.border, gap: 12 },
    footer: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 16, gap: 12, width: "100%", maxWidth: 820, alignSelf: "center" },
    section: { paddingVertical: 16, gap: 12 },
  }), [theme, mode]);
  const button = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button"
    accessibilityLabel={label} disabled={disabled || busy} onPress={onPress}
    style={({ pressed }) => [styles.button, { opacity: disabled || busy ? 0.4 : pressed ? 0.8 : 1 }]}>
    <Text style={styles.action}>{label}</Text>
  </Pressable>;
  const ownerFor = (id: string, source: Pick<ConsultationRoom, "profiles"> | undefined = room): Owner => owners.find((owner) => owner.id === id)
    || { id, name: source?.profiles[id]?.name || "参加者", icon: "" };
  const avatars = (ids: string[], source?: Pick<ConsultationRoom, "profiles">) => <View style={{ flexDirection: "row", paddingLeft: 0 }}>
    {ids.slice(0, 4).map((id, index) => <View key={id} style={{ marginLeft: index ? -9 : 0,
      borderRadius: 22, borderWidth: 3, borderColor: theme.colors.canvas }}>
      <VoiceOrchestratorIcon orchestrator={ownerFor(id, source)} size={34} />
    </View>)}
  </View>;
  const back = () => {
    if (mode === "list") onClose();
    else setMode(mode === "new" || mode === "room" ? "list" : "room");
  };
  const editSettings = () => {
    if (!room) return;
    setTemplate(room.template); setMaxTurns(String(room.maxTurns));
    setTemplateExpanded(false); setMode("settings");
  };
  const create = () => void act(async () => {
    const value = await send("create", { participants: selected }) as ConsultationRoom;
    applyRoom(value); setSelectedRoom(value.id); setMode("room");
  });

  const submit = async (text: string, accepted: () => boolean) => {
    if (!room || !connected || busy || !text.trim()) return;
    setError("");
    const previous = pendingSend.current;
    const submission = previous?.roomId === room.id && previous.text === text ? previous : { roomId: room.id, text, messageId: randomUUID() };
    pendingSend.current = submission;
    if (submission !== previous) speech.stop();
    try { await ensureSpeechReady(); applyRoom(await send("supplement", submission) as ConsultationRoom); if (pendingSend.current === submission) pendingSend.current = null; if (accepted()) setEditingTranscript(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "送信できません"); }
  };
  const live = room?.run?.progress;
  const liveText = live?.messages.filter((item) => item.phase !== "commentary").map((item) => item.text).join("\n").trim() || "";
  const lastStep = room?.steps?.at(-1);
  const orphanTrace = lastStep?.trace && !room?.messages.some((message) => message.id === lastStep.runId) ? lastStep : null;
  return <SafeAreaView style={styles.root} testID="voice-consultation-screen">
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={mode === "list" ? "相談を閉じる" : "戻る"} onPress={back} style={styles.iconButton}>
          <Ionicons name={mode === "list" ? "close" : "chevron-back"} size={23} color={theme.colors.textPrimary} />
        </Pressable>
        <Text numberOfLines={1} style={styles.title}>{mode === "list" ? "相談" : mode === "new" ? "仲間を集める" : mode === "settings" ? "相談の設定" : room?.question || "新しい相談"}</Text>
        {mode === "room" && room ? <Pressable accessibilityRole="button" accessibilityLabel="設定" onPress={editSettings} style={styles.iconButton}>
          <Ionicons name="options-outline" size={22} color={theme.colors.textSecondary} />
        </Pressable> : null}
        {mode === "list" ? <Pressable accessibilityRole="button" accessibilityLabel="新しい相談"
          disabled={!connected} onPress={() => { setSelected([]); setMode("new"); }} style={[styles.iconButton, { backgroundColor: theme.colors.accent }]}>
          <Ionicons name="add" size={25} color={theme.colors.textOnAccent} />
        </Pressable> : null}
      </View>
      {mode === "room" && room ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 14, gap: 18 }}>
        {room.participants.map((id) => <View key={id} style={{ width: 64, alignItems: "center", gap: 5 }}>
          <VoiceOrchestratorIcon orchestrator={ownerFor(id)} size={34} active={room.state === "running" && room.run?.orchestratorId === id} />
          <Text numberOfLines={1} style={[styles.secondary, { fontSize: 11, maxWidth: 64 }]}>{ownerFor(id).name}</Text>
        </View>)}
      </ScrollView> : null}
      {!connected ? <Text style={[styles.secondary, { paddingHorizontal: 24 }]}>Runnerへ接続していません</Text> : null}
      {error ? <Text accessibilityRole="alert" style={[styles.text, { paddingHorizontal: 24 }]}>{error}</Text> : null}
      <ScrollView testID="consultation-messages" ref={scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled"
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          historyAtBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
        }} scrollEventThrottle={16}
        onContentSizeChange={() => { if (mode === "room" && historyAtBottom.current) scroll.current?.scrollToEnd({ animated: false }); }}>
        {mode === "list" ? <>
          <Text style={[styles.secondary, { marginBottom: 6 }]}>いつもの仲間と、ひとつの話を。</Text>
          {!rooms.length ? <View style={[styles.section, { paddingVertical: 64 }]}>
            <Text style={[styles.text, { fontSize: 24, fontWeight: "600" }]}>一緒に考えてみよう</Text>
            <Text style={styles.secondary}>右上の＋から、話したい仲間を選べます。</Text>
          </View> : null}
          {rooms.map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={item.question || "新しい相談"}
            style={styles.card} onPress={() => { setSelectedRoom(item.id); setMode("room"); }}>
            <View style={styles.row}>
              {avatars(item.participants, item)}
              <View style={{ flex: 1, gap: 5 }}>
                <Text numberOfLines={2} style={[styles.text, { fontWeight: "600", lineHeight: 23 }]}>{item.question || "新しい相談"}</Text>
                <View style={styles.row}>
                  <View pointerEvents="none" style={{ flex: 1, maxHeight: 20, overflow: "hidden" }}>
                    <MarkdownText tone="assistant" content={item.lastMessage?.source === "participant"
                      ? `${item.profiles[item.lastMessage!.speakerId]?.name || "参加者"}：${item.lastMessage?.text}`
                      : item.lastMessage?.text || "メッセージを送って始める"}
                      textStyle={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 }}
                      containerStyle={{ width: "auto" }} resolveImageSource={() => null} />
                  </View>
                  <Text style={[styles.secondary, { fontSize: 11 }]}>{formatMessageTimestampLabel(item.lastMessage?.at)}</Text>
                </View>
              </View>
            </View>
          </Pressable>)}
        </> : null}
        {mode === "new" ? <>
          <View style={{ paddingVertical: 18, gap: 8 }}>
            <Text style={[styles.text, { fontSize: 26, lineHeight: 34, fontWeight: "700", letterSpacing: -0.6 }]}>誰と話そう？</Text>
            <Text style={styles.secondary}>気になる仲間をタップ。長押しすると紹介を読めます。</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 20, justifyContent: "center", paddingVertical: 20 }}>
            {owners.map((owner) => {
              const checked = selected.includes(owner.id);
              return <Pressable key={owner.id} accessibilityRole="checkbox" accessibilityLabel={owner.name}
                accessibilityHint="タップで参加を切り替え、長押しで得意分野・担当を表示"
                accessibilityState={{ checked, disabled: !checked && selected.length >= 8 }}
                onLongPress={() => Alert.alert(owner.name, owner.publicIntroduction || "得意分野・担当は個人設定から登録できます。")}
                onPress={() => {
                  if (!checked && selected.length >= 8) return;
                  if (reduceMotion === false) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setSelected((current) => checked ? current.filter((id) => id !== owner.id) : [...current, owner.id]);
                }} style={({ pressed }) => ({ width: 82, alignItems: "center", gap: 10, paddingVertical: 10,
                  transform: [{ scale: pressed ? 0.92 : 1 }], opacity: !checked && selected.length >= 8 ? 0.4 : pressed ? 0.8 : 1 })}>
                <View>
                  <VoiceOrchestratorIcon orchestrator={owner} size={64} active={checked} />
                  {checked ? <Reanimated.View entering={reduceMotion === false ? ZoomIn.springify().damping(15) : undefined}
                    exiting={reduceMotion === false ? FadeOut.duration(120) : undefined} style={{ position: "absolute", right: -2, bottom: 0, width: 22, height: 22,
                    borderRadius: 11, backgroundColor: theme.colors.accent, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: theme.colors.canvas }}>
                    <Ionicons name="checkmark" size={14} color={theme.colors.textOnAccent} />
                  </Reanimated.View> : null}
                </View>
                <Text numberOfLines={1} style={[styles.secondary, { maxWidth: 82, fontSize: 12, fontWeight: checked ? "700" : "400" }]}>{owner.name}</Text>
              </Pressable>;
            })}
          </View>
        </> : null}
        {mode === "settings" ? <>
          <View style={styles.section}>
            <Text style={[styles.text, { fontWeight: "600" }]}>返答の上限</Text>
            <View style={styles.row}>
              <TextInput accessibilityLabel="返答の上限" keyboardType="number-pad" style={[styles.input, { width: 78, textAlign: "center" }]} value={maxTurns} onChangeText={setMaxTurns} />
              <Text style={styles.secondary}>回まで（1〜30）</Text>
            </View>
            <Text style={styles.secondary}>あなたがメッセージを送るたびに、数え直します。</Text>
          </View>
          <View style={styles.section}>
            <Pressable accessibilityRole="button" accessibilityLabel="相談の進め方を編集" accessibilityState={{ expanded: templateExpanded }}
              onPress={() => setTemplateExpanded((value) => !value)} style={styles.row}>
              <Text style={[styles.text, { fontWeight: "600", flex: 1 }]}>相談の進め方</Text>
              <Ionicons name={templateExpanded ? "chevron-up" : "chevron-down"} size={18} color={theme.colors.textSecondary} />
            </Pressable>
            <Text style={styles.secondary}>次の返答から適用。本人の通常設定は変わりません。</Text>
            {templateExpanded ? <TextInput accessibilityLabel="相談の進め方" multiline style={[styles.input, { minHeight: 200 }]} value={template} onChangeText={setTemplate} /> : null}
          </View>
          {button("設定を保存", () => void act(async () => {
            applyRoom(await send("configure", { roomId: room?.id, template, maxTurns: Number(maxTurns) }) as ConsultationRoom); setMode("room");
          }), !connected)}
        </> : null}
        {mode === "room" && !room && connected ? <Text style={styles.secondary}>相談を読み込んでいます…</Text> : null}
        {mode === "room" && room ? <>
          {!room.messages.length ? <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 10, paddingVertical: 70 }}>
            {avatars(room.participants, room)}
            <Text style={[styles.text, { fontSize: 22, fontWeight: "600", marginTop: 8 }]}>みんな、集まりました</Text>
            <Text style={styles.secondary}>話したいことを、いつもの言葉で。</Text>
          </View> : null}
          <VoiceConversationMessages messages={room.messages.map((message) => ({
            role: message.source === "user" ? "user" : message.source === "participant" ? "assistant" : "system",
            text: message.text, at: message.at, outputTokens: message.outputTokens, clientOperationId: message.id,
            speakerName: message.speakerId === "user" ? "あなた" : message.speakerId === "system" ? "参加・設定" : ownerFor(message.speakerId).name,
            ...(message.source === "participant" ? { orchestratorId: message.speakerId, orchestrator: ownerFor(message.speakerId),
              trace: room.steps?.find((step) => step.runId === message.id)?.trace } : {}),
          }))} onRead={playback ? (message) => {
            const owner = owners.find((item) => item.id === message.orchestratorId);
            if (owner) { cancelSpeechJobs(); speech.read({ id: message.clientOperationId, text: message.text, owner }); }
          } : undefined} speakingMessageId={speech.activeMessageId} onStopReading={stopSpeech} />
          {room.state === "running" && room.run ? <View style={{ gap: 8 }}>
            {liveText && liveText !== "[[PASS]]" ? <VoiceConversationMessages messages={[{ role: "assistant", text: liveText, clientOperationId: room.run.id,
              speakerName: ownerFor(room.run.orchestratorId).name, orchestrator: ownerFor(room.run.orchestratorId), streaming: true }]} /> : null}
            {live?.messages.some((item) => item.phase !== "commentary" && item.truncated) ? <Text style={styles.secondary}>途中表示は一部省略しています。確定後に全文を表示します。</Text> : null}
            <View style={{ marginLeft: 39, gap: 4 }}>
              {!liveText || liveText === "[[PASS]]" ? <Text accessibilityLiveRegion="polite" style={styles.secondary}>{ownerFor(room.run.orchestratorId).name}が考えています…</Text> : null}
              {live ? <VoiceTurnTrace trace={live} live /> : null}
            </View>
          </View> : null}
          {room.state === "paused" && room.run?.progress ? <View style={{ gap: 4 }}>
            <Text style={styles.secondary}>{ownerFor(room.run.orchestratorId).name} · 結果未確認の作業記録</Text>
            <VoiceTurnTrace trace={room.run.progress} />
          </View> : null}
          {orphanTrace?.trace && room.state !== "running" ? <View style={{ gap: 4 }}>
            <Text style={styles.secondary}>{ownerFor(orphanTrace.orchestratorId).name}の作業</Text><VoiceTurnTrace trace={orphanTrace.trace} />
          </View> : null}
          {room.state !== "running" && room.messages.length ? <View style={{ alignItems: "center", gap: 12, paddingVertical: 14 }}>
            <Text accessibilityLiveRegion="polite" style={styles.secondary}>{reasonText[room.reason] || "続きがあれば、メッセージをどうぞ。"}</Text>
            {room.reason !== "ended" && ["paused", "stopped"].includes(room.state) && room.turns < room.maxTurns
              ? button("確認して再開", () => void act(async () => { await ensureSpeechReady(); applyRoom(await send("resume", { roomId: room.id }) as ConsultationRoom); }), !connected) : null}
          </View> : null}
        </> : null}
      </ScrollView>
      {mode === "new" ? <View style={styles.footer}>
        <View style={[styles.row, { justifyContent: "space-between" }]}>{avatars(selected)}
          <Text accessibilityLiveRegion="polite" style={styles.secondary}>{selected.length ? `${selected.length}人を選択中` : "2〜8人を選んでください"}</Text>
        </View>
        {button("相談を作る", create, !connected || selected.length < 2)}
      </View> : null}
      {mode === "room" && room ? <View style={styles.footer}>
        <StreamingSttFooter transcript={supplement} phase="idle" reduceMotion={reduceMotion}
          voiceStatus={editingTranscript || supplement || error || speech.error ? undefined : speech.activeMessageId ? "speaking" : room.state === "running" ? "responding" : undefined}
          statusText={speech.error || undefined} onRequestEdit={() => { stopSpeech(); setEditingTranscript(true); }}
          onChangeText={setSupplement} onFocus={() => { stopSpeech(); setEditingTranscript(true); }} onBlur={() => setEditingTranscript(false)}
          onSubmit={submit} submitDisabled={!connected || busy} onCancelSpeaking={stopSpeech}
          stopLabel="相談を停止" onStop={room.run || room.state === "running" ? () => {
            stopSpeech(); void act(async () => { applyRoom(await send("stop", { roomId: room.id }) as ConsultationRoom); });
          } : undefined} />
      </View> : null}
    </KeyboardAvoidingView>
    <UserInputModal request={userInput.request} onDecide={userInput.decide} />
    <VoiceResetConfirmationModal request={resetRequest} />
  </SafeAreaView>;
}
