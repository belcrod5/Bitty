jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
import { Alert } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { LearningEvaluationCard, type LearningEvaluation } from "./LearningEvaluationCard";

const evaluation = (): LearningEvaluation => ({ id: "evaluation-1", version: 1, goal: "報告を短くする", score: 100,
  reason: "明示的に了承された", unknowns: "事実精度は未確認", at: "2026-10-20T12:00:00Z",
  period: { from: "2026-10-20T11:00:00Z", until: "2026-10-20T12:00:00Z" }, scope: { orchestratorId: "main" }, corrections: [] });
const correction = (id: string, extra = {}) => ({ id, score: null, reason: "", at: "2026-10-20T12:00:00Z", ...extra });

test("compact card hides rationale/history; editing is local and unchanged save is disabled", async () => {
  const value = evaluation(); value.corrections = [correction("old")];
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningEvaluationCard evaluation={value} busy={false} manage={manage} />);
  expect(screen.getByText("100 / 100")).toBeTruthy(); expect(screen.getByText("未設定")).toBeTruthy();
  expect(screen.queryByText(value.reason)).toBeNull(); expect(screen.queryByText("未評価 · 次回分析待ち")).toBeNull();
  await fireEvent.press(screen.getByLabelText("評価を変更"));
  expect(screen.getByLabelText("訂正点数: 報告を短くする").props.value).toBe("100");
  expect(screen.getByLabelText("評価を保存")).toBeDisabled(); expect(manage).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("キャンセル"));
  expect(screen.queryByLabelText("評価を保存")).toBeNull(); expect(manage).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("評価の根拠")); expect(screen.getByText(value.reason)).toBeTruthy();
  await screen.unmount();
});

test.each(["0", "100"])("valid score %s saves once and closes after success", async (score) => {
  const value = evaluation(); value.score = 50;
  let resolve: (value: null) => void = () => {};
  const manage = jest.fn(() => new Promise<null>((done) => { resolve = done; }));
  const screen = await render(<LearningEvaluationCard evaluation={value} busy={false} manage={manage} />);
  await fireEvent.press(screen.getByLabelText("評価を変更"));
  await fireEvent.changeText(screen.getByLabelText("訂正点数: 報告を短くする"), score);
  await fireEvent.press(screen.getByLabelText("評価を保存"));
  await fireEvent.press(screen.getByLabelText("評価を保存"));
  expect(manage).toHaveBeenCalledTimes(1);
  expect(manage).toHaveBeenCalledWith("correct", { evaluationId: value.id, version: 1, score: Number(score), reason: "" }, false);
  expect(screen.getByLabelText("評価を保存")).toBeTruthy();
  await act(async () => { resolve(null); }); await waitFor(() => expect(screen.queryByLabelText("評価を保存")).toBeNull());
  await screen.unmount();
});

test("empty and invalid inputs cannot save; reason-only is supported and failed draft stays", async () => {
  const manage = jest.fn(async () => "接続エラー");
  const screen = await render(<LearningEvaluationCard evaluation={evaluation()} busy={false} manage={manage} />);
  await fireEvent.press(screen.getByLabelText("評価を変更"));
  for (const score of ["", "101", "-1", "1.5", "NaN"]) {
    await fireEvent.changeText(screen.getByLabelText("訂正点数: 報告を短くする"), score);
    expect(screen.getByLabelText("評価を保存")).toBeDisabled();
  }
  await fireEvent.changeText(screen.getByLabelText("訂正点数: 報告を短くする"), "");
  await fireEvent.changeText(screen.getByLabelText("訂正理由: 報告を短くする"), "  説明が長すぎた  ");
  await fireEvent.press(screen.getByLabelText("評価を保存"));
  await waitFor(() => screen.getByRole("alert"));
  expect(screen.getByRole("alert")).toHaveTextContent("接続エラー");
  expect(screen.getByLabelText("訂正理由: 報告を短くする").props.value).toBe("  説明が長すぎた  ");
  expect(manage).toHaveBeenCalledWith("correct", { evaluationId: "evaluation-1", version: 1, score: null, reason: "説明が長すぎた" }, false);
  await screen.unmount();
});

test("latest uncancelled meaningful correction prefills editor while original AI score stays", async () => {
  const value = evaluation(); value.corrections = [correction("first", { score: 40, reason: "長い" }),
    correction("blank"), correction("cancelled", { score: 70, cancelledAt: value.at })];
  const screen = await render(<LearningEvaluationCard evaluation={value} busy={false} manage={jest.fn(async () => null)} />);
  expect(screen.getByText("100 / 100")).toBeTruthy(); expect(screen.getByText("40 / 100")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("評価を変更"));
  expect(screen.getByLabelText("訂正点数: 報告を短くする").props.value).toBe("40");
  expect(screen.getByLabelText("訂正理由: 報告を短くする").props.value).toBe("長い");
  expect(screen.getByLabelText("評価を保存")).toBeDisabled(); await screen.unmount();
});

