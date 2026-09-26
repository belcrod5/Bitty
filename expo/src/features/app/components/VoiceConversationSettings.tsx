import { useCallback, useEffect, useState } from "react";
import { Alert, Text, TouchableOpacity, View } from "react-native";
import { useRunnerWebSocketManager, useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import { effortOptionsForModel } from "../modelOptions";
import { useAppStyles } from "../styles";
import { isReasoningEffort, type ReasoningEffort } from "../utils/settingsParsers";
import { SettingsSelect } from "./SettingsSelect";

type VoiceModel = { modelId: string; label: string; effortOptions: ReasoningEffort[] };
type VoiceSettings = {
  model: string;
  effort: ReasoningEffort;
  models: VoiceModel[];
  storedMessageCount: number;
  memoryCharacterCount: number;
};

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "低", medium: "中", high: "高", xhigh: "非常に高い", max: "最大", ultra: "Ultra",
};

function countsOf(result: Record<string, unknown>) {
  const storedMessageCount = result.storedMessageCount;
  const memoryCharacterCount = result.memoryCharacterCount;
  if (typeof storedMessageCount !== "number" || !Number.isSafeInteger(storedMessageCount) || storedMessageCount < 0
    || typeof memoryCharacterCount !== "number" || !Number.isSafeInteger(memoryCharacterCount) || memoryCharacterCount < 0) {
    throw new Error("音声会話の保存件数を確認できません。");
  }
  return { storedMessageCount, memoryCharacterCount };
}

export function VoiceConversationSettings() {
  const styles = useAppStyles();
  const manager = useRunnerWebSocketManager();
  const { connected, generation } = useRunnerWebSocketSnapshot();
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
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

  const readSettings = useCallback(async (): Promise<VoiceSettings> => {
    const result = await request("voice.settings");
    if (typeof result.model !== "string" || !isReasoningEffort(result.effort)
      || !Array.isArray(result.models)) throw new Error("音声会話の設定を読み込めません。");
    const models = result.models.flatMap((value) => {
      if (!value || typeof value !== "object" || typeof value.modelId !== "string"
        || !Array.isArray(value.effortOptions)) return [];
      const efforts = value.effortOptions.filter(isReasoningEffort);
      return efforts.length ? [{ modelId: value.modelId, label: String(value.label || value.modelId), effortOptions: efforts }] : [];
    });
    return { model: result.model, effort: result.effort, models, ...countsOf(result) };
  }, [request]);

  useEffect(() => {
    let current = true;
    setSettings(null);
    void manager.connect().then(readSettings).then((loaded) => {
      if (current) {
        setSettings(loaded);
        setError("");
      }
    }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : "Runnerに接続できません。");
    });
    return () => { current = false; };
  }, [connected, generation, manager, readSettings]);

  const update = async (model: string, effort: ReasoningEffort) => {
    setBusy(true);
    setError("");
    try {
      const result = await request("voice.settings.update", { model, effort });
      setSettings((current) => current && { ...current, model: String(result.model), effort: result.effort as ReasoningEffort });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "設定を保存できません。");
    } finally { setBusy(false); }
  };

  const clear = (kind: "memory" | "messages") => {
    Alert.alert(
      kind === "memory" ? "メモリーをクリア" : "保持メッセージをクリア",
      kind === "memory"
        ? "要約メモリーを消します。保持メッセージは残り、必要に応じて再び要約されます。"
        : "保持メッセージを消します。要約メモリーは残ります。",
      [
        { text: "キャンセル", style: "cancel" },
        { text: "クリア", style: "destructive", onPress: () => {
          setBusy(true);
          setError("");
          void request(kind === "memory" ? "voice.memory.clear" : "voice.messages.clear")
            .then((result) => {
              const counts = countsOf(result);
              if (manager.getSnapshot().connected && manager.getSnapshot().generation === generation) {
                setSettings((current) => current && { ...current, ...counts });
              }
            })
            .catch((cause) => setError(cause instanceof Error ? cause.message : "クリアできません。"))
            .finally(() => setBusy(false));
        } },
      ],
    );
  };

  const currentModel = settings?.models.find((model) => model.modelId === settings.model);
  const efforts = effortOptionsForModel(currentModel && { supportsReasoningEffort: true, effortOptions: currentModel.effortOptions });

  return (
    <View style={styles.settingsSection}>
      <View style={styles.settingsSectionHeader}><Text style={styles.settingsSectionTitle}>音声会話</Text></View>
      <View style={styles.settingsGroup}>
        <SettingsSelect
          icon="chatbubble-ellipses-outline" label="音声会話のモデル"
          options={(settings?.models || []).map((model) => ({ value: model.modelId, label: model.label }))}
          selectedValue={settings?.model || ""}
          loading={!settings && connected}
          onSelect={(modelId) => {
            if (!settings || busy) return;
            const option = settings.models.find((item) => item.modelId === modelId);
            if (!option) return;
            const effort = option.effortOptions.includes(settings.effort) ? settings.effort : option.effortOptions[0];
            void update(modelId, effort);
          }}
        />
        <SettingsSelect
          icon="options-outline" label="音声会話のエフォート"
          options={efforts.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] }))}
          selectedValue={settings?.effort || ""}
          onSelect={(effort) => { if (settings && !busy) void update(settings.model, effort as ReasoningEffort); }}
        />
        <View style={[styles.settingsRow, styles.settingsRowDivider]}>
          <View style={styles.settingsRowLabelWrap}>
            <Text style={styles.settingsRowLabel}>要約メモリー</Text>
            <Text style={styles.settingsRowDescription}>
              {`保存中: ${settings?.memoryCharacterCount ?? "--"}文字 · 保持メッセージから再生成される場合があります`}
            </Text>
          </View>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="メモリーをクリア"
            disabled={busy || !connected || !settings} onPress={() => clear("memory")}>
            <Text style={styles.settingsDangerText}>クリア</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.settingsRow}>
          <View style={styles.settingsRowLabelWrap}>
            <Text style={styles.settingsRowLabel}>保持メッセージ</Text>
            <Text style={styles.settingsRowDescription}>
              {`保存中: ${settings?.storedMessageCount ?? "--"}件 · 要約メモリーは残します`}
            </Text>
          </View>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="保持メッセージをクリア"
            disabled={busy || !connected || !settings} onPress={() => clear("messages")}>
            <Text style={styles.settingsDangerText}>クリア</Text>
          </TouchableOpacity>
        </View>
        {error ? <Text style={styles.settingsErrorText}>{error}</Text> : null}
      </View>
    </View>
  );
}
