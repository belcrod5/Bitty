import React from "react";
import { Alert, Platform, StyleSheet } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { fitTailTextLines, placeOrchestratorActivities, SkiaMiniBoardScreen } from "./SkiaMiniBoardScreen";
import { gridFromSectionRect } from "../utils/skiaBoardSectionGeometry";
import { VisualThemeProvider } from "../theme/VisualThemeContext";
import { VISUAL_THEMES } from "../theme/visualThemes";
import { setPendingPushVoiceOrchestratorId } from "../utils/pushApprovalNotifications";

let mockRunningSessionCount: number | null = 0;
jest.mock("../hooks/useReduceMotionEnabled", () => ({ useReduceMotionEnabled: () => true }));
jest.mock("../hooks/useRegisteredDirectoryActiveSessionCount", () => ({
  useRegisteredDirectoryActiveSessionCount: () => mockRunningSessionCount,
}));

jest.mock("../components/CodexStatusSummaryMenu", () => ({
  CodexStatusSummaryMenu: ({ compact }: { compact?: boolean }) => {
    const ReactModule = require("react");
    const { Text } = require("react-native");
    return ReactModule.createElement(Text, { testID: "codex-status-summary-menu", accessibilityLabel: String(compact) }, "75%\n50%");
  },
}));

const mockPersistViewport = jest.fn();
const mockMarkViewportInteraction = jest.fn();
jest.mock("../hooks/useSkiaBoardViewportPersistence", () => ({
  SKIA_BOARD_MIN_SCALE: 0.25,
  SKIA_BOARD_MAX_SCALE: 2.5,
  useSkiaBoardViewportPersistence: () => ({
    persistViewport: mockPersistViewport,
    markViewportInteraction: mockMarkViewportInteraction,
  }),
}));

