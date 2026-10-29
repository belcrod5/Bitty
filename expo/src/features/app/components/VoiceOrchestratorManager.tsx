import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, SafeAreaView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useRunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketContext";
import { KeyboardAwareScrollView, KeyboardAvoidingView } from "../keyboardController";
import { effortOptionsForModel } from "../modelOptions";
import { useAppStyles } from "../styles";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { isReasoningEffort, type ReasoningEffort } from "../utils/settingsParsers";
import { DEFAULT_TTS_PROVIDER, TTS_PROVIDERS, TTS_PROVIDER_LABELS, type TtsProvider } from "../utils/audioConfig";
import { pickVoiceOrchestratorIcon, supportsVoiceOrchestratorIconPicking } from "../utils/voiceOrchestratorIconPicker";
import { AppModal } from "./AppModal";
import { SettingsSelect } from "./SettingsSelect";
import { OrchestratorLearningPanel } from "./OrchestratorLearningPanel";
import { VoiceOrchestratorIcon, type VoiceOrchestrator } from "./VoiceOrchestratorIcon";

type VoiceModel = { modelId: string; label: string; effortOptions: ReasoningEffort[] };
type Detail = {
  name: string; icon: string; publicIntroduction: string; model: string; effort: ReasoningEffort; systemInstruction: string;
  ttsProvider: TtsProvider; voiceId: string;
  topicModel: string; topicEffort: ReasoningEffort;
  overviewModel?: string; overviewEffort?: ReasoningEffort;
  models: VoiceModel[]; storedMessageCount: number; memoryCharacterCount: number;
  isolationVersion: number;
};
type List = { orchestrators: VoiceOrchestrator[]; selectedId: string };
const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "低", medium: "中", high: "高", xhigh: "非常に高い", max: "最大", ultra: "Ultra",
};

