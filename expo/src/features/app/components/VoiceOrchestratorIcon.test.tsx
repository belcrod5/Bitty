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
