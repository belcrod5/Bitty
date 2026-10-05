import React from "react";
import { act, render } from "@testing-library/react-native";
import { Animated } from "react-native";
import { SkiaBoardActivityFrame } from "./SkiaBoardActivityFrame";
import { VISUAL_THEMES } from "../theme/visualThemes";
import { useSharedValue } from "react-native-reanimated";

const mockFrameLoops: Array<{ callback: (frame: { timeSincePreviousFrame: number }) => void;
  setActive: jest.Mock }> = [];
let mockBoardValues: { positions: { value: Array<{ x: number; y: number }> };
  boardX: { value: number }; boardY: { value: number }; scale: { value: number } };
jest.mock("@shopify/react-native-skia", () => {
  const ReactModule = require("react");
  const { View } = require("react-native");
  const Stub = ({ children, testID, ...props }: { children?: React.ReactNode; testID?: string }) =>
    ReactModule.createElement(View, { testID, ...props }, children);
  return {
    BlurMask: ({ blur, ...props }: { blur: unknown }) =>
      ReactModule.createElement(View, { testID: "activity-blur", blur, ...props }),
    Canvas: Stub, Circle: ({ c, children, ...props }: {
      c: { value: { x: number; y: number } }; children?: React.ReactNode }) =>
      ReactModule.createElement(View, { testID: "activity-dot", c, ...props }, children),
    Group: ({ children, clip, opacity }: { children?: React.ReactNode; clip?: unknown; opacity?: unknown }) =>
      ReactModule.createElement(View, { testID: clip ? "activity-glow-clip" : undefined, clip, opacity }, children),
    Line: ({ p1, p2, children }: { p1: { value: { x: number; y: number } };
      p2: { value: { x: number; y: number } }; children?: React.ReactNode }) =>
      ReactModule.createElement(View, { testID: "activity-route-segment", p1, p2 }, children),
    Path: ({ path, children, ...props }: { path: unknown; children?: React.ReactNode }) =>
      ReactModule.createElement(View, { testID: "activity-path", path, ...props }, children),
    SweepGradient: ({ start, end }: { start: { value: number }; end: { value: number } }) =>
      ReactModule.createElement(View, { testID: "activity-gradient", start, end }),
    vec: (x: number, y: number) => ({ x, y }),
    Skia: {
      XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
      RRectXY: (rect: unknown, rx: number, ry: number) => ({ rect, rx, ry }),
      Path: { Make: () => {
        const path = { points: [] as Array<[number, number]>, roundedRect: null as unknown,
          moveTo(x: number, y: number) { this.points.push([x, y]); },
          lineTo(x: number, y: number) { this.points.push([x, y]); },
          close() { this.points.push(this.points[0]); },
          addRRect(rect: unknown) { this.roundedRect = rect; } };
        return path;
      } },
    },
  };
});
jest.mock("react-native-reanimated", () => {
  const ReactModule = require("react");
  return {
    useSharedValue: (initial: unknown) => ReactModule.useRef({ value: initial }).current,
    useDerivedValue: (derive: () => unknown) => ({ get value() { return derive(); } }),
    useFrameCallback: (callback: (frame: { timeSincePreviousFrame: number }) => void) => {
      const loop = ReactModule.useRef(null);
      if (!loop.current) {
        loop.current = { callback, setActive: jest.fn() };
        mockFrameLoops.push(loop.current);
      }
      loop.current.callback = callback;
      return loop.current;
    },
  };
});

let mockReduceMotion = false;
jest.mock("../hooks/useReduceMotionEnabled", () => ({
  useReduceMotionEnabled: () => mockReduceMotion,
}));

const actor = (id: string) => ({ id, name: id, icon: "" });
const badge = (key: string, label: string, status = "running") => ({
  key, orchestrator: actor(key), status, label, count: 1,
});
type Badge = ReturnType<typeof badge>;
type Target = { index: number; badgeIndex: number; badgeCount: number };
const standard = VISUAL_THEMES.standard;
const cyberpunk = VISUAL_THEMES.cyberpunk;

function FrameFixture({ badges, targets, theme = standard }: {
  badges: Badge[]; targets: Target[]; theme?: typeof standard;
}) {
  const positions = useSharedValue([{ x: 30, y: 40 }, { x: 100, y: 200 }]);
  const boardX = useSharedValue(0);
  const boardY = useSharedValue(0);
  const scale = useSharedValue(1);
  mockBoardValues = { positions, boardX, boardY, scale };
  return <SkiaBoardActivityFrame badges={badges} theme={theme} targets={targets}
    positions={positions} boardX={boardX} boardY={boardY} scale={scale} cardWidth={270} />;
}

const oneTarget: Target[] = [{ index: 0, badgeIndex: 0, badgeCount: 1 }];
function frame(badges: Badge[], targets: Target[] = badges.length ? oneTarget : [], theme = standard) {
  return <FrameFixture badges={badges} targets={targets} theme={theme} />;
}

