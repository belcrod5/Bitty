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
