import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { AnswerLearningDetails } from "./AnswerLearningDetails";
import { VisualThemeProvider } from "../theme/VisualThemeContext";
import { VISUAL_THEMES } from "../theme/visualThemes";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
const mockRequest = jest.fn();
const mockManager = { request: mockRequest };
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({ useRunnerWebSocketManager: () => mockManager }));
afterEach(() => mockRequest.mockReset());
const props = { orchestratorId: "main", operationId: "op-1" };
const empty = { items: [], reads: [], inheritedReads: [], readsVerified: true };
const detailsButton = (screen: Awaited<ReturnType<typeof render>>) => screen.getByRole("button", { name: /^回答の学習・参照詳細/ });
const response = (delivery: unknown) => ({ payload: { delivery } });
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("fetches metadata once before expansion, counts unique versions, and keeps reference categories distinct", async () => {
  const shared = { id: "one", version: 2, name: "短い報告" };
  mockRequest.mockResolvedValue(response({ ...empty, items: [shared],
    reads: [shared, { id: "two", version: 3, name: "確認手順", hash: "secret-hash" }],
    inheritedReads: [{ id: "two", version: 2, name: "以前の確認手順" }] }));
  const screen = await render(<AnswerLearningDetails {...props} />);
  await waitFor(() => expect(screen.getByTestId("answer-learning-count")).toHaveTextContent("3"));
  expect(screen.queryByText("学習コンテキスト")).toBeNull();
  expect(detailsButton(screen).props.accessibilityState).toMatchObject({ expanded: false });
  await fireEvent.press(detailsButton(screen));
  expect(detailsButton(screen).props.accessibilityState).toMatchObject({ expanded: true });
  expect(screen.getByText("モデルへ渡した学習")).toBeTruthy();
  expect(screen.getByText("この回答で読んだスキル")).toBeTruthy();
  expect(screen.getByText("以前の回答から継承")).toBeTruthy();
  expect(screen.getByText("確認手順")).toBeTruthy();
  expect(screen.queryByText(/secret-hash/)).toBeNull();
  await fireEvent.press(detailsButton(screen));
  await fireEvent.press(detailsButton(screen));
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.learning.delivery", payload: props });
});

test("verified empty records have no numeric badge and explicitly show no references", async () => {
  mockRequest.mockResolvedValue(response(empty));
  const screen = await render(<AnswerLearningDetails {...props} />);
  await waitFor(() => screen.getByLabelText("回答の学習・参照詳細、参照なし"));
  expect(screen.queryByTestId("answer-learning-count")).toBeNull();
  await fireEvent.press(detailsButton(screen));
  expect(screen.getByText("0件の知識・スキル · 重複を除く")).toBeTruthy();
  expect(screen.getAllByText("なし")).toHaveLength(3);
});

test.each([null, undefined])("missing record (%s) is unknown rather than a verified zero", async (delivery) => {
  mockRequest.mockResolvedValue(response(delivery));
  const screen = await render(<AnswerLearningDetails {...props} />);
  await waitFor(() => screen.getByLabelText("回答の学習・参照詳細、記録未確認"));
  expect(screen.queryByTestId("answer-learning-count")).toBeNull();
  expect(screen.getByText("?")).toBeTruthy();
  await fireEvent.press(detailsButton(screen));
  expect(screen.getByText("参照記録は未確認です。保持期間外・忘却後の回答も含みます。")).toBeTruthy();
});

test.each([0, 1])("incomplete read evidence preserves uncertainty with %i known items", async (count) => {
  mockRequest.mockResolvedValue(response({ ...empty, readsVerified: false,
    items: count ? [{ id: "one", version: 1 }] : [] }));
  const screen = await render(<AnswerLearningDetails {...props} />);
  await waitFor(() => screen.getByLabelText(/一部記録未確認/));
  if (count) expect(screen.getByTestId("answer-learning-count")).toHaveTextContent("1+");
  else expect(screen.queryByTestId("answer-learning-count")).toBeNull();
  await fireEvent.press(detailsButton(screen));
  expect(screen.getByText("スキル読取（記録未確認）")).toBeTruthy();
  expect(screen.getByText("未確認")).toBeTruthy();
  if (count) expect(screen.getByText("名称未記録の学習")).toBeTruthy();
});

