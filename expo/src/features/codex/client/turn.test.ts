import { createWebSocketWithOptionalAuth } from "../../ws/webSocketAuth";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage } from "../../runnerWs/types";
import { startCodexAppServerTurn } from "./turn";
import {
  createTurn,
  FakeRunnerWebSocketManager,
  FakeWebSocket,
  flushPromises,
  lastSent,
  respondToLastRequest,
} from "./turnTestSupport";

jest.mock("../../ws/webSocketAuth", () => ({
  createWebSocketWithOptionalAuth: jest.fn(),
}));

const mockCreateWebSocketWithOptionalAuth = jest.mocked(createWebSocketWithOptionalAuth);
const originalWebSocket = global.WebSocket;

beforeEach(() => {
  global.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  mockCreateWebSocketWithOptionalAuth.mockReset();
});

afterEach(() => {
  global.WebSocket = originalWebSocket;
  jest.useRealTimers();
});

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
    payload: { method, params },
  });
}

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
  await flushPromises();
  await session.interrupt();
  await expect(session.promise).rejects.toThrow("interrupted");
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
  expect((lastSent(manager).payload as any).params).toMatchObject({ includeTurns: false });
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
