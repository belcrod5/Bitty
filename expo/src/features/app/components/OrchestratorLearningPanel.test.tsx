jest.mock("../keyboardController", () => ({ KeyboardAwareScrollView: require("react-native").ScrollView, KeyboardAvoidingView: require("react-native").KeyboardAvoidingView }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
import { Alert } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { LearningKnowledge } from "./LearningKnowledgeCard";
import { OrchestratorLearningPanel } from "./OrchestratorLearningPanel";

jest.mock("./SettingsSelect", () => ({
  SettingsSelect: ({ label, onSelect, options, selectedValue }: { label: string;
    onSelect: (value: string) => void; selectedValue: string; options: { value: string }[] }) => {
    const ReactModule = require("react");
    const { Pressable, Text } = require("react-native");
    return ReactModule.createElement(Pressable, { testID: `select-${label}`,
      accessibilityValue: { text: selectedValue },
      onLongPress: () => onSelect(options[0]?.value || ""),
      onPress: () => onSelect(options[options.length - 1]?.value || "") },
    ReactModule.createElement(Text, null, label));
  },
}));

beforeEach(() => { jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00Z")); });
afterEach(() => { jest.restoreAllMocks(); });

const models = [
  { modelId: "model-a", label: "Model A", effortOptions: ["low"] },
  { modelId: "model-b", label: "Model B", effortOptions: ["medium", "high"] },
];
const initialStatus = () => ({
  settings: { model: "", effort: "", settingsRevision: 4 }, status: "unconfigured", enabled: false,
  observedThrough: 10, processedThrough: 8, pendingCount: 2,
  candidates: [{ id: "candidate-1", version: 1, status: "candidate", kind: "preference", content: "報告を短くする",
    conditions: "作業完了の報告", reason: "短い報告を明示的に希望",
    scope: { orchestratorId: "main" }, evidence: [{ pairSeq: 8 }] }] as LearningKnowledge[],
  gaps: [{ from: 1, through: 2, reason: "ログ保持期間外" }], error: null,
  outputLimitEnforced: false,
  usage: { blockedReason: null,
    budget: { day: "2026-10-20", calls: 1, maxCalls: 12, maxTokens: 100000, tokens: 5000 },
    today: { measuredCalls: 0, partialCalls: 0, missingCalls: 1, unpricedCalls: 1,
      inputTokens: null as number | null, outputTokens: null as number | null,
      reservationChargedTokens: 5000, anonymousCalls: 0,
      estimatedCosts: [] as { currency: string; amount: number }[] }, priceSnapshot: null,
  },
});
const orchestrators = [{ id: "main", name: "メイン", icon: "" }];

function mockApi(status = initialStatus()) {
  return jest.fn(async (op: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (op === "voice.settings") return { models };
    if (op === "voice.learning.usage") return { calls: [], days: {}, retention: { createdAt: null }, aggregateGranularity: "UTC-day" };
    if (op === "voice.learning.status") return status;
    if (op === "voice.learning.configure") return { ...status,
      settings: { model: payload?.model, effort: payload?.effort, settingsRevision: 5 } };
    throw new Error(`unexpected ${op}`);
  });
}

test("shows observed candidates, evidence, excluded input and missing usage without inventing zero", async () => {
  const request = mockApi();
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByText("報告を短くする"));
  expect(screen.getByText("学習・評価用モデルは全オーケストレータ共通")).toBeTruthy();
  expect(screen.queryByText("根拠：1件のやりとり")).toBeNull();
  await fireEvent.press(screen.getByLabelText("詳細・管理: 報告を短くする"));
  expect(screen.getByText("根拠：1件のやりとり")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("データの管理・診断"));
  expect(screen.getByText("#1〜2: ログ保持期間外")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("今日の予算と計測の詳細"));
  expect(screen.getByTestId("learning-input-tokens")).toHaveTextContent("取得済み入力: 未取得");
  expect(screen.getByText("料金算定不能（単価未設定）")).toBeTruthy();
  expect(screen.getByTestId("select-学習・評価用モデル").props.accessibilityValue.text).toBe("");
  expect(screen.getByTestId("learning-settings-save")).toBeDisabled();
  expect(request).not.toHaveBeenCalledWith("voice.learning.configure", expect.anything());
  await screen.unmount();
});

test("saves independent shared model and effort with the settings revision", async () => {
  const request = mockApi();
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByText("報告を短くする"));
  await fireEvent.press(screen.getByTestId("select-学習・評価用モデル"));
  await fireEvent.press(screen.getByTestId("select-学習・評価用エフォート"));
  await fireEvent.press(screen.getByTestId("learning-settings-save"));
  await waitFor(() => expect(request).toHaveBeenCalledWith("voice.learning.configure", {
    model: "model-b", effort: "high", settingsRevision: 4,
  }));
  expect(screen.getByText("設定を保存しました。")).toBeTruthy();
  await screen.unmount();
});

test("unavailable stored model remains visible and cannot silently fall back", async () => {
  const status = initialStatus();
  status.settings = { model: "retired-model", effort: "high", settingsRevision: 4 };
  const request = mockApi(status);
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByText("選択中のモデル・エフォートは現在利用できません。別の設定を選んでください。"));
  expect(screen.getByTestId("select-学習・評価用モデル").props.accessibilityValue.text).toBe("retired-model");
  expect(screen.getByTestId("learning-settings-save")).toBeDisabled();
  await screen.unmount();
});

test("failed configuration stays unsaved and the user can refresh a conflicting revision", async () => {
  const request = mockApi();
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByText("報告を短くする"));
  await fireEvent.press(screen.getByTestId("select-学習・評価用モデル"));
  request.mockRejectedValueOnce(new Error("設定が更新されています。再読み込みしてください。"));
  await fireEvent.press(screen.getByTestId("learning-settings-save"));
  await waitFor(() => screen.getByText("設定が更新されています。再読み込みしてください。"));
  expect(screen.queryByText("設定を保存しました。")).toBeNull();
  await fireEvent.press(screen.getByTestId("learning-status-refresh"));
  await waitFor(() => expect(screen.queryByText("設定が更新されています。再読み込みしてください。")).toBeNull());
  expect(screen.getByTestId("select-学習・評価用モデル").props.accessibilityValue.text).toBe("");
  await screen.unmount();
});

