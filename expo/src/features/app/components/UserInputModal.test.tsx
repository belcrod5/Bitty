import { act, fireEvent, render } from "@testing-library/react-native";
import { UserInputModal } from "./UserInputModal";
import type { UserInputRequest } from "../../codex/userInput";

const request = (): UserInputRequest => ({
  requestId: "input-1", threadId: "thread-1", startedAtMs: Date.now() - 15_000,
  questions: [
    { id: "choice", header: "Choice", question: "Which?", isOther: true, isSecret: false,
      options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }] },
    { id: "secret", header: "Secret", question: "Password?", isOther: false, isSecret: true, options: null },
  ],
});

test("renders multiple questions, selectable options, and masked free text then submits their IDs", async () => {
  const onDecide = jest.fn();
  const view = await render(<UserInputModal request={request()} onDecide={onDecide} />);
  expect(view.getByText("質問 · 残り45秒")).toBeTruthy();
  const inputs = view.getAllByPlaceholderText("回答を入力");
  expect(inputs[1].props.secureTextEntry).toBe(true);
  await fireEvent.press(view.getByText("B"));
  await fireEvent.changeText(inputs[1], "private answer");
  await fireEvent.press(view.getByText("回答する"));
  expect(onDecide).toHaveBeenCalledWith({ answers: {
    choice: { answers: ["B"] }, secret: { answers: ["private answer"] },
  } });
});

test("skip sends empty answers; countdown expiry only hides UI without sending a timeout", async () => {
  jest.useFakeTimers();
  try {
    const onDecide = jest.fn();
    const view = await render(<UserInputModal request={request()} onDecide={onDecide} />);
    await fireEvent.press(view.getByText("見送る"));
    expect(onDecide).toHaveBeenCalledWith({ answers: {} });
    onDecide.mockClear();
    await act(async () => { jest.advanceTimersByTime(45_000); });
    expect(view.queryByText("Which?")).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
    await view.unmount();
  } finally { jest.useRealTimers(); }
});
