import { createWebSocketWithOptionalAuth } from "../../ws/webSocketAuth";
import { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type {
  RunnerWsConnectionSnapshot,
  RunnerWsMessage,
  RunnerWsMessageFilter,
} from "../../runnerWs/types";
import { compactCodexAppServerThread } from "./compact";

jest.mock("../../ws/webSocketAuth", () => ({
  createWebSocketWithOptionalAuth: jest.fn(),
  isWebSocketForCloudflareRunner: jest.fn(() => false),
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
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
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
  expect((initialize.payload as any).params.capabilities.experimentalApi).toBe(true);

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
  expect((lastRequest(manager).payload as any).params).toEqual({
    threadId: "thread-1",
    excludeTurns: true,
  });

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

test("neutral compact uses capability, handoff, and the Agent operation", async () => {
  const request = jest.fn()
    .mockResolvedValueOnce({
      channel: "agent", op: "agent.ready",
      payload: {
        protocolVersion: 2,
        backends: [{ backendId: "codex", readiness: { ready: true }, capabilities: { operations: { compact: true } } }],
      },
    })
    .mockResolvedValueOnce({ channel: "agent", op: "session.handoff.completed", payload: {} })
    .mockResolvedValueOnce({
      channel: "agent", op: "session.compact.completed",
      payload: { method: "thread/compact/start", accepted: true },
    });
  const manager = { request } as unknown as RunnerWebSocketManager;

  await expect(compactCodexAppServerThread({
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
    threadId: "thread-1",
    runnerWebSocketManager: manager,
    backendId: "codex",
    rawFallbackBackendId: "codex",
  })).resolves.toEqual({ threadId: "thread-1", method: "thread/compact/start", accepted: true });
  expect(request.mock.calls.map((call) => call[0].op)).toEqual([
    "agent.hello", "session.handoff", "session.compact",
  ]);
});

test("neutral compact retains the backend result after a temporary connection loss", async () => {
  const compactCompleted = {
    channel: "agent", op: "session.compact.completed",
    payload: { method: "thread/compact/start", accepted: true },
  };
  let connectionLost!: (error: Error) => void;
  const firstCompactResponse = new Promise<RunnerWsMessage>((_resolve, reject) => {
    connectionLost = reject;
  });
  const request = jest.fn()
    .mockResolvedValueOnce({
      channel: "agent", op: "agent.ready",
      payload: {
        protocolVersion: 2,
        backends: [{ backendId: "codex", readiness: { ready: true }, capabilities: { operations: { compact: true } } }],
      },
    })
    .mockResolvedValueOnce({ channel: "agent", op: "session.handoff.completed", payload: {} })
    .mockReturnValueOnce(firstCompactResponse)
    .mockResolvedValueOnce(compactCompleted);
  let connectionState: RunnerWsConnectionSnapshot["connectionState"] = "ready";
  const snapshotHandlers = new Set<() => void>();
  const manager = {
    request,
    getSnapshot: () => ({ connectionState }),
    subscribeSnapshot: (handler: () => void) => {
      snapshotHandlers.add(handler);
      return () => { snapshotHandlers.delete(handler); };
    },
  } as unknown as RunnerWebSocketManager;
  const compact = compactCodexAppServerThread({
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
    threadId: "thread-1",
    runnerWebSocketManager: manager,
    backendId: "codex",
    rawFallbackBackendId: "codex",
  });

  for (let i = 0; i < 5 && request.mock.calls.at(-1)?.[0].op !== "session.compact"; i += 1) {
    await flushPromises();
  }
  expect(request.mock.calls.at(-1)?.[0].op).toBe("session.compact");
  connectionState = "background";
  connectionLost(new Error("runner_ws_disconnected"));
  await flushPromises();
  expect(request.mock.calls.filter((call) => call[0].op === "session.compact")).toHaveLength(1);
  connectionState = "ready";
  for (const handler of snapshotHandlers) handler();

  await expect(compact).resolves.toEqual({
    threadId: "thread-1", method: "thread/compact/start", accepted: true,
  });
  expect(request.mock.calls.filter((call) => call[0].op === "session.compact")).toHaveLength(2);
});

test.each([
  ["runner_ws_not_ready: idle (runner_ws_url_required)", "idle"],
  ["runner_ws_auth_failed", "stopped"],
] as const)("compact reports terminal connection errors immediately: %s", async (message, connectionState) => {
  const subscribeSnapshot = jest.fn();
  const manager = {
    request: jest.fn().mockRejectedValue(new Error(message)),
    getSnapshot: () => ({ connectionState }),
    subscribeSnapshot,
  } as unknown as RunnerWebSocketManager;

  await expect(compactCodexAppServerThread({
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
    threadId: "thread-1",
    runnerWebSocketManager: manager,
    backendId: "claude",
    rawFallbackBackendId: "codex",
  })).rejects.toThrow(message);
  expect(subscribeSnapshot).not.toHaveBeenCalled();
});

test.each(["success", "failure"] as const)(
  "backgrounding the real manager resumes the same compact operation: %s",
  async (backendOutcome) => {
    const sockets: ManagedSocket[] = [];
    const compactRequests: RunnerWsMessage[] = [];
    class ManagedSocket extends FakeWebSocket {
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { reason: string; code: number }) => void) | null = null;
      bufferedAmount = 0;

      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.({});
        this.message({ channel: "control", op: "ready" });
      }

      message(message: RunnerWsMessage) {
        this.onmessage?.({ data: JSON.stringify(message) });
      }

      send(raw: string) {
        const message = JSON.parse(raw) as RunnerWsMessage;
        if (message.channel !== "agent") return;
        if (message.op === "session.compact") compactRequests.push(message);
        const response = message.op === "agent.hello"
          ? { op: "agent.ready", payload: {
            protocolVersion: 2,
            backends: [{ backendId: "codex", readiness: { ready: true }, capabilities: { operations: { compact: true } } }],
          } }
          : message.op === "session.handoff"
            ? { op: "session.handoff.completed", payload: {} }
            : message.op === "session.compact" && sockets.length === 2
              ? backendOutcome === "success"
                ? { op: "session.compact.completed", payload: { method: "thread/compact/start", accepted: true } }
                : { op: "error", payload: { message: "native compact failed" } }
              : null;
        if (response) queueMicrotask(() => this.message({
          channel: "agent", requestId: message.requestId, ...response,
        }));
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.({ reason: "", code: 1000 });
      }
    }
    mockCreateWebSocketWithOptionalAuth.mockImplementation(() => {
      const socket = new ManagedSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    const manager = new RunnerWebSocketManager({
      url: "ws://127.0.0.1:8788/runner-ws", token: "runner-token", appState: "active",
    });
    const connecting = manager.connect();
    sockets[0].open();
    await connecting;

    try {
      const compact = compactCodexAppServerThread({
        wsUrl: "ws://127.0.0.1:8788/runner-ws",
        threadId: "thread-1",
        runnerWebSocketManager: manager,
        backendId: "codex",
        rawFallbackBackendId: "codex",
      });
      for (let i = 0; i < 20 && compactRequests.length === 0; i += 1) await flushPromises();
      expect(compactRequests).toHaveLength(1);

      manager.setAppState("background");
      await flushPromises();
      expect(compactRequests).toHaveLength(1);
      manager.setAppState("active");
      sockets[1].open();

      if (backendOutcome === "success") {
        await expect(compact).resolves.toEqual({
          threadId: "thread-1", method: "thread/compact/start", accepted: true,
        });
      } else {
        await expect(compact).rejects.toThrow("native compact failed");
      }
      expect(compactRequests).toHaveLength(2);
      expect(compactRequests[1].payload).toEqual(compactRequests[0].payload);
    } finally {
      manager.disconnect("manual");
    }
  }
);