// Skia Canvasはjest環境で描画できないため、レイアウトに影響しないスタブへ置換する。
jest.mock("@shopify/react-native-skia", () => {
  const ReactModule = require("react");
  const { View } = require("react-native");
  const Stub = ({ children }: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, children);
  // NativeのCanvasはchildrenを別React rootで描画し、外側Contextを継承しない。
  // standardのProviderを挟んで同じ境界を再現し、Canvas外で解決したthemeだけを検証する。
  const CanvasStub = ({ children }: { children?: React.ReactNode }) => {
    const { VisualThemeProvider: DefaultThemeProvider } = require("../theme/VisualThemeContext");
    return ReactModule.createElement(
      DefaultThemeProvider,
      { themeId: "standard", onSelectTheme: () => undefined },
      ReactModule.createElement(View, null, children),
    );
  };
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
  const createPictureStub = (cb: (canvas: unknown) => void, bounds: unknown) => {
    const recorded = { texts: [] as string[], iconColors: [] as string[] };
    const target = globalThis as Record<string, unknown>;
    const pictureBounds = target.__skiaBoardPictureBounds as unknown[] | undefined;
    target.__skiaBoardPictureBounds = [...(pictureBounds || []), bounds];
    cb({
      save: () => undefined,
      restore: () => undefined,
      translate: () => undefined,
      clipRect: () => undefined,
      clipRRect: () => undefined,
      drawRRect: (_rect: unknown, paint: { color?: string }) => {
        const target = globalThis as Record<string, unknown>;
        const colors = target.__skiaBoardRRectColors as string[] | undefined;
        target.__skiaBoardRRectColors = [...(colors || []), String(paint.color)];
      },
      drawCircle: (x: number, y: number) => {
        const target = globalThis as Record<string, unknown>;
        const centers = target.__skiaBoardCircleCenters as Array<{ x: number; y: number }> | undefined;
        target.__skiaBoardCircleCenters = [...(centers || []), { x, y }];
      },
      drawLine: () => undefined,
      drawImageRect: (_image: unknown, _source: unknown, destination: unknown) => {
        const target = globalThis as Record<string, unknown>;
        const rects = target.__skiaBoardImageRects as unknown[] | undefined;
        target.__skiaBoardImageRects = [...(rects || []), destination];
      },
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
    BlurMask: Stub,
    Canvas: CanvasStub,
    Circle: Stub,
    Group: Stub,
    Line: Stub,
    Path: PathStub,
    Picture: PictureStub,
    SweepGradient: Stub,
    vec: (x: number, y: number) => ({ x, y }),
    useImage: () => (globalThis as Record<string, unknown>).__skiaBoardTestImage || null,
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
      Data: { fromBase64: (base64: string) => ({ base64, dispose: () => undefined }) },
      Image: { MakeImageFromEncoded: (data: { base64: string }) => {
        if (data.base64 === "bad") return null;
        const image = { width: () => 20, height: () => 20, dispose: jest.fn() };
        const target = globalThis as Record<string, unknown>;
        const images = target.__skiaBoardActivityImages as Array<typeof image> | undefined;
        target.__skiaBoardActivityImages = [...(images || []), image];
        return image;
      } },
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
          quadTo: () => undefined,
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

jest.mock("../keyboardController", () => {
  const ReactModule = require("react");
  const { View } = require("react-native");
  return {
    KeyboardAvoidingView: ({ children }: { children?: React.ReactNode }) => (
      ReactModule.createElement(View, null, children)
    ),
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
      target.__skiaBoardFrameCallback ||= callback;
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
  useAppShell: () => ({ activeScreen: "skia_board", openDrawer: jest.fn() }),
}));
const mockBoardVoiceHandlers = new Map<string, (message: { payload: unknown }) => void>();
const mockBoardVoiceRequest = jest.fn(async () => ({ op: "voice.orchestrators.list.result", payload: {
  orchestrators: [{ id: "main", name: "メイン", icon: "", unreadCount: 0 }], selectedId: "main",
} }));
const mockBoardVoiceManager = {
  request: mockBoardVoiceRequest,
  subscribe: ({ op }: { op: string }, handler: (message: { payload: unknown }) => void) => {
    mockBoardVoiceHandlers.set(op, handler);
    return () => { mockBoardVoiceHandlers.delete(op); };
  },
};
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketManager: () => mockBoardVoiceManager,
  useRunnerWebSocketSnapshot: () => ({ connected: true, generation: 1 }),
}));
jest.mock("./VoiceConversationScreen", () => ({
  VoiceConversationScreen: ({ onClose, initialOrchestratorId }: { onClose: () => void; initialOrchestratorId?: string }) => {
    const ReactModule = require("react");
    const { TouchableOpacity } = require("react-native");
    return ReactModule.createElement(TouchableOpacity, {
      testID: "voice-conversation-screen",
      accessibilityLabel: initialOrchestratorId,
      onPress: onClose,
    });
  },
}));
jest.mock("../contexts/ChatScreenContext", () => ({
  useChatScreen: () => ({
    runnerUrl: "http://localhost:8787",
    runnerToken: "token",
    sanitizeTextForTts: (text: string) => text,
    handleAssistantAudioButtonPress: jest.fn(),
  }),
}));
jest.mock("../contexts/ConversationContext", () => ({
  useConversation: () => ({
    registeredDirectories: [{ path: "/workspace", displayName: "Workspace" }],
  }),
}));
jest.mock("../contexts/SkiaBoardContext", () => ({
  useSkiaBoard: () => ({
    renameFile: mockRenameBoardFile,
    markFileUnavailable: mockMarkBoardFileUnavailable,
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
jest.mock("../components/WorkspaceTextFileEditor", () => {
  const ReactModule = require("react");
  const { Text } = require("react-native");
  return {
    WorkspaceTextFileEditor: ({ target }: { target?: { path?: string } | null }) => (
      target ? ReactModule.createElement(Text, { testID: "text-editor-target" }, target.path) : null
    ),
  };
});

const mockMoveBoardCard = jest.fn();
const mockAddBoardSection = jest.fn();
const mockUpdateBoardSection = jest.fn();
const mockRemoveBoardSection = jest.fn();
const mockRemoveBoardSession = jest.fn();
const mockRemoveBoardDirectory = jest.fn();
const mockRemoveBoardFile = jest.fn();
const mockHasBoardFile = jest.fn(() => true);
const mockMarkBoardFileUnavailable = jest.fn();
const mockRenameBoardFile = jest.fn();
const mockUpdateBoardCardAppearance = jest.fn();
const mockTidyBoard = jest.fn();
const mockSetBoardCardTextScale = jest.fn();
const mockDefaultSession = {
  kind: "session" as const,
  backendId: "claude",
  cardId: "session:session-1",
  panelId: "skia_mini_preview_session-1",
  sessionId: "session-1",
  directory: "/workspace",
  source: "appserver" as const,
  title: "Title 1",
  directoryName: "Workspace",
  lastMessageContent: "hello",
  updatedAtLabel: "1分前",
  markerColor: "none" as const,
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
    renameBoardFile: mockRenameBoardFile,
    updateBoardCardAppearance: mockUpdateBoardCardAppearance,
    tidyBoard: mockTidyBoard,
  }),
}));

beforeEach(() => {
  (globalThis as Record<string, unknown>).__skiaBoardFrameCallback = null;
  mockRunningSessionCount = 0;
  mockBoardVoiceHandlers.clear();
  mockBoardVoiceRequest.mockReset();
  mockBoardVoiceRequest.mockResolvedValue({ op: "voice.orchestrators.list.result", payload: {
    orchestrators: [{ id: "main", name: "メイン", icon: "", unreadCount: 0 }], selectedId: "main",
  } });
  (globalThis as Record<string, unknown>).__skiaBoardParagraphStyles = [];
  (globalThis as Record<string, unknown>).__skiaBoardRRectColors = [];
  (globalThis as Record<string, unknown>).__skiaBoardCircleCenters = [];
  (globalThis as Record<string, unknown>).__skiaBoardImageRects = [];
  (globalThis as Record<string, unknown>).__skiaBoardPictureBounds = [];
  (globalThis as Record<string, unknown>).__skiaBoardTestImage = null;
  (globalThis as Record<string, unknown>).__skiaBoardActivityImages = [];
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
  mockRenameBoardFile.mockClear();
  mockUpdateBoardCardAppearance.mockClear();
  mockTidyBoard.mockClear();
  mockSetBoardCardTextScale.mockClear();
  mockPersistViewport.mockClear();
  mockMarkViewportInteraction.mockClear();
  mockSessions = [mockDefaultSession];
  mockSections = [];
});

test("places each actor on the verified target and retains parallel work after one completion", () => {
  const ref = { backendId: "claude", nativeSessionId: "session-1" };
  const orchestrators = [
    { id: "one", name: "一", icon: "" },
    { id: "two", name: "二", icon: "" },
  ];
  const activities = [
    { id: "a", orchestratorId: "one", sessionRef: ref, kind: "run", status: "completed", label: "会話中", startedAt: 1 },
    { id: "b", orchestratorId: "one", sessionRef: ref, kind: "tool", status: "running", label: "読み込み中", startedAt: 2 },
    { id: "c", orchestratorId: "two", sessionRef: ref, kind: "run", status: "running", label: "会話中", startedAt: 3 },
    { id: "d", orchestratorId: null, kind: "http", status: "running", label: "取得中", startedAt: 4 },
  ];
  const placement = placeOrchestratorActivities(activities, [mockDefaultSession], orchestrators);
  expect(placement.cards.get(mockDefaultSession.cardId)?.map((badge) => [badge.key, badge.count, badge.status]))
    .toEqual([["one", 2, "running"], ["two", 1, "running"]]);
  expect(placement.global).toHaveLength(1);
  expect(placement.global[0].orchestrator.icon).toBe("");

  const remaining = placeOrchestratorActivities(activities.filter(({ id }) => id !== "a"),
    [mockDefaultSession], orchestrators);
  expect(remaining.cards.get(mockDefaultSession.cardId)?.find(({ key }) => key === "one")?.count).toBe(1);
  expect(placeOrchestratorActivities(activities, [{ ...mockDefaultSession, backendId: "codex" }], orchestrators)
    .global.reduce((sum, badge) => sum + badge.count, 0)).toBe(4);
  expect(placeOrchestratorActivities(activities, [], orchestrators).global
    .reduce((sum, badge) => sum + badge.count, 0)).toBe(4);
});

test("activity pushes draw floating card badge and whole-board frame without adding cards", async () => {
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()}
    openSessionHistoryPopup={jest.fn()} />);
  await act(async () => mockBoardVoiceHandlers.get("voice.unread.changed")?.({ payload: {
    orchestrators: [{ id: "one", name: "一", icon: "" }, { id: "two", name: "二", icon: "" }],
  } }));
  await act(async () => mockBoardVoiceHandlers.get("orchestrator_activity_updated")?.({ payload: {
    instanceId: "server", revision: 1, activities: [
      { id: "a", orchestratorId: "one", sessionRef: { backendId: "claude", nativeSessionId: "session-1" },
        kind: "tool", status: "running", label: "読み込み中", startedAt: 1 },
      { id: "b", orchestratorId: "two", kind: "http", status: "completed", label: "取得中", startedAt: 2 },
    ],
  } }));
  expect(screen.getByTestId("skia-text:読み込み中")).toBeTruthy();
  expect(screen.getByTestId("skia-board-activity-frame")).toBeTruthy();
  expect(screen.getByTestId("skia-board-activity-actor-one")).toBeTruthy();
  expect(screen.getByTestId("skia-board-activity-actor-two")).toBeTruthy();
  expect(screen.getByTestId("skia-board-activity-status").props.children.join("")).toBe("読み込み中 · 実行中");
  const bounds = (globalThis as Record<string, unknown>).__skiaBoardPictureBounds as
    Array<{ x: number; y: number; width: number; height: number }>;
  const floatingBadge = ((globalThis as Record<string, unknown>).__skiaBoardCircleCenters as
    Array<{ x: number; y: number }>).find((center) => center.y === -3);
  expect(floatingBadge).toBeDefined();
  expect(bounds.some((rect) => floatingBadge && rect.x <= floatingBadge.x - 18 &&
    rect.y <= floatingBadge.y - 18 && rect.x + rect.width >= floatingBadge.x + 28)).toBe(true);
  await act(async () => mockBoardVoiceHandlers.get("orchestrator_activity_updated")?.({ payload: {
    instanceId: "server", revision: 2, activities: [
      { id: "a", orchestratorId: "one", sessionRef: { backendId: "claude", nativeSessionId: "session-1" },
        kind: "tool", status: "running", label: "読み込み中", startedAt: 1 },
    ],
  } }));
  expect(screen.getByTestId("skia-board-activity-frame")).toBeTruthy();
  expect(screen.queryByTestId("skia-board-activity-actor-two")).toBeNull();
  expect(mockSessions).toHaveLength(1);
});

test("card images update, fall back after decode failure, and release old images", async () => {
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()}
    openSessionHistoryPopup={jest.fn()} />);
  const emitMetadata = async (icon: string) => act(async () => mockBoardVoiceHandlers.get("voice.unread.changed")?.({
    payload: { orchestrators: [{ id: "one", name: "一", icon }] },
  }));
  const emitActivity = async (revision: number, activities: unknown[]) => act(async () =>
    mockBoardVoiceHandlers.get("orchestrator_activity_updated")?.({ payload: {
      instanceId: "server", revision, activities,
    } }));
  await emitMetadata("data:image/png;base64,first");
  await emitActivity(1, [{ id: "a", orchestratorId: "one",
    sessionRef: { backendId: "claude", nativeSessionId: "session-1" },
    kind: "tool", status: "running", label: "読み込み中", startedAt: 1 }]);
  const images = () => (globalThis as Record<string, unknown>).__skiaBoardActivityImages as Array<{ dispose: jest.Mock }>;
  expect(images()).toHaveLength(1);
  await emitMetadata("data:image/png;base64,second");
  expect(images()).toHaveLength(2);
  expect(images()[0].dispose).toHaveBeenCalledTimes(1);
  await emitMetadata("data:image/png;base64,bad");
  expect(screen.getByTestId("skia-text:一")).toBeTruthy();
  expect(images()[1].dispose).toHaveBeenCalledTimes(1);
  await emitMetadata("data:image/png;base64,third");
  expect(images()).toHaveLength(3);
  await emitActivity(2, []);
  expect(images()[2].dispose).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test("mic badge uses latest canonical voice counts and a Push opens its orchestrator", async () => {
  let resolveOld!: (value: unknown) => void;
  mockBoardVoiceRequest.mockImplementationOnce(() => new Promise((resolve) => {
    resolveOld = resolve as (value: unknown) => void;
  }));
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()}
    openSessionHistoryPopup={jest.fn()} voicePlayback={{
      synthesizeSpeechStream: jest.fn(async () => undefined),
      stopTtsPlayback: jest.fn(async () => undefined),
      isTtsPlaybackActive: false, ttsUiStatus: "idle",
    }} />);
  await act(async () => mockBoardVoiceHandlers.get("voice.unread.changed")?.({ payload: {
    orchestrators: [{ id: "main", unreadCount: 1 }, { id: "other", unreadCount: 2 }],
  } }));
  expect(screen.getByTestId("skia-board-voice-unread")).toBeTruthy();
  expect(screen.getByText("3")).toBeTruthy();
  await act(async () => resolveOld({ op: "voice.orchestrators.list.result", payload: {
    orchestrators: [{ id: "main", unreadCount: 1 }], selectedId: "main",
  } }));
  expect(screen.getByText("3")).toBeTruthy();
  await act(async () => setPendingPushVoiceOrchestratorId("other"));
  expect(screen.getByTestId("voice-conversation-screen").props.accessibilityLabel).toBe("other");
});

