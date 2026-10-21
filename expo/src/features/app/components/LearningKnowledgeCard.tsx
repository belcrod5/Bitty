import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { humanLearningDate, knowledgeState } from "./learningDashboardData";

export type LearningKnowledge = {
  id: string; version: number; status: string; updatedAt?: string; kind: string; content: string; conditions: string; reason: string;
  action?: "create" | "retire"; replaces?: string[];
  scope: { orchestratorId: string; shared?: boolean }; matchTerms?: string[]; targetConstraints?: string[];
  skill?: Record<string, string>; published?: { version: number; hash: string }; evidence: { pairSeq: number }[];
};
const KIND_LABELS: Record<string, string> = {
  preference: "応答の好み", procedure: "作業の手順", batch_proposal: "まとめて行う作業",
};
export const learningSkillText = (skill?: Record<string, string>) => skill ? Object.entries({ purpose: "目的", triggers: "発動条件", inputs: "入力",
  steps: "手順", outputs: "出力", exceptions: "例外", approvals: "必要な承認" }).map(([key, label]) => `${label}: ${skill[key] || "未設定"}`).join("\n") : "なし";
type Manage = (op: string, payload: Record<string, unknown>, reportError?: boolean) => Promise<string | null>;

export function LearningKnowledgeCard({ item, chatName, selecting, selected, busy, onSelect, manage }: {
  item: LearningKnowledge; chatName: string; selecting: boolean; selected: boolean; busy: boolean;
  onSelect: () => void; manage: Manage;
}) {
  const { theme: { colors, tones } } = useVisualTheme();
  const [expanded, setExpanded] = useState(false);
  const references = { items: [{ id: item.id, version: item.version }] };
  const adoptLabel = item.action === "retire" ? "停止案を適用" : "変更案を適用";
  const switchable = item.action !== "retire" && (item.status === "active" || item.status === "retired" || item.status === "candidate" && !item.replaces?.length);
  const restore = () => Alert.alert("この方針を再開", "置き換え先の方針が使用中なら停止し、この方針を再開します。", [
    { text: "キャンセル", style: "cancel" }, { text: "再開する", onPress: () => { void manage("decide", { ...references, action: "restore" }); } },
  ]);
  const tone = item.status === "active" ? tones.info : null;
  const action = (label: string, operation: string, payload: Record<string, unknown>, confirmation?: "forget" | "share") =>
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={`${label}: ${item.content}`} disabled={busy}
      onPress={() => {
        if (confirmation) Alert.alert(
          confirmation === "forget" ? "この学習を削除" : "全チャットで使う",
          confirmation === "forget" ? "この学習と、編集・統合で関連する保存版を削除します。元の会話は残ります。"
            : "この学習を全チャットで、条件に応じて回答に使います。", [
          { text: "キャンセル", style: "cancel" },
          { text: confirmation === "forget" ? "削除する" : "適用する", style: confirmation === "forget" ? "destructive" : "default", onPress: () => { void manage(operation, payload); } },
        ]);
        else void manage(operation, payload);
      }} style={({ pressed }) => [styles.action, { opacity: busy ? 0.4 : pressed ? 0.6 : 1 }]}>
      <Text style={[styles.actionText, { color: confirmation === "forget" ? tones.danger.foreground : colors.accent }]}>{label}</Text>
    </Pressable>;
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: selected ? colors.accent : colors.borderSubtle }]}>
    <View style={styles.heading}>
      {selecting ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }}
        accessibilityLabel={`一括操作の対象に選択: ${item.content}`} disabled={busy} onPress={onSelect} style={styles.checkbox}>
        <Ionicons name={selected ? "checkbox" : "square-outline"} size={22} color={selected ? colors.accent : colors.textMuted} />
      </Pressable> : null}
      <View style={styles.content}>
        <View style={styles.metadata}>
          <Text style={[styles.status, { color: tone?.foreground || colors.textSecondary,
            backgroundColor: tone?.background || colors.surfaceMuted }]}>{knowledgeState(item.status)}</Text>
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
    {expanded ? <View style={[styles.details, { borderColor: colors.borderSubtle }]}>
      {item.status === "active" ? <Text style={[styles.caption, { color: colors.textSecondary }]}>条件に合う回答で参照します。毎回使うとは限りません。</Text> : null}
      <Text style={[styles.caption, { color: colors.textSecondary }]}>{KIND_LABELS[item.kind] || item.kind} · 元のチャット：{chatName} · {item.scope.shared ? "全チャット共通" : `${chatName}限定`} · 第{item.version}版</Text>
      {item.action === "retire" && item.conditions ? <Text style={[styles.caption, { color: colors.textSecondary }]}>適用条件：{item.conditions}</Text> : null}
      {item.replaces?.length ? <Text style={[styles.caption, { color: colors.textSecondary }]}>{item.action === "retire" ? "停止" : "置き換え"}対象：{item.replaces.length}件の既存方針</Text> : null}
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
  </View>;
}
const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 }, heading: { flexDirection: "row", gap: 8 }, content: { flex: 1, gap: 8 },
  checkbox: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", alignSelf: "flex-start" },
  metadata: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  status: { fontSize: 11, fontWeight: "600", paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5 },
  title: { fontSize: 14, fontWeight: "500", lineHeight: 22 }, caption: { fontSize: 12, lineHeight: 18 },
  switchRow: { width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingVertical: 5 }, switchCopy: { flex: 1, gap: 3 },
  actions: { flexDirection: "row", flexWrap: "wrap", columnGap: 18 },
  action: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 5 }, actionText: { fontSize: 13, fontWeight: "500" },
  details: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, gap: 8 },
});
