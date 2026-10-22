import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { AnswerLearningDetails } from "./AnswerLearningDetails";
const mockRequest = jest.fn();
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({ useRunnerWebSocketManager: () => ({ request: mockRequest }) }));
afterEach(() => mockRequest.mockReset());
test("loads only on demand and distinguishes delivered items, current reads and inherited reads", async () => {
  mockRequest.mockResolvedValue({ payload: { delivery: { contextRevision: 2, selectedDigest: "abcdef1234567890", readsVerified: true,
    items: [{ id: "one", version: 2, name: "短い報告" }], reads: [{ id: "two", version: 3, name: "確認手順", hash: "1234567890abcdef" }],
    inheritedReads: [{ id: "three", version: 1, name: "以前の参照" }] } } });
  const screen = await render(<AnswerLearningDetails orchestratorId="main" operationId="op-1" color="black" />);
  expect(mockRequest).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("回答の学習・参照詳細"));
  await waitFor(() => screen.getByText("モデルに渡した学習: 短い報告 v2"));
  expect(screen.getByText("このターンで参照した専用スキル: 確認手順 v3 (1234567890ab)")).toBeTruthy();
  expect(screen.getByText("親に残る参照: 以前の参照 v1")).toBeTruthy();
  expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.learning.delivery", payload: { orchestratorId: "main", operationId: "op-1" } });
});
test("missing delivery is unconfirmed instead of pretending no learning was used", async () => {
  mockRequest.mockResolvedValue({ payload: { delivery: null } });
  const screen = await render(<AnswerLearningDetails orchestratorId="main" operationId="old" color="black" />);
  await fireEvent.press(screen.getByLabelText("回答の学習・参照詳細"));
  await waitFor(() => screen.getByText("配送・参照記録は未確認です（保持期間外・忘却後を含む）。"));
});
