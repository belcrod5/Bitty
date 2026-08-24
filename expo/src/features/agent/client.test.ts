import { startAgentSessionObserverWithRawFallback, startAgentTurnWithRawFallback } from "./client";
import type { RunnerWebSocketManager } from "../runnerWs/RunnerWebSocketManager";

test("a protocol-v1 Runner falls back to the raw Codex transport", async () => {
  const request = jest.fn(async () => ({
    channel: "agent",
    op: "agent.ready",
    payload: {
      protocolVersion: 1,
      backends: [{ backendId: "codex", readiness: { ready: true } }],
    },
  }));
  const manager = { request } as unknown as RunnerWebSocketManager;
  const rawResult = { threadId: "raw-thread", turnId: "raw-turn", reply: "raw", contextUsage: null };
  const rawStart = jest.fn(() => ({ promise: Promise.resolve(rawResult), interrupt: async () => {} }));

  const session = startAgentTurnWithRawFallback({
    backendId: "codex",
    preferNeutralAgent: true,
    rawFallbackBackendId: "codex",
    runnerWebSocketManager: manager,
    wsUrl: "ws://runner.test",
    traceId: "trace-old-runner",
    inputText: "hello",
    cwd: "/workspace",
    onApprovalRequest: async () => "decline" as const,
  }, rawStart);

  await expect(session.promise).resolves.toEqual(rawResult);
  expect(rawStart).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
});

