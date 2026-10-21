import type { LearningEvaluation } from "./LearningEvaluationCard";
import type { LearningKnowledge } from "./LearningKnowledgeCard";

export type DashboardPeriod = "day" | "week";
export type ChartBucket = { key: string; from: number; until: number; label: string };
const DAY = 86_400_000;
export function dashboardWindow(period: DashboardPeriod, offset: number, utc: boolean, now = Date.now()) {
  const date = new Date(now);
  if (utc) date.setUTCHours(0, 0, 0, 0); else date.setHours(0, 0, 0, 0);
  const move = (value: Date, days: number) => { const next = new Date(value); if (utc) next.setUTCDate(next.getUTCDate() + days); else next.setDate(next.getDate() + days); return next; };
  const step = period === "day" ? 1 : 7;
  const count = period === "day" ? 7 : 6;
  const weekday = utc ? date.getUTCDay() : date.getDay();
  const end = move(date, period === "week" ? 8 - (weekday || 7) : 1);
  const until = move(end, offset * step * count);
  const from = move(until, -step * count);
  const format = (value: Date) => value.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", ...(utc ? { timeZone: "UTC" } : {}) });
  const buckets: ChartBucket[] = Array.from({ length: count }, (_, i) => {
    const start = move(from, i * step); const endDate = move(start, step);
    return { key: start.toISOString(), from: +start, until: +endDate, label: format(start) };
  });
  const endDate = move(until, -1);
  const year = utc ? from.getUTCFullYear() : from.getFullYear();
  const endYear = utc ? endDate.getUTCFullYear() : endDate.getFullYear();
  const currentYear = utc ? new Date(now).getUTCFullYear() : new Date(now).getFullYear();
  const label = year !== endYear ? `${year}/${format(from)} – ${endYear}/${format(endDate)}` : `${year !== currentYear ? `${year}/` : ""}${format(from)} – ${format(endDate)}`;
  return { from: +from, until: +until, buckets, label };
}
export const inBucket = (at: string, bucket: Pick<ChartBucket, "from" | "until">) => Date.parse(at) >= bucket.from && Date.parse(at) < bucket.until;
export const humanLearningDate = (at: string, utc = false) => Number.isFinite(Date.parse(at))
  ? new Date(at).toLocaleString("ja-JP", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", ...(utc ? { timeZone: "UTC" } : {}) }) : "日時不明";
export function evaluationScores(records: LearningEvaluation[]) {
  const ai = records.flatMap((record) => record.score === null ? [] : [record.score]);
  const user = records.flatMap((record) => {
    const correction = [...record.corrections].reverse().find((entry) => !entry.cancelledAt && (entry.score !== null || entry.reason.trim()));
    return correction?.score === undefined || correction.score === null ? [] : [correction.score];
  });
  const mean = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  return { ai: mean(ai), user: mean(user), aiCount: ai.length, userCount: user.length };
}
export type UsageCall = { callId: string; startedAt: string; status: string; requestedModel: string; reportedModel: string | null;
  requestedEffort: string; reportedEffort: string | null; usage: { inputTokens: number | null; outputTokens: number | null; state: string };
  cost: { amount: number | null; currency: string | null }; };
export type UsageHistory = { calls: UsageCall[]; days: Record<string, { buckets: Record<string, {
  dimensions: { anonymous?: boolean; currency?: string | null; usageState?: string }; totals: { calls: number; inputTokens?: number; outputTokens?: number;
    missingInputCalls?: number; missingOutputCalls?: number; unpricedCalls?: number; estimatedAmount?: number } }> }>;
  retention: { createdAt: string | null; detailPrunedThrough: string | null; aggregatePrunedThrough: string | null };
  blockedReason: string | null; aggregateGranularity: string };
// Days are the authoritative aggregate. Detailed calls are a drill-down, never added to these totals.
export function usageTotals(history: UsageHistory, range: Pick<ChartBucket, "from" | "until">) {
  let calls = 0; let tokens: number | null = null; let unknownCalls = 0; let anonymousCalls = 0; let unpricedCalls = 0;
  const costs: Record<string, number> = {};
  for (const [day, entry] of Object.entries(history.days)) {
    if (!inBucket(day, range)) continue;
    for (const { dimensions, totals } of Object.values(entry.buckets)) {
      calls += totals.calls;
      if (dimensions.anonymous) { anonymousCalls += totals.calls; unknownCalls += totals.calls; unpricedCalls += totals.calls; continue; }
      if ((totals.missingInputCalls ?? totals.calls) < totals.calls) tokens = (tokens ?? 0) + (totals.inputTokens ?? 0);
      if ((totals.missingOutputCalls ?? totals.calls) < totals.calls) tokens = (tokens ?? 0) + (totals.outputTokens ?? 0);
      if (dimensions.usageState !== "measured" || (totals.missingInputCalls ?? totals.calls) > 0 || (totals.missingOutputCalls ?? totals.calls) > 0) unknownCalls += totals.calls;
      unpricedCalls += totals.unpricedCalls ?? totals.calls;
      if (dimensions.currency && (totals.unpricedCalls ?? totals.calls) < totals.calls) costs[dimensions.currency] = (costs[dimensions.currency] ?? 0) + (totals.estimatedAmount ?? 0);
    }
  }
  const coverageStart = Math.max(Date.parse(history.retention.createdAt || "") || Infinity,
    history.retention.aggregatePrunedThrough ? Date.parse(history.retention.aggregatePrunedThrough) + DAY : -Infinity);
  return { calls, tokens, unknownCalls, anonymousCalls, unpricedCalls, costs,
    incomplete: range.from < coverageStart, hasRecords: calls > 0 };
}
export type LearningChange = { id: string; at: string; action: string; actor: string; reason: string; before: LearningKnowledge | null; after: LearningKnowledge | null };
const CHANGE_LABELS: Record<string, string> = { created: "新しい学習の候補を追加", adopt: "回答での使用を開始", reject: "学習の候補を見送り",
  retire: "回答での使用を停止", share: "全チャットでの使用を開始", publish: "専用スキルを保存", restore: "以前の方針で使用を再開",
  replaced: "新しい方針に置き換え", rollback_replaced: "以前の方針に戻すため使用を停止", edit_proposed: "方針の変更案を作成",
  merge_proposed: "方針をまとめる案を作成", retire_proposed: "方針を停止する案を作成" };
export const learningChangeTitle = (entry: LearningChange) => entry.action === "created" ? `${entry.after?.skill ? "専用スキル" : entry.after?.kind === "preference" ? "応答の好み" : "学習"}の候補を追加` : entry.action === "adopt" && entry.after?.status === "retired" ? "方針を停止する案を適用" : CHANGE_LABELS[entry.action] || "学習の内容を変更";
export const knowledgeState = (status: string) => ({ candidate: "確認待ち", active: "使用中", retired: "停止中", rejected: "見送り" }[status] || "状態不明");
