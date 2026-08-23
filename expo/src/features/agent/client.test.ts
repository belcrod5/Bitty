import { startAgentTurnWithRawFallback } from "./client";
import type { RunnerWebSocketManager } from "../runnerWs/RunnerWebSocketManager";

test("a durable completed operation result settles without waiting for replay events", async () => {
  const request = jest.fn()
    .mockResolvedValueOnce({
      channel: "agent",
      op: "agent.ready",
      payload: {
        protocolVersion: 1,
        backends: [{
          backendId: "codex",
          readiness: { ready: true },
          capabilities: { action: { policyProfiles: [] }, model: {}, workspace: { admission: false } },
        }],
      },
    })
    .mockResolvedValueOnce({
      channel: "agent",
      op: "turn.result",
      streamId: "run-1",
      payload: {
        runId: "run-1",
        outcome: "completed",
        sessionRef: { backendId: "codex", nativeSessionId: "session-1" },
      },
    })
    .mockResolvedValueOnce({
      channel: "agent", op: "agent.ready",
      payload: {
        protocolVersion: 1,
        backends: [{ backendId: "codex", readiness: { ready: true } }],
      },
    })
    .mockResolvedValueOnce({
      channel: "agent", op: "history.read.result",
      payload: {
        items: [{ role: "assistant", content: [{ type: "text", text: "recovered" }] }],
      },
    });
  const manager = {
    request,
    subscribe: () => () => {},
    subscribeSnapshot: () => () => {},
    getSnapshot: () => ({ generation: 1, connectionState: "ready" }),
  } as unknown as RunnerWebSocketManager;
  const rawStart = jest.fn();

  const session = startAgentTurnWithRawFallback({
    backendId: "codex",
    preferNeutralAgent: true,
    runnerWebSocketManager: manager,
    wsUrl: "ws://runner.test",
    traceId: "trace-1",
    inputText: "hello",
    cwd: "/workspace",
    onApprovalRequest: async () => "decline" as const,
  }, rawStart);

  await expect(session.promise).resolves.toEqual({
    threadId: "session-1",
    turnId: "",
    reply: "recovered",
    contextUsage: null,
  });
  expect(rawStart).not.toHaveBeenCalled();
});

