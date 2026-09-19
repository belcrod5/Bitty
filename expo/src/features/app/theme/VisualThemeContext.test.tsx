import { fireEvent, render } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";
import { AppModal, AppModalHost } from "../components/AppModal.macos";
import { VisualThemeProvider, useVisualTheme } from "./VisualThemeContext";

function ThemeProbe() {
  const { selectTheme, theme, themeId } = useVisualTheme();
  return (
    <Pressable testID="select-cyberpunk" onPress={() => selectTheme("cyberpunk")}>
      <Text>{`${themeId}:${theme.colors.textPrimary}`}</Text>
    </Pressable>
  );
}

test("provides the selected theme and switches when the controlled id changes", async () => {
  const onSelectTheme = jest.fn();
  const screen = await render(
    <VisualThemeProvider themeId="standard" onSelectTheme={onSelectTheme}>
      <ThemeProbe />
    </VisualThemeProvider>
  );

  expect(screen.getByText("standard:#0f172a")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("select-cyberpunk"));
  expect(onSelectTheme).toHaveBeenCalledWith("cyberpunk");

  await screen.rerender(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={onSelectTheme}>
      <ThemeProbe />
    </VisualThemeProvider>
  );
  expect(screen.getByText("cyberpunk:#f2f7f7")).toBeTruthy();
  await screen.unmount();
});

test("uses the standard theme when a component is rendered in isolation", async () => {
  const screen = await render(<ThemeProbe />);
  expect(screen.getByText("standard:#0f172a")).toBeTruthy();
  await screen.unmount();
});

test("keeps the selected theme in content rehosted by the macOS modal", async () => {
  const screen = await render(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <AppModalHost>
        <AppModal visible animationType="none">
          <ThemeProbe />
        </AppModal>
      </AppModalHost>
    </VisualThemeProvider>
  );

  expect(screen.getByText("cyberpunk:#f2f7f7")).toBeTruthy();
  await screen.unmount();
});
