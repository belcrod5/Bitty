import { useEffect, useRef } from "react";
import { useRunnerWebSocketManager, useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import type { ApprovalAction, ApprovalRequest } from "../../codex/approvalFlow";
import { normalizeAppServerApprovalRequest, toCodexApprovalDecision } from "../../codex/client/helpers";

export function useVoiceApprovals(
  onRequest: ((request: ApprovalRequest) => Promise<ApprovalAction>) | undefined,
  onResolved: ((request: ApprovalRequest) => void) | undefined,
  orchestrators: { id: string; name: string }[],
) {
  const manager = useRunnerWebSocketManager();
  const { connected } = useRunnerWebSocketSnapshot();
  const callbacks = useRef({ onRequest, onResolved, orchestrators });
  const pending = useRef(new Map<string, { request: ApprovalRequest; operationId: string }>());
  callbacks.current = { onRequest, onResolved, orchestrators };

  useEffect(() => {
    if (connected) return;
    for (const { request } of pending.current.values()) callbacks.current.onResolved?.(request);
    pending.current.clear();
  }, [connected]);

  useEffect(() => {
    const unsubscribe = manager.subscribe({ channel: "agent", op: "voice.approval.request" }, (message) => {
      const payload = message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
        ? message.payload as Record<string, unknown> : {};
      const requestId = String(payload.requestId || "");
      const operationId = String(message.operationId || "");
      const method = String(payload.method || "");
      if (!requestId || !operationId || pending.current.has(requestId)
        || (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval")) return;
      const title = callbacks.current.orchestrators.find((item) => item.id === payload.orchestratorId)?.name;
      const request = {
        ...normalizeAppServerApprovalRequest(payload.params, {
          rpcId: 0, method, threadId: String(payload.threadId || ""), turnId: String(payload.turnId || ""),
        }),
        requestId,
        sessionInfo: { sessionId: String(payload.threadId || ""), sessionTitle: title || "音声会話" },
      };
      pending.current.set(requestId, { request, operationId });
      const decision = callbacks.current.onRequest?.(request) ?? Promise.resolve<ApprovalAction>("decline");
      void Promise.resolve(decision)
        .then((action) => {
          if (pending.current.get(requestId)?.request !== request) return;
          return manager.request({ channel: "agent", op: "voice.approval.decision", operationId,
            payload: { requestId, decision: toCodexApprovalDecision(action) } }, { timeoutMs: 30_000 });
        })
        .catch(() => undefined)
        .finally(() => {
          if (pending.current.get(requestId)?.request !== request) return;
          pending.current.delete(requestId);
          callbacks.current.onResolved?.(request);
        });
    });
    return () => {
      unsubscribe();
      for (const [requestId, { request, operationId }] of pending.current) {
        callbacks.current.onResolved?.(request);
        void manager.request({ channel: "agent", op: "voice.approval.decision",
          operationId, payload: { requestId, decision: "cancel" } }).catch(() => undefined);
      }
      pending.current.clear();
    };
  }, [manager]);
}
