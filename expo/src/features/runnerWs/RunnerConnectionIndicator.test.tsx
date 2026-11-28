import React, { useEffect } from "react";
import { Keyboard, Pressable, StyleSheet, Text } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { RunnerConnectionIndicator, RunnerConnectionRecovery } from "./RunnerConnectionIndicator";
import type { RunnerWsAppState, RunnerWsConnectionState } from "./types";

let mockConnectionState: RunnerWsConnectionState = "ready";
let mockAppState: RunnerWsAppState = "active";
jest.mock("./RunnerWebSocketContext", () => ({
  useRunnerWebSocketSnapshot: () => ({ connectionState: mockConnectionState, appState: mockAppState }),
}));
beforeEach(() => { mockConnectionState = "ready"; mockAppState = "active"; });

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

describe("connection recovery", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("a short interruption keeps chat mounted and only shows the corner spinner", async () => {
    const mount = jest.fn();
    const unmount = jest.fn();
    function Chat() { useEffect(() => { mount(); return unmount; }, []); return <Text>open chat</Text>; }
    const content = () => <>
      <Chat />
      <RunnerConnectionIndicator enabled connectionInterrupted={false} />
      <RunnerConnectionRecovery enabled><Text>reconnect screen</Text></RunnerConnectionRecovery>
    </>;
    const screen = await render(content());
    mockConnectionState = "reconnecting";
    await screen.rerender(content());
    await act(async () => jest.advanceTimersByTime(9_999));
    expect(screen.getByTestId("runner-connection-indicator")).toBeTruthy();
    expect(screen.queryByText("reconnect screen")).toBeNull();
    mockConnectionState = "ready";
    await screen.rerender(content());
    await act(async () => jest.advanceTimersByTime(10_000));
    expect(screen.queryByText("reconnect screen")).toBeNull();
    expect(mount).toHaveBeenCalledTimes(1);
    expect(unmount).not.toHaveBeenCalled();
  });

  test("sustained outage offers recovery actions and successful WS recovery dismisses it despite stale HTTP status", async () => {
    const retry = jest.fn();
    const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
    const content = () => <>
      <RunnerConnectionIndicator enabled connectionInterrupted />
      <RunnerConnectionRecovery enabled><Pressable onPress={retry}><Text>retry connection</Text></Pressable></RunnerConnectionRecovery>
    </>;
    mockConnectionState = "reconnecting";
    const screen = await render(content());
    await act(async () => jest.advanceTimersByTime(10_000));
    expect(dismiss).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByText("retry connection"));
    expect(retry).toHaveBeenCalledTimes(1);
    mockConnectionState = "ready";
    await screen.rerender(content());
    expect(screen.queryByText("retry connection")).toBeNull();
    expect(screen.getByTestId("runner-connection-indicator")).toBeTruthy();
    dismiss.mockRestore();
  });

  test("retry state changes do not restart the sustained interruption deadline", async () => {
    mockConnectionState = "reconnecting";
    const content = <RunnerConnectionRecovery enabled><Text>reconnect screen</Text></RunnerConnectionRecovery>;
    const screen = await render(content);
    await act(async () => jest.advanceTimersByTime(5_000));
    mockConnectionState = "connecting";
    await screen.rerender(<RunnerConnectionRecovery enabled><Text>reconnect screen</Text></RunnerConnectionRecovery>);
    await act(async () => jest.advanceTimersByTime(5_000));
    expect(screen.getByText("reconnect screen")).toBeTruthy();
  });

  test.each(["disabled", "background"])("%s resets the deadline before a new foreground interruption", async (reason) => {
    mockConnectionState = "reconnecting";
    const content = (enabled = true) => <RunnerConnectionRecovery enabled={enabled}><Text>reconnect screen</Text></RunnerConnectionRecovery>;
    const screen = await render(content());
    await act(async () => jest.advanceTimersByTime(5_000));
    if (reason === "background") mockAppState = "background";
    await screen.rerender(content(reason !== "disabled"));
    await act(async () => jest.advanceTimersByTime(20_000));
    expect(screen.queryByText("reconnect screen")).toBeNull();
    mockAppState = "active";
    await screen.rerender(content());
    await act(async () => jest.advanceTimersByTime(9_999));
    expect(screen.queryByText("reconnect screen")).toBeNull();
    await act(async () => jest.advanceTimersByTime(1));
    expect(screen.getByText("reconnect screen")).toBeTruthy();
  });

  test("a stopped socket still exposes manual recovery", async () => {
    mockConnectionState = "stopped";
    const screen = await render(<RunnerConnectionRecovery enabled><Text>reconnect screen</Text></RunnerConnectionRecovery>);
    await act(async () => jest.advanceTimersByTime(10_000));
    expect(screen.getByText("reconnect screen")).toBeTruthy();
  });
});
