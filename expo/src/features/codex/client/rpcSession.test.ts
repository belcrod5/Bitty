import { createWebSocketWithOptionalAuth } from "../../ws/webSocketAuth";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type {
  RunnerWsConnectionSnapshot,
  RunnerWsMessage,
  RunnerWsMessageFilter,
} from "../../runnerWs/types";
import { assertSupportedCodexAppServer, runCodexRpcSession } from "./rpcSession";

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

function lastRequest(manager: FakeRunnerWebSocketManager) {
  const requests = sentMessages(manager).filter((message) => (
    message.payload &&
    typeof message.payload === "object" &&
    typeof (message.payload as Record<string, unknown>).method === "string"
  ));
  return requests[requests.length - 1];
}

function respondToLastRequest(manager: FakeRunnerWebSocketManager, result: unknown) {
  const outbound = lastRequest(manager);
  manager.emit({
    channel: "llm",
    op: "rpc",
    operationId: outbound.operationId,
    sessionId: outbound.sessionId,
    threadId: outbound.threadId,
    payload: {
      id: (outbound.payload as { id?: number }).id,
      result,
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

test("manager mode rewrites JSON-RPC ids and cleans up without creating a direct socket", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const promise = runCodexRpcSession({
    wsUrl: "ws://127.0.0.1:8788/codex-ws",
    wsToken: "runner-token",
    clientName: "test-client",
    clientTitle: "Test Client",
    traceId: "trace-1",
    threadId: "thread-1",
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    run: async (rpc) => {
      const result = await rpc<{ value: string }>("thread/list", {});
      return result.value;
    },
  });

  expect(mockCreateWebSocketWithOptionalAuth).not.toHaveBeenCalled();
  expect(manager.connect).toHaveBeenCalledTimes(1);

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
  expect((initialize.payload as { id?: number }).id).not.toBe(1);

  respondToLastRequest(manager, { userAgent: "codex-cli/0.145.0" });
  await flushPromises();

  const threadList = lastRequest(manager);
  expect(threadList.payload).toMatchObject({ method: "thread/list" });
  expect((threadList.payload as { id?: number }).id).not.toBe(2);

  respondToLastRequest(manager, { value: "done" });

  await expect(promise).resolves.toBe("done");
  expect(manager.unsubscribeCalls).toBe(3);
});

test("Expo rejects an old or unparseable Codex App Server during initialize", () => {
  expect(() => assertSupportedCodexAppServer({ userAgent: "codex-cli/0.144.9" }))
    .toThrow("0.145.0以上へ更新");
  expect(() => assertSupportedCodexAppServer({ userAgent: "codex-cli/0.144.999" }))
    .toThrow("0.145.0以上へ更新");
  expect(() => assertSupportedCodexAppServer({ userAgent: "unknown" }))
    .toThrow("unknown");
  expect(() => assertSupportedCodexAppServer({ userAgent: "codex-cli/0.145.0" }))
    .not.toThrow();
  expect(() => assertSupportedCodexAppServer({ userAgent: "codex-cli/1.0.0" }))
    .not.toThrow();
});

test("manager mode rejects the session when the runner reports a control error for the operation", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const promise = runCodexRpcSession({
    wsUrl: "ws://127.0.0.1:8788/codex-ws",
    wsToken: "runner-token",
    clientName: "test-client",
    clientTitle: "Test Client",
    traceId: "trace-1",
    threadId: "thread-1",
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    run: async (rpc) => rpc("thread/read", {}),
  });

  manager.becomeReady();
  await flushPromises();

  const initialize = lastRequest(manager);
  expect(initialize.payload).toMatchObject({ method: "initialize" });

  // Unrelated operations must not affect this session.
  manager.emit({
    channel: "control",
    op: "error",
    operationId: "another-operation",
    payload: { error: "invalid_llm_rpc_payload", message: "other session" },
  });
  await flushPromises();

  manager.emit({
    channel: "control",
    op: "error",
    requestId: initialize.requestId,
    operationId: initialize.operationId,
    payload: { error: "invalid_llm_rpc_payload", message: "identity rejected" },
  });

  await expect(promise).rejects.toThrow(
    "Codex app-server runner-ws error: identity rejected"
  );
  expect(manager.unsubscribeCalls).toBe(3);
});
