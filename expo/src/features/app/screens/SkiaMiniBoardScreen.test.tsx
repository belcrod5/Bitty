import React from "react";
import { Alert } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { SkiaMiniBoardScreen } from "./SkiaMiniBoardScreen";

// Skia Canvasはjest環境で描画できないため、レイアウトに影響しないスタブへ置換する。
jest.mock("@shopify/react-native-skia", () => {
  const ReactModule = require("react");
  const { View } = require("react-native");
  const Stub = ({ children }: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, children);
  return {
    Canvas: Stub,
    Circle: Stub,
    Group: Stub,
    Line: Stub,
    RoundedRect: Stub,
    Text: Stub,
    matchFont: () => ({ getTextWidth: () => 10 }),
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
jest.mock("../components/RunnerFileViewer", () => ({ RunnerFileViewer: () => null }));
jest.mock("../components/WorkspaceFileRenameDialog", () => ({ WorkspaceFileRenameDialog: () => null }));
jest.mock("../components/WorkspaceTextFileEditor", () => ({ WorkspaceTextFileEditor: () => null }));

const mockMoveBoardCard = jest.fn();
const mockRemoveBoardSession = jest.fn();
const mockRemoveBoardFile = jest.fn();
const mockHasBoardFile = jest.fn(() => true);
const mockMarkBoardFileUnavailable = jest.fn();
const mockTidyBoard = jest.fn();
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
  col: 0,
  row: 0,
};
let mockSessions = [mockDefaultSession];

jest.mock("../hooks/useSkiaMiniChatSessions", () => ({
  useSkiaMiniChatSessions: () => ({
    directorySync: { phase: "idle", completedCount: 0, totalCount: 0, failedCount: 0 },
    hydratingPanelCount: 0,
    panelHydrationErrorCount: 0,
    sessions: mockSessions,
    items: mockSessions,
    moveBoardCard: mockMoveBoardCard,
    removeBoardSession: mockRemoveBoardSession,
    removeBoardFile: mockRemoveBoardFile,
    hasBoardFile: mockHasBoardFile,
    markBoardFileUnavailable: mockMarkBoardFileUnavailable,
    tidyBoard: mockTidyBoard,
  }),
}));

beforeEach(() => {
  mockMoveBoardCard.mockClear();
  mockRemoveBoardSession.mockClear();
  mockRemoveBoardFile.mockClear();
  mockHasBoardFile.mockClear();
  mockMarkBoardFileUnavailable.mockClear();
  mockTidyBoard.mockClear();
  mockSessions = [mockDefaultSession];
});

function gestureRegistry() {
  return (globalThis as Record<string, unknown>)
    .__skiaBoardGestureRegistry as Record<string, Record<string, (...args: unknown[]) => unknown>>;
}

function fireCardTap() {
  // カード0は col=0,row=0 → (18, 18) 起点なので (30, 30) のタップで命中する。
  gestureRegistry().Tap.onEnd({ x: 30, y: 30 }, true);
}

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

test("suppresses the remove dialog while holding a drag-armed card", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  await render(
    <SkiaMiniBoardScreen openSessionHistoryPopup={jest.fn()} />
  );

  const registry = gestureRegistry();
  // 選択済みカードに触れている間(ドラッグ待機)は長押し削除を発火させない。
  await act(async () => {
    fireCardTap();
  });
  await act(async () => {
    registry.Pan.onTouchesDown({ numberOfTouches: 1 });
    registry.Pan.onBegin({ x: 30, y: 30 });
    registry.LongPress.onStart({ x: 30, y: 30 });
  });

  expect(alertSpy).not.toHaveBeenCalled();
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
    registry.Pan.onUpdate({ numberOfPointers: 1, translationX: 40, translationY: 50 });
    registry.Pan.onFinalize();
  });

  expect(mockMoveBoardCard).toHaveBeenCalledTimes(1);
  const [cardId, col, row] = mockMoveBoardCard.mock.calls[0];
  expect(cardId).toBe("session:session-1");
  // (18+40, 18+50) がグリッド単位へ変換されて保存される(cardWidth依存のため値は正のグリッド量)。
  expect(col).toBeGreaterThan(0);
  expect(row).toBeCloseTo(50 / (154 + 18), 5);
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
  expect(row).toBeCloseTo(1 + 50 / (154 + 18), 5);
});
