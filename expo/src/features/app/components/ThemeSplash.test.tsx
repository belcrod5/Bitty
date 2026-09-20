import React from "react";
import { act, render } from "@testing-library/react-native";
import { Animated } from "react-native";

import { VisualThemeProvider } from "../theme/VisualThemeContext";
import { ThemeSplash } from "./ThemeSplash";

let mockReduceMotion = false;
const completionCallbacks: Array<(result: Animated.EndResult) => void> = [];

jest.mock("../hooks/useReduceMotionEnabled", () => ({
  useReduceMotionEnabled: () => mockReduceMotion,
}));

function animation(): Animated.CompositeAnimation {
  return {
    start: (callback) => {
      if (callback) completionCallbacks.push(callback);
    },
    stop: jest.fn(),
    reset: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReduceMotion = false;
  completionCallbacks.length = 0;
  jest.spyOn(Animated, "timing").mockImplementation(() => animation());
  jest.spyOn(Animated, "delay").mockImplementation(() => animation());
  jest.spyOn(Animated, "sequence").mockImplementation(() => animation());
  jest.spyOn(Animated, "parallel").mockImplementation(() => animation());
  jest.spyOn(Animated, "loop").mockImplementation(() => animation());
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("waits for the persisted theme before playing the splash animation", async () => {
  jest.useFakeTimers();
  const onReady = jest.fn();
  const screen = await render(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <ThemeSplash ready={false} onReady={onReady} />
    </VisualThemeProvider>
  );

  expect(screen.getByTestId("theme-splash", { includeHiddenElements: true })).toBeTruthy();
  expect(onReady).not.toHaveBeenCalled();

  await screen.rerender(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <ThemeSplash ready onReady={onReady} />
    </VisualThemeProvider>
  );
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(Animated.loop).toHaveBeenCalledTimes(1);
  expect((Animated.timing as jest.Mock).mock.calls.every(([, config]) => config.useNativeDriver === false)).toBe(true);

  await screen.rerender(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <ThemeSplash ready onReady={onReady} />
    </VisualThemeProvider>
  );
  expect(onReady).toHaveBeenCalledTimes(1);
});

test("suppresses cyberpunk flashing when Reduce Motion is enabled", async () => {
  mockReduceMotion = true;
  const screen = await render(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <ThemeSplash ready />
    </VisualThemeProvider>
  );

  expect(Animated.loop).not.toHaveBeenCalled();
  await screen.unmount();
});

test("fails open when persisted settings do not resolve", async () => {
  jest.useFakeTimers();
  const onReady = jest.fn();
  const screen = await render(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <ThemeSplash ready={false} onReady={onReady} />
    </VisualThemeProvider>
  );

  await act(async () => jest.advanceTimersByTime(5_000));

  expect(screen.queryByTestId("theme-splash", { includeHiddenElements: true })).toBeNull();
  expect(onReady).toHaveBeenCalledTimes(1);

  await screen.rerender(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <ThemeSplash ready onReady={onReady} />
    </VisualThemeProvider>
  );
  expect(onReady).toHaveBeenCalledTimes(1);
});

test("fails open when the animation completion callback does not fire", async () => {
  jest.useFakeTimers();
  const onReady = jest.fn();
  const screen = await render(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <ThemeSplash ready onReady={onReady} />
    </VisualThemeProvider>
  );

  expect(screen.getByTestId("theme-splash", { includeHiddenElements: true })).toBeTruthy();
  await act(async () => jest.advanceTimersByTime(970));

  expect(screen.queryByTestId("theme-splash", { includeHiddenElements: true })).toBeNull();
  expect(onReady).toHaveBeenCalledTimes(1);
});

test("cleans up the fail-open timer on unmount", async () => {
  jest.useFakeTimers();
  const onReady = jest.fn();
  const screen = await render(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <ThemeSplash ready={false} onReady={onReady} />
    </VisualThemeProvider>
  );

  await screen.unmount();
  await act(async () => jest.advanceTimersByTime(5_000));

  expect(onReady).not.toHaveBeenCalled();
});

test("replays StrictMode effects without duplicating the ready event", async () => {
  jest.useFakeTimers();
  const onReady = jest.fn();
  const screen = await render(
    <React.StrictMode>
      <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
        <ThemeSplash ready onReady={onReady} />
      </VisualThemeProvider>
    </React.StrictMode>
  );

  expect(completionCallbacks).toHaveLength(2);
  expect(onReady).toHaveBeenCalledTimes(1);

  await act(async () => completionCallbacks[0]?.({ finished: true }));
  expect(screen.getByTestId("theme-splash", { includeHiddenElements: true })).toBeTruthy();
  await act(async () => completionCallbacks[1]?.({ finished: true }));
  expect(screen.queryByTestId("theme-splash", { includeHiddenElements: true })).toBeNull();
  expect(onReady).toHaveBeenCalledTimes(1);
});