test("overlays voice input while keeping the board mounted", async () => {
  const screen = await render(<SkiaMiniBoardScreen
    onStartNewSessionInDirectory={jest.fn()}
    openSessionHistoryPopup={jest.fn()}
    voicePlayback={{
      synthesizeSpeechStream: jest.fn(async () => undefined),
      stopTtsPlayback: jest.fn(async () => undefined),
      isTtsPlaybackActive: false,
      ttsUiStatus: "idle",
    }}
  />);
  await fireEvent.press(screen.getByTestId("skia-board-voice-conversation"));
  expect(screen.getByTestId("skia-board-usage-pill")).toBeTruthy();
  const voice = screen.getByTestId("voice-conversation-screen");
  const header = screen.getByTestId("skia-board-header-safe-area");
  const siblings = header.parent?.children ?? [];
  expect(siblings.indexOf(header)).toBeLessThan(siblings.indexOf(voice));
  expect(StyleSheet.flatten(header.props.style).zIndex).toBeUndefined();
  await fireEvent.press(screen.getByTestId("voice-conversation-screen"));
  expect(screen.queryByTestId("voice-conversation-screen")).toBeNull();
  expect(screen.getByTestId("skia-board-usage-pill")).toBeTruthy();
});

test("persists viewport reset through the local viewport owner", async () => {
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  await fireEvent.press(screen.getByLabelText("ボードメニューを開く"));
  await fireEvent.press(screen.getByLabelText("表示位置とズームをリセット"));
  expect(mockPersistViewport).toHaveBeenCalledWith(0, 0, 1);
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

test("passes the selected board theme across the isolated Skia Canvas root", async () => {
  const screen = await render(
    <VisualThemeProvider themeId="standard" onSelectTheme={jest.fn()}>
      <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
    </VisualThemeProvider>,
  );
  (globalThis as Record<string, unknown>).__skiaBoardParagraphStyles = [];
  (globalThis as Record<string, unknown>).__skiaBoardRRectColors = [];

  await screen.rerender(
    <VisualThemeProvider themeId="cyberpunk" onSelectTheme={jest.fn()}>
      <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
    </VisualThemeProvider>,
  );

  const theme = VISUAL_THEMES.cyberpunk;
  const rrectColors = (globalThis as Record<string, unknown>).__skiaBoardRRectColors as string[];
  const paragraphStyles = (globalThis as Record<string, unknown>)
    .__skiaBoardParagraphStyles as Array<{ color?: string }>;
  expect(rrectColors).toEqual(expect.arrayContaining([
    theme.board.cardSurface,
    theme.board.cardBorder,
  ]));
  expect(paragraphStyles).toEqual(expect.arrayContaining([
    expect.objectContaining({ color: theme.board.textPrimary }),
    expect.objectContaining({ color: theme.board.textMuted }),
  ]));
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
    backendId: "claude",
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
  expect(screen.queryByTestId("skia-text:NEW SESSION")).toBeNull();
  expect((globalThis as Record<string, unknown>).__skiaBoardCircleCenters).toEqual([]);
  expect(screen.getAllByTestId("skia-icon-path").map((icon) => icon.props.accessibilityLabel)).toContain("#65b9f2");
  await act(async () => { fireCardTap(); });
  expect(onStartNewSessionInDirectory).not.toHaveBeenCalled();
  await act(async () => { fireCardTap(); });
  expect(onStartNewSessionInDirectory).toHaveBeenCalledWith("/workspace/projects/bitty");
});

test("file cards show their containing directory and a shaded default file icon", async () => {
  mockSessions = [{
    kind: "file",
    cardId: "file:/workspace\ndocs/readme.md",
    rootDir: "/workspace",
    path: "docs/readme.md",
    name: "readme.md",
    col: 0,
    row: 0,
  } as unknown as typeof mockDefaultSession];
  const screen = await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );

  expect(screen.getByTestId("skia-text:readme.md")).toBeTruthy();
  expect(screen.getByTestId("skia-text:/workspace/docs")).toBeTruthy();
  expect(screen.queryByTestId("skia-text:docs/readme.md")).toBeNull();
  expect(screen.queryByTestId("skia-text:FILE")).toBeNull();
  expect((globalThis as Record<string, unknown>).__skiaBoardCircleCenters).toEqual([]);
  expect(screen.getAllByTestId("skia-icon-path").map((icon) => icon.props.accessibilityLabel)).toContain("#91c9f3");
});

test("resource card taps, long presses and drags stop at the shorter card edge", async () => {
  const onStartNewSessionInDirectory = jest.fn();
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
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={onStartNewSessionInDirectory} openSessionHistoryPopup={jest.fn()} />
  );
  const registry = gestureRegistry();

  await act(async () => {
    registry.Tap.onEnd({ x: 30, y: 108 }, true);
    registry.Tap.onEnd({ x: 30, y: 108 }, true);
    registry.LongPress.onStart({ x: 30, y: 108 });
  });
  expect(onStartNewSessionInDirectory).not.toHaveBeenCalled();
  expect(alertSpy).not.toHaveBeenCalled();

  await act(async () => {
    registry.Tap.onEnd({ x: 30, y: 88 }, true);
  });
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onBegin({ x: 30, y: 108 });
    registry.Pan.onStart();
    registry.Pan.onUpdate({ numberOfPointers: 1, translationX: 20, translationY: 20 });
    registry.Pan.onFinalize();
  });
  expect(onStartNewSessionInDirectory).not.toHaveBeenCalled();
  expect(alertSpy).not.toHaveBeenCalled();
  expect(mockMoveBoardCard).not.toHaveBeenCalled();

  // The outside pan moved the camera by (20, 20), so the selected card moved with it.
  await act(async () => {
    registry.Tap.onEnd({ x: 50, y: 108 }, true);
  });
  await act(async () => {
    registry.LongPress.onStart({ x: 50, y: 108 });
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onBegin({ x: 50, y: 108 });
    registry.Pan.onStart();
    registry.Pan.onUpdate({ numberOfPointers: 1, translationX: 20, translationY: 20 });
    registry.Pan.onFinalize();
  });
  expect(onStartNewSessionInDirectory).toHaveBeenCalledWith("/workspace");
  expect(alertSpy).toHaveBeenCalled();
  expect(mockMoveBoardCard).toHaveBeenCalledTimes(1);
  alertSpy.mockRestore();
});

