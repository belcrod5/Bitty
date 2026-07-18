import { useEffect } from "react";
import { render } from "@testing-library/react-native";
import { AppState } from "react-native";

import { createWebSocketWithOptionalAuth } from "../ws/webSocketAuth";
import { RunnerWebSocketProvider } from "./RunnerWebSocketContext";
import { RunnerWebSocketManager } from "./RunnerWebSocketManager";

jest.mock("../ws/webSocketAuth", () => ({
  createWebSocketWithOptionalAuth: jest.fn(),
  isWebSocketForCloudflareRunner: jest.requireActual("../ws/webSocketAuth")
    .isWebSocketForCloudflareRunner,
}));

const mockCreateWebSocketWithOptionalAuth = jest.mocked(createWebSocketWithOptionalAuth);
const originalAppState = AppState.currentState;

beforeEach(() => {
  mockCreateWebSocketWithOptionalAuth.mockReset();
});

afterEach(() => {
  AppState.currentState = originalAppState;
  jest.restoreAllMocks();
});

test("admits a child connection effect before provider options are applied", async () => {
  AppState.currentState = "active";
  const socket = {
    close: jest.fn(),
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onclose: null as ((event: CloseEvent) => void) | null,
  } as unknown as WebSocket;
  mockCreateWebSocketWithOptionalAuth.mockReturnValue(socket);
  const manager = new RunnerWebSocketManager({
    bootstrapReady: false,
    url: "",
    token: "",
    appState: "unknown",
    clientInstanceId: "provider-ordering-test",
  });
  let childConnection: Promise<void> | undefined;

  function ConnectOnMount() {
    useEffect(() => {
      childConnection = manager.connect();
    }, []);
    return null;
  }

  await render(
    <RunnerWebSocketProvider
      bootstrapReady
      url="wss://runner.example.com/runner-ws"
      token="runner-token"
      cloudflareRunnerUrl="https://runner.example.com"
      cloudflareAccessClientId="access-id"
      cloudflareAccessClientSecret="access-secret"
      manager={manager}
    >
      <ConnectOnMount />
    </RunnerWebSocketProvider>
  );

  expect(childConnection).toBeDefined();
  expect(mockCreateWebSocketWithOptionalAuth).toHaveBeenCalledTimes(1);
  expect(manager.getSnapshot().lastError).not.toBe("runner_ws_bootstrap_pending");
  socket.onopen?.({} as Event);
  socket.onmessage?.({
    data: JSON.stringify({ channel: "control", op: "ready" }),
  } as MessageEvent);

  await expect(childConnection).resolves.toBeUndefined();
  expect(manager.getSnapshot().connectionState).toBe("ready");
});

test("applies restored runner authentication as one provider update", async () => {
  AppState.currentState = "active";
  const socket = { close: jest.fn() } as unknown as WebSocket;
  mockCreateWebSocketWithOptionalAuth.mockReturnValue(socket);
  const manager = new RunnerWebSocketManager({
    bootstrapReady: false,
    url: "",
    token: "",
    appState: "active",
    clientInstanceId: "provider-test",
  });
  const initialProps = {
    bootstrapReady: false,
    url: "",
    token: "",
    cloudflareRunnerUrl: "",
    cloudflareAccessClientId: "",
    cloudflareAccessClientSecret: "",
    manager,
  };
  const view = await render(
    <RunnerWebSocketProvider {...initialProps}>
      <></>
    </RunnerWebSocketProvider>
  );

  expect(mockCreateWebSocketWithOptionalAuth).not.toHaveBeenCalled();

  await view.rerender(
    <RunnerWebSocketProvider
      {...initialProps}
      bootstrapReady
      url="wss://runner.example.com/runner-ws"
      token="runner-token"
      cloudflareRunnerUrl="https://runner.example.com"
      cloudflareAccessClientId="access-id"
      cloudflareAccessClientSecret="access-secret"
    >
      <></>
    </RunnerWebSocketProvider>
  );

  expect(mockCreateWebSocketWithOptionalAuth).toHaveBeenCalledTimes(1);
  expect(mockCreateWebSocketWithOptionalAuth).toHaveBeenCalledWith(
    "wss://runner.example.com/runner-ws",
    "runner-token",
    {
      runnerUrl: "https://runner.example.com",
      clientId: "access-id",
      clientSecret: "access-secret",
    }
  );
});
