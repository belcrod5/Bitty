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
import { VoiceConversationMessages } from "../components/VoiceConversationMessages";
import { VoiceOrchestratorIcon, type VoiceOrchestrator } from "../components/VoiceOrchestratorIcon";
import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import { useVoiceUserInput } from "../hooks/useVoiceUserInput";

type Owner = VoiceOrchestrator;
type Profile = { orchestratorId: string; name: string; introduction: string };
export type ConsultationRoom = {
  id: string; question: string; participants: string[]; profiles: Record<string, Profile>; template: string;
  turns: number; maxTurns: number; revision: number; state: "idle" | "running" | "paused" | "stopped"; reason: string;
  messages: { id: string; seq: number; speakerId: string; source: string; text: string; at?: string }[];
  run: { id: string; orchestratorId: string } | null;
  resetConfirmation?: { required?: boolean };
};

const reasonText: Record<string, string> = {
  ready: "相談を始められます", all_pass: "全員が見送りました", limit: "回数または時間の上限に達しました",
  user_stopped: "停止しました", session_busy: "参加者が別の処理中です。終わってから再開できます",
  unknown: "前の返答を確認する必要があります", recovery_required: "前回の処理を確認して再開します",
  confirmation_required: "セッション切替の確認を待っています",
};

export function VoiceConsultationScreen({ onClose }: { onClose: () => void }) {
  const manager = useRunnerWebSocketManager();
  const { connected, generation } = useRunnerWebSocketSnapshot();
  const { theme } = useVisualTheme();
  const reduceMotion = useReduceMotionEnabled();
  const [owners, setOwners] = useState<Owner[]>([]), [rooms, setRooms] = useState<ConsultationRoom[]>([]);
  const [selectedRoom, setSelectedRoom] = useState("");
  const [mode, setMode] = useState<"list" | "new" | "room" | "settings">("list");
  const [selected, setSelected] = useState<string[]>([]);
  const [template, setTemplate] = useState("");
  const [maxTurns, setMaxTurns] = useState("9");
  const [supplement, setSupplement] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [resetDeadline, setResetDeadline] = useState<number | null>(null);
  const scroll = useRef<ScrollView>(null);
  const pendingSend = useRef<{ roomId: string; text: string; messageId: string } | null>(null);
  const room = rooms.find((item) => item.id === selectedRoom);
  const userInput = useVoiceUserInput(manager, room?.run?.orchestratorId || "");
  const applyRoom = useCallback((value: ConsultationRoom) => {
    setRooms((current) => {
      const previous = current.find((item) => item.id === value.id);
      if (previous && previous.revision > value.revision) return current;
      return [value, ...current.filter((item) => item.id !== value.id)];
    });
  }, []);
  const send = useCallback(async (operation: string, payload: Record<string, unknown> = {}) => {
    const response = await manager.request({ channel: "agent", op: `voice.consultations.${operation}`, payload });
    if (response.op !== `voice.consultations.${operation}.result`) {
      throw new Error(String((response.payload as { message?: string })?.message || "相談の操作に失敗しました"));
    }
    return response.payload;
  }, [manager]);
  const act = useCallback(async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "接続を確認してください"); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => {
    let current = true;
    void manager.connect().then(async () => {
      const [ownerResponse, result] = await Promise.all([
        manager.request({ channel: "agent", op: "voice.orchestrators.list" }), send("list"),
      ]);
      if (!current) return;
      const ownerPayload = ownerResponse.payload as { orchestrators: Owner[] };
      const value = result as { rooms: ConsultationRoom[]; defaultTemplate: string };
      setOwners(ownerPayload.orchestrators);
      for (const item of value.rooms) applyRoom(item);
      setTemplate((existing) => existing || value.defaultTemplate);
    }).catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : "相談を読み込めません"); });
    return () => { current = false; };
  }, [manager, connected, generation, send, applyRoom]);
  useEffect(() => manager.subscribe({ channel: "agent", op: "voice.consultations.changed" }, (message) => {
    const value = message.payload as ConsultationRoom;
    if (value?.id && Array.isArray(value.messages)) applyRoom(value);
  }), [manager, applyRoom]);
  const decideReset = useCallback((decision: "reset" | "continue") => {
    if (!room) return;
    void act(async () => { applyRoom(await send("reset", { roomId: room.id, decision }) as ConsultationRoom); });
  }, [room, act, send, applyRoom]);
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
    header: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16, borderBottomWidth: 1, borderColor: theme.colors.border },
    title: { color: theme.colors.textPrimary, fontSize: 19, fontWeight: "700", flex: 1 },
    body: { padding: 16, gap: 14 }, row: { flexDirection: "row", gap: 12, alignItems: "center", flexWrap: "wrap" },
    text: { color: theme.colors.textPrimary, fontSize: 16, lineHeight: 23 },
    secondary: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 },
    input: { color: theme.colors.textPrimary, backgroundColor: theme.colors.surface, borderColor: theme.colors.borderStrong,
      borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16, textAlignVertical: "top" },
    button: { padding: 12, borderRadius: 10, backgroundColor: theme.colors.surfaceRaised, borderWidth: 1, borderColor: theme.colors.border },
    action: { color: theme.colors.controlAccent, fontSize: 16, fontWeight: "600" },
    card: { padding: 14, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, gap: 8, backgroundColor: theme.colors.surface },
    footer: { padding: 12, gap: 10, borderTopWidth: 1, borderColor: theme.colors.border },
  }), [theme]);
  const button = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button"
    accessibilityLabel={label} disabled={disabled || busy} onPress={onPress} style={[styles.button, (disabled || busy) && { opacity: 0.4 }]}>
    <Text style={styles.action}>{label}</Text>
  </Pressable>;
  const back = () => {
    if (mode === "list") onClose();
    else setMode(mode === "new" || mode === "room" ? "list" : "room");
  };
  const editSettings = () => {
    if (!room) return;
    setTemplate(room.template); setMaxTurns(String(room.maxTurns));
    setMode("settings");
  };
  const create = () => void act(async () => {
    const value = await send("create", { participants: selected }) as ConsultationRoom;
    applyRoom(value); setSelectedRoom(value.id); setMode("room");
  });

  return <SafeAreaView style={styles.root} testID="voice-consultation-screen">
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={mode === "list" ? "相談を閉じる" : "戻る"} onPress={back}>
          <Ionicons name="chevron-back" size={25} color={theme.colors.textPrimary} />
        </Pressable>
        <Text style={styles.title}>{mode === "list" ? "相談" : mode === "new" ? "新しい相談" : mode === "settings" ? "相談の設定" : "相談"}</Text>
        {mode === "room" && room ? <>
          {button("設定", editSettings)}
        </> : null}
      </View>
      {!connected ? <Text style={[styles.secondary, { padding: 12 }]}>Runnerへ接続していません</Text> : null}
      {error ? <Text accessibilityRole="alert" style={[styles.text, { padding: 12 }]}>{error}</Text> : null}
      <ScrollView ref={scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => { if (mode === "room") scroll.current?.scrollToEnd({ animated: false }); }}>
        {mode === "list" ? <>
          {button("新しい相談", () => { setSelected([]); setMode("new"); }, !connected)}
          {!rooms.length ? <Text style={styles.secondary}>複数のオーケストレーターと、順番に意見を交わせます。</Text> : null}
          {rooms.map((item) => <Pressable key={item.id} accessibilityRole="button" style={styles.card}
            onPress={() => { setSelectedRoom(item.id); setMode("room"); }}>
            <Text style={styles.text}>{item.question || "新しい相談"}</Text>
            <Text style={styles.secondary}>{item.participants.map((id) => item.profiles[id]?.name || id).join(" → ")} · {item.turns}/{item.maxTurns}手番</Text>
          </Pressable>)}
        </> : null}
        {mode === "new" ? <>
          <Text style={[styles.text, { fontSize: 24, fontWeight: "700" }]}>仲間を集めよう</Text>
          <Text style={styles.secondary}>一緒に考えたい人を選んでください。選んだ順に話します。長押しで得意分野・担当を見られます。</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, justifyContent: "center", paddingVertical: 20 }}>
            {owners.map((owner) => {
              const checked = selected.includes(owner.id);
              return <Pressable key={owner.id} accessibilityRole="checkbox" accessibilityLabel={owner.name}
                accessibilityHint="タップで参加を切り替え、長押しで得意分野・担当を表示"
                accessibilityState={{ checked, disabled: !checked && selected.length >= 8 }} onLongPress={() => Alert.alert(owner.name, owner.publicIntroduction || "得意分野・担当は個人設定から登録できます。")}
                onPress={() => {
                  if (reduceMotion === false) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  if (!checked && selected.length >= 8) return;
                  setSelected((current) => checked ? current.filter((id) => id !== owner.id) : [...current, owner.id]);
                }} style={({ pressed }) => ({ width: 88, alignItems: "center", gap: 9, paddingVertical: 12, borderRadius: 22,
                  backgroundColor: checked ? theme.colors.userMessageSurface : theme.colors.surface,
                  borderWidth: 1, borderColor: checked ? theme.colors.accent : theme.colors.border,
                  transform: [{ scale: pressed ? 0.94 : 1 }], opacity: pressed ? 0.8 : 1 })}>
                <View>
                  <VoiceOrchestratorIcon orchestrator={owner} size={58} active={checked} />
                  {checked ? <Reanimated.View entering={reduceMotion === false ? ZoomIn.springify().damping(15) : undefined}
                    exiting={reduceMotion === false ? FadeOut.duration(120) : undefined} style={{ position: "absolute", right: -4, bottom: -2, width: 22, height: 22,
                    borderRadius: 11, backgroundColor: theme.colors.accent, alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name="checkmark" size={16} color={theme.colors.textOnAccent} />
                  </Reanimated.View> : null}
                </View>
                <Text numberOfLines={1} style={[styles.secondary, { maxWidth: 76, fontWeight: checked ? "700" : "400" }]}>{owner.name}</Text>
              </Pressable>;
            })}
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.secondary}>{selected.length}人を選択中 · 2〜8人を選んでください</Text>
          {selected.length ? <View style={styles.row}>{selected.map((id, index) => {
            const owner = owners.find((item) => item.id === id)!;
            return <View key={id} style={{ alignItems: "center", gap: 4 }}>
              <VoiceOrchestratorIcon orchestrator={owner} size={32} />
              <Text style={styles.secondary}>{index + 1}. {owner.name}</Text>
            </View>;
          })}</View> : null}
          {button("相談を作る", create, !connected || selected.length < 2)}
        </> : null}
        {mode === "settings" ? <>
          <Text style={styles.text}>返答の最大回数（1〜30）</Text>
          <TextInput accessibilityLabel="最大手番数" keyboardType="number-pad" style={styles.input} value={maxTurns} onChangeText={setMaxTurns} />
          <Text style={styles.secondary}>あなたが送るたびに数え直します。参加者の発言では増えません。</Text>
          <Text style={styles.text}>相談の進め方</Text>
          <TextInput accessibilityLabel="相談の進め方" multiline style={[styles.input, { minHeight: 170 }]} value={template} onChangeText={setTemplate} />
          <Text style={styles.secondary}>次の返答から適用します。本人の通常設定は変更しません。得意分野・担当は各オーケストレーターの個人設定で編集できます。</Text>
          {button("設定を保存", () => void act(async () => {
            applyRoom(await send("configure", { roomId: room?.id, template, maxTurns: Number(maxTurns) }) as ConsultationRoom); setMode("room");
          }), !connected)}
        </> : null}
        {mode === "room" && room ? <>
          <Text style={styles.secondary}>{room.participants.map((id) => room.profiles[id]?.name || id).join(" → ")} · {room.turns}/{room.maxTurns}手番</Text>
          {!room.messages.length ? <Text style={styles.secondary}>仲間が集まりました。いつものようにメッセージを送って相談を始めましょう。</Text> : null}
          <VoiceConversationMessages messages={room.messages.map((message) => ({
            role: message.source === "user" ? "user" : message.source === "participant" ? "assistant" : "system",
            text: message.text, at: message.at, clientOperationId: message.id,
            speakerName: message.speakerId === "user" ? "あなた" : message.speakerId === "system" ? "参加・設定"
              : room.profiles[message.speakerId]?.name || message.speakerId,
            ...(message.source === "participant" ? { orchestratorId: message.speakerId } : {}),
          }))} />
          <Text accessibilityLiveRegion="polite" style={styles.secondary}>{room.state === "running" && room.run
            ? `${room.profiles[room.run.orchestratorId]?.name || "参加者"}が考えています…`
            : reasonText[room.reason] || (room.state === "paused" ? "確認してから再開してください" : "")}</Text>
          <View style={styles.row}>
            {room.state !== "running" && room.messages.length > 0 ? button(room.reason === "ready" ? "開始" : "確認して再開", () => void act(async () => {
              applyRoom(await send("resume", { roomId: room.id }) as ConsultationRoom);
            }), !connected || room.turns >= room.maxTurns) : null}
          </View>
          {room.reason === "limit" ? <Text style={styles.secondary}>メッセージを送ると、回数と時間の上限を新しく数え直します。</Text> : null}
        </> : null}
      </ScrollView>
      {mode === "room" && room ? <View style={styles.footer}>
        <StreamingSttFooter manual transcript={supplement} phase="idle" reduceMotion={reduceMotion !== false}
          onChangeText={setSupplement} submitDisabled={!connected || busy}
          stopAvailable={Boolean(room.run) || room.state === "running"}
          voiceStatus={room.state === "running" ? "responding" : undefined}
          onStop={() => void act(async () => { applyRoom(await send("stop", { roomId: room.id }) as ConsultationRoom); })}
          onSubmit={async (text, accepted) => {
            setError("");
            const previous = pendingSend.current;
            const submission = previous?.roomId === room.id && previous.text === text ? previous
              : { roomId: room.id, text, messageId: randomUUID() };
            pendingSend.current = submission;
            try {
              applyRoom(await send("supplement", submission) as ConsultationRoom);
              if (pendingSend.current === submission) pendingSend.current = null;
              accepted();
            }
            catch (cause) { setError(cause instanceof Error ? cause.message : "送信できません"); throw cause; }
          }} />
      </View> : null}
    </KeyboardAvoidingView>
    <UserInputModal request={userInput.request} onDecide={userInput.decide} />
    <VoiceResetConfirmationModal request={resetRequest} />
  </SafeAreaView>;
}
