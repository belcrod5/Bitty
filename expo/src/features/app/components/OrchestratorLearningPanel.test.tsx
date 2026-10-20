import { fireEvent, render, waitFor } from "@testing-library/react-native";
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

const models = [
  { modelId: "model-a", label: "Model A", effortOptions: ["low"] },
  { modelId: "model-b", label: "Model B", effortOptions: ["medium", "high"] },
];
const initialStatus = () => ({
  settings: { model: "", effort: "", settingsRevision: 4 }, status: "unconfigured", enabled: false,
  observedThrough: 10, processedThrough: 8, pendingCount: 2,
  candidates: [{ id: "candidate-1", kind: "preference", content: "報告を短くする",
    conditions: "作業完了の報告", reason: "短い報告を明示的に希望",
    scope: { orchestratorId: "main" }, evidence: [{ pairSeq: 8 }] }],
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
    if (op === "voice.learning.status") return status;
    if (op === "voice.learning.configure") return { ...status,
      settings: { model: payload?.model, effort: payload?.effort, settingsRevision: 5 } };
    throw new Error(`unexpected ${op}`);
  });
}

test("shows observed candidates, evidence, excluded input and missing usage without inventing zero", async () => {
  const request = mockApi();
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
  await waitFor(() => screen.getByText("報告を短くする"));
  expect(screen.getByText("全オーケストレータ共通 · 観測のみ")).toBeTruthy();
  expect(screen.getByText("根拠: #8")).toBeTruthy();
  expect(screen.getByText("#1〜2: ログ保持期間外")).toBeTruthy();
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
  await waitFor(() => screen.getByText("選択中のモデル・エフォートは現在利用できません。別の設定を選んでください。"));
  expect(screen.getByTestId("select-学習・評価用モデル").props.accessibilityValue.text).toBe("retired-model");
  expect(screen.getByTestId("learning-settings-save")).toBeDisabled();
  await screen.unmount();
});

test("failed configuration stays unsaved and the user can refresh a conflicting revision", async () => {
  const request = mockApi();
  const screen = await render(<OrchestratorLearningPanel request={request} orchestrators={orchestrators} />);
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
  await waitFor(() => screen.getByText("モデル一覧を取得できません。"));
  expect(screen.getByText("会話を観測中")).toBeTruthy();
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
  await waitFor(() => screen.getByText("学習データを読み込めません。"));
  expect(screen.getByText("利用量を取得できません。")).toBeTruthy();
  expect(screen.queryByText("呼び出し 0 / 12 回")).toBeNull();
  await screen.unmount();
});
