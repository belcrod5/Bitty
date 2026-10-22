import { dashboardWindow, evaluationScores, humanLearningDate, learningChangeTitle, usageTotals, type UsageHistory } from "./learningDashboardData";
import type { LearningEvaluation } from "./LearningEvaluationCard";
const evaluation = (score: number | null, corrections: LearningEvaluation["corrections"] = []): LearningEvaluation => ({ id: "e", version: 1, goal: "報告", score, corrections, reason: "理由", unknowns: "", at: "2026-10-21T01:00:00Z", period: { from: null, until: null }, scope: { orchestratorId: "main" } });
const range = { from: Date.parse("2026-10-20"), until: Date.parse("2026-10-22") };
const usageFixture = (): UsageHistory => ({ calls: [], days: { "2026-10-21": { buckets: { a: { dimensions: { currency: "USD", usageState: "measured" }, totals: { calls: 2, inputTokens: 100, outputTokens: 20, missingInputCalls: 0, missingOutputCalls: 0, unpricedCalls: 0, estimatedAmount: 0.01 } } } } }, retention: { createdAt: "2026-10-01T00:00:00Z", aggregatePrunedThrough: null, detailPrunedThrough: null }, blockedReason: null, aggregateGranularity: "UTC-day" });
test("day and Monday-week windows are nonoverlapping and period paging stays UTC", () => {
  const now = Date.parse("2026-10-21T23:00:00Z"); const days = dashboardWindow("day", 0, true, now); const previous = dashboardWindow("day", -1, true, now);
  expect(days.buckets).toHaveLength(7); expect(new Date(days.until).toISOString()).toBe("2026-10-22T00:00:00.000Z"); expect(previous.until).toBe(days.from);
  const weeks = dashboardWindow("week", 0, true, now); expect(weeks.buckets).toHaveLength(6); expect(new Date(weeks.from).getUTCDay()).toBe(1); expect(weeks.buckets[1].from).toBe(weeks.buckets[0].until);
});
test("local windows follow local midnight rather than UTC; year boundaries identify the year", () => {
  const now = new Date(2026, 0, 2, 1).getTime(); const window = dashboardWindow("day", 0, false, now);
  expect(new Date(window.until).getHours()).toBe(0); expect(window.label).toContain("2025/"); expect(window.label).toContain("2026/");
  expect(humanLearningDate("not-a-date")).toBe("日時不明");
});
test("zero scores are valid, missing scores excluded, latest reason-only never falls back to AI or an older score", () => {
  expect(evaluationScores([evaluation(0), evaluation(null), evaluation(100)])).toEqual({ ai: 50, user: null, aiCount: 2, userCount: 0 });
  const records = [evaluation(100, [{ id: "old", score: 80, reason: "", at: "1" }, { id: "new", score: null, reason: "要確認", at: "2" }])];
  expect(evaluationScores(records).user).toBeNull(); records[0].corrections[1].cancelledAt = "3"; expect(evaluationScores(records).user).toBe(80);
});
test("authoritative daily aggregates never add detailed calls again", () => {
  const history = usageFixture(); history.calls = [{ callId: "same-call", startedAt: "2026-10-21T01:00:00Z" }] as UsageHistory["calls"];
  expect(usageTotals(history, range)).toMatchObject({ calls: 2, tokens: 120, costs: { USD: 0.01 }, unknownCalls: 0, incomplete: false });
});
test("unknown, partial and anonymous usage cannot become zero or invented model costs", () => {
  const history = usageFixture(); history.days["2026-10-21"].buckets = { a: { dimensions: { usageState: "partial" }, totals: { calls: 1, inputTokens: 0, outputTokens: 0, missingInputCalls: 0, missingOutputCalls: 1, unpricedCalls: 1 } }, anonymous: { dimensions: { anonymous: true }, totals: { calls: 3 } } };
  expect(usageTotals(history, range)).toMatchObject({ calls: 4, tokens: 0, unknownCalls: 4, anonymousCalls: 3, costs: {}, unpricedCalls: 4 });
  history.days = {}; expect(usageTotals(history, range).tokens).toBeNull();
});
test("inclusion-unconfirmed partial with known input/output remains marked incomplete measurement", () => {
  const history = usageFixture(); history.days["2026-10-21"].buckets.a.dimensions.usageState = "partial";
  expect(usageTotals(history, range).unknownCalls).toBe(2);
});
test("currencies stay separate, known free cost stays zero, retention gaps are explicit", () => {
  const history = usageFixture(); history.days["2026-10-21"].buckets.b = { dimensions: { currency: "JPY", usageState: "measured" }, totals: { calls: 1, inputTokens: 2, outputTokens: 1, missingInputCalls: 0, missingOutputCalls: 0, unpricedCalls: 0, estimatedAmount: 0 } };
  expect(usageTotals(history, range).costs).toEqual({ USD: 0.01, JPY: 0 }); history.retention.aggregatePrunedThrough = "2026-10-20"; expect(usageTotals(history, range).incomplete).toBe(true);
});
test("real stopping-proposal history snapshots have status, not action", () => {
  const entry = { id: "change", at: "2026-10-21", action: "adopt", actor: "user", reason: "", before: null, after: { status: "retired" } } as Parameters<typeof learningChangeTitle>[0];
  expect(learningChangeTitle(entry)).toBe("方針を停止する案を適用"); expect(learningChangeTitle({ ...entry, action: "created", after: { ...entry.after!, kind: "preference" } })).toBe("応答の好みの候補を追加");
});
