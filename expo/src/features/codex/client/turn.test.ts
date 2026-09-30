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

test("rejects the removed legacy Codex WebSocket path", async () => {
  const manager = new FakeRunnerWebSocketManager();

  const session = createTurn(manager, "ws://127.0.0.1:8788/codex-ws");

  await expect(session.promise).rejects.toThrow("must use /runner-ws");
  expect(mockCreateWebSocketWithOptionalAuth).not.toHaveBeenCalled();
  expect(manager.connect).not.toHaveBeenCalled();
});

test("new app threads expose calendar tools whenever the client provides the handler", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const session = startCodexAppServerTurn({
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
    wsToken: "runner-token",
    inputText: "today's events",
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    onApprovalRequest: jest.fn(() => "approve_once"),
    onCalendarToolCall: jest.fn(async () => ({ ok: true as const, data: null })),
  });

  manager.becomeReady();
  await flushPromises();
  respondToLastRequest(manager, {});
  await flushPromises();
  expect((lastSent(manager).payload as any).method).toBe("modelProvider/capabilities/read");
  respondToLastRequest(manager, { namespaceTools: true });
  await flushPromises();

  const threadStart = lastSent(manager);
  expect((threadStart.payload as any).method).toBe("thread/start");
  const [calendarNamespace] = (threadStart.payload as any).params.dynamicTools;
  expect(calendarNamespace).toMatchObject({
    type: "namespace",
    name: "calendar",
  });
  expect(calendarNamespace.tools.map((tool: { name: string }) => tool.name)).toEqual([
    "calendar_list_calendars",
    "calendar_search_events",
    "calendar_get_event",
    "calendar_create_event",
    "calendar_update_event",
    "calendar_delete_event",
  ]);
  expect(calendarNamespace.tools.every((tool: { deferLoading?: boolean }) => tool.deferLoading === true)).toBe(true);

  await session.interrupt();
  await expect(session.promise).rejects.toThrow("interrupted");
});

test("calendar threads fail clearly when namespace tools are unavailable", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const session = startCodexAppServerTurn({
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
    wsToken: "runner-token",
    inputText: "today's events",
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    onApprovalRequest: jest.fn(() => "approve_once"),
    onCalendarToolCall: jest.fn(async () => ({ ok: true as const, data: null })),
  });

  manager.becomeReady();
  await flushPromises();
  respondToLastRequest(manager, {});
  await flushPromises();
  respondToLastRequest(manager, { namespaceTools: false });

  await expect(session.promise).rejects.toThrow("codex_dynamic_tools_incompatible");
  expect(manager.send.mock.calls.some(([message]) => (message.payload as any)?.method === "thread/start")).toBe(false);
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
  emitTurnNotification(manager, outbound, "thread/tokenUsage/updated", {
    threadId: "thread-1", turnId: "other-turn",
    tokenUsage: { total: { outputTokens: 999 }, last: { outputTokens: 999 } },
  });
  emitTurnNotification(manager, outbound, "thread/tokenUsage/updated", {
    threadId: "thread-1", turnId: "turn-1",
    tokenUsage: { total: { outputTokens: 100 }, last: { outputTokens: 100 } },
  });
  emitTurnNotification(manager, outbound, "thread/tokenUsage/updated", {
    threadId: "thread-1", turnId: "turn-1",
    tokenUsage: { total: { outputTokens: 100 }, last: { outputTokens: 100 } },
  });
  emitTurnNotification(manager, outbound, "thread/tokenUsage/updated", {
    threadId: "thread-1", turnId: "turn-1",
    tokenUsage: { total: { outputTokens: 150 }, last: { outputTokens: 50 } },
  });
  emitTurnNotification(manager, outbound, "thread/tokenUsage/updated", {
    threadId: "thread-1", turnId: "turn-1",
    tokenUsage: { total: { outputTokens: 180 },
      last: { inputTokens: 150, outputTokens: 30, totalTokens: 180 }, modelContextWindow: 272000 },
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
    outputTokens: 180,
    contextUsage: expect.objectContaining({ totalTokens: 180, contextWindowTokens: 272000 }),
  });
});

