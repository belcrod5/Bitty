import React from "react";
import { StyleSheet } from "react-native";
import { render } from "@testing-library/react-native";
import { RunnerConnectionIndicator } from "./RunnerConnectionIndicator";
import type { RunnerWsConnectionState } from "./types";

let mockConnectionState: RunnerWsConnectionState = "ready";
jest.mock("./RunnerWebSocketContext", () => ({
  useRunnerWebSocketSnapshot: () => ({ connectionState: mockConnectionState }),
}));
beforeEach(() => { mockConnectionState = "ready"; });

test("HTTP interruption shows a tiny animated, touch-through icon even while WebSocket is ready", async () => {
  const screen = await render(<RunnerConnectionIndicator enabled connectionInterrupted />);
  const overlay = screen.getByTestId("runner-connection-indicator");
  expect(overlay.props.pointerEvents).toBe("none");
  expect(StyleSheet.flatten(overlay.props.style)).toMatchObject({ position: "absolute", top: 0, left: 0, zIndex: 20_000 });
  const spinner = screen.getByLabelText("Runner に接続中");
  expect(spinner.props.animating).not.toBe(false);
  expect(StyleSheet.flatten(spinner.props.style)).toMatchObject({ width: 12, height: 12, transform: [{ scale: 0.6 }] });
  await screen.rerender(<RunnerConnectionIndicator enabled connectionInterrupted={false} />);
  expect(screen.queryByTestId("runner-connection-indicator")).toBeNull();
});

test.each<RunnerWsConnectionState>(["connecting", "handshaking", "reconnecting"])("shows existing WebSocket %s state", async (state) => {
  mockConnectionState = state;
  const screen = await render(<RunnerConnectionIndicator enabled connectionInterrupted={false} />);
  expect(screen.getByTestId("runner-connection-indicator")).toBeTruthy();
  await screen.rerender(<RunnerConnectionIndicator enabled={false} connectionInterrupted />);
  expect(screen.queryByTestId("runner-connection-indicator")).toBeNull();
});

test.each<RunnerWsConnectionState>(["idle", "ready", "background", "stopped"])("does not animate for WebSocket %s alone", async (state) => {
  mockConnectionState = state;
  const screen = await render(<RunnerConnectionIndicator enabled connectionInterrupted={false} />);
  expect(screen.queryByTestId("runner-connection-indicator")).toBeNull();
});
