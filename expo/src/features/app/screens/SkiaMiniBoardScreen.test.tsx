import React from "react";
import { Alert, Platform, StyleSheet } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { fitTailTextLines, SkiaMiniBoardScreen } from "./SkiaMiniBoardScreen";
import { gridFromSectionRect } from "../utils/skiaBoardSectionGeometry";

// Skia Canvasはjest環境で描画できないため、レイアウトに影響しないスタブへ置換する。
jest.mock("@shopify/react-native-skia", () => {
  const ReactModule = require("react");
  const { View } = require("react-native");
  const Stub = ({ children }: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, children);
  // 文字列パス=アイコン。グリッド等のPathオブジェクト描画はアイコン数の検証に含めない。
  const PathStub = ({ path, color }: { path: unknown; color: string }) => (
    typeof path === "string"
      ? ReactModule.createElement(View, {
          testID: "skia-icon-path",
          accessibilityLabel: color,
        })
      : null
  );
  const ParagraphStub = ({ paragraph }: { paragraph: { text: string; rendered?: boolean } }) => {
    paragraph.rendered = true;
    return ReactModule.createElement(View, {
      testID: `skia-text:${paragraph.text}`,
      accessibilityLabel: paragraph.text,
    });
  };
  // createPictureへ描いた内容(テキストとアイコン)を記録し、Pictureスタブが
  // ParagraphStub/PathStubと同じtestIDのViewとして描画する。
  const createPictureStub = (cb: (canvas: unknown) => void) => {
    const recorded = { texts: [] as string[], iconColors: [] as string[] };
    cb({
      save: () => undefined,
      restore: () => undefined,
      translate: () => undefined,
      clipRect: () => undefined,
      drawRRect: () => undefined,
      drawCircle: () => undefined,
      drawLine: () => undefined,
      drawPath: (_path: unknown, paint: { color?: string }) => {
        recorded.iconColors.push(String(paint.color));
      },
      drawParagraph: (text: string) => {
        recorded.texts.push(text);
      },
    });
    return recorded;
  };
  const PictureStub = ({ picture }: { picture?: { texts: string[]; iconColors: string[] } }) =>
    ReactModule.createElement(View, null, [
      ...(picture?.texts || []).map((text: string, index: number) =>
        ReactModule.createElement(View, {
          key: `text-${index}`,
          testID: `skia-text:${text}`,
          accessibilityLabel: text,
        })),
      ...(picture?.iconColors || []).map((color: string, index: number) =>
        ReactModule.createElement(View, {
          key: `icon-${index}`,
          testID: "skia-icon-path",
          accessibilityLabel: color,
        })),
    ]);
  return {
    Canvas: Stub,
    Circle: Stub,
    Group: Stub,
    Line: Stub,
    Path: PathStub,
    Picture: PictureStub,
    RoundedRect: Stub,
    FontWeight: { Bold: 700 },
    PaintStyle: { Fill: 0, Stroke: 1 },
    StrokeCap: { Butt: 0, Round: 1, Square: 2 },
    StrokeJoin: { Miter: 0, Round: 1, Bevel: 2 },
    ClipOp: { Difference: 0, Intersect: 1 },
    Paragraph: ParagraphStub,
    createPicture: createPictureStub,
    Skia: {
      Color: (color: string) => color,
      Paint: () => {
        const paint = {
          color: undefined as string | undefined,
          setColor: (color: string) => { paint.color = color; },
          setAlphaf: () => undefined,
          setAntiAlias: () => undefined,
          setStyle: () => undefined,
          setStrokeWidth: () => undefined,
          setStrokeCap: () => undefined,
          setStrokeJoin: () => undefined,
        };
        return paint;
      },
      RRectXY: (rect: unknown, rx: number, ry: number) => ({ rect, rx, ry }),
      XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
      Path: {
        Make: () => ({
          moveTo: () => undefined,
          lineTo: () => undefined,
        }),
        MakeFromSVGString: (svg: string) => ({ svg, dispose: () => undefined }),
      },
      ParagraphBuilder: {
        Make: () => {
          let text = "";
          return {
            pushStyle: (style: { fontStyle?: unknown }) => {
              if (
                Object.prototype.hasOwnProperty.call(style, "fontStyle")
                && style.fontStyle === undefined
              ) {
                throw new Error("Value is undefined, expected an Object");
              }
              const target = globalThis as Record<string, unknown>;
              const styles = target.__skiaBoardParagraphStyles as unknown[] | undefined;
              target.__skiaBoardParagraphStyles = [...(styles || []), style];
            },
            addText: (next: string) => { text += next; },
            build: () => {
              const firstLine = text.split(/\r?\n/, 1)[0] || "";
              const paragraph: {
                text: string;
                rendered?: boolean;
                layout: () => undefined;
                getLongestLine: () => number;
                paint: (canvas: { drawParagraph?: (text: string) => void }) => void;
                dispose: () => void;
              } = {
                text: firstLine,
                layout: () => undefined,
                getLongestLine: () => Array.from(firstLine).length * 5,
                paint: (canvas) => { canvas.drawParagraph?.(firstLine); },
                dispose: () => undefined,
              };
              paragraph.dispose = () => {
                const target = globalThis as Record<string, unknown>;
                target.__skiaBoardDisposedParagraphs =
                  Number(target.__skiaBoardDisposedParagraphs || 0) + 1;
                if (paragraph.rendered) {
                  target.__skiaBoardDisposedRenderedParagraphs =
                    Number(target.__skiaBoardDisposedRenderedParagraphs || 0) + 1;
                }
              };
              return paragraph;
            },
          };
        },
      },
    },
  };
});

jest.mock("@expo/vector-icons", () => {
  const ReactModule = require("react");
  const { Text } = require("react-native");
  return {
    Ionicons: ({ name }: { name: string }) => ReactModule.createElement(Text, null, name),
  };
});

// 公式mockのuseSharedValueはrender毎に新オブジェクトを返し、実物と異なり
// deps比較で毎render変化してしまうため、実物同様に同一参照を維持する。
jest.mock("react-native-worklets", () => require("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => {
  const actualMock = require("react-native-reanimated/mock");
  const ReactModule = require("react");
  return {
    ...actualMock,
    useSharedValue: (init: unknown) => ReactModule.useRef({
      value: init,
      modify(modifier: (value: unknown) => unknown) {
        this.value = modifier(this.value);
      },
    }).current,
    withTiming: jest.fn(actualMock.withTiming),
    // 実mockのwithDecayは即座にcallback(true)で完了扱いになるため、
    // 「減衰中に新しいタッチで止める」流れを検証できるよう完了させない。
    withDecay: jest.fn(() => 0),
    cancelAnimation: jest.fn(),
    // フレーム反映ループ: コールバックを捕捉してテストから任意タイミングで実行でき、
    // setActive(起動・停止)の呼び出しも検証できるようにする。
    useFrameCallback: (callback: () => void) => {
      const target = globalThis as Record<string, unknown>;
      target.__skiaBoardFrameCallback = callback;
      if (!target.__skiaBoardFrameLoopSetActive) {
        target.__skiaBoardFrameLoopSetActive = jest.fn();
      }
      return { setActive: target.__skiaBoardFrameLoopSetActive, isActive: false, callbackId: -1 };
    },
  };
});

