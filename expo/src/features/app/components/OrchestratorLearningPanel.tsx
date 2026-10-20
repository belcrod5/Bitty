import { useCallback, useEffect, useRef, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { useAppStyles } from "../styles";
import { isReasoningEffort, type ReasoningEffort } from "../utils/settingsParsers";
import { SettingsSelect } from "./SettingsSelect";
import type { VoiceOrchestrator } from "./VoiceOrchestratorIcon";

type Model = { modelId: string; label: string; effortOptions: ReasoningEffort[] };
type Candidate = {
  id: string; kind: string; content: string; conditions: string; reason: string;
  scope: { orchestratorId: string }; evidence: { pairSeq: number }[];
};
type LearningStatus = {
  settings: { model: string; effort: string; settingsRevision: number };
  status: string; enabled: boolean; observedThrough: number; processedThrough: number;
  pendingCount: number; candidates: Candidate[];
  gaps: { from: number; through: number; reason: string }[];
  error: { code: string; message: string } | null;
  outputLimitEnforced: boolean;
  usage: {
    blockedReason: string | null;
    budget: { day: string; calls: number; tokens: number; maxCalls: number; maxTokens: number };
    today: { measuredCalls: number; partialCalls: number; missingCalls: number; unpricedCalls: number;
      inputTokens: number | null; outputTokens: number | null; reservationChargedTokens: number;
      anonymousCalls: number; estimatedCosts: { currency: string; amount: number }[] };
    priceSnapshot: { version: string } | null;
  } | null;
};
type Request = (op: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "低", medium: "中", high: "高", xhigh: "非常に高い", max: "最大", ultra: "Ultra",
};
const STATUS_LABELS: Record<string, string> = {
  unconfigured: "モデル未設定", observing: "会話を観測中", analyzing: "分析中",
  paused: "保留中", retry_exhausted: "再試行の上限に達したため保留中",
};
const KIND_LABELS: Record<string, string> = {
  preference: "好み・応答方針", procedure: "反復手順", batch_proposal: "一括提案のパターン",
};

function readStatus(value: Record<string, unknown>): LearningStatus {
  if (!value.settings || typeof value.settings !== "object" || typeof value.status !== "string"
    || !Array.isArray(value.candidates) || !Array.isArray(value.gaps)
    || (value.usage !== null && (!value.usage || typeof value.usage !== "object"))) throw new Error("学習状態を読み込めません。");
  const state = value as unknown as LearningStatus;
  if (typeof state.settings.model !== "string" || typeof state.settings.effort !== "string"
    || !Number.isSafeInteger(state.settings.settingsRevision)
    || (state.usage !== null && (!state.usage.budget || !state.usage.today || !Array.isArray(state.usage.today.estimatedCosts)))
    || state.candidates.some((item) => !item || typeof item.content !== "string"
      || typeof item.conditions !== "string" || typeof item.reason !== "string"
      || !item.scope || typeof item.scope.orchestratorId !== "string" || !Array.isArray(item.evidence))
    || state.gaps.some((item) => !item || typeof item.reason !== "string")
    || (state.error !== null && (!state.error || typeof state.error.message !== "string"))) {
    throw new Error("学習状態を読み込めません。");
  }
  return state;
}

export function OrchestratorLearningPanel({ request, orchestrators }: {
  request: Request; orchestrators: VoiceOrchestrator[];
}) {
  const styles = useAppStyles();
  const [status, setStatus] = useState<LearningStatus | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [saved, setSaved] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setBusy(true); setError(""); setCatalogError(""); setSaved(false);
    try {
      const [state, catalog] = await Promise.allSettled([
        request("voice.learning.status"), request("voice.settings", { orchestratorId: "main" }),
      ]);
      if (id !== requestId.current) return;
      if (state.status === "rejected") throw state.reason;
      const value = readStatus(state.value);
      setStatus(value);
      setModel(value.settings.model || ""); setEffort(value.settings.effort || "");
      if (catalog.status === "rejected" || !Array.isArray(catalog.value.models)) {
        setModels([]); setCatalogError("モデル一覧を取得できません。"); return;
      }
      const options = catalog.value.models.flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return [];
        const option = item as { modelId?: unknown; label?: unknown; effortOptions?: unknown };
        if (typeof option.modelId !== "string" || !Array.isArray(option.effortOptions)) return [];
        const efforts = option.effortOptions.filter(isReasoningEffort);
        return efforts.length ? [{ modelId: option.modelId, label: String(option.label || option.modelId),
          effortOptions: efforts }] : [];
      });
      setModels(options);
    } catch (cause) {
      if (id === requestId.current) setError(cause instanceof Error ? cause.message : "学習状態を読み込めません。");
    } finally { if (id === requestId.current) setBusy(false); }
  }, [request]);

  useEffect(() => {
    void load();
    return () => { requestId.current += 1; };
  }, [load]);

  const selectedModel = models.find((item) => item.modelId === model);
  const validSelection = (!model && !effort) || Boolean(selectedModel?.effortOptions.includes(effort as ReasoningEffort));
  const selectionChanged = status && (model !== status.settings.model || effort !== status.settings.effort);
  const save = async () => {
    if (!status || !validSelection || !selectionChanged) return;
    const id = ++requestId.current;
    setBusy(true); setError(""); setSaved(false);
    try {
      const value = readStatus(await request("voice.learning.configure", {
        model, effort, settingsRevision: status.settings.settingsRevision,
      }));
      if (id !== requestId.current) return;
      setStatus(value); setModel(value.settings.model); setEffort(value.settings.effort); setSaved(true);
    } catch (cause) {
      if (id === requestId.current) setError(cause instanceof Error ? cause.message : "設定を保存できません。");
    } finally { if (id === requestId.current) setBusy(false); }
  };

  return <>
    <Text style={styles.settingsFooterText}>全オーケストレータ共通 · 観測のみ</Text>
    <Text style={styles.settingsFooterText}>会話から学習候補を作成します。現在の回答にはまだ反映されません。</Text>
    <View style={styles.settingsSection}>
      <View style={styles.settingsGroup}>
        <SettingsSelect icon="bulb-outline" label="学習・評価用モデル"
          options={[{ value: "", label: "未設定（分析を停止）" }, ...models.map((item) => ({ value: item.modelId, label: item.label }))]}
          selectedValue={model} placeholder="未設定" loading={!status && busy}
          onSelect={(value) => {
            if (busy) return;
            if (!value) { setModel(""); setEffort(""); setSaved(false); return; }
            const option = models.find((item) => item.modelId === value);
            if (option) { setModel(value); setEffort(option.effortOptions.includes(effort as ReasoningEffort)
              ? effort : option.effortOptions[0]); setSaved(false); }
          }} />
        <SettingsSelect icon="options-outline" label="学習・評価用エフォート"
          options={(selectedModel?.effortOptions || []).map((value) => ({ value, label: EFFORT_LABELS[value] }))}
          selectedValue={effort} placeholder="モデルを選択してください"
          onSelect={(value) => { if (!busy) { setEffort(value); setSaved(false); } }} />
      </View>
      <Text style={styles.settingsFooterText}>保存した設定は次の分析バッチから適用されます。未設定の間は会話の観測だけを行います。実行中の分析は完了まで継続し、利用量の記録を残します。</Text>
      {catalogError ? <Text accessibilityRole="alert" style={styles.settingsErrorText}>{catalogError}</Text> : null}
      {model && !validSelection && !catalogError ? <Text style={styles.settingsErrorText}>選択中のモデル・エフォートは現在利用できません。別の設定を選んでください。</Text> : null}
      <TouchableOpacity testID="learning-settings-save" accessibilityRole="button"
        accessibilityLabel="学習・評価用設定を保存" disabled={busy || !status || !validSelection || !selectionChanged}
        style={[styles.settingsPrimaryButton, { minHeight: 48, opacity: busy || !status || !validSelection || !selectionChanged ? 0.5 : 1 }]}
        onPress={() => void save()}>
        <Text style={styles.settingsPrimaryButtonText}>{busy ? "処理中…" : "設定を保存"}</Text>
      </TouchableOpacity>
      {saved ? <Text accessibilityRole="alert" style={styles.settingsSuccessText}>設定を保存しました。</Text> : null}
    </View>
    {error ? <Text accessibilityRole="alert" style={styles.settingsErrorText}>{error}</Text> : null}
    <TouchableOpacity testID="learning-status-refresh" accessibilityRole="button" accessibilityLabel="学習状態を更新"
      disabled={busy} onPress={() => void load()} style={styles.settingsBackButton}>
      <Text style={styles.settingsActionText}>状態を更新</Text>
    </TouchableOpacity>
    {status ? <>
      <View style={styles.settingsSection}>
        <Text style={styles.settingsSectionTitle}>学習状態</Text>
        <View style={styles.settingsGroup}>
          <View style={[styles.settingsRow, styles.settingsRowDivider]}>
            <Text style={styles.settingsRowLabel}>分析</Text>
            <Text style={[styles.settingsRowValue, { flex: 1 }]}>{STATUS_LABELS[status.status] || status.status}</Text>
          </View>
          <View style={styles.settingsRow}>
            <Text style={styles.settingsRowDescription}>観測済み {status.observedThrough} · 分析済み {status.processedThrough} · 未処理 {status.pendingCount} 件</Text>
          </View>
        </View>
        {status.error ? <Text accessibilityRole="alert" style={styles.settingsErrorText}>{status.error.message}</Text> : null}
      </View>
      <View style={styles.settingsSection}>
        <Text style={styles.settingsSectionTitle}>本日の利用量・予算（UTC）</Text>
        {status.usage ? <><View style={[styles.settingsGroup, { paddingVertical: 12, gap: 6 }]}>
          <Text style={styles.settingsRowLabel}>{status.usage.budget.day}</Text>
          <Text style={styles.settingsRowDescription}>呼び出し {status.usage.budget.calls} / {status.usage.budget.maxCalls} 回</Text>
          <Text style={styles.settingsRowDescription}>予算消費 {status.usage.budget.tokens} / {status.usage.budget.maxTokens} tokens（予約・欠測分を含む）</Text>
          <Text testID="learning-input-tokens" style={styles.settingsRowDescription}>取得済み入力: {status.usage.today.inputTokens === null ? "未取得" : `${status.usage.today.inputTokens} tokens`}</Text>
          <Text style={styles.settingsRowDescription}>取得済み出力: {status.usage.today.outputTokens === null ? "未取得" : `${status.usage.today.outputTokens} tokens`}</Text>
          <Text style={styles.settingsRowDescription}>実測 {status.usage.today.measuredCalls} · 一部取得 {status.usage.today.partialCalls} · 欠測 {status.usage.today.missingCalls} 回</Text>
          {status.usage.today.anonymousCalls > 0 ? <Text style={styles.settingsRowDescription}>削除後の匿名集計: {status.usage.today.anonymousCalls} 回</Text> : null}
          {status.usage.today.estimatedCosts.length ? status.usage.today.estimatedCosts.map((cost) => (
            <Text key={cost.currency} style={styles.settingsRowDescription}>算定料金（算定できた分）: {cost.amount} {cost.currency}</Text>
          )) : <Text style={styles.settingsRowDescription}>{status.usage.priceSnapshot
            ? "料金算定不能（算定に必要な利用量が未取得）" : "料金算定不能（単価未設定）"}</Text>}
          {status.usage.today.unpricedCalls > 0 ? <Text style={styles.settingsRowDescription}>料金を算定できない呼び出し: {status.usage.today.unpricedCalls} 回</Text> : null}
          {status.usage.blockedReason ? <Text accessibilityRole="alert" style={styles.settingsErrorText}>利用量記録による保留: {status.usage.blockedReason}</Text> : null}
        </View>
        <Text style={styles.settingsFooterText}>失敗・再試行も利用量に含みます。取得済みトークンと算定料金は、取得できた分の合計です。</Text>
        {!status.outputLimitEnforced ? <Text style={styles.settingsFooterText}>トークン数の上限は目安です。呼び出し回数にも上限を設けています。</Text> : null}
        </> : <Text style={styles.settingsFooterText}>利用量を取得できません。</Text>}
      </View>
      <View style={styles.settingsSection}>
        <Text style={styles.settingsSectionTitle}>学習候補 · {status.candidates.length} 件</Text>
        {status.candidates.length ? <View style={styles.settingsGroup}>{status.candidates.map((item) => (
          <View key={item.id} style={[styles.settingsRow, styles.settingsRowDivider, { flexDirection: "column", alignItems: "stretch" }]}>
            <Text style={styles.settingsRowLabel}>{item.content}</Text>
            <Text style={styles.settingsRowDescription}>{KIND_LABELS[item.kind] || item.kind} · {orchestrators.find((entry) => entry.id === item.scope.orchestratorId)?.name || item.scope.orchestratorId} の候補</Text>
            <Text style={styles.settingsRowDescription}>適用条件: {item.conditions}</Text>
            <Text style={styles.settingsRowDescription}>作成理由: {item.reason}</Text>
            <Text style={styles.settingsRowDescription}>根拠: {item.evidence.map((source) => `#${source.pairSeq}`).join("、")}</Text>
          </View>
        ))}</View> : <Text style={styles.settingsFooterText}>候補はまだありません。</Text>}
      </View>
      <View style={styles.settingsSection}>
        <Text style={styles.settingsSectionTitle}>学習入力の欠損・除外</Text>
        {status.gaps.length ? <View style={[styles.settingsGroup, { paddingVertical: 12 }]}>{status.gaps.map((item, index) => (
          <Text key={index} style={styles.settingsRowDescription}>#{item.from}〜{item.through}: {item.reason}</Text>
        ))}</View> : <Text style={styles.settingsFooterText}>記録された欠損・除外はありません。</Text>}
      </View>
    </> : null}
  </>;
}
