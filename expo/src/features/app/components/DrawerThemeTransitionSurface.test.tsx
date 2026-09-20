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

test("keeps standard drawer feedback visual-free while playing the edge sound", async () => {
  await render(surface("standard", { direction: "open", sequence: 1 }));

  expect(playThemeSfx).toHaveBeenCalledTimes(1);
  expect(playThemeSfx).toHaveBeenCalledWith("drawerOpen");
  expect(withTiming).not.toHaveBeenCalled();
});

test("runs cyberpunk blink and vertical-only stretch for each rapid edge", async () => {
  const screen = await render(surface("cyberpunk", null));
  expect(playThemeSfx).not.toHaveBeenCalled();

  await screen.rerender(surface("cyberpunk", { direction: "open", sequence: 1 }));
  expect(playThemeSfx).toHaveBeenLastCalledWith("drawerOpen");
  expect((withTiming as jest.Mock).mock.calls.slice(0, 5).map(([target]) => target)).toEqual([
    1.045,
    0.955,
    1.025,
    0.98,
    1,
  ]);

  const cancelCountAfterOpen = (cancelAnimation as jest.Mock).mock.calls.length;
  await screen.rerender(surface("cyberpunk", { direction: "close", sequence: 2 }));
  expect(playThemeSfx).toHaveBeenLastCalledWith("drawerClose");
  expect(playThemeSfx).toHaveBeenCalledTimes(2);
  expect((cancelAnimation as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(
    cancelCountAfterOpen + 3
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
