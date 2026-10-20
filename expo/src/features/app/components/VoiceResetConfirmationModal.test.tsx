import { act, fireEvent, render, within } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { VoiceResetConfirmationModal } from "./VoiceResetConfirmationModal";

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test("offers both choices with a filling countdown inside Continue", async () => {
  const decide = jest.fn();
  const view = await render(<VoiceResetConfirmationModal request={{ required: false, deadlineMs: Date.now() + 10_000, decide }} />);
  expect(view.getByText("10秒後にリセットせず続けます。")).toBeTruthy();
  const meter = view.getByTestId("voice-reset-countdown");
  expect(within(view.getByRole("button", { name: "続ける" })).getByTestId("voice-reset-countdown")).toBe(meter);
  expect(StyleSheet.flatten(meter.props.style).width).toBe("0%");
  await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
  expect(parseFloat(StyleSheet.flatten(view.getByTestId("voice-reset-countdown").props.style).width)).toBeGreaterThan(45);
  await fireEvent.press(view.getByRole("button", { name: "続ける" }));
  expect(decide).toHaveBeenCalledWith("continue");
  await fireEvent.press(view.getByRole("button", { name: "リセットする" }));
  expect(decide).toHaveBeenCalledWith("reset");
});

test("required reset offers only Reset and no countdown", async () => {
  const decide = jest.fn();
  const view = await render(<VoiceResetConfirmationModal request={{ required: true, deadlineMs: null, decide }} />);
  expect(view.getByText("セッションのリセットが必要です")).toBeTruthy();
  expect(view.queryByRole("button", { name: "続ける" })).toBeNull();
  expect(view.queryByTestId("voice-reset-countdown")).toBeNull();
  await fireEvent.press(view.getByRole("button", { name: "リセットする" }));
  expect(decide).toHaveBeenCalledWith("reset");
});
