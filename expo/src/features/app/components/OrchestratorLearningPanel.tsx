import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useAppStyles } from "../styles";
import { isReasoningEffort, type ReasoningEffort } from "../utils/settingsParsers";
import { type LearningEvaluation } from "./LearningEvaluationCard";
import { currentLearningUpdateSources, LearningKnowledgeCard, type LearningKnowledge } from "./LearningKnowledgeCard";
import { LearningEvaluationOverview } from "./LearningEvaluationOverview";
import { LearningUsageOverview } from "./LearningUsageOverview";
import { LearningChangeHistory } from "./LearningChangeHistory";
import { LearningDisclosure, LearningPager } from "./LearningTimeline";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { SettingsSelect } from "./SettingsSelect";
import type { VoiceOrchestrator } from "./VoiceOrchestratorIcon";

type Model = { modelId: string; label: string; effortOptions: ReasoningEffort[] };
type LearningStatus = {
  settings: { model: string; effort: string; settingsRevision: number };
  status: string; enabled: boolean; observedThrough: number; processedThrough: number;
  pendingCount: number; unreadCount?: number; candidates: LearningKnowledge[];
  gaps: { from: number; through: number; reason: string }[];
  error: { code: string; message: string } | null;
  outputLimitEnforced: boolean;
  retry?: { batchId: string; settingsRevision: number; attempts: number; ceiling: number } | null;
  evaluations?: LearningEvaluation[];
  changes?: { id: string; at: string; action: string; actor: string; reason: string;
    before: LearningKnowledge | null; after: LearningKnowledge | null }[];
  requests?: { id: string; instruction: string; resolution?: { reason: string } }[];
  proposals?: { id: string; status: string; targets: string[]; count: number; operation: string; exclusions: string; order: string; onFailure: string;
    feedback?: { action: string; pairSeq: number; userQuote: string }[]; outcome?: { status: string } }[];
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
  unconfigured: "新しい学習を停止中", observing: "会話を学習中", analyzing: "会話を分析中",
  paused: "保留中", retry_exhausted: "再試行の上限に達したため保留中",
};

function readStatus(value: Record<string, unknown>, orchestratorId: string): LearningStatus {
  if (!value.settings || typeof value.settings !== "object" || typeof value.status !== "string"
    || !Array.isArray(value.candidates) || !Array.isArray(value.gaps)
    || (value.usage !== null && (!value.usage || typeof value.usage !== "object"))) throw new Error("学習状態を読み込めません。");
  const state = value as unknown as LearningStatus;
  if (typeof state.settings.model !== "string" || typeof state.settings.effort !== "string"
    || !Number.isSafeInteger(state.settings.settingsRevision)
    || (state.usage !== null && (!state.usage.budget || !state.usage.today || !Array.isArray(state.usage.today.estimatedCosts)))
    || state.candidates.some((item) => !item || typeof item.content !== "string"
      || typeof item.conditions !== "string" || typeof item.reason !== "string"
      || !item.scope || item.scope.orchestratorId !== orchestratorId || !Array.isArray(item.evidence))
    || state.gaps.some((item) => !item || typeof item.reason !== "string")
    || (state.error !== null && (!state.error || typeof state.error.message !== "string"))) {
    throw new Error("学習状態を読み込めません。");
  }
  return state;
}

