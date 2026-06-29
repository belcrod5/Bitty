import { createWebSocketWithOptionalAuth } from "../ws/webSocketAuth";
import {
  isRunnerWsMessage,
  normalizeRunnerWsServerStatus,
  type RunnerWsAppState,
  type RunnerWsConnectionSnapshot,
  type RunnerWsConnectionState,
  type RunnerWsMessage,
  type RunnerWsMessageFilter,
  type RunnerWsServerStatus,
} from "./types";

const RUNNER_WS_ENVELOPE_MAX_CHARS = 32 * 1024 * 1024;
const RUNNER_WS_MAX_BUFFERED_AMOUNT = 32 * 1024 * 1024;
const RUNNER_WS_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RUNNER_WS_MAX_PENDING_REQUESTS = 500;
const RUNNER_WS_RECONNECT_BASE_DELAY_MS = 1_000;
const RUNNER_WS_RECONNECT_MAX_DELAY_MS = 10_000;
const RUNNER_WS_RECONNECT_JITTER_MS = 250;
const RUNNER_WS_HEARTBEAT_INTERVAL_MS = 15_000;

type RunnerWebSocketManagerOptions = {
  url: string;
  token: string;
  appState?: RunnerWsAppState;
  clientInstanceId?: string;
};

type RunnerWsPendingRequest = {
  requestId: string;
  resolve: (message: RunnerWsMessage) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

type RunnerWsSubscriber = {
  filter: RunnerWsMessageFilter;
  handler: (message: RunnerWsMessage) => void;
};

type ConnectWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

function normalizeUrl(value: unknown) {
  const raw = normalizeText(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.pathname = "/runner-ws";
    return url.toString();
  } catch {
    return raw;
  }
}

function makeError(code: string, detail?: string) {
  return new Error(detail ? `${code}: ${detail}` : code);
}

function isAuthFailureCloseReason(reason: string) {
  const normalized = normalizeText(reason).toLowerCase();
  return (
    normalized.includes("401") ||
    normalized.includes("403") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden")
  );
}

function createClientInstanceId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `runner-ws-${Date.now().toString(36)}-${random}`;
}