test("a client-side event failure interrupts the server run best-effort", async () => {
  let eventHandler: ((message: unknown) => void) | null = null;
  const onTurnAccepted = jest.fn();
  const request = jest.fn(async (message: { op?: string }) => {
    if (message.op === "turn.start") {
      return { channel: "agent", op: "turn.accepted", streamId: "run-1", payload: { runId: "run-1", queued: true } };
    }
    if (message.op === "turn.interrupt") {
      return { channel: "agent", op: "turn.interrupted", payload: {} };
    }
    return {
      channel: "agent",
      op: "agent.ready",
      payload: {
        protocolVersion: 1,
        backends: [{
          backendId: "codex",
          readiness: { ready: true },
          capabilities: { action: { policyProfiles: [] }, model: {}, workspace: { admission: false } },
        }],
      },
    };
  });
  const manager = {
    request,
    subscribe: (_filter: unknown, handler: (message: unknown) => void) => {
      eventHandler = handler;
      return () => {};
    },
    subscribeSnapshot: () => () => {},
    getSnapshot: () => ({ generation: 1, connectionState: "ready" }),
  } as unknown as RunnerWebSocketManager;

  const session = startAgentTurnWithRawFallback({
    backendId: "codex",
    preferNeutralAgent: true,
    runnerWebSocketManager: manager,
    wsUrl: "ws://runner.test",
    traceId: "trace-1",
    inputText: "hello",
    cwd: "/workspace",
    onApprovalRequest: async () => "decline" as const,
    onTurnAccepted,
  }, jest.fn());

  for (let i = 0; i < 20 && request.mock.calls.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(onTurnAccepted).toHaveBeenCalledWith({ runId: "run-1", queued: true });
  // クライアント側で処理できないイベント → turn失敗と同時にサーバー側runをinterruptする
  eventHandler!({ payload: { runId: "run-1", protocolVersion: 99, type: "turn.completed", sequence: 1, payload: {} } });
  await expect(session.promise).rejects.toThrow(/unsupported/);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ op: "turn.interrupt", streamId: "run-1" }));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function createLiveTurn(options: {
  onApprovalRequest: (request: any) => Promise<any>;
  onApprovalRequestResolved?: (request: any) => void;
  actionResponse?: { channel: string; op: string; payload?: Record<string, unknown> } | Promise<{
    channel: string; op: string; payload?: Record<string, unknown>;
  }>;
  resumeActions?: Record<string, unknown>[];
  onCalendarToolCall?: (request: any) => Promise<any>;
}) {
  let eventHandler: ((message: any) => void) | null = null;
  let snapshotHandler: (() => void) | null = null;
  let generation = 1;
  const request = jest.fn(async (message: { op?: string }) => {
    if (message.op === "turn.start") {
      return { channel: "agent", op: "turn.accepted", streamId: "run-1", payload: { runId: "run-1" } };
    }
    if (message.op === "action.respond") {
      return options.actionResponse || { channel: "agent", op: "action.respond.result", payload: {} };
    }
    if (message.op === "events.resume") {
      return { channel: "agent", op: "events.resumed", payload: { activeActions: options.resumeActions || [] } };
    }
    if (message.op === "turn.interrupt") {
      return { channel: "agent", op: "turn.interrupted", payload: {} };
    }
    return {
      channel: "agent",
      op: "agent.ready",
      payload: {
        protocolVersion: 1,
        backends: [{
          backendId: "codex",
          readiness: { ready: true },
          capabilities: { action: { policyProfiles: [] }, model: {}, workspace: { admission: false } },
        }],
      },
    };
  });
  const manager = {
    request,
    subscribe: (_filter: unknown, handler: (message: any) => void) => {
      eventHandler = handler;
      return () => {};
    },
    subscribeSnapshot: (handler: () => void) => {
      snapshotHandler = handler;
      return () => {};
    },
    getSnapshot: () => ({ generation, connectionState: "ready" }),
  } as unknown as RunnerWebSocketManager;
  const session = startAgentTurnWithRawFallback({
    backendId: "codex",
    preferNeutralAgent: true,
    runnerWebSocketManager: manager,
    wsUrl: "ws://runner.test",
    traceId: "trace-live",
    inputText: "hello",
    cwd: "/workspace",
    onApprovalRequest: options.onApprovalRequest,
    onApprovalRequestResolved: options.onApprovalRequestResolved,
    onCalendarToolCall: options.onCalendarToolCall,
  }, jest.fn());
  for (let index = 0; index < 20 && request.mock.calls.every(([message]) => message.op !== "turn.start"); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  let sequence = 0;
  return {
    request,
    session,
    emit(type: string, payload: Record<string, unknown> = {}) {
      sequence += 1;
      eventHandler!({ payload: { runId: "run-1", protocolVersion: 1, type, sequence, payload } });
    },
    reconnect() {
      generation += 1;
      snapshotHandler!();
    },
  };
}

test("server action resolution closes a pending approval without blocking later events or responding again", async () => {
  const approval = deferred<"cancel">();
  const resolved = jest.fn();
  const turn = await createLiveTurn({
    onApprovalRequest: () => approval.promise,
    onApprovalRequestResolved: resolved,
  });

  turn.emit("action.requested", { requestId: "approval-1", kind: "approval", title: "Approve?", decisions: ["allow", "deny"] });
  turn.emit("action.resolved", { requestId: "approval-1", outcome: "answered", decision: "allow" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(turn.request.mock.calls.some(([message]) => message.op === "action.respond")).toBe(false);

  turn.emit("turn.completed", {});
  await expect(turn.session.promise).resolves.toEqual({ threadId: "", turnId: "", reply: "", contextUsage: null });
  approval.resolve("cancel");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(turn.request.mock.calls.some(([message]) => message.op === "action.respond")).toBe(false);
});

test("a local approval responds once and closes its UI", async () => {
  const resolved = jest.fn();
  const turn = await createLiveTurn({
    onApprovalRequest: async () => "approve_once",
    onApprovalRequestResolved: resolved,
  });
  turn.emit("action.requested", { requestId: "approval-local", kind: "approval", decisions: ["allow", "deny"] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const responses = turn.request.mock.calls.filter(([message]) => message.op === "action.respond");
  expect(responses).toHaveLength(1);
  expect(responses[0][0]).toEqual(expect.objectContaining({ payload: expect.objectContaining({ decision: "allow" }) }));
  expect(resolved).toHaveBeenCalledTimes(1);
  turn.emit("action.resolved", { requestId: "approval-local", outcome: "answered", decision: "allow" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(resolved).toHaveBeenCalledTimes(1);
  turn.emit("turn.completed", {});
  await turn.session.promise;
});

test("action_expired closes the approval without interrupting the turn", async () => {
  const resolved = jest.fn();
  const turn = await createLiveTurn({
    onApprovalRequest: async () => "decline",
    onApprovalRequestResolved: resolved,
    actionResponse: { channel: "agent", op: "error", payload: { code: "action_expired", message: "expired" } },
  });
  turn.emit("action.requested", { requestId: "approval-expired", kind: "approval", decisions: ["allow", "deny"] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(turn.request.mock.calls.some(([message]) => message.op === "turn.interrupt")).toBe(false);
  turn.emit("turn.completed", {});
  await expect(turn.session.promise).resolves.toBeDefined();
});

test("server resolution racing an in-flight UI response does not interrupt the turn", async () => {
  const response = deferred<{ channel: string; op: string; payload: Record<string, unknown> }>();
  const resolved = jest.fn();
  const turn = await createLiveTurn({
    onApprovalRequest: async () => "approve_once",
    onApprovalRequestResolved: resolved,
    actionResponse: response.promise,
  });
  turn.emit("action.requested", { requestId: "approval-race", kind: "approval", decisions: ["allow", "deny"] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  turn.emit("action.resolved", { requestId: "approval-race", outcome: "answered", decision: "deny" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  response.resolve({ channel: "agent", op: "error", payload: { code: "action_expired" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(turn.request.mock.calls.some(([message]) => message.op === "turn.interrupt")).toBe(false);
  turn.emit("turn.completed", {});
  await expect(turn.session.promise).resolves.toBeDefined();
});

test("terminal events close pending approvals and resumed active approvals use the same lifecycle", async () => {
  const approval = deferred<"cancel">();
  const resolved = jest.fn();
  const turn = await createLiveTurn({
    onApprovalRequest: () => approval.promise,
    onApprovalRequestResolved: resolved,
    resumeActions: [{ requestId: "approval-resumed", kind: "approval", decisions: ["allow", "deny"] }],
  });
  turn.reconnect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  turn.emit("turn.completed", {});
  await turn.session.promise;
  expect(resolved).toHaveBeenCalledTimes(1);
  approval.resolve("cancel");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(turn.request.mock.calls.some(([message]) => message.op === "action.respond")).toBe(false);
});

test("dynamic tool actions keep the result response path", async () => {
  const turn = await createLiveTurn({
    onApprovalRequest: async () => "decline",
    onCalendarToolCall: async () => ({ ok: true, value: "done" }),
  });
  turn.emit("action.requested", {
    requestId: "tool-1",
    kind: "dynamic_tool",
    decisions: ["result"],
    input: { method: "calendar.test", params: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const response = turn.request.mock.calls.find(([message]) => message.op === "action.respond");
  expect(response?.[0]).toEqual(expect.objectContaining({ payload: expect.objectContaining({ decision: "result" }) }));
  turn.emit("turn.completed", {});
  await turn.session.promise;
});
