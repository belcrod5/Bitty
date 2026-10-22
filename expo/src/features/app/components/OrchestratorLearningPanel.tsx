import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useAppStyles } from "../styles";
import { isReasoningEffort, type ReasoningEffort } from "../utils/settingsParsers";
import { SettingsSelect } from "./SettingsSelect";
import type { VoiceOrchestrator } from "./VoiceOrchestratorIcon";

type Model = { modelId: string; label: string; effortOptions: ReasoningEffort[] };
type Candidate = {
  id: string; version: number; status: string; updatedAt?: string; kind: string; content: string; conditions: string; reason: string;
  scope: { orchestratorId: string; shared?: boolean }; matchTerms?: string[]; targetConstraints?: string[]; skill?: Record<string, string>; published?: { version: number; hash: string }; evidence: { pairSeq: number }[];
};
type LearningStatus = {
  settings: { model: string; effort: string; settingsRevision: number };
  status: string; enabled: boolean; observedThrough: number; processedThrough: number;
  pendingCount: number; candidates: Candidate[];
  gaps: { from: number; through: number; reason: string }[];
  error: { code: string; message: string } | null;
  outputLimitEnforced: boolean;
  retry?: { batchId: string; settingsRevision: number; attempts: number; ceiling: number } | null;
  evaluations?: { id: string; version: number; goal: string; score: number | null; reason: string; unknowns: string;
    at: string; period: { from: string | null; until: string | null }; scope: { orchestratorId: string };
    corrections: { id: string; score: number | null; reason: string; at: string; resolution?: { reason: string; itemId: string | null } }[] }[];
  changes?: { id: string; at: string; action: string; actor: string; reason: string;
    before: Candidate | null; after: Candidate | null }[];
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
  const [selected, setSelected] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");
  const [scores, setScores] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
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

  const manage = async (op: string, payload: Record<string, unknown>) => {
    if (busy) return;
    const id = ++requestId.current; setBusy(true); setError("");
    try {
      const value = readStatus(await request(`voice.learning.${op}`, payload));
      if (id === requestId.current) { setStatus(value); setSelected([]); setInstruction(""); }
    } catch (cause) { if (id === requestId.current) setError(cause instanceof Error ? cause.message : "変更を保存できません。"); }
    finally { if (id === requestId.current) setBusy(false); }
  };
  const references = (status?.candidates || []).filter((item) => selected.includes(item.id)).map(({ id, version }) => ({ id, version }));
  const button = (label: string, op: string, payload: Record<string, unknown>, disabled = false) => (
    <TouchableOpacity key={label} accessibilityRole="button" accessibilityLabel={label} disabled={busy || disabled}
      onPress={() => void manage(op, payload)} style={[styles.settingsBackButton, { opacity: busy || disabled ? 0.5 : 1 }]}>
      <Text style={styles.settingsActionText}>{label}</Text>
    </TouchableOpacity>);
  const skillText = (skill?: Record<string, string>) => skill ? Object.entries({ purpose: "目的", triggers: "発動条件", inputs: "入力",
    steps: "手順", outputs: "出力", exceptions: "例外", approvals: "必要な承認" }).map(([key, label]) => `${label}: ${skill[key] || "未設定"}`).join("\n") : "なし";
  const itemStatus: Record<string, string> = { candidate: "候補", active: "有効", retired: "廃止", rejected: "却下" };
  return <>
    <Text style={styles.settingsFooterText}>学習・評価用モデルは全オーケストレータ共通</Text>
    <Text style={styles.settingsFooterText}>採用した方針を次の応答から、進行中の作業に影響しない時点で反映します。現在の依頼・手動設定・承認規則が優先されます。スキルは専用領域に保存し、自動公開しません。メッセージクリアでは学習を忘却しません。「忘却」は選択した学習と編集・統合で関連する保存版も削除します。</Text>
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
        {status.status === "retry_exhausted" && status.retry ? <>
          <Text style={styles.settingsFooterText}>元入力の試行回数と当日予算を維持し、現在のモデル設定で1回だけ再試行します。</Text>
          {button("保留した分析を1回再試行", "retry", { batchId: status.retry.batchId, settingsRevision: status.retry.settingsRevision }, !status.settings.model)}
        </> : null}
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
        <Text style={styles.settingsSectionTitle}>学習・専用スキル · {status.candidates.length} 件</Text>
        <Text style={styles.settingsFooterText}>選択した候補をまとめて採用・却下できます。共有化は全チャットへの明示採用です。公開や提案の採用で外部操作が許可されることはありません。</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {button("選択候補を採用", "decide", { items: references, action: "adopt" }, !references.length)}
          {button("選択候補を却下", "decide", { items: references, action: "reject" }, !references.length)}
        </View>
        <TextInput accessibilityLabel="学習の編集・統合・廃止の希望" placeholder="選択した学習の編集・統合・廃止の希望"
          value={instruction} onChangeText={setInstruction} multiline maxLength={1000} style={styles.settingsRowDescription} />
        {button("選択学習の修正案を依頼", "change", { items: references, instruction }, !references.length || !instruction.trim())}
        {status.candidates.length ? <View style={styles.settingsGroup}>{status.candidates.map((item) => (
          <View key={item.id} style={[styles.settingsRow, styles.settingsRowDivider, { flexDirection: "column", alignItems: "stretch" }]}>
            <TouchableOpacity accessibilityRole="checkbox" accessibilityState={{ checked: selected.includes(item.id) }}
              accessibilityLabel={`学習を選択: ${item.content}`} disabled={busy}
              onPress={() => setSelected((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}>
              <Text style={styles.settingsRowDescription}>{selected.includes(item.id) ? "☑" : "□"}</Text><Text style={styles.settingsRowLabel}>{item.content}</Text>
            </TouchableOpacity>
            <Text style={styles.settingsRowDescription}>{KIND_LABELS[item.kind] || item.kind} · {orchestrators.find((entry) => entry.id === item.scope.orchestratorId)?.name || item.scope.orchestratorId} · {item.scope.shared ? "全チャット共通" : "このチャット限定"} · {itemStatus[item.status] || item.status || "候補"} · v{item.version || 1}</Text>
            <Text style={styles.settingsRowDescription}>適用条件: {item.conditions}</Text>
            {item.matchTerms?.length ? <Text style={styles.settingsRowDescription}>発動語: {item.matchTerms.join("、")}</Text> : null}
            {item.targetConstraints?.length ? <Text style={styles.settingsRowDescription}>ツールで確認が必要な対象: {item.targetConstraints.join("、")}</Text> : null}
            <Text style={styles.settingsRowDescription}>作成理由: {item.reason}</Text>
            <Text style={styles.settingsRowDescription}>根拠: {item.evidence.map((source) => `#${source.pairSeq}`).join("、")}</Text>
            {item.updatedAt ? <Text style={styles.settingsRowDescription}>更新: {item.updatedAt}</Text> : null}
            {item.skill ? <Text style={styles.settingsRowDescription}>専用スキル案{`\n${skillText(item.skill)}`}</Text> : null}
            {item.published ? <Text style={styles.settingsRowDescription}>公開版 v{item.published.version} · {item.published.hash.slice(0, 12)}</Text> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {item.status === "active" ? <>
                {button(`廃止: ${item.content}`, "decide", { items: [{ id: item.id, version: item.version }], action: "retire" })}
                {!item.scope.shared ? button(`全チャットへ採用: ${item.content}`, "decide", { items: [{ id: item.id, version: item.version }], action: "share" }) : null}
                {item.skill && !item.published ? button(`専用スキルを公開: ${item.content}`, "decide", { items: [{ id: item.id, version: item.version }], action: "publish" }) : null}
              </> : null}
              {item.status === "retired" ? button(`直前の方針を復元: ${item.content}`, "decide", { items: [{ id: item.id, version: item.version }], action: "restore" }) : null}
              {button(`学習と保存版を忘却: ${item.content}`, "forget", { items: [{ id: item.id, version: item.version }] })}
            </View>
          </View>
        ))}</View> : <Text style={styles.settingsFooterText}>候補はまだありません。</Text>}
      </View>
      <View style={styles.settingsSection}>
        <Text style={styles.settingsSectionTitle}>AIによる暫定評価</Text>
        <Text style={styles.settingsFooterText}>観測できた希望への適合度です。無反応は満足を意味しません。点数は全人格の満足度や客観的品質の保証ではありません。</Text>
        {(status.evaluations || []).map((evaluation) => <View key={evaluation.id} style={[styles.settingsGroup, { padding: 12, gap: 6 }]}>
          <Text style={styles.settingsRowLabel}>{evaluation.goal} · {evaluation.score === null ? "未評価" : `${evaluation.score} / 100`}</Text>
          <Text style={styles.settingsRowDescription}>{evaluation.period.from || evaluation.at} 〜 {evaluation.period.until || evaluation.at}</Text>
          <Text style={styles.settingsRowDescription}>{evaluation.reason} · 未確認: {evaluation.unknowns || "なし"}</Text>
          {evaluation.corrections.map((correction) => <Text key={correction.id} style={styles.settingsRowDescription}>
            ユーザー訂正: {correction.score === null ? "未評価" : `${correction.score} / 100`} {correction.reason}
            {correction.resolution ? ` · 反映: ${correction.resolution.reason}` : " · 次回分析待ち"}</Text>)}
          <TextInput accessibilityLabel={`訂正点数: ${evaluation.goal}`} value={scores[evaluation.id] ?? ""}
            placeholder="0〜100（空欄は未評価）" keyboardType="numeric" maxLength={3}
            onChangeText={(value) => setScores((current) => ({ ...current, [evaluation.id]: value }))} style={styles.settingsRowDescription} />
          <TextInput accessibilityLabel={`訂正理由: ${evaluation.goal}`} value={reasons[evaluation.id] ?? ""} placeholder="理由（任意）"
            onChangeText={(value) => setReasons((current) => ({ ...current, [evaluation.id]: value }))} maxLength={1000} style={styles.settingsRowDescription} />
          {button(`評価を訂正: ${evaluation.goal}`, "correct", { evaluationId: evaluation.id, version: evaluation.version,
            score: scores[evaluation.id]?.trim() ? Number(scores[evaluation.id]) : null, reason: reasons[evaluation.id] || "" },
          Boolean(scores[evaluation.id]?.trim()) && (!/^\d{1,3}$/.test(scores[evaluation.id]) || Number(scores[evaluation.id]) > 100))}
        </View>)}
      </View>
      <View style={styles.settingsSection}>
        <Text style={styles.settingsSectionTitle}>一括提案の記録</Text>
        {(status.proposals || []).map((proposal) => <View key={proposal.id} style={[styles.settingsGroup, { padding: 12 }]}>
          <Text style={styles.settingsRowLabel}>{proposal.operation} · {proposal.count} 件 · {proposal.status}</Text>
          <Text style={styles.settingsRowDescription}>対象: {proposal.targets.join("、")} · 除外: {proposal.exclusions} · 順序: {proposal.order} · 失敗時: {proposal.onFailure}</Text>
          {(proposal.feedback || []).map((feedback, index) => <Text key={index} style={styles.settingsRowDescription}>会話の根拠 #{feedback.pairSeq}: {feedback.userQuote} · {feedback.action}</Text>)}
          {proposal.outcome ? <Text style={styles.settingsRowDescription}>ユーザーが確認した結果: {proposal.outcome.status}</Text> : null}
          {proposal.status === "offered" ? <View style={{ flexDirection: "row" }}>
            {button(`提案を採用（実行許可は別）: ${proposal.operation}`, "proposal", { id: proposal.id, decision: "accepted" })}
            {button(`提案を断る: ${proposal.operation}`, "proposal", { id: proposal.id, decision: "declined" })}
          </View> : null}
        </View>)}
      </View>
      <View style={styles.settingsSection}>
        <Text style={styles.settingsSectionTitle}>確定した変更履歴</Text>
        <Text style={styles.settingsFooterText}>保持範囲は各100件・90日です。整理済みの履歴は表示できません。</Text>
        {(status.requests || []).map((entry) => <Text key={entry.id} style={styles.settingsRowDescription}>修正依頼: {entry.instruction} · {entry.resolution?.reason || "分析待ち"}</Text>)}
        {(status.changes || []).slice().reverse().map((entry) => <View key={entry.id} style={[styles.settingsGroup, { padding: 12 }]}>
          <Text style={styles.settingsRowLabel}>{entry.actor === "ai" ? "裏側AI" : "ユーザー"} · {entry.action} · {entry.at}</Text>
          <Text style={styles.settingsRowDescription}>理由: {entry.reason || "指定なし"}</Text>
          <Text style={styles.settingsRowDescription}>前: {entry.before ? `${entry.before.status} v${entry.before.version} ${entry.before.content} ${skillText(entry.before.skill)}` : "なし"}</Text>
          <Text style={styles.settingsRowDescription}>後: {entry.after ? `${entry.after.status} v${entry.after.version} ${entry.after.content} ${skillText(entry.after.skill)}` : "なし"}</Text>
        </View>)}
      </View>
      <View style={styles.settingsSection}>
        <Text style={styles.settingsSectionTitle}>学習の忘却</Text>
        <Text style={styles.settingsFooterText}>全学習・専用スキルと保存版・評価・訂正・変更/参照履歴を削除します。会話原本と既存メモリーは別です。利用量・料金の台帳と当日予算は保持します。</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="全学習を忘却" disabled={busy}
          onPress={() => Alert.alert("全学習を忘却", "全学習、専用スキルと保存版、評価と履歴を削除します。会話原本・既存メモリー・利用量台帳は保持します。", [
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
    </> : null}
  </>;
}
