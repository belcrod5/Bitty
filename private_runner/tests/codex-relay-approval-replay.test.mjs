import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_MOCK = "1";
process.env.RUNNER_TOKEN = process.env.RUNNER_TOKEN || "test-token";

const { __TESTING__ } = await import("../src/server-runtime.mjs");
const { shouldReplayCodexRelayEvent } = __TESTING__;

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
