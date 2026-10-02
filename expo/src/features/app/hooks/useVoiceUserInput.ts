import { useEffect, useRef, useSyncExternalStore } from "react";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { UserInputRequest } from "../../codex/userInput";
import { useUserInputRequestController } from "./useUserInputRequestController";

export function useVoiceUserInput(manager: RunnerWebSocketManager, visibleOrchestratorId: string) {
  const controller = useUserInputRequestController(visibleOrchestratorId);
  const { ask, resolved, decide } = controller;
  const pending = useRef(new Map<string, { request: UserInputRequest; operationId: string }>());
  const connected = useSyncExternalStore(manager.subscribeSnapshot,
    () => manager.getSnapshot().connected, () => manager.getSnapshot().connected);

  useEffect(() => {
    if (connected) return;
    pending.current.clear();
    decide(null);
  }, [connected, decide]);

  useEffect(() => {
    const unsubscribeRequest = manager.subscribe({ channel: "agent", op: "voice.userInput.request" }, (message) => {
      const payload = message.payload as Record<string, unknown> | undefined;
      const params = payload?.params as Record<string, unknown> | undefined;
      const requestId = String(payload?.requestId || "");
      const operationId = String(message.operationId || "");
      const orchestratorId = String(payload?.orchestratorId || "");
      const threadId = String(payload?.threadId || "");
      const startedAtMs = payload?.startedAtMs;
      if (!requestId || !operationId || !orchestratorId || !threadId || pending.current.has(requestId)
        || typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs) || !Array.isArray(params?.questions)) return;
      const request: UserInputRequest = { requestId, threadId, startedAtMs, questions: params.questions };
      pending.current.set(requestId, { request, operationId });
      void ask(request, orchestratorId).then(async (result) => {
        if (!result || pending.current.get(requestId)?.request !== request) return;
        await manager.request({ channel: "agent", op: "voice.userInput.respond", operationId,
          payload: { requestId, result } }, { timeoutMs: 30_000 });
      }).catch(() => undefined).finally(() => {
        if (pending.current.get(requestId)?.request !== request) return;
        pending.current.delete(requestId);
        resolved(request);
      });
    });
    const unsubscribeResolved = manager.subscribe({ channel: "agent", op: "voice.userInput.resolved" }, (message) => {
      const payload = message.payload as Record<string, unknown> | undefined;
      const requestId = String(payload?.requestId || "");
      const entry = pending.current.get(requestId);
      if (!entry || entry.operationId !== message.operationId) return;
      pending.current.delete(requestId);
      resolved(entry.request);
    });
    return () => {
      unsubscribeRequest();
      unsubscribeResolved();
      pending.current.clear();
    };
  }, [ask, resolved, manager]);

  return controller;
}
