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

test("manager mode mirrors seq advances and ignores seq-less llm rpc envelopes", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const onRelaySeqAdvance = jest.fn();
  const onRelayReset = jest.fn();
  const observer = createObserver(manager, {
    resumeFromSeq: 4,
    resumeFromRelayId: "relay-a",
    onRelaySeqAdvance,
    onRelayReset,
  });
  manager.becomeReady();
  await flushPromises();

  // attachedで同一relayのlatestSeqまで前進する。
  manager.emit({
    channel: "relay",
    op: "attached",
    threadId: "thread-1",
    seq: 10,
    payload: { relayId: "relay-a", latestSeq: 10, replayed: 6 },
  });
  expect(onRelayReset).not.toHaveBeenCalled();
  expect(onRelaySeqAdvance).toHaveBeenLastCalledWith({
    threadId: "thread-1",
    relayId: "relay-a",
    seq: 10,
  });

  // llm:rpc envelopeのseqでも前進をミラーする。
  manager.emit({
    channel: "llm",
    op: "rpc",
    threadId: "thread-1",
    seq: 11,
    payload: { method: "item/agentMessage/delta", params: { delta: "x" } },
  });
  expect(onRelaySeqAdvance).toHaveBeenLastCalledWith({
    threadId: "thread-1",
    relayId: "relay-a",
    seq: 11,
  });

  // seq-less envelope(共有threadless relay由来の規約)はwatermarkに影響しない。
  onRelaySeqAdvance.mockClear();
  manager.emit({
    channel: "llm",
    op: "rpc",
    threadId: "thread-1",
    payload: { method: "item/agentMessage/delta", params: { delta: "y" } },
  });
  // 過去より小さいseqも無視(後退しない)。
  manager.emit({
    channel: "llm",
    op: "rpc",
    threadId: "thread-1",
    seq: 3,
    payload: { method: "item/agentMessage/delta", params: { delta: "z" } },
  });
  expect(onRelaySeqAdvance).not.toHaveBeenCalled();
  observer.close();
});

test("manager mode resets watermark when attached reports a different relayId", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const onRelaySeqAdvance = jest.fn();
  const onRelayReset = jest.fn();
  const observer = createObserver(manager, {
    resumeFromSeq: 200,
    resumeFromRelayId: "relay-old",
    onRelaySeqAdvance,
    onRelayReset,
  });
  manager.becomeReady();
  await flushPromises();
  expect(manager.send).toHaveBeenCalledWith({
    channel: "relay",
    op: "resume",
    threadId: "thread-1",
    seq: 200,
  });

  // relayが作り直された: relayId不一致 + latestSeq後退。
  manager.emit({
    channel: "relay",
    op: "attached",
    threadId: "thread-1",
    seq: 50,
    payload: { relayId: "relay-new", latestSeq: 50, replayed: 0 },
  });
  expect(onRelayReset).toHaveBeenCalledTimes(1);
  expect(onRelayReset).toHaveBeenCalledWith({
    threadId: "thread-1",
    relayId: "relay-new",
    seq: 50,
  });
  expect(onRelaySeqAdvance).not.toHaveBeenCalled();

  // 次のWS世代のresumeはリセット後のseqで送られる(古いseqの再送=無音欠落を防ぐ)。
  manager.send.mockClear();
  manager.becomeReady(2);
  await flushPromises();
  expect(manager.send).toHaveBeenCalledWith({
    channel: "relay",
    op: "resume",
    threadId: "thread-1",
    seq: 50,
  });
  observer.close();
});

test("manager mode resets watermark when latestSeq regresses even with same relayId", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const onRelayReset = jest.fn();
  const observer = createObserver(manager, {
    resumeFromSeq: 200,
    resumeFromRelayId: "",
    onRelayReset,
  });
  manager.becomeReady();
  await flushPromises();

  manager.emit({
    channel: "relay",
    op: "attached",
    threadId: "thread-1",
    seq: 120,
    payload: { relayId: "relay-x", latestSeq: 120, replayed: 0 },
  });
  expect(onRelayReset).toHaveBeenCalledWith({
    threadId: "thread-1",
    relayId: "relay-x",
    seq: 120,
  });
  observer.close();
});

test("manager mode mirrors relayId on attached even without seq advance", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const onRelaySeqAdvance = jest.fn();
  const observer = createObserver(manager, {
    resumeFromSeq: 0,
    onRelaySeqAdvance,
  });
  manager.becomeReady();
  await flushPromises();

  // replayイベントがattachedより先に届く(サーバーはreplay→attachedの順で送る)。
  manager.emit({
    channel: "llm",
    op: "rpc",
    threadId: "thread-1",
    seq: 5,
    payload: { method: "item/agentMessage/delta", params: { delta: "x" } },
  });
  expect(onRelaySeqAdvance).toHaveBeenLastCalledWith({
    threadId: "thread-1",
    relayId: "",
    seq: 5,
  });

  // attachedはseq前進を伴わなくてもrelayIdをwatermarkへミラーする
  // (relayId空のままだと次回起動時のrelay作り直し照合が素通りになる)。
  manager.emit({
    channel: "relay",
    op: "attached",
    threadId: "thread-1",
    seq: 5,
    payload: { relayId: "relay-a", latestSeq: 5, replayed: 5 },
  });
  expect(onRelaySeqAdvance).toHaveBeenLastCalledWith({
    threadId: "thread-1",
    relayId: "relay-a",
    seq: 5,
  });
  observer.close();
});

test("manager mode falls back to seq 0 resume after resume_miss", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const observer = createObserver(manager, {
    resumeFromSeq: 200,
    resumeFromRelayId: "relay-old",
  });
  manager.becomeReady();
  await flushPromises();
  expect(manager.send).toHaveBeenCalledWith({
    channel: "relay",
    op: "resume",
    threadId: "thread-1",
    seq: 200,
  });

  // サーバーのeventLogトリムでreplay不能(resume_miss)。同じseqで再resumeし続けると
  // 恒久missになるため、次回はseq=0(サーバーの現行turn補正)へ落とす。
  manager.emit({
    channel: "relay",
    op: "resume_miss",
    threadId: "thread-1",
    seq: 200,
    payload: { resumeFromSeq: 200, reason: "relay_event_history_gap" },
  });
  manager.send.mockClear();
  manager.becomeReady(2);
  await flushPromises();
  expect(manager.send).toHaveBeenCalledWith({
    channel: "relay",
    op: "resume",
    threadId: "thread-1",
    seq: 0,
  });
  observer.close();
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
