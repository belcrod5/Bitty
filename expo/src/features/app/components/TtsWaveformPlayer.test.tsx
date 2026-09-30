import { fireEvent, render } from "@testing-library/react-native";
import { TtsWaveformPlayer } from "./TtsWaveformPlayer";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("./CircularProgressRing", () => ({ CircularProgressRing: () => null }));
jest.mock("../styles", () => ({ useAppStyles: () => ({}) }));
jest.mock("../theme/VisualThemeContext", () => ({
  useVisualTheme: () => ({ theme: require("../theme/visualThemes").VISUAL_THEMES.standard }),
}));

test("only the visible playback button is interactive", async () => {
  const onPressPlayStop = jest.fn();
  const screen = await render(<TtsWaveformPlayer
    isPlaybackActive={false}
    playButtonDisabled={false}
    onPressPlayStop={onPressPlayStop}
  />);
  expect(screen.queryByLabelText("TTS通信量を開く")).toBeNull();
  expect(screen.queryByText("TTS通信量")).toBeNull();
  const buttons = screen.getAllByRole("button");
  expect(buttons).toHaveLength(1);
  fireEvent.press(buttons[0]);
  expect(onPressPlayStop).toHaveBeenCalledTimes(1);
});
