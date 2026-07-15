import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type {
  RunnerWsConnectionSnapshot,
  RunnerWsMessage,
  RunnerWsMessageFilter,
} from "../../runnerWs/types";
import { startCodexAppServerTurn } from "./turn";

export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
}

type FakeSubscription = {
  filter: RunnerWsMessageFilter;
  handler: (message: RunnerWsMessage) => void;
  active: boolean;
};

export class FakeRunnerWebSocketManager {
  send = jest.fn();
  disconnect = jest.fn();
  unsubscribeCalls = 0;
  private subscriptions: FakeSubscription[] = [];
  private snapshotHandlers: Array<() => void> = [];
  private resolveConnect: (() => void) | null = null;
  private connectPromise = new Promise<void>((resolve) => {
    this.resolveConnect = resolve;
  });
  private snapshot: RunnerWsConnectionSnapshot = {
    connectionState: "idle",
    appState: "active",
    clientInstanceId: "client-1",
    generation: 0,
    pendingRequestCount: 0,
    subscriptionCount: 0,
    url: "ws://127.0.0.1:8788/runner-ws",
    readyState: FakeWebSocket.CLOSED,
    connected: false,
    reconnectCount: 0,
  };

  connect = jest.fn(() => this.connectPromise);

  getSnapshot = () => ({
    ...this.snapshot,
    subscriptionCount: this.subscriptions.filter((subscription) => subscription.active).length,
  });

  subscribe = (
    filter: RunnerWsMessageFilter,
    handler: (message: RunnerWsMessage) => void
  ) => {
    const subscription = { filter, handler, active: true };
    this.subscriptions.push(subscription);
    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      this.unsubscribeCalls += 1;
    };
  };

  subscribeSnapshot = (handler: () => void) => {
    this.snapshotHandlers.push(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.unsubscribeCalls += 1;
      this.snapshotHandlers = this.snapshotHandlers.filter((item) => item !== handler);
    };
  };

  becomeReady() {
    this.snapshot = {
      ...this.snapshot,
      connectionState: "ready",
      readyState: FakeWebSocket.OPEN,
      connected: true,
      generation: this.snapshot.generation + 1,
    };
    for (const handler of this.snapshotHandlers) handler();
    this.resolveConnect?.();
  }

  dropConnection() {
    this.snapshot = {
      ...this.snapshot,
      connectionState: "reconnecting",
      readyState: FakeWebSocket.CLOSED,
      connected: false,
    };
    for (const handler of this.snapshotHandlers) handler();
  }

  setAppState(
    appState: RunnerWsConnectionSnapshot["appState"],
    connectionState = this.snapshot.connectionState
  ) {
    this.snapshot = { ...this.snapshot, appState, connectionState };
    for (const handler of this.snapshotHandlers) handler();
  }

  repeatSnapshot() {
    for (const handler of this.snapshotHandlers) handler();
  }

  emit(message: RunnerWsMessage) {
    for (const subscription of this.subscriptions) {
      if (!subscription.active || !filterMatches(subscription.filter, message)) continue;
      subscription.handler(message);
    }
  }
}

function filterMatches(filter: RunnerWsMessageFilter, message: RunnerWsMessage) {
  return (
    (filter.channel === undefined || filter.channel === message.channel) &&
    (filter.op === undefined || filter.op === message.op) &&
    (filter.requestId === undefined || filter.requestId === message.requestId) &&
    (filter.operationId === undefined || filter.operationId === message.operationId) &&
    (filter.sessionId === undefined || filter.sessionId === message.sessionId) &&
    (filter.threadId === undefined || filter.threadId === message.threadId)
  );
}

export function createTurn(
  manager: FakeRunnerWebSocketManager,
  wsUrl = "ws://127.0.0.1:8788/runner-ws",
  threadId = "",
  timeoutMs?: number
) {
  return startCodexAppServerTurn({
    wsUrl,
    wsToken: "runner-token",
    traceId: "trace-1",
    inputText: "hello",
    cwd: "/tmp/project",
    threadId,
    timeoutMs,
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    onApprovalRequest: jest.fn(() => "approve_once"),
  });
}

export async function flushPromises() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

export function lastSent(manager: FakeRunnerWebSocketManager) {
  const calls = manager.send.mock.calls;
  return calls[calls.length - 1]?.[0] as RunnerWsMessage;
}

export function respondToLastRequest(
  manager: FakeRunnerWebSocketManager,
  result: unknown,
  threadId?: string
) {
  const outbound = lastSent(manager);
  const payload = outbound.payload as { id?: number };
  manager.emit({
    channel: "llm",
    op: "rpc",
    operationId: outbound.operationId,
    sessionId: outbound.sessionId,
    ...(threadId ? { threadId } : {}),
    payload: { id: payload.id, result },
  });
}
