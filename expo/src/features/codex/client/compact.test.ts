import { createWebSocketWithOptionalAuth } from "../../ws/webSocketAuth";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type {
  RunnerWsConnectionSnapshot,
  RunnerWsMessage,
  RunnerWsMessageFilter,
} from "../../runnerWs/types";
import { compactCodexAppServerThread } from "./compact";

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

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function sentMessages(manager: FakeRunnerWebSocketManager) {
  return manager.send.mock.calls.map((call) => call[0] as RunnerWsMessage);
}

function sentMethods(manager: FakeRunnerWebSocketManager) {
  return sentMessages(manager).map((message) => (
    typeof message.payload === "object" && message.payload
      ? String((message.payload as Record<string, unknown>).method || "")
      : ""
  ));
}

function lastRequest(manager: FakeRunnerWebSocketManager) {
  const requests = sentMessages(manager).filter((message) => (
    message.payload &&
    typeof message.payload === "object" &&
    typeof (message.payload as Record<string, unknown>).method === "string" &&
    typeof (message.payload as Record<string, unknown>).id === "number"
  ));
  return requests[requests.length - 1];
}

function respondToLastRequest(manager: FakeRunnerWebSocketManager, result: unknown) {
  const outbound = lastRequest(manager);
  const outboundPayload = outbound.payload as { id?: number; method?: string };
  const responseResult = outboundPayload.method === "initialize" && result && typeof result === "object"
    ? { userAgent: "codex-cli/0.145.0", ...result }
    : result;
  manager.emit({
    channel: "llm",
    op: "rpc",
    operationId: outbound.operationId,
    sessionId: outbound.sessionId,
    threadId: outbound.threadId,
    payload: {
      id: outboundPayload.id,
      result: responseResult,
    },
  });
}

function emitNotification(
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
    threadId: outbound.threadId,
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

test("manager mode treats cached initialize success as normal and completes compact flow", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const onEvent = jest.fn();
  const promise = compactCodexAppServerThread({
    wsUrl: "ws://127.0.0.1:8788/codex-ws",
    wsToken: "runner-token",
    threadId: "thread-1",
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    onEvent,
  });

  expect(mockCreateWebSocketWithOptionalAuth).not.toHaveBeenCalled();
  expect(manager.connect).toHaveBeenCalledTimes(1);
  expect(manager.send).not.toHaveBeenCalled();

  manager.becomeReady();
  await flushPromises();

  const initialize = lastRequest(manager);
  expect(initialize).toMatchObject({
    channel: "llm",
    op: "rpc",
    operationId: expect.any(String),
    sessionId: "thread-1",
    threadId: "thread-1",
    payload: { method: "initialize" },
  });

  respondToLastRequest(manager, {});
  await flushPromises();

  expect(sentMethods(manager)).toEqual([
    "initialize",
    "initialized",
    "thread/read",
  ]);

  respondToLastRequest(manager, { thread: { id: "thread-1" } });
  await flushPromises();
  expect(sentMethods(manager)).toEqual([
    "initialize",
    "initialized",
    "thread/read",
    "thread/resume",
  ]);

  respondToLastRequest(manager, { thread: { id: "thread-1" } });
  await flushPromises();
  expect(sentMethods(manager)).toEqual([
    "initialize",
    "initialized",
    "thread/read",
    "thread/resume",
    "thread/compact/start",
  ]);

  const compactStart = lastRequest(manager);
  respondToLastRequest(manager, { accepted: true });
  await flushPromises();

  emitNotification(manager, compactStart, "thread/compacted", {
    threadId: "thread-1",
  });

  await expect(promise).resolves.toEqual({
    threadId: "thread-1",
    method: "thread/compact/start",
    accepted: true,
  });
  expect(onEvent).toHaveBeenCalledWith("thread/compacted", { threadId: "thread-1" });
  expect(manager.unsubscribeCalls).toBe(2);
  expect(manager.disconnect).not.toHaveBeenCalled();
});
