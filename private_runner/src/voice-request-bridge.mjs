import { randomUUID } from "node:crypto";
import { isValidUserInputResponse } from "./codex-user-input.mjs";

export function createVoiceRequestBridge({ send, onResolved, timeoutMs = 2 * 60 * 1000 }) {
  const pending = new Map();
  let closed = false;

  return {
    request(operationId, { method, params, threadId, turnId, startedAtMs = Date.now() }, orchestratorId = "main", orchestratorName = "", signal) {
      const question = method === "item/tool/requestUserInput";
      if (question && Date.now() >= startedAtMs + 60_000) return Promise.resolve({ answers: {} });
      if (closed || signal?.aborted) return question ? Promise.resolve({ answers: {} })
        : Promise.reject(new Error("Voice approval channel closed"));
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        let announced = false;
        const finish = (value, error) => {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (question && announced) {
            try { onResolved?.({ requestId, operationId, orchestratorId }); } catch {}
          }
          if (error && !question) reject(error);
          else resolve(question && error ? { answers: {} } : value);
        };
        const abort = () => finish({ answers: {} }, new Error("Voice approval cancelled"));
        const timer = setTimeout(() => finish({ answers: {} }, new Error("Voice approval timed out")),
          question ? Math.max(0, startedAtMs + 60_000 - Date.now()) : timeoutMs);
        pending.set(requestId, { operationId, question, params, startedAtMs, finish });
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (send({ requestId, operationId, method, params, threadId, turnId, orchestratorId, orchestratorName,
            ...(question ? { startedAtMs } : {}) }) !== true) {
            throw new Error("Voice approval channel closed");
          }
          announced = true;
        } catch (error) {
          finish({ answers: {} }, error);
        }
      });
    },
    decide(operationId, requestId, decision) {
      const entry = pending.get(requestId);
      if (!entry || entry.question || entry.operationId !== operationId
        || !["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return false;
      entry.finish(decision, decision === "cancel" ? new Error("Voice approval cancelled") : null);
      return true;
    },
    respond(operationId, requestId, result) {
      const entry = pending.get(requestId);
      if (!entry?.question || entry.operationId !== operationId) return false;
      if (Date.now() >= entry.startedAtMs + 60_000) {
        entry.finish({ answers: {} });
        return false;
      }
      if (!isValidUserInputResponse(entry.params, result)) return false;
      entry.finish({ answers: result.answers });
      return true;
    },
    close() {
      closed = true;
      for (const entry of pending.values()) {
        entry.finish({ answers: {} }, new Error("Voice approval channel closed"));
      }
      pending.clear();
    },
  };
}
