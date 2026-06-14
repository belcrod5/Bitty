import {
  isRunnerWsMessage,
  normalizeRunnerWsServerStatus,
  type RunnerWsConnectionSnapshot,
  type RunnerWsMessage,
  type RunnerWsMessageFilter,
  type RunnerWsServerStatus,
} from "./types";
import { createWebSocketWithOptionalAuth } from "../ws/webSocketAuth";

export type RunnerWsClientOptions = {
  url: string;
  token?: string;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectJitterRatio?: number;
  onSnapshot?: (snapshot: RunnerWsConnectionSnapshot) => void;
  onOpen?: () => void;
  onClose?: (event: WebSocketCloseEvent) => void;
  onError?: (event: Event) => void;
  onInvalidMessage?: (raw: string) => void;
};

export type RunnerWsUnsubscribe = () => void;

export type RunnerWsClient = {
  send: (message: RunnerWsMessage) => boolean;
  subscribe: (
    filter: RunnerWsMessageFilter,
    handler: (message: RunnerWsMessage) => void
  ) => RunnerWsUnsubscribe;
  getSnapshot: () => RunnerWsConnectionSnapshot;
  close: () => void;
};

function matchesFilter(message: RunnerWsMessage, filter: RunnerWsMessageFilter) {
  if (filter.channel && message.channel !== filter.channel) return false;
  if (filter.op && message.op !== filter.op) return false;
  if (filter.requestId && message.requestId !== filter.requestId) return false;
  if (filter.sessionId && message.sessionId !== filter.sessionId) return false;
  if (filter.threadId && message.threadId !== filter.threadId) return false;
  if (filter.streamId && message.streamId !== filter.streamId) return false;
  return true;
}

