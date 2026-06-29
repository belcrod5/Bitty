import { createWebSocketWithOptionalAuth } from "../ws/webSocketAuth";
import { RunnerWebSocketManager } from "./RunnerWebSocketManager";
import type { RunnerWsMessage } from "./types";

jest.mock("../ws/webSocketAuth", () => ({
  createWebSocketWithOptionalAuth: jest.fn(),
}));

const mockCreateWebSocketWithOptionalAuth = jest.mocked(createWebSocketWithOptionalAuth);
const originalWebSocket = global.WebSocket;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: string[] = [];
  closeCalls = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ reason: "client_close" } as CloseEvent);
  }

  closeWithReason(reason: string) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ reason } as CloseEvent);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  message(message: RunnerWsMessage) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

function nextSocket() {
  const socket = new FakeWebSocket();
  mockCreateWebSocketWithOptionalAuth.mockReturnValueOnce(socket as unknown as WebSocket);
  return socket;
}

function createManager() {
  return new RunnerWebSocketManager({
    url: " ws://127.0.0.1:8788/runner-ws ",
    token: " runner-token ",
    appState: "active",
    clientInstanceId: "client-1",
  });
}

function createLegacyUrlManager() {
  return new RunnerWebSocketManager({
    url: " ws://127.0.0.1:8788/codex-ws ",
    token: " runner-token ",
    appState: "active",
    clientInstanceId: "client-1",
  });
}

async function connectReady(manager: RunnerWebSocketManager, socket: FakeWebSocket) {
  const connected = manager.connect();
  socket.open();
  socket.message({
    channel: "control",
    op: "ready",
    payload: {
      connectionId: "conn-1",
      runnerWsConnectionCount: 1,
    },
  });
  await connected;
}

beforeEach(() => {
  global.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  mockCreateWebSocketWithOptionalAuth.mockReset();
});

afterEach(() => {
  global.WebSocket = originalWebSocket;
  jest.useRealTimers();
});

test("snapshot reference is stable between manager updates", () => {
  const manager = createManager();

  const firstSnapshot = manager.getSnapshot();
  expect(manager.getSnapshot()).toBe(firstSnapshot);

  manager.setAppState("inactive");

  const updatedSnapshot = manager.getSnapshot();
  expect(updatedSnapshot).not.toBe(firstSnapshot);
  expect(manager.getSnapshot()).toBe(updatedSnapshot);
});

test("connect is single-flight and waits for control ready", async () => {
  const socket = nextSocket();
  const manager = createManager();

  const firstConnect = manager.connect();
  const secondConnect = manager.connect();
  expect(secondConnect).toBe(firstConnect);
  expect(mockCreateWebSocketWithOptionalAuth).toHaveBeenCalledTimes(1);

  socket.open();
  expect(manager.getSnapshot().connectionState).toBe("handshaking");

  let resolved = false;
  firstConnect.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);

  socket.message({
    channel: "control",
    op: "ready",
    payload: {
      connectionId: "conn-1",
      runnerWsConnectionCount: 1,
    },
  });

  await firstConnect;
  expect(resolved).toBe(true);
  expect(manager.getSnapshot()).toMatchObject({
    connectionState: "ready",
    connectionId: "conn-1",
    runnerWsConnectionCount: 1,
    pendingRequestCount: 0,
  });
});

test("normalizes legacy codex-ws URLs to runner-ws", () => {
  nextSocket();
  const manager = createLegacyUrlManager();

  void manager.connect().catch(() => undefined);

  expect(mockCreateWebSocketWithOptionalAuth).toHaveBeenCalledWith(
    "ws://127.0.0.1:8788/runner-ws",
    "runner-token"
  );
  expect(manager.getSnapshot().url).toBe("ws://127.0.0.1:8788/runner-ws");
});

test("send throws until control ready", async () => {
  const socket = nextSocket();
  const manager = createManager();

  expect(() => {
    manager.send({ channel: "control", op: "ping" });
  }).toThrow("runner_ws_not_ready");

  const connecting = manager.connect();
  socket.open();
  expect(() => {
    manager.send({ channel: "control", op: "ping" });
  }).toThrow("runner_ws_not_ready");

  socket.message({ channel: "control", op: "ready" });
  await connecting;

  manager.send({ channel: "control", op: "ping" });
  expect(JSON.parse(socket.sent[0])).toMatchObject({ channel: "control", op: "ping" });
});