async function layout(screen: Awaited<ReturnType<typeof render>>, width = 400, railX = 0) {
  await act(async () => {
    screen.getByTestId("skia-board-activity-frame").props.onLayout({
      nativeEvent: { layout: { width, height: 800 } },
    });
    screen.getByTestId("skia-board-activity-safe-top").props.onLayout({
      nativeEvent: { layout: { y: 15 } },
    });
    screen.getByTestId("skia-board-activity-top-rail").props.onLayout({
      nativeEvent: { layout: { x: railX, y: 30 } },
    });
    screen.getByTestId("skia-board-activity-status").parent?.props.onLayout?.({
      nativeEvent: { layout: { x: 120, y: 0, width: 150, height: 40 } },
    });
  });
}

const point = (value: { value: { x: number; y: number } }) => value.value;

test("draws the rainbow at exact screen edges and around the command label", async () => {
  const screen = await render(frame([badge("one", "実行中")]));
  expect(screen.queryByTestId("activity-route-segment")).toBeNull();
  await layout(screen, 400, 18);
  const paths = screen.getAllByTestId("activity-path");
  expect(paths[0].props.path.points).toEqual([[0, 0], [400, 0], [400, 800], [0, 800], [0, 0]]);
  expect(paths[2].props.path.roundedRect).toEqual({
    rect: { x: 138, y: 45, width: 150, height: 40 }, rx: 18, ry: 18,
  });
  expect(point(screen.getAllByTestId("activity-route-segment")[0].props.p1))
    .toEqual({ x: 213, y: 85 });
  expect(screen.getByTestId("activity-glow-clip").props.clip)
    .toEqual({ x: 0, y: 0, width: 400, height: 800 });
  expect(screen.getByTestId("skia-board-activity-status").parent?.props.style)
    .not.toHaveProperty("borderColor");
  expect(mockFrameLoops[0].setActive).toHaveBeenLastCalledWith(true);
  const gradients = screen.getAllByTestId("activity-gradient");
  const blurs = screen.getAllByTestId("activity-blur");
  expect(gradients[0].props.start).toBe(gradients[2].props.start);
  expect(paths[0].props.strokeWidth).toBe(paths[2].props.strokeWidth);
  expect(blurs[0].props.blur).toBe(blurs[1].props.blur);
  expect(paths[0].parent?.props.opacity).toBe(paths[2].parent?.props.opacity);
  expect(paths[0].props.strokeWidth.value).toBe(23);
  for (let step = 0; step < 4; step += 1) mockFrameLoops[0].callback({ timeSincePreviousFrame: 50 });
  mockFrameLoops[0].callback({ timeSincePreviousFrame: 25 });
  expect(gradients[0].props.start.value).toBeCloseTo(67.5);
  expect(gradients[2].props.end.value).toBeCloseTo(427.5);
  expect(paths[0].props.strokeWidth.value).toBeCloseTo(32);
  expect(blurs[0].props.blur.value).toBeCloseTo(13);
  expect(paths[0].parent?.props.opacity.value).toBeCloseTo(0.95);
  for (let step = 0; step < 9; step += 1) mockFrameLoops[0].callback({ timeSincePreviousFrame: 50 });
  expect(paths[2].props.strokeWidth.value).toBeCloseTo(14);
  expect(blurs[1].props.blur.value).toBeCloseTo(6);
  expect(paths[2].parent?.props.opacity.value).toBeCloseTo(0.55);
});

test("routes three orthogonal segments to each badge icon and flows three dots along them", async () => {
  const screen = await render(frame([badge("one", "取得中"), badge("two", "実行中"), badge("three", "会話中")],
    [{ index: 0, badgeIndex: 0, badgeCount: 2 },
      { index: 0, badgeIndex: 1, badgeCount: 2 },
      { index: 1, badgeIndex: 0, badgeCount: 1 }]));
  await layout(screen);
  const segments = screen.getAllByTestId("activity-route-segment");
  expect(segments).toHaveLength(9);
  expect(segments.slice(0, 3).map((line) => [point(line.props.p1), point(line.props.p2)])).toEqual([
    [{ x: 195, y: 85 }, { x: 195, y: 113 }],
    [{ x: 195, y: 113 }, { x: 248, y: 113 }],
    [{ x: 248, y: 113 }, { x: 248, y: 37 }],
  ]);
  expect(point(segments[5].props.p2)).toEqual({ x: 302, y: 37 });
  expect(point(segments[8].props.p2)).toEqual({ x: 372, y: 197 });
  const dots = screen.getAllByTestId("activity-dot");
  expect(dots).toHaveLength(18);
  expect(point(dots[0].props.c)).toEqual({ x: 195, y: 85 });
  mockFrameLoops[0].callback({ timeSincePreviousFrame: 50 });
  expect(point(dots[0].props.c)).toEqual({ x: 195, y: 92 });
  for (let step = 0; step < 4; step += 1) mockFrameLoops[0].callback({ timeSincePreviousFrame: 50 });
  expect(point(dots[0].props.c)).toEqual({ x: 202, y: 113 });
  for (let step = 0; step < 7; step += 1) mockFrameLoops[0].callback({ timeSincePreviousFrame: 50 });
  expect(point(dots[0].props.c).x).toBe(248);
  expect(point(dots[0].props.c).y).toBeCloseTo(110);
  mockBoardValues.boardX.value = -40;
  mockBoardValues.boardY.value = 10;
  mockBoardValues.scale.value = 2;
  expect(point(segments[2].props.p2)).toEqual({ x: 456, y: 84 });
  mockBoardValues.boardX.value = 1000;
  expect(segments[0].parent?.props.opacity.value).toBe(0);
  expect(point(dots[0].props.c)).toEqual({ x: -20, y: -20 });
});

