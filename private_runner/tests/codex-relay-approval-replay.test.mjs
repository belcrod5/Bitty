import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_MOCK = "1";
process.env.RUNNER_TOKEN = process.env.RUNNER_TOKEN || "test-token";

const { __TESTING__ } = await import("../src/server-runtime.mjs");
const {
  attachClientToCodexRelay,
  handleCodexRelayUpstreamMessage,
  isCodexRelayThreadMismatch,
  shouldReplayCodexRelayEvent,
} = __TESTING__;

function approvalEvent(rpcId) {
  return {
    data: JSON.stringify({
      id: rpcId,
      method: "item/commandExecution/requestApproval",
      params: {},
    }),
  };
}

test("replays an unresolved approval", () => {
  const relay = { pendingApprovalRequestIds: new Set([8]) };
  const event = approvalEvent(8);

  assert.equal(shouldReplayCodexRelayEvent(relay, event), true);
});

test("does not replay an approval after its response was forwarded", () => {
  const relay = { pendingApprovalRequestIds: new Set() };

  assert.equal(shouldReplayCodexRelayEvent(relay, approvalEvent(8)), false);
});

test("continues replaying non-approval relay events", () => {
  const relay = { pendingApprovalRequestIds: new Set() };
  const event = {
    data: JSON.stringify({
      method: "item/completed",
      params: {},
    }),
  };

  assert.equal(shouldReplayCodexRelayEvent(relay, event), true);
});

test("replays only the current turn from seq zero without resurrecting answered approvals", () => {
  const sent = [];
  const client = {
    readyState: 1,
    send(data) {
      sent.push(JSON.parse(String(data || "{}")));
    },
  };
  const relay = {
    relayId: "relay-test",
    threadId: "thread-test",
    clients: new Set(),
    pendingApprovalRequestIds: new Set([8]),
    lastSeq: 4,
    currentTurnStartSeq: 2,
    eventLog: [
      {
        seq: 1,
        data: JSON.stringify({
          method: "turn/started",
          params: { threadId: "thread-test" },
        }),
      },
      {
        seq: 2,
        data: JSON.stringify({
          id: 8,
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread-test" },
        }),
      },
      {
        seq: 3,
        data: JSON.stringify({
          id: 9,
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread-test" },
        }),
      },
      {
        seq: 4,
        data: JSON.stringify({
          method: "item/completed",
          params: { threadId: "thread-test" },
        }),
      },
    ],
    turnCompleted: false,
    closed: false,
    cleanupTimer: null,
  };

  const replayed = attachClientToCodexRelay(relay, client, { replayAfterSeq: 0 });
  const replayedMethods = sent
    .map((message) => String(message.method || ""))
    .filter(Boolean);

  assert.equal(replayed, 2);
  assert.deepEqual(replayedMethods, [
    "item/commandExecution/requestApproval",
    "item/completed",
  ]);
  assert.equal(sent.some((message) => message.id === 9), false);
});

test("returns resume miss when retained relay history has a sequence gap", () => {
  const sent = [];
  const client = {
    readyState: 1,
    send(data) {
      sent.push(JSON.parse(String(data || "{}")));
    },
  };
  const relay = {
    relayId: "relay-test",
    threadId: "thread-test",
    clients: new Set(),
    pendingApprovalRequestIds: new Set(),
    lastSeq: 7000,
    currentTurnStartSeq: 500,
    eventLog: [
      {
        seq: 1001,
        data: JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "late" } }),
      },
    ],
    turnCompleted: false,
    closed: false,
    cleanupTimer: null,
  };

  const replayed = attachClientToCodexRelay(relay, client, { replayAfterSeq: 500 });

  assert.equal(replayed, 0);
  assert.equal(relay.clients.size, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "runner_relay_resume_miss");
  assert.equal(sent[0].reason, "relay_event_history_gap");
});

test("detects relay events from a different thread", () => {
  assert.equal(isCodexRelayThreadMismatch("parent-thread", "child-thread"), true);
  assert.equal(isCodexRelayThreadMismatch("parent-thread", "parent-thread"), false);
  assert.equal(isCodexRelayThreadMismatch("parent-thread", ""), false);
  assert.equal(isCodexRelayThreadMismatch("", "child-thread"), false);
});

test("drops upstream relay events from a different thread before mutating relay state", () => {
  const sent = [];
  const subscriber = {
    readyState: 1,
    send(data) {
      sent.push(String(data || ""));
    },
  };
  const relay = {
    relayId: "relay-test",
    remote: "test",
    endpoint: "/codex-ws",
    clients: new Set([subscriber]),
    threadId: "parent-thread",
    turnStatus: "",
    turnStarted: false,
    turnCompleted: false,
    pendingApprovalRequestIds: new Set(),
    requestIdByRpcId: new Map(),
    requestMethodByRpcId: new Map(),
    lastSeq: 0,
    eventLog: [],
    closed: false,
  };
  const largeChildEvent = JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "child-thread",
      status: "completed",
      padding: "x".repeat(45000),
    },
  });

  handleCodexRelayUpstreamMessage(relay, largeChildEvent, false);

  assert.equal(relay.eventLog.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(relay.lastSeq, 0);
  assert.equal(relay.turnCompleted, false);
  assert.equal(relay.turnStatus, "");
});
