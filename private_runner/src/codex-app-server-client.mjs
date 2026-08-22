import { WebSocket } from "ws";

import { codexTurnEventMatches } from "./codex-turn-execution.mjs";

export function createCodexAppServerClient({
  signal,
  upstreamUrl,
  upstreamToken = "",
  turnCompletionTimeoutMs = 24 * 60 * 60 * 1000,
  WebSocketImpl = WebSocket,
} = {}) {
  const headers = {};
  if (upstreamToken) headers.authorization = `Bearer ${upstreamToken}`;
  const ws = new WebSocketImpl(upstreamUrl, { headers });
  const pending = new Map();
  const completionWaiters = new Set();
  const notificationListeners = new Set();
  const serverRequestHandlers = new Set();
  let nextId = 1;
  let closed = false;
  let detachAbortListener = () => {};

  const finishCompletionWaiters = () => {
    for (const waiter of completionWaiters) waiter.finish();
    completionWaiters.clear();
  };
  const close = (code = 1000, reason = "closed") => {
    if (closed) return;
    closed = true;
    detachAbortListener();
    for (const entry of pending.values()) {
      entry.reject(new Error("Codex app-server request cancelled"));
      if (entry.timeout) clearTimeout(entry.timeout);
    }
    pending.clear();
    finishCompletionWaiters();
    const openState = Number.isInteger(WebSocketImpl.OPEN) ? WebSocketImpl.OPEN : 1;
    const connectingState = Number.isInteger(WebSocketImpl.CONNECTING) ? WebSocketImpl.CONNECTING : 0;
    if (ws.readyState === openState || ws.readyState === connectingState) {
      try {
        ws.close(code, reason);
      } catch {}
    }
  };
  const openPromise = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
    ws.on("close", (code, reasonBuf) => {
      const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString("utf8") : String(reasonBuf || "");
      if (closed) return;
      closed = true;
      const message = `Codex app-server WebSocket closed code=${Number(code) || 0} reason=${reason || "-"}`;
      for (const entry of pending.values()) {
        entry.reject(new Error(message));
        if (entry.timeout) clearTimeout(entry.timeout);
      }
      pending.clear();
      finishCompletionWaiters();
    });
  });

  ws.on("message", (data) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message?.method && (typeof message.id === "string" || typeof message.id === "number")) {
      for (const handler of serverRequestHandlers) {
        Promise.resolve(handler(message)).then((result) => {
          if (closed || ws.readyState !== WebSocketImpl.OPEN) return;
          ws.send(JSON.stringify({ id: message.id, result }));
        }).catch(() => {
          if (closed || ws.readyState !== WebSocketImpl.OPEN) return;
          ws.send(JSON.stringify({ id: message.id, result: { success: false, contentItems: [] } }));
        });
      }
      return;
    }
    if (message?.method) {
      if (message.method === "turn/completed" || message.method === "turn/interrupted") {
        for (const waiter of [...completionWaiters]) waiter.handle(message.params ?? {});
      }
      for (const listener of notificationListeners) {
        try {
          listener(String(message.method), message.params ?? {});
        } catch {}
      }
      return;
    }
    const id = Number(message?.id);
    if (!Number.isInteger(id)) return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timeout) clearTimeout(entry.timeout);
    if (message.error) {
      entry.reject(new Error(String(message.error?.message || message.error || "Codex RPC failed")));
    } else {
      entry.resolve(message.result);
    }
  });

  const send = (payload) => {
    if (closed || ws.readyState !== WebSocketImpl.OPEN) {
      throw new Error("Codex app-server WebSocket is not open");
    }
    ws.send(JSON.stringify(payload));
  };
  const request = (method, params = {}, timeoutMs = 30000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex RPC timeout: ${method}`));
        }, Math.floor(Number(timeoutMs)))
        : null;
      pending.set(id, { resolve, reject, timeout });
      try {
        send({ id, method, params });
      } catch (error) {
        pending.delete(id);
        if (timeout) clearTimeout(timeout);
        reject(error);
      }
    });
  };
  const waitForTurnCompletion = () => {
    let timer = null;
    let expected = null;
    const buffered = [];
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const finish = () => {
      if (!completionWaiters.delete(waiter)) return;
      if (timer) clearTimeout(timer);
      resolvePromise();
    };
    const handle = (params) => {
      if (!expected) {
        buffered.push(params);
        return;
      }
      if (codexTurnEventMatches(params, expected)) finish();
    };
    const expect = (identity) => {
      expected = identity;
      if (buffered.some((params) => codexTurnEventMatches(params, expected))) finish();
      buffered.length = 0;
    };
    const waiter = { finish, handle };
    completionWaiters.add(waiter);
    timer = setTimeout(finish, turnCompletionTimeoutMs);
    return { promise, expect };
  };
  if (signal) {
    const abort = () => close(1000, "aborted");
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
      detachAbortListener = () => signal.removeEventListener("abort", abort);
    }
  }

  return {
    ws,
    openPromise,
    request,
    notify: (method, params = {}) => send({ method, params }),
    close,
    waitForTurnCompletion,
    addNotificationListener(listener) {
      if (typeof listener !== "function") throw new TypeError("notification listener must be a function");
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    addServerRequestHandler(handler) {
      if (typeof handler !== "function") throw new TypeError("server request handler must be a function");
      serverRequestHandlers.add(handler);
      return () => serverRequestHandlers.delete(handler);
    },
  };
}
