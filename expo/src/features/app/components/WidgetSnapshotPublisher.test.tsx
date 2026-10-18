import React from "react";
import { AppState } from "react-native";
import { act, render } from "@testing-library/react-native";
import { WidgetSnapshotPublisher } from "./WidgetSnapshotPublisher";

let mockCredentials = { runnerUrl: "https://runner", runnerToken: "token" };
let mockSnapshot = { connected: true, generation: 1, appState: "active" };
let mockDiagnostics = { codexCliStatusFetchedAtMs: 1, codexAuthSwitching: false };
const mockActivate = jest.fn(async (_url: string, _token: string) => undefined);
const mockRefresh = jest.fn(async (_url: string, _token: string) => true);
const mockHandlers = new Map<string, () => void>();
const mockRequest = jest.fn();
const mockManager = { request: mockRequest, subscribe: ({ op }: { op: string }, handler: () => void) => {
  mockHandlers.set(op, handler); return () => mockHandlers.delete(op);
} };
jest.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => ({ activateSource: (url: string, token: string) => mockActivate(url, token),
  refreshSnapshot: (url: string, token: string) => mockRefresh(url, token) }) }));
jest.mock("../contexts/ChatScreenContext", () => ({ useChatScreen: () => mockCredentials }));
jest.mock("../contexts/ChatDiagnosticsContext", () => ({ useChatDiagnostics: () => mockDiagnostics }));
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketSnapshot: () => mockSnapshot, useRunnerWebSocketManager: () => mockManager,
}));
const advance = async () => { await act(async () => { jest.advanceTimersByTime(600); }); };
beforeEach(() => {
  jest.useFakeTimers(); mockActivate.mockClear(); mockRefresh.mockClear(); mockRequest.mockClear(); mockHandlers.clear();
  AppState.currentState = "active";
  mockCredentials = { runnerUrl: "https://runner", runnerToken: "token" };
  mockSnapshot = { connected: true, generation: 1, appState: "active" };
  mockDiagnostics = { codexCliStatusFetchedAtMs: 1, codexAuthSwitching: false };
});
afterEach(() => jest.useRealTimers());

test("foreground uses the same native snapshot fetch as background, without fetching history", async () => {
  const screen = await render(<WidgetSnapshotPublisher ready />);
  await advance();
  expect(mockActivate).toHaveBeenCalledWith("https://runner", "token");
  expect(mockRefresh).toHaveBeenCalledWith("https://runner", "token");
  expect(mockRequest).not.toHaveBeenCalled();
  await act(async () => { mockHandlers.get("voice.task-checklist.changed")?.(); mockHandlers.get("sessions_active_changed")?.(); });
  await advance();
  expect(mockRefresh).toHaveBeenCalledTimes(2);
  screen.unmount();
});

test("background hydration and an unready bootstrap cannot replace native downloaded snapshots", async () => {
  AppState.currentState = "background";
  mockSnapshot = { ...mockSnapshot, appState: "unknown" };
  const screen = await render(<WidgetSnapshotPublisher ready={false} />);
  mockCredentials = { runnerUrl: "https://other", runnerToken: "new" };
  await screen.rerender(<WidgetSnapshotPublisher ready />);
  await advance();
  expect(mockActivate).not.toHaveBeenCalled(); expect(mockRefresh).not.toHaveBeenCalled();
  AppState.currentState = "active"; mockSnapshot = { ...mockSnapshot, appState: "active" };
  await screen.rerender(<WidgetSnapshotPublisher ready={false} />);
  await advance();
  expect(mockActivate).not.toHaveBeenCalled(); expect(mockRefresh).not.toHaveBeenCalled();
  screen.unmount();
});

test("an offline Runner change activates and invalidates source independently of a WebSocket connection", async () => {
  const screen = await render(<WidgetSnapshotPublisher ready />);
  await advance(); mockActivate.mockClear(); mockRefresh.mockClear();
  mockSnapshot = { ...mockSnapshot, connected: false };
  mockCredentials = { runnerUrl: "https://other", runnerToken: "new" };
  await screen.rerender(<WidgetSnapshotPublisher ready />);
  await advance();
  expect(mockActivate).toHaveBeenCalledWith("https://other", "new");
  expect(mockRefresh).not.toHaveBeenCalled();
  screen.unmount();
});

test("does not start a late queued refresh after the app is backgrounded", async () => {
  const screen = await render(<WidgetSnapshotPublisher ready />);
  AppState.currentState = "background";
  await advance();
  expect(mockRefresh).not.toHaveBeenCalled();
  screen.unmount();
});
