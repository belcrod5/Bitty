import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceRequestBridge } from "../src/voice-request-bridge.mjs";

const request = { method: "item/commandExecution/requestApproval", params: { command: "echo" }, threadId: "thread", turnId: "turn" };
const question = { ...request, method: "item/tool/requestUserInput", params: { questions: [{ id: "choice" }] } };
const calendar = { ...request, method: "item/tool/call", params: { namespace: "calendar",
  tool: "calendar_search_events", callId: "calendar-call", threadId: "thread", turnId: "turn",
  arguments: { start: "2026-10-20T00:00:00+09:00", end: "2026-10-21T00:00:00+09:00" } } };
const calendarResult = { ok: true, data: { events: [], truncated: false } };
const readCalendarResult = (response) => {
  assert.equal(response.success, true);
  assert.equal(response.contentItems.length, 1);
  assert.equal(response.contentItems[0].type, "inputText");
  return JSON.parse(response.contentItems[0].text);
};

test("calendar results are validated, correlated and wrapped as dynamic tool responses", async () => {
  const sent = [];
  const resolved = [];
  const bridge = createVoiceRequestBridge({ send: (value) => { sent.push(value); return true; },
    onResolved: (value) => resolved.push(value) });
  const pending = bridge.request("operation", calendar, "other");
  const id = sent[0].requestId;
  assert.equal(sent[0].method, "item/tool/call");
  assert.deepEqual(sent[0].params, calendar.params);
  assert.equal(bridge.decide("operation", id, "accept"), false);
  assert.equal(bridge.respond("wrong-operation", id, calendarResult), false);
  assert.equal(bridge.respond("operation", "wrong-request", calendarResult), false);
  for (const invalid of [null, [], {}, { ok: true }, { answers: {} },
    { success: true, contentItems: [] }, { ok: false, error: {} },
    { ok: false, error: { code: "device_unavailable", message: "error", retryable: "false" } }]) {
    assert.equal(bridge.respond("operation", id, invalid), false);
  }
  assert.equal(bridge.respond("operation", id, calendarResult), true);
  assert.deepEqual(readCalendarResult(await pending), calendarResult);
  assert.equal(bridge.respond("operation", id, calendarResult), false);
  assert.deepEqual(resolved, [{ requestId: id, operationId: "operation", orchestratorId: "other", method: calendar.method }]);
  const failed = bridge.request("failed", calendar);
  const failure = { ok: false, error: { code: "calendar_permission_denied", message: "denied", retryable: false } };
  assert.equal(bridge.respond("failed", sent[1].requestId, failure), true);
  assert.deepEqual(readCalendarResult(await failed), failure);
});

test("calendar requests permit only the three read tools in the calendar namespace", async () => {
  const sent = [];
  const bridge = createVoiceRequestBridge({ send: (value) => { sent.push(value); return true; } });
  for (const tool of ["calendar_list_calendars", "calendar_search_events", "calendar_get_event"]) {
    const pending = bridge.request(tool, { ...calendar, params: { ...calendar.params, tool } });
    assert.equal(bridge.respond(tool, sent.at(-1).requestId, calendarResult), true);
    assert.deepEqual(readCalendarResult(await pending), calendarResult);
  }
  for (const params of [
    ...["calendar_create_event", "calendar_update_event", "calendar_delete_event", "unknown"].map((tool) => ({ ...calendar.params, tool })),
    { ...calendar.params, namespace: "other" },
  ]) {
    assert.equal(readCalendarResult(await bridge.request("invalid", { ...calendar, params })).error.code, "invalid_arguments");
  }
  assert.equal(sent.length, 3);
});

test("calendar timeout is 30 seconds and late responses are rejected before the timer runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const sent = [];
  const resolved = [];
  const bridge = createVoiceRequestBridge({ send: (value) => { sent.push(value); return true; },
    onResolved: (value) => resolved.push(value), timeoutMs: 5 });
  let done = false;
  const pending = bridge.request("operation", calendar).then((value) => { done = true; return value; });
  assert.equal(sent[0].startedAtMs, 1000);
  t.mock.timers.tick(29_999);
  await Promise.resolve();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  assert.equal(readCalendarResult(await pending).error.code, "device_unavailable");
  assert.equal(bridge.respond("operation", sent[0].requestId, calendarResult), false);
  const late = bridge.request("late", calendar);
  t.mock.timers.setTime(61_000);
  assert.equal(bridge.respond("late", sent[1].requestId, calendarResult), false);
  assert.equal(readCalendarResult(await late).error.code, "device_unavailable");
  assert.equal(resolved.length, 2);
});

test("calendar forwarding retains its original receipt time and remaining deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 21_000 });
  const sent = [];
  const bridge = createVoiceRequestBridge({ send: (value) => { sent.push(value); return true; } });
  const pending = bridge.request("operation", { ...calendar, startedAtMs: 1000 });
  assert.equal(sent[0].startedAtMs, 1000);
  t.mock.timers.tick(10_000);
  assert.equal(readCalendarResult(await pending).error.code, "device_unavailable");
  assert.equal(readCalendarResult(await bridge.request("expired", { ...calendar, startedAtMs: 1000 })).error.code, "device_unavailable");
  assert.equal(sent.length, 1);
});

test("calendar cancellation, disconnect and send failure resolve with calendar errors", async () => {
  const sent = [];
  const resolved = [];
  const bridge = createVoiceRequestBridge({ send: (value) => { sent.push(value); return true; },
    onResolved: (value) => resolved.push(value) });
  const controller = new AbortController();
  const cancelled = bridge.request("cancelled", calendar, "main", "", controller.signal);
  controller.abort();
  assert.equal(readCalendarResult(await cancelled).error.code, "request_cancelled");
  assert.equal(bridge.respond("cancelled", sent[0].requestId, calendarResult), false);
  assert.equal(readCalendarResult(await bridge.request("aborted", calendar, "main", "", controller.signal)).error.code, "request_cancelled");
  const disconnected = bridge.request("disconnected", calendar);
  bridge.close();
  assert.equal(readCalendarResult(await disconnected).error.code, "device_unavailable");
  assert.equal(bridge.respond("disconnected", sent[1].requestId, calendarResult), false);
  assert.equal(readCalendarResult(await bridge.request("closed", calendar)).error.code, "device_unavailable");
  assert.equal(resolved.length, 2);
  for (const send of [() => false, () => { throw new Error("send failed"); }]) {
    const failed = createVoiceRequestBridge({ send });
    assert.equal(readCalendarResult(await failed.request("failed", calendar)).error.code, "device_unavailable");
  }
});

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
