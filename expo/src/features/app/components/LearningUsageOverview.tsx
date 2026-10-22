import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { dashboardWindow, humanLearningDate, inBucket, usageTotals, type DashboardPeriod, type UsageHistory } from "./learningDashboardData";
import { LearningDetailsModal } from "./LearningDetailsModal";
import { LearningBars, LearningDisclosure, LearningPager, LearningPeriodControl } from "./LearningTimeline";

type Request = (op: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
export type LearningUsageStatus = { blockedReason: string | null;
  budget: { day: string; calls: number; tokens: number; maxCalls: number; maxTokens: number };
  today: { measuredCalls: number; partialCalls: number; missingCalls: number; unpricedCalls: number;
    inputTokens: number | null; outputTokens: number | null; reservationChargedTokens: number;
    anonymousCalls: number; estimatedCosts: { currency: string; amount: number }[] };
  priceSnapshot: { version: string } | null };
const number = (value: number) => value.toLocaleString("ja-JP");
const costText = (costs: Record<string, number>) => Object.entries(costs).map(([currency, amount]) => `${amount.toLocaleString("ja-JP", { maximumFractionDigits: 6 })} ${currency}`).join(" · ") || "未算定";
export function LearningUsageOverview({ request, usage, refreshKey, outputLimitEnforced }: { request: Request; usage: LearningUsageStatus | null; refreshKey: number; outputLimitEnforced: boolean }) {
  const { theme: { colors, tones } } = useVisualTheme();
  const [period, setPeriod] = useState<DashboardPeriod>("day"); const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null); const [detailsWindow, setDetailsWindow] = useState<ReturnType<typeof dashboardWindow> | null>(null); const [page, setPage] = useState(0);
  const [history, setHistory] = useState<UsageHistory | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [retry, setRetry] = useState(0);
  const showList = detailsWindow !== null;
  const window = detailsWindow ?? dashboardWindow(period, offset, true);
  useEffect(() => {
    let active = true; setLoading(true); setError(""); setHistory(null);
    void request("voice.learning.usage", { since: new Date(window.from).toISOString(), until: new Date(window.until - 1).toISOString(), limit: 10000 }).then((value) => {
      if (!active) return;
      if (!Array.isArray(value.calls) || !value.days || typeof value.days !== "object" || !value.retention || value.aggregateGranularity !== "UTC-day") throw new Error("利用量を読み込めません。");
      setHistory(value as unknown as UsageHistory);
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "利用量を読み込めません。"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, window.from, window.until, refreshKey, retry]);
  const reset = () => { setSelected(null); setDetailsWindow(null); setPage(0); };
  const summary = history ? usageTotals(history, window) : null;
  const bucket = window.buckets.find((entry) => entry.key === selected);
  const range = bucket || window;
  const detailsPeriod = bucket ? `${new Date(bucket.from).toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" })}${period === "week" ? ` – ${new Date(bucket.until - 1).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", timeZone: "UTC" })}` : ""}` : window.label;
  const selectedSummary = history ? usageTotals(history, range) : null;
  const calls = history?.calls.filter((entry) => inBucket(entry.startedAt, range)).slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)) || [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(calls.length / 5) - 1));
  return <><View testID="learning-usage-overview" accessibilityElementsHidden={showList} importantForAccessibility={showList ? "no-hide-descendants" : "auto"} style={styles.section}>
    <View><Text accessibilityRole="header" style={[styles.title, { color: colors.textPrimary }]}>AI利用量</Text><Text style={[styles.caption, { color: colors.textMuted, marginTop: 6 }]}>学習・評価のための利用 · UTC基準</Text></View>
    <View style={styles.summary}>
      <View style={styles.metric}><Text style={[styles.caption, { color: colors.textMuted }]}>取得済みトークン</Text><Text style={[styles.number, { color: colors.textPrimary }]}>{summary?.tokens === null || !summary ? "—" : number(summary.tokens)}</Text></View>
      <View style={styles.metric}><Text style={[styles.caption, { color: colors.textMuted }]}>呼び出し</Text><Text style={[styles.number, { color: colors.textPrimary }]}>{summary ? number(summary.calls) : "—"}<Text style={styles.unit}> 回</Text></Text></View>
    </View>
    <Text style={[styles.cost, { color: colors.textSecondary }]}>推定料金　{summary ? costText(summary.costs) : "—"}{summary?.unpricedCalls ? "（未算定分あり）" : ""}</Text>
    <LearningPeriodControl period={period} offset={offset} label={window.label} onPeriod={(value) => { setPeriod(value); setOffset(0); reset(); }} onOffset={(value) => { setOffset(value); reset(); }} />
    {history ? <LearningBars buckets={window.buckets} selected={selected} unit="tokens" onSelect={(key) => { setSelected(key); setDetailsWindow(window); setPage(0); }}
      values={window.buckets.map((entry) => { const total = usageTotals(history, entry); return { primary: total.tokens,
        label: `${total.tokens === null ? "トークン未取得" : `取得済み ${number(total.tokens)}トークン`}, ${total.calls}回${total.incomplete ? "、保持期間外を含む" : ""}` }; })} /> : null}
    {loading ? <Text style={[styles.caption, { color: colors.textMuted }]}>利用量を読み込み中…</Text> : null}
    {error ? <><Text accessibilityRole="alert" style={{ color: tones.danger.foreground }}>{error}</Text><Pressable accessibilityRole="button" accessibilityLabel="利用量を再読み込み" onPress={() => setRetry(retry + 1)} style={styles.linkButton}><Text style={{ color: colors.accent }}>再読み込み</Text></Pressable></> : null}
    {history ? <>
      <Pressable accessibilityRole="button" accessibilityLabel="利用明細を表示" onPress={() => { setSelected(null); setDetailsWindow(window); setPage(0); }} style={styles.linkButton}>
        <Text style={[styles.link, { color: colors.accent }]}>この期間の明細を見る</Text></Pressable>
      {summary?.incomplete ? <Text style={[styles.caption, { color: colors.textMuted }]}>保持期間外を含みます。表示は残っている記録のみです。</Text> : null}
      {summary?.unknownCalls ? <Text style={[styles.caption, { color: colors.textMuted }]}>取得済みの合計です。{summary.unknownCalls}回は利用量が未確定です。</Text> : null}
    </> : null}
    {usage ? <LearningDisclosure title="今日の予算と計測の詳細">
      <Text style={[styles.caption, { color: colors.textSecondary }]}>{new Date(`${usage.budget.day}T00:00:00Z`).toLocaleDateString("ja-JP", { month: "long", day: "numeric", timeZone: "UTC" })}（UTC）</Text>
      <Text style={[styles.recordHeading, { color: colors.textPrimary }]}>呼び出し {usage.budget.calls} / {usage.budget.maxCalls} 回</Text>
      <View style={[styles.track, { backgroundColor: colors.surfaceMuted }]}><View style={[styles.fill, { backgroundColor: colors.accent, width: `${Math.min(100, usage.budget.calls / Math.max(1, usage.budget.maxCalls) * 100)}%` }]} /></View>
      <Text style={[styles.caption, { color: colors.textSecondary }]}>予算消費 {number(usage.budget.tokens)} / {number(usage.budget.maxTokens)} tokens</Text>
      <Text style={[styles.caption, { color: colors.textMuted }]}>予算には予約・未取得分を含み、グラフの取得済み量とは異なります。</Text>
      <Text testID="learning-input-tokens" style={[styles.caption, { color: colors.textSecondary }]}>取得済み入力: {usage.today.inputTokens === null ? "未取得" : `${usage.today.inputTokens} tokens`}</Text>
      <Text style={[styles.caption, { color: colors.textSecondary }]}>取得済み出力: {usage.today.outputTokens === null ? "未取得" : `${usage.today.outputTokens} tokens`}</Text>
      <Text style={[styles.caption, { color: colors.textSecondary }]}>実測 {usage.today.measuredCalls} · 一部取得 {usage.today.partialCalls} · 欠測 {usage.today.missingCalls} 回</Text>
      {usage.today.estimatedCosts.length ? usage.today.estimatedCosts.map((cost) => <Text key={cost.currency} style={[styles.caption, { color: colors.textSecondary }]}>算定料金（算定できた分）: {cost.amount} {cost.currency}</Text>) : <Text style={[styles.caption, { color: colors.textSecondary }]}>{usage.priceSnapshot ? "料金算定不能（算定に必要な利用量が未取得）" : "料金算定不能（単価未設定）"}</Text>}
      {usage.today.unpricedCalls > 0 ? <Text style={[styles.caption, { color: colors.textMuted }]}>料金を算定できない呼び出し: {usage.today.unpricedCalls} 回</Text> : null}
      {!outputLimitEnforced ? <Text style={[styles.caption, { color: colors.textMuted }]}>トークン上限は目安です。呼び出し回数にも上限があります。</Text> : null}
    </LearningDisclosure> : <Text style={[styles.caption, { color: colors.textMuted }]}>利用量を取得できません。</Text>}
    {usage?.blockedReason || history?.blockedReason ? <Text accessibilityRole="alert" style={{ color: tones.danger.foreground }}>利用量の記録に問題があるため、新しい分析を保留しています。</Text> : null}
  </View>
    <LearningDetailsModal visible={showList} title="AI利用明細"
      subtitle={`${detailsPeriod} · UTC · ${selectedSummary?.calls ?? "—"}回`}
      page={currentPage} testID="learning-usage-details-modal" onClose={() => setDetailsWindow(null)}>
      {history ? <View style={styles.records}>
        {selectedSummary?.anonymousCalls ? <Text style={[styles.caption, { color: colors.textSecondary }]}>うち{selectedSummary.anonymousCalls}回は削除後の匿名集計です。モデル・実測量・料金の詳細は残っていません。</Text> : null}
        {history.retention.detailPrunedThrough && Date.parse(history.retention.detailPrunedThrough) >= range.from || calls.length < (selectedSummary?.calls || 0) - (selectedSummary?.anonymousCalls || 0)
          ? <Text style={[styles.caption, { color: colors.textMuted }]}>一部は日別集計のみ残っています。明細がない分もグラフには集計済みです。</Text> : null}
        {history.calls.length >= 10000 ? <Text style={[styles.caption, { color: colors.textMuted }]}>明細は取得上限の直近10,000件です。</Text> : null}
        {calls.slice(currentPage * 5, currentPage * 5 + 5).map((entry) => <View key={entry.callId} style={[styles.record, { borderColor: colors.borderSubtle }]}>
          <Text style={[styles.recordHeading, { color: colors.textPrimary }]}>{entry.reportedModel || `${entry.requestedModel}（指定モデル）`}</Text>
          <Text style={[styles.caption, { color: colors.textMuted }]}>{humanLearningDate(entry.startedAt, true)} UTC · {entry.status === "failed" ? "失敗" : entry.status === "pending" ? "処理中" : entry.status === "interrupted" ? "中断" : entry.status === "unknown" ? "結果未確認" : entry.status === "completed" ? "完了" : "状態不明"}</Text>
          <Text style={[styles.caption, { color: colors.textSecondary }]}>入力 {entry.usage.inputTokens === null ? "未取得" : number(entry.usage.inputTokens)} · 出力 {entry.usage.outputTokens === null ? "未取得" : number(entry.usage.outputTokens)} tokens</Text>
          <Text style={[styles.caption, { color: colors.textSecondary }]}>推定料金 {entry.cost.amount === null || !entry.cost.currency ? "未算定" : costText({ [entry.cost.currency]: entry.cost.amount })}{entry.usage.state !== "measured" ? " · 利用量の一部が未確定" : ""}</Text>
        </View>)}
        {!calls.length ? <Text style={[styles.caption, { color: colors.textMuted }]}>この期間の個別明細はありません。</Text> : null}
        <LearningPager page={currentPage} total={calls.length} onPage={setPage} label="利用明細" />
      </View> : <View style={styles.records}>
        <Text accessibilityRole={error ? "alert" : undefined} style={[styles.caption, { color: error ? tones.danger.foreground : colors.textMuted }]}>{error || "利用明細を読み込み中…"}</Text>
        {error ? <Pressable accessibilityRole="button" accessibilityLabel="利用明細を再読み込み" onPress={() => setRetry(retry + 1)} style={styles.linkButton}><Text style={{ color: colors.accent }}>再読み込み</Text></Pressable> : null}
      </View>}
    </LearningDetailsModal>
  </>;
}
const styles = StyleSheet.create({ section: { gap: 14 }, title: { fontSize: 19, fontWeight: "700" }, summary: { flexDirection: "row", flexWrap: "wrap", gap: 28 }, metric: { minWidth: 100, gap: 6 },
  number: { fontSize: 29, fontWeight: "700", fontVariant: ["tabular-nums"] }, unit: { fontSize: 12, fontWeight: "400" }, caption: { fontSize: 11, lineHeight: 17 },
  cost: { fontSize: 12 }, linkButton: { minHeight: 44, justifyContent: "center" }, link: { fontSize: 13, fontWeight: "600" }, records: { gap: 12 }, record: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, gap: 5 },
  recordHeading: { fontSize: 13, fontWeight: "600" }, track: { height: 5, borderRadius: 3, overflow: "hidden" }, fill: { height: 5, borderRadius: 3 } });
