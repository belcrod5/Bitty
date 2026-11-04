import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { humanLearningDate, knowledgeState, type LearningChange } from "./learningDashboardData";
import { LearningDetailsModal } from "./LearningDetailsModal";
import { LearningChangeHistory } from "./LearningChangeHistory";
import { LearningDisclosure } from "./LearningTimeline";

export type LearningKnowledge = {
  id: string; version: number; status: string; createdAt?: string; updatedAt?: string; kind: string; content: string; conditions: string; reason: string;
  action?: "create" | "retire"; replaces?: string[]; replacementVersions?: { id: string; version: number }[];
  scope: { orchestratorId: string; shared?: boolean }; matchTerms?: string[]; targetConstraints?: string[];
  skill?: Record<string, string>; published?: { version: number; hash: string }; evidence: { pairSeq: number }[];
};
const KIND_LABELS: Record<string, string> = {
  preference: "応答の好み", procedure: "作業の手順", batch_proposal: "まとめて行う作業",
};
const SKILL_LABELS = { purpose: "目的", triggers: "発動条件", inputs: "入力", steps: "手順", outputs: "出力", exceptions: "例外", approvals: "必要な承認" };
export const learningSkillText = (skill?: Record<string, string>) => skill ? Object.entries(SKILL_LABELS).map(([key, label]) => `${label}: ${skill[key] || "未設定"}`).join("\n") : "なし";
type Manage = (op: string, payload: Record<string, unknown>, reportError?: boolean) => Promise<string | null>;

// A source version can change without removing the proposal's relationship to it.
export function learningProposalSources(item: LearningKnowledge, knowledge: LearningKnowledge[]): LearningKnowledge[] {
  if (item.status !== "candidate" || !item.replaces?.length) return [];
  const sources = item.replaces.map((id) => knowledge.find((entry) => entry.id === id));
  return sources.every((source): source is LearningKnowledge => source?.status === "active" && source.scope.orchestratorId === item.scope.orchestratorId && source.scope.shared === item.scope.shared) ? sources : [];
}

export function canApplyLearningProposal(item: LearningKnowledge, knowledge: LearningKnowledge[]): boolean {
  if (item.status !== "candidate") return false;
  if (!item.replaces?.length) return item.action !== "retire";
  const sources = learningProposalSources(item, knowledge);
  return sources.length > 0 && sources.every((source) => item.replacementVersions?.some((entry) => entry.id === source.id && entry.version === source.version));
}

