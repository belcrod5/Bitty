import React from "react";
import { Text, type Animated } from "react-native";
import { act, render } from "@testing-library/react-native";

import { VisualThemeProvider } from "../theme/VisualThemeContext";
import {
  DrawerThemeTransitionSurface,
  type DrawerTransitionEvent,
} from "./DrawerThemeTransitionSurface";

let mockReduceMotion = false;
const mockCreateCyberpunkFlashBlinkTransition = jest.fn();
const createdAnimations: Animated.CompositeAnimation[] = [];

jest.mock("../hooks/useReduceMotionEnabled", () => ({
  useReduceMotionEnabled: () => mockReduceMotion,
}));

jest.mock("./cyberpunkFlashBlinkTransition", () => ({
  createCyberpunkFlashBlinkTransition: (...args: unknown[]) =>
    mockCreateCyberpunkFlashBlinkTransition(...args),
}));

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
  createdAnimations.length = 0;
  mockCreateCyberpunkFlashBlinkTransition.mockImplementation(() => {
    const animation: Animated.CompositeAnimation = {
      start: jest.fn(),
      stop: jest.fn(),
      reset: jest.fn(),
    };
    createdAnimations.push(animation);
    return animation;
  });
});

test("keeps standard drawer feedback visual-free", async () => {
  await render(surface("standard", { direction: "open", sequence: 1 }));

  expect(playThemeSfx).toHaveBeenCalledTimes(1);
  expect(playThemeSfx).toHaveBeenCalledWith("drawerOpen");
  expect(mockCreateCyberpunkFlashBlinkTransition).not.toHaveBeenCalled();
});

test("runs cyberpunk flash and blink without vertical stretch for each rapid edge", async () => {
  const screen = await render(surface("cyberpunk", null));
  expect(playThemeSfx).not.toHaveBeenCalled();

  await screen.rerender(surface("cyberpunk", { direction: "open", sequence: 1 }));
  expect(playThemeSfx).toHaveBeenLastCalledWith("drawerOpen");
  expect(mockCreateCyberpunkFlashBlinkTransition).toHaveBeenCalledWith(
    expect.objectContaining({ direction: "open" })
  );
  expect(createdAnimations[0]?.start).toHaveBeenCalledTimes(1);

  await screen.rerender(surface("cyberpunk", { direction: "close", sequence: 2 }));
  expect(playThemeSfx).toHaveBeenLastCalledWith("drawerClose");
  expect(playThemeSfx).toHaveBeenCalledTimes(2);
  expect(createdAnimations[0]?.stop).toHaveBeenCalledTimes(1);
  expect(createdAnimations[1]?.start).toHaveBeenCalledTimes(1);
});

test("suppresses cyberpunk visual feedback with Reduce Motion", async () => {
  mockReduceMotion = true;
  await act(async () => {
    await render(surface("cyberpunk", { direction: "close", sequence: 1 }));
  });

  expect(playThemeSfx).toHaveBeenCalledWith("drawerClose");
  expect(mockCreateCyberpunkFlashBlinkTransition).not.toHaveBeenCalled();
});