test("a failed load is reported and can be retried", async () => {
  const request = mockApi();
  request.mockRejectedValueOnce(new Error("接続を確認してください"));
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByText("接続を確認してください"));
  await fireEvent.press(screen.getByTestId("learning-status-refresh"));
  await waitFor(() => screen.getByText("報告を短くする"));
  await screen.unmount();
});


test("partial measurements and estimated costs stay separate by currency", async () => {
  const status = initialStatus();
  status.usage.today = { ...status.usage.today, partialCalls: 1, missingCalls: 0,
    inputTokens: 0, outputTokens: 120,
    estimatedCosts: [{ currency: "USD", amount: 0.01 }, { currency: "JPY", amount: 2 }] };
  const screen = await render(<OrchestratorLearningPanel request={mockApi(status)} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByLabelText("今日の予算と計測の詳細"));
  await fireEvent.press(screen.getByLabelText("今日の予算と計測の詳細"));
  await waitFor(() => screen.getByText("取得済み入力: 0 tokens"));
  expect(screen.getByText("実測 0 · 一部取得 1 · 欠測 0 回")).toBeTruthy();
  expect(screen.getByText("算定料金（算定できた分）: 0.01 USD")).toBeTruthy();
  expect(screen.getByText("算定料金（算定できた分）: 2 JPY")).toBeTruthy();
  expect(screen.getByText("料金を算定できない呼び出し: 1 回")).toBeTruthy();
  await screen.unmount();
});

test("clearing the selected model stops analysis without silently selecting a replacement", async () => {
  const status = initialStatus();
  status.settings = { model: "model-b", effort: "high", settingsRevision: 4 };
  status.enabled = true;
  const request = mockApi(status);
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByText("報告を短くする"));
  await fireEvent(screen.getByTestId("select-学習・評価用モデル"), "longPress");
  expect(screen.getByTestId("select-学習・評価用モデル").props.accessibilityValue.text).toBe("");
  expect(screen.getByTestId("select-学習・評価用エフォート").props.accessibilityValue.text).toBe("");
  await fireEvent.press(screen.getByTestId("learning-settings-save"));
  await waitFor(() => expect(request).toHaveBeenCalledWith("voice.learning.configure", {
    model: "", effort: "", settingsRevision: 4,
  }));
  expect(screen.getByTestId("select-学習・評価用モデル").props.accessibilityValue.text).toBe("");
  await screen.unmount();
});