test("subscribers receive only messages matching explicit filter fields", async () => {
  const socket = nextSocket();
  const manager = createManager();
  await connectReady(manager, socket);
  const handler = jest.fn();

  const unsubscribe = manager.subscribe(
    { channel: "llm", op: "rpc", operationId: "op-1", threadId: "thread-1" },
    handler
  );

  socket.message({ channel: "llm", op: "rpc", operationId: "op-2", threadId: "thread-1" });
  socket.message({ channel: "tts", op: "rpc", operationId: "op-1", threadId: "thread-1" });
  socket.message({ channel: "llm", op: "rpc", operationId: "op-1", threadId: "thread-1" });

  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining({ channel: "llm", op: "rpc", operationId: "op-1" })
  );

  unsubscribe();
  socket.message({ channel: "llm", op: "rpc", operationId: "op-1", threadId: "thread-1" });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(manager.getSnapshot().subscriptionCount).toBe(0);
});

test("high-volume feature messages update counters without notifying snapshot subscribers", async () => {
  const socket = nextSocket();
  const manager = createManager();
  await connectReady(manager, socket);
  const snapshotHandler = jest.fn();
  const messageHandler = jest.fn();
  const unsubscribeSnapshot = manager.subscribeSnapshot(snapshotHandler);
  const unsubscribeMessage = manager.subscribe({ channel: "llm", op: "rpc" }, messageHandler);
  snapshotHandler.mockClear();

  manager.send({ channel: "llm", op: "rpc", operationId: "op-1" });
  socket.message({ channel: "llm", op: "rpc", operationId: "op-1" });
  socket.message({ channel: "llm", op: "rpc", operationId: "op-2" });

  expect(messageHandler).toHaveBeenCalledTimes(2);
  expect(snapshotHandler).not.toHaveBeenCalled();
  expect(manager.getSnapshot()).toMatchObject({
    sentCount: 1,
    receivedCount: 3,
  });

  unsubscribeMessage();
  unsubscribeSnapshot();
});

test("subscribers drop llm rpc messages missing explicit operation or session metadata", async () => {
  const socket = nextSocket();
  const manager = createManager();
  await connectReady(manager, socket);
  const handler = jest.fn();

  manager.subscribe(
    { channel: "llm", op: "rpc", operationId: "op-1", sessionId: "session-1" },
    handler
  );

  socket.message({
    channel: "llm",
    op: "rpc",
    sessionId: "session-1",
    payload: { method: "item/agentMessage/delta", params: { delta: "ignored" } },
  });
  socket.message({
    channel: "llm",
    op: "rpc",
    operationId: "op-1",
    payload: { method: "turn/completed", params: { threadId: "thread-1" } },
  });
  socket.message({
    channel: "llm",
    op: "rpc",
    operationId: "op-1",
    sessionId: "session-1",
    payload: { method: "turn/completed", params: { threadId: "thread-1" } },
  });

  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining({
      operationId: "op-1",
      sessionId: "session-1",
      payload: expect.objectContaining({ method: "turn/completed" }),
    })
  );
});

test("control pong updates heartbeat and server status snapshot", async () => {
  const socket = nextSocket();
  const manager = createManager();
  await connectReady(manager, socket);

  socket.message({
    channel: "control",
    op: "pong",
    sessionId: "conn-from-session",
    payload: {
      status: {
        runnerWsConnectionCount: 2,
        turnState: "running",
      },
    },
  });

  expect(manager.getSnapshot()).toMatchObject({
    connectionId: "conn-from-session",
    runnerWsConnectionCount: 2,
    serverStatus: {
      runnerWsConnectionCount: 2,
      turnState: "running",
    },
  });
  expect(manager.getSnapshot().lastPongAt).toEqual(expect.any(Number));
});

test("ready connection sends periodic control ping with client identity", async () => {
  jest.useFakeTimers();
  const socket = nextSocket();
  const manager = createManager();
  await connectReady(manager, socket);

  expect(socket.sent).toHaveLength(0);

  await jest.advanceTimersByTimeAsync(15_000);
  expect(JSON.parse(socket.sent[0])).toMatchObject({
    channel: "control",
    op: "ping",
    payload: {
      clientInstanceId: "client-1",
      connectionId: "conn-1",
      generation: 1,
    },
  });

  await jest.advanceTimersByTimeAsync(5);
  socket.message({
    channel: "control",
    op: "pong",
    payload: {
      clientInstanceId: "client-1",
      connectionId: "conn-1",
      status: {
        runnerWsConnectionCount: 1,
      },
    },
  });

  expect(manager.getSnapshot()).toMatchObject({
    lastPingRttMs: 5,
    consecutiveMissedPingCount: 0,
    runnerWsConnectionCount: 1,
  });
});