test("manager mode subtracts the previous turn total from a resumed thread", async () => {
  const threadId = "thread-turn-output-baseline";
  const firstManager = new FakeRunnerWebSocketManager();
  const first = createTurn(firstManager);
  firstManager.becomeReady();
  await flushPromises();
  respondToLastRequest(firstManager, {});
  await flushPromises();
  respondToLastRequest(firstManager, { thread: { id: threadId } }, threadId);
  await flushPromises();
  respondToLastRequest(firstManager, { thread: { id: threadId, status: "idle" } }, threadId);
  await flushPromises();
  respondToLastRequest(firstManager, { turn: { id: "turn-first" } }, threadId);
  await flushPromises();
  const firstOutbound = lastSent(firstManager);
  emitTurnNotification(firstManager, firstOutbound, "thread/tokenUsage/updated", {
    threadId, turnId: "turn-first",
    tokenUsage: { total: { outputTokens: 180 }, last: { outputTokens: 30 } },
  });
  emitTurnNotification(firstManager, firstOutbound, "turn/completed", {
    threadId, turn: { id: "turn-first", status: "completed" },
  });
  await expect(first.promise).resolves.toMatchObject({ outputTokens: 180 });

  const secondManager = new FakeRunnerWebSocketManager();
  const second = createTurn(secondManager, "ws://127.0.0.1:8788/runner-ws", threadId);
  secondManager.becomeReady();
  await flushPromises();
  respondToLastRequest(secondManager, {});
  await flushPromises();
  respondToLastRequest(secondManager, { thread: { id: threadId, status: "idle" } }, threadId);
  await flushPromises();
  respondToLastRequest(secondManager, { thread: { id: threadId } }, threadId);
  await flushPromises();
  respondToLastRequest(secondManager, { turn: { id: "turn-second" } }, threadId);
  await flushPromises();
  const secondOutbound = lastSent(secondManager);
  for (const [total, last] of [[180, 30], [380, 200], [430, 50], [460, 30]]) {
    emitTurnNotification(secondManager, secondOutbound, "thread/tokenUsage/updated", {
      threadId, turnId: "turn-second",
      tokenUsage: { total: { outputTokens: total }, last: { outputTokens: last } },
    });
  }
  emitTurnNotification(secondManager, secondOutbound, "turn/completed", {
    threadId, turn: { id: "turn-second", status: "completed" },
  });

  await expect(second.promise).resolves.toMatchObject({ outputTokens: 280 });
});

test("manager mode omits turn output when a resumed thread baseline is unknown", async () => {
  const threadId = "thread-unknown-output-baseline";
  const manager = new FakeRunnerWebSocketManager();
  const session = createTurn(manager, "ws://127.0.0.1:8788/runner-ws", threadId);
  manager.becomeReady();
  await flushPromises();
  respondToLastRequest(manager, {});
  await flushPromises();
  respondToLastRequest(manager, { thread: { id: threadId, status: "idle" } }, threadId);
  await flushPromises();
  respondToLastRequest(manager, { thread: { id: threadId } }, threadId);
  await flushPromises();
  respondToLastRequest(manager, { turn: { id: "turn-unknown" } }, threadId);
  await flushPromises();
  const outbound = lastSent(manager);
  emitTurnNotification(manager, outbound, "thread/tokenUsage/updated", {
    threadId, turnId: "turn-unknown",
    tokenUsage: { total: { outputTokens: 380 }, last: { outputTokens: 200 } },
  });
  emitTurnNotification(manager, outbound, "turn/completed", {
    threadId, turn: { id: "turn-unknown", status: "completed" },
  });

  await expect(session.promise).resolves.not.toHaveProperty("outputTokens");
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
