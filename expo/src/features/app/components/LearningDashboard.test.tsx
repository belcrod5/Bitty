jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { LearningEvaluationOverview } from "./LearningEvaluationOverview";
import { LearningUsageOverview } from "./LearningUsageOverview";
import { LearningChangeHistory } from "./LearningChangeHistory";
import type { LearningEvaluation } from "./LearningEvaluationCard";
import type { UsageHistory } from "./learningDashboardData";
const evaluations = (count = 7): LearningEvaluation[] => Array.from({ length: count }, (_, index) => ({ id: `evaluation-${index}`, version: 1, goal: `確認作業 ${index}`, score: index ? 90 : null, reason: "根拠", unknowns: "", at: `2026-10-21T0${index}:00:00Z`, period: { from: null, until: null }, scope: { orchestratorId: "main" }, corrections: [] }));
const usageHistory = (): UsageHistory => ({ calls: Array.from({ length: 7 }, (_, index) => ({ callId: `call-${index}`, startedAt: `2026-10-21T0${index}:00:00Z`, status: ["completed", "pending", "failed", "interrupted", "unknown", "completed", "completed"][index], requestedModel: "model-a", reportedModel: index ? "model-a" : null, requestedEffort: "low", reportedEffort: null, usage: { inputTokens: 100, outputTokens: index ? 20 : null, state: index ? "measured" : "partial" }, cost: { amount: index ? 0 : null, currency: "USD" } })), days: { "2026-10-21": { buckets: { measured: { dimensions: { usageState: "measured", currency: "USD" }, totals: { calls: 6, inputTokens: 600, outputTokens: 120, missingInputCalls: 0, missingOutputCalls: 0, estimatedAmount: 0, unpricedCalls: 0 } }, partial: { dimensions: { usageState: "partial", currency: null }, totals: { calls: 1, inputTokens: 100, outputTokens: 0, missingInputCalls: 0, missingOutputCalls: 1, estimatedAmount: 0, unpricedCalls: 1 } } } } }, retention: { createdAt: "2026-10-01T00:00:00Z", detailPrunedThrough: null, aggregatePrunedThrough: null }, blockedReason: null, aggregateGranularity: "UTC-day" });
beforeEach(() => { jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00Z")); });
afterEach(() => { jest.restoreAllMocks(); });
test("overview hides evaluation cards until tapping a bucket, pages five at a time and closes in one tap", async () => {
  const screen = await render(<LearningEvaluationOverview evaluations={evaluations()} busy={false} manage={jest.fn(async () => null)} />);
  expect(screen.queryByText("確認作業 6")).toBeNull(); expect(screen.getByText("この期間の平均 · AI 6件 / あなた 0件")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(/10\/21: 7件/)); expect(screen.getByText("確認作業 6")).toBeTruthy(); expect(screen.queryByText("確認作業 0")).toBeNull();
  await fireEvent.press(screen.getByLabelText("評価の次のページ")); expect(screen.getByText("確認作業 0")).toBeTruthy(); expect(screen.getByText("未評価")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("評価の一覧を閉じる")); expect(screen.queryByText("確認作業 0")).toBeNull(); await screen.unmount();
});
test("unscored evaluations remain reachable, periods reset selection and future periods are disabled", async () => {
  const screen = await render(<LearningEvaluationOverview evaluations={evaluations(1)} busy={false} manage={jest.fn(async () => null)} />);
  await fireEvent.press(screen.getByLabelText("評価の一覧を表示")); expect(screen.getByText("確認作業 0")).toBeTruthy(); await fireEvent.press(screen.getByLabelText("週別")); expect(screen.queryByText("確認作業 0")).toBeNull();
  expect(screen.getByLabelText("次の期間")).toBeDisabled(); await fireEvent.press(screen.getByLabelText("前の期間")); await fireEvent.press(screen.getByLabelText("評価の一覧を表示")); expect(screen.getByText("この期間のふりかえりはありません。")).toBeTruthy(); await screen.unmount();
});
test("evaluation pagination clamps after a refresh removes records", async () => {
  const manage = jest.fn(async () => null); const screen = await render(<LearningEvaluationOverview evaluations={evaluations()} busy={false} manage={manage} />);
  await fireEvent.press(screen.getByLabelText("評価の一覧を表示")); await fireEvent.press(screen.getByLabelText("評価の次のページ")); await screen.rerender(<LearningEvaluationOverview evaluations={evaluations(1)} busy={false} manage={manage} />);
  expect(screen.getByText("確認作業 0")).toBeTruthy(); expect(screen.queryByLabelText("評価の次のページ")).toBeNull(); await screen.unmount();
});
test("usage reads existing API once, aggregates days without doubling calls, and drill-down shows truthful terminal states", async () => {
  const request = jest.fn(async () => usageHistory() as unknown as Record<string, unknown>); const screen = await render(<LearningUsageOverview request={request} usage={null} refreshKey={0} outputLimitEnforced={false} />);
  await waitFor(() => screen.getByText("820")); expect(request).toHaveBeenCalledWith("voice.learning.usage", { since: "2026-10-15T00:00:00.000Z", until: "2026-10-21T23:59:59.999Z", limit: 10000 });
  expect(screen.queryByText(/UTC ·/)).toBeNull(); await fireEvent.press(screen.getByLabelText(/10\/21: 取得済み 820/)); expect(screen.getByText(/UTC · 結果未確認/)).toBeTruthy(); expect(screen.getByText(/UTC · 中断/)).toBeTruthy(); expect(screen.getByText(/UTC · 失敗/)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("利用明細の次のページ")); expect(screen.getByText(/UTC · 処理中/)).toBeTruthy(); expect(screen.getByText("入力 100 · 出力 未取得 tokens")).toBeTruthy();
  expect(screen.getByText(/推定料金 未算定/)).toBeTruthy(); expect(request).toHaveBeenCalledTimes(1); await fireEvent.press(screen.getByLabelText("利用明細を閉じる")); expect(screen.queryByText(/UTC · 処理中/)).toBeNull(); await screen.unmount();
});
test("usage missing history and anonymous usage stay unknown, never zero; history errors are retriable", async () => {
  let fail = true; const history = usageHistory(); history.calls = []; history.days["2026-10-21"].buckets = { anonymous: { dimensions: { anonymous: true }, totals: { calls: 2 } } };
  const request = jest.fn(async () => { if (fail) throw new Error("履歴に接続できません"); return history as unknown as Record<string, unknown>; });
  const screen = await render(<LearningUsageOverview request={request} usage={null} refreshKey={0} outputLimitEnforced={false} />); await waitFor(() => screen.getByText("履歴に接続できません")); fail = false; await fireEvent.press(screen.getByLabelText("利用量を再読み込み"));
  await waitFor(() => screen.getByText("推定料金　未算定（未算定分あり）")); await fireEvent.press(screen.getByLabelText("利用明細を表示")); expect(screen.getByText(/うち2回は削除後の匿名集計/)).toBeTruthy(); expect(screen.getByText("この期間の個別明細はありません。")).toBeTruthy(); await screen.unmount();
});
test("usage ignores stale range responses after paging and never refetches for local disclosures", async () => {
  let resolveFirst!: (value: Record<string, unknown>) => void; const first = new Promise<Record<string, unknown>>((resolve) => { resolveFirst = resolve; });
  const request = jest.fn().mockReturnValueOnce(first).mockResolvedValueOnce({ ...usageHistory(), days: {}, calls: [] }); const screen = await render(<LearningUsageOverview request={request} usage={null} refreshKey={0} outputLimitEnforced={false} />);
  await fireEvent.press(screen.getByLabelText("前の期間")); await waitFor(() => screen.getByText("推定料金　未算定")); await act(async () => { resolveFirst(usageHistory() as unknown as Record<string, unknown>); await first; });
  expect(screen.queryByText("820")).toBeNull(); expect(request).toHaveBeenCalledTimes(2); await screen.unmount();
});
test("change history names actions, uses human dates, keeps snapshots folded and pages records", async () => {
  const changes = evaluations().map((entry, index) => ({ id: `change-${index}`, at: entry.at, action: index ? "share" : "created", actor: index ? "user" : "ai", reason: "変更理由", before: null, after: { id: "k", version: 1, status: "candidate", kind: "preference", content: "短い報告", conditions: "報告時", reason: "", scope: { orchestratorId: "main" }, evidence: [] } }));
  const screen = await render(<LearningChangeHistory changes={changes} requests={[]} />); expect(screen.queryByText("全チャットでの使用を開始")).toBeNull(); await fireEvent.press(screen.getByLabelText("学習の履歴 · 7件"));
  expect(screen.getAllByText("全チャットでの使用を開始")).toHaveLength(5); expect(screen.queryByText("変更前：まだ登録されていません")).toBeNull(); await fireEvent.press(screen.getAllByLabelText("変更の詳細")[0]); expect(screen.getByText("使用範囲：元のチャット限定 → 全チャット")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("変更履歴の次のページ")); expect(screen.getByText("応答の好みの候補を追加")).toBeTruthy(); expect(screen.getAllByText(/2026年10月21日/).length).toBeGreaterThan(0); await screen.unmount();
});