// ジェスチャ定義のコールバックを捕捉し、テストからタップ等を直接発火できるようにする。
jest.mock("react-native-gesture-handler", () => {
  const registry: Record<string, Record<string, (...args: unknown[]) => unknown>> = {};
  (globalThis as Record<string, unknown>).__skiaBoardGestureRegistry = registry;
  const makeChain = (name: string) => {
    const callbacks: Record<string, (...args: unknown[]) => unknown> = {};
    registry[name] = callbacks;
    const chain: Record<string, unknown> = new Proxy({}, {
      get: (_target, prop: string) => (callback: (...args: unknown[]) => unknown) => {
        callbacks[prop] = callback;
        return chain;
      },
    });
    return chain;
  };
  return {
    Gesture: {
      Pan: () => makeChain("Pan"),
      Tap: () => makeChain("Tap"),
      Pinch: () => makeChain("Pinch"),
      LongPress: () => makeChain("LongPress"),
      Simultaneous: (...gestures: unknown[]) => gestures,
    },
    GestureDetector: ({ children }: { children?: React.ReactNode }) => children,
  };
});

jest.mock("../contexts/AppShellContext", () => ({
  useAppShell: () => ({ openDrawer: jest.fn() }),
}));
jest.mock("../contexts/ChatScreenContext", () => ({
  useChatScreen: () => ({
    runnerUrl: "http://localhost:8787",
    runnerToken: "token",
    sanitizeTextForTts: (text: string) => text,
    handleAssistantAudioButtonPress: jest.fn(),
  }),
}));
jest.mock("../components/RunnerMediaViewer", () => ({ RunnerMediaViewer: () => null }));
jest.mock("../components/RunnerFileViewer", () => {
  const ReactModule = require("react");
  const { Text } = require("react-native");
  return {
    RunnerFileViewer: ({ target }: { target?: { path?: string } | null }) => (
      target ? ReactModule.createElement(Text, { testID: "runner-file-target" }, target.path) : null
    ),
  };
});
jest.mock("../components/WorkspaceFileRenameDialog", () => ({ WorkspaceFileRenameDialog: () => null }));
jest.mock("../components/WorkspaceTextFileEditor", () => ({ WorkspaceTextFileEditor: () => null }));

const mockMoveBoardCard = jest.fn();
const mockAddBoardSection = jest.fn();
const mockUpdateBoardSection = jest.fn();
const mockRemoveBoardSection = jest.fn();
const mockRemoveBoardSession = jest.fn();
const mockRemoveBoardDirectory = jest.fn();
const mockRemoveBoardFile = jest.fn();
const mockHasBoardFile = jest.fn(() => true);
const mockMarkBoardFileUnavailable = jest.fn();
const mockTidyBoard = jest.fn();
const mockSetBoardCardTextScale = jest.fn();
const mockDefaultSession = {
  kind: "session" as const,
  cardId: "session:session-1",
  panelId: "skia_mini_preview_session-1",
  sessionId: "session-1",
  directory: "/workspace",
  source: "appserver",
  title: "Title 1",
  directoryName: "Workspace",
  lastMessageContent: "hello",
  updatedAtLabel: "1分前",
  markerColor: "none",
  unread: false,
  activityTrail: [] as Array<{
    kind: "reading" | "writing" | "thinking" | "web";
    active: boolean;
  }>,
  subagentLoading: false,
  subagentRunningCount: 0,
  subagentTotalCount: 0,
  col: 0,
  row: 0,
};
let mockSessions = [mockDefaultSession];
let mockSections: Array<{
  id: string;
  label: string;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  color: string;
  opacity: number;
  borderOnly: boolean;
}> = [];

function mockSectionAt(x: number, y: number, width: number, height: number) {
  const id = "section:1";
  return {
    id,
    label: "計画",
    ...gridFromSectionRect({ id, x, y, width, height }, 270),
    color: "#3b82f6",
    opacity: 0.2,
    borderOnly: false,
  };
}

jest.mock("../hooks/useSkiaMiniChatSessions", () => ({
  useSkiaMiniChatSessions: () => ({
    directorySync: { phase: "idle", completedCount: 0, totalCount: 0, failedCount: 0 },
    hydratingPanelCount: 0,
    panelHydrationErrorCount: 0,
    sessions: mockSessions,
    items: mockSessions,
    sections: mockSections,
    cardTextScale: 1,
    setBoardCardTextScale: mockSetBoardCardTextScale,
    moveBoardCard: mockMoveBoardCard,
    addBoardSection: mockAddBoardSection,
    updateBoardSection: mockUpdateBoardSection,
    removeBoardSection: mockRemoveBoardSection,
    removeBoardSession: mockRemoveBoardSession,
    removeBoardDirectory: mockRemoveBoardDirectory,
    removeBoardFile: mockRemoveBoardFile,
    hasBoardFile: mockHasBoardFile,
    markBoardFileUnavailable: mockMarkBoardFileUnavailable,
    tidyBoard: mockTidyBoard,
  }),
}));

beforeEach(() => {
  (globalThis as Record<string, unknown>).__skiaBoardParagraphStyles = [];
  (globalThis as Record<string, unknown>).__skiaBoardDisposedParagraphs = 0;
  (globalThis as Record<string, unknown>).__skiaBoardDisposedRenderedParagraphs = 0;
  mockMoveBoardCard.mockClear();
  mockAddBoardSection.mockClear();
  mockUpdateBoardSection.mockClear();
  mockRemoveBoardSection.mockClear();
  mockRemoveBoardSession.mockClear();
  mockRemoveBoardDirectory.mockClear();
  mockRemoveBoardFile.mockClear();
  mockHasBoardFile.mockClear();
  mockMarkBoardFileUnavailable.mockClear();
  mockTidyBoard.mockClear();
  mockSetBoardCardTextScale.mockClear();
  mockSessions = [mockDefaultSession];
  mockSections = [];
});