export function VoiceOrchestratorManager({ visible, list, onListChanged, onConversationChanged,
  onClose, runnerBaseUrl, runnerToken }: {
  visible: boolean; list: List; onListChanged: (list: List) => void;
  onConversationChanged: (id: string) => void; onClose: () => void;
  runnerBaseUrl?: string; runnerToken?: string;
}) {
  const manager = useRunnerWebSocketManager();
  const styles = useAppStyles();
  const { theme } = useVisualTheme();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [learningId, setLearningId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftPicker, setDraftPicker] = useState(false);
  const [generatingIntroduction, setGeneratingIntroduction] = useState(false);
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState<ReasoningEffort>("low");
  const [error, setError] = useState("");
  const [voices, setVoices] = useState<{ voiceId: string; name: string }[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voiceFilter, setVoiceFilter] = useState("");
  const draftRequestRef = useRef(0);
  const detailIdRef = useRef(detailId);
  detailIdRef.current = detailId;
  const voiceCatalogKeyRef = useRef("");
  const voiceCatalogRequestRef = useRef(0);
  voiceCatalogKeyRef.current = detail ? `${detailId}:${detail.ttsProvider}` : "";
  const request = useCallback(async (op: string, payload?: Record<string, unknown>, timeoutMs?: number) => {
    const envelope = { channel: "agent" as const, op, ...(payload ? { payload } : {}) };
    const response = timeoutMs ? await manager.request(envelope, { timeoutMs }) : await manager.request(envelope);
    const result = response.payload && typeof response.payload === "object" && !Array.isArray(response.payload)
      ? response.payload as Record<string, unknown> : {};
    if (response.op === "error") throw new Error(String(result.message || result.code || "操作に失敗しました。"));
    if (response.op !== `${op}.result`) throw new Error("Runnerの応答が不正です。");
    if (payload?.orchestratorId !== undefined && result.orchestratorId !== undefined
      && result.orchestratorId !== payload.orchestratorId) throw new Error("別のオーケストレータの応答を受信しました。");
    return result;
  }, [manager]);

  useEffect(() => {
    if (!visible) { draftRequestRef.current += 1; setDraftPicker(false); setGeneratingIntroduction(false); setBusy(false); setDetailId(null); setDetail(null); setLearningId(null); setError(""); setVoices([]);
      voiceCatalogRequestRef.current += 1; }
  }, [visible]);

  useEffect(() => {
    draftRequestRef.current += 1; setDraftPicker(false); setGeneratingIntroduction(false); setBusy(false);
    if (!visible || detailId === null) return;
    let current = true;
    voiceCatalogRequestRef.current += 1;
    setVoices([]);
    setVoicesLoading(false);
    setVoiceFilter("");
    setDetail(null);
    setError("");
    void request("voice.settings", { orchestratorId: detailId === "new" ? "main" : detailId })
      .then((value) => {
        if (!current) return;
        const settings = detailId === "new" && value.defaults && typeof value.defaults === "object"
          ? value.defaults as Record<string, unknown> : detailId === "new" ? {} : value;
        if (typeof settings.model !== "string" || !isReasoningEffort(settings.effort)
          || typeof settings.topicModel !== "string" || !isReasoningEffort(settings.topicEffort)
          || typeof settings.systemInstruction !== "string" || !Array.isArray(value.models)) {
          throw new Error("設定を読み込めません。");
        }
        const models = value.models.flatMap((model) => {
          if (!model || typeof model !== "object" || typeof model.modelId !== "string"
            || !Array.isArray(model.effortOptions)) return [];
          const efforts = model.effortOptions.filter(isReasoningEffort);
          return efforts.length ? [{ modelId: model.modelId, label: String(model.label || model.modelId), effortOptions: efforts }] : [];
        });
        setDetail({
          name: detailId === "new" ? "" : String(value.name || ""),
          icon: detailId === "new" ? "" : String(value.icon || ""),
          publicIntroduction: detailId === "new" ? "" : String(value.publicIntroduction || ""),
          ttsProvider: detailId !== "new" && TTS_PROVIDERS.includes(value.ttsProvider as TtsProvider)
            ? value.ttsProvider as TtsProvider : DEFAULT_TTS_PROVIDER,
          voiceId: detailId === "new" ? "" : String(value.voiceId || ""),
          model: settings.model, effort: settings.effort, systemInstruction: settings.systemInstruction,
          topicModel: settings.topicModel, topicEffort: settings.topicEffort,
          ...(typeof settings.overviewModel === "string"
            && isReasoningEffort(settings.overviewEffort)
            ? { overviewModel: settings.overviewModel, overviewEffort: settings.overviewEffort } : {}),
          models, storedMessageCount: Number(value.storedMessageCount || 0),
          memoryCharacterCount: Number(value.memoryCharacterCount || 0),
          isolationVersion: value.isolationVersion === 1 ? 1 : 0,
        });
      }).catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : "設定を読み込めません。"); });
    return () => { current = false; };
  }, [detailId, request, visible]);

  const loadVoices = useCallback(async () => {
    if (!detail || !runnerBaseUrl || !runnerToken || voicesLoading) return;
    const catalogKey = `${detailId}:${detail.ttsProvider}`;
    const requestId = ++voiceCatalogRequestRef.current;
    setVoicesLoading(true);
    try {
      const response = await fetch(`${runnerBaseUrl}/voices?ttsProvider=${encodeURIComponent(detail.ttsProvider)}`,
        { headers: { authorization: `Bearer ${runnerToken.trim()}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
      if (requestId !== voiceCatalogRequestRef.current || catalogKey !== voiceCatalogKeyRef.current) return;
      setVoices(Array.isArray(data?.voices) ? data.voices.flatMap((item: unknown) => {
        if (!item || typeof item !== "object" || typeof (item as { voiceId?: unknown }).voiceId !== "string") return [];
        const voice = item as { voiceId: string; name?: string };
        return [{ voiceId: voice.voiceId, name: String(voice.name || voice.voiceId) }];
      }) : []);
    } catch (cause) { if (requestId === voiceCatalogRequestRef.current
      && catalogKey === voiceCatalogKeyRef.current) {
      setError(cause instanceof Error ? cause.message : "声を読み込めません。");
    } }
    finally { if (requestId === voiceCatalogRequestRef.current
      && catalogKey === voiceCatalogKeyRef.current) setVoicesLoading(false); }
  }, [detail, detailId, runnerBaseUrl, runnerToken, voicesLoading]);

  const applyList = (value: Record<string, unknown>) => {
    if (!Array.isArray(value.orchestrators) || typeof value.selectedId !== "string") {
      throw new Error("一覧を更新できません。");
    }
    onListChanged({ orchestrators: value.orchestrators as VoiceOrchestrator[], selectedId: value.selectedId });
  };

  const save = async () => {
    if (!detail || detailId === null) return;
    setBusy(true);
    setError("");
    try {
      const result = await request(detailId === "new" ? "voice.orchestrators.create" : "voice.orchestrators.update", {
        ...(detailId === "new" ? {} : { orchestratorId: detailId }),
        name: detail.name, icon: detail.icon, publicIntroduction: detail.publicIntroduction, model: detail.model,
        ttsProvider: detail.ttsProvider, voiceId: detail.voiceId,
        effort: detail.effort, systemInstruction: detail.systemInstruction,
        topicModel: detail.topicModel, topicEffort: detail.topicEffort,
        ...(detail.overviewModel && detail.overviewEffort
          ? { overviewModel: detail.overviewModel, overviewEffort: detail.overviewEffort } : {}),
      });
      applyList(result);
      setDetailId(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存できません。"); }
    finally { setBusy(false); }
  };

  const generateIntroduction = async () => {
    if (!detail || !detailId || detailId === "new") return;
    const ownerId = detailId, draftRequest = ++draftRequestRef.current;
    setDraftPicker(false); setBusy(true); setGeneratingIntroduction(true); setError("");
    try {
      const result = await request("voice.orchestrators.introduction.draft", { orchestratorId: ownerId, model: draftModel, effort: draftEffort }, 75_000);
      if (detailIdRef.current !== ownerId || draftRequestRef.current !== draftRequest) return;
      if (typeof result.introduction !== "string") throw new Error("紹介の下書きを読み込めません。");
      setDetail((current) => current && { ...current, publicIntroduction: result.introduction as string });
    } catch (cause) { if (detailIdRef.current === ownerId && draftRequestRef.current === draftRequest) setError(cause instanceof Error ? cause.message : "紹介を作成できません。"); }
    finally { if (draftRequestRef.current === draftRequest) { setBusy(false); setGeneratingIntroduction(false); } }
  };

  const remove = () => {
    if (!detailId || detailId === "main" || detailId === "new") return;
    Alert.alert("オーケストレータを削除", "このオーケストレータの会話履歴も削除します。", [
      { text: "キャンセル", style: "cancel" },
      { text: "削除", style: "destructive", onPress: () => {
        setBusy(true);
        void request("voice.orchestrators.delete", { orchestratorId: detailId })
          .then((result) => { applyList(result); onConversationChanged(detailId); setDetailId(null); })
          .catch((cause) => setError(cause instanceof Error ? cause.message : "削除できません。"))
          .finally(() => setBusy(false));
      } },
    ]);
  };

  const clear = (kind: "memory" | "messages") => {
    if (!detailId || detailId === "new") return;
    if (kind === "memory" && detail?.isolationVersion !== 1) return;
    Alert.alert(kind === "memory" ? "メモリーをクリア" : "保持メッセージをクリア",
      kind === "memory" ? "このオーケストレータの要約メモリーを消します。" : "このオーケストレータの会話履歴を消します。", [
        { text: "キャンセル", style: "cancel" },
        { text: "クリア", style: "destructive", onPress: () => {
          setBusy(true);
          void request(kind === "memory" ? "voice.memory.clear" : "voice.messages.clear",
            { orchestratorId: detailId })
            .then((result) => {
              if (kind === "messages") onConversationChanged(detailId);
              if (detailIdRef.current !== detailId) return;
              setDetail((current) => current && { ...current,
                storedMessageCount: kind === "messages" ? 0 : current.storedMessageCount,
                memoryCharacterCount: kind === "memory" ? 0 : current.memoryCharacterCount });
              if (kind === "memory" && typeof result.memoryCharacterCount !== "number") throw new Error("メモリーを確認できません。");
            })
            .catch((cause) => { if (detailIdRef.current === detailId) setError(cause instanceof Error ? cause.message : "クリアできません。"); })
            .finally(() => setBusy(false));
        } },
      ]);
  };

  const pickIcon = async () => {
    if (!supportsVoiceOrchestratorIconPicking) return;
    try {
      const icon = await pickVoiceOrchestratorIcon();
      if (icon) setDetail((current) => current && { ...current, icon });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "画像を読み込めません。"); }
  };

  const currentModel = detail?.models.find((model) => model.modelId === detail.model);
  const efforts = effortOptionsForModel(currentModel && { supportsReasoningEffort: true, effortOptions: currentModel.effortOptions });
  const currentTopicModel = detail?.models.find((model) => model.modelId === detail.topicModel);
  const topicEfforts = effortOptionsForModel(currentTopicModel
    && { supportsReasoningEffort: true, effortOptions: currentTopicModel.effortOptions });
  const currentOverviewModel = detail?.models.find((model) => model.modelId === detail.overviewModel);
  const overviewEfforts = effortOptionsForModel(currentOverviewModel
    && { supportsReasoningEffort: true, effortOptions: currentOverviewModel.effortOptions });

  const learningOrchestrator = list.orchestrators.find((item) => item.id === learningId);
  const back = () => learningId ? setLearningId(null) : detailId === null ? onClose() : setDetailId(null);

  return (
    <><AppModal visible={visible} animationType="slide" onRequestClose={back}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}
        automaticOffset={Platform.OS === "ios"}>
      <SafeAreaView style={styles.settingsScreen}>
        <KeyboardAwareScrollView testID="orchestrator-settings-scroll" style={{ flex: 1 }}
          contentContainerStyle={styles.settingsContent} keyboardShouldPersistTaps="handled">
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="戻る"
            style={styles.settingsBackButton} onPress={back}>
            <Text style={styles.settingsBackButtonText}>‹ {detailId === null && !learningId ? "音声会話" : "オーケストレータ"}</Text>
          </TouchableOpacity>
          <Text style={styles.settingsTitle}>{learningId ? "学習・評価" : detailId === null ? "オーケストレータ" : detailId === "new" ? "追加" : "詳細"}</Text>
          {learningId ? learningOrchestrator ? <>
            <SettingsSelect icon="chatbubbles-outline" label="オーケストレータ"
              options={list.orchestrators.map((item) => ({ value: item.id, label: item.name }))}
              selectedValue={learningId} onSelect={setLearningId} />
            <OrchestratorLearningPanel key={learningId} request={request} orchestrator={learningOrchestrator} />
          </> : <Text style={styles.settingsErrorText}>オーケストレータが見つかりません。</Text> : detailId === null ? (
            <View style={styles.settingsSection}>
              <View style={styles.settingsGroup}>
                {list.orchestrators.map((item) => (
                  <Pressable key={item.id} testID={`orchestrator-row-${item.id}`}
                    accessibilityRole="button" accessibilityLabel={`${item.name}の設定${(item.learningUnreadCount || 0) > 0
                      ? `、新しく学んだこと ${item.learningUnreadCount}件` : ""}`}
                    onPress={() => setDetailId(item.id)} style={[styles.settingsRow, styles.settingsRowDivider, { gap: 12 }]}>
                    <VoiceOrchestratorIcon orchestrator={item} />
                    <Text style={[styles.settingsRowLabel, { flex: 1 }]}>{item.name}</Text>
                    <Text style={styles.settingsRowValue}>›</Text>
                  </Pressable>
                ))}
                <TouchableOpacity testID="orchestrator-add" accessibilityRole="button" accessibilityLabel="オーケストレータを追加"
                  onPress={() => setDetailId("new")} style={styles.settingsRow}>
                  <Text style={styles.settingsActionText}>＋ 追加</Text>
                </TouchableOpacity>
                <TouchableOpacity testID="orchestrator-learning-open" accessibilityRole="button"
                  accessibilityLabel="学習・評価を開く" onPress={() => setLearningId(list.selectedId)}
                  style={[styles.settingsRow, { borderTopWidth: 1, borderTopColor: theme.colors.groupedDivider }]}>
                  <View style={styles.settingsRowLabelWrap}>
                    <Text style={styles.settingsRowLabel}>学習・評価</Text>
                    <Text style={styles.settingsRowDescription}>オーケストレータごとに管理</Text>
                  </View>
                  <Text style={styles.settingsRowValue}>›</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : detail ? (
            <View style={styles.settingsSection}>
              <Text style={styles.settingsFooterText}>{detail.isolationVersion === 1
                ? "記憶・学習・スキルは専用です。共通スキルや外部連携は自動で引き継ぎません。"
                : "分離機能を使うにはRunnerを更新してください。"}</Text>
              <View style={styles.settingsGroup}>
                <View style={[styles.settingsRow, styles.settingsRowDivider, { gap: 12 }]}>
                  <VoiceOrchestratorIcon orchestrator={{ id: detailId, name: detail.name || "?", icon: detail.icon }} size={52} />
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="アイコン画像を選ぶ"
                    disabled={busy || !supportsVoiceOrchestratorIconPicking} onPress={() => void pickIcon()}>
                    <Text style={styles.settingsActionText}>画像を選ぶ</Text>
                  </TouchableOpacity>
                  {detail.icon ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="アイコン画像を削除"
                    disabled={busy} onPress={() => setDetail({ ...detail, icon: "" })}>
                    <Text style={styles.settingsDangerText}>削除</Text>
                  </TouchableOpacity> : null}
                </View>
                <View style={[styles.settingsRow, styles.settingsRowDivider]}>
                  <Text style={styles.settingsRowLabel}>名前</Text>
                  <TextInput testID="orchestrator-name" accessibilityLabel="オーケストレータの名前"
                    value={detail.name} onChangeText={(name) => setDetail({ ...detail, name })}
                    maxLength={80} editable={!busy} style={{ flex: 1, marginLeft: 12, color: theme.colors.groupedTextPrimary }} />
                </View>
                <View style={[styles.settingsRow, styles.settingsRowDivider, { flexDirection: "column", alignItems: "stretch", gap: 10 }]}>
                  <Text style={styles.settingsRowLabel}>得意分野・担当</Text>
                  <TextInput accessibilityLabel="得意分野・担当" multiline maxLength={1000} editable={!busy}
                    value={detail.publicIntroduction} onChangeText={(publicIntroduction) => setDetail({ ...detail, publicIntroduction })}
                    placeholder="例：メールの検索・整理、顧客への返信相談"
                    placeholderTextColor={theme.colors.textMuted}
                    style={{ color: theme.colors.groupedTextPrimary, minHeight: 70, textAlignVertical: "top" }} />
                  <Text style={styles.settingsRowDescription}>相談相手へ公開する紹介です。下書きは直近12メッセージと採用済み学習10件までを使い、メモリー全体は読みません。保存前に編集できます。</Text>
                  {generatingIntroduction ? <Text role="status" style={styles.settingsFooterText}>紹介を作成しています…</Text> : null}
                  {detailId !== "new" ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="紹介を自動生成"
                    disabled={busy} onPress={() => { setDraftModel(detail.model); setDraftEffort(detail.effort); setDraftPicker(true); }}>
                    <Text style={styles.settingsActionText}>紹介を自動生成</Text>
                  </TouchableOpacity> : null}
                </View>
                <SettingsSelect icon="chatbubble-ellipses-outline" label="モデル"
                  options={detail.models.map((model) => ({ value: model.modelId, label: model.label }))}
                  selectedValue={detail.model} onSelect={(model) => {
                    const option = detail.models.find((item) => item.modelId === model);
                    if (option) setDetail({ ...detail, model,
                      effort: option.effortOptions.includes(detail.effort) ? detail.effort : option.effortOptions[0] });
                  }} />
                <SettingsSelect icon="options-outline" label="エフォート"
                  options={efforts.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] }))}
                  selectedValue={detail.effort} onSelect={(effort) => setDetail({ ...detail, effort: effort as ReasoningEffort })} />
                <SettingsSelect icon="headset-outline" label="読み上げサービス"
                  options={TTS_PROVIDERS.map((provider) => ({ value: provider, label: TTS_PROVIDER_LABELS[provider] }))}
                  selectedValue={detail.ttsProvider} onSelect={(ttsProvider) => {
                    voiceCatalogRequestRef.current += 1;
                    setDetail({ ...detail, ttsProvider, voiceId: "" }); setVoices([]); setVoiceFilter("");
                    setVoicesLoading(false);
                  }} />
                <SettingsSelect icon="person-circle-outline" label="読み上げの声"
                  options={[{ value: "", label: "サービスの既定" }, ...voices
                    .filter((voice) => !voiceFilter || `${voice.name} ${voice.voiceId}`.toLowerCase()
                      .includes(voiceFilter.trim().toLowerCase()))
                    .map((voice) => ({ value: voice.voiceId, label: voice.name, description: voice.voiceId }))]}
                  selectedValue={detail.voiceId} onSelect={(voiceId) => setDetail({ ...detail, voiceId })}
                  loading={voicesLoading} searchValue={voiceFilter} onSearchChange={setVoiceFilter}
                  searchPlaceholder="声の名前で検索" onOpen={() => void loadVoices()} />
                <SettingsSelect icon="git-branch-outline" label="話題判定モデル"
                  options={detail.models.map((model) => ({ value: model.modelId, label: model.label }))}
                  selectedValue={detail.topicModel} onSelect={(topicModel) => {
                    const option = detail.models.find((item) => item.modelId === topicModel);
                    if (option) setDetail({ ...detail, topicModel,
                      topicEffort: option.effortOptions.includes(detail.topicEffort)
                        ? detail.topicEffort : option.effortOptions[0] });
                  }} />
                <SettingsSelect icon="speedometer-outline" label="話題判定エフォート"
                  options={topicEfforts.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] }))}
                  selectedValue={detail.topicEffort}
                  onSelect={(topicEffort) => setDetail({ ...detail, topicEffort: topicEffort as ReasoningEffort })} />
                {detail.overviewModel && detail.overviewEffort ? <>
                  <SettingsSelect icon="list-outline" label="To Do表示モデル"
                    options={detail.models.map((model) => ({ value: model.modelId, label: model.label }))}
                    selectedValue={detail.overviewModel} onSelect={(overviewModel) => {
                      const option = detail.models.find((item) => item.modelId === overviewModel);
                      if (option) setDetail({ ...detail, overviewModel,
                        overviewEffort: detail.overviewEffort && option.effortOptions.includes(detail.overviewEffort)
                          ? detail.overviewEffort : option.effortOptions[0] });
                    }} />
                  <SettingsSelect icon="options-outline" label="To Do表示エフォート"
                    options={overviewEfforts.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] }))}
                    selectedValue={detail.overviewEffort}
                    onSelect={(overviewEffort) => setDetail({ ...detail,
                      overviewEffort: overviewEffort as ReasoningEffort })} />
                </> : null}
                {!currentTopicModel ? <Text style={styles.settingsErrorText}>話題判定モデルは現在利用できません。</Text> : null}
                <View style={[styles.settingsRow, styles.settingsRowDivider, { flexDirection: "column", alignItems: "stretch" }]}>
                  <Text style={styles.settingsRowLabel}>システム指示</Text>
                  <TextInput testID="orchestrator-system-instruction" accessibilityLabel="システム指示"
                    value={detail.systemInstruction} onChangeText={(systemInstruction) => setDetail({ ...detail, systemInstruction })}
                    multiline editable={!busy} style={{ minHeight: 76, padding: 10, borderRadius: 8,
                      color: theme.colors.groupedTextPrimary, backgroundColor: theme.colors.surfaceRaised, textAlignVertical: "top" }} />
                </View>
              </View>
              {detailId !== "new" ? <View style={[styles.settingsGroup, { marginTop: 20 }]}>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="このオーケストレータの学習・評価を開く"
                  onPress={() => setLearningId(detailId)} style={[styles.settingsRow, styles.settingsRowDivider]}>
                  <Text style={styles.settingsActionText}>学習・評価</Text>
                  <Text style={styles.settingsRowValue}>›</Text>
                </TouchableOpacity>
                <View style={[styles.settingsRow, styles.settingsRowDivider]}>
                  <View style={styles.settingsRowLabelWrap}>
                    <Text style={styles.settingsRowLabel}>メモリー</Text>
                    <Text style={styles.settingsRowDescription}>{detail.isolationVersion === 1
                      ? `${detail.memoryCharacterCount} 文字 · このオーケストレータ専用` : "専用メモリーに対応するRunnerへ更新してください。"}</Text>
                  </View>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="メモリーをクリア"
                    disabled={busy || detail.isolationVersion !== 1} onPress={() => clear("memory")}><Text style={styles.settingsDangerText}>クリア</Text></TouchableOpacity>
                </View>
                <View style={[styles.settingsRow, detailId === "main" ? undefined : styles.settingsRowDivider]}>
                  <View style={styles.settingsRowLabelWrap}>
                    <Text style={styles.settingsRowLabel}>保持メッセージ</Text>
                    <Text style={styles.settingsRowDescription}>{detail.storedMessageCount} 件</Text>
                  </View>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="保持メッセージをクリア"
                    disabled={busy} onPress={() => clear("messages")}><Text style={styles.settingsDangerText}>クリア</Text></TouchableOpacity>
                </View>
                {detailId !== "main" ? <TouchableOpacity testID="orchestrator-delete" accessibilityRole="button"
                  accessibilityLabel="オーケストレータを削除" disabled={busy} onPress={remove} style={styles.settingsRow}>
                  <Text style={styles.settingsDangerText}>オーケストレータを削除</Text>
                </TouchableOpacity> : null}
              </View> : null}
            </View>
          ) : null}
          {error && (!detailId || !detail) ? <Text style={styles.settingsErrorText}>{error}</Text> : null}
        </KeyboardAwareScrollView>
        {detailId !== null && detail ? <View style={{ width: "100%", maxWidth: 760, alignSelf: "center",
          paddingHorizontal: 18, paddingTop: 12, paddingBottom: 12, gap: 8 }}>
          {error ? <Text accessibilityRole="alert" style={styles.settingsErrorText}>{error}</Text> : null}
          <TouchableOpacity testID="orchestrator-save" accessibilityRole="button" accessibilityLabel="オーケストレータを保存"
            disabled={busy} onPress={() => void save()}
            style={[styles.settingsPrimaryButton, { width: "100%", minHeight: 52, alignSelf: "center" }]}>
            <Text style={styles.settingsPrimaryButtonText}>保存</Text>
          </TouchableOpacity>
        </View> : null}
      </SafeAreaView>
      </KeyboardAvoidingView>
    </AppModal>
    {draftPicker ? <AppModal visible={visible} animationType="slide" onRequestClose={() => setDraftPicker(false)}>
      <SafeAreaView style={styles.settingsScreen}>
        <View style={styles.settingsContent}>
          <Text style={styles.settingsTitle}>紹介の下書き</Text>
          <Text style={styles.settingsFooterText}>生成に使うモデルを選んでください。紹介の保存や本人の通常モデルの変更は行いません。</Text>
          <SettingsSelect icon="chatbubble-ellipses-outline" label="紹介のモデル"
            options={detail?.models.map((item) => ({ value: item.modelId, label: item.label })) || []}
            selectedValue={draftModel} onSelect={(model) => {
              const option = detail?.models.find((item) => item.modelId === model);
              if (option) { setDraftModel(model); if (!option.effortOptions.includes(draftEffort)) setDraftEffort(option.effortOptions[0]); }
            }} />
          <SettingsSelect icon="options-outline" label="紹介のエフォート"
            options={(detail?.models.find((item) => item.modelId === draftModel)?.effortOptions || []).map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] }))}
            selectedValue={draftEffort} onSelect={(effort) => setDraftEffort(effort as ReasoningEffort)} />
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="選んだモデルで紹介を生成" onPress={() => void generateIntroduction()}>
            <Text style={styles.settingsActionText}>下書きを作る</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="紹介の生成をキャンセル" onPress={() => setDraftPicker(false)}>
            <Text style={styles.settingsActionText}>キャンセル</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </AppModal> : null}</>
  );
}
