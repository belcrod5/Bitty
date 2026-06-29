import { createWebSocketWithOptionalAuth } from "../../ws/webSocketAuth";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type {
  RunnerWsConnectionSnapshot,
  RunnerWsMessage,
  RunnerWsMessageFilter,
} from "../../runnerWs/types";
import { startCodexAppServerTurn } from "./turn";

jest.mock("../../ws/webSocketAuth", () => ({
  createWebSocketWithOptionalAuth: jest.fn(),
}));

const mockCreateWebSocketWithOptionalAuth = jest.mocked(createWebSocketWithOptionalAuth);
const originalWebSocket = global.WebSocket;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
}

type FakeSubscription = {
  filter: RunnerWsMessageFilter;
  handler: (message: RunnerWsMessage) => void;
  active: boolean;
};

class FakeRunnerWebSocketManager {
  send = jest.fn();
  disconnect = jest.fn();
  unsubscribeCalls = 0;
  private subscriptions: FakeSubscription[] = [];
  private snapshotHandlers: Array<() => void> = [];
  private resolveConnect: (() => void) | null = null;
  private connectPromise = new Promise<void>((resolve) => {
    this.resolveConnect = resolve;
  });
  private snapshot: RunnerWsConnectionSnapshot = {
    connectionState: "idle",
    appState: "active",
    clientInstanceId: "client-1",
    generation: 0,
    pendingRequestCount: 0,
    subscriptionCount: 0,
    url: "ws://127.0.0.1:8788/runner-ws",
    readyState: FakeWebSocket.CLOSED,
    connected: false,
    reconnectCount: 0,
  };

  connect = jest.fn(() => this.connectPromise);

  getSnapshot = () => ({
    ...this.snapshot,
    subscriptionCount: this.subscriptions.filter((subscription) => subscription.active).length,
  });

  subscribe = (
    filter: RunnerWsMessageFilter,
    handler: (message: RunnerWsMessage) => void
  ) => {
    const subscription = { filter, handler, active: true };
    this.subscriptions.push(subscription);
    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      this.unsubscribeCalls += 1;
    };
  };

  subscribeSnapshot = (handler: () => void) => {
    this.snapshotHandlers.push(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.unsubscribeCalls += 1;
      this.snapshotHandlers = this.snapshotHandlers.filter((item) => item !== handler);
    };
  };

  becomeReady() {
    this.snapshot = {
      ...this.snapshot,
      connectionState: "ready",
      readyState: FakeWebSocket.OPEN,
      connected: true,
      generation: this.snapshot.generation + 1,
    };
    for (const handler of this.snapshotHandlers) {
      handler();
    }
    this.resolveConnect?.();
  }

  dropConnection() {
    this.snapshot = {
      ...this.snapshot,
      connectionState: "reconnecting",
      readyState: FakeWebSocket.CLOSED,
      connected: false,
    };
    for (const handler of this.snapshotHandlers) {
      handler();
    }
  }

  emit(message: RunnerWsMessage) {
    for (const subscription of this.subscriptions) {
      if (!subscription.active) continue;
      if (!filterMatches(subscription.filter, message)) continue;
      subscription.handler(message);
    }
  }
}

function filterMatches(filter: RunnerWsMessageFilter, message: RunnerWsMessage) {
  return (
    (filter.channel === undefined || filter.channel === message.channel) &&
    (filter.op === undefined || filter.op === message.op) &&
    (filter.requestId === undefined || filter.requestId === message.requestId) &&
    (filter.operationId === undefined || filter.operationId === message.operationId) &&
    (filter.sessionId === undefined || filter.sessionId === message.sessionId) &&
    (filter.threadId === undefined || filter.threadId === message.threadId)
  );
}

