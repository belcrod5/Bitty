import { fireEvent, render, userEvent } from "@testing-library/react-native";
import { ChatContextUsageMenu } from "./ChatContextUsageMenu";

function renderMenu(contextPctText: string, onStartNewSession = jest.fn()) {
  return render(
    <ChatContextUsageMenu
      contextPctText={contextPctText}
      directoryPath="/workspace"
      progress={0}
      progressColor="#0284c7"
      trackColor="#dbeafe"
      onStartNewSession={onStartNewSession}
    />
  );
}

describe("ChatContextUsageMenu", () => {
  it("shows the placeholder as-is while context usage is not fetched yet", async () => {
    const { getByText, queryByText } = await renderMenu("--");

    expect(getByText("--")).toBeTruthy();
    expect(queryByText("--%")).toBeNull();
  });

  it("shows a fetched context usage percentage", async () => {
    const { getByText } = await renderMenu("42%");

    expect(getByText("42%")).toBeTruthy();
  });

  it("starts a new chat from the context-usage long-press action", async () => {
    const onStartNewSession = jest.fn();
    const menu = await renderMenu("42%", onStartNewSession);
    const user = userEvent.setup();

    await user.longPress(menu.getByLabelText("コンテキスト使用量 42%"));
    await fireEvent.press(menu.getByText("同じディレクトリーで新規セッション"));

    expect(onStartNewSession).toHaveBeenCalledTimes(1);
  });
});