function parseMessage(data: unknown): RunnerWsMessage | null {
  if (typeof data !== "string" || data.length > RUNNER_WS_ENVELOPE_MAX_CHARS) return null;
  try {
    const parsed = JSON.parse(data);
    return isRunnerWsMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function filterMatches(filter: RunnerWsMessageFilter, message: RunnerWsMessage) {
  return (
    (filter.channel === undefined || filter.channel === message.channel) &&
    (filter.op === undefined || filter.op === message.op) &&
    (filter.requestId === undefined || filter.requestId === message.requestId) &&
    (filter.operationId === undefined || filter.operationId === message.operationId) &&
    (filter.sessionId === undefined || filter.sessionId === message.sessionId) &&
    (filter.threadId === undefined || filter.threadId === message.threadId) &&
    (filter.streamId === undefined || filter.streamId === message.streamId)
  );
}

function readServerStatus(message: RunnerWsMessage): RunnerWsServerStatus | undefined {
  const payload = message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
    ? message.payload as Record<string, unknown>
    : undefined;
  if (!payload) return undefined;
  return normalizeRunnerWsServerStatus(payload.serverStatus || payload.status || payload);
}

export class RunnerWebSocketManager {
  private url: string;
  private token: string;
  private ws: WebSocket | null = null;
  private connectionState: RunnerWsConnectionState = "idle";
  private appState: RunnerWsAppState;
  private clientInstanceId: string;
  private connectionId: string | undefined;
  private generation = 0;
  private reconnectCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectWaiter: ConnectWaiter | null = null;
  private pendingRequests = new Map<string, RunnerWsPendingRequest>();
  private subscribers = new Map<number, RunnerWsSubscriber>();
  private snapshotSubscribers = new Set<() => void>();
  private nextSubscriberId = 1;
  private nextRequestId = 1;
  private lastError: string | undefined;
  private openedAtMs: number | undefined;
  private lastMessageAtMs: number | undefined;
  private lastCloseAtMs: number | undefined;
  private sentCount = 0;
  private receivedCount = 0;
  private sendErrorCount = 0;
  private closeCount = 0;
  private errorCount = 0;
  private lastPongAt: number | undefined;
  private lastPingAt: number | undefined;
  private missedPingCount = 0;
  private consecutiveMissedPingCount = 0;
  private lastPingRttMs: number | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private runnerWsConnectionCount: number | undefined;
  private serverStatus: RunnerWsServerStatus | undefined;
  private cachedSnapshot: RunnerWsConnectionSnapshot;

  constructor(options: RunnerWebSocketManagerOptions) {
    this.url = normalizeUrl(options.url);
    this.token = normalizeText(options.token);
    this.appState = options.appState || "unknown";
    this.clientInstanceId = normalizeText(options.clientInstanceId) || createClientInstanceId();
    if (this.appState === "background") {
      this.connectionState = "background";
    }
    this.cachedSnapshot = this.buildSnapshot();
  }

  setConnectionOptions(options: { url: string; token: string }) {
    const nextUrl = normalizeUrl(options.url);
    const nextToken = normalizeText(options.token);
    if (nextUrl === this.url && nextToken === this.token) return;
    this.url = nextUrl;
    this.token = nextToken;
    this.disconnect("config-changed");
    if (this.appState === "active" && this.url) {
      this.connect().catch(() => undefined);
    }
  }

  connect(): Promise<void> {
    if (this.connectionState === "ready" && this.ws) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.appState === "background") {
      return Promise.reject(makeError("runner_ws_background"));
    }
    if (!this.url) {
      return Promise.reject(makeError("runner_ws_url_required"));
    }

    this.clearReconnectTimer();
    this.connectionState = this.connectionState === "reconnecting" ? "reconnecting" : "connecting";
    this.lastError = undefined;
    this.emitSnapshot();

    let socket: WebSocket;
    try {
      socket = createWebSocketWithOptionalAuth(this.url, this.token);
    } catch (error) {
      const failure = error instanceof Error ? error : makeError("runner_ws_connect_failed");
      this.lastError = failure.message;
      if (this.appState === "active") {
        this.scheduleReconnect();
      } else {
        this.connectionState = "idle";
        this.emitSnapshot();
      }
      return Promise.reject(failure);
    }
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectWaiter = { resolve, reject };
    });
    this.attachSocket(socket, this.generation + 1);
    return this.connectPromise;
  }

  disconnect(reason: "background" | "manual" | "logout" | "config-changed" = "manual") {
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    const nextState: RunnerWsConnectionState = reason === "background" ? "background" : "stopped";
    this.connectionState = nextState;
    this.rejectConnectWaiter(makeError(`runner_ws_disconnected_${reason}`));
    this.rejectAllPending(makeError(`runner_ws_disconnected_${reason}`));
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Closing best-effort; state and pending requests are already settled.
      }
    }
    this.emitSnapshot();
  }

  setAppState(nextAppState: RunnerWsAppState) {
    if (nextAppState === this.appState) return;
    const previous = this.appState;
    this.appState = nextAppState;
    if (nextAppState === "background") {
      this.disconnect("background");
      return;
    }
    if (nextAppState === "active" && previous === "background") {
      if (this.connectionState === "background") {
        this.connectionState = "idle";
      }
      this.emitSnapshot();
      if (this.url) {
        this.connect().catch(() => undefined);
      }
      return;
    }
    this.emitSnapshot();
  }

  send(message: RunnerWsMessage): void {
    if (this.connectionState !== "ready" || !this.ws) {
      this.sendErrorCount += 1;
      this.emitSnapshot();
      throw makeError("runner_ws_not_ready", this.connectionState);
    }
    if ((this.ws.bufferedAmount || 0) > RUNNER_WS_MAX_BUFFERED_AMOUNT) {
      this.sendErrorCount += 1;
      this.lastError = "runner_ws_buffered_amount_exceeded";
      this.emitSnapshot();
      throw makeError("runner_ws_buffered_amount_exceeded");
    }
    const payload = JSON.stringify(message);
    if (payload.length > RUNNER_WS_ENVELOPE_MAX_CHARS) {
      this.sendErrorCount += 1;
      this.lastError = "runner_ws_message_too_large";
      this.emitSnapshot();
      throw makeError("runner_ws_message_too_large");
    }
    try {
      this.ws.send(payload);
      this.sentCount += 1;
      this.refreshSnapshot();
    } catch (error) {
      this.sendErrorCount += 1;
      this.lastError = error instanceof Error ? error.message : "runner_ws_send_failed";
      this.emitSnapshot();
      throw error;
    }
  }

  request<TResponse extends RunnerWsMessage = RunnerWsMessage>(
    message: RunnerWsMessage,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<TResponse> {
    if (this.connectionState !== "ready") {
      return Promise.reject(makeError("runner_ws_not_ready", this.connectionState));
    }
    if (this.pendingRequests.size >= RUNNER_WS_MAX_PENDING_REQUESTS) {
      return Promise.reject(makeError("runner_ws_pending_limit_exceeded"));
    }
    const requestId = normalizeText(message.requestId) || this.makeRequestId();
    if (this.pendingRequests.has(requestId)) {
      return Promise.reject(makeError("runner_ws_duplicate_request_id", requestId));
    }
    const timeoutMs = Math.max(1, Number(options.timeoutMs || RUNNER_WS_DEFAULT_REQUEST_TIMEOUT_MS));
    const outbound = { ...message, requestId };

    return new Promise<TResponse>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        if (options.signal && abortListener) {
          options.signal.removeEventListener("abort", abortListener);
        }
      };
      const finishReject = (error: Error) => {
        cleanup();
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (!this.pendingRequests.delete(requestId)) return;
        finishReject(makeError("runner_ws_request_timeout", requestId));
        this.emitSnapshot();
      }, timeoutMs);
      const abortListener = () => {
        if (!this.pendingRequests.delete(requestId)) return;
        finishReject(makeError("runner_ws_request_aborted", requestId));
        this.emitSnapshot();
      };
      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timeout);
          reject(makeError("runner_ws_request_aborted", requestId));
          return;
        }
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
      this.pendingRequests.set(requestId, {
        requestId,
        resolve: (response) => {
          cleanup();
          resolve(response as TResponse);
        },
        reject: finishReject,
        cleanup,
      });
      this.emitSnapshot();
      try {
        this.send(outbound);
      } catch (error) {
        if (this.pendingRequests.delete(requestId)) {
          finishReject(error instanceof Error ? error : makeError("runner_ws_send_failed"));
          this.emitSnapshot();
        }
      }
    });
  }

  subscribe(filter: RunnerWsMessageFilter, handler: (message: RunnerWsMessage) => void): () => void {
    const id = this.nextSubscriberId;
    this.nextSubscriberId += 1;
    this.subscribers.set(id, { filter: { ...filter }, handler });
    this.emitSnapshot();
    return () => {
      if (this.subscribers.delete(id)) {
        this.emitSnapshot();
      }
    };
  }

  subscribeSnapshot = (handler: () => void): (() => void) => {
    this.snapshotSubscribers.add(handler);
    return () => {
      this.snapshotSubscribers.delete(handler);
    };
  };

  getSnapshot = (): RunnerWsConnectionSnapshot => this.cachedSnapshot;

  private attachSocket(socket: WebSocket, generation: number) {
    this.generation = generation;
    this.ws = socket;
    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.openedAtMs = Date.now();
      this.connectionState = "handshaking";
      this.emitSnapshot();
    };
    socket.onmessage = (event) => {
      if (!this.isCurrent(socket, generation)) return;
      this.handleMessage(event.data);
    };
    socket.onerror = (event) => {
      if (!this.isCurrent(socket, generation)) return;
      this.errorCount += 1;
      this.lastError = String((event as ErrorEvent)?.message || "runner_ws_socket_error");
      this.emitSnapshot();
    };
    socket.onclose = (event) => {
      if (!this.isCurrent(socket, generation)) return;
      this.handleClose(String((event as CloseEvent)?.reason || ""));
    };
    this.emitSnapshot();
  }

  private handleMessage(data: unknown) {
    const message = parseMessage(data);
    if (!message) return;
    this.receivedCount += 1;
    this.lastMessageAtMs = Date.now();
    let shouldNotifySnapshot = false;
    if (message.channel === "control" && (message.op === "ready" || message.op === "pong")) {
      this.updateControlSnapshot(message);
      shouldNotifySnapshot = true;
      if (message.op === "ready") {
        this.connectionState = "ready";
        this.resolveConnectWaiter();
        this.startHeartbeat();
      }
    }

    if (message.requestId) {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        this.pendingRequests.delete(message.requestId);
        pending.resolve(message);
        shouldNotifySnapshot = true;
      }
    }

    this.deliverMessage(message);
    if (shouldNotifySnapshot) {
      this.emitSnapshot();
    } else {
      this.refreshSnapshot();
    }
  }

  private updateControlSnapshot(message: RunnerWsMessage) {
    const now = Date.now();
    if (message.op === "pong") {
      this.lastPongAt = now;
      if (this.lastPingAt) {
        this.lastPingRttMs = Math.max(0, now - this.lastPingAt);
      }
      this.consecutiveMissedPingCount = 0;
    }
    const payload = message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
      ? message.payload as Record<string, unknown>
      : {};
    const connectionId = normalizeText(payload.connectionId);
    const sessionId = normalizeText(message.sessionId);
    if (connectionId || sessionId) {
      this.connectionId = connectionId || sessionId;
    }
    const status = readServerStatus(message);
    if (status) {
      this.serverStatus = status;
      this.runnerWsConnectionCount = status.runnerWsConnectionCount;
    }
  }

  private deliverMessage(message: RunnerWsMessage) {
    for (const subscriber of this.subscribers.values()) {
      if (!filterMatches(subscriber.filter, message)) continue;
      try {
        subscriber.handler(message);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : "runner_ws_subscriber_failed";
      }
    }
  }

  private handleClose(reason: string) {
    this.ws = null;
    this.clearHeartbeatTimer();
    this.closeCount += 1;
    this.lastCloseAtMs = Date.now();
    this.rejectConnectWaiter(makeError("runner_ws_closed_before_ready", reason || undefined));
    this.rejectAllPending(makeError("runner_ws_disconnected", reason || undefined));
    if (this.connectionState === "background" || this.connectionState === "stopped") {
      this.emitSnapshot();
      return;
    }
    if (isAuthFailureCloseReason(reason)) {
      this.connectionState = "stopped";
      this.lastError = makeError("runner_ws_auth_failed", reason || undefined).message;
      this.emitSnapshot();
      return;
    }
    if (this.appState === "active") {
      this.scheduleReconnect();
      return;
    }
    this.connectionState = "idle";
    this.emitSnapshot();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      this.emitSnapshot();
      return;
    }
    this.connectionState = "reconnecting";
    this.reconnectCount += 1;
    const backoffMs = Math.min(
      RUNNER_WS_RECONNECT_MAX_DELAY_MS,
      RUNNER_WS_RECONNECT_BASE_DELAY_MS * (2 ** Math.min(5, this.reconnectCount - 1))
    );
    const jitterMs = Math.floor(Math.random() * RUNNER_WS_RECONNECT_JITTER_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.appState !== "active" || this.connectionState === "background" || this.connectionState === "stopped") {
        this.emitSnapshot();
        return;
      }
      this.connect().catch(() => undefined);
    }, backoffMs + jitterMs);
    this.emitSnapshot();
  }

  private resolveConnectWaiter() {
    const waiter = this.connectWaiter;
    this.connectWaiter = null;
    this.connectPromise = null;
    if (waiter) {
      waiter.resolve();
    }
  }

  private rejectConnectWaiter(error: Error) {
    const waiter = this.connectWaiter;
    this.connectWaiter = null;
    this.connectPromise = null;
    if (waiter) {
      waiter.reject(error);
    }
  }

  private rejectAllPending(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startHeartbeat() {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeatPing();
    }, RUNNER_WS_HEARTBEAT_INTERVAL_MS);
    this.unrefTimer(this.heartbeatTimer);
  }

  private sendHeartbeatPing() {
    if (this.connectionState !== "ready" || !this.ws) {
      this.clearHeartbeatTimer();
      return;
    }
    if (this.lastPingAt && (!this.lastPongAt || this.lastPongAt < this.lastPingAt)) {
      this.missedPingCount += 1;
      this.consecutiveMissedPingCount += 1;
    }
    this.lastPingAt = Date.now();
    try {
      this.send({
        channel: "control",
        op: "ping",
        payload: {
          clientInstanceId: this.clientInstanceId,
          connectionId: this.connectionId,
          generation: this.generation,
        },
      });
    } catch {
      // send() already updates the diagnostic snapshot and error counters.
    }
  }

  private clearHeartbeatTimer() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private unrefTimer(timer: ReturnType<typeof setInterval>) {
    const maybeUnref = timer as ReturnType<typeof setInterval> & { unref?: () => void };
    maybeUnref.unref?.();
  }

  private makeRequestId() {
    const id = `${this.clientInstanceId}-${Date.now().toString(36)}-${this.nextRequestId}`;
    this.nextRequestId += 1;
    return id;
  }

  private isCurrent(socket: WebSocket, generation: number) {
    return this.ws === socket && this.generation === generation;
  }

  private buildSnapshot(): RunnerWsConnectionSnapshot {
    return {
      connectionState: this.connectionState,
      appState: this.appState,
      clientInstanceId: this.clientInstanceId,
      connectionId: this.connectionId,
      generation: this.generation,
      pendingRequestCount: this.pendingRequests.size,
      subscriptionCount: this.subscribers.size,
      bufferedAmount: this.ws?.bufferedAmount || 0,
      lastPongAt: this.lastPongAt,
      runnerWsConnectionCount: this.runnerWsConnectionCount,
      lastError: this.lastError,
      url: this.url,
      readyState: this.ws?.readyState ?? ((WebSocket as typeof WebSocket & { CLOSED?: number }).CLOSED ?? 3),
      connected: this.connectionState === "ready",
      reconnectCount: this.reconnectCount,
      openedAtMs: this.openedAtMs,
      lastMessageAtMs: this.lastMessageAtMs,
      lastCloseAtMs: this.lastCloseAtMs,
      sentCount: this.sentCount,
      receivedCount: this.receivedCount,
      sendErrorCount: this.sendErrorCount,
      closeCount: this.closeCount,
      errorCount: this.errorCount,
      missedPingCount: this.missedPingCount,
      consecutiveMissedPingCount: this.consecutiveMissedPingCount,
      lastPingRttMs: this.lastPingRttMs,
      serverStatus: this.serverStatus,
    };
  }

  private refreshSnapshot() {
    this.cachedSnapshot = this.buildSnapshot();
  }

  private emitSnapshot() {
    this.refreshSnapshot();
    for (const handler of this.snapshotSubscribers) {
      handler();
    }
  }
}