test("tidies board cards only after confirmation without touching the viewport", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );

  await fireEvent.press(screen.getByLabelText("ボードメニューを開く"));
  await fireEvent.press(screen.getByLabelText("カードをグリッドに整頓"));

  expect(screen.queryByLabelText("カードをグリッドに整頓")).toBeNull();
  expect(mockTidyBoard).not.toHaveBeenCalled();
  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(alertSpy).toHaveBeenCalledWith(
    "カードを整頓",
    "すべてのカードをグリッドに整頓しますか?",
    [
      { text: "キャンセル", style: "cancel" },
      { text: "整頓", onPress: expect.any(Function) },
    ]
  );
  const buttons = alertSpy.mock.calls[0]?.[2];
  buttons?.[0]?.onPress?.();
  expect(mockTidyBoard).not.toHaveBeenCalled();
  buttons?.[1]?.onPress?.();
  expect(mockTidyBoard).toHaveBeenCalledTimes(1);
  expect(mockPersistViewport).not.toHaveBeenCalled();
  alertSpy.mockRestore();
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
  const boardActions = alertSpy.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
  await act(async () => {
    boardActions.find((action) => action.text === "ファイル操作")?.onPress?.();
  });
  const matchingCalls = alertSpy.mock.calls.filter((call) => call[0] === "readme.md");
  const menuCall = matchingCalls[matchingCalls.length - 1];
  const actions = (menuCall?.[2] || []) as Array<{ text: string; onPress?: () => void }>;
  actions.find((action) => action.text === "Skiaボードから除外")?.onPress?.();
  expect(mockRemoveBoardFile).toHaveBeenCalledWith("/workspace", "docs/readme.md");
  alertSpy.mockRestore();
});

