import { fireEvent, render } from "@testing-library/react-native";
import { VoiceOrchestratorIcon } from "./VoiceOrchestratorIcon";
import { VisualThemeProvider } from "../theme/VisualThemeContext";

test("falls back to the name after a broken image and accepts a replacement image", async () => {
  const wrap = (icon: string) => (
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <VoiceOrchestratorIcon orchestrator={{ id: "parent", name: "親", icon }} />
    </VisualThemeProvider>
  );
  const screen = await render(wrap("data:image/png;base64,broken"));
  await fireEvent(screen.getByTestId("voice-orchestrator-icon-parent"), "error");
  expect(screen.getByText("親")).toBeTruthy();
  await screen.rerender(wrap("data:image/png;base64,replacement"));
  expect(screen.getByTestId("voice-orchestrator-icon-parent")).toBeTruthy();
});

test("floats a separate learning count on main only and keeps the conversation unread count", async () => {
  const wrap = (id: string, count?: number) => (
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <VoiceOrchestratorIcon orchestrator={{ id, name: "メイン", icon: "", unreadCount: 2, learningUnreadCount: count }} />
    </VisualThemeProvider>
  );
  const screen = await render(wrap("main", 3));
  expect(screen.getByTestId("voice-orchestrator-unread-main")).toBeTruthy();
  expect(screen.getByLabelText("新しく学んだこと 3件")).toBeTruthy();
  expect(screen.getByTestId("voice-orchestrator-learning-unread-main").props.style).toMatchObject({
    position: "absolute", right: -4, bottom: -4,
  });
  await screen.rerender(wrap("main", 120));
  expect(screen.getByText("99+")).toBeTruthy();
  for (const count of [undefined, 0, -1, 0.5, Number.NaN]) {
    await screen.rerender(wrap("main", count));
    expect(screen.queryByTestId("voice-orchestrator-learning-unread-main")).toBeNull();
  }
  await screen.rerender(wrap("child", 3));
  expect(screen.queryByTestId("voice-orchestrator-learning-unread-child")).toBeNull();
});