test("loading can expand without sending a second request", async () => {
  const pending = deferred();
  mockRequest.mockReturnValue(pending.promise);
  const screen = await render(<AnswerLearningDetails {...props} />);
  expect(detailsButton(screen).props.accessibilityState).toMatchObject({ busy: true });
  await fireEvent.press(detailsButton(screen));
  expect(screen.getByText("参照記録を確認中…")).toBeTruthy();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(response(empty)); });
  expect(screen.getByText("0件の知識・スキル · 重複を除く")).toBeTruthy();
});

test.each(["network", "invalid"])("failed %s request can retry while keeping the card expanded", async (failure) => {
  if (failure === "network") mockRequest.mockRejectedValueOnce(new Error("offline"));
  else mockRequest.mockResolvedValueOnce(response({ items: null, reads: [], inheritedReads: [] }));
  mockRequest.mockResolvedValueOnce(response(empty));
  const screen = await render(<AnswerLearningDetails {...props} />);
  await waitFor(() => screen.getByLabelText("回答の学習・参照詳細、記録未確認"));
  await fireEvent.press(detailsButton(screen));
  expect(screen.getByText("参照記録を取得できませんでした。")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("参照記録を再読み込み"));
  await waitFor(() => screen.getByText("0件の知識・スキル · 重複を除く"));
  expect(detailsButton(screen).props.accessibilityState).toMatchObject({ expanded: true });
  expect(mockRequest).toHaveBeenCalledTimes(2);
});

test("hidden or paused history makes no request, drops in-flight results, and reloads on resume", async () => {
  const pending = deferred();
  mockRequest.mockReturnValueOnce(pending.promise).mockResolvedValue(response(empty));
  const screen = await render(<AnswerLearningDetails {...props} paused />);
  expect(mockRequest).not.toHaveBeenCalled();
  expect(detailsButton(screen)).toBeDisabled();
  await screen.rerender(<AnswerLearningDetails {...props} />);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  await fireEvent.press(detailsButton(screen));
  await screen.rerender(<AnswerLearningDetails {...props} paused />);
  await act(async () => { pending.resolve(response({ ...empty, items: [{ id: "stale", version: 1, name: "古い参照" }] })); });
  expect(screen.queryByTestId("answer-learning-count")).toBeNull();
  expect(screen.queryByText("学習コンテキスト")).toBeNull();
  await screen.rerender(<AnswerLearningDetails {...props} />);
  await waitFor(() => screen.getByLabelText("回答の学習・参照詳細、参照なし"));
  expect(mockRequest).toHaveBeenCalledTimes(2);
});

test.each(["operationId", "orchestratorId"] as const)("changing %s clears old data and ignores a late response", async (field) => {
  const old = deferred();
  mockRequest.mockReturnValueOnce(old.promise).mockResolvedValue(response(empty));
  const screen = await render(<AnswerLearningDetails {...props} />);
  await fireEvent.press(detailsButton(screen));
  await screen.rerender(<AnswerLearningDetails {...{ ...props, [field]: "new" }} />);
  await waitFor(() => screen.getByLabelText("回答の学習・参照詳細、参照なし"));
  await act(async () => { old.resolve(response({ ...empty, items: [{ id: "stale", version: 1 }] })); });
  expect(screen.queryByTestId("answer-learning-count")).toBeNull();
  expect(detailsButton(screen).props.accessibilityState).toMatchObject({ expanded: false });
});

test.each(["standard", "cyberpunk"] as const)("expanded card uses %s theme colors and accessible touch targets", async (themeId) => {
  mockRequest.mockResolvedValue(response(empty));
  const screen = await render(<VisualThemeProvider themeId={themeId} onSelectTheme={() => undefined}>
    <AnswerLearningDetails {...props} />
  </VisualThemeProvider>);
  await waitFor(() => screen.getByLabelText("回答の学習・参照詳細、参照なし"));
  expect(detailsButton(screen)).toHaveStyle({ minHeight: 44, minWidth: 64 });
  expect(detailsButton(screen)).not.toHaveStyle({ borderWidth: 1 });
  expect(StyleSheet.flatten(detailsButton(screen).props.style).backgroundColor).toBeUndefined();
  await fireEvent.press(detailsButton(screen));
  const header = screen.getByText("学習コンテキスト");
  expect(header).toHaveStyle({ color: VISUAL_THEMES[themeId].tones.info.foreground });
  expect(detailsButton(screen)).not.toHaveStyle({ borderWidth: 1 });
  expect(StyleSheet.flatten(detailsButton(screen).props.style).backgroundColor).toBeUndefined();
  expect(screen.getByText("学習コンテキスト").parent?.parent?.parent)
    .toHaveStyle({ backgroundColor: VISUAL_THEMES[themeId].tones.info.background });
});
