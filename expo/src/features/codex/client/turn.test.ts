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

function createTurn(manager: FakeRunnerWebSocketManager, wsUrl = "ws://127.0.0.1:8788/runner-ws") {
  return startCodexAppServerTurn({
    wsUrl,
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

function emitTurnNotificationWithSeq(
  manager: FakeRunnerWebSocketManager,
  outbound: RunnerWsMessage,
  seq: number,
  method: string,
  params: Record<string, unknown>
) {
  manager.emit({
    channel: "llm",
    op: "rpc",
    operationId: outbound.operationId,
    sessionId: outbound.sessionId,
    threadId: String(params.threadId || outbound.threadId || ""),
    seq,
    payload: {
      method,
      params,
    },
  });
}

async function startLiveTurn(
  manager: FakeRunnerWebSocketManager,
  extra: { onDelta?: (delta: string, meta: unknown) => void } = {}
) {
  const session = startCodexAppServerTurn({
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
    wsToken: "runner-token",
    traceId: "trace-1",
    inputText: "hello",
    cwd: "/tmp/project",
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    onApprovalRequest: jest.fn(() => "approve_once"),
    ...extra,
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
  return { session, turnStartOutbound };
}

beforeEach(() => {
  global.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  mockCreateWebSocketWithOptionalAuth.mockReset();
});

afterEach(() => {
  global.WebSocket = originalWebSocket;
  jest.useRealTimers();
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

test("manager mode uses singleton even when configured URL is legacy codex-ws", async () => {
  const manager = new FakeRunnerWebSocketManager();

  const session = createTurn(manager, "ws://127.0.0.1:8788/codex-ws");

  expect(mockCreateWebSocketWithOptionalAuth).not.toHaveBeenCalled();
  expect(manager.connect).toHaveBeenCalledTimes(1);

  manager.becomeReady();
  await flushPromises();

  expect(lastSent(manager)).toMatchObject({
    channel: "llm",
    op: "rpc",
    payload: {
      method: "initialize",
    },
  });

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

test("manager mode fires onAgentMessageCompleted with full text when item/completed arrives without prior delta", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const onDelta = jest.fn();
  const onAgentMessageCompleted = jest.fn();
  const session = startCodexAppServerTurn({
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
    wsToken: "runner-token",
    traceId: "trace-1",
    inputText: "hello",
    cwd: "/tmp/project",
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    onApprovalRequest: jest.fn(() => "approve_once"),
    onDelta,
    onAgentMessageCompleted,
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

  emitTurnNotification(manager, turnStartOutbound, "item/completed", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    item: {
      id: "agent-item-1",
      type: "agentMessage",
      text: "hello back",
    },
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
  expect(onDelta).toHaveBeenCalledTimes(1);
  expect(onDelta).toHaveBeenCalledWith(
    "hello back",
    expect.objectContaining({ itemId: "agent-item-1" })
  );
  expect(onAgentMessageCompleted).toHaveBeenCalledTimes(1);
  expect(onAgentMessageCompleted).toHaveBeenCalledWith(
    "hello back",
    expect.objectContaining({ itemId: "agent-item-1" })
  );
});

test("manager mode fires onAgentMessageCompleted with full text even when the full text was already streamed via delta", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const onDelta = jest.fn();
  const onAgentMessageCompleted = jest.fn();
  const session = startCodexAppServerTurn({
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
    wsToken: "runner-token",
    traceId: "trace-1",
    inputText: "hello",
    cwd: "/tmp/project",
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    onApprovalRequest: jest.fn(() => "approve_once"),
    onDelta,
    onAgentMessageCompleted,
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
    delta: "hello back",
  });
  emitTurnNotification(manager, turnStartOutbound, "item/completed", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    item: {
      id: "agent-item-1",
      type: "agentMessage",
      text: "hello back",
    },
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
  // Only the single delta from item/agentMessage/delta; item/completed has no
  // remaining text to flush via onDelta since it was already streamed in full.
  expect(onDelta).toHaveBeenCalledTimes(1);
  expect(onDelta).toHaveBeenCalledWith(
    "hello back",
    expect.objectContaining({ itemId: "agent-item-1" })
  );
  expect(onAgentMessageCompleted).toHaveBeenCalledTimes(1);
  expect(onAgentMessageCompleted).toHaveBeenCalledWith(
    "hello back",
    expect.objectContaining({ itemId: "agent-item-1" })
  );
});

test("manager mode reports onAgentMessageCompleted per item across multiple agentMessages in one turn", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const onAgentMessageCompleted = jest.fn();
  const session = startCodexAppServerTurn({
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
    wsToken: "runner-token",
    traceId: "trace-1",
    inputText: "hello",
    cwd: "/tmp/project",
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    onApprovalRequest: jest.fn(() => "approve_once"),
    onAgentMessageCompleted,
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

  emitTurnNotification(manager, turnStartOutbound, "item/completed", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    item: {
      id: "agent-item-1",
      type: "agentMessage",
      text: "first message",
    },
  });
  emitTurnNotification(manager, turnStartOutbound, "item/completed", {
    threadId: "thread-1",
    itemId: "agent-item-2",
    item: {
      id: "agent-item-2",
      type: "agentMessage",
      text: "second message",
    },
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
    reply: "first message\n\nsecond message",
  });
  expect(onAgentMessageCompleted).toHaveBeenCalledTimes(2);
  expect(onAgentMessageCompleted).toHaveBeenNthCalledWith(
    1,
    "first message",
    expect.objectContaining({ itemId: "agent-item-1" })
  );
  expect(onAgentMessageCompleted).toHaveBeenNthCalledWith(
    2,
    "second message",
    expect.objectContaining({ itemId: "agent-item-2" })
  );
});

test("manager cleanup unsubscribes without disconnecting singleton socket", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const session = createTurn(manager);

  manager.becomeReady();
  await flushPromises();
  manager.dropConnection();

  await expect(session.promise).rejects.toThrow("runner-ws disconnected");
  expect(manager.unsubscribeCalls).toBe(3);
  expect(manager.disconnect).not.toHaveBeenCalled();
});

test("manager mode does not fail an in-flight turn while awaiting reconnect", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { session, turnStartOutbound } = await startLiveTurn(manager);

  emitTurnNotificationWithSeq(manager, turnStartOutbound, 1, "item/agentMessage/delta", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    delta: "hello ",
  });

  manager.dropConnection();
  await flushPromises();

  let settled = false;
  session.promise.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  await flushPromises();
  expect(settled).toBe(false);

  // Avoid leaking the real 120s reconnect-wait timer past the end of the test.
  await session.interrupt();
  await expect(session.promise).rejects.toThrow();
});

test("manager mode sends relay:resume once the singleton reconnects mid-turn", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { session, turnStartOutbound } = await startLiveTurn(manager);

  emitTurnNotificationWithSeq(manager, turnStartOutbound, 1, "item/agentMessage/delta", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    delta: "hello ",
  });

  manager.dropConnection();
  await flushPromises();

  manager.send.mockClear();
  manager.becomeReady();
  await flushPromises();

  expect(manager.send).toHaveBeenCalledWith({
    channel: "relay",
    op: "resume",
    threadId: "thread-1",
    seq: 1,
  });

  // resume was sent but never "attached"; interrupt to release the reconnect-wait timer.
  await session.interrupt();
  await expect(session.promise).rejects.toThrow();
});

test("manager mode resumes streaming after reconnect, ignores duplicate replay seq, and completes", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const onDelta = jest.fn();
  const { session, turnStartOutbound } = await startLiveTurn(manager, { onDelta });

  emitTurnNotificationWithSeq(manager, turnStartOutbound, 1, "item/agentMessage/delta", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    delta: "hello ",
  });

  manager.dropConnection();
  await flushPromises();
  manager.becomeReady();
  await flushPromises();

  // Server replay re-delivers the already-applied seq=1 delta before the new seq=2 one.
  emitTurnNotificationWithSeq(manager, turnStartOutbound, 1, "item/agentMessage/delta", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    delta: "hello ",
  });
  emitTurnNotificationWithSeq(manager, turnStartOutbound, 2, "item/agentMessage/delta", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    delta: "back",
  });

  manager.emit({
    channel: "relay",
    op: "attached",
    threadId: "thread-1",
    seq: 2,
    payload: { latestSeq: 2, replayed: 1 },
  });

  emitTurnNotificationWithSeq(manager, turnStartOutbound, 3, "turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });

  await expect(session.promise).resolves.toMatchObject({
    threadId: "thread-1",
    turnId: "turn-1",
    reply: "hello back",
  });
  expect(onDelta).toHaveBeenCalledTimes(2);
});

test("manager mode fails the turn on relay:resume_miss after reconnect", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { session, turnStartOutbound } = await startLiveTurn(manager);

  emitTurnNotificationWithSeq(manager, turnStartOutbound, 1, "item/agentMessage/delta", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    delta: "hello ",
  });

  manager.dropConnection();
  await flushPromises();
  manager.becomeReady();
  await flushPromises();

  manager.emit({
    channel: "relay",
    op: "resume_miss",
    threadId: "thread-1",
    seq: 1,
    payload: { reason: "gap" },
  });

  await expect(session.promise).rejects.toThrow("relay resume miss");
});

test("manager mode fails the turn once the reconnect wait timeout elapses", async () => {
  jest.useFakeTimers();
  const manager = new FakeRunnerWebSocketManager();
  const { session, turnStartOutbound } = await startLiveTurn(manager);

  emitTurnNotificationWithSeq(manager, turnStartOutbound, 1, "item/agentMessage/delta", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    delta: "hello ",
  });

  manager.dropConnection();
  await flushPromises();

  const rejection = expect(session.promise).rejects.toThrow("reconnect timeout");
  await jest.advanceTimersByTimeAsync(120_000);
  await rejection;
});

test("manager mode resolves as interrupted when interrupt() runs during reconnect wait", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { session, turnStartOutbound } = await startLiveTurn(manager);

  emitTurnNotificationWithSeq(manager, turnStartOutbound, 1, "item/agentMessage/delta", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    delta: "hello ",
  });

  manager.dropConnection();
  await flushPromises();

  await session.interrupt();

  await expect(session.promise).rejects.toThrow("interrupted");
});