test("customizes a file card without renaming the Runner file", async () => {
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
  const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify({
      basePath: "/workspace",
      entries: [
        { kind: "file", name: "docs.png", path: "/Users/me/Pictures/docs.png" },
        { kind: "file", name: "notes.txt", path: "/Users/me/Pictures/notes.txt" },
      ],
    }),
  } as Response);
  const screen = await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );

  await act(async () => {
    gestureRegistry().LongPress.onStart({ x: 30, y: 30 });
  });
  const actions = alertSpy.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
  await act(async () => {
    actions.find((action) => action.text === "表示をカスタマイズ")?.onPress?.();
  });
  await fireEvent.changeText(screen.getByLabelText("ボード上の表示名"), "Docs");
  expect(screen.getByLabelText("画像を探すディレクトリ")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("カード画像"));
  await waitFor(() => expect(screen.getByLabelText("docs.pngを画像として選択")).toBeTruthy());
  expect(fetchSpy).toHaveBeenCalledWith(
    expect.stringContaining("path=%2Fworkspace"),
    expect.any(Object)
  );
  expect(screen.queryByLabelText("notes.txtを画像として選択")).toBeNull();
  await fireEvent.press(screen.getByLabelText("docs.pngを画像として選択"));
  expect(screen.getAllByText("/Users/me/Pictures/docs.png")).not.toHaveLength(0);
  await fireEvent.press(screen.getByLabelText("選択した画像を解除"));
  expect(screen.queryByLabelText("選択した画像を解除")).toBeNull();
  await fireEvent.press(screen.getByLabelText("カード画像"));
  await waitFor(() => expect(screen.getByLabelText("docs.pngを画像として選択")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("docs.pngを画像として選択"));
  await fireEvent.press(screen.getByText("保存"));

  expect(mockUpdateBoardCardAppearance).toHaveBeenCalledWith(
    "file:/workspace\ndocs/readme.md",
    { displayNameOverride: "Docs", imagePath: "/Users/me/Pictures/docs.png" }
  );
  alertSpy.mockRestore();
  fetchSpy.mockRestore();
});

