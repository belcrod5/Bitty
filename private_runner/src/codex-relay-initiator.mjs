import { randomUUID } from "node:crypto";

import { startCodexTurn } from "./codex-turn-execution.mjs";

export function createCodexRelayInitiator({ relay, forward, operationId }) {
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  const subscriber = {
    readyState: 1,
    send(raw) {
      let message;
      try {
        message = JSON.parse(String(raw ?? ""));
      } catch {
        return;
      }
      if (message?.method || (typeof message?.id !== "string" && typeof message?.id !== "number")) return;
      const entry = pending.get(String(message.id));
      if (!entry) return;
      pending.delete(String(message.id));
      if (entry.timeout) clearTimeout(entry.timeout);
      if (message.error) {
        entry.reject(new Error(String(message.error?.message || message.error || "Codex RPC failed")));
      } else {
        entry.resolve(message.result);
      }
    },
  };

  const send = (payload) => {
    if (closed) throw new Error("Codex relay initiator is closed");
    const threadId = String(relay?.threadId || "").trim();
    forward(relay, JSON.stringify(payload), false, {
      endpoint: relay?.endpoint,
      remote: relay?.remote,
      clientWs: subscriber,
      operationId,
      sessionId: threadId || operationId,
      threadId,
    });
  };

  const request = (method, params = {}, timeoutMs = 30000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? setTimeout(() => {
          pending.delete(String(id));
          reject(new Error(`Codex RPC timeout: ${method}`));
        }, Math.floor(Number(timeoutMs)))
        : null;
      pending.set(String(id), { resolve, reject, timeout });
      try {
        send({ id, method, params });
      } catch (error) {
        pending.delete(String(id));
        if (timeout) clearTimeout(timeout);
        reject(error);
      }
    });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      if (entry.timeout) clearTimeout(entry.timeout);
      entry.reject(new Error("Codex relay initiator closed"));
    }
    pending.clear();
  };

  return {
    client: {
      openPromise: Promise.resolve(),
      request,
      notify: (method, params = {}) => send({ method, params }),
    },
    subscriber,
    close,
  };
}

export function createNormalCodexTurnStarter({
  createRelay,
  attachClient,
  forwardClientData,
  removeClient,
  cleanupDetachedRelay,
}) {
  return async function startNormalCodexTurn({
    inputText,
    cwd,
    model = "",
    effort = "",
    serviceName = "private-runner-scheduled-codex",
  }) {
    const operationId = `runner_initiated_${randomUUID()}`;
    const relay = createRelay({
      endpoint: "/runner-initiated-codex",
      remote: "runner",
    });
    const initiator = createCodexRelayInitiator({
      relay,
      forward: forwardClientData,
      operationId,
    });
    attachClient(relay, initiator.subscriber);
    let cleanupStartedTurn = () => {};
    try {
      const started = await startCodexTurn({
        client: initiator.client,
        clientName: serviceName,
        inputText,
        cwd,
        model,
        effort,
        approvalPolicy: "on-request",
      });
      cleanupStartedTurn = started.cleanup;
      return { threadId: started.threadId, turnId: started.turnId };
    } finally {
      cleanupStartedTurn();
      initiator.close();
      removeClient(relay, initiator.subscriber);
      cleanupDetachedRelay(relay, "runner_initiator_detached");
    }
  };
}
