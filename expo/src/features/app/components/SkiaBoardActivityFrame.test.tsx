import React from "react";
import { act, render, waitFor } from "@testing-library/react-native";
import { SkiaBoardActivityFrame } from "./SkiaBoardActivityFrame";
import { VisualThemeProvider } from "../theme/VisualThemeContext";
import { VISUAL_THEMES } from "../theme/visualThemes";

const mockTransitions: Array<{
  kind: string;
  direction: string;
  reduceMotion: boolean;
  onFinish: (finished: boolean) => void;
  stop: jest.Mock;
}> = [];
let mockReduceMotion = false;
jest.mock("../hooks/useReduceMotionEnabled", () => ({
  useReduceMotionEnabled: () => mockReduceMotion,
}));
jest.mock("./popupChatTransitions", () => {
  const start = (kind: string, options: { direction: string; reduceMotion: boolean;
    onFinish: (finished: boolean) => void }) => {
    const transition = { ...options, kind, stop: jest.fn() };
    mockTransitions.push(transition);
    return transition;
  };
  return {
    startStandardPopupTransition: (options: Parameters<typeof start>[1]) => start("standard", options),
    startCyberpunkPopupTransition: (options: Parameters<typeof start>[1]) => start("cyberpunk", options),
  };
});

const actor = (id: string) => ({ id, name: id, icon: "" });
const badge = (key: string, label: string, status = "running") => ({
  key, orchestrator: actor(key), status, label, count: 1,
});
const standard = VISUAL_THEMES.standard;
const cyberpunk = VISUAL_THEMES.cyberpunk;

function frame(badges: ReturnType<typeof badge>[], theme = standard) {
  return <VisualThemeProvider themeId={theme.id} onSelectTheme={() => undefined}>
    <SkiaBoardActivityFrame badges={badges} theme={theme} />
  </VisualThemeProvider>;
}

beforeEach(() => {
  mockTransitions.length = 0;
  mockReduceMotion = false;
});

test("keeps the frame through tool updates and a canceled close, then removes it after a real close", async () => {
  const screen = await render(frame([badge("one", "取得中")]));
  expect(mockTransitions.map((transition) => transition.direction)).toEqual(["open"]);
  expect(screen.getByTestId("skia-board-activity-status").props.children.join("")).toBe("取得中 · 実行中");

  await act(async () => screen.rerender(frame([badge("one", "書き込み中")])));
  expect(mockTransitions).toHaveLength(1);
  expect(screen.getByTestId("skia-board-activity-status").props.children.join("")).toBe("書き込み中 · 実行中");

  await act(async () => screen.rerender(frame([])));
  expect(mockTransitions[0].stop).toHaveBeenCalledTimes(1);
  expect(mockTransitions[1].direction).toBe("close");
  expect(screen.getByTestId("skia-board-activity-frame")).toBeTruthy();

  await act(async () => screen.rerender(frame([badge("two", "会話中")])));
  expect(mockTransitions[1].stop).toHaveBeenCalledTimes(1);
  expect(mockTransitions[2].direction).toBe("open");
  await act(async () => mockTransitions[1].onFinish(true));
  expect(screen.getByTestId("skia-board-activity-actor-two")).toBeTruthy();

  await act(async () => screen.rerender(frame([])));
  await waitFor(() => expect(mockTransitions).toHaveLength(4));
  await act(async () => mockTransitions[3].onFinish(true));
  expect(screen.queryByTestId("skia-board-activity-frame")).toBeNull();
  await act(async () => screen.unmount());
  expect(mockTransitions[3].stop).toHaveBeenCalledTimes(1);
});

test("shows two distinct actors and prioritizes the running label with reduced motion", async () => {
  mockReduceMotion = true;
  const screen = await render(frame([
    badge("one", "取得中", "completed"),
    badge("two", "ツール実行中"),
    badge("three", "会話中"),
  ], cyberpunk));
  await waitFor(() => expect(mockTransitions).toHaveLength(1));
  expect(mockTransitions[0].kind).toBe("cyberpunk");
  expect(mockTransitions[0].reduceMotion).toBe(true);
  expect(screen.getByTestId("skia-board-activity-actor-one")).toBeTruthy();
  expect(screen.getByTestId("skia-board-activity-actor-two")).toBeTruthy();
  expect(screen.queryByTestId("skia-board-activity-actor-three")).toBeNull();
  expect(screen.getByText("+1")).toBeTruthy();
  expect(screen.getByTestId("skia-board-activity-status").props.children.join(""))
    .toBe("ツール実行中 · 実行中");
});