export function createRunnerWsClient(options: RunnerWsClientOptions): RunnerWsClient {
  const url = String(options.url || "").trim();
  const token = String(options.token || "").trim();
  const reconnectEnabled = options.reconnect === true;
  const reconnectDelayMs = Number.isFinite(Number(options.reconnectDelayMs))
    ? Math.max(250, Math.floor(Number(options.reconnectDelayMs)))
    : 1000;
  const reconnectMaxDelayMs = Number.isFinite(Number(options.reconnectMaxDelayMs))
    ? Math.max(reconnectDelayMs, Math.floor(Number(options.reconnectMaxDelayMs)))
    : 5000;
  const reconnectJitterRatio = Number.isFinite(Number(options.reconnectJitterRatio))
    ? Math.min(0.5, Math.max(0, Number(options.reconnectJitterRatio)))
    : 0.2;
  const subscribers = new Set<{
    filter: RunnerWsMessageFilter;
    handler: (message: RunnerWsMessage) => void;
  }>();
  let closed = false;
  let lastError = "";
  let reconnectCount = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let ws: WebSocket | null = null;
  let openedAtMs = 0;
  let lastMessageAtMs = 0;
  let lastCloseAtMs = 0;
  let sentCount = 0;
  let receivedCount = 0;
  let sendErrorCount = 0;
  let closeCount = 0;
  let errorCount = 0;
  let missedPingCount = 0;
  let consecutiveMissedPingCount = 0;
  let lastPingRttMs: number | undefined;
  let pingSeq = 0;
  let pendingPing: { requestId: string; sentAtMs: number } | null = null;
  let serverStatus: RunnerWsServerStatus | undefined;

  function getSnapshot(): RunnerWsConnectionSnapshot {
    const readyState = ws?.readyState ?? WebSocket.CLOSED;
    const bufferedAmountRaw = Number((ws as any)?.bufferedAmount);
    return {
      url,
      readyState,
      connected: readyState === WebSocket.OPEN,
      reconnectCount,
      lastError: lastError || undefined,
      openedAtMs: openedAtMs || undefined,
      lastMessageAtMs: lastMessageAtMs || undefined,
      lastCloseAtMs: lastCloseAtMs || undefined,
      sentCount,
      receivedCount,
      sendErrorCount,
      closeCount,
      errorCount,
      missedPingCount,
      consecutiveMissedPingCount,
      lastPingRttMs,
      bufferedAmount: Number.isFinite(bufferedAmountRaw) ? bufferedAmountRaw : undefined,
      serverStatus,
    };
  }

  function notifySnapshot() {
    options.onSnapshot?.(getSnapshot());
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function clearPingTimer() {
    if (!pingTimer) return;
    clearInterval(pingTimer);
    pingTimer = null;
  }

  function sendRaw(message: RunnerWsMessage) {
    const activeWs = ws;
    if (closed || !activeWs || activeWs.readyState !== WebSocket.OPEN) {
      lastError = closed ? "client_closed" : "websocket_not_open";
      notifySnapshot();
      return false;
    }
    try {
      activeWs.send(JSON.stringify(message));
      sentCount += 1;
      notifySnapshot();
      return true;
    } catch (error) {
      sendErrorCount += 1;
      lastError = error instanceof Error ? error.message : String(error || "send_failed");
      notifySnapshot();
      return false;
    }
  }

  function sendPing() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (pendingPing) {
      missedPingCount += 1;
      consecutiveMissedPingCount += 1;
    }
    pingSeq += 1;
    const requestId = `runner-ws-ping-${now}-${pingSeq}`;
    pendingPing = { requestId, sentAtMs: now };
    sendRaw({
      channel: "control",
      op: "ping",
      requestId,
    });
  }

  function startPingTimer() {
    clearPingTimer();
    pendingPing = null;
    sendPing();
    pingTimer = setInterval(sendPing, 5000);
  }

  function scheduleReconnect() {
    if (closed || !reconnectEnabled || reconnectTimer) return;
    const baseDelayMs = Math.min(reconnectMaxDelayMs, reconnectDelayMs * Math.max(1, reconnectCount + 1));
    const jitterWindow = Math.floor(baseDelayMs * reconnectJitterRatio);
    const jitter = jitterWindow > 0
      ? Math.floor((Math.random() * (jitterWindow * 2 + 1)) - jitterWindow)
      : 0;
    const delayMs = Math.max(100, baseDelayMs + jitter);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed) return;
      reconnectCount += 1;
      notifySnapshot();
      connect();
    }, delayMs);
    notifySnapshot();
  }

  function connect() {
    clearReconnectTimer();
    try {
      ws = createWebSocketWithOptionalAuth(url, token);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error || "websocket_create_failed");
      notifySnapshot();
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      if (closed) return;
      openedAtMs = Date.now();
      pendingPing = null;
      consecutiveMissedPingCount = 0;
      notifySnapshot();
      options.onOpen?.();
      startPingTimer();
    };

    ws.onmessage = (event) => {
      if (closed) return;
      const raw = typeof event.data === "string" ? event.data : String(event.data || "");
      receivedCount += 1;
      lastMessageAtMs = Date.now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        lastError = "invalid_json_message";
        notifySnapshot();
        options.onInvalidMessage?.(raw);
        return;
      }
      if (!isRunnerWsMessage(parsed)) {
        lastError = "invalid_runner_ws_message";
        notifySnapshot();
        options.onInvalidMessage?.(raw);
        return;
      }
      if (parsed.channel === "control" && parsed.op === "pong") {
        const requestId = String(parsed.requestId || "");
        if (pendingPing && requestId === pendingPing.requestId) {
          lastPingRttMs = Math.max(0, Date.now() - pendingPing.sentAtMs);
          pendingPing = null;
          consecutiveMissedPingCount = 0;
        }
        const payload = parsed.payload && typeof parsed.payload === "object"
          ? parsed.payload as Record<string, unknown>
          : {};
        const nextServerStatus = normalizeRunnerWsServerStatus(payload.status);
        if (nextServerStatus) {
          serverStatus = nextServerStatus;
        }
        notifySnapshot();
      }
      for (const subscriber of Array.from(subscribers)) {
        if (!matchesFilter(parsed, subscriber.filter)) continue;
        try {
          subscriber.handler(parsed);
        } catch {}
      }
    };

    ws.onerror = (event) => {
      if (closed) return;
      errorCount += 1;
      lastError = String((event as any)?.message || event.type || "websocket_error");
      notifySnapshot();
      options.onError?.(event);
    };

    ws.onclose = (event) => {
      if (closed) return;
      closeCount += 1;
      lastCloseAtMs = Date.now();
      clearPingTimer();
      pendingPing = null;
      notifySnapshot();
      options.onClose?.(event);
      scheduleReconnect();
    };
  }

  connect();

  return {
    send(message) {
      return sendRaw(message);
    },
    subscribe(filter, handler) {
      const subscriber = { filter, handler };
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    getSnapshot() {
      return getSnapshot();
    },
    close() {
      if (closed) return;
      closed = true;
      clearReconnectTimer();
      clearPingTimer();
      subscribers.clear();
      const activeWs = ws;
      ws = null;
      try {
        if (activeWs?.readyState === WebSocket.OPEN || activeWs?.readyState === WebSocket.CONNECTING) {
          activeWs.close();
        }
      } catch {}
    },
  };
}
