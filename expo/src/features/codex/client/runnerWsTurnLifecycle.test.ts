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
    payload: { method, params },
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

  return { session, turnStartOutbound: lastSent(manager) };
}

test("direct runner-ws mode sends the exact identity pair on every setup RPC", async () => {
  const sent: RunnerWsMessage[] = [];
  const socket: any = {
    readyState: FakeWebSocket.CONNECTING,
    send: jest.fn((raw: string) => sent.push(JSON.parse(raw))),
    close: jest.fn(),
  };
  mockCreateWebSocketWithOptionalAuth.mockReturnValue(socket);
  const session = startCodexAppServerTurn({
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
    wsToken: "runner-token",
    traceId: "trace-direct",
    inputText: "hello",
    cwd: "/tmp/project",
    onApprovalRequest: jest.fn(() => "approve_once"),
  });
  const respond = async (result: unknown, threadId = "") => {
    const outbound = sent.at(-1)!;
    socket.onmessage({ data: JSON.stringify({
      channel: "llm", op: "rpc",
      operationId: outbound.operationId, sessionId: outbound.sessionId,
      ...(threadId ? { threadId } : {}),
      payload: { id: (outbound.payload as any).id, result },
    }) });
    await flushPromises();
  };

  socket.readyState = FakeWebSocket.OPEN;
  socket.onopen();
  await flushPromises();
  await respond({});
  await respond({ thread: { id: "thread-1" } }, "thread-1");
  await respond({ thread: { id: "thread-1", status: "idle" } }, "thread-1");
  await respond({ turn: { id: "turn-1" } }, "thread-1");

  const setupMessages = sent.filter((message) => [
    "initialize", "initialized", "thread/start", "thread/read", "turn/start",
  ].includes(String((message.payload as any)?.method || "")));
  expect(setupMessages.map((message) => (message.payload as any).method)).toEqual([
    "initialize", "initialized", "thread/start", "thread/read", "turn/start",
  ]);
  for (const message of setupMessages) {
    expect(message.operationId).toMatch(/^codex_turn_op_/);
    expect(message.sessionId).toMatch(/^codex_turn_session_/);
  }
  expect(new Set(setupMessages.map((message) => message.operationId))).toHaveProperty("size", 1);
  expect(new Set(setupMessages.map((message) => message.sessionId))).toHaveProperty("size", 1);
  expect(setupMessages.find((message) => (message.payload as any).method === "turn/start")?.threadId).toBe("thread-1");
  await session.interrupt();
  await expect(session.promise).rejects.toThrow("interrupted");
});

test("manager mode resumes initialize response by identity without resending it", async () => {
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

  manager.setAppState("background", "background");
  manager.setAppState("active", "reconnecting");
  manager.becomeReady();
  await flushPromises();
  expect(manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "initialize")).toHaveLength(1);
  expect(lastSent(manager)).toMatchObject({
    channel: "relay",
    op: "resume",
    operationId: outbound.operationId,
    sessionId: outbound.sessionId,
    seq: 0,
  });
  manager.emit({
    channel: "llm", op: "rpc",
    operationId: outbound.operationId, sessionId: outbound.sessionId, seq: 1,
    payload: { id: (outbound.payload as any).id, result: {} },
  });
  await flushPromises();
  expect(manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "thread/start")).toHaveLength(1);
  await session.interrupt();
  await expect(session.promise).rejects.toThrow("interrupted");
});

test("manager mode recovers thread/start response without creating a second thread", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const session = createTurn(manager);
  manager.becomeReady();
  await flushPromises();
  respondToLastRequest(manager, {});
  await flushPromises();
  const threadStart = lastSent(manager);
  expect((threadStart.payload as any).method).toBe("thread/start");

  manager.dropConnection();
  manager.becomeReady();
  await flushPromises();
  expect(lastSent(manager)).toMatchObject({
    channel: "relay", op: "resume",
    operationId: threadStart.operationId, sessionId: threadStart.sessionId,
  });
  manager.emit({
    channel: "llm", op: "rpc",
    operationId: threadStart.operationId, sessionId: threadStart.sessionId,
    threadId: "thread-1", seq: 1,
    payload: { id: (threadStart.payload as any).id, result: { thread: { id: "thread-1" } } },
  });
  await flushPromises();
  expect(manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "thread/start")).toHaveLength(1);
  expect((lastSent(manager).payload as any).method).toBe("thread/read");
  await session.interrupt();
  await expect(session.promise).rejects.toThrow("interrupted");
});

test("manager mode waits to send initialized notification across the inactive race", async () => {
  const manager = new FakeRunnerWebSocketManager();
  let rejectInitialized = true;
  manager.send.mockImplementation((message: RunnerWsMessage) => {
    if ((message.payload as any)?.method === "initialized" && rejectInitialized) {
      rejectInitialized = false;
      manager.setAppState("inactive");
      throw new Error("runner_ws_not_ready");
    }
  });
  const session = createTurn(manager);
  manager.becomeReady();
  await flushPromises();
  respondToLastRequest(manager, {});
  await flushPromises();
  expect(manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "thread/start")).toHaveLength(0);
  manager.setAppState("active");
  await flushPromises();
  expect(manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "initialized")).toHaveLength(2);
  expect(manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "thread/start")).toHaveLength(1);
  await session.interrupt();
  await expect(session.promise).rejects.toThrow("interrupted");
});

