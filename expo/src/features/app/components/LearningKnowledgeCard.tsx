import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { humanLearningDate, knowledgeState } from "./learningDashboardData";
import { LearningDetailsModal } from "./LearningDetailsModal";

export type LearningKnowledge = {
  id: string; version: number; status: string; updatedAt?: string; kind: string; content: string; conditions: string; reason: string;
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

// A proposal belongs under its current cards only while every replacement still matches.
export function currentLearningUpdateSources(item: LearningKnowledge, knowledge: LearningKnowledge[]): LearningKnowledge[] {
  if (item.status !== "candidate" || item.action === "retire" || !item.replaces?.length) return [];
  const sources = item.replaces.map((id) => knowledge.find((entry) => entry.id === id));
  return sources.every((source): source is LearningKnowledge => source?.status === "active" && source.scope.orchestratorId === item.scope.orchestratorId && source.scope.shared === item.scope.shared
    && Boolean(item.replacementVersions?.some((entry) => entry.id === source.id && entry.version === source.version))) ? sources : [];
}

function LearningUpdateReview({ updates, knowledge, chatName, orchestratorId, busy, manage, onClose }: {
  updates: LearningKnowledge[]; knowledge: LearningKnowledge[]; chatName: string; orchestratorId: string; busy: boolean; manage: Manage; onClose: () => void;
}) {
  const { theme: { colors, tones } } = useVisualTheme();
  const [selection, setSelection] = useState(() => ({ id: updates[0]?.id, version: updates[0]?.version }));
  const [error, setError] = useState("");
  const currentPage = updates.findIndex((entry) => entry.id === selection.id && entry.version === selection.version);
  const proposal = updates[currentPage];
  const sources = proposal?.replaces?.map((id) => knowledge.find((entry) => entry.id === id)) || [];
  const changedSkillFields = Object.entries(SKILL_LABELS).filter(([key]) => sources.some((source) => source?.skill?.[key] !== proposal?.skill?.[key]));
  const ready = proposal && currentLearningUpdateSources(proposal, knowledge).length > 0;
  const choose = async (action: "adopt" | "reject") => {
    if (!proposal || busy || action === "adopt" && !ready) return;
    setError("");
    const failure = await manage("decide", { items: [{ id: proposal.id, version: proposal.version }], action }, false);
    if (failure) setError(failure);
    else onClose();
  };
  return <LearningDetailsModal visible title="学習の更新" subtitle={updates.length > 1 ? `${updates.length}件の更新案から選べます` : "現在の内容と比べて確認"}
    page={Math.max(0, currentPage)} testID="learning-update-modal" onClose={onClose}>
    {proposal ? <>
      {updates.length > 1 ? <View style={styles.proposalNavigation}>
        <Pressable accessibilityRole="button" accessibilityLabel="前の更新案" disabled={busy || currentPage === 0}
          onPress={() => { setSelection({ id: updates[currentPage - 1].id, version: updates[currentPage - 1].version }); setError(""); }} style={[styles.navigationButton, { opacity: busy || currentPage === 0 ? 0.35 : 1 }]}>
          <Ionicons name="chevron-back" size={20} color={colors.accent} /></Pressable>
        <Text accessibilityRole="header" style={[styles.actionText, { color: colors.textPrimary }]}>案 {currentPage + 1} / {updates.length}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="次の更新案" disabled={busy || currentPage === updates.length - 1}
          onPress={() => { setSelection({ id: updates[currentPage + 1].id, version: updates[currentPage + 1].version }); setError(""); }} style={[styles.navigationButton, { opacity: busy || currentPage === updates.length - 1 ? 0.35 : 1 }]}>
          <Ionicons name="chevron-forward" size={20} color={colors.accent} /></Pressable>
      </View> : null}
      <View style={[styles.comparisonPanel, { backgroundColor: colors.surfaceMuted, borderColor: colors.borderSubtle }]}>
        <View style={styles.comparisonHeading}><Ionicons name="checkmark-circle-outline" size={17} color={colors.textSecondary} />
          <Text style={[styles.comparisonLabel, { color: colors.textSecondary }]}>{ready ? sources.length > 1 ? `現在の内容 · ${sources.length}件` : "現在の内容" : "更新元の内容"}</Text></View>
        {sources.map((source, index) => <View key={proposal.replaces![index]} style={styles.original}>
          {source ? <>
            <Text style={[styles.title, { color: colors.textSecondary }]}>{source.content}</Text>
            <Text style={[styles.caption, { color: colors.textMuted }]}>使う範囲：{source.scope.shared ? "全チャット" : source.scope.orchestratorId === orchestratorId ? `${chatName}限定` : "別のチャット限定"}</Text>
            <Text style={[styles.caption, { color: colors.textMuted }]}>適用：{source.conditions || "条件なし"}</Text>
            {JSON.stringify(source.matchTerms || []) !== JSON.stringify(proposal.matchTerms || []) ? <Text style={[styles.caption, { color: colors.textMuted }]}>関連する言葉：{source.matchTerms?.join("、") || "指定なし"}</Text> : null}
            {JSON.stringify(source.targetConstraints || []) !== JSON.stringify(proposal.targetConstraints || []) ? <Text style={[styles.caption, { color: colors.textMuted }]}>確認対象：{source.targetConstraints?.join("、") || "指定なし"}</Text> : null}
            {changedSkillFields.length ? <Text style={[styles.caption, { color: colors.textSecondary }]}>{changedSkillFields.map(([key, label]) => `${label}: ${source.skill?.[key] || "なし"}`).join("\n")}</Text> : null}
          </> : <Text style={[styles.caption, { color: tones.warning.foreground }]}>更新元を確認できません</Text>}
        </View>)}
      </View>
      <View style={styles.comparisonArrow}><Ionicons name="arrow-down" size={23} color={colors.accent} /></View>
      <View style={[styles.comparisonPanel, { backgroundColor: tones.info.background, borderColor: colors.accent }]}>
        <View style={styles.comparisonHeading}><Ionicons name="sparkles-outline" size={17} color={colors.accent} />
          <Text style={[styles.comparisonLabel, { color: colors.accent }]}>{sources.length > 1 ? "まとめて更新後" : "更新後"}</Text></View>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{proposal.content}</Text>
        <Text style={[styles.caption, { color: colors.textSecondary }]}>使う範囲：{proposal.scope.shared ? "全チャット" : proposal.scope.orchestratorId === orchestratorId ? `${chatName}限定` : "別のチャット限定"}</Text>
        <Text style={[styles.caption, { color: colors.textSecondary }]}>適用：{proposal.conditions || "条件なし"}</Text>
        {sources.some((source) => JSON.stringify(source?.matchTerms || []) !== JSON.stringify(proposal.matchTerms || [])) ? <Text style={[styles.caption, { color: colors.textSecondary }]}>関連する言葉：{proposal.matchTerms?.join("、") || "指定なし"}</Text> : null}
        {sources.some((source) => JSON.stringify(source?.targetConstraints || []) !== JSON.stringify(proposal.targetConstraints || [])) ? <Text style={[styles.caption, { color: colors.textSecondary }]}>確認対象：{proposal.targetConstraints?.join("、") || "指定なし"}</Text> : null}
        {changedSkillFields.length ? <Text style={[styles.caption, { color: colors.textSecondary }]}>{changedSkillFields.map(([key, label]) => `${label}: ${proposal.skill?.[key] || "なし"}`).join("\n")}</Text> : null}
      </View>
      {proposal.reason ? <Text style={[styles.caption, { color: colors.textSecondary }]}>{proposal.reason}</Text> : null}
      {!ready ? <View style={[styles.notice, { backgroundColor: tones.warning.background }]}><Ionicons name="alert-circle-outline" size={18} color={tones.warning.foreground} />
        <Text style={[styles.noticeCopy, { color: tones.warning.foreground }]}>更新元が変わっています。この案は適用できません。</Text></View> : null}
      {error ? <Text accessibilityRole="alert" style={[styles.caption, { color: tones.danger.foreground }]}>{error}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={`この案に更新: ${proposal.content}`} disabled={busy || !ready}
        onPress={() => void choose("adopt")} style={[styles.primaryAction, { backgroundColor: colors.primaryAction, opacity: busy || !ready ? 0.4 : 1 }]}>
        <Ionicons name="checkmark" size={19} color={colors.textOnAccent} /><Text style={[styles.actionText, { color: colors.textOnAccent }]}>この案に更新</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`この案を見送る: ${proposal.content}`} disabled={busy}
        onPress={() => void choose("reject")} style={styles.secondaryAction}><Text style={[styles.actionText, { color: colors.textSecondary }]}>この案を見送る</Text></Pressable>
    </> : <Text style={[styles.caption, { color: colors.textSecondary }]}>この更新案は状態が変わりました。閉じて確認してください。</Text>}
  </LearningDetailsModal>;
}

export function LearningKnowledgeCard({ item, knowledge, chatName, selecting, selected, busy, onSelect, manage }: {
  item: LearningKnowledge; knowledge: LearningKnowledge[]; chatName: string; selecting: boolean; selected: boolean; busy: boolean;
  onSelect: () => void; manage: Manage;
}) {
  const { theme: { colors, tones } } = useVisualTheme();
  const [expanded, setExpanded] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const references = { items: [{ id: item.id, version: item.version }] };
  const isUpdate = item.status === "candidate" && item.action !== "retire" && Boolean(item.replaces?.length);
  const updates = item.status === "active" ? knowledge.filter((entry) => currentLearningUpdateSources(entry, knowledge).some((source) => source.id === item.id)) : [];
  const adoptLabel = item.action === "retire" ? "停止案を適用" : "更新内容を見る";
  const switchable = item.action !== "retire" && (item.status === "active" || item.status === "retired" || item.status === "candidate" && !item.replaces?.length);
  const restore = () => Alert.alert("この方針を再開", "置き換え先の方針が使用中なら停止し、この方針を再開します。", [
    { text: "キャンセル", style: "cancel" }, { text: "再開する", onPress: () => { void manage("decide", { ...references, action: "restore" }); } },
  ]);
  const tone = item.status === "active" ? tones.info : null;
  const action = (label: string, operation: string, payload: Record<string, unknown>, confirmation?: "forget" | "share") => {
    const disabled = busy;
    return <Pressable key={label} accessibilityRole="button" accessibilityLabel={`${label}: ${item.content}`} disabled={disabled}
      onPress={() => {
        if (confirmation) Alert.alert(
          confirmation === "forget" ? "この学習を削除" : "全チャットで使う",
          confirmation === "forget" ? "この学習と、編集・統合で関連する保存版を削除します。元の会話は残ります。"
            : "この学習を全チャットで、条件に応じて回答に使います。", [
          { text: "キャンセル", style: "cancel" },
          { text: confirmation === "forget" ? "削除する" : "適用する", style: confirmation === "forget" ? "destructive" : "default", onPress: () => { void manage(operation, payload); } },
        ]);
        else if (isUpdate && operation === "decide" && payload.action === "adopt") setReviewing(true);
        else void manage(operation, payload);
      }} style={({ pressed }) => [styles.action, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
      <Text style={[styles.actionText, { color: confirmation === "forget" ? tones.danger.foreground : colors.accent }]}>{label}</Text>
    </Pressable>;
  };
  return <><View accessibilityElementsHidden={reviewing} importantForAccessibility={reviewing ? "no-hide-descendants" : "auto"} style={[styles.card, { backgroundColor: colors.surface, borderColor: selected ? colors.accent : colors.borderSubtle }]}>
    <View style={styles.heading}>
      {selecting ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }}
        accessibilityLabel={`一括操作の対象に選択: ${item.content}`} disabled={busy} onPress={onSelect} style={styles.checkbox}>
        <Ionicons name={selected ? "checkbox" : "square-outline"} size={22} color={selected ? colors.accent : colors.textMuted} />
      </Pressable> : null}
      <View style={styles.content}>
        <View style={styles.metadata}>
          <Text style={[styles.status, { color: tone?.foreground || colors.textSecondary,
            backgroundColor: tone?.background || colors.surfaceMuted }]}>{isUpdate ? "更新案" : knowledgeState(item.status)}</Text>
          <Text style={[styles.caption, { color: colors.textSecondary }]}>{item.skill ? item.published ? "専用スキル" : "専用スキル案" : KIND_LABELS[item.kind] || "学習"}</Text>
          <Text style={[styles.caption, { color: colors.textMuted }]}>{item.scope.shared ? "全チャット" : `${chatName}限定`}</Text>
          {item.skill ? <Ionicons name="library-outline" size={13} color={colors.textMuted} accessibilityLabel="専用スキル" /> : null}
        </View>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{item.content}</Text>
        {item.action === "retire" && item.status === "candidate" ? <Text style={[styles.caption, { color: colors.textSecondary }]}>既存の方針を停止する案</Text>
          : item.conditions ? <Text style={[styles.caption, { color: colors.textSecondary }]}>適用：{item.conditions}</Text> : null}
      </View>
    </View>
    <View style={styles.actions}>
      {!selecting && switchable ? <View style={styles.switchRow}>
        <View style={styles.switchCopy}><Text style={[styles.actionText, { color: colors.textPrimary }]}>関連する回答で使う</Text>
          <Text style={[styles.caption, { color: colors.textMuted }]}>{item.status === "active" ? "条件に合うときに参照" : item.status === "candidate" ? "オンにすると採用" : "オフ・使用を停止中"}</Text></View>
        <Switch accessibilityLabel={`関連する回答で使う: ${item.content}`} value={item.status === "active"} disabled={busy}
          trackColor={{ false: colors.border, true: colors.accent }} onValueChange={() => {
            if (item.status === "retired") restore();
            else void manage("decide", { ...references, action: item.status === "active" ? "retire" : "adopt" });
          }} />
      </View> : null}
      {!selecting && item.status === "candidate" && !switchable ? action(adoptLabel, "decide", { ...references, action: "adopt" }) : null}
      <Pressable accessibilityRole="button" accessibilityLabel={`詳細・管理: ${item.content}`} accessibilityState={{ expanded }}
        disabled={busy} onPress={() => setExpanded((value) => !value)} style={styles.action}>
        <Text style={[styles.actionText, { color: colors.textSecondary }]}>{expanded ? "閉じる" : "詳細・管理"}</Text>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={13} color={colors.textMuted} />
      </Pressable>
    </View>
    {!selecting && updates.length ? <Pressable accessibilityRole="button" accessibilityLabel={`更新案${updates.length}件を見る: ${item.content}`}
      disabled={busy} onPress={() => setReviewing(true)} style={[styles.updateEntry, { borderColor: colors.borderSubtle }]}>
      <Ionicons name="arrow-up-circle-outline" size={20} color={colors.accent} />
      <Text style={[styles.updateLabel, { color: colors.accent }]}>更新案</Text>
      <View style={[styles.updateCount, { backgroundColor: tones.info.background }]}><Text style={[styles.comparisonLabel, { color: colors.accent }]}>{updates.length}</Text></View>
      <Ionicons name="chevron-forward" size={16} color={colors.accent} />
    </Pressable> : null}
    {expanded ? <View style={[styles.details, { borderColor: colors.borderSubtle }]}>
      {item.status === "active" ? <Text style={[styles.caption, { color: colors.textSecondary }]}>条件に合う回答で参照します。毎回使うとは限りません。</Text> : null}
      <Text style={[styles.caption, { color: colors.textSecondary }]}>{KIND_LABELS[item.kind] || item.kind} · 元のチャット：{chatName} · {item.scope.shared ? "全チャット共通" : `${chatName}限定`} · 第{item.version}版</Text>
      {item.action === "retire" && item.conditions ? <Text style={[styles.caption, { color: colors.textSecondary }]}>適用条件：{item.conditions}</Text> : null}
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
          {!item.scope.shared ? action("全チャットで使う", "decide", { ...references, action: "share" }, "share") : null}
          {item.skill && !item.published ? action("専用スキルとして保存", "decide", { ...references, action: "publish" }) : null}
        </> : null}
        {action("学習を削除", "forget", references, "forget")}
      </View>
    </View> : null}
  </View>
    {reviewing ? <LearningUpdateReview updates={isUpdate ? [item] : updates} knowledge={knowledge} chatName={chatName} orchestratorId={item.scope.orchestratorId} busy={busy} manage={manage} onClose={() => setReviewing(false)} /> : null}
  </>;
}
const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 }, heading: { flexDirection: "row", gap: 8 }, content: { flex: 1, gap: 8 },
  checkbox: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", alignSelf: "flex-start" },
  metadata: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  status: { fontSize: 11, fontWeight: "600", paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5 },
  updateEntry: { flexDirection: "row", alignItems: "center", minHeight: 48, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, marginTop: 2, paddingTop: 6 },
  updateLabel: { flex: 1, fontSize: 13, fontWeight: "600" }, updateCount: { minWidth: 24, height: 23, paddingHorizontal: 6, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  proposalNavigation: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, navigationButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  comparisonPanel: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 12 }, original: { gap: 5 }, comparisonArrow: { alignItems: "center" },
  primaryAction: { minHeight: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 7 },
  secondaryAction: { minHeight: 44, alignItems: "center", justifyContent: "center" }, notice: { padding: 12, borderRadius: 10, flexDirection: "row", gap: 7 }, noticeCopy: { flex: 1, fontSize: 12, lineHeight: 18 },
  comparisonHeading: { flexDirection: "row", alignItems: "center", gap: 5 }, comparisonLabel: { fontSize: 11, fontWeight: "600" },
  title: { fontSize: 14, fontWeight: "500", lineHeight: 22 }, caption: { fontSize: 12, lineHeight: 18 },
  switchRow: { width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingVertical: 5 }, switchCopy: { flex: 1, gap: 3 },
  actions: { flexDirection: "row", flexWrap: "wrap", columnGap: 18 },
  action: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 5 }, actionText: { fontSize: 13, fontWeight: "500" },
  details: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, gap: 8 },
});