test("a failed model catalog preserves status and lets the user stop analysis", async () => {
  const status = initialStatus();
  status.settings = { model: "model-b", effort: "high", settingsRevision: 4 };
  status.status = "observing"; status.enabled = true;
  const api = mockApi(status);
  const request = jest.fn(async (op: string, payload?: Record<string, unknown>) => {
    if (op === "voice.settings") throw new Error("catalog unavailable");
    return api(op, payload);
  });
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByText("モデル一覧を取得できません。"));
  expect(screen.getByText("会話を学習中")).toBeTruthy();
  expect(screen.getByText("報告を短くする")).toBeTruthy();
  expect(screen.getByTestId("select-学習・評価用モデル").props.accessibilityValue.text).toBe("model-b");
  expect(screen.getByTestId("learning-settings-save")).toBeDisabled();
  await fireEvent(screen.getByTestId("select-学習・評価用モデル"), "longPress");
  await fireEvent.press(screen.getByTestId("learning-settings-save"));
  await waitFor(() => expect(request).toHaveBeenCalledWith("voice.learning.configure", {
    model: "", effort: "", settingsRevision: 4,
  }));
  expect(screen.getByText("設定を保存しました。")).toBeTruthy();
  expect(screen.getByText("モデル一覧を取得できません。")).toBeTruthy();
  await screen.unmount();
});

test("persisted learning errors remain visible when usage cannot be loaded", async () => {
  const request = jest.fn(async (op: string): Promise<Record<string, unknown>> => op === "voice.settings"
    ? { models } : { ...initialStatus(), status: "paused", usage: null,
      error: { code: "learning_state_invalid", message: "学習データを読み込めません。" } });
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByText("学習データを読み込めません。"));
  expect(screen.getByText("利用量を取得できません。")).toBeTruthy();
  expect(screen.queryByText("呼び出し 0 / 12 回")).toBeNull();
  await screen.unmount();
});

test("bulk adoption sends exact item versions and failures keep decisions unsaved", async () => {
  const status = initialStatus();
  const request = jest.fn(async (op: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (op === "voice.settings") return { models };
    if (op === "voice.learning.usage") return { calls: [], days: {}, retention: { createdAt: null }, aggregateGranularity: "UTC-day" };
    if (op === "voice.learning.status") return status;
    if (op === "voice.learning.decide") throw new Error("版が変更されています");
    throw new Error(`unexpected ${op}`);
  });
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByLabelText("まとめて操作"));
  await fireEvent.press(screen.getByLabelText("まとめて操作"));
  await fireEvent.press(screen.getByLabelText("一括操作の対象に選択: 報告を短くする"));
  await fireEvent.press(screen.getByLabelText("選んだ候補を採用"));
  await waitFor(() => expect(screen.getByText("版が変更されています")).toBeTruthy());
  expect(request).toHaveBeenCalledWith("voice.learning.decide", { items: [{ id: "candidate-1", version: 1 }], action: "adopt" });
  expect(screen.getByLabelText("一括操作の対象に選択: 報告を短くする").props.accessibilityState.checked).toBe(true);
  await screen.unmount();
});

test("provisional score and user corrections are distinct; an empty optional reason is saved", async () => {
  const status = { ...initialStatus(), evaluations: [{ id: "evaluation-1", version: 1, goal: "短い報告", score: null,
    reason: "確認不足", unknowns: "満足は未確認", at: "2026-10-20T12:00:00Z", period: { from: null, until: null },
    scope: { orchestratorId: "main" }, corrections: [] }] };
  const request = jest.fn(async (op: string): Promise<Record<string, unknown>> => op === "voice.settings" ? { models } : status);
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByLabelText("評価の一覧を表示"));
  await fireEvent.press(screen.getByLabelText("評価の一覧を表示"));
  await waitFor(() => expect(screen.getByText("短い報告")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("評価を変更"));
  await fireEvent.changeText(screen.getByLabelText("訂正点数: 短い報告"), "55");
  await fireEvent.press(screen.getByLabelText("評価を保存"));
  await waitFor(() => expect(request).toHaveBeenCalledWith("voice.learning.correct", { evaluationId: "evaluation-1", version: 1, score: 55, reason: "" }));
  await screen.unmount();
});

