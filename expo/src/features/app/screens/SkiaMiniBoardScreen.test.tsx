import React from "react";
import { Alert, StyleSheet } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { fitTailTextLines, SkiaMiniBoardScreen } from "./SkiaMiniBoardScreen";
import { gridFromSectionRect } from "../utils/skiaBoardSectionGeometry";

// Skia Canvasはjest環境で描画できないため、レイアウトに影響しないスタブへ置換する。
jest.mock("@shopify/react-native-skia", () => {
  const ReactModule = require("react");
  const { View } = require("react-native");
  const Stub = ({ children }: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, children);
  const PathStub = ({ color }: { color: string }) => ReactModule.createElement(View, {
    testID: "skia-icon-path",
    accessibilityLabel: color,
  });
  const TextStub = ({ text }: { text: string }) =>
    ReactModule.createElement(View, { testID: `skia-text:${text}`, accessibilityLabel: text });
  return {
    Canvas: Stub,
    Circle: Stub,
    Group: Stub,
    Line: Stub,
    Path: PathStub,
    RoundedRect: Stub,
    Text: TextStub,
    matchFont: () => ({
      getTextWidth: (text: string) => Array.from(text).length * 5,
      getSize: () => 9,
    }),
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
jest.mock("react-native-reanimated", () => {
  const actualMock = require("react-native-reanimated/mock");
  const ReactModule = require("react");
  return {
    ...actualMock,
    useSharedValue: (init: unknown) => ReactModule.useRef({ value: init }).current,
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
    removeBoardFile: mockRemoveBoardFile,
    hasBoardFile: mockHasBoardFile,
    markBoardFileUnavailable: mockMarkBoardFileUnavailable,
    tidyBoard: mockTidyBoard,
  }),
}));

beforeEach(() => {
  mockMoveBoardCard.mockClear();
  mockAddBoardSection.mockClear();
  mockUpdateBoardSection.mockClear();
  mockRemoveBoardSection.mockClear();
  mockRemoveBoardSession.mockClear();
  mockRemoveBoardFile.mockClear();
  mockHasBoardFile.mockClear();
  mockMarkBoardFileUnavailable.mockClear();
  mockTidyBoard.mockClear();
  mockSetBoardCardTextScale.mockClear();
  mockSessions = [mockDefaultSession];
  mockSections = [];
});

function gestureRegistry() {
  return (globalThis as Record<string, unknown>)
    .__skiaBoardGestureRegistry as Record<string, Record<string, (...args: unknown[]) => unknown>>;
}

function fireCardTap() {
  // カード0は col=0,row=0 → (18, 18) 起点なので (30, 30) のタップで命中する。
  gestureRegistry().Tap.onEnd({ x: 30, y: 30 }, true);
}

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
  const screen = await render(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);

  expect(screen.getByLabelText(/^…/)).toBeTruthy();
  expect(screen.getByLabelText(/FIRST_TAIL$/)).toBeTruthy();

  mockSessions = [{
    ...mockDefaultSession,
    lastMessageContent: `${"older ".repeat(100)}FIRST_TAIL SECOND_TAIL`,
  }];
  await act(async () => {
    screen.rerender(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);
  });

  expect(screen.queryByLabelText(/FIRST_TAIL$/)).toBeNull();
  expect(screen.getByLabelText(/SECOND_TAIL$/)).toBeTruthy();
});

test("opens the tapped card session via the shared session history popup", async () => {
  const openSessionHistoryPopup = jest.fn();
  await render(
    <SkiaMiniBoardScreen openSessionHistoryPopup={openSessionHistoryPopup} />
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

test("tidies board cards without touching the viewport", async () => {
  const screen = await render(
    <SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />
  );

  await fireEvent.press(screen.getByLabelText("ボードメニューを開く"));
  await fireEvent.press(screen.getByLabelText("カードをグリッドに整頓"));

  expect(mockTidyBoard).toHaveBeenCalledTimes(1);
});

test("long-pressing a card asks for confirmation before removing it", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  await render(
    <SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />
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
  await render(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);

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
  const screen = await render(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);

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
  await render(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);

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
  const screen = await render(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);

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
  const screen = await render(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);

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

  const screen = await render(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);

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
  await render(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);

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
    <SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />
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
    <SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />
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
    <SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />
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
    screen.rerender(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);
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
  const screen = await render(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);
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
  const screen = await render(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);
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
  await render(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);
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
  await render(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);
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

test("edits section label, color, opacity, and border-only mode from long press", async () => {
  mockSections = [mockSectionAt(300, 250, 200, 150)];
  const screen = await render(<SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />);
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
  await render(<SkiaMiniBoardScreen openSessionHistoryPopup={openSessionHistoryPopup} />);
  await act(async () => {
    fireCardTap();
  });
  await act(async () => {
    fireCardTap();
  });
  expect(openSessionHistoryPopup).toHaveBeenCalledTimes(1);
});
