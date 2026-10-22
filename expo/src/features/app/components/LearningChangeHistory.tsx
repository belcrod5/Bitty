import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { humanLearningDate, knowledgeState, learningChangeTitle, type LearningChange } from "./learningDashboardData";
import { LearningDisclosure, LearningPager } from "./LearningTimeline";

export function LearningChangeHistory({ changes, requests }: { changes: LearningChange[]; requests: { id: string; instruction: string; resolution?: { reason: string } }[] }) {
  const { theme: { colors } } = useVisualTheme(); const [page, setPage] = useState(0); const [requestPage, setRequestPage] = useState(0);
  const entries = changes.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const requestCurrentPage = Math.min(requestPage, Math.max(0, Math.ceil(requests.length / 5) - 1));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(entries.length / 5) - 1));
  return <LearningDisclosure title={`学習の履歴 · ${entries.length}件`}>
    {entries.length ? entries.slice(currentPage * 5, currentPage * 5 + 5).map((entry) => <View key={entry.id} style={[styles.row, { borderColor: colors.borderSubtle }]}>
      <Text style={[styles.date, { color: colors.textMuted }]}>{humanLearningDate(entry.at)} · {entry.actor === "ai" ? "AI" : "あなた"}</Text>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{learningChangeTitle(entry)}</Text>
      <Text numberOfLines={2} style={[styles.body, { color: colors.textSecondary }]}>{entry.after?.content || entry.before?.content || "内容は保持されていません"}</Text>
      <LearningDisclosure title="変更の詳細">
        {entry.action === "share" ? <Text style={[styles.body, { color: colors.textSecondary }]}>使用範囲：元のチャット限定 → 全チャット</Text> : null}
        {entry.action === "publish" ? <Text style={[styles.body, { color: colors.textSecondary }]}>専用スキル：保存前 → 第{entry.after?.published?.version || entry.after?.version}版を保存</Text> : null}
        {entry.before?.conditions !== entry.after?.conditions && entry.after?.conditions ? <Text style={[styles.body, { color: colors.textSecondary }]}>使う場面：{entry.before?.conditions || "指定なし"} → {entry.after.conditions}</Text> : null}
        <Text style={[styles.body, { color: colors.textSecondary }]}>理由：{entry.reason || "指定なし"}</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>変更前：{entry.before ? `${knowledgeState(entry.before.status)} · ${entry.before.content}` : "まだ登録されていません"}</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>変更後：{entry.after ? `${knowledgeState(entry.after.status)} · ${entry.after.content}` : "登録なし"}</Text>
      </LearningDisclosure>
    </View>) : <Text style={[styles.body, { color: colors.textMuted }]}>学習の変更はまだありません。</Text>}
    <LearningPager page={currentPage} total={entries.length} onPage={setPage} label="変更履歴" />
    {requests.length ? <LearningDisclosure title={`あなたからの修正依頼 · ${requests.length}件`}>
      {requests.slice().reverse().slice(requestCurrentPage * 5, requestCurrentPage * 5 + 5).map((entry) => <View key={entry.id} style={styles.request}><Text style={[styles.body, { color: colors.textPrimary }]}>{entry.instruction}</Text><Text style={[styles.date, { color: colors.textMuted }]}>{entry.resolution?.reason || "次回の分析待ち"}</Text></View>)}
      <LearningPager page={requestPage} total={requests.length} onPage={setRequestPage} label="修正依頼" />
    </LearningDisclosure> : null}
    <Text style={[styles.date, { color: colors.textMuted }]}>直近100件・90日分まで。整理済みの履歴は表示できません。</Text>
  </LearningDisclosure>;
}
const styles = StyleSheet.create({ row: { gap: 7, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 14 }, date: { fontSize: 11, lineHeight: 17 }, title: { fontSize: 14, fontWeight: "600" }, body: { fontSize: 12, lineHeight: 19 }, request: { gap: 5, paddingVertical: 8 } });