test("keeps a legacy image path until its directory is selected again", async () => {
  mockSessions = [{
    kind: "file",
    cardId: "file:/workspace\nreadme.md",
    rootDir: "/workspace",
    path: "readme.md",
    name: "readme.md",
    imagePath: "/outside/legacy.png",
    col: 0,
    row: 0,
  } as unknown as typeof mockDefaultSession];
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );

  await act(async () => {
    gestureRegistry().LongPress.onStart({ x: 30, y: 30 });
  });
  const actions = alertSpy.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
  await act(async () => {
    actions.find((action) => action.text === "表示をカスタマイズ")?.onPress?.();
  });

  expect(screen.getByText("登録解除済み: /outside")).toBeTruthy();
  expect(screen.getAllByText("/outside/legacy.png")).not.toHaveLength(0);
  await fireEvent.press(screen.getByLabelText("画像を探すディレクトリ"));
  await fireEvent.press(screen.getByText("Workspace"));
  expect(screen.queryByText("/outside/legacy.png")).toBeNull();
  alertSpy.mockRestore();
});

test("loads a configured image from the authenticated Runner media endpoint", async () => {
  mockSessions = [{
    kind: "directory",
    cardId: "directory:/workspace",
    directory: "/workspace",
    name: "Workspace",
    imagePath: "/Users/me/Pictures/board.png",
    col: 0,
    row: 0,
  } as unknown as typeof mockDefaultSession];
  const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as Response);
  (globalThis as Record<string, unknown>).__skiaBoardTestImage = {
    width: () => 200,
    height: () => 100,
  };

  const screen = await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );

  expect((globalThis as Record<string, unknown>).__skiaBoardImageRects).toEqual(expect.arrayContaining([
    { x: 12, y: expect.any(Number), width: 52, height: 26 },
  ]));
  expect(screen.getByTestId("skia-text:Workspace")).toBeTruthy();
  expect(screen.getByTestId("skia-text:/workspace")).toBeTruthy();

  await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
    "http://localhost:8787/files/media?path=%2FUsers%2Fme%2FPictures%2Fboard.png&rootDir=%2FUsers%2Fme%2FPictures",
    expect.objectContaining({ headers: { authorization: "Bearer token" } })
  ));
  fetchSpy.mockRestore();
});

