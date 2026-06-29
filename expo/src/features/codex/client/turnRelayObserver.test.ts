import { createWebSocketWithOptionalAuth } from "../../ws/webSocketAuth";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type {
  RunnerWsConnectionSnapshot,
  RunnerWsMessage,
  RunnerWsMessageFilter,
} from "../../runnerWs/types";
import { startCodexAppServerTurnRelayObserver } from "./turnRelayObserver";

jest.mock("../../ws/webSocketAuth", () => ({
  createWebSocketWithOptionalAuth: jest.fn(),
}));

const mockCreateWebSocketWithOptionalAuth = jest.mocked(createWebSocketWithOptionalAuth);

type FakeSubscription = {
  filter: RunnerWsMessageFilter;
  handler: (message: RunnerWsMessage) => void;
  active: boolean;
};

class FakeRunnerWebSocketManager {
  connect = jest.fn(() => this.connectPromise);
  send = jest.fn();
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
    readyState: 3,
    connected: false,
    reconnectCount: 0,
  };

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

  becomeReady(generation = 1) {
    this.snapshot = {
      ...this.snapshot,
      connectionState: "ready",
      generation,
      readyState: 1,
      connected: true,
    };
    for (const handler of this.snapshotHandlers) {
      handler();
    }
    this.resolveConnect?.();
  }

  emit(message: RunnerWsMessage) {
    for (const subscription of this.subscriptions) {
      if (!subscription.active) continue;
      if (!filterMatches(subscription.filter, message)) continue;
      subscription.handler(message);
    }
  }
}

function filterMatches(filter: RunnerWsMessageFilter, message: RunnerWsMessage) {
  return (
    (filter.channel === undefined || filter.channel === message.channel) &&
    (filter.op === undefined || filter.op === message.op) &&
    (filter.threadId === undefined || filter.threadId === message.threadId)
  );
}

function createObserver(manager: FakeRunnerWebSocketManager, overrides = {}) {
  return startCodexAppServerTurnRelayObserver({
    wsUrl: "ws://127.0.0.1:8788/runner-ws",
    wsToken: "runner-token",
    threadId: "thread-1",
    resumeFromSeq: 4,
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    onApprovalRequest: jest.fn(() => "approve_once"),
    ...overrides,
  });
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  mockCreateWebSocketWithOptionalAuth.mockReset();
});

test("manager mode does not create an observer socket and sends relay resume after ready", async () => {
  const manager = new FakeRunnerWebSocketManager();

  const observer = createObserver(manager);
  expect(mockCreateWebSocketWithOptionalAuth).not.toHaveBeenCalled();
  expect(manager.connect).toHaveBeenCalledTimes(1);

  manager.becomeReady();
  await flushPromises();

  expect(manager.send).toHaveBeenCalledWith({
    channel: "relay",
    op: "resume",
    threadId: "thread-1",
    seq: 4,
  });
  observer.close();
});

test("manager mode unsubscribes on close without closing the singleton", () => {
  const manager = new FakeRunnerWebSocketManager();
  const observer = createObserver(manager);

  observer.close();

  expect(manager.unsubscribeCalls).toBe(4);
  expect("disconnect" in manager).toBe(false);
});

test("manager mode sends approval decisions through llm rpc envelopes", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const onApprovalRequest = jest.fn(async () => "approve_once" as const);
  const observer = createObserver(manager, { onApprovalRequest });
  manager.becomeReady();
  await flushPromises();
  manager.send.mockClear();

  manager.emit({
    channel: "llm",
    op: "rpc",
    threadId: "thread-1",
    payload: {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        requestId: "approval-1",
        command: "ls",
        args: ["-la"],
      },
    },
  });
  await flushPromises();

  expect(onApprovalRequest).toHaveBeenCalledTimes(1);
  expect(manager.send).toHaveBeenCalledWith({
    channel: "llm",
    op: "rpc",
    threadId: "thread-1",
    payload: {
      id: 7,
      result: {
        decision: "accept",
      },
    },
  });
  observer.close();
});
