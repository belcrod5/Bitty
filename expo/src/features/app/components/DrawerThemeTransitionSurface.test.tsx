import React from "react";
import { Text } from "react-native";
import { act, render } from "@testing-library/react-native";
import { cancelAnimation, withTiming } from "react-native-reanimated";

import { VisualThemeProvider } from "../theme/VisualThemeContext";
import {
  DrawerThemeTransitionSurface,
  type DrawerTransitionEvent,
} from "./DrawerThemeTransitionSurface";

let mockReduceMotion = false;

jest.mock("react-native-worklets", () => require("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => {
  const mock = require("react-native-reanimated/mock");
  return {
    ...mock,
    cancelAnimation: jest.fn(),
    useReducedMotion: () => mockReduceMotion,
    withDelay: jest.fn((_delay, animation) => animation),
    withSequence: jest.fn(mock.withSequence),
    withTiming: jest.fn(mock.withTiming),
  };
});

const playThemeSfx = jest.fn(async () => {});

function surface(themeId: "standard" | "cyberpunk", event: DrawerTransitionEvent | null) {
  return (
    <VisualThemeProvider themeId={themeId} onSelectTheme={jest.fn()}>
      <DrawerThemeTransitionSurface event={event} playThemeSfx={playThemeSfx}>
        <Text>Drawer content</Text>
      </DrawerThemeTransitionSurface>
    </VisualThemeProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReduceMotion = false;
});

test("keeps standard drawer feedback visual-free", async () => {
  await render(surface("standard", { direction: "open", sequence: 1 }));

  expect(playThemeSfx).toHaveBeenCalledTimes(1);
  expect(playThemeSfx).toHaveBeenCalledWith("drawerOpen");
  expect(withTiming).not.toHaveBeenCalled();
});

test("runs cyberpunk flash and blink without vertical stretch for each rapid edge", async () => {
  const screen = await render(surface("cyberpunk", null));
  expect(playThemeSfx).not.toHaveBeenCalled();

  await screen.rerender(surface("cyberpunk", { direction: "open", sequence: 1 }));
  expect(playThemeSfx).toHaveBeenLastCalledWith("drawerOpen");
  const timingTargets = (withTiming as jest.Mock).mock.calls.map(([target]) => target);
  expect(timingTargets).not.toContain(1.045);
  expect(timingTargets).not.toContain(0.955);
  expect(timingTargets).not.toContain(1.025);
  expect(timingTargets).not.toContain(0.98);

  const cancelCountAfterOpen = (cancelAnimation as jest.Mock).mock.calls.length;
  await screen.rerender(surface("cyberpunk", { direction: "close", sequence: 2 }));
  expect(playThemeSfx).toHaveBeenLastCalledWith("drawerClose");
  expect(playThemeSfx).toHaveBeenCalledTimes(2);
  expect((cancelAnimation as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(
    cancelCountAfterOpen + 2
  );
});

test("suppresses cyberpunk visual feedback with Reduce Motion", async () => {
  mockReduceMotion = true;
  await act(async () => {
    await render(surface("cyberpunk", { direction: "close", sequence: 1 }));
  });

  expect(playThemeSfx).toHaveBeenCalledWith("drawerClose");
  expect(withTiming).not.toHaveBeenCalled();
});
