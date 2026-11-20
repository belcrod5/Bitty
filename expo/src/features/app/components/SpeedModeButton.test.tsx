import React, { Profiler } from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { SpeedModeButton } from "./SpeedModeButton";

let mockReduceMotion: boolean | null = false;
const mockValues: { value: number }[] = [];
let mockIconWorklet: (() => { opacity: number }) | null = null;
const mockWithTiming = jest.fn((value: number, _config: unknown) => value);
const mockWithRepeat = jest.fn((value: number, _repetitions: number, _reverse: boolean,
  _callback: undefined, _reduceMotion: string) => value);
const mockCancelAnimation = jest.fn();

jest.mock("../hooks/useReduceMotionEnabled", () => ({ useReduceMotionEnabled: () => mockReduceMotion }));
jest.mock("@expo/vector-icons", () => {
  const ReactModule = jest.requireActual<typeof React>("react");
  const { Text } = jest.requireActual("react-native");
  return { Ionicons: ({ name }: { name: string }) => ReactModule.createElement(Text, null, name) };
});
jest.mock("react-native-reanimated", () => {
  const ReactModule = jest.requireActual<typeof React>("react");
  const { View } = jest.requireActual("react-native");
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (initial: number) => {
      const value = ReactModule.useRef({ value: initial }).current;
      if (!mockValues.includes(value)) mockValues.push(value);
      return value;
    },
    useAnimatedStyle: (callback: () => { opacity: number }) => {
      mockIconWorklet = callback;
      return callback();
    },
    withTiming: (...args: Parameters<typeof mockWithTiming>) => mockWithTiming(...args),
    withRepeat: (...args: Parameters<typeof mockWithRepeat>) => mockWithRepeat(...args),
    cancelAnimation: (value: unknown) => mockCancelAnimation(value),
    Easing: { sin: jest.fn(), inOut: (easing: unknown) => easing },
    ReduceMotion: { Never: "never" },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockReduceMotion = false;
  mockValues.length = 0;
  mockIconWorklet = null;
});

test("pulses only when on and cancels/reset on disable and unmount", async () => {
  const onPress = jest.fn();
  const screen = await render(<SpeedModeButton active={false} label="Standard" onPress={onPress} />);
  expect(mockWithRepeat).not.toHaveBeenCalled();
  expect(mockValues[0].value).toBe(1);
  await fireEvent.press(screen.getByRole("button", { name: "速度設定を開く: Standard" }));
  expect(onPress).toHaveBeenCalledTimes(1);

  await screen.rerender(<SpeedModeButton active label="Fast" onPress={onPress} />);
  expect(mockWithTiming).toHaveBeenCalledWith(0.35, { duration: 1500, easing: expect.any(Function), reduceMotion: "never" });
  expect(mockWithRepeat).toHaveBeenLastCalledWith(0.35, -1, true, undefined, "never");
  await screen.rerender(<SpeedModeButton active label="Fast" onPress={jest.fn()} />);
  expect(mockWithRepeat).toHaveBeenCalledTimes(1);

  const cancelsBeforeDisable = mockCancelAnimation.mock.calls.length;
  await screen.rerender(<SpeedModeButton active={false} label="Standard" onPress={onPress} />);
  expect(mockCancelAnimation).toHaveBeenCalledTimes(cancelsBeforeDisable + 1);
  expect(mockValues[0].value).toBe(1);
  await screen.rerender(<SpeedModeButton active label="Fast" onPress={onPress} />);
  const cancelsBeforeUnmount = mockCancelAnimation.mock.calls.length;
  await screen.unmount();
  expect(mockCancelAnimation).toHaveBeenCalledTimes(cancelsBeforeUnmount + 1);
  expect(mockValues[0].value).toBe(1);
});

test.each([null, true])("stays static with motion preference %s and responds to OS preference changes", async (preference) => {
  mockReduceMotion = preference;
  const screen = await render(<SpeedModeButton active label="Fast" onPress={jest.fn()} />);
  expect(mockWithRepeat).not.toHaveBeenCalled();
  expect(mockValues[0].value).toBe(1);
  expect(screen.getByRole("button", { name: "速度設定を開く: Fast" })).toBeTruthy();

  mockReduceMotion = false;
  await screen.rerender(<SpeedModeButton active label="Fast" onPress={jest.fn()} />);
  expect(mockWithRepeat).toHaveBeenCalledTimes(1);
  mockReduceMotion = true;
  await screen.rerender(<SpeedModeButton active label="Fast" onPress={jest.fn()} />);
  expect(mockValues[0].value).toBe(1);
  expect(mockWithRepeat).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test("animation frames update only shared opacity without React commits", async () => {
  const onRender = jest.fn();
  const screen = await render(<Profiler id="fast-toggle" onRender={onRender}>
    <SpeedModeButton active label="Fast" onPress={jest.fn()} />
  </Profiler>);
  const commits = onRender.mock.calls.length;
  await act(async () => {
    for (let frame = 0; frame < 120; frame += 1) {
      const opacity = 0.35 + 0.65 * (frame % 60) / 59;
      mockValues[0].value = opacity;
      expect(mockIconWorklet?.()).toEqual({ opacity });
    }
  });
  expect(onRender).toHaveBeenCalledTimes(commits);
  expect(mockWithRepeat.mock.calls[0][3]).toBeUndefined();
  await screen.unmount();
});