test("a durable completed operation result settles without waiting for replay events", async () => {
  const request = jest.fn()
    .mockResolvedValueOnce({
      channel: "agent",
      op: "agent.ready",
      payload: {
        protocolVersion: 2,
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
        protocolVersion: 2,
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

test("an out-of-order client event interrupts the server run best-effort", async () => {
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
        protocolVersion: 2,
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
  eventHandler!({
    payload: {
      runId: "run-1", protocolVersion: 2, type: "content.delta", sequence: 2,
      payload: { itemId: "assistant-1", delta: "newer" },
    },
  });
  eventHandler!({ payload: { runId: "run-1", protocolVersion: 2, type: "turn.completed", sequence: 1, payload: {} } });
  await expect(session.promise).rejects.toThrow(/not increasing/);
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
  onEvent?: (method: string, params: unknown) => void;
  onThreadIdResolved?: (threadId: string) => void;
  actionResponse?: { channel: string; op: string; payload?: Record<string, unknown> } | Promise<{
    channel: string; op: string; payload?: Record<string, unknown>;
  }>;
  resumeActions?: Record<string, unknown>[];
  resumeReplayTruncated?: boolean;
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
      return {
        channel: "agent", op: "events.resumed", streamId: "run-1",
        payload: {
          runId: "run-1",
          activeActions: options.resumeActions || [],
          ...(options.resumeReplayTruncated
            ? { replayTruncated: true, replayFromSequence: 7 }
            : {}),
        },
      };
    }
    if (message.op === "turn.interrupt") {
      return { channel: "agent", op: "turn.interrupted", payload: {} };
    }
    if (message.op === "events.detach") {
      return { channel: "agent", op: "events.detached", payload: { detached: true } };
    }
    return {
      channel: "agent",
      op: "agent.ready",
      payload: {
        protocolVersion: 2,
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
    onEvent: options.onEvent,
    onThreadIdResolved: options.onThreadIdResolved,
  }, jest.fn());
  for (let index = 0; index < 20 && request.mock.calls.every(([message]) => message.op !== "turn.start"); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  let sequence = 0;
  return {
    request,
    session,
    emit(type: string, payload: Record<string, unknown> = {}, eventOptions?: {
      sequence?: number;
      sessionRef?: { backendId: string; nativeSessionId: string };
    }) {
      sequence = eventOptions?.sequence ?? sequence + 1;
      eventHandler!({
        payload: {
          runId: "run-1",
          protocolVersion: 2,
          type,
          sequence,
          ...(eventOptions?.sessionRef ? { sessionRef: eventOptions.sessionRef } : {}),
          payload,
        },
      });
    },
    reconnect() {
      generation += 1;
      snapshotHandler!();
    },
  };
}

test("a direct neutral turn maps tool lifecycle to one raw-compatible command item", async () => {
  const onEvent = jest.fn();
  const turn = await createLiveTurn({
    onApprovalRequest: async () => "decline",
    onEvent,
  });

  turn.emit("tool.started", {
    toolCallId: "call-1",
    name: "exec_command",
    inputSummary: "find . -type f",
  });
  turn.emit("tool.completed", {
    toolCallId: "call-1",
    inputSummary: "find . -type f",
    status: "completed",
    exitCode: 0,
  });
  turn.emit("turn.completed");
  await turn.session.promise;

  expect(onEvent).toHaveBeenNthCalledWith(1, "item/started", {
    item: {
      id: "call-1",
      type: "commandExecution",
      command: "find . -type f",
      status: "inProgress",
    },
  });
  expect(onEvent).toHaveBeenNthCalledWith(2, "item/completed", {
    item: {
      id: "call-1",
      type: "commandExecution",
      command: "find . -type f",
      status: "completed",
      exitCode: 0,
    },
  });
  expect(onEvent).toHaveBeenNthCalledWith(3, "turn/completed", {});
});

test.each([
  { action: "approve_for_session" as const, decisions: ["allow", "allow_for_session", "deny"], expected: "allow_for_session" },
  { action: "approve_for_session" as const, decisions: ["allow", "deny"], expected: "allow" },
  { action: "approve_once" as const, decisions: ["allow", "allow_for_session", "deny"], expected: "allow" },
  { action: "decline" as const, decisions: ["allow", "allow_for_session", "deny"], expected: "deny" },
])("neutral approval maps $action to $expected for advertised decisions", async ({ action, decisions, expected }) => {
  const turn = await createLiveTurn({ onApprovalRequest: async () => action });
  turn.emit("action.requested", { requestId: "approval-1", kind: "approval", decisions });
  for (let index = 0; index < 20 && turn.request.mock.calls.every(([message]) => message.op !== "action.respond"); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(turn.request.mock.calls.find(([message]) => message.op === "action.respond")?.[0])
    .toEqual(expect.objectContaining({ payload: expect.objectContaining({ decision: expected }) }));
  turn.emit("turn.completed");
  await turn.session.promise;
});

test("server action resolution closes a pending approval without blocking terminal events", async () => {
  const approval = deferred<"decline">();
  const resolved = jest.fn();
  const turn = await createLiveTurn({
    onApprovalRequest: () => approval.promise,
    onApprovalRequestResolved: resolved,
  });
  turn.emit("action.requested", { requestId: "approval-1", kind: "approval", decisions: ["allow", "deny"] });
  turn.emit("action.resolved", { requestId: "approval-1", outcome: "answered", decision: "allow" });
  turn.emit("turn.completed");
  await turn.session.promise;
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(turn.request.mock.calls.some(([message]) => message.op === "action.respond")).toBe(false);
  approval.resolve("decline");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(turn.request.mock.calls.some(([message]) => message.op === "action.respond")).toBe(false);
});

test("a local approval response and its server resolution close the UI once", async () => {
  const resolved = jest.fn();
  const turn = await createLiveTurn({
    onApprovalRequest: async () => "approve_once",
    onApprovalRequestResolved: resolved,
  });
  turn.emit("action.requested", { requestId: "approval-local", kind: "approval", decisions: ["allow", "deny"] });
  for (let index = 0; index < 20 && resolved.mock.calls.length === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(resolved).toHaveBeenCalledTimes(1);
  turn.emit("action.resolved", { requestId: "approval-local", outcome: "answered", decision: "allow" });
  turn.emit("turn.completed");
  await turn.session.promise;
  expect(resolved).toHaveBeenCalledTimes(1);
});

test("action_expired closes the approval without interrupting the turn", async () => {
  const resolved = jest.fn();
  const turn = await createLiveTurn({
    onApprovalRequest: async () => "decline",
    onApprovalRequestResolved: resolved,
    actionResponse: { channel: "agent", op: "error", payload: { code: "action_expired", message: "expired" } },
  });
  turn.emit("action.requested", { requestId: "approval-expired", kind: "approval", decisions: ["allow", "deny"] });
  for (let index = 0; index < 20 && resolved.mock.calls.length === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(turn.request.mock.calls.some(([message]) => message.op === "turn.interrupt")).toBe(false);
  turn.emit("turn.completed");
  await turn.session.promise;
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
  response.resolve({ channel: "agent", op: "error", payload: { code: "action_expired" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(turn.request.mock.calls.some(([message]) => message.op === "turn.interrupt")).toBe(false);
  turn.emit("turn.completed");
  await turn.session.promise;
});

test("terminal events close resumed active approvals", async () => {
  const approval = deferred<"decline">();
  const resolved = jest.fn();
  const turn = await createLiveTurn({
    onApprovalRequest: () => approval.promise,
    onApprovalRequestResolved: resolved,
    resumeActions: [{ requestId: "approval-resumed", kind: "approval", decisions: ["allow", "deny"] }],
  });
  turn.reconnect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  turn.emit("turn.completed");
  await turn.session.promise;
  expect(resolved).toHaveBeenCalledTimes(1);
  approval.resolve("decline");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(turn.request.mock.calls.some(([message]) => message.op === "action.respond")).toBe(false);
});

test("an initial replay gap continues from retained events without interrupting the run", async () => {
  let eventHandler: ((message: any) => void) | null = null;
  const request = jest.fn(async (message: { op?: string }) => {
    if (message.op === "turn.start") {
      eventHandler?.({
        channel: "agent",
        op: "event",
        payload: {
          protocolVersion: 2,
          type: "content.delta",
          runId: "run-1",
          sequence: 10,
          payload: { itemId: "item-1", delta: "partial" },
        },
      });
      return {
        channel: "agent",
        op: "turn.accepted",
        streamId: "run-1",
        payload: { runId: "run-1", replayTruncated: true, replayFromSequence: 10, activeActions: [] },
      };
    }
    if (message.op === "events.detach") {
      return { channel: "agent", op: "events.detached", payload: { detached: true } };
    }
    if (message.op === "turn.interrupt") {
      return { channel: "agent", op: "turn.interrupt.accepted", payload: { status: "cancelling" } };
    }
    return {
      channel: "agent",
      op: "agent.ready",
      payload: {
        protocolVersion: 2,
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
    subscribeSnapshot: () => () => {},
    getSnapshot: () => ({ generation: 1, connectionState: "ready" }),
  } as unknown as RunnerWebSocketManager;
  const onDelta = jest.fn();

  const session = startAgentTurnWithRawFallback({
    backendId: "codex",
    preferNeutralAgent: true,
    runnerWebSocketManager: manager,
    wsUrl: "ws://runner.test",
    traceId: "trace-gap",
    inputText: "hello",
    cwd: "/workspace",
    onApprovalRequest: async () => "decline" as const,
    onDelta,
  }, jest.fn());

  for (let i = 0; i < 20 && onDelta.mock.calls.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  (eventHandler as ((message: any) => void) | null)?.({
    channel: "agent",
    op: "event",
    payload: {
      protocolVersion: 2,
      type: "turn.completed",
      runId: "run-1",
      sequence: 11,
      payload: {},
    },
  });

  await expect(session.promise).resolves.toEqual(expect.objectContaining({ reply: "partial" }));
  expect(onDelta).toHaveBeenCalledWith("partial", { itemId: "item-1", delta: "partial" });
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ op: "events.detach", streamId: "run-1" }));
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ op: "turn.interrupt" }));
});

test("a reconnect replay gap resolves stale approval and recovers the session from later events", async () => {
  const approval = deferred<"decline">();
  const onApprovalRequest = jest.fn(() => approval.promise);
  const onApprovalRequestResolved = jest.fn();
  const onThreadIdResolved = jest.fn();
  const onEvent = jest.fn();
  const turn = await createLiveTurn({
    onApprovalRequest,
    onApprovalRequestResolved,
    onThreadIdResolved,
    onEvent,
    resumeReplayTruncated: true,
  });

  turn.emit("action.requested", { requestId: "stale-approval", kind: "approval" });
  for (let i = 0; i < 20 && onApprovalRequest.mock.calls.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  turn.reconnect();
  const sessionRef = { backendId: "codex", nativeSessionId: "thread-recovered" };
  turn.emit("content.delta", { itemId: "assistant-1", delta: "after gap" }, { sequence: 7, sessionRef });
  turn.emit("turn.completed", {}, { sessionRef });

  await expect(turn.session.promise).resolves.toEqual(expect.objectContaining({
    threadId: "thread-recovered",
    reply: "after gap",
  }));
  expect(onEvent).toHaveBeenCalledWith("content/delta", { itemId: "assistant-1", delta: "after gap" });
  expect(onApprovalRequestResolved).toHaveBeenCalledTimes(1);
  expect(onThreadIdResolved).toHaveBeenCalledTimes(1);
  expect(onThreadIdResolved).toHaveBeenCalledWith("thread-recovered");
  expect(turn.request).toHaveBeenCalledWith(expect.objectContaining({
    op: "events.resume",
    streamId: "run-1",
    seq: 1,
  }));
  expect(turn.request).not.toHaveBeenCalledWith(expect.objectContaining({ op: "turn.interrupt" }));
  approval.resolve("decline");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(turn.request).not.toHaveBeenCalledWith(expect.objectContaining({ op: "action.respond" }));
});

test("a dynamic tool is claimed before its side effect executes", async () => {
  let eventHandler: ((message: any) => void) | null = null;
  const order: string[] = [];
  const request = jest.fn(async (message: { op?: string }) => {
    if (message.op === "agent.hello") {
      return {
        channel: "agent",
        op: "agent.ready",
        payload: {
          protocolVersion: 2,
          backends: [{
            backendId: "codex",
            readiness: { ready: true },
            capabilities: { action: { policyProfiles: [] }, model: {}, workspace: { admission: false } },
          }],
        },
      };
    }
    if (message.op === "turn.start") {
      return {
        channel: "agent",
        op: "turn.accepted",
        streamId: "run-1",
        payload: {
          runId: "run-1",
          activeActions: [{
            requestId: "tool-1",
            kind: "dynamic_tool",
            input: { method: "calendar", params: {} },
          }],
        },
      };
    }
    if (message.op === "action.claim") {
      order.push("claim");
      return { channel: "agent", op: "action.claim.accepted", payload: { status: "claimed" } };
    }
    if (message.op === "action.respond") {
      order.push("respond");
      return { channel: "agent", op: "action.response.accepted", payload: {} };
    }
    return { channel: "agent", op: "events.detached", payload: { detached: true } };
  });
  const manager = {
    request,
    subscribe: (_filter: unknown, handler: (message: any) => void) => {
      eventHandler = handler;
      return () => {};
    },
    subscribeSnapshot: () => () => {},
    getSnapshot: () => ({ generation: 1, connectionState: "ready" }),
  } as unknown as RunnerWebSocketManager;
  const onCalendarToolCall = jest.fn(async () => {
    order.push("side-effect");
    return { ok: true as const, data: {} };
  });
  const session = startAgentTurnWithRawFallback({
    backendId: "codex",
    preferNeutralAgent: true,
    runnerWebSocketManager: manager,
    wsUrl: "ws://runner.test",
    traceId: "trace-tool-claim",
    inputText: "calendar",
    cwd: "/workspace",
    onApprovalRequest: async () => "decline" as const,
    onCalendarToolCall,
  }, jest.fn());
  for (let i = 0; i < 20 && !order.includes("respond"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  (eventHandler as ((message: any) => void) | null)?.({
    channel: "agent",
    op: "event",
    payload: {
      protocolVersion: 2,
      type: "session.resolved",
      runId: "run-1",
      sessionRef: { backendId: "codex", nativeSessionId: "thread-1" },
      sequence: 7,
      payload: {},
    },
  });
  (eventHandler as ((message: any) => void) | null)?.({
    channel: "agent",
    op: "event",
    payload: {
      protocolVersion: 2,
      type: "turn.completed",
      runId: "run-1",
      sequence: 8,
      payload: { sessionRef: { backendId: "codex", nativeSessionId: "thread-1" } },
    },
  });

  await expect(session.promise).resolves.toEqual(expect.objectContaining({ threadId: "thread-1" }));
  expect(order).toEqual(["claim", "side-effect", "respond"]);
  expect(onCalendarToolCall).toHaveBeenCalledTimes(1);
});

test("a restored neutral observer attaches by session, replays live output, and interrupts the active run", async () => {
  let eventHandler: ((message: any) => void) | null = null;
  const request = jest.fn(async (message: { op?: string }) => {
    if (message.op === "agent.hello") {
      return {
        channel: "agent",
        op: "agent.ready",
        payload: { protocolVersion: 2, backends: [{ backendId: "claude", readiness: { ready: true } }] },
      };
    }
    if (message.op === "events.resume") {
      eventHandler?.({
        channel: "agent",
        op: "event",
        payload: {
          protocolVersion: 2,
          type: "content.delta",
          runId: "run-1",
          sessionRef: { backendId: "claude", nativeSessionId: "session-1" },
          sequence: 4,
          payload: { itemId: "item-1", delta: "live" },
        },
      });
      eventHandler?.({
        channel: "agent",
        op: "event",
        payload: {
          protocolVersion: 2,
          type: "action.requested",
          runId: "run-1",
          sessionRef: { backendId: "claude", nativeSessionId: "session-1" },
          sequence: 5,
          payload: { requestId: "stale-action", kind: "permission", decisions: ["allow", "deny"] },
        },
      });
      return {
        channel: "agent",
        op: "events.resumed",
        streamId: "run-1",
        payload: {
          active: true,
          runId: "run-1",
          runChanged: true,
          replayTruncated: true,
          replayFromSequence: 4,
          activeActions: [{ requestId: "tool-1", kind: "dynamic_tool", input: { method: "calendar" } }],
        },
      };
    }
    if (message.op === "turn.interrupt") {
      return { channel: "agent", op: "turn.interrupt.accepted", payload: { status: "cancelling" } };
    }
    throw new Error(`unexpected request: ${message.op}`);
  });
  const manager = {
    request,
    subscribe: (_filter: unknown, handler: (message: any) => void) => {
      eventHandler = handler;
      return () => {};
    },
    subscribeSnapshot: () => () => {},
    getSnapshot: () => ({ generation: 1, connectionState: "ready" }),
  } as unknown as RunnerWebSocketManager;
  const onDelta = jest.fn();
  const onRelayReset = jest.fn();
  const onLog = jest.fn();
  const onApprovalRequest = jest.fn(async () => "decline" as const);
  const rawStart = jest.fn();

  const observer = startAgentSessionObserverWithRawFallback({
    wsUrl: "ws://runner.test",
    threadId: "session-1",
    backendId: "claude",
    preferNeutralAgent: true,
    runnerWebSocketManager: manager,
    resumeFromRelayId: "run-old",
    resumeFromSeq: 1,
    onApprovalRequest,
    onDelta,
    onRelayReset,
    onLog,
  }, rawStart);
  await observer.interrupt?.();
  for (let i = 0; i < 20 && onDelta.mock.calls.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(rawStart).not.toHaveBeenCalled();
  expect(onDelta).toHaveBeenCalledWith("live", { itemId: "item-1" });
  expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ stage: "relay_observer_replay_truncated" }));
  expect(onLog).not.toHaveBeenCalledWith(expect.objectContaining({ stage: "relay_observer_resume_miss" }));
  expect(onRelayReset).toHaveBeenNthCalledWith(1, { threadId: "session-1", relayId: "run-1", seq: 0 });
  expect(onRelayReset).toHaveBeenCalledWith({ threadId: "session-1", relayId: "run-1", seq: 3 });
  expect(onRelayReset.mock.invocationCallOrder[0]).toBeLessThan(onDelta.mock.invocationCallOrder[0]);
  expect(onApprovalRequest).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ op: "action.claim" }));
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ op: "action.respond" }));

  expect(request).toHaveBeenCalledWith(expect.objectContaining({ op: "turn.interrupt", streamId: "run-1" }));
  observer.close();
});

test("a restored neutral observer settles when the run ends between history and attach", async () => {
  const request = jest.fn(async (message: { op?: string }) => {
    if (message.op === "agent.hello") {
      return {
        channel: "agent",
        op: "agent.ready",
        payload: { protocolVersion: 2, backends: [{ backendId: "claude", readiness: { ready: true } }] },
      };
    }
    return { channel: "agent", op: "events.resumed", payload: { active: false, activeActions: [] } };
  });
  const manager = {
    request,
    subscribe: () => () => {},
    subscribeSnapshot: () => () => {},
    getSnapshot: () => ({ generation: 1, connectionState: "ready" }),
  } as unknown as RunnerWebSocketManager;
  const onTurnCompleted = jest.fn();

  startAgentSessionObserverWithRawFallback({
    wsUrl: "ws://runner.test",
    threadId: "session-1",
    backendId: "claude",
    preferNeutralAgent: true,
    runnerWebSocketManager: manager,
    onApprovalRequest: async () => "decline" as const,
    onTurnCompleted,
  }, jest.fn());
  for (let i = 0; i < 20 && onTurnCompleted.mock.calls.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(onTurnCompleted).toHaveBeenCalledWith({ noActiveRun: true });
});

test("a restored neutral observer does not replace started tool input with a generic completion label", async () => {
  let eventHandler: ((message: any) => void) | null = null;
  const request = jest.fn(async (message: { op?: string }) => {
    if (message.op === "agent.hello") {
      return {
        channel: "agent",
        op: "agent.ready",
        payload: { protocolVersion: 2, backends: [{ backendId: "codex", readiness: { ready: true } }] },
      };
    }
    if (message.op === "events.resume") {
      eventHandler?.({
        channel: "agent",
        op: "event",
        payload: {
          protocolVersion: 2,
          type: "tool.started",
          runId: "run-1",
          sequence: 1,
          payload: { toolCallId: "call-1", name: "exec_command", inputSummary: "find . -type f" },
        },
      });
      eventHandler?.({
        channel: "agent",
        op: "event",
        payload: {
          protocolVersion: 2,
          type: "tool.completed",
          runId: "run-1",
          sequence: 2,
          payload: {
            toolCallId: "call-1",
            status: "completed",
            exitCode: 0,
          },
        },
      });
      return {
        channel: "agent",
        op: "events.resumed",
        streamId: "run-1",
        payload: { active: true, runId: "run-1", activeActions: [] },
      };
    }
    return { channel: "agent", op: "events.detached", payload: { detached: true } };
  });
  const manager = {
    request,
    subscribe: (_filter: unknown, handler: (message: any) => void) => {
      eventHandler = handler;
      return () => {};
    },
    subscribeSnapshot: () => () => {},
    getSnapshot: () => ({ generation: 1, connectionState: "ready" }),
  } as unknown as RunnerWebSocketManager;
  const onEvent = jest.fn();
  const observer = startAgentSessionObserverWithRawFallback({
    wsUrl: "ws://runner.test",
    threadId: "session-1",
    backendId: "codex",
    preferNeutralAgent: true,
    runnerWebSocketManager: manager,
    onApprovalRequest: async () => "decline" as const,
    onEvent,
  }, jest.fn());

  for (let i = 0; i < 20 && onEvent.mock.calls.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(onEvent).toHaveBeenNthCalledWith(1, "item/started", {
    item: {
      id: "call-1",
      type: "commandExecution",
      command: "find . -type f",
      status: "inProgress",
    },
  });
  expect(onEvent).toHaveBeenNthCalledWith(2, "item/completed", {
    item: {
      id: "call-1",
      type: "commandExecution",
      command: "",
      status: "completed",
      exitCode: 0,
    },
  });
  observer.close();
});

test("a passive observer projection error detaches without interrupting the active run", async () => {
  let eventHandler: ((message: any) => void) | null = null;
  const request = jest.fn(async (message: { op?: string }) => {
    if (message.op === "agent.hello") {
      return {
        channel: "agent",
        op: "agent.ready",
        payload: { protocolVersion: 2, backends: [{ backendId: "claude", readiness: { ready: true } }] },
      };
    }
    if (message.op === "events.resume") {
      eventHandler?.({
        channel: "agent",
        op: "event",
        payload: {
          protocolVersion: 2,
          type: "content.delta",
          runId: "run-1",
          sequence: 1,
          payload: { itemId: "item-1", delta: "live" },
        },
      });
      return {
        channel: "agent",
        op: "events.resumed",
        streamId: "run-1",
        payload: { active: true, runId: "run-1", activeActions: [] },
      };
    }
    if (message.op === "events.detach") {
      return { channel: "agent", op: "events.detached", payload: { detached: true } };
    }
    if (message.op === "turn.interrupt") {
      throw new Error("passive observer must not interrupt");
    }
    throw new Error(`unexpected request: ${message.op}`);
  });
  const manager = {
    request,
    subscribe: (_filter: unknown, handler: (message: any) => void) => {
      eventHandler = handler;
      return () => {};
    },
    subscribeSnapshot: () => () => {},
    getSnapshot: () => ({ generation: 1, connectionState: "ready" }),
  } as unknown as RunnerWebSocketManager;
  const onLog = jest.fn();

  startAgentSessionObserverWithRawFallback({
    wsUrl: "ws://runner.test",
    threadId: "session-1",
    backendId: "claude",
    preferNeutralAgent: true,
    runnerWebSocketManager: manager,
    onApprovalRequest: async () => "decline" as const,
    onDelta: () => { throw new Error("projection failed"); },
    onLog,
  }, jest.fn());
  for (let i = 0; i < 20 && !request.mock.calls.some(([message]) => message.op === "events.detach"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(onLog).toHaveBeenCalledWith(expect.objectContaining({
    stage: "relay_observer_resume_miss",
    message: "projection failed",
  }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ op: "events.detach", streamId: "run-1" }));
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ op: "turn.interrupt" }));
});

test("reconnect buffers replay until the authoritative active-action snapshot filters stale requests", async () => {
  let generation = 1;
  let resumeCount = 0;
  let eventHandler: ((message: any) => void) | null = null;
  let snapshotHandler: (() => void) | null = null;
  const request = jest.fn(async (message: { op?: string }) => {
    if (message.op === "agent.hello") {
      return {
        channel: "agent",
        op: "agent.ready",
        payload: { protocolVersion: 2, backends: [{ backendId: "claude", readiness: { ready: true } }] },
      };
    }
    if (message.op === "events.resume") {
      resumeCount += 1;
      if (resumeCount > 1) {
        eventHandler?.({
          channel: "agent",
          op: "event",
          payload: {
            protocolVersion: 2,
            type: "content.delta",
            runId: "run-1",
            sequence: 4,
            payload: { itemId: "item-1", delta: "after reconnect" },
          },
        });
        eventHandler?.({
          channel: "agent",
          op: "event",
          payload: {
            protocolVersion: 2,
            type: "action.requested",
            runId: "run-1",
            sequence: 6,
            payload: { requestId: "already-resolved", kind: "permission" },
          },
        });
      }
      return {
        channel: "agent",
        op: "events.resumed",
        streamId: "run-1",
        payload: { active: true, runId: "run-1", activeActions: [] },
      };
    }
    return { channel: "agent", op: "events.detached", payload: { detached: true } };
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
  const onApprovalRequest = jest.fn(async () => "decline" as const);
  const onDelta = jest.fn();
  const observer = startAgentSessionObserverWithRawFallback({
    wsUrl: "ws://runner.test",
    threadId: "session-1",
    backendId: "claude",
    preferNeutralAgent: true,
    runnerWebSocketManager: manager,
    onApprovalRequest,
    onDelta,
  }, jest.fn());
  for (let i = 0; i < 20 && resumeCount < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

  generation = 2;
  (snapshotHandler as (() => void) | null)?.();
  for (let i = 0; i < 20 && onDelta.mock.calls.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(onDelta).toHaveBeenCalledWith("after reconnect", { itemId: "item-1" });
  expect(onApprovalRequest).not.toHaveBeenCalled();
  observer.close();
});

test("a restored neutral terminal preserves failed outcome", async () => {
  let eventHandler: ((message: any) => void) | null = null;
  const request = jest.fn(async (message: { op?: string }) => {
    if (message.op === "agent.hello") {
      return {
        channel: "agent",
        op: "agent.ready",
        payload: { protocolVersion: 2, backends: [{ backendId: "claude", readiness: { ready: true } }] },
      };
    }
    if (message.op === "events.resume") {
      eventHandler?.({
        channel: "agent",
        op: "event",
        payload: {
          protocolVersion: 2,
          type: "action.resolved",
          runId: "run-1",
          sequence: 2,
          payload: { requestId: "approval-1", outcome: "expired" },
        },
      });
      eventHandler?.({
        channel: "agent",
        op: "event",
        payload: {
          protocolVersion: 2,
          type: "content.delta",
          runId: "run-1",
          sequence: 4,
          payload: { itemId: "assistant-1", delta: "after action" },
        },
      });
      eventHandler?.({
        channel: "agent",
        op: "event",
        payload: {
          protocolVersion: 2,
          type: "turn.failed",
          runId: "run-1",
          sequence: 6,
          payload: { error: { message: "backend failed" } },
        },
      });
      return {
        channel: "agent",
        op: "events.resumed",
        streamId: "run-1",
        payload: { active: true, runId: "run-1", activeActions: [] },
      };
    }
    return { channel: "agent", op: "events.detached", payload: { detached: true } };
  });
  const manager = {
    request,
    subscribe: (_filter: unknown, handler: (message: any) => void) => {
      eventHandler = handler;
      return () => {};
    },
    subscribeSnapshot: () => () => {},
    getSnapshot: () => ({ generation: 1, connectionState: "ready" }),
  } as unknown as RunnerWebSocketManager;
  const onTurnCompleted = jest.fn();
  const onDelta = jest.fn();

  startAgentSessionObserverWithRawFallback({
    wsUrl: "ws://runner.test",
    threadId: "session-1",
    backendId: "claude",
    preferNeutralAgent: true,
    runnerWebSocketManager: manager,
    onApprovalRequest: async () => "decline" as const,
    onDelta,
    onTurnCompleted,
  }, jest.fn());
  for (let i = 0; i < 20 && onTurnCompleted.mock.calls.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(onDelta).toHaveBeenCalledWith("after action", { itemId: "assistant-1" });
  expect(onTurnCompleted).toHaveBeenCalledWith({
    error: { message: "backend failed" },
    outcome: "failed",
  });
});