test("three accidental corrections can be cancelled together only after confirmation; history is retained", async () => {
  const value = evaluation(); value.corrections = [correction("a"), correction("b"), correction("c"),
    correction("done", { score: 55, resolution: { reason: "確認済み", itemId: null } }),
    correction("gone", { cancelledAt: value.at })];
  const manage = jest.fn(async () => null); const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<LearningEvaluationCard evaluation={value} busy={false} manage={manage} />);
  await fireEvent.press(screen.getByLabelText("訂正履歴 · 5"));
  expect(screen.getByText("未評価 · 取消済み")).toBeTruthy(); expect(screen.getByText("55 / 100 · 反映済み")).toBeTruthy();
  expect(screen.queryByLabelText("訂正を取り消す: done")).toBeNull(); expect(screen.queryByLabelText("訂正を取り消す: gone")).toBeNull();
  await fireEvent.press(screen.getByLabelText("訂正3件をまとめて取消"));
  expect(manage).not.toHaveBeenCalled();
  await act(async () => { alert.mock.calls[0][2]?.find((entry) => entry.style === "destructive")?.onPress?.(); });
  await waitFor(() => expect(manage).toHaveBeenCalledWith("correction.cancel", { evaluationId: value.id, version: 1, correctionIds: ["a", "b", "c"] }, false));
  await fireEvent.press(screen.getByLabelText("訂正を取り消す: b"));
  await act(async () => { alert.mock.calls[1][2]?.find((entry) => entry.style === "destructive")?.onPress?.(); });
  expect(manage).toHaveBeenLastCalledWith("correction.cancel", { evaluationId: value.id, version: 1, correctionIds: ["b"] }, false);
  alert.mockRestore(); await screen.unmount();
});

test("bulk cancellation respects the service's 100 correction limit", async () => {
  const value = evaluation(); value.corrections = Array.from({ length: 101 }, (_, index) => correction(`id-${index}`));
  const manage = jest.fn(async () => null); const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<LearningEvaluationCard evaluation={value} busy={false} manage={manage} />);
  await fireEvent.press(screen.getByLabelText("訂正履歴 · 101"));
  expect(screen.getAllByText("未評価 · 入力なし・学習対象外")).toHaveLength(101);
  await fireEvent.press(screen.getByLabelText("訂正100件をまとめて取消"));
  await act(async () => { alert.mock.calls[0][2]?.find((entry) => entry.style === "destructive")?.onPress?.(); });
  expect(manage).toHaveBeenCalledWith("correction.cancel", { evaluationId: value.id, version: 1,
    correctionIds: value.corrections.slice(0, 100).map((item) => item.id) }, false);
  alert.mockRestore(); await screen.unmount();
});

test("three resolved empty corrections without linked learning remain individually and collectively cancellable", async () => {
  const value = evaluation(); value.corrections = ["a", "b", "c"].map((id) => correction(id, {
    resolution: { reason: "No meaningful input", itemId: null },
  }));
  value.corrections.push(correction("protected", { resolution: { reason: "Created learning", itemId: "learning-1" } }));
  value.corrections.push(correction("unknown", { resolution: { reason: "Unknown outcome" } }));
  const manage = jest.fn(async () => null); const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<LearningEvaluationCard evaluation={value} busy={false} manage={manage} />);
  await fireEvent.press(screen.getByLabelText("訂正履歴 · 5"));
  expect(screen.getAllByText("未評価 · 入力なし・学習対象外")).toHaveLength(3);
  expect(screen.queryByLabelText("訂正を取り消す: protected")).toBeNull();
  expect(screen.queryByLabelText("訂正を取り消す: unknown")).toBeNull();
  await fireEvent.press(screen.getByLabelText("訂正を取り消す: a"));
  await act(async () => { alert.mock.calls[0][2]?.find((entry) => entry.style === "destructive")?.onPress?.(); });
  expect(manage).toHaveBeenLastCalledWith("correction.cancel", { evaluationId: value.id, version: 1, correctionIds: ["a"] }, false);
  await fireEvent.press(screen.getByLabelText("訂正3件をまとめて取消"));
  await act(async () => { alert.mock.calls[1][2]?.find((entry) => entry.style === "destructive")?.onPress?.(); });
  expect(manage).toHaveBeenLastCalledWith("correction.cancel", { evaluationId: value.id, version: 1, correctionIds: ["a", "b", "c"] }, false);
  alert.mockRestore(); await screen.unmount();
});