test("renders Japanese and emoji through system-fallback paragraphs", async () => {
  mockSessions = [{
    ...mockDefaultSession,
    directoryName: "日本語の作業場所",
    title: "進捗確認 👍🏽",
    lastMessageContent: "文字化けせず表示 👨‍👩‍👧‍👦",
  }];

  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  expect(screen.getByLabelText("日本語の作業場所")).toBeTruthy();
  expect(screen.getByLabelText("進捗確認 👍🏽")).toBeTruthy();
  expect(screen.getByLabelText("文字化けせず表示 👨‍👩‍👧‍👦")).toBeTruthy();
  const styles = (globalThis as Record<string, unknown>)
    .__skiaBoardParagraphStyles as Array<{ fontFamilies?: string[]; fontStyle?: unknown }>;
  expect(styles.length).toBeGreaterThan(0);
  expect(styles.every((style) => style.fontFamilies?.[0] === ".AppleSystemUIFont")).toBe(true);
  expect(styles.some((style) => !("fontStyle" in style))).toBe(true);
  expect(styles.some((style) => style.fontStyle !== undefined)).toBe(true);
  expect((globalThis as Record<string, unknown>).__skiaBoardDisposedParagraphs).not.toBe(0);
});

function gestureRegistry() {
  return (globalThis as Record<string, unknown>)
    .__skiaBoardGestureRegistry as Record<string, Record<string, (...args: unknown[]) => unknown>>;
}

function fireCardTap() {
  // カード0は col=0,row=0 → (18, 18) 起点なので (30, 30) のタップで命中する。
  gestureRegistry().Tap.onEnd({ x: 30, y: 30 }, true);
}

test("animates mouse-wheel zoom but keeps two-pointer pinch direct", async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(Platform, "OS");
  Object.defineProperty(Platform, "OS", { configurable: true, value: "macos" });
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  const { withTiming } = require("react-native-reanimated") as { withTiming: jest.Mock };
  withTiming.mockClear();

  gestureRegistry().Pinch.onStart({ focalX: 100, focalY: 50 });
  gestureRegistry().Pinch.onUpdate({
    focalX: 100,
    focalY: 50,
    numberOfPointers: 1,
    scale: 1.04,
  });
  expect(withTiming.mock.calls.map(([target]) => target)).toEqual([1.04, -4, -2]);

  withTiming.mockClear();
  gestureRegistry().Pinch.onStart({ focalX: 100, focalY: 50 });
  gestureRegistry().Pinch.onUpdate({
    focalX: 100,
    focalY: 50,
    numberOfPointers: 2,
    scale: 1.04,
  });
  expect(withTiming).not.toHaveBeenCalled();
  if (platformDescriptor) {
    Object.defineProperty(Platform, "OS", platformDescriptor);
  }
});

function reanimatedMocks() {
  return require("react-native-reanimated") as {
    withDecay: jest.Mock;
    cancelAnimation: jest.Mock;
  };
}

test("board pan release continues with camera decay until a new touch stops it", async () => {
  const { withDecay, cancelAnimation } = reanimatedMocks();
  withDecay.mockClear();
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  const pan = gestureRegistry().Pan;

  // システム割込みでキャンセルされた終了(success=false)では慣性を開始しない。
  await act(async () => {
    pan.onTouchesDown({ numberOfTouches: 1 });
    pan.onBegin({ x: 350, y: 300 });
    pan.onStart();
    pan.onUpdate({ numberOfPointers: 1, translationX: 40, translationY: 20 });
    pan.onEnd({ x: 390, y: 320, velocityX: 500, velocityY: -250 }, false);
    pan.onFinalize();
  });
  expect(withDecay).not.toHaveBeenCalled();

  await act(async () => {
    pan.onTouchesDown({ numberOfTouches: 1 });
    pan.onBegin({ x: 350, y: 300 });
    pan.onStart();
    pan.onUpdate({ numberOfPointers: 1, translationX: 40, translationY: 20 });
    pan.onEnd({ x: 390, y: 320, velocityX: 500, velocityY: -250 }, true);
    pan.onFinalize();
  });
  expect(withDecay.mock.calls.map(([config]) => config.velocity)).toEqual([500, -250]);

  // 慣性中に画面へ触れたら減衰アニメーションを停止する。
  cancelAnimation.mockClear();
  await act(async () => {
    pan.onTouchesDown({ numberOfTouches: 1 });
  });
  expect(cancelAnimation).toHaveBeenCalled();
});

test("slow releases below the inertia thresholds do not start camera decay", async () => {
  const { withDecay } = reanimatedMocks();
  withDecay.mockClear();
  let now = 1000;
  const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  // パン: 指を止めて離した程度の速度(≈36px/s < 50px/s)では滑らない。
  const registry = gestureRegistry();
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onBegin({ x: 350, y: 300 });
    registry.Pan.onStart();
    registry.Pan.onUpdate({ numberOfPointers: 1, translationX: 40, translationY: 20 });
    registry.Pan.onEnd({ x: 390, y: 320, velocityX: 30, velocityY: 20 }, true);
    registry.Pan.onFinalize();
  });
  expect(withDecay).not.toHaveBeenCalled();

  // ピンチ: focal 10px/s・scale 0.1/s の低速リリースでも滑らない。
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onTouchesDown({ numberOfTouches: 2 });
    registry.Pinch.onBegin();
    registry.Pinch.onStart({ focalX: 100, focalY: 50 });
    now += 100;
    registry.Pinch.onUpdate({ focalX: 101, focalY: 51, numberOfPointers: 2, scale: 1.01 });
    now += 16;
    registry.Pan.onTouchesUp({ numberOfTouches: 0, changedTouches: [{ x: 101, y: 51 }] });
    registry.Pan.onFinalize();
  });
  expect(withDecay).not.toHaveBeenCalled();
  nowSpy.mockRestore();
});

test("the gesture frame loop starts on the first touch and stops at finalize", async () => {
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  const setActive = (globalThis as Record<string, unknown>)
    .__skiaBoardFrameLoopSetActive as jest.Mock;
  setActive.mockClear();

  const pan = gestureRegistry().Pan;
  await act(async () => {
    pan.onTouchesDown({ numberOfTouches: 1 });
  });
  expect(setActive).toHaveBeenLastCalledWith(true);

  await act(async () => {
    pan.onBegin({ x: 350, y: 300 });
    pan.onStart();
    pan.onUpdate({ numberOfPointers: 1, translationX: 40, translationY: 20 });
    pan.onEnd({ x: 390, y: 320, velocityX: 0, velocityY: 0 }, true);
    pan.onFinalize();
  });
  expect(setActive).toHaveBeenLastCalledWith(false);
});

