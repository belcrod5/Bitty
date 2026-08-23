import { startAgentTurnWithRawFallback } from "./client";
import type { RunnerWebSocketManager } from "../runnerWs/RunnerWebSocketManager";

async function neutralApprovalDecision(options: {
  action: "approve_once" | "approve_for_session" | "decline";
  decisions: string[];
  resumed?: boolean;
}) {
  let eventHandler: ((message: unknown) => void) | null = null;
  let snapshotHandler: (() => void) | null = null;
  let generation = 1;
  let responseDecision = "";
  const action = {
    requestId: "approval-1",
    kind: "approval",
    title: "Approve command",
    decisions: options.decisions,
  };
  const manager = {
    async request(message: { op?: string; payload?: Record<string, unknown> }) {
      if (message.op === "agent.hello") {
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
      }
      if (message.op === "turn.start") {
        if (options.resumed) {
          setTimeout(() => {
            generation = 2;
            snapshotHandler?.();
          }, 0);
        } else {
          queueMicrotask(() => {
            eventHandler?.({
              payload: {
                protocolVersion: 1,
                type: "action.requested",
                runId: "run-1",
                sequence: 1,
                payload: action,
              },
            });
          });
        }
        return { channel: "agent", op: "turn.accepted", streamId: "run-1", payload: { runId: "run-1" } };
      }
      if (message.op === "events.resume") {
        return { channel: "agent", op: "events.resumed", payload: { resumeMiss: false, activeActions: [action] } };
      }
      if (message.op === "action.respond") {
        responseDecision = String(message.payload?.decision || "");
        queueMicrotask(() => eventHandler?.({
          payload: {
            protocolVersion: 1,
            type: "turn.completed",
            runId: "run-1",
            sequence: options.resumed ? 1 : 2,
            payload: {},
          },
        }));
        return { channel: "agent", op: "action.responded", payload: {} };
      }
      throw new Error(`Unexpected request: ${message.op}`);
    },
    subscribe(_filter: unknown, handler: (message: unknown) => void) {
      eventHandler = handler;
      return () => {};
    },
    subscribeSnapshot(handler: () => void) {
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
    traceId: "trace-approval",
    inputText: "hello",
    cwd: "/workspace",
    onApprovalRequest: async () => options.action,
  }, jest.fn());
  await session.promise;
  return responseDecision;
}

test.each([
  { action: "approve_for_session" as const, decisions: ["allow", "allow_for_session", "deny"], expected: "allow_for_session" },
  { action: "approve_for_session" as const, decisions: ["allow", "deny"], expected: "allow" },
  { action: "approve_once" as const, decisions: ["allow", "allow_for_session", "deny"], expected: "allow" },
  { action: "decline" as const, decisions: ["allow", "allow_for_session", "deny"], expected: "deny" },
])("neutral approval maps $action to $expected for advertised decisions", async ({ action, decisions, expected }) => {
  await expect(neutralApprovalDecision({ action, decisions })).resolves.toBe(expected);
});

test("resumed active actions preserve advertised session approval", async () => {
  await expect(neutralApprovalDecision({
    action: "approve_for_session",
    decisions: ["allow", "allow_for_session", "deny"],
    resumed: true,
  })).resolves.toBe("allow_for_session");
});

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
  const request = jest.fn(async (message: { op?: string }) => {
    if (message.op === "turn.start") {
      return { channel: "agent", op: "turn.accepted", streamId: "run-1", payload: { runId: "run-1" } };
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
  }, jest.fn());

  for (let i = 0; i < 20 && request.mock.calls.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // クライアント側で処理できないイベント → turn失敗と同時にサーバー側runをinterruptする
  eventHandler!({ payload: { runId: "run-1", protocolVersion: 99, type: "turn.completed", sequence: 1, payload: {} } });
  await expect(session.promise).rejects.toThrow(/unsupported/);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ op: "turn.interrupt", streamId: "run-1" }));
});