test("all-learning forgetting is available with no candidates and requires the explicit destructive confirmation", async () => {
  const status = { ...initialStatus(), candidates: [] };
  const request = jest.fn(async (op: string): Promise<Record<string, unknown>> => op === "voice.settings" ? { models } : status);
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByLabelText("データの管理・診断"));
  await fireEvent.press(screen.getByLabelText("データの管理・診断"));
  await waitFor(() => screen.getByLabelText("全学習を忘却"));
  await fireEvent.press(screen.getByLabelText("全学習を忘却"));
  expect(request).not.toHaveBeenCalledWith("voice.learning.forget", expect.anything());
  expect(alert).toHaveBeenCalled();
  await act(async () => { alert.mock.calls[0][2]?.find((entry) => entry.style === "destructive")?.onPress?.(); });
  await waitFor(() => expect(request).toHaveBeenCalledWith("voice.learning.forget", { all: true }));
  alert.mockRestore(); await screen.unmount();
});

test("exhausted analysis retry uses the exact batch and settings revision without resetting budget", async () => {
  const status = { ...initialStatus(), status: "retry_exhausted", settings: { model: "model-a", effort: "low", settingsRevision: 4 },
    retry: { batchId: "batch-exhausted", settingsRevision: 4, attempts: 3, ceiling: 3 } };
  const request = jest.fn(async (op: string): Promise<Record<string, unknown>> => op === "voice.settings" ? { models } : status);
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByLabelText("保留した分析を1回再試行"));
  await fireEvent.press(screen.getByLabelText("保留した分析を1回再試行"));
  await waitFor(() => expect(request).toHaveBeenCalledWith("voice.learning.retry", { batchId: "batch-exhausted", settingsRevision: 4 }));
  await screen.unmount();
});

test("default view has no bulk checkboxes or change form; selecting alone never writes", async () => {
  const request = mockApi();
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByText("報告を短くする"));
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByLabelText("学習の編集・統合・廃止の希望")).toBeNull();
  await fireEvent.press(screen.getByLabelText("まとめて操作"));
  await fireEvent.press(screen.getByRole("checkbox"));
  expect(screen.getByText("1件を選択")).toBeTruthy();
  expect(request.mock.calls.map(([op]) => op)).toEqual(["voice.learning.status", "voice.settings", "voice.learning.usage"]);
  await fireEvent.press(screen.getByLabelText("一括操作を終了"));
  expect(screen.queryByRole("checkbox")).toBeNull();
  await screen.unmount();
});

test.each([
  [6, false, false, true, false],
  [2, true, false, true, false],
  [51, false, false, false, false],
  [50, false, false, true, false],
  [5, false, false, true, true],
  [2, false, true, false, true],
  [2, false, false, true, true],
])("bulk contracts with %i items, mixed chats %s, active item %s", async (count, mixedChats, active, canDecide, canChange) => {
  const status = initialStatus(); const template = status.candidates[0];
  status.candidates = Array.from({ length: count }, (_, i) => ({ ...template, id: `item-${i}`, content: `方針${i}`,
    status: active && i === 0 ? "active" : "candidate", scope: { orchestratorId: mixedChats && i === 0 ? "other" : "main" } }));
  const request = mockApi(status);
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByLabelText("まとめて操作"));
  await fireEvent.press(screen.getByLabelText("まとめて操作"));
  for (let selectedCount = 0; selectedCount < count;) {
    for (const checkbox of screen.getAllByRole("checkbox")) { await fireEvent.press(checkbox); selectedCount += 1; }
    if (selectedCount < count) await fireEvent.press(screen.getByLabelText("学習の次のページ"));
  }
  expect(screen.getByText(`${count}件を選択`)).toBeTruthy();
  expect(screen.getByLabelText("選んだ候補を採用").props.accessibilityState.disabled).toBe(!canDecide);
  expect(screen.getByLabelText("選んだ候補を見送る").props.accessibilityState.disabled).toBe(!canDecide);
  expect(screen.getByLabelText("選んだ学習の修正案を依頼").props.accessibilityState.disabled).toBe(!canChange);
  expect(request.mock.calls).toHaveLength(3);
  await screen.unmount();
});