test.each([standard, cyberpunk])("fades with %s, ignores a canceled close, and removes after a completed close", async (theme) => {
  const transitions: Array<{ duration: number; toValue: number; stop: jest.Mock;
    finish: (finished: boolean) => void }> = [];
  const timing = jest.spyOn(Animated, "timing").mockImplementation((_value, config) => {
    const transition: { duration: number; toValue: number; stop: jest.Mock;
      finish: (finished: boolean) => void } = { duration: config.duration || 0,
        toValue: config.toValue as number, stop: jest.fn(), finish: () => undefined };
    transitions.push(transition);
    return { start: (callback: (result: { finished: boolean }) => void) => {
      transition.finish = (finished: boolean) => callback({ finished });
    }, stop: transition.stop, reset: jest.fn() } as ReturnType<typeof Animated.timing>;
  });
  try {
    const screen = await render(frame([badge("one", "取得中")], oneTarget, theme));
    expect(transitions.map(({ toValue, duration }) => [toValue, duration])).toEqual([[1, 220]]);
    expect(screen.getByTestId("skia-board-activity-status").props.children.join("")).toBe("取得中 · 実行中");
    await screen.rerender(frame([badge("one", "書き込み中")], oneTarget, theme));
    expect(transitions).toHaveLength(1);
    await screen.rerender(frame([], [], theme));
    expect(transitions[0].stop).toHaveBeenCalledTimes(1);
    expect(transitions[1]).toMatchObject({ duration: 220, toValue: 0 });
    expect(screen.getByTestId("skia-board-activity-frame")).toBeTruthy();
    expect(screen.queryByTestId("activity-route-segment")).toBeNull();
    await screen.rerender(frame([badge("two", "会話中")], oneTarget, theme));
    await act(async () => transitions[1].finish(true));
    expect(screen.getByTestId("skia-board-activity-actor-two")).toBeTruthy();
    await screen.rerender(frame([], [], theme));
    await act(async () => transitions[3].finish(true));
    expect(screen.queryByTestId("skia-board-activity-frame")).toBeNull();
    await screen.unmount();
    expect(transitions[3].stop).toHaveBeenCalledTimes(1);
    expect(mockFrameLoops[0].setActive).toHaveBeenLastCalledWith(false);
  } finally {
    timing.mockRestore();
  }
});

test("shows global activity without routes and hides a route when its card disappears", async () => {
  const screen = await render(frame([badge("global", "実行中")], []));
  await layout(screen);
  expect(screen.getByTestId("skia-board-activity-frame")).toBeTruthy();
  expect(screen.queryByTestId("activity-route-segment")).toBeNull();
  await screen.rerender(frame([badge("one", "実行中")], oneTarget));
  const line = screen.getAllByTestId("activity-route-segment")[0];
  mockBoardValues.positions.value = [];
  expect(line.parent?.props.opacity.value).toBe(0);
});

test("keeps dots still and disables the frame loop with Reduce Motion", async () => {
  mockReduceMotion = true;
  const screen = await render(frame([
    badge("one", "取得中", "completed"),
    badge("two", "ツール実行中"),
    badge("three", "会話中"),
  ], oneTarget, cyberpunk));
  await layout(screen);
  const dots = screen.getAllByTestId("activity-dot");
  const start = point(dots[0].props.c);
  expect(point(dots[0].props.c)).toEqual(start);
  expect(mockFrameLoops[0].setActive).toHaveBeenLastCalledWith(false);
  expect(screen.getAllByTestId("activity-path")[0].props.strokeWidth.value).toBe(23);
  expect(screen.getAllByTestId("activity-gradient")[0].props.start.value).toBe(0);
  expect(screen.getByTestId("skia-board-activity-actor-one")).toBeTruthy();
  expect(screen.getByTestId("skia-board-activity-actor-two")).toBeTruthy();
  expect(screen.queryByTestId("skia-board-activity-actor-three")).toBeNull();
  expect(screen.getByText("+1")).toBeTruthy();
  expect(screen.getByTestId("skia-board-activity-status").props.children.join(""))
    .toBe("ツール実行中 · 実行中");
});

beforeEach(() => {
  mockFrameLoops.length = 0;
  mockReduceMotion = false;
});