test("a board pan leaves the camera at its final position for later hit-testing", async () => {
  const openSessionHistoryPopup = jest.fn();
  await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={openSessionHistoryPopup} />
  );

  // 目標値はonFinalizeのflushで必ずカメラへ反映される(フレームコールバック未実行でも)。
  const registry = gestureRegistry();
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onBegin({ x: 350, y: 300 });
    registry.Pan.onStart();
    registry.Pan.onUpdate({ numberOfPointers: 1, translationX: 130, translationY: 130 });
    registry.Pan.onEnd({ x: 480, y: 430, velocityX: 0, velocityY: 0 }, true);
    registry.Pan.onFinalize();
  });

  // カード0はワールド座標(18,18)起点。ボードが(130,130)動いた後は画面(160,160)で命中する。
  await act(async () => {
    registry.Tap.onEnd({ x: 160, y: 160 }, true);
  });
  await act(async () => {
    registry.Tap.onEnd({ x: 160, y: 160 }, true);
  });
  expect(openSessionHistoryPopup).toHaveBeenCalledTimes(1);
});

test("the frame callback applies pending camera targets mid-drag", async () => {
  const openSessionHistoryPopup = jest.fn();
  await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={openSessionHistoryPopup} />
  );

  const registry = gestureRegistry();
  const frameCallback = (globalThis as Record<string, unknown>)
    .__skiaBoardFrameCallback as () => void;
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onBegin({ x: 350, y: 300 });
    registry.Pan.onStart();
    registry.Pan.onUpdate({ numberOfPointers: 1, translationX: 130, translationY: 130 });
    // onUpdateは目標値を書くだけで、フレームコールバックがカメラへ反映する。
    frameCallback();
  });

  // finalizeのflushを経ずに、カード0(ワールド18,18)がボード移動(130,130)後の
  // 画面(160,160)で命中する=フレーム経路で反映済み。
  await act(async () => {
    registry.Tap.onEnd({ x: 160, y: 160 }, true);
  });
  await act(async () => {
    registry.Tap.onEnd({ x: 160, y: 160 }, true);
  });
  expect(openSessionHistoryPopup).toHaveBeenCalledTimes(1);
});

test("the frame loop stops when a pinch outlives the pan gesture", async () => {
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  const setActive = (globalThis as Record<string, unknown>)
    .__skiaBoardFrameLoopSetActive as jest.Mock;

  const registry = gestureRegistry();
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onTouchesDown({ numberOfTouches: 2 });
    registry.Pinch.onBegin();
    registry.Pinch.onStart({ focalX: 100, focalY: 50 });
    registry.Pinch.onUpdate({ focalX: 110, focalY: 60, numberOfPointers: 2, scale: 1.2 });
    // 3本指等でパンだけ先に終了するケース。
    registry.Pan.onFinalize();
  });
  setActive.mockClear();
  await act(async () => {
    registry.Pinch.onUpdate({ focalX: 120, focalY: 70, numberOfPointers: 2, scale: 1.3 });
  });
  expect(setActive).toHaveBeenLastCalledWith(true);

  // ピンチのfinalizeでループが止まり、常駐しない。
  await act(async () => {
    registry.Pinch.onFinalize();
  });
  expect(setActive).toHaveBeenLastCalledWith(false);
});

test("card drags do not gain inertia", async () => {
  const { withDecay } = reanimatedMocks();
  withDecay.mockClear();
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  await act(async () => {
    fireCardTap();
  });
  const pan = gestureRegistry().Pan;
  await act(async () => {
    pan.onTouchesDown({ numberOfTouches: 1 });
    pan.onBegin({ x: 30, y: 30 });
    pan.onStart();
    pan.onUpdate({ numberOfPointers: 1, translationX: 40, translationY: 50 });
    pan.onEnd({ x: 70, y: 80, velocityX: 400, velocityY: 400 }, true);
    pan.onFinalize();
  });

  expect(mockMoveBoardCard).toHaveBeenCalledTimes(1);
  expect(withDecay).not.toHaveBeenCalled();
});

test("pinch release decays focal and scale together with the scale clamped", async () => {
  const { withDecay } = reanimatedMocks();
  withDecay.mockClear();
  let now = 1000;
  const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  const registry = gestureRegistry();
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onTouchesDown({ numberOfTouches: 2 });
    registry.Pinch.onBegin();
    registry.Pinch.onStart({ focalX: 100, focalY: 50 });
    now += 100;
    // focalの連続移動量(50px)が採用ゲート(24px)を超えるフリック相当の動き。
    registry.Pinch.onUpdate({ focalX: 130, focalY: 90, numberOfPointers: 2, scale: 1.2 });
    now += 16;
    registry.Pan.onTouchesUp({ numberOfTouches: 0 });
    registry.Pan.onFinalize();
  });

  // focal X/Yとscaleの3本が同経路で減衰し、scaleはMIN/MAX内に収まる。
  expect(withDecay).toHaveBeenCalledTimes(3);
  expect(withDecay.mock.calls[0][0].velocity).toBeCloseTo(300, 5);
  expect(withDecay.mock.calls[1][0].velocity).toBeCloseTo(400, 5);
  expect(withDecay.mock.calls[2][0].velocity).toBeCloseTo(2, 5);
  expect(withDecay.mock.calls[2][0].clamp).toEqual([0.25, 2.5]);
  nowSpy.mockRestore();
});

test("a short release jolt after stationary fingers does not start inertia", async () => {
  const { withDecay } = reanimatedMocks();
  withDecay.mockClear();
  let now = 1000;
  const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  const registry = gestureRegistry();
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onTouchesDown({ numberOfTouches: 2 });
    registry.Pinch.onBegin();
    registry.Pinch.onStart({ focalX: 100, focalY: 50 });
    now += 100;
    // ひとしきり動かした後…
    registry.Pinch.onUpdate({ focalX: 150, focalY: 100, numberOfPointers: 2, scale: 1.5 });
    // 指を止める(300msイベントなし)→ 連続移動量はリセットされる。
    now += 300;
    registry.Pinch.onUpdate({ focalX: 151, focalY: 100, numberOfPointers: 2, scale: 1.5 });
    // 離し際の指の転がり: 瞬間速度は高い(4px/8ms=500px/s)が累積移動量はわずか。
    now += 8;
    registry.Pinch.onUpdate({ focalX: 155, focalY: 100, numberOfPointers: 2, scale: 1.5 });
    now += 8;
    registry.Pan.onTouchesUp({ numberOfTouches: 0, changedTouches: [{ x: 155, y: 100 }] });
    registry.Pan.onFinalize();
  });

  expect(withDecay).not.toHaveBeenCalled();
  nowSpy.mockRestore();
});