test("failed change request preserves selection and draft; success clears mode and exact versions are sent", async () => {
  const status = initialStatus();
  let fail = true;
  const request = jest.fn(async (op: string): Promise<Record<string, unknown>> => {
    if (op === "voice.settings") return { models };
    if (op === "voice.learning.usage") return { calls: [], days: {}, retention: { createdAt: null }, aggregateGranularity: "UTC-day" };
    if (op === "voice.learning.change" && fail) throw new Error("通信に失敗しました");
    return status;
  });
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByLabelText("まとめて操作"));
  await fireEvent.press(screen.getByLabelText("まとめて操作"));
  await fireEvent.press(screen.getByRole("checkbox"));
  await fireEvent.press(screen.getByLabelText("選んだ学習の修正案を依頼"));
  expect(screen.getByLabelText("修正案の作成を依頼")).toBeDisabled();
  await fireEvent.changeText(screen.getByLabelText("学習の編集・統合・廃止の希望"), "3行以内に変更");
  await fireEvent.press(screen.getByLabelText("修正案の作成を依頼"));
  await waitFor(() => screen.getByText("通信に失敗しました"));
  expect(screen.getByRole("checkbox").props.accessibilityState.checked).toBe(true);
  expect(screen.getByLabelText("学習の編集・統合・廃止の希望").props.value).toBe("3行以内に変更");
  expect(request).toHaveBeenCalledWith("voice.learning.change", { items: [{ id: "candidate-1", version: 1 }], instruction: "3行以内に変更" });
  fail = false;
  await fireEvent.press(screen.getByLabelText("修正案の作成を依頼"));
  await waitFor(() => expect(screen.queryByRole("checkbox")).toBeNull());
  expect(screen.queryByLabelText("学習の編集・統合・廃止の希望")).toBeNull();
  await screen.unmount();
});

test("refresh with removed items clears stale bulk selection and draft", async () => {
  const status = initialStatus(); const request = mockApi(status);
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await fireEvent.press(screen.getByLabelText("学習の設定"));
  await waitFor(() => screen.getByLabelText("まとめて操作"));
  await fireEvent.press(screen.getByLabelText("まとめて操作")); await fireEvent.press(screen.getByRole("checkbox"));
  await fireEvent.press(screen.getByLabelText("選んだ学習の修正案を依頼"));
  await fireEvent.changeText(screen.getByLabelText("学習の編集・統合・廃止の希望"), "まとめる");
  status.candidates = [];
  await fireEvent.press(screen.getByLabelText("学習状態を更新"));
  await waitFor(() => screen.getByText("学習はまだありません。"));
  expect(screen.queryByText("1件を選択")).toBeNull(); expect(screen.queryByLabelText("学習の編集・統合・廃止の希望")).toBeNull();
  await screen.unmount();
});

test("closing details while an evaluation save is pending keeps the parent write and its saved result", async () => {
  const evaluation = { id: "evaluation-pending", version: 1, goal: "短い報告", score: 90, reason: "簡潔な報告", unknowns: "", at: "2026-10-21T10:00:00Z", period: { from: null, until: null }, scope: { orchestratorId: "main" }, corrections: [] as { id: string; score: number; reason: string; at: string }[] };
  const status = { ...initialStatus(), evaluations: [evaluation] };
  let complete!: (value: Record<string, unknown>) => void;
  const pending = new Promise<Record<string, unknown>>((resolve) => { complete = resolve; });
  const request = jest.fn(async (op: string): Promise<Record<string, unknown>> => {
    if (op === "voice.settings") return { models };
    if (op === "voice.learning.usage") return { calls: [], days: {}, retention: { createdAt: null }, aggregateGranularity: "UTC-day" };
    if (op === "voice.learning.correct") return pending;
    return status;
  });
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await waitFor(() => screen.getByLabelText("評価の一覧を表示")); await fireEvent.press(screen.getByLabelText("評価の一覧を表示")); await fireEvent.press(screen.getByLabelText("評価を変更"));
  await fireEvent.changeText(screen.getByLabelText("訂正点数: 短い報告"), "55"); await fireEvent.press(screen.getByLabelText("評価を保存"));
  await waitFor(() => expect(request).toHaveBeenCalledWith("voice.learning.correct", { evaluationId: "evaluation-pending", version: 1, score: 55, reason: "" }));
  await fireEvent.press(screen.getByLabelText("会話のふりかえりを閉じる")); expect(screen.queryByText("短い報告")).toBeNull();
  await act(async () => { complete({ ...status, evaluations: [{ ...evaluation, corrections: [{ id: "correction-saved", score: 55, reason: "", at: "2026-10-21T12:00:00Z" }] }] }); await pending; });
  await fireEvent.press(screen.getByLabelText("評価の一覧を表示")); expect(screen.getByText("55 / 100")).toBeTruthy();
  expect(request.mock.calls.filter(([op]) => op === "voice.learning.correct")).toHaveLength(1); await screen.unmount();
});
