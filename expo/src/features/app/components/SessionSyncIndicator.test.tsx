import React from "react";
import { render } from "@testing-library/react-native";
import { Animated } from "react-native";
import { SessionSyncIndicator } from "./SessionSyncIndicator";
import { USE_NATIVE_ANIMATION_DRIVER } from "../utils/animationDriver";

let mockReduceMotion: boolean | null = false;
jest.mock("../hooks/useReduceMotionEnabled", () => ({
  useReduceMotionEnabled: () => mockReduceMotion,
}));

const start = jest.fn();
const stop = jest.fn();
beforeEach(() => {
  mockReduceMotion = false;
  jest.clearAllMocks();
  jest.spyOn(Animated, "loop").mockReturnValue({ start, stop, reset: jest.fn() });
});
afterEach(() => jest.restoreAllMocks());

test.each(["bar", "ring"] as const)("%s animates only during sync and stops on completion/unmount", async (variant) => {
  const screen = await render(<SessionSyncIndicator phase="idle" variant={variant} />);
  expect(screen.queryByTestId(`session-sync-${variant}`)).toBeNull();
  expect(start).not.toHaveBeenCalled();
  await screen.rerender(<SessionSyncIndicator phase="loading" variant={variant} />);
  expect(screen.getByTestId(`session-sync-${variant}`).props.pointerEvents).toBe("none");
  expect(start).toHaveBeenCalledTimes(1);
  await screen.rerender(<SessionSyncIndicator phase="complete" variant={variant} />);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId(`session-sync-${variant}`)).toBeNull();
  await screen.rerender(<SessionSyncIndicator phase="refreshing" variant={variant} />);
  await screen.unmount();
  expect(stop).toHaveBeenCalledTimes(2);
});

test.each([true, null])("keeps a static indicator when reduced motion is %s", async (reduceMotion) => {
  mockReduceMotion = reduceMotion;
  const screen = await render(<SessionSyncIndicator phase="refreshing" variant="bar" />);
  expect(screen.getByTestId("session-sync-bar")).toBeTruthy();
  expect(start).not.toHaveBeenCalled();
});

test("uses a non-interaction transform loop and stops on motion preference changes", async () => {
  const timing = jest.spyOn(Animated, "timing");
  const screen = await render(<SessionSyncIndicator phase="refreshing" variant="ring" />);
  expect(timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    isInteraction: false, useNativeDriver: USE_NATIVE_ANIMATION_DRIVER,
  }));
  mockReduceMotion = true;
  await screen.rerender(<SessionSyncIndicator phase="refreshing" variant="ring" />);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("session-sync-ring")).toBeTruthy();
});