export function OrchestratorLearningPanel({ request: sendRequest, orchestrator }: {
  request: Request; orchestrator: VoiceOrchestrator;
}) {
  const request = useCallback<Request>(async (op, payload) => {
    const result = await sendRequest(op, { ...payload, orchestratorId: orchestrator.id });
    if (op.startsWith("voice.learning.") && typeof result.orchestratorId !== "string") {
      throw new Error("オーケストレータ別の応答を確認できません。Runnerを更新してください。");
    }
    if (result.orchestratorId !== undefined && result.orchestratorId !== orchestrator.id) {
      throw new Error("別のオーケストレータの応答を受信しました。");
    }
    return result;
  }, [sendRequest, orchestrator.id]);
  const styles = useAppStyles();
  const { theme: { colors, tones } } = useVisualTheme();
  const [knowledgeFilter, setKnowledgeFilter] = useState("all");
  const [knowledgePage, setKnowledgePage] = useState(0);
  const [usageRefresh, setUsageRefresh] = useState(0);
  const [status, setStatus] = useState<LearningStatus | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [saved, setSaved] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [requestingChange, setRequestingChange] = useState(false);
  const managing = useRef(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setBusy(true); setError(""); setCatalogError(""); setSaved(false);
    try {
      const [state, catalog] = await Promise.allSettled([
        request("voice.learning.status"), request("voice.settings"),
      ]);
      if (id !== requestId.current) return;
      if (state.status === "rejected") throw state.reason;
      const value = readStatus(state.value, orchestrator.id);
      setUsageRefresh((current) => current + 1);
      setStatus(value); setSelected([]); setInstruction(""); setSelecting(false); setRequestingChange(false);
      setModel(value.settings.model || ""); setEffort(value.settings.effort || "");
      if (value.unreadCount !== undefined && value.unreadCount > 0) {
        void request("voice.learning.read", { items: value.candidates.filter((item) => item.status === "candidate")
          .map(({ id, version }) => ({ id, version })) }).catch(() => undefined);
      }
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
  }, [request, orchestrator.id]);

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
      }), orchestrator.id);
      if (id !== requestId.current) return;
      setStatus(value); setModel(value.settings.model); setEffort(value.settings.effort); setSaved(true);
    } catch (cause) {
      if (id === requestId.current) setError(cause instanceof Error ? cause.message : "設定を保存できません。");
    } finally { if (id === requestId.current) setBusy(false); }
  };

  const manage = async (op: string, payload: Record<string, unknown>, reportError = true): Promise<string | null> => {
    if (busy || managing.current) return "処理中です。少し待ってからお試しください。";
    managing.current = true;
    const id = ++requestId.current; setBusy(true); setError("");
    try {
      const value = readStatus(await request(`voice.learning.${op}`, payload), orchestrator.id);
      if (id !== requestId.current) return "画面が更新されました。状態を確認してください。";
      setUsageRefresh((current) => current + 1);
      setStatus(value); setSelected([]); setInstruction(""); setSelecting(false); setRequestingChange(false);
      return null;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "変更を保存できません。";
      if (reportError && id === requestId.current) setError(message);
      return message;
    } finally { managing.current = false; if (id === requestId.current) setBusy(false); }
  };
  const selectedItems = (status?.candidates || []).filter((item) => selected.includes(item.id));
  const references = selectedItems.map(({ id, version }) => ({ id, version }));
  const canDecide = references.length > 0 && references.length <= 50 && selectedItems.every((item) => item.status === "candidate");
  const canChange = references.length > 0 && references.length <= 5;
  const button = (label: string, op: string, payload: Record<string, unknown>, disabled = false) => (
    <TouchableOpacity key={label} accessibilityRole="button" accessibilityLabel={label} disabled={busy || disabled}
      onPress={() => void manage(op, payload)} style={[styles.settingsBackButton, { opacity: busy || disabled ? 0.5 : 1 }]}>
      <Text style={styles.settingsActionText}>{label}</Text>
    </TouchableOpacity>);
  const filteredKnowledge = (status?.candidates || []).filter((item) => {
    if (knowledgeFilter === "all") return selecting || !currentLearningUpdateSources(item, status?.candidates || []).length;
    if (knowledgeFilter === "inactive") return item.status === "retired" || item.status === "rejected";
    return item.status === knowledgeFilter;
  });
  const knowledgeCurrentPage = Math.min(knowledgePage, Math.max(0, Math.ceil(filteredKnowledge.length / 5) - 1));
  return <View style={dashboard.page}>
    {error ? <Text accessibilityRole="alert" style={styles.settingsErrorText}>{error}</Text> : null}
    <View style={dashboard.top}>
      <View style={dashboard.topCopy}><Text style={[dashboard.eyebrow, { color: colors.textMuted }]}>会話から育つアシスタント</Text>
        <Text accessibilityRole="header" style={[dashboard.pageTitle, { color: colors.textPrimary }]}>{orchestrator.name}の学習</Text></View>
      <TouchableOpacity testID="learning-status-refresh" accessibilityRole="button" accessibilityLabel="学習状態を更新"
        disabled={busy} onPress={() => void load()} style={styles.settingsBackButton}>
        <Text style={styles.settingsActionText}>{busy ? "更新中…" : "更新"}</Text>
      </TouchableOpacity>
    </View>
    {status ? <>
      <View style={[dashboard.state, { backgroundColor: colors.surfaceMuted }]}>
        <View style={[dashboard.dot, { backgroundColor: status.enabled ? colors.accent : colors.textMuted }]} />
        <View style={dashboard.topCopy}><Text style={[dashboard.stateTitle, { color: colors.textPrimary }]}>{STATUS_LABELS[status.status] || "学習状態を確認してください"}</Text>
          <Text style={[dashboard.caption, { color: colors.textMuted }]}>{status.pendingCount}件の会話が分析待ち</Text></View>
      </View>
      {status.error ? <Text accessibilityRole="alert" style={styles.settingsErrorText}>{status.error.message}</Text> : null}
      {status.status === "retry_exhausted" && status.retry ? <>
        <Text style={styles.settingsFooterText}>当日の予算を維持し、現在のモデル設定でもう一度だけ試します。</Text>
        {button("保留した分析を1回再試行", "retry", { batchId: status.retry.batchId, settingsRevision: status.retry.settingsRevision }, !status.settings.model)}
      </> : null}
      <View style={[dashboard.section, { borderColor: colors.borderSubtle }]}><LearningEvaluationOverview evaluations={status.evaluations || []} busy={busy} manage={manage} /></View>
      <View style={[dashboard.section, { borderColor: colors.borderSubtle }]}>
        <Text accessibilityRole="header" style={[dashboard.sectionTitle, { color: colors.textPrimary }]}>学んだこと <Text style={[dashboard.count, { color: colors.textMuted }]}>{status.candidates.length}</Text></Text>
        <Text style={[dashboard.caption, { color: colors.textSecondary }]}>応答の好み {status.candidates.filter((item) => item.kind === "preference" && !item.skill).length} · 作業の手順 {status.candidates.filter((item) => item.kind === "procedure" && !item.skill).length} · 一括作業の方針 {status.candidates.filter((item) => item.kind === "batch_proposal" && !item.skill).length} · 専用スキル {status.candidates.filter((item) => Boolean(item.published)).length}</Text>
        {status.candidates.some((item) => item.skill && !item.published) ? <Text style={[dashboard.caption, { color: colors.textMuted }]}>専用スキル案 {status.candidates.filter((item) => item.skill && !item.published).length}件は保存前です。</Text> : null}
        <View style={dashboard.filters}>{[["all", "すべて"], ["candidate", "確認待ち"], ["active", "使用中"], ["inactive", "停止・見送り"]].map(([value, label]) =>
          <TouchableOpacity key={value} accessibilityRole="tab" accessibilityLabel={`学習: ${label}`} accessibilityState={{ selected: knowledgeFilter === value }}
            onPress={() => { setKnowledgeFilter(value); setKnowledgePage(0); }} style={[dashboard.filter, { backgroundColor: knowledgeFilter === value ? tones.info.background : colors.surfaceMuted }]}>
            <Text style={[dashboard.filterText, { color: knowledgeFilter === value ? tones.info.foreground : colors.textMuted }]}>{label}</Text>
          </TouchableOpacity>)}</View>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <Text style={styles.settingsFooterText}>学んだ内容を、使うかどうか選べます。</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={selecting ? "一括操作を終了" : "まとめて操作"}
            disabled={busy} onPress={() => { setSelecting((value) => !value); setKnowledgeFilter("all"); setKnowledgePage(0); setSelected([]); setInstruction(""); setRequestingChange(false); }}
            style={styles.settingsBackButton}>
            <Text style={styles.settingsActionText}>{selecting ? "選択を終了" : "まとめて操作"}</Text>
          </TouchableOpacity>
        </View>
        {selecting ? <View style={[styles.settingsGroup, { padding: 12, gap: 8 }]}>
          <Text style={styles.settingsRowLabel}>{references.length}件を選択</Text>
          <Text style={styles.settingsFooterText}>チェックは一括操作の対象選びです。使用状態は変わりません。</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {button("選んだ候補を採用", "decide", { items: references, action: "adopt" }, !canDecide)}
            {button("選んだ候補を見送る", "decide", { items: references, action: "reject" }, !canDecide)}
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="選んだ学習の修正案を依頼" disabled={busy || !canChange}
              onPress={() => setRequestingChange((value) => !value)} style={[styles.settingsBackButton, { opacity: busy || !canChange ? 0.5 : 1 }]}>
              <Text style={styles.settingsActionText}>修正案を依頼</Text>
            </TouchableOpacity>
          </View>
          {references.length > 0 && !canDecide ? <Text style={styles.settingsFooterText}>まとめて採用・見送りできるのは候補50件までです。</Text> : null}
          {references.length > 0 && !canChange ? <Text style={styles.settingsFooterText}>修正案は同じチャットの学習を5件まで選んで依頼できます。</Text> : null}
          {requestingChange ? <>
            <Text style={styles.settingsFooterText}>次回の分析で変更候補を作成します。採用するまで回答には反映しません。</Text>
            {!status.settings.model ? <Text style={styles.settingsFooterText}>作成には学習・評価用モデルの設定が必要です。</Text> : null}
            <TextInput accessibilityLabel="学習の編集・統合・廃止の希望" placeholder="変えたい内容や、まとめたい方針"
              value={instruction} onChangeText={setInstruction} editable={!busy} multiline maxLength={1000}
              style={[styles.settingsRowDescription, { minHeight: 72, padding: 12 }]} />
            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {button("修正案の作成を依頼", "change", { items: references, instruction }, !canChange || !instruction.trim())}
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="修正案の依頼をキャンセル" disabled={busy}
                onPress={() => { setRequestingChange(false); setInstruction(""); }} style={styles.settingsBackButton}>
                <Text style={styles.settingsActionText}>キャンセル</Text>
              </TouchableOpacity>
            </View>
          </> : null}
        </View> : null}
        {filteredKnowledge.length ? <View style={{ gap: 12 }}>{filteredKnowledge.slice(knowledgeCurrentPage * 5, knowledgeCurrentPage * 5 + 5).map((item) => (
          <LearningKnowledgeCard key={item.id} item={item} knowledge={status.candidates}
            chatName={orchestrator.name}
            selecting={selecting} selected={selected.includes(item.id)} busy={busy} manage={manage}
            onSelect={() => setSelected((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} />
        ))}</View> : <Text style={styles.settingsFooterText}>{status.candidates.length ? "この状態の学習はありません。" : "学習はまだありません。"}</Text>}
        <LearningPager page={knowledgeCurrentPage} total={filteredKnowledge.length} onPage={setKnowledgePage} label="学習" />
      </View>
      <View style={[dashboard.section, { borderColor: colors.borderSubtle }]}><LearningUsageOverview request={request} usage={status.usage} refreshKey={usageRefresh} outputLimitEnforced={status.outputLimitEnforced} /></View>
      <View style={[dashboard.section, { borderColor: colors.borderSubtle }]}><LearningChangeHistory changes={status.changes || []} requests={status.requests || []} /></View>
      <View style={styles.settingsSection}>
        <LearningDisclosure title={`まとめて行う作業の提案 · ${(status.proposals || []).length}件`}>
        {(status.proposals || []).map((proposal) => <View key={proposal.id} style={[styles.settingsGroup, { padding: 12 }]}>
          <Text style={styles.settingsRowLabel}>{proposal.operation} · {proposal.count} 件 · {{ offered: "確認待ち", accepted: "採用", declined: "見送り" }[proposal.status] || "記録済み"}</Text>
          <Text style={styles.settingsRowDescription}>対象: {proposal.targets.join("、")} · 除外: {proposal.exclusions} · 順序: {proposal.order} · 失敗時: {proposal.onFailure}</Text>
          {(proposal.feedback || []).map((feedback, index) => <Text key={index} style={styles.settingsRowDescription}>会話での反応：{feedback.userQuote} · {{ accepted: "採用", declined: "見送り", outcome_confirmed: "結果を確認", outcome_failed: "うまくいかなかった" }[feedback.action] || "記録済み"}</Text>)}
          {proposal.outcome ? <Text style={styles.settingsRowDescription}>ユーザーが確認した結果: {{ outcome_confirmed: "確認できた", outcome_failed: "うまくいかなかった" }[proposal.outcome.status] || "記録済み"}</Text> : null}
          {proposal.status === "offered" ? <View style={{ flexDirection: "row" }}>
            {button(`提案を採用（実行許可は別）: ${proposal.operation}`, "proposal", { id: proposal.id, decision: "accepted" })}
            {button(`提案を断る: ${proposal.operation}`, "proposal", { id: proposal.id, decision: "declined" })}
          </View> : null}
        </View>)}
        </LearningDisclosure>
      </View>
    </> : null}
    <View style={[dashboard.section, { borderColor: colors.borderSubtle }]}><LearningDisclosure title="学習の設定">
    <Text style={styles.settingsFooterText}>学習・評価用モデルと予算はこのオーケストレータ専用です。</Text>
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
      <Text style={styles.settingsFooterText}>未設定で新しい分析を停止します。採用済みの学習は引き続き回答で使います。</Text>
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
    </LearningDisclosure></View>
    {status ? <View style={[dashboard.section, { borderColor: colors.borderSubtle }]}><LearningDisclosure title="データの管理・診断">
      <View style={styles.settingsSection}>
        <Text style={styles.settingsSectionTitle}>学習の忘却</Text>
        <Text style={styles.settingsFooterText}>このオーケストレータの全学習・専用スキルと保存版・評価・訂正・変更/参照履歴を削除します。会話原本と既存メモリーは別です。利用量・料金の台帳と当日予算は保持します。</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="全学習を忘却" disabled={busy}
          onPress={() => Alert.alert("全学習を忘却", "このオーケストレータの全学習、専用スキルと保存版、評価と履歴を削除します。会話原本・既存メモリー・利用量台帳は保持します。", [
            { text: "キャンセル", style: "cancel" }, { text: "忘却", style: "destructive", onPress: () => void manage("forget", { all: true }) },
          ])} style={styles.settingsBackButton}>
          <Text style={styles.settingsActionText}>全学習を忘却</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.settingsSection}>
        <Text style={styles.settingsSectionTitle}>学習入力の欠損・除外</Text>
        {status.gaps.length ? <View style={[styles.settingsGroup, { paddingVertical: 12 }]}>{status.gaps.map((item, index) => (
          <Text key={index} style={styles.settingsRowDescription}>#{item.from}〜{item.through}: {item.reason}</Text>
        ))}</View> : <Text style={styles.settingsFooterText}>記録された欠損・除外はありません。</Text>}
      </View>
    </LearningDisclosure></View> : null}
  </View>;
}
const dashboard = StyleSheet.create({
  page: { gap: 22, paddingBottom: 24 }, top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16 }, topCopy: { flex: 1, gap: 5 },
  eyebrow: { fontSize: 11, fontWeight: "500" }, pageTitle: { fontSize: 25, fontWeight: "700" },
  state: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 14, padding: 15 }, dot: { width: 7, height: 7, borderRadius: 4 }, stateTitle: { fontSize: 13, fontWeight: "600" },
  caption: { fontSize: 11, lineHeight: 17 }, section: { gap: 12, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 22 }, sectionTitle: { fontSize: 19, fontWeight: "700" }, count: { fontSize: 16 },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 6 }, filter: { paddingHorizontal: 11, minHeight: 44, borderRadius: 9, justifyContent: "center" }, filterText: { fontSize: 12, fontWeight: "500" },
});