function createTurn(manager: FakeRunnerWebSocketManager) {
  return startCodexAppServerTurn({
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
    wsToken: "runner-token",
    traceId: "trace-1",
    inputText: "hello",
    cwd: "/tmp/project",
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    onApprovalRequest: jest.fn(() => "approve_once"),
  });
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function lastSent(manager: FakeRunnerWebSocketManager) {
  const calls = manager.send.mock.calls;
  return calls[calls.length - 1]?.[0] as RunnerWsMessage;
}

function respondToLastRequest(
  manager: FakeRunnerWebSocketManager,
  result: unknown,
  threadId?: string
) {
  const outbound = lastSent(manager);
  const payload = outbound.payload as { id?: number };
  manager.emit({
    channel: "llm",
    op: "rpc",
    operationId: outbound.operationId,
    sessionId: outbound.sessionId,
    ...(threadId ? { threadId } : {}),
    payload: {
      id: payload.id,
      result,
    },
  });
}

function emitTurnNotification(
  manager: FakeRunnerWebSocketManager,
  outbound: RunnerWsMessage,
  method: string,
  params: Record<string, unknown>
) {
  manager.emit({
    channel: "llm",
    op: "rpc",
    operationId: outbound.operationId,
    sessionId: outbound.sessionId,
    threadId: String(params.threadId || outbound.threadId || ""),
    payload: {
      method,
      params,
    },
  });
}

beforeEach(() => {
  global.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  mockCreateWebSocketWithOptionalAuth.mockReset();
});

afterEach(() => {
  global.WebSocket = originalWebSocket;
});

test("manager mode waits for ready and sends initialize without creating a direct socket", async () => {
  const manager = new FakeRunnerWebSocketManager();

  const session = createTurn(manager);

  expect(mockCreateWebSocketWithOptionalAuth).not.toHaveBeenCalled();
  expect(manager.connect).toHaveBeenCalledTimes(1);
  expect(manager.send).not.toHaveBeenCalled();

  manager.becomeReady();
  await flushPromises();

  expect(manager.send).toHaveBeenCalledTimes(1);
  const outbound = lastSent(manager);
  expect(outbound).toMatchObject({
    channel: "llm",
    op: "rpc",
    operationId: expect.any(String),
    sessionId: expect.any(String),
    payload: {
      method: "initialize",
    },
  });
  expect((outbound.payload as { id?: number }).id).toEqual(expect.any(Number));
  expect((outbound.payload as { id?: number }).id).not.toBe(1);

  manager.dropConnection();
  await expect(session.promise).rejects.toThrow("runner-ws disconnected");
});

test("manager mode resolves JSON-RPC responses delivered through subscription", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const session = createTurn(manager);

  manager.becomeReady();
  await flushPromises();

  respondToLastRequest(manager, {});
  await flushPromises();
  expect((lastSent(manager).payload as any).method).toBe("thread/start");
  respondToLastRequest(manager, { thread: { id: "thread-1" } }, "thread-1");

  await flushPromises();
  expect((lastSent(manager).payload as any).method).toBe("thread/read");
  expect(lastSent(manager)).toMatchObject({ threadId: "thread-1" });
  respondToLastRequest(manager, { thread: { id: "thread-1", status: "idle" } }, "thread-1");

  await flushPromises();
  expect((lastSent(manager).payload as any).method).toBe("turn/start");
  expect(lastSent(manager)).toMatchObject({ threadId: "thread-1" });
  respondToLastRequest(manager, { turn: { id: "turn-1" } }, "thread-1");

  await flushPromises();
  const outbound = lastSent(manager);
  manager.emit({
    channel: "llm",
    op: "rpc",
    operationId: outbound.operationId,
    sessionId: outbound.sessionId,
    threadId: "thread-1",
    payload: {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: {
          id: "item-1",
          type: "agentMessage",
          text: "hello back",
        },
      },
    },
  });
  manager.emit({
    channel: "llm",
    op: "rpc",
    operationId: outbound.operationId,
    sessionId: outbound.sessionId,
    threadId: "thread-1",
    payload: {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
        },
      },
    },
  });

  await expect(session.promise).resolves.toMatchObject({
    threadId: "thread-1",
    turnId: "turn-1",
    reply: "hello back",
  });
});

test("manager mode delivers idless turn notifications with runner-ws metadata to callbacks and result", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const onDelta = jest.fn();
  const onEvent = jest.fn();
  const session = startCodexAppServerTurn({
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
    wsToken: "runner-token",
    traceId: "trace-1",
    inputText: "hello",
    cwd: "/tmp/project",
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    onApprovalRequest: jest.fn(() => "approve_once"),
    onDelta,
    onEvent,
  });

  manager.becomeReady();
  await flushPromises();

  respondToLastRequest(manager, {});
  await flushPromises();
  respondToLastRequest(manager, { thread: { id: "thread-1" } }, "thread-1");
  await flushPromises();
  respondToLastRequest(manager, { thread: { id: "thread-1", status: "idle" } }, "thread-1");
  await flushPromises();
  respondToLastRequest(manager, { turn: { id: "turn-1" } }, "thread-1");
  await flushPromises();

  const turnStartOutbound = lastSent(manager);
  expect(turnStartOutbound).toMatchObject({
    channel: "llm",
    op: "rpc",
    operationId: expect.any(String),
    sessionId: expect.any(String),
    threadId: "thread-1",
  });

  emitTurnNotification(manager, turnStartOutbound, "item/started", {
    threadId: "thread-1",
    item: {
      id: "agent-item-1",
      type: "agentMessage",
    },
  });
  emitTurnNotification(manager, turnStartOutbound, "item/agentMessage/delta", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    delta: "hello ",
  });
  emitTurnNotification(manager, turnStartOutbound, "item/agentMessage/delta", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    delta: "back",
  });
  emitTurnNotification(manager, turnStartOutbound, "turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
    },
  });

  await expect(session.promise).resolves.toMatchObject({
    threadId: "thread-1",
    turnId: "turn-1",
    reply: "hello back",
  });
  expect(onDelta).toHaveBeenNthCalledWith(
    1,
    "hello ",
    expect.objectContaining({ itemId: "agent-item-1", delta: "hello " })
  );
  expect(onDelta).toHaveBeenNthCalledWith(
    2,
    "back",
    expect.objectContaining({ itemId: "agent-item-1", delta: "back" })
  );
  expect(onEvent).toHaveBeenCalledWith(
    "turn/completed",
    expect.objectContaining({
      threadId: "thread-1",
      turn: expect.objectContaining({ id: "turn-1", status: "completed" }),
    })
  );
});

test("manager cleanup unsubscribes without disconnecting singleton socket", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const session = createTurn(manager);

  manager.becomeReady();
  await flushPromises();
  manager.dropConnection();

  await expect(session.promise).rejects.toThrow("runner-ws disconnected");
  expect(manager.unsubscribeCalls).toBe(2);
  expect(manager.disconnect).not.toHaveBeenCalled();
});
