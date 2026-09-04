import { fireEvent, render, userEvent, waitFor } from "@testing-library/react-native";
import { Platform, StyleSheet } from "react-native";
import { CHAT_CONTENT_MAX_WIDTH } from "../styles/layoutConstants";
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

const platformOSDescriptor = Object.getOwnPropertyDescriptor(Platform, "OS");

afterEach(() => {
  if (platformOSDescriptor) Object.defineProperty(Platform, "OS", platformOSDescriptor);
});

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

  it("constrains the macOS context menu to the shared chat width", async () => {
    Object.defineProperty(Platform, "OS", { configurable: true, value: "macos" });
    const menu = await renderMenu("25%");

    fireEvent(menu.getByLabelText("コンテキスト使用量 25%"), "longPress");

    await waitFor(() => {
      expect(StyleSheet.flatten(menu.getByTestId("chat-context-menu").props.style)).toMatchObject({
        width: "100%",
        maxWidth: CHAT_CONTENT_MAX_WIDTH,
        alignSelf: "center",
      });
    });
  });
});
