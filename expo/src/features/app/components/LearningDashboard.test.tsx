jest.mock("../keyboardController", () => ({ KeyboardAwareScrollView: require("react-native").ScrollView, KeyboardAvoidingView: require("react-native").KeyboardAvoidingView }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
import { act, fireEvent, render, waitFor, within } from "@testing-library/react-native";
import { LearningEvaluationOverview } from "./LearningEvaluationOverview";
import { LearningUsageOverview } from "./LearningUsageOverview";
import { LearningChangeHistory } from "./LearningChangeHistory";
import { Alert } from "react-native";
import type { LearningEvaluation } from "./LearningEvaluationCard";
import type { UsageHistory } from "./learningDashboardData";
const evaluations = (count = 7): LearningEvaluation[] => Array.from({ length: count }, (_, index) => ({ id: `evaluation-${index}`, version: 1, goal: `確認作業 ${index}`, score: index ? 90 : null, reason: "根拠", unknowns: "", at: `2026-10-21T0${index}:00:00Z`, period: { from: null, until: null }, scope: { orchestratorId: "main" }, corrections: [] }));
const usageHistory = (): UsageHistory => ({ calls: Array.from({ length: 7 }, (_, index) => ({ callId: `call-${index}`, startedAt: `2026-10-21T0${index}:00:00Z`, status: ["completed", "pending", "failed", "interrupted", "unknown", "completed", "completed"][index], requestedModel: "model-a", reportedModel: index ? "model-a" : null, requestedEffort: "low", reportedEffort: null, usage: { inputTokens: 100, outputTokens: index ? 20 : null, state: index ? "measured" : "partial" }, cost: { amount: index ? 0 : null, currency: "USD" } })), days: { "2026-10-21": { buckets: { measured: { dimensions: { usageState: "measured", currency: "USD" }, totals: { calls: 6, inputTokens: 600, outputTokens: 120, missingInputCalls: 0, missingOutputCalls: 0, estimatedAmount: 0, unpricedCalls: 0 } }, partial: { dimensions: { usageState: "partial", currency: null }, totals: { calls: 1, inputTokens: 100, outputTokens: 0, missingInputCalls: 0, missingOutputCalls: 1, estimatedAmount: 0, unpricedCalls: 1 } } } } }, retention: { createdAt: "2026-10-01T00:00:00Z", detailPrunedThrough: null, aggregatePrunedThrough: null }, blockedReason: null, aggregateGranularity: "UTC-day" });
beforeEach(() => { jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00Z")); });
afterEach(() => { jest.restoreAllMocks(); });
test("overview hides evaluation cards until tapping a bucket, pages five at a time and closes in one tap", async () => {
  const screen = await render(<LearningEvaluationOverview evaluations={evaluations()} busy={false} manage={jest.fn(async () => null)} />);
  expect(screen.queryByText("確認作業 6")).toBeNull(); expect(screen.getByText("この期間の平均 · AI 6件 / あなた 0件")).toBeTruthy();
  const background = screen.getByTestId("learning-evaluation-overview"); const originalChildren = background.children.length;
  await fireEvent.press(screen.getByLabelText(/10\/21: 7件/));
  expect(background.children).toHaveLength(originalChildren);
  expect(within(background).queryByText("確認作業 6", { includeHiddenElements: true })).toBeNull();
  expect(screen.getByTestId("learning-evaluations-modal").props.presentationStyle).toBe("fullScreen"); expect(screen.getByText("確認作業 6")).toBeTruthy(); expect(screen.queryByText("確認作業 0")).toBeNull();
  await fireEvent.press(screen.getByLabelText("評価の次のページ")); expect(screen.getByText("確認作業 0")).toBeTruthy(); expect(screen.getByText("未評価")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("会話のふりかえりを閉じる")); expect(screen.queryByText("確認作業 0")).toBeNull(); await screen.unmount();
});
test("unscored evaluations remain reachable, periods reset selection and future periods are disabled", async () => {
  const screen = await render(<LearningEvaluationOverview evaluations={evaluations(1)} busy={false} manage={jest.fn(async () => null)} />);
  await fireEvent.press(screen.getByLabelText("評価の一覧を表示")); expect(screen.getByText("確認作業 0")).toBeTruthy(); await fireEvent.press(screen.getByLabelText("会話のふりかえりを閉じる")); await fireEvent.press(screen.getByLabelText("週別")); expect(screen.queryByText("確認作業 0")).toBeNull();
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
  expect(screen.getByText(/推定料金 未算定/)).toBeTruthy(); expect(request).toHaveBeenCalledTimes(1); await fireEvent.press(screen.getByLabelText("AI利用明細を閉じる")); expect(screen.queryByText(/UTC · 処理中/)).toBeNull(); await screen.unmount();
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

test("evaluation modal keeps the exact selected day, returns to the same graph and reopens on page one", async () => {
  const otherDay = { ...evaluations(1)[0], id: "other-day", goal: "別日の作業", at: "2026-10-20T05:00:00Z" };
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningEvaluationOverview evaluations={[...evaluations(), otherDay]} busy={false} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(/10\/21: 7件/));
  expect(screen.getByText("2026/10/21 · 7件")).toBeTruthy(); expect(screen.queryByText("別日の作業")).toBeNull();
  await fireEvent.press(screen.getByLabelText("評価の次のページ"));
  await fireEvent(screen.getByTestId("learning-evaluations-modal"), "requestClose");
  expect(screen.getByLabelText(/10\/21: 7件/).props.accessibilityState.selected).toBe(true);
  expect(screen.getByText("10/15 – 10/21")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(/10\/21: 7件/));
  expect(screen.getByText("確認作業 6")).toBeTruthy(); expect(screen.queryByText("確認作業 0")).toBeNull();
  expect(manage).not.toHaveBeenCalled(); await screen.unmount();
});
test("evaluation editing stays in the foreground, failed drafts remain, closing discards drafts and saving preserves exact API payload", async () => {
  const records = evaluations(1); const manage = jest.fn<Promise<string | null>, [string, Record<string, unknown>, boolean?]>().mockResolvedValueOnce("保存できません").mockResolvedValueOnce(null);
  const screen = await render(<LearningEvaluationOverview evaluations={records} busy={false} manage={manage} />);
  await fireEvent.press(screen.getByLabelText("評価の一覧を表示")); await fireEvent.press(screen.getByLabelText("評価を変更"));
  await fireEvent.changeText(screen.getByLabelText("訂正点数: 確認作業 0"), "55"); await fireEvent.press(screen.getByLabelText("評価を保存"));
  await waitFor(() => screen.getByText("保存できません")); expect(screen.getByLabelText("訂正点数: 確認作業 0").props.value).toBe("55");
  await fireEvent.press(screen.getByLabelText("会話のふりかえりを閉じる")); await fireEvent.press(screen.getByLabelText("評価の一覧を表示"));
  expect(screen.queryByLabelText("訂正点数: 確認作業 0")).toBeNull(); expect(manage).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByLabelText("評価を変更")); expect(screen.getByLabelText("訂正点数: 確認作業 0").props.value).toBe("");
  await fireEvent.changeText(screen.getByLabelText("訂正点数: 確認作業 0"), "55"); await fireEvent.press(screen.getByLabelText("評価を保存"));
  await waitFor(() => expect(manage).toHaveBeenLastCalledWith("correct", { evaluationId: "evaluation-0", version: 1, score: 55, reason: "" }, false));
  await screen.rerender(<LearningEvaluationOverview evaluations={[{ ...records[0], corrections: [{ id: "correction", score: 55, reason: "", at: "2026-10-21T12:00:00Z" }] }]} busy={false} manage={manage} />);
  expect(screen.getByText("55 / 100")).toBeTruthy(); expect(screen.getByLabelText("会話のふりかえりを閉じる")).toBeTruthy(); await screen.unmount();
});
test("existing correction cancellation still confirms and sends protected identifiers from inside foreground details", async () => {
  const manage = jest.fn(async () => null); const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const records = [{ ...evaluations(1)[0], corrections: [{ id: "correction-1", score: 55, reason: "短さを希望", at: "2026-10-21T12:00:00Z" }] }];
  const screen = await render(<LearningEvaluationOverview evaluations={records} busy={false} manage={manage} />);
  await fireEvent.press(screen.getByLabelText("評価の一覧を表示")); await fireEvent.press(screen.getByLabelText("訂正履歴 · 1")); await fireEvent.press(screen.getByLabelText("訂正を取り消す: correction-1"));
  expect(manage).not.toHaveBeenCalled(); await act(async () => { alert.mock.calls[0][2]?.find((entry) => entry.style === "destructive")?.onPress?.(); });
  expect(manage).toHaveBeenCalledWith("correction.cancel", { evaluationId: "evaluation-0", version: 1, correctionIds: ["correction-1"] }, false); await screen.unmount();
});
test("usage modal pages, closes by OS back, preserves the graph and reopens without another history request", async () => {
  const history = usageHistory(); const request = jest.fn(async () => history as unknown as Record<string, unknown>);
  const screen = await render(<LearningUsageOverview request={request} usage={null} refreshKey={0} outputLimitEnforced={false} />);
  await waitFor(() => screen.getByText("820")); const background = screen.getByTestId("learning-usage-overview"); const originalChildren = background.children.length;
  await fireEvent.press(screen.getByLabelText(/10\/21: 取得済み 820/)); expect(screen.getByText("2026/10/21 · UTC · 7回")).toBeTruthy();
  expect(within(background).queryByText(/UTC ·/, { includeHiddenElements: true })).toBeNull(); expect(background.children).toHaveLength(originalChildren);
  await fireEvent.press(screen.getByLabelText("利用明細の次のページ")); await fireEvent(screen.getByTestId("learning-usage-details-modal"), "requestClose");
  expect(screen.getByLabelText(/10\/21: 取得済み 820/).props.accessibilityState.selected).toBe(true);
  await fireEvent.press(screen.getByLabelText("利用明細を表示")); expect(screen.getByText(/UTC · 結果未確認/)).toBeTruthy(); expect(screen.queryByText(/UTC · 処理中/)).toBeNull();
  expect(request).toHaveBeenCalledTimes(1); await screen.unmount();
});
test("weekly modal shows its selected UTC range and an empty usage bucket still opens a closeable foreground", async () => {
  const request = jest.fn(async () => usageHistory() as unknown as Record<string, unknown>);
  const screen = await render(<LearningUsageOverview request={request} usage={null} refreshKey={0} outputLimitEnforced={false} />); await waitFor(() => screen.getByText("820"));
  await fireEvent.press(screen.getByLabelText("週別")); await waitFor(() => screen.getByLabelText(/10\/19: 取得済み 820/)); await fireEvent.press(screen.getByLabelText(/10\/19: 取得済み 820/));
  expect(screen.getByText("2026/10/19 – 10/25 · UTC · 7回")).toBeTruthy(); await fireEvent.press(screen.getByLabelText("AI利用明細を閉じる"));
  await fireEvent.press(screen.getByLabelText(/10\/12: トークン未取得/)); expect(screen.getByText("この期間の個別明細はありません。")).toBeTruthy(); expect(screen.getByLabelText("AI利用明細を閉じる")).toBeTruthy(); expect(request).toHaveBeenCalledTimes(2); await screen.unmount();
});

test("usage refresh errors inside an open modal can retry in front without closing or refetching on local reopening", async () => {
  const request = jest.fn().mockResolvedValueOnce(usageHistory()).mockRejectedValueOnce(new Error("明細の更新に失敗しました")).mockResolvedValueOnce(usageHistory());
  const screen = await render(<LearningUsageOverview request={request} usage={null} refreshKey={0} outputLimitEnforced={false} />); await waitFor(() => screen.getByText("820")); await fireEvent.press(screen.getByLabelText("利用明細を表示"));
  await screen.rerender(<LearningUsageOverview request={request} usage={null} refreshKey={1} outputLimitEnforced={false} />);
  await waitFor(() => screen.getByText("明細の更新に失敗しました")); expect(screen.getByRole("alert")).toHaveTextContent("明細の更新に失敗しました");
  await fireEvent.press(screen.getByLabelText("利用明細を再読み込み")); await waitFor(() => screen.getByText(/UTC · 結果未確認/));
  await fireEvent.press(screen.getByLabelText("AI利用明細を閉じる")); await fireEvent.press(screen.getByLabelText("利用明細を表示")); expect(request).toHaveBeenCalledTimes(3); await screen.unmount();
});

test("open evaluation day and all-period details keep the displayed range across midnight", async () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 21, 23, 59).getTime());
  const record = { ...evaluations(1)[0], goal: "最古日の作業", at: new Date(2026, 9, 15, 12).toISOString() };
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningEvaluationOverview evaluations={[record]} busy={false} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(/10\/15: 1件/)); expect(screen.getByText("2026/10/15 · 1件")).toBeTruthy();
  now.mockReturnValue(new Date(2026, 9, 22, 12).getTime()); await screen.rerender(<LearningEvaluationOverview evaluations={[record]} busy={false} manage={manage} />);
  expect(screen.getByText("2026/10/15 · 1件")).toBeTruthy(); expect(screen.getByText("最古日の作業")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("会話のふりかえりを閉じる"));
  now.mockReturnValue(new Date(2026, 9, 21, 12).getTime()); await screen.rerender(<LearningEvaluationOverview evaluations={[record]} busy={false} manage={manage} />);
  await fireEvent.press(screen.getByLabelText("評価の一覧を表示")); now.mockReturnValue(new Date(2026, 9, 22, 12).getTime());
  await screen.rerender(<LearningEvaluationOverview evaluations={[record]} busy={false} manage={manage} />); expect(screen.getByText("10/15 – 10/21 · 1件")).toBeTruthy(); expect(screen.getByText("最古日の作業")).toBeTruthy(); await screen.unmount();
});
test("open usage details keep their requested UTC window across midnight and oldest-week Monday rollover", async () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T23:59:00Z"));
  const history = usageHistory(); history.calls[0].startedAt = "2026-10-15T12:00:00Z";
  history.days["2026-10-15"] = { buckets: { partial: history.days["2026-10-21"].buckets.partial } }; delete history.days["2026-10-21"].buckets.partial;
  const request = jest.fn(async () => history as unknown as Record<string, unknown>);
  const screen = await render(<LearningUsageOverview request={request} usage={null} refreshKey={0} outputLimitEnforced={false} />); await waitFor(() => screen.getByText("820"));
  await fireEvent.press(screen.getByLabelText(/10\/15: 取得済み 100/)); now.mockReturnValue(Date.parse("2026-10-22T00:01:00Z"));
  await screen.rerender(<LearningUsageOverview request={request} usage={null} refreshKey={0} outputLimitEnforced={false} />);
  expect(screen.getByText("2026/10/15 · UTC · 1回")).toBeTruthy(); expect(screen.getByText("入力 100 · 出力 未取得 tokens")).toBeTruthy(); expect(request).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByLabelText("AI利用明細を閉じる")); await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  now.mockReturnValue(Date.parse("2026-10-25T12:00:00Z")); await fireEvent.press(screen.getByLabelText("週別")); await waitFor(() => screen.getByLabelText(/9\/14: トークン未取得/));
  await fireEvent.press(screen.getByLabelText(/9\/14: トークン未取得/)); const callsBeforeRollover = request.mock.calls.length;
  now.mockReturnValue(Date.parse("2026-10-26T00:01:00Z")); await screen.rerender(<LearningUsageOverview request={request} usage={null} refreshKey={0} outputLimitEnforced={false} />);
  expect(screen.getByText("2026/9/14 – 9/20 · UTC · 0回")).toBeTruthy(); expect(request).toHaveBeenCalledTimes(callsBeforeRollover); await screen.unmount();
});