function LearningUpdateReview({ updates, initialProposal, historyMode, knowledge, changes, chatName, orchestratorId, busy, manage, onClose }: {
  updates: LearningKnowledge[]; initialProposal: LearningKnowledge; historyMode: boolean; knowledge: LearningKnowledge[]; changes: LearningChange[]; chatName: string; orchestratorId: string; busy: boolean; manage: Manage; onClose: () => void;
}) {
  const { theme: { colors, tones } } = useVisualTheme();
  const [selection, setSelection] = useState(() => ({ id: initialProposal.id, version: initialProposal.version, history: historyMode }));
  const [error, setError] = useState("");
  const currentPage = updates.findIndex((entry) => entry.id === selection.id && entry.version === selection.version);
  const proposal = updates[currentPage];
  const sources = proposal?.replaces?.map((id) => knowledge.find((entry) => entry.id === id)) || [];
  const ready = Boolean(proposal && canApplyLearningProposal(proposal, knowledge));
  const fields = proposal ? [
    { label: "内容", before: sources.map((source) => source?.content || "未確認"), after: proposal.content },
    { label: "適用条件", before: sources.map((source) => source?.conditions || "条件なし"), after: proposal.conditions || "条件なし" },
    { label: "種類", before: sources.map((source) => KIND_LABELS[source?.kind || ""] || "学習"), after: KIND_LABELS[proposal.kind] || "学習" },
    { label: "関連する言葉", before: sources.map((source) => source?.matchTerms?.map((term) => `「${term}」`).join("、") || "指定なし"), after: proposal.matchTerms?.map((term) => `「${term}」`).join("、") || "指定なし" },
    { label: "確認対象", before: sources.map((source) => source?.targetConstraints?.map((term) => `「${term}」`).join("、") || "指定なし"), after: proposal.targetConstraints?.map((term) => `「${term}」`).join("、") || "指定なし" },
    ...Object.entries(SKILL_LABELS).map(([key, label]) => ({ label, before: sources.map((source) => source?.skill?.[key] || "なし"), after: proposal.skill?.[key] || "なし" })),
  ] : [];
  const changedFields = fields.filter((field) => field.before.some((value) => value !== field.after));
  const preview = changedFields[0] || fields[0];
  const relatedIds = new Set(updates.flatMap((entry) => [entry.id, ...(entry.replaces || [])]));
  const history = changes.filter((entry) => [entry.before, entry.after].some((value) => value && value.scope.orchestratorId === orchestratorId && [value.id, ...(value.replaces || [])].some((id) => relatedIds.has(id))));
  const alternatives = updates.filter((entry) => entry.action !== "retire" && canApplyLearningProposal(entry, knowledge) && entry.id !== proposal?.id);
  const past = updates.filter((entry) => !canApplyLearningProposal(entry, knowledge) && (!selection.history || entry.id !== proposal?.id));
  const choose = async (action: "adopt" | "reject") => {
    if (!proposal || busy || action === "adopt" && (!ready || selection.history)) return;
    setError("");
    const failure = await manage("decide", { items: [{ id: proposal.id, version: proposal.version }], action }, false);
    if (failure) setError(failure);
    else onClose();
  };
  return <LearningDetailsModal visible title="学習の更新" subtitle={proposal ? humanLearningDate(proposal.createdAt || "") : ""}
    page={Math.max(0, currentPage)} testID="learning-update-modal" onClose={onClose}>
    {proposal && (ready || selection.history) ? <>
      <Text style={[styles.comparisonLabel, { color: selection.history ? colors.textMuted : colors.accent }]}>{selection.history ? "履歴" : changedFields.length ? `変更点 · ${preview.label}${changedFields.length > 1 ? ` ほか${changedFields.length - 1}項目` : ""}` : "内容の変更なし"}</Text>
      <View style={[styles.comparisonPanel, { backgroundColor: colors.surfaceMuted, borderColor: colors.borderSubtle }]}>
        {preview.before.map((value, index) => <Text key={index} numberOfLines={3} style={[styles.title, { color: colors.textSecondary }]}>{value}</Text>)}
        <View style={styles.comparisonArrow}><Ionicons name="arrow-down" size={20} color={colors.accent} accessibilityLabel="変更後" /></View>
        <Text numberOfLines={3} style={[styles.title, { color: colors.textPrimary }]}>{proposal.action === "retire" ? "使用を停止" : preview.after}</Text>
      </View>
      {ready && !selection.history ? <Pressable accessibilityRole="button" accessibilityLabel={`この案に更新: ${proposal.content}`} disabled={busy}
        onPress={() => void choose("adopt")} style={[styles.primaryAction, { backgroundColor: colors.primaryAction, opacity: busy ? 0.4 : 1 }]}>
        <Ionicons name="checkmark" size={19} color={colors.textOnAccent} /><Text style={[styles.actionText, { color: colors.textOnAccent }]}>適用する</Text></Pressable> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={`この案を見送る: ${proposal.content}`} disabled={busy}
        onPress={() => void choose("reject")} style={styles.secondaryAction}><Text style={[styles.actionText, { color: colors.textSecondary }]}>見送る</Text></Pressable>
      {error ? <Text accessibilityRole="alert" style={[styles.caption, { color: tones.danger.foreground }]}>{error}</Text> : null}
      <LearningDisclosure title="詳細">
        {!ready ? <Text style={[styles.caption, { color: colors.textMuted }]}>現在の内容には適用できない提案です。</Text> : null}
        <Text style={[styles.caption, { color: colors.textMuted }]}>使う範囲：{proposal.scope.shared ? "全チャット" : proposal.scope.orchestratorId === orchestratorId ? `${chatName}限定` : "別のチャット限定"}</Text>
        {sources.map((source, index) => <Text key={proposal.replaces![index]} style={[styles.caption, { color: colors.textMuted }]}>
          {source ? `${knowledgeState(source.status)}：第${source.version}版 · 更新：${humanLearningDate(source.updatedAt || source.createdAt || "")} · ${source.scope.shared ? "全チャット" : source.scope.orchestratorId === orchestratorId ? `${chatName}限定` : "別のチャット限定"}` : "現在の内容：未確認"} · 提案の対象：{proposal.replacementVersions?.find((entry) => entry.id === proposal.replaces![index])?.version || "版不明"}
        </Text>)}
        {fields.filter((field) => proposal.skill || sources.some((source) => source?.skill) || !Object.values(SKILL_LABELS).includes(field.label)).map((field) => <View key={field.label} style={styles.original}>
          <Text style={[styles.comparisonLabel, { color: colors.textMuted }]}>{field.label}</Text>
          {field.before.some((value) => value !== field.after) ? <Text style={[styles.caption, { color: colors.textSecondary }]}>{`${field.before.join("\n＋\n")}\n↓\n${field.after}`}</Text>
            : <Text style={[styles.caption, { color: colors.textSecondary }]}>{field.after}</Text>}
        </View>)}
        <Text style={[styles.caption, { color: colors.textMuted }]}>理由：{proposal.reason || "指定なし"}</Text>
      </LearningDisclosure>
    </> : <Text style={[styles.caption, { color: colors.textMuted }]}>{proposal ? "この提案は現在の内容に適用できません。" : "この提案は更新されました。閉じて確認してください。"}</Text>}
    {alternatives.length ? <LearningDisclosure title={`ほかの提案 · ${alternatives.length}件`}>
      {alternatives.map((entry) => <Pressable key={entry.id} accessibilityRole="button" accessibilityLabel={`提案を見る: ${entry.content}`} disabled={busy}
        onPress={() => { setSelection({ id: entry.id, version: entry.version, history: false }); setError(""); }} style={[styles.historyEntry, { borderColor: colors.borderSubtle }]}>
        <Text style={[styles.caption, { color: colors.textMuted }]}>{humanLearningDate(entry.createdAt || "")}</Text>
        <Text numberOfLines={2} style={[styles.title, { color: colors.textPrimary }]}>{entry.content}</Text>
      </Pressable>)}
    </LearningDisclosure> : null}
    {past.length || history.length ? <LearningDisclosure title="履歴" initialOpen={historyMode}>
      {past.map((entry) => <Pressable key={entry.id} accessibilityRole="button" accessibilityLabel={`過去の提案を見る: ${entry.content}`} disabled={busy}
        onPress={() => { setSelection({ id: entry.id, version: entry.version, history: true }); setError(""); }} style={[styles.historyEntry, { borderColor: colors.borderSubtle }]}>
        <Text style={[styles.caption, { color: colors.textMuted }]}>{humanLearningDate(entry.createdAt || "")}</Text>
        <Text numberOfLines={2} style={[styles.title, { color: colors.textSecondary }]}>{entry.content}</Text>
      </Pressable>)}
      {history.length ? <LearningChangeHistory changes={history} requests={[]} /> : null}
    </LearningDisclosure> : null}
  </LearningDetailsModal>;
}

export function LearningKnowledgeCard({ item, knowledge, changes = [], chatName, selecting, selected, busy, onSelect, manage }: {
  item: LearningKnowledge; knowledge: LearningKnowledge[]; changes?: LearningChange[]; chatName: string; selecting: boolean; selected: boolean; busy: boolean;
  onSelect: () => void; manage: Manage;
}) {
  const { theme: { colors, tones } } = useVisualTheme();
  const [expanded, setExpanded] = useState(false);
  const [reviewing, setReviewing] = useState<"proposal" | "history" | null>(null);
  const references = { items: [{ id: item.id, version: item.version }] };
  const isUpdate = item.status === "candidate" && item.action !== "retire" && Boolean(item.replaces?.length);
  const applicable = canApplyLearningProposal(item, knowledge);
  const relatedSources = item.status === "active" ? [item] : learningProposalSources(item, knowledge);
  const updates = knowledge.filter((entry) => (entry.action !== "retire" || !canApplyLearningProposal(entry, knowledge)) && learningProposalSources(entry, knowledge).some((source) => relatedSources.some((current) => current.id === source.id)))
    .sort((a, b) => (Date.parse(b.createdAt || "") || 0) - (Date.parse(a.createdAt || "") || 0));
  const currentUpdates = updates.filter((entry) => canApplyLearningProposal(entry, knowledge));
  const pastUpdates = updates.filter((entry) => !canApplyLearningProposal(entry, knowledge));
  const adoptLabel = item.action === "retire" ? "停止案を適用" : "更新内容を見る";
  const switchable = item.action !== "retire" && (item.status === "active" || item.status === "retired" || item.status === "candidate" && !item.replaces?.length);
  const restore = () => Alert.alert("この方針を再開", "置き換え先の方針が使用中なら停止し、この方針を再開します。", [
    { text: "キャンセル", style: "cancel" }, { text: "再開する", onPress: () => { void manage("decide", { ...references, action: "restore" }); } },
  ]);
  const tone = item.status === "active" ? tones.info : null;
  const action = (label: string, operation: string, payload: Record<string, unknown>, confirmDelete = false) => {
    const disabled = busy;
    return <Pressable key={label} accessibilityRole="button" accessibilityLabel={`${label}: ${item.content}`} disabled={disabled}
      onPress={() => {
        if (confirmDelete) Alert.alert(
          "この学習を削除",
          "この学習と、編集・統合で関連する保存版を削除します。元の会話は残ります。", [
          { text: "キャンセル", style: "cancel" },
          { text: "削除する", style: "destructive", onPress: () => { void manage(operation, payload); } },
        ]);
        else if (operation === "decide" && payload.action === "adopt" && !applicable) return;
        else if (isUpdate && operation === "decide" && payload.action === "adopt") setReviewing("proposal");
        else void manage(operation, payload);
      }} style={({ pressed }) => [styles.action, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
      <Text style={[styles.actionText, { color: confirmDelete ? tones.danger.foreground : colors.accent }]}>{label}</Text>
    </Pressable>;
  };
  return <><View accessibilityElementsHidden={Boolean(reviewing)} importantForAccessibility={reviewing ? "no-hide-descendants" : "auto"} style={[styles.card, { backgroundColor: colors.surface, borderColor: selected ? colors.accent : colors.borderSubtle }]}>
    <View style={styles.heading}>
      {selecting ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }}
        accessibilityLabel={`一括操作の対象に選択: ${item.content}`} disabled={busy} onPress={onSelect} style={styles.checkbox}>
        <Ionicons name={selected ? "checkbox" : "square-outline"} size={22} color={selected ? colors.accent : colors.textMuted} />
      </Pressable> : null}
      <View style={styles.content}>
        <View style={styles.metadata}>
          <Text style={[styles.status, { color: tone?.foreground || colors.textSecondary,
            backgroundColor: tone?.background || colors.surfaceMuted }]}>{item.status === "candidate" && !applicable ? "過去の提案" : isUpdate ? "更新案" : knowledgeState(item.status)}</Text>
          {item.skill ? <Ionicons name="library-outline" size={13} color={colors.textMuted} accessibilityLabel="専用スキル" /> : null}
        </View>
        <Text numberOfLines={3} style={[styles.title, { color: colors.textPrimary }]}>{item.content}</Text>
        {item.status === "active" || item.status === "candidate" ? <Text style={[styles.caption, { color: colors.textMuted }]}>{item.status === "active" ? `更新：${humanLearningDate(item.updatedAt || item.createdAt || "")}` : `提案：${humanLearningDate(item.createdAt || "")}`}</Text> : null}
      </View>
    </View>
    <View style={styles.actions}>
      {!selecting && switchable ? <View style={styles.switchRow}>
        <Text style={[styles.actionText, { color: colors.textPrimary }]}>回答で使う</Text>
        <Switch accessibilityLabel={`関連する回答で使う: ${item.content}`} value={item.status === "active"} disabled={busy}
          trackColor={{ false: colors.border, true: colors.accent }} onValueChange={() => {
            if (item.status === "retired") restore();
            else void manage("decide", { ...references, action: item.status === "active" ? "retire" : "adopt" });
          }} />
      </View> : null}
      {!selecting && item.status === "candidate" && !switchable ? applicable ? action(adoptLabel, "decide", { ...references, action: "adopt" })
        : <Pressable accessibilityRole="button" accessibilityLabel={`過去の提案を見る: ${item.content}`} disabled={busy} onPress={() => setReviewing("history")} style={styles.action}>
          <Ionicons name="time-outline" size={18} color={colors.textMuted} /><Text style={[styles.actionText, { color: colors.textSecondary }]}>履歴を見る</Text>
        </Pressable> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={`詳細・管理: ${item.content}`} accessibilityState={{ expanded }}
        disabled={busy} onPress={() => setExpanded((value) => !value)} style={styles.action}>
        <Text style={[styles.actionText, { color: colors.textSecondary }]}>{expanded ? "閉じる" : "詳細・管理"}</Text>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={13} color={colors.textMuted} />
      </Pressable>
    </View>
    {!selecting && item.status === "active" && currentUpdates.length ? <Pressable accessibilityRole="button" accessibilityLabel={`更新案${currentUpdates.length}件を見る: ${item.content}`}
      disabled={busy} onPress={() => setReviewing("proposal")} style={[styles.updateEntry, { borderColor: colors.borderSubtle }]}>
      <Ionicons name="arrow-up-circle-outline" size={20} color={colors.accent} />
      <View style={styles.content}><Text style={[styles.updateLabel, { color: colors.accent }]}>{Number.isFinite(Date.parse(currentUpdates[0].createdAt || "")) ? "最新の提案を見る" : "提案を見る"}</Text>
        <Text style={[styles.caption, { color: colors.textMuted }]}>{humanLearningDate(currentUpdates[0].createdAt || "")}</Text></View>
      <Ionicons name="chevron-forward" size={16} color={colors.accent} />
    </Pressable> : null}
    {!selecting && item.status === "active" && pastUpdates.length ? <Pressable accessibilityRole="button" accessibilityLabel={`提案の履歴を見る: ${item.content}`}
      disabled={busy} onPress={() => setReviewing("history")} style={styles.action}>
      <Ionicons name="time-outline" size={18} color={colors.textMuted} /><Text style={[styles.actionText, { color: colors.textSecondary }]}>履歴</Text>
    </Pressable> : null}
    {expanded ? <View style={[styles.details, { borderColor: colors.borderSubtle }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{item.content}</Text>
      {item.conditions ? <Text style={[styles.caption, { color: colors.textSecondary }]}>適用条件：{item.conditions}</Text> : null}
      <Text style={[styles.caption, { color: colors.textSecondary }]}>{KIND_LABELS[item.kind] || item.kind} · 元のチャット：{chatName} · {item.scope.shared ? "全チャット" : `${chatName}限定`} · 第{item.version}版</Text>
      {item.replaces?.length ? <Text style={[styles.caption, { color: colors.textSecondary }]}>{item.action === "retire" ? "停止" : "更新"}対象：{item.replaces.length}件の既存方針</Text> : null}
      {item.matchTerms?.length ? <Text style={[styles.caption, { color: colors.textSecondary }]}>関連する言葉：{item.matchTerms.join("、")}</Text> : null}
      {item.targetConstraints?.length ? <Text style={[styles.caption, { color: colors.textSecondary }]}>ツールで確認する対象：{item.targetConstraints.join("、")}</Text> : null}
      <Text style={[styles.caption, { color: colors.textSecondary }]}>作成理由：{item.reason}</Text>
      <Text style={[styles.caption, { color: colors.textSecondary }]}>根拠：{item.evidence.length}件のやりとり</Text>
      {item.updatedAt ? <Text style={[styles.caption, { color: colors.textMuted }]}>更新：{humanLearningDate(item.updatedAt)}</Text> : null}
      {item.skill ? <Text style={[styles.caption, { color: colors.textSecondary }]}>専用スキル案{`\n${learningSkillText(item.skill)}`}</Text> : null}
      {item.published ? <Text style={[styles.caption, { color: colors.textSecondary }]}>専用スキルを保存済み · 第{item.published.version}版</Text> : null}
      {item.status === "retired" && item.action === "retire" ? <Text style={[styles.caption, { color: colors.textSecondary }]}>再開する場合は元の方針から戻せます。</Text> : null}
      <View style={styles.actions}>
        {item.status === "candidate" ? action("見送る", "decide", { ...references, action: "reject" }) : null}
        {item.status === "active" ? <>
          {item.skill && !item.published ? action("専用スキルとして保存", "decide", { ...references, action: "publish" }) : null}
        </> : null}
        {action("学習を削除", "forget", references, true)}
      </View>
    </View> : null}
  </View>
    {reviewing ? <LearningUpdateReview updates={item.status === "candidate" && !updates.some((entry) => entry.id === item.id) ? [item] : updates}
      initialProposal={item.status === "candidate" ? item : reviewing === "history" ? pastUpdates[0] : currentUpdates[0]} historyMode={reviewing === "history"}
      knowledge={knowledge} changes={changes} chatName={chatName} orchestratorId={item.scope.orchestratorId} busy={busy} manage={manage} onClose={() => setReviewing(null)} /> : null}
  </>;
}
const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 }, heading: { flexDirection: "row", gap: 8 }, content: { flex: 1, gap: 8 },
  checkbox: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", alignSelf: "flex-start" },
  metadata: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  status: { fontSize: 11, fontWeight: "600", paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5 },
  updateEntry: { flexDirection: "row", alignItems: "center", minHeight: 48, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, marginTop: 2, paddingTop: 6 },
  updateLabel: { fontSize: 13, fontWeight: "600" }, historyEntry: { borderLeftWidth: 2, paddingLeft: 12, paddingVertical: 8, gap: 5 },
  comparisonPanel: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 12 }, original: { gap: 5 }, comparisonArrow: { alignItems: "center" },
  primaryAction: { minHeight: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 7 },
  secondaryAction: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  comparisonLabel: { fontSize: 11, fontWeight: "600" },
  title: { fontSize: 14, fontWeight: "500", lineHeight: 22 }, caption: { fontSize: 12, lineHeight: 18 },
  switchRow: { width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingVertical: 5 },
  actions: { flexDirection: "row", flexWrap: "wrap", columnGap: 18 },
  action: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 5 }, actionText: { fontSize: 13, fontWeight: "500" },
  details: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, gap: 8 },
});