test("manager mode only starts connect from active idle", async () => {
  const manager = new FakeRunnerWebSocketManager();
  manager.setAppState("active", "connecting");
  const session = createTurn(manager);
  expect(manager.connect).not.toHaveBeenCalled();
  manager.repeatSnapshot();
  expect(manager.connect).not.toHaveBeenCalled();
  manager.becomeReady();
  await flushPromises();
  expect((lastSent(manager).payload as any).method).toBe("initialize");
  await session.interrupt();
  await expect(session.promise).rejects.toThrow("interrupted");
});

test("manager mode waits for active as well as ready before initial setup", async () => {
  const manager = new FakeRunnerWebSocketManager();
  manager.setAppState("inactive");
  const session = createTurn(manager);

  manager.becomeReady();
  await flushPromises();
  manager.repeatSnapshot();
  expect(manager.send).not.toHaveBeenCalled();

  manager.setAppState("active");
  await flushPromises();
  manager.repeatSnapshot();
  expect(manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "initialize")).toHaveLength(1);

  respondToLastRequest(manager, {});
  manager.setAppState("inactive");
  await flushPromises();
  expect(manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "thread/start")).toHaveLength(0);
  manager.setAppState("active");
  await flushPromises();
  manager.repeatSnapshot();
  expect(manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "thread/start")).toHaveLength(1);

  await session.interrupt();
  await expect(session.promise).rejects.toThrow("interrupted");
});

test("manager mode cancels an admission wait without later sending", async () => {
  const manager = new FakeRunnerWebSocketManager();
  manager.setAppState("background", "background");
  const session = createTurn(manager);
  await flushPromises();
  expect(manager.connect).not.toHaveBeenCalled();

  await session.interrupt();
  await expect(session.promise).rejects.toThrow("interrupted");
  manager.setAppState("active");
  manager.repeatSnapshot();
  await flushPromises();

  expect(manager.send).not.toHaveBeenCalled();
  expect(manager.disconnect).not.toHaveBeenCalled();
});

test("manager mode releases an admission wait on the overall timeout", async () => {
  jest.useFakeTimers();
  const manager = new FakeRunnerWebSocketManager();
  manager.setAppState("background", "background");
  const session = createTurn(manager, undefined, "", 5000);
  const rejection = expect(session.promise).rejects.toThrow("turn timeout");

  await jest.advanceTimersByTimeAsync(5000);
  await rejection;
  manager.setAppState("active", "ready");
  await flushPromises();
  expect(manager.send).not.toHaveBeenCalled();
});

test("manager mode admits existing-thread start RPCs once per active ready transition", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const session = createTurn(manager, undefined, "thread-1");
  manager.becomeReady();
  await flushPromises();

  respondToLastRequest(manager, {});
  await flushPromises();
  respondToLastRequest(manager, { thread: { id: "thread-1", status: "idle" } }, "thread-1");
  manager.setAppState("background", "background");
  await flushPromises();
  expect((lastSent(manager).payload as any).method).toBe("thread/read");

  manager.setAppState("active", "connecting");
  manager.becomeReady();
  await flushPromises();
  expect((lastSent(manager).payload as any).method).toBe("thread/resume");
  respondToLastRequest(manager, { thread: { id: "thread-1" } }, "thread-1");
  manager.setAppState("inactive");
  await flushPromises();
  expect((lastSent(manager).payload as any).method).toBe("thread/resume");

  manager.setAppState("active", "connecting");
  await flushPromises();
  expect((lastSent(manager).payload as any).method).toBe("thread/resume");
  manager.becomeReady();
  await flushPromises();
  manager.repeatSnapshot();
  const turnStarts = manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "turn/start");
  expect(turnStarts).toHaveLength(1);
  respondToLastRequest(manager, { turn: { id: "turn-1" } }, "thread-1");
  await session.interrupt();
  await expect(session.promise).rejects.toThrow("interrupted");
});

test("manager mode re-admits only a synchronously rejected turn/start send", async () => {
  const manager = new FakeRunnerWebSocketManager();
  let rejectTurnStart = true;
  manager.send.mockImplementation((message: RunnerWsMessage) => {
    if ((message.payload as any)?.method === "turn/start" && rejectTurnStart) {
      rejectTurnStart = false;
      manager.setAppState("inactive");
      throw new Error("runner_ws_inactive_start_blocked");
    }
  });
  const session = createTurn(manager);
  manager.becomeReady();
  await flushPromises();
  respondToLastRequest(manager, {});
  await flushPromises();
  respondToLastRequest(manager, { thread: { id: "thread-1" } }, "thread-1");
  await flushPromises();
  respondToLastRequest(manager, { thread: { id: "thread-1", status: "idle" } }, "thread-1");

  await flushPromises();
  manager.setAppState("active");
  await flushPromises();
  expect(manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "turn/start")).toHaveLength(2);
  respondToLastRequest(manager, { turn: { id: "turn-1" } }, "thread-1");
  await session.interrupt();
  await expect(session.promise).rejects.toThrow("interrupted");
  expect(manager.send.mock.calls.some(([message]) => message.op === "resume")).toBe(false);
});