test("aborts an unused image request and retries it after the card is shown again", async () => {
  mockSessions = [{
    kind: "directory",
    cardId: "directory:/workspace",
    directory: "/workspace",
    name: "Workspace",
    imagePath: "/Users/me/Pictures/pending.png",
    col: 0,
    row: 0,
  } as unknown as typeof mockDefaultSession];
  let firstSignal: AbortSignal | undefined;
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation((_url, init) => {
    firstSignal ||= init?.signal || undefined;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });

  const first = await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
  await first.unmount();
  expect(firstSignal?.aborted).toBe(true);

  const second = await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  await second.unmount();
  fetchSpy.mockRestore();
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
    cardId: "file:/workspace\ndocs/data.json",
    rootDir: "/workspace",
    path: "docs/data.json",
    name: "data.json",
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
    "data.json に対応する表示方法がありません。",
  );
  alertSpy.mockRestore();
});

test("opens a Markdown file in the text editor on its second tap", async () => {
  mockSessions = [{
    kind: "file",
    cardId: "file:/workspace\ndocs/readme.md",
    rootDir: "/workspace",
    path: "docs/readme.md",
    name: "readme.md",
    col: 0,
    row: 0,
  } as unknown as typeof mockDefaultSession];
  const screen = await render(
    <SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />
  );

  await act(async () => {
    fireCardTap();
  });
  await act(async () => {
    fireCardTap();
  });

  expect(screen.getByTestId("text-editor-target").props.children).toBe("docs/readme.md");
});

