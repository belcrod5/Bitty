import React from "react";
import { act, render } from "@testing-library/react-native";
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

// ジェスチャ定義のコールバックを捕捉し、テストからタップを直接発火できるようにする。
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
      Simultaneous: (...gestures: unknown[]) => gestures,
    },
    GestureDetector: ({ children }: { children?: React.ReactNode }) => children,
  };
});

jest.mock("../contexts/AppShellContext", () => ({
  useAppShell: () => ({ openDrawer: jest.fn() }),
}));

jest.mock("../hooks/useSkiaMiniChatSessions", () => ({
  useSkiaMiniChatSessions: () => ({
    directorySync: { phase: "idle", completedCount: 0, totalCount: 0, failedCount: 0 },
    hydratingPanelCount: 0,
    panelHydrationErrorCount: 0,
    sessions: [
      {
        panelId: "skia_mini_preview_1",
        sessionId: "session-1",
        directory: "/workspace",
        source: "appserver",
        title: "Title 1",
        directoryName: "Workspace",
        lastMessageContent: "hello",
        updatedAtLabel: "1分前",
        markerColor: "none",
      },
    ],
  }),
}));

function fireCardTap() {
  const registry = (globalThis as Record<string, unknown>)
    .__skiaBoardGestureRegistry as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  // カード0は (18, 18) 起点なので (30, 30) のタップで命中する。
  registry.Tap.onEnd({ x: 30, y: 30 }, true);
}

test("opens the tapped card session via the shared session history popup", async () => {
  const openSessionHistoryPopup = jest.fn();
  await render(
    <SkiaMiniBoardScreen
      onClose={jest.fn()}
      openSessionHistoryPopup={openSessionHistoryPopup}
    />
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
