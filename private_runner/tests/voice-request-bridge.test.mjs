import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceRequestBridge } from "../src/voice-request-bridge.mjs";

const request = { method: "item/commandExecution/requestApproval", params: { command: "echo" }, threadId: "thread", turnId: "turn" };
const question = { ...request, method: "item/tool/requestUserInput", params: { questions: [{ id: "choice" }] } };

test("questions use original timestamp, validate responses and resolve only once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const sent = [];
  const resolved = [];
  const bridge = createVoiceRequestBridge({ send: (value) => { sent.push(value); return true; },
    onResolved: (value) => resolved.push(value) });
  const result = bridge.request("operation", question, "other");
  const id = sent[0].requestId;
  assert.equal(sent[0].startedAtMs, 1000);
  assert.equal(bridge.decide("operation", id, "accept"), false);
  assert.equal(bridge.respond("wrong-operation", id, { answers: {} }), false);
  assert.equal(bridge.respond("operation", id, { answers: { unknown: { answers: ["A"] } } }), false);
  assert.equal(bridge.respond("operation", id, { answers: { choice: { answers: [123] } } }), false);
  t.mock.timers.tick(59_999);
  const answer = { answers: { choice: { answers: ["A"] } } };
  assert.equal(bridge.respond("operation", id, answer), true);
  assert.deepEqual(await result, answer);
  t.mock.timers.tick(1);
  assert.equal(bridge.respond("operation", id, answer), false);
  assert.deepEqual(resolved, [{ requestId: id, operationId: "operation", orchestratorId: "other", method: question.method }]);
});

test("questions expire at 60 seconds and reject late answers even before the timer runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const sent = [];
  const resolved = [];
  const bridge = createVoiceRequestBridge({ send: (value) => { sent.push(value); return true; },
    onResolved: (value) => resolved.push(value) });
  let done = false;
  const result = bridge.request("operation", question).then((value) => { done = true; return value; });
  t.mock.timers.tick(59_999);
  await Promise.resolve();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await result, { answers: {} });
  const late = bridge.request("second", question);
  t.mock.timers.setTime(121_000);
  assert.equal(bridge.respond("second", sent[1].requestId, { answers: { choice: { answers: ["A"] } } }), false);
  assert.deepEqual(await late, { answers: {} });
  assert.equal(resolved.length, 2);
});

test("skip, disconnect, native cancellation and send failure return empty answers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const sent = [];
  const resolved = [];
  const bridge = createVoiceRequestBridge({ send: (value) => { sent.push(value); return true; },
    onResolved: (value) => resolved.push(value) });
  const skipped = bridge.request("skip", question);
  assert.equal(bridge.respond("skip", sent[0].requestId, { answers: {} }), true);
  assert.deepEqual(await skipped, { answers: {} });
  const controller = new AbortController();
  const cancelled = bridge.request("cancel", question, "main", "", controller.signal);
  controller.abort();
  assert.deepEqual(await cancelled, { answers: {} });
  const disconnected = bridge.request("close", question);
  bridge.close();
  assert.deepEqual(await disconnected, { answers: {} });
  assert.deepEqual(await bridge.request("closed", question), { answers: {} });
  t.mock.timers.tick(60_000);
  assert.equal(resolved.length, 3);
  assert.deepEqual(await createVoiceRequestBridge({ send: () => false }).request("failed", question), { answers: {} });
});

test("forwarding a question retains its native receipt time and remaining deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 31_000 });
  const sent = [];
  const bridge = createVoiceRequestBridge({ send: (value) => { sent.push(value); return true; } });
  const pending = bridge.request("operation", { ...question, startedAtMs: 1000 });
  assert.equal(sent[0].startedAtMs, 1000);
  t.mock.timers.tick(30_000);
  assert.deepEqual(await pending, { answers: {} });
  assert.deepEqual(await bridge.request("expired", { ...question, startedAtMs: 1000 }), { answers: {} });
  assert.equal(sent.length, 1);
});

for (const decision of ["accept", "acceptForSession", "decline"]) {
  test(`correlated voice approval ${decision}`, async () => {
    const sent = [];
    const bridge = createVoiceRequestBridge({ send: (value) => { sent.push(value); return true; } });
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
  const bridge = createVoiceRequestBridge({ send: (value) => { sent.push(value); return true; } });
  const cancelled = bridge.request("first", request);
  assert.equal(bridge.decide("first", sent[0].requestId, "cancel"), true);
  await assert.rejects(cancelled, /cancelled/);
  const disconnected = bridge.request("second", request);
  bridge.close();
  await assert.rejects(disconnected, /channel closed/);
  await assert.rejects(bridge.request("third", request), /channel closed/);
});

test("aborting an approval removes its pending decision", async () => {
  let sent;
  const resolved = [];
  const bridge = createVoiceRequestBridge({ send: (value) => { sent = value; return true; },
    onResolved: (value) => resolved.push(value) });
  const controller = new AbortController();
  const pending = bridge.request("operation", request, "main", "", controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(bridge.decide("operation", sent.requestId, "accept"), false);
  assert.deepEqual(resolved, [{ requestId: sent.requestId, operationId: "operation",
    orchestratorId: "main", method: request.method }]);
});

test("send failure and timeout reject without accepting stale decisions", async () => {
  const failed = createVoiceRequestBridge({ send: () => false });
  await assert.rejects(failed.request("operation", request), /channel closed/);
  let sent;
  const bridge = createVoiceRequestBridge({ send: (value) => { sent = value; return true; }, timeoutMs: 5 });
  await assert.rejects(bridge.request("operation", request), /timed out/);
  assert.equal(bridge.decide("operation", sent.requestId, "accept"), false);
});


test("background approval metadata preserves the orchestrator identity and current name", async () => {
  let sent;
  const bridge = createVoiceRequestBridge({ send: (value) => { sent = value; return true; } });
  const pending = bridge.request("scheduled-operation", request, "main", "定期調査");
  assert.equal(sent.orchestratorId, "main");
  assert.equal(sent.orchestratorName, "定期調査");
  assert.equal(bridge.decide("scheduled-operation", sent.requestId, "accept"), true);
  assert.equal(await pending, "accept");
});
