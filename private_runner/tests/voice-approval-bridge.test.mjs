import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceApprovalBridge } from "../src/voice-approval-bridge.mjs";

const request = { method: "item/commandExecution/requestApproval", params: { command: "echo" }, threadId: "thread", turnId: "turn" };

for (const decision of ["accept", "acceptForSession", "decline"]) {
  test(`correlated voice approval ${decision}`, async () => {
    const sent = [];
    const bridge = createVoiceApprovalBridge({ send: (value) => { sent.push(value); return true; } });
    const result = bridge.request("operation", request);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, request.method);
    assert.equal(bridge.decide("wrong-operation", sent[0].requestId, decision), false);
    assert.equal(bridge.decide("operation", "wrong-request", decision), false);
    assert.equal(bridge.decide("operation", sent[0].requestId, decision), true);
    assert.equal(await result, decision);
    assert.equal(bridge.decide("operation", sent[0].requestId, decision), false);
  });
}

test("cancel and connection close reject outstanding approvals", async () => {
  const sent = [];
  const bridge = createVoiceApprovalBridge({ send: (value) => { sent.push(value); return true; } });
  const cancelled = bridge.request("first", request);
  assert.equal(bridge.decide("first", sent[0].requestId, "cancel"), true);
  await assert.rejects(cancelled, /cancelled/);
  const disconnected = bridge.request("second", request);
  bridge.close();
  await assert.rejects(disconnected, /channel closed/);
  await assert.rejects(bridge.request("third", request), /channel closed/);
});

test("send failure and timeout reject without accepting stale decisions", async () => {
  const failed = createVoiceApprovalBridge({ send: () => false });
  await assert.rejects(failed.request("operation", request), /channel closed/);
  let sent;
  const bridge = createVoiceApprovalBridge({ send: (value) => { sent = value; return true; }, timeoutMs: 5 });
  await assert.rejects(bridge.request("operation", request), /timed out/);
  assert.equal(bridge.decide("operation", sent.requestId, "accept"), false);
});
