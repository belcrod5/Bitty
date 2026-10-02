import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, SafeAreaView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useRunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketContext";
import { KeyboardAwareScrollView } from "../keyboardController";
import { effortOptionsForModel } from "../modelOptions";
import { useAppStyles } from "../styles";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { isReasoningEffort, type ReasoningEffort } from "../utils/settingsParsers";
import { pickVoiceOrchestratorIcon, supportsVoiceOrchestratorIconPicking } from "../utils/voiceOrchestratorIconPicker";
import { AppModal } from "./AppModal";
import { SettingsSelect } from "./SettingsSelect";
import { VoiceOrchestratorIcon, type VoiceOrchestrator } from "./VoiceOrchestratorIcon";

type VoiceModel = { modelId: string; label: string; effortOptions: ReasoningEffort[] };
type Detail = {
  name: string; icon: string; model: string; effort: ReasoningEffort; systemInstruction: string;
  models: VoiceModel[]; storedMessageCount: number; memoryCharacterCount: number;
};
type List = { orchestrators: VoiceOrchestrator[]; selectedId: string };
const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "低", medium: "中", high: "高", xhigh: "非常に高い", max: "最大", ultra: "Ultra",
};

export function VoiceOrchestratorManager({ visible, list, onListChanged, onConversationChanged, onClose }: {
  visible: boolean; list: List; onListChanged: (list: List) => void;
  onConversationChanged: (id: string) => void; onClose: () => void;
}) {
  const manager = useRunnerWebSocketManager();
  const styles = useAppStyles();
  const { theme } = useVisualTheme();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useCallback(async (op: string, payload?: Record<string, unknown>) => {
    const response = await manager.request({ channel: "agent", op, ...(payload ? { payload } : {}) });
    const result = response.payload && typeof response.payload === "object" && !Array.isArray(response.payload)
      ? response.payload as Record<string, unknown> : {};
    if (response.op === "error") throw new Error(String(result.message || result.code || "操作に失敗しました。"));
    if (response.op !== `${op}.result`) throw new Error("Runnerの応答が不正です。");
    return result;
  }, [manager]);

  useEffect(() => {
    if (!visible) { setDetailId(null); setDetail(null); setError(""); }
  }, [visible]);

  useEffect(() => {
    if (!visible || detailId === null) return;
    let current = true;
    setDetail(null);
    setError("");
    void request("voice.settings", { orchestratorId: detailId === "new" ? "main" : detailId })
      .then((value) => {
        if (!current) return;
        if (typeof value.model !== "string" || !isReasoningEffort(value.effort)
          || typeof value.systemInstruction !== "string" || !Array.isArray(value.models)) {
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
          model: value.model, effort: value.effort, systemInstruction: value.systemInstruction,
          models, storedMessageCount: Number(value.storedMessageCount || 0),
          memoryCharacterCount: Number(value.memoryCharacterCount || 0),
        });
      }).catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : "設定を読み込めません。"); });
    return () => { current = false; };
  }, [detailId, request, visible]);

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
        name: detail.name, icon: detail.icon, model: detail.model,
        effort: detail.effort, systemInstruction: detail.systemInstruction,
      });
      applyList(result);
      setDetailId(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存できません。"); }
    finally { setBusy(false); }
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
    Alert.alert(kind === "memory" ? "共有メモリーをクリア" : "保持メッセージをクリア",
      kind === "memory" ? "全オーケストレータの要約メモリーを消します。" : "このオーケストレータの会話履歴を消します。", [
        { text: "キャンセル", style: "cancel" },
        { text: "クリア", style: "destructive", onPress: () => {
          setBusy(true);
          void request(kind === "memory" ? "voice.memory.clear" : "voice.messages.clear",
            { orchestratorId: detailId })
            .then((result) => {
              setDetail((current) => current && { ...current,
                storedMessageCount: kind === "messages" ? 0 : current.storedMessageCount,
                memoryCharacterCount: kind === "memory" ? 0 : current.memoryCharacterCount });
              if (kind === "messages") onConversationChanged(detailId);
              if (kind === "memory" && typeof result.memoryCharacterCount !== "number") throw new Error("メモリーを確認できません。");
            })
            .catch((cause) => setError(cause instanceof Error ? cause.message : "クリアできません。"))
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

  return (
    <AppModal visible={visible} animationType="slide" onRequestClose={() => detailId === null ? onClose() : setDetailId(null)}>
      <SafeAreaView style={styles.settingsScreen}>
        <KeyboardAwareScrollView contentContainerStyle={styles.settingsContent} keyboardShouldPersistTaps="handled">
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="戻る"
            style={styles.settingsBackButton} onPress={() => detailId === null ? onClose() : setDetailId(null)}>
            <Text style={styles.settingsBackButtonText}>‹ {detailId === null ? "音声会話" : "オーケストレータ"}</Text>
          </TouchableOpacity>
          <Text style={styles.settingsTitle}>{detailId === null ? "オーケストレータ" : detailId === "new" ? "追加" : "詳細"}</Text>
          {detailId === null ? (
            <View style={styles.settingsSection}>
              <View style={styles.settingsGroup}>
                {list.orchestrators.map((item) => (
                  <Pressable key={item.id} testID={`orchestrator-row-${item.id}`}
                    accessibilityRole="button" accessibilityLabel={`${item.name}の設定`}
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
              </View>
            </View>
          ) : detail ? (
            <View style={styles.settingsSection}>
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
                <View style={[styles.settingsRow, styles.settingsRowDivider, { flexDirection: "column", alignItems: "stretch" }]}>
                  <Text style={styles.settingsRowLabel}>システム指示</Text>
                  <TextInput testID="orchestrator-system-instruction" accessibilityLabel="システム指示"
                    value={detail.systemInstruction} onChangeText={(systemInstruction) => setDetail({ ...detail, systemInstruction })}
                    multiline editable={!busy} style={{ minHeight: 76, padding: 10, borderRadius: 8,
                      color: theme.colors.groupedTextPrimary, backgroundColor: theme.colors.surfaceRaised, textAlignVertical: "top" }} />
                </View>
                <TouchableOpacity testID="orchestrator-save" accessibilityRole="button" accessibilityLabel="オーケストレータを保存"
                  disabled={busy} onPress={() => void save()} style={styles.settingsRow}>
                  <Text style={styles.settingsActionText}>保存</Text>
                </TouchableOpacity>
              </View>
              {detailId !== "new" ? <View style={[styles.settingsGroup, { marginTop: 20 }]}>
                <View style={[styles.settingsRow, styles.settingsRowDivider]}>
                  <View style={styles.settingsRowLabelWrap}>
                    <Text style={styles.settingsRowLabel}>共有メモリー</Text>
                    <Text style={styles.settingsRowDescription}>{detail.memoryCharacterCount} 文字 · 全オーケストレータで共有</Text>
                  </View>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="共有メモリーをクリア"
                    disabled={busy} onPress={() => clear("memory")}><Text style={styles.settingsDangerText}>クリア</Text></TouchableOpacity>
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
          {error ? <Text style={styles.settingsErrorText}>{error}</Text> : null}
        </KeyboardAwareScrollView>
      </SafeAreaView>
    </AppModal>
  );
}