test("an implausible focal jump is discarded from the velocity samples", async () => {
  const { withDecay } = reanimatedMocks();
  withDecay.mockClear();
  let now = 1000;
  const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  const registry = gestureRegistry();
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onTouchesDown({ numberOfTouches: 2 });
    registry.Pinch.onBegin();
    registry.Pinch.onStart({ focalX: 100, focalY: 50 });
    now += 100;
    registry.Pinch.onUpdate({ focalX: 150, focalY: 100, numberOfPointers: 2, scale: 1.5 });
    // 100px/8ms=12500px/s は指では出せない=focal点のジャンプ。サンプルに採用しない。
    now += 8;
    registry.Pinch.onUpdate({ focalX: 250, focalY: 100, numberOfPointers: 2, scale: 1.5 });
    now += 8;
    registry.Pan.onTouchesUp({ numberOfTouches: 0, changedTouches: [{ x: 250, y: 100 }] });
    registry.Pan.onFinalize();
  });

  expect(withDecay).not.toHaveBeenCalled();
  nowSpy.mockRestore();
});

test("pinch inertia does not start while a finger stays down or after a stale release", async () => {
  const { withDecay } = reanimatedMocks();
  withDecay.mockClear();
  let now = 1000;
  const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  const registry = gestureRegistry();
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onTouchesDown({ numberOfTouches: 2 });
    registry.Pinch.onBegin();
    registry.Pinch.onStart({ focalX: 100, focalY: 50 });
    now += 100;
    registry.Pinch.onUpdate({ focalX: 110, focalY: 60, numberOfPointers: 2, scale: 1.2 });
    // 片指が残っている間は慣性を開始しない。
    registry.Pan.onTouchesUp({ numberOfTouches: 1 });
  });
  expect(withDecay).not.toHaveBeenCalled();

  // 指を置いたまま時間が経った後の離しでは、古い速度で滑り出さない。
  await act(async () => {
    now += 500;
    registry.Pan.onTouchesUp({ numberOfTouches: 0 });
    registry.Pan.onFinalize();
  });
  expect(withDecay).not.toHaveBeenCalled();
  nowSpy.mockRestore();
});

test("dragging the remaining finger past the slop discards pinch momentum, tiny release wobble keeps it", async () => {
  const { withDecay } = reanimatedMocks();
  withDecay.mockClear();
  let now = 1000;
  const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  const registry = gestureRegistry();
  const pinchThenDropToOneFinger = () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onTouchesDown({ numberOfTouches: 2 });
    registry.Pinch.onBegin();
    registry.Pinch.onStart({ focalX: 100, focalY: 50 });
    now += 100;
    registry.Pinch.onUpdate({ focalX: 110, focalY: 60, numberOfPointers: 2, scale: 1.2 });
    // 2本→1本(ピンチ終了)。
    registry.Pan.onTouchesUp({ numberOfTouches: 1, changedTouches: [{ x: 108, y: 58 }] });
  };

  // ① 離し際の微小移動(スロップ10px以内)ではサンプルを保持し、慣性が発動する。
  await act(async () => {
    pinchThenDropToOneFinger();
    registry.Pan.onTouchesMove({ numberOfTouches: 1, changedTouches: [{ x: 110, y: 60 }] });
    registry.Pan.onTouchesMove({ numberOfTouches: 1, changedTouches: [{ x: 114, y: 63 }] });
    now += 16;
    registry.Pan.onTouchesUp({ numberOfTouches: 0, changedTouches: [{ x: 114, y: 63 }] });
    registry.Pan.onFinalize();
  });
  expect(withDecay).toHaveBeenCalledTimes(3);

  // ② スロップを超える移動(意図的なドラッグ)ではサンプルを破棄し、慣性は発動しない。
  withDecay.mockClear();
  await act(async () => {
    pinchThenDropToOneFinger();
    registry.Pan.onTouchesMove({ numberOfTouches: 1, changedTouches: [{ x: 110, y: 60 }] });
    registry.Pan.onTouchesMove({ numberOfTouches: 1, changedTouches: [{ x: 135, y: 60 }] });
    now += 16;
    registry.Pan.onTouchesUp({ numberOfTouches: 0, changedTouches: [{ x: 135, y: 60 }] });
    registry.Pan.onFinalize();
  });
  expect(withDecay).not.toHaveBeenCalled();

  // ③ 2本指のままの動き(通常のピンチ/フリック)ではサンプルは破棄されず、慣性が始まる。
  // (mockのwithDecayはscale値を0へ潰すため、しきい値を確実に超えるscale変化を使う。)
  withDecay.mockClear();
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onTouchesDown({ numberOfTouches: 2 });
    registry.Pinch.onBegin();
    registry.Pinch.onStart({ focalX: 100, focalY: 50 });
    now += 100;
    registry.Pinch.onUpdate({ focalX: 110, focalY: 60, numberOfPointers: 2, scale: 2 });
    registry.Pan.onTouchesMove({ numberOfTouches: 2, changedTouches: [{ x: 110, y: 60 }] });
    now += 16;
    registry.Pan.onTouchesUp({ numberOfTouches: 0, changedTouches: [{ x: 110, y: 60 }] });
    registry.Pan.onFinalize();
  });
  expect(withDecay).toHaveBeenCalledTimes(3);
  nowSpy.mockRestore();
});

test("keeps complete two-line text and truncates only its leading side", () => {
  const font = {
    getTextWidth: (text: string) => Array.from(text).length,
  } as Parameters<typeof fitTailTextLines>[1];

  expect(fitTailTextLines("おはよう", font, 5)).toEqual(["おはよう"]);
  expect(fitTailTextLines("abcdefgh", font, 5)).toEqual(["abcde", "fgh"]);
  expect(fitTailTextLines("abcdefghijkl", font, 5)).toEqual(["…defg", "hijkl"]);
  expect(fitTailTextLines("abcdefghijkl", font, 6)).toEqual(["abcdef", "ghijkl"]);
  expect(fitTailTextLines("", font, 5)).toEqual([]);
  expect(fitTailTextLines("a", font, 0)).toEqual(["a"]);
  expect(fitTailTextLines("abc", font, 0)).toEqual(["…", "c"]);
  expect(fitTailTextLines("xe\u0301yz", font, 2)).toEqual(["…", "yz"]);
  expect(fitTailTextLines("x❤️yz", font, 2)).toEqual(["…", "yz"]);
  expect(fitTailTextLines("x👨‍👩‍👧‍👦yz", font, 2)).toEqual(["…", "yz"]);
  expect(fitTailTextLines("x👍🏽yz", font, 2)).toEqual(["…", "yz"]);
  expect(fitTailTextLines("x🇯🇵yz", font, 2)).toEqual(["…", "yz"]);
});