test("heartbeat records missed pongs without closing the socket", async () => {
  jest.useFakeTimers();
  const socket = nextSocket();
  const manager = createManager();
  await connectReady(manager, socket);

  await jest.advanceTimersByTimeAsync(15_000);
  await jest.advanceTimersByTimeAsync(15_000);

  expect(socket.closeCalls).toBe(0);
  expect(manager.getSnapshot()).toMatchObject({
    connectionState: "ready",
    missedPingCount: 1,
    consecutiveMissedPingCount: 1,
  });
});

test("request provides a requestId, times out, and cleans up", async () => {
  jest.useFakeTimers();
  const socket = nextSocket();
  const manager = createManager();
  await connectReady(manager, socket);

  const response = manager.request({ channel: "control", op: "ping" }, { timeoutMs: 25 });
  const sent = JSON.parse(socket.sent[0]);
  expect(sent.requestId).toMatch(/^client-1-/);
  expect(manager.getSnapshot().pendingRequestCount).toBe(1);

  const timedOut = expect(response).rejects.toThrow("runner_ws_request_timeout");
  await jest.advanceTimersByTimeAsync(25);

  await timedOut;
  expect(manager.getSnapshot().pendingRequestCount).toBe(0);
});

test("background closes intentionally and active reconnects once", async () => {
  const firstSocket = nextSocket();
  const manager = createManager();
  await connectReady(manager, firstSocket);

  manager.setAppState("inactive");
  expect(firstSocket.closeCalls).toBe(0);
  expect(manager.getSnapshot().appState).toBe("inactive");

  manager.setAppState("background");
  expect(firstSocket.closeCalls).toBe(1);
  expect(manager.getSnapshot().connectionState).toBe("background");

  const secondSocket = nextSocket();
  manager.setAppState("active");
  expect(mockCreateWebSocketWithOptionalAuth).toHaveBeenCalledTimes(2);
  secondSocket.open();
  secondSocket.message({ channel: "control", op: "ready" });
  await Promise.resolve();

  expect(manager.getSnapshot()).toMatchObject({
    appState: "active",
    connectionState: "ready",
    generation: 2,
  });
});

test("inactive app state blocks new start-style messages without closing existing socket", async () => {
  const socket = nextSocket();
  const manager = createManager();
  await connectReady(manager, socket);

  manager.setAppState("inactive");

  expect(() => {
    manager.send({
      channel: "llm",
      op: "rpc",
      operationId: "op-start",
      payload: { jsonrpc: "2.0", id: 1, method: "turn/start" },
    });
  }).toThrow("runner_ws_inactive_start_blocked");
  expect(() => {
    manager.send({
      channel: "tts",
      op: "start",
      operationId: "op-tts",
      payload: { mode: "text", text: "hello" },
    });
  }).toThrow("runner_ws_inactive_start_blocked");

  manager.send({
    channel: "llm",
    op: "rpc",
    operationId: "op-existing",
    payload: { jsonrpc: "2.0", id: 2, method: "turn/interrupt" },
  });

  expect(socket.closeCalls).toBe(0);
  expect(JSON.parse(socket.sent[0])).toMatchObject({
    channel: "llm",
    op: "rpc",
    operationId: "op-existing",
  });
});

test("authentication failure close stops automatic reconnect loop", async () => {
  jest.useFakeTimers();
  const firstSocket = nextSocket();
  const manager = createManager();

  const connecting = manager.connect();
  firstSocket.closeWithReason("Received bad response code from server: 401.");

  await expect(connecting).rejects.toThrow("runner_ws_closed_before_ready");

  expect(manager.getSnapshot()).toMatchObject({
    connectionState: "stopped",
    reconnectCount: 0,
    lastError: "runner_ws_auth_failed: Received bad response code from server: 401.",
  });

  await jest.advanceTimersByTimeAsync(20_000);
  expect(mockCreateWebSocketWithOptionalAuth).toHaveBeenCalledTimes(1);
});
