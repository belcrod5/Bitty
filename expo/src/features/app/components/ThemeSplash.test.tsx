import React from "react";
import { act, render } from "@testing-library/react-native";
import { useReducedMotion, withRepeat, withTiming } from "react-native-reanimated";

import { VisualThemeProvider } from "../theme/VisualThemeContext";
import { ThemeSplash } from "./ThemeSplash";

jest.mock("react-native-worklets", () => require("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => {
  const mock = require("react-native-reanimated/mock");
  return {
    ...mock,
    useReducedMotion: jest.fn(() => false),
    withRepeat: jest.fn(mock.withRepeat),
    withTiming: jest.fn(mock.withTiming),
  };
});

const mockUseReducedMotion = useReducedMotion as jest.MockedFunction<typeof useReducedMotion>;
const mockWithTiming = withTiming as jest.MockedFunction<typeof withTiming>;
const defaultWithTiming = require("react-native-reanimated/mock").withTiming;

beforeEach(() => {
  jest.clearAllMocks();
  mockUseReducedMotion.mockReturnValue(false);
  mockWithTiming.mockImplementation(defaultWithTiming);
});

afterEach(() => {
  jest.useRealTimers();
});

test("waits for the persisted theme before playing the splash animation", async () => {
  jest.useFakeTimers();
  mockWithTiming.mockImplementation((toValue) => toValue as never);
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
  expect(withRepeat).toHaveBeenCalledTimes(1);

  await screen.rerender(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <ThemeSplash ready onReady={onReady} />
    </VisualThemeProvider>
  );
  expect(onReady).toHaveBeenCalledTimes(1);
});

test("suppresses cyberpunk flashing when Reduce Motion is enabled", async () => {
  mockUseReducedMotion.mockReturnValue(true);
  const screen = await render(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={() => undefined}>
      <ThemeSplash ready />
    </VisualThemeProvider>
  );

  expect(withRepeat).not.toHaveBeenCalled();
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
  mockWithTiming.mockImplementation((toValue) => toValue as never);
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
  const completionCallbacks: Array<(finished?: boolean) => void> = [];
  mockWithTiming.mockImplementation((toValue, _config, callback) => {
    if (callback) completionCallbacks.push(callback);
    return toValue as never;
  });
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

  await act(async () => completionCallbacks[0]?.(true));
  expect(screen.getByTestId("theme-splash", { includeHiddenElements: true })).toBeTruthy();
  await act(async () => completionCallbacks[1]?.(true));
  expect(screen.queryByTestId("theme-splash", { includeHiddenElements: true })).toBeNull();
  expect(onReady).toHaveBeenCalledTimes(1);
});
