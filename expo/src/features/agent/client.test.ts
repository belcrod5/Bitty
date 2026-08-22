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