test("manager cleanup unsubscribes without disconnecting singleton socket", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const session = createTurn(manager);

  manager.becomeReady();
  await flushPromises();
  manager.dropConnection();
  await session.interrupt();
  await expect(session.promise).rejects.toThrow("interrupted");
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

  await session.interrupt();
  manager.becomeReady();
  await flushPromises();
  manager.emit({
    channel: "relay", op: "attached", threadId: "thread-1", seq: 1,
    payload: { latestSeq: 1, replayed: 0 },
  });
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

  expect(manager.send).toHaveBeenCalledWith(expect.objectContaining({
    channel: "relay",
    op: "resume",
    threadId: "thread-1",
    seq: 1,
  }));

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
  manager.becomeReady();
  await flushPromises();
  manager.emit({
    channel: "relay", op: "attached", threadId: "thread-1", seq: 1,
    payload: { latestSeq: 1, replayed: 0 },
  });
  await expect(session.promise).rejects.toThrow("interrupted");
  expect(manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "turn/interrupt")).toHaveLength(1);
});

test("manager mode recovers turn/start response before interrupting exactly once", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const session = createTurn(manager);
  manager.becomeReady();
  await flushPromises();
  respondToLastRequest(manager, {});
  await flushPromises();
  respondToLastRequest(manager, { thread: { id: "thread-1" } }, "thread-1");
  await flushPromises();
  respondToLastRequest(manager, { thread: { id: "thread-1", status: "idle" } }, "thread-1");
  await flushPromises();
  const turnStart = lastSent(manager);
  expect((turnStart.payload as any).method).toBe("turn/start");

  manager.dropConnection();
  await session.interrupt();
  manager.becomeReady();
  await flushPromises();
  manager.emit({
    channel: "llm", op: "rpc",
    operationId: turnStart.operationId, sessionId: turnStart.sessionId,
    threadId: "thread-1", seq: 1,
    payload: { id: (turnStart.payload as any).id, result: { turn: { id: "turn-1" } } },
  });
  await expect(session.promise).rejects.toThrow("interrupted");
  expect(manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "turn/start")).toHaveLength(1);
  expect(manager.send.mock.calls.filter(([message]) => (message.payload as any)?.method === "turn/interrupt")).toHaveLength(1);
});

test("manager mode resends an unsent approval decision once admission returns", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { session, turnStartOutbound } = await startLiveTurn(manager);

  let failSends = true;
  manager.send.mockImplementation(() => {
    if (failSends) throw new Error("runner_ws_not_ready: reconnecting");
  });
  manager.dropConnection();
  await flushPromises();

  manager.emit({
    channel: "llm", op: "rpc",
    operationId: turnStartOutbound.operationId, sessionId: turnStartOutbound.sessionId,
    threadId: "thread-1", seq: 1,
    payload: {
      id: 9001,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", command: "ls" },
    },
  });
  await flushPromises();

  const decisionSends = () => manager.send.mock.calls.filter(([message]) => (
    (message.payload as any)?.id === 9001 && (message.payload as any)?.result?.decision === "accept"
  ));
  expect(decisionSends()).toHaveLength(1);

  failSends = false;
  manager.becomeReady();
  await flushPromises();
  expect(decisionSends()).toHaveLength(2);

  emitTurnNotificationWithSeq(manager, turnStartOutbound, 2, "item/agentMessage/delta", {
    threadId: "thread-1",
    itemId: "agent-item-1",
    delta: "done",
  });
  emitTurnNotificationWithSeq(manager, turnStartOutbound, 3, "turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
  await expect(session.promise).resolves.toMatchObject({ reply: "done" });
});

test("manager mode retries turn/interrupt on relay attach when the first send never left", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { session } = await startLiveTurn(manager);

  manager.send.mockImplementationOnce(() => {
    throw new Error("runner_ws_not_ready: handshaking");
  });
  await session.interrupt();
  const interruptSends = () => manager.send.mock.calls.filter(([message]) => (
    (message.payload as any)?.method === "turn/interrupt"
  ));
  expect(interruptSends()).toHaveLength(1);

  // The unsent interrupt must not settle the turn as interrupted: the runner would
  // keep the turn running and hydration would resurrect it as "Running".
  let settled = false;
  session.promise.then(() => { settled = true; }, () => { settled = true; });
  await flushPromises();
  expect(settled).toBe(false);

  manager.emit({
    channel: "relay", op: "attached", threadId: "thread-1", seq: 1,
    payload: { latestSeq: 1, replayed: 0 },
  });
  await expect(session.promise).rejects.toThrow("interrupted");
  expect(interruptSends()).toHaveLength(2);
});
