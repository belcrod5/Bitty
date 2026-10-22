import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { LearningEvaluationCard, type LearningEvaluation } from "./LearningEvaluationCard";
import { dashboardWindow, evaluationScores, inBucket, type DashboardPeriod } from "./learningDashboardData";
import { LearningDetailsModal } from "./LearningDetailsModal";
import { LearningBars, LearningPager, LearningPeriodControl } from "./LearningTimeline";

type Manage = (op: string, payload: Record<string, unknown>, reportError?: boolean) => Promise<string | null>;
export function LearningEvaluationOverview({ evaluations, busy, manage }: { evaluations: LearningEvaluation[]; busy: boolean; manage: Manage }) {
  const { theme: { colors } } = useVisualTheme();
  const [period, setPeriod] = useState<DashboardPeriod>("day"); const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null); const [detailsWindow, setDetailsWindow] = useState<ReturnType<typeof dashboardWindow> | null>(null); const [page, setPage] = useState(0);
  const showList = detailsWindow !== null;
  const window = detailsWindow ?? dashboardWindow(period, offset, false);
  const records = evaluations.filter((entry) => inBucket(entry.at, window)); const summary = evaluationScores(records);
  const bucket = window.buckets.find((entry) => entry.key === selected);
  const filtered = (bucket ? records.filter((entry) => inBucket(entry.at, bucket)) : records).slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 5) - 1));
  const detailsPeriod = bucket ? `${new Date(bucket.from).toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric" })}${period === "week" ? ` – ${new Date(bucket.until - 1).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}` : ""}` : window.label;
  const reset = () => { setSelected(null); setDetailsWindow(null); setPage(0); };
  return <><View testID="learning-evaluation-overview" accessibilityElementsHidden={showList} importantForAccessibility={showList ? "no-hide-descendants" : "auto"} style={styles.section}>
    <View><Text accessibilityRole="header" style={[styles.title, { color: colors.textPrimary }]}>会話のふりかえり</Text>
      <Text style={[styles.subtitle, { color: colors.textMuted }]}>希望に沿えたかを振り返ります</Text></View>
    <Text style={[styles.caption, { color: colors.textMuted }]}>この期間の平均 · AI {summary.aiCount}件 / あなた {summary.userCount}件</Text>
    <View style={styles.summary}>
      <View><Text style={[styles.legend, { color: colors.accent }]}>● AIの見立て</Text><Text style={[styles.score, { color: colors.textPrimary }]}>{summary.ai ?? "—"}<Text style={styles.denominator}> / 100</Text></Text></View>
      <View><Text style={[styles.legend, { color: colors.textSecondary }]}>● あなたの評価</Text><Text style={[styles.score, { color: colors.textPrimary }]}>{summary.user ?? "—"}<Text style={styles.denominator}> / 100</Text></Text></View>
    </View>
    <LearningPeriodControl period={period} offset={offset} label={window.label} onPeriod={(value) => { setPeriod(value); setOffset(0); reset(); }} onOffset={(value) => { setOffset(value); reset(); }} />
    <LearningBars buckets={window.buckets} selected={selected} maximum={100} unit="平均点" secondaryLabel="あなたの評価" onSelect={(key) => { setSelected(key); setDetailsWindow(window); setPage(0); }}
      values={window.buckets.map((entry) => { const scores = evaluationScores(records.filter((record) => inBucket(record.at, entry))); return { primary: scores.ai, secondary: scores.user,
        label: `${records.filter((record) => inBucket(record.at, entry)).length}件。AIの見立て ${scores.ai === null ? "未評価" : `${scores.ai}点`}, あなた ${scores.user === null ? "未評価" : `${scores.user}点`}` }; })} />
    <Pressable accessibilityRole="button" accessibilityLabel="評価の一覧を表示" onPress={() => { setSelected(null); setDetailsWindow(window); setPage(0); }} style={styles.listButton}>
      <Text style={[styles.link, { color: colors.accent }]}>{`ふりかえりを見る · ${records.length}件`}</Text></Pressable>
    <Text style={[styles.caption, { color: colors.textMuted }]}>保存中の評価（直近100件・90日まで）を評価した日で集計。— は未評価。</Text>
  </View>
    <LearningDetailsModal visible={showList} title="会話のふりかえり"
      subtitle={`${detailsPeriod} · ${filtered.length}件`}
      page={currentPage} testID="learning-evaluations-modal" onClose={() => setDetailsWindow(null)}>
      <View style={styles.list}>
        {filtered.length ? filtered.slice(currentPage * 5, currentPage * 5 + 5).map((evaluation) => <LearningEvaluationCard key={evaluation.id} evaluation={evaluation} busy={busy} manage={manage} />)
          : <Text style={[styles.caption, { color: colors.textMuted }]}>この期間のふりかえりはありません。</Text>}
        <LearningPager page={currentPage} total={filtered.length} onPage={setPage} label="評価" />
      </View>
    </LearningDetailsModal>
  </>;
}
const styles = StyleSheet.create({ section: { gap: 14 }, title: { fontSize: 19, fontWeight: "700" }, subtitle: { fontSize: 12, marginTop: 6 }, summary: { flexDirection: "row", flexWrap: "wrap", gap: 24, paddingTop: 6 },
  legend: { fontSize: 12, fontWeight: "500" }, score: { fontSize: 31, fontWeight: "700", marginTop: 6, fontVariant: ["tabular-nums"] }, denominator: { fontSize: 12, fontWeight: "400" },
  listButton: { minHeight: 44, justifyContent: "center" }, link: { fontSize: 13, fontWeight: "600" }, list: { gap: 12 }, caption: { fontSize: 11, lineHeight: 17 } });
