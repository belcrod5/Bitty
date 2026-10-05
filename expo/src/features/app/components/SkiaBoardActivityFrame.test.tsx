import React from "react";
import { act, render, waitFor } from "@testing-library/react-native";
import { SkiaBoardActivityFrame } from "./SkiaBoardActivityFrame";
import { VisualThemeProvider } from "../theme/VisualThemeContext";
import { VISUAL_THEMES } from "../theme/visualThemes";
import { useSharedValue } from "react-native-reanimated";

const mockPaths: Array<Array<[number, number]>> = [];
const mockFrameLoops: Array<{ callback: (frame: { timeSincePreviousFrame: number }) => void;
  setActive: jest.Mock }> = [];
let mockBoardValues: { positions: { value: Array<{ x: number; y: number }> };
  boardX: { value: number }; boardY: { value: number }; scale: { value: number } };
jest.mock("@shopify/react-native-skia", () => {
  const ReactModule = require("react");
  const { View } = require("react-native");
  const Stub = ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    ReactModule.createElement(View, { testID }, children);
  return {
    BlurMask: Stub, Canvas: Stub,
    Group: ({ children, clip }: { children?: React.ReactNode; clip: unknown }) =>
      ReactModule.createElement(View, { testID: "activity-glow-clip", clip }, children),
    Line: ({ p1, p2, children }: { p1: { x: number; y: number };
      p2: { value: { x: number; y: number } }; children?: React.ReactNode }) =>
      ReactModule.createElement(View, { testID: "activity-target-line", p1, p2 }, children),
    Path: Stub,
    SweepGradient: ({ start, end }: { start: { value: number }; end: { value: number } }) =>
      ReactModule.createElement(View, { testID: "activity-gradient", start, end }),
    vec: (x: number, y: number) => ({ x, y }),
    Skia: {
      XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
      Path: { Make: () => {
        const points: Array<[number, number]> = [];
        mockPaths.push(points);
        return {
          moveTo: (x: number, y: number) => points.push([x, y]),
          lineTo: (x: number, y: number) => points.push([x, y]),
          quadTo: (_cx: number, _cy: number, x: number, y: number) => points.push([x, y]),
        };
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

function FrameFixture({ badges, theme }: { badges: ReturnType<typeof badge>[]; theme: typeof standard }) {
  const positions = useSharedValue([{ x: 30, y: 40 }]);
  const boardX = useSharedValue(0);
  const boardY = useSharedValue(0);
  const scale = useSharedValue(1);
  mockBoardValues = { positions, boardX, boardY, scale };
  return <VisualThemeProvider themeId={theme.id} onSelectTheme={() => undefined}>
    <SkiaBoardActivityFrame badges={badges} theme={theme} targetIndexes={badges.length ? [0] : []}
      positions={positions} boardX={boardX} boardY={boardY} scale={scale}
      cardWidth={270} cardHeights={[112]} />
  </VisualThemeProvider>;
}

function frame(badges: ReturnType<typeof badge>[], theme = standard) {
  return <FrameFixture badges={badges} theme={theme} />;
}

beforeEach(() => {
  mockPaths.length = 0;
  mockFrameLoops.length = 0;
  mockTransitions.length = 0;
  mockReduceMotion = false;
});

test("draws the inner frame at the safe-area rail and connects a visible target card", async () => {
  const screen = await render(frame([badge("one", "実行中")]));
  await act(async () => {
    screen.getByTestId("skia-board-activity-frame").props.onLayout({
      nativeEvent: { layout: { width: 400, height: 800 } },
    });
    screen.getByTestId("skia-board-activity-safe-top").props.onLayout({
      nativeEvent: { layout: { y: 15 } },
    });
    screen.getByTestId("skia-board-activity-top-rail").props.onLayout({
      nativeEvent: { layout: { y: 30, height: 40 } },
    });
  });
  expect(mockPaths.at(-1)).toEqual([[8, 65], [8, 782], [18, 792], [382, 792], [392, 782],
    [392, 65], [8, 65]]);
  expect(screen.getByTestId("activity-glow-clip").props.clip)
    .toEqual({ x: 8, y: 65, width: 384, height: 727 });
  const line = screen.getByTestId("activity-target-line");
  expect(line.props.p1).toEqual({ x: 200, y: 85 });
  expect(line.props.p2.value).toEqual({ x: 200, y: 40 });
  mockBoardValues.boardX.value = 20;
  mockBoardValues.boardY.value = 20;
  mockBoardValues.scale.value = 2;
  expect(line.props.p2.value).toEqual({ x: 200, y: 100 });
  mockBoardValues.boardX.value = 500;
  expect(line.props.p2.value).toEqual(line.props.p1);
  expect(mockFrameLoops[0].setActive).toHaveBeenLastCalledWith(true);
  mockFrameLoops[0].callback({ timeSincePreviousFrame: 50 });
  const gradient = screen.getAllByTestId("activity-gradient")[0];
  expect(gradient.props.start.value).toBeCloseTo(3.6);
  expect(gradient.props.end.value).toBeCloseTo(363.6);
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
  expect(screen.queryByTestId("activity-target-line")).toBeNull();

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
  expect(mockFrameLoops[0].setActive).toHaveBeenLastCalledWith(false);
  expect(mockTransitions[0].kind).toBe("cyberpunk");
  expect(mockTransitions[0].reduceMotion).toBe(true);
  expect(screen.getByTestId("skia-board-activity-actor-one")).toBeTruthy();
  expect(screen.getByTestId("skia-board-activity-actor-two")).toBeTruthy();
  expect(screen.queryByTestId("skia-board-activity-actor-three")).toBeNull();
  expect(screen.getByText("+1")).toBeTruthy();
  expect(screen.getByTestId("skia-board-activity-status").props.children.join(""))
    .toBe("ツール実行中 · 実行中");
});
