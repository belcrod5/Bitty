import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { RunnerWsConnectionStatus } from "./RunnerWsConnectionStatus";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("./RunnerWebSocketContext", () => ({
  useRunnerWebSocketSnapshot: () => ({
    connectionState: "ready",
    lastPingRttMs: 12,
    runnerWsConnectionCount: 1,
    clientInstanceId: "client-1",
    connectionId: "connection-1",
    generation: 1,
    pendingRequestCount: 0,
    subscriptionCount: 0,
    lastPongAt: Date.now(),
  }),
}));

test("shows and copies a materialized session history reference", async () => {
  const onCopy = jest.fn();
  const screen = await render(
    <RunnerWsConnectionStatus
      sessionBackendId="claude"
      sessionId="session-1"
      sessionMaterialized
      onCopySessionHistoryReference={onCopy}
    />,
  );

  await fireEvent.press(screen.getByLabelText("セッション同期状態を開く"));
  expect(screen.getByText("claude")).toBeTruthy();
  expect(screen.getByText("session-1")).toBeTruthy();
  const copyButton = screen.getByLabelText("履歴参照をコピー");
  expect(copyButton).not.toBeDisabled();
  await fireEvent.press(copyButton);
  expect(onCopy).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test("does not allow copying a local draft session", async () => {
  const onCopy = jest.fn();
  const screen = await render(
    <RunnerWsConnectionStatus
      sessionBackendId="codex"
      sessionId="local-draft-id"
      sessionMaterialized={false}
      onCopySessionHistoryReference={onCopy}
    />,
  );

  await fireEvent.press(screen.getByLabelText("セッション同期状態を開く"));
  expect(screen.getByText("未実体化")).toBeTruthy();
  const copyButton = screen.getByLabelText("履歴参照をコピー");
  expect(copyButton).toBeDisabled();
  await fireEvent.press(copyButton);
  expect(onCopy).not.toHaveBeenCalled();
  await screen.unmount();
});