test("finds the visible suffix without measuring every character candidate", () => {
  let measurementCount = 0;
  const font = {
    getTextWidth: (text: string) => {
      measurementCount += 1;
      return Array.from(text).length;
    },
  } as Parameters<typeof fitTailTextLines>[1];

  expect(fitTailTextLines(`${"a".repeat(10_000)}tail`, font, 10)).toEqual([
    "…aaaaaaaaa",
    "aaaaaatail",
  ]);
  expect(measurementCount).toBeLessThan(100);
});

test("keeps the latest message tail visible as streaming content grows", async () => {
  mockSessions = [{
    ...mockDefaultSession,
    lastMessageContent: `${"older ".repeat(100)}FIRST_TAIL`,
  }];
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  expect(screen.getByLabelText(/^…/)).toBeTruthy();
  expect(screen.getByLabelText(/FIRST_TAIL$/)).toBeTruthy();

  mockSessions = [{
    ...mockDefaultSession,
    lastMessageContent: `${"older ".repeat(100)}FIRST_TAIL SECOND_TAIL`,
  }];
  await act(async () => {
    screen.rerender(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  });

  expect(screen.queryByLabelText(/FIRST_TAIL$/)).toBeNull();
  expect(screen.getByLabelText(/SECOND_TAIL$/)).toBeTruthy();
});

test("keeps the latest hard-line tail visible", async () => {
  mockSessions = [{
    ...mockDefaultSession,
    lastMessageContent: `${"older ".repeat(100)}\nLATEST_TAIL`,
  }];

  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  expect(screen.getByLabelText(/LATEST_TAIL$/)).toBeTruthy();
});

test("opens the tapped card session via the shared session history popup", async () => {
  const openSessionHistoryPopup = jest.fn();
  await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={openSessionHistoryPopup} />
  );

  // 1タップ目は選択のみ。
  await act(async () => {
    fireCardTap();
  });
  expect(openSessionHistoryPopup).not.toHaveBeenCalled();

  // 2タップ目でドロワーと同じセッション履歴ポップアップを skia_board 起点で開く。
  await act(async () => {
    fireCardTap();
  });
  expect(openSessionHistoryPopup).toHaveBeenCalledWith({
    sessionId: "session-1",
    directory: "/workspace",
    source: "appserver",
    origin: "skia_board",
  });
});

test("opens a new session from a directory card on its second tap", async () => {
  const onStartNewSessionInDirectory = jest.fn();
  mockSessions = [{
    kind: "directory",
    cardId: "directory:/workspace/projects/bitty",
    directory: "/workspace/projects/bitty",
    name: "Bitty",
    col: 0,
    row: 0,
  } as unknown as typeof mockDefaultSession];
  const screen = await render(
    <SkiaMiniBoardScreen
      onStartNewSessionInDirectory={onStartNewSessionInDirectory}
      openSessionHistoryPopup={jest.fn()}
    />
  );

  expect(screen.getByLabelText("Bitty")).toBeTruthy();
  expect(screen.getByLabelText("/workspace/projects/bitty")).toBeTruthy();
  await act(async () => { fireCardTap(); });
  expect(onStartNewSessionInDirectory).not.toHaveBeenCalled();
  await act(async () => { fireCardTap(); });
  expect(onStartNewSessionInDirectory).toHaveBeenCalledWith("/workspace/projects/bitty");
});

test("tidies board cards without touching the viewport", async () => {
  const screen = await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );

  await fireEvent.press(screen.getByLabelText("ボードメニューを開く"));
  await fireEvent.press(screen.getByLabelText("カードをグリッドに整頓"));

  expect(mockTidyBoard).toHaveBeenCalledTimes(1);
});

test("keeps board menu actions clickable through the shared modal", async () => {
  const screen = await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );

  await fireEvent.press(screen.getByLabelText("ボードメニューを開く"));

  expect(screen.getByLabelText("カードをグリッドに整頓")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("カード文字を大きくする"));
  expect(mockSetBoardCardTextScale).toHaveBeenCalledWith(1.1);
});

test("long-pressing a card asks for confirmation before removing it", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );

  await act(async () => {
    gestureRegistry().LongPress.onStart({ x: 30, y: 30 });
  });

  expect(alertSpy).toHaveBeenCalled();
  expect(mockRemoveBoardSession).not.toHaveBeenCalled();

  // 確認ダイアログの「削除」でボードステートから外す。
  const actions = alertSpy.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
  const removeAction = actions.find((action) => action.text === "削除");
  removeAction?.onPress?.();
  expect(mockRemoveBoardSession).toHaveBeenCalledWith("session-1");
  alertSpy.mockRestore();
});

test("long-pressing a directory card removes its shortcut after confirmation", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  mockSessions = [{
    kind: "directory",
    cardId: "directory:/workspace",
    directory: "/workspace",
    name: "Workspace",
    col: 0,
    row: 0,
  } as unknown as typeof mockDefaultSession];
  await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );

  await act(async () => {
    gestureRegistry().LongPress.onStart({ x: 30, y: 30 });
  });
  const actions = alertSpy.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
  actions.find((action) => action.text === "削除")?.onPress?.();

  expect(mockRemoveBoardDirectory).toHaveBeenCalledWith("/workspace");
  alertSpy.mockRestore();
});

test("shows the shared file menu and removes a file card from it", async () => {
  mockSessions = [{
    kind: "file",
    cardId: "file:/workspace\ndocs/readme.md",
    rootDir: "/workspace",
    path: "docs/readme.md",
    name: "readme.md",
    col: 0,
    row: 0,
  } as unknown as typeof mockDefaultSession];
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  await act(async () => {
    gestureRegistry().LongPress.onStart({ x: 30, y: 30 });
  });

  const menuCall = alertSpy.mock.calls.find((call) => call[0] === "readme.md");
  const actions = (menuCall?.[2] || []) as Array<{ text: string; onPress?: () => void }>;
  actions.find((action) => action.text === "Skiaボードから除外")?.onPress?.();
  expect(mockRemoveBoardFile).toHaveBeenCalledWith("/workspace", "docs/readme.md");
  alertSpy.mockRestore();
});

test("opens a supported file on its second tap without opening the context menu", async () => {
  mockSessions = [{
    kind: "file",
    cardId: "file:/workspace\ntasks/today.checklist",
    rootDir: "/workspace",
    path: "tasks/today.checklist",
    name: "today.checklist",
    col: 0,
    row: 0,
  } as unknown as typeof mockDefaultSession];
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  await act(async () => {
    fireCardTap();
  });
  await act(async () => {
    fireCardTap();
  });

  expect(screen.getByTestId("runner-file-target").props.children).toBe("tasks/today.checklist");
  expect(alertSpy).not.toHaveBeenCalledWith("today.checklist", expect.anything(), expect.anything());
  alertSpy.mockRestore();
});

