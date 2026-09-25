import { randomUUID } from "node:crypto";

export function createVoiceApprovalBridge({ send, timeoutMs = 2 * 60 * 1000 }) {
  const pending = new Map();
  let closed = false;

  return {
    request(operationId, { method, params, threadId, turnId }) {
      if (closed) return Promise.reject(new Error("Voice approval channel closed"));
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("Voice approval timed out"));
        }, timeoutMs);
        pending.set(requestId, { operationId, timer, resolve, reject });
        try {
          if (send({ requestId, operationId, method, params, threadId, turnId }) !== true) {
            throw new Error("Voice approval channel closed");
          }
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    decide(operationId, requestId, decision) {
      const entry = pending.get(requestId);
      if (!entry || entry.operationId !== operationId
        || !["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return false;
      pending.delete(requestId);
      clearTimeout(entry.timer);
      if (decision === "cancel") entry.reject(new Error("Voice approval cancelled"));
      else entry.resolve(decision);
      return true;
    },
    close() {
      closed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Voice approval channel closed"));
      }
      pending.clear();
    },
  };
}