test("floats circular navigation controls over the full-height canvas", async () => {
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  expect(screen.queryByText("Board")).toBeNull();
  expect(screen.queryByText(/タップで選択/)).toBeNull();
  const headerStyle = StyleSheet.flatten(
    screen.getByTestId("skia-board-header-safe-area").props.style
  );
  expect(headerStyle).toMatchObject({
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  });
  expect(headerStyle.backgroundColor).toBeUndefined();
  expect(screen.getByTestId("skia-board-header-safe-area").props.pointerEvents).toBe("box-none");
  const header = screen.getByTestId("skia-board-header");
  expect(header.props.pointerEvents).toBe("box-none");
  expect(StyleSheet.flatten(header.props.style)).toMatchObject({
    justifyContent: "space-between",
  });
  expect(header.children).toHaveLength(2);
  expect(header.children.map((child) => (
    typeof child === "string" ? child : child.props.accessibilityLabel
  ))).toEqual(["ナビゲーションを開く", "ボードメニューを開く"]);
  for (const label of ["ナビゲーションを開く", "ボードメニューを開く"]) {
    expect(StyleSheet.flatten(screen.getByLabelText(label).props.style)).toMatchObject({
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: "#e8eef6",
    });
  }
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

test("centers the three-row usage and original tools on one bottom anchor", async () => {
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);

  expect(StyleSheet.flatten(screen.getByTestId("skia-board-tools-safe-area").props.style)).toMatchObject({
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
  });
  expect(screen.getByTestId("skia-board-footer-row").props.pointerEvents).toBe("box-none");
  expect(StyleSheet.flatten(screen.getByTestId("skia-board-footer-row").props.style)).toMatchObject({
    minHeight: 54,
    marginBottom: 12,
    alignItems: "center",
    justifyContent: "center",
  });
  expect(StyleSheet.flatten(screen.getByTestId("skia-board-usage-safe-area").props.style)).toMatchObject({
    position: "absolute",
    right: 14,
    bottom: 0,
    top: 0,
    justifyContent: "center",
  });
  expect(StyleSheet.flatten(screen.getByTestId("skia-board-usage-pill").props.style)).toMatchObject({
    paddingVertical: 3,
  });
  expect(screen.getByTestId("codex-status-summary-menu").props.accessibilityLabel).toBe("true");
  expect(screen.getByTestId("skia-board-running-session-count").props.children).toBe(0);
  expect(screen.queryByTestId("skia-board-status-pill")).toBeNull();
});

test("shows the live session count from the shared active-session hook", async () => {
  mockRunningSessionCount = 3;
  const screen = await render(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  expect(screen.getByTestId("skia-board-running-session-count").props.children).toBe(3);
  expect(screen.getByLabelText("実行中のセッション 3件")).toBeTruthy();
  mockRunningSessionCount = null;
  await screen.rerender(<SkiaMiniBoardScreen onStartNewSessionInDirectory={jest.fn()} openSessionHistoryPopup={jest.fn()} />);
  expect(screen.getByTestId("skia-board-running-session-count").props.children).toBe("--");
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
  const displayTitle = `${"🙂".repeat(199)}…`;
  mockSessions = [{ ...mockDefaultSession, title: displayTitle }];
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

  expect(alertSpy).toHaveBeenCalledWith(
    "カードを削除",
    `「${displayTitle}」をボードから外しますか?\n外したセッションは自動では再追加されません。`,
    expect.any(Array),
  );
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