test("keeps an explicit fallback for unsupported file types on second tap", async () => {
  mockSessions = [{
    kind: "file",
    cardId: "file:/workspace\ndocs/readme.md",
    rootDir: "/workspace",
    path: "docs/readme.md",
    name: "readme.md",
    col: 0,
    row: 0,
  } as unknown as typeof mockDefaultSession];
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  await act(async () => {
    fireCardTap();
  });
  await act(async () => {
    fireCardTap();
  });

  expect(alertSpy).toHaveBeenCalledWith(
    "開けません",
    "readme.md に対応する表示方法がありません。",
  );
  alertSpy.mockRestore();
});

test("shows only transparent navigation controls in the header and adjusts card text", async () => {
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  expect(screen.queryByText("Board")).toBeNull();
  expect(screen.queryByText(/タップで選択/)).toBeNull();
  expect(StyleSheet.flatten(screen.getByLabelText("ナビゲーションを開く").props.style)).toMatchObject({
    width: 44,
    height: 44,
  });
  await fireEvent.press(screen.getByLabelText("ボードメニューを開く"));
  expect(StyleSheet.flatten(screen.getByLabelText("カードをグリッドに整頓").props.style)).toMatchObject({
    minHeight: 44,
  });
  expect(StyleSheet.flatten(screen.getByLabelText("カード文字を小さくする").props.style)).toMatchObject({
    width: 44,
    height: 44,
  });
  expect(StyleSheet.flatten(screen.getByLabelText("カード文字を大きくする").props.style)).toMatchObject({
    width: 44,
    height: 44,
  });
  await fireEvent.press(screen.getByLabelText("カード文字を大きくする"));

  expect(mockSetBoardCardTextScale).toHaveBeenCalledWith(1.1);
});

test("keeps the canvas full bleed while the status pill observes the bottom safe area", async () => {
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  expect(StyleSheet.flatten(screen.getByTestId("skia-board-status-safe-area").props.style)).toMatchObject({
    position: "absolute",
    bottom: 0,
  });
  expect(StyleSheet.flatten(screen.getByTestId("skia-board-status-pill").props.style)).toMatchObject({
    marginBottom: 14,
  });
});

test("renders the four retained vector activities and an ASCII subagent count", async () => {
  mockSessions = [{
    ...mockDefaultSession,
    unread: false,
    activityTrail: [
      { kind: "reading", active: false },
      { kind: "writing", active: false },
      { kind: "web", active: false },
      { kind: "thinking", active: true },
    ],
    subagentLoading: false,
    subagentRunningCount: 1,
    subagentTotalCount: 2,
  }];

  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  const icons = screen.getAllByTestId("skia-icon-path");
  expect(icons).toHaveLength(5);
  expect(icons.map((icon) => icon.props.accessibilityLabel)).toEqual([
    "#94a3b8",
    "#94a3b8",
    "#94a3b8",
    "#f97316",
    "#64748b",
  ]);
  expect(screen.getByTestId("skia-text:1/2")).toBeTruthy();
  expect(screen.queryByTestId("skia-text:× 1/2")).toBeNull();
});

test("shows a moved-or-deleted message instead of file actions for an unavailable card", async () => {
  mockSessions = [{
    kind: "file",
    cardId: "file:/workspace\ndocs/missing.md",
    rootDir: "/workspace",
    path: "docs/missing.md",
    name: "missing.md",
    unavailable: true,
    col: 0,
    row: 0,
  } as unknown as typeof mockDefaultSession];
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  await act(async () => {
    gestureRegistry().LongPress.onStart({ x: 30, y: 30 });
  });

  const messageCall = alertSpy.mock.calls.find((call) => (
    call[0] === "missing.md" && call[1] === "ファイルが削除または移動されました。"
  ));
  expect(messageCall).toBeTruthy();
  const actions = (messageCall?.[2] || []) as Array<{ text: string; onPress?: () => void }>;
  actions.find((action) => action.text === "Skiaボードから除外")?.onPress?.();
  expect(mockRemoveBoardFile).toHaveBeenCalledWith("/workspace", "docs/missing.md");
  alertSpy.mockRestore();
});

test("long-pressing a selected card still opens its context menu", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );

  const registry = gestureRegistry();
  // Panはtouch-downではactiveにならないため、移動許容内の長押しが優先される。
  await act(async () => {
    fireCardTap();
  });
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onBegin({ x: 30, y: 30 });
    registry.LongPress.onStart({ x: 30, y: 30 });
  });

  expect(alertSpy).toHaveBeenCalled();
  expect(registry.Pan.minDistance).toBe(10);
  alertSpy.mockRestore();
});

test("commits the dragged card position back to the board state", async () => {
  await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );

  const registry = gestureRegistry();
  await act(async () => {
    fireCardTap();
  });
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onBegin({ x: 30, y: 30 });
    registry.Pan.onStart();
    registry.Pan.onUpdate({ numberOfPointers: 1, translationX: 40, translationY: 50 });
    registry.Pan.onFinalize();
  });

  expect(mockMoveBoardCard).toHaveBeenCalledTimes(1);
  const [cardId, col, row] = mockMoveBoardCard.mock.calls[0];
  expect(cardId).toBe("session:session-1");
  // (18+40, 18+50) がグリッド単位へ変換されて保存される(cardWidth依存のため値は正のグリッド量)。
  expect(col).toBeGreaterThan(0);
  expect(row).toBeCloseTo(50 / (112 + 18), 5);
});

test("commits the active card coordinates when sessions reorder during a drag", async () => {
  mockSessions = ["a", "b", "c"].map((id, row) => ({
    ...mockSessions[0],
    panelId: `skia_mini_preview_${id}`,
    cardId: `session:${id}`,
    sessionId: id,
    title: id.toUpperCase(),
    row,
  }));
  const screen = await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );

  await act(async () => {
    // Bはrow=1なので、ボード座標(30, 200)で選択・ドラッグを開始する。
    gestureRegistry().Tap.onEnd({ x: 30, y: 200 }, true);
  });
  await act(async () => {
    gestureRegistry().Pan.onTouchesDown({ numberOfTouches: 1 });
    gestureRegistry().Pan.onBegin({ x: 30, y: 200 });
    gestureRegistry().Pan.onStart();
    gestureRegistry().Pan.onUpdate({ numberOfPointers: 1, translationX: 40, translationY: 50 });
  });

  mockSessions = mockSessions.slice(1);
  await act(async () => {
    screen.rerender(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  });
  await act(async () => {
    gestureRegistry().Pan.onFinalize();
  });

  expect(mockMoveBoardCard).toHaveBeenCalledTimes(1);
  const [cardId, col, row] = mockMoveBoardCard.mock.calls[0];
  expect(cardId).toBe("session:b");
  expect(col).toBeGreaterThan(0);
  expect(row).toBeCloseTo(1 + 50 / (112 + 18), 5);
});

