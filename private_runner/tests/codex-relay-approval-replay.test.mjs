import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_MOCK = "1";
process.env.RUNNER_TOKEN = process.env.RUNNER_TOKEN || "test-token";

const { __TESTING__ } = await import("../src/server-runtime.mjs");
const {
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