test("creates a section by dragging blank board space from the section tool", async () => {
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  await act(async () => {
    fireEvent.press(screen.getByLabelText("セクションを作成"));
  });
  await act(async () => {
    const pan = gestureRegistry().Pan;
    pan.onTouchesDown({ numberOfTouches: 1 });
    pan.onBegin({ x: 350, y: 300 });
    pan.onStart();
    pan.onUpdate({ numberOfPointers: 1, translationX: 160, translationY: 100 });
    pan.onFinalize();
  });

  expect(mockAddBoardSection).toHaveBeenCalledTimes(1);
  expect(mockAddBoardSection.mock.calls[0][0]).toMatchObject({
    label: "セクション",
    ...gridFromSectionRect({ id: "draft", x: 350, y: 300, width: 160, height: 100 }, 270),
    color: "#3b82f6",
    opacity: 0.2,
    borderOnly: false,
  });
  expect(screen.getByLabelText("選択と移動").props.accessibilityState).toEqual({ selected: true });
});

test("does not create a section over a card or after a multi-touch sequence", async () => {
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  const pan = gestureRegistry().Pan;
  await act(async () => {
    fireEvent.press(screen.getByLabelText("セクションを作成"));
  });
  await act(async () => {
    pan.onTouchesDown({ numberOfTouches: 1 });
    pan.onBegin({ x: 30, y: 30 });
    pan.onStart();
    pan.onUpdate({ numberOfPointers: 1, translationX: 120, translationY: 100 });
    pan.onFinalize();
  });
  expect(mockAddBoardSection).not.toHaveBeenCalled();

  await act(async () => {
    pan.onTouchesDown({ numberOfTouches: 1 });
    pan.onBegin({ x: 350, y: 300 });
    pan.onStart();
    pan.onUpdate({ numberOfPointers: 1, translationX: 120, translationY: 100 });
    pan.onTouchesDown({ numberOfTouches: 2 });
    pan.onFinalize();
  });
  expect(mockAddBoardSection).not.toHaveBeenCalled();
});

test("moves and resizes only the selected section", async () => {
  mockSections = [mockSectionAt(300, 250, 200, 150)];
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  const registry = gestureRegistry();
  await act(async () => {
    registry.Tap.onEnd({ x: 380, y: 320 }, true);
  });
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onBegin({ x: 380, y: 320 });
    registry.Pan.onStart();
    registry.Pan.onUpdate({ numberOfPointers: 1, translationX: 40, translationY: 30 });
    registry.Pan.onFinalize();
  });
  expect(mockUpdateBoardSection).toHaveBeenLastCalledWith(
    "section:1",
    gridFromSectionRect({ id: "section:1", x: 340, y: 280, width: 200, height: 150 }, 270)
  );

  mockUpdateBoardSection.mockClear();
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onBegin({ x: 540, y: 430 });
    registry.Pan.onStart();
    registry.Pan.onUpdate({ numberOfPointers: 1, translationX: 60, translationY: 50 });
    registry.Pan.onFinalize();
  });
  expect(mockUpdateBoardSection).toHaveBeenLastCalledWith(
    "section:1",
    gridFromSectionRect({ id: "section:1", x: 340, y: 280, width: 260, height: 200 }, 270)
  );
});

test("restores a moved section when a second pointer turns the drag into a pinch", async () => {
  mockSections = [mockSectionAt(300, 250, 200, 150)];
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  const pan = gestureRegistry().Pan;
  await act(async () => {
    gestureRegistry().Tap.onEnd({ x: 380, y: 320 }, true);
  });
  await act(async () => {
    pan.onTouchesDown({ numberOfTouches: 1 });
    pan.onBegin({ x: 380, y: 320 });
    pan.onStart();
    pan.onUpdate({ numberOfPointers: 1, translationX: 40, translationY: 30 });
    pan.onTouchesDown({ numberOfTouches: 2 });
    pan.onFinalize();
  });
  expect(mockUpdateBoardSection).not.toHaveBeenCalled();

  // 復元済みなら元の右下端(500, 400)からリサイズが始まる。
  await act(async () => {
    pan.onTouchesDown({ numberOfTouches: 1 });
    pan.onBegin({ x: 500, y: 400 });
    pan.onStart();
    pan.onUpdate({ numberOfPointers: 1, translationX: 60, translationY: 50 });
    pan.onFinalize();
  });
  expect(mockUpdateBoardSection).toHaveBeenCalledWith(
    "section:1",
    gridFromSectionRect({ id: "section:1", x: 300, y: 250, width: 260, height: 200 }, 270)
  );
});

test("does not dispose a rendered paragraph when a section label changes", async () => {
  mockSections = [mockSectionAt(300, 250, 200, 150)];
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  mockSections = [{ ...mockSections[0], label: "実装" }];
  await act(async () => {
    screen.rerender(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  });

  expect(screen.getByLabelText("実装")).toBeTruthy();
  expect((globalThis as Record<string, unknown>).__skiaBoardDisposedRenderedParagraphs).toBe(0);
});

test("edits section label, color, opacity, and border-only mode from long press", async () => {
  mockSections = [mockSectionAt(300, 250, 200, 150)];
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  expect(screen.getByLabelText("計画")).toBeTruthy();
  await act(async () => {
    gestureRegistry().LongPress.onStart({ x: 380, y: 320 });
  });
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText("セクションのラベル"), "実装");
  });
  await act(async () => {
    fireEvent.press(screen.getByLabelText("背景色 #22c55e"));
  });
  await act(async () => {
    fireEvent.press(screen.getByLabelText("透明度を上げる"));
  });
  await act(async () => {
    fireEvent.press(screen.getByLabelText("ボーダーのみ"));
  });
  await act(async () => {
    fireEvent.press(screen.getByText("保存"));
  });

  expect(mockUpdateBoardSection).toHaveBeenCalledWith("section:1", {
    label: "実装",
    color: "#22c55e",
    opacity: 0.3,
    borderOnly: true,
  });
});

test("cards receive hits before an overlapping background section", async () => {
  mockSections = [{ ...mockSectionAt(0, 0, 400, 300), label: "背景" }];
  const openSessionHistoryPopup = jest.fn();
  await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={openSessionHistoryPopup} />);
  await act(async () => {
    fireCardTap();
  });
  await act(async () => {
    fireCardTap();
  });
  expect(openSessionHistoryPopup).toHaveBeenCalledTimes(1);
});
