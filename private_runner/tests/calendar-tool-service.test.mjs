import assert from "node:assert/strict";
import test from "node:test";

import {
  createCalendarScheduleRequestHandler,
  createCalendarToolService,
  calendarScheduleRequestId,
  calendarScheduleDynamicTools,
} from "../src/calendar-tool-service.mjs";

test("only exposes a pending calendar read to its selected device and accepts one matching result", async () => {
  const pushes = [];
  let resolved = null;
  const service = createCalendarToolService({
    sendPush: (deviceId, marker) => pushes.push({ deviceId, marker }),
  });
  const request = service.createReadRequest({
    ruleId: "rule-1", ruleRevision: "rule-a", deviceId: "device-a",
    tool: "calendar_search_events", arguments: { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" },
    resolve: (result) => { resolved = result; },
  });
  assert.ok(request.requestId);
  assert.equal(service.getRequests("device-b").length, 0);
  const [pending] = service.getRequests("device-a");
  assert.equal(pending.requestId, request.requestId);
  assert.equal(Object.hasOwn(pending, "deviceId"), false);
  assert.equal(service.acceptResult({
    requestId: request.requestId, deviceId: "device-b", requestHash: pending.requestHash,
    result: { ok: true, data: { events: [], truncated: false } },
  }).status, 409);
  assert.equal(service.acceptResult({
    requestId: request.requestId, deviceId: "device-a", requestHash: pending.requestHash,
    result: { ok: true, data: { events: [], truncated: false } },
  }).status, 200);
  assert.deepEqual(resolved, { ok: true, data: { events: [], truncated: false } });
  assert.equal(service.getRequests("device-a").length, 0);
  await Promise.resolve();
  assert.deepEqual(pushes, [{ deviceId: "device-a", marker: { type: "calendar_request_available" } }]);
});

test("expires requests and does not retain calendar arguments after expiry", () => {
  let at = Date.parse("2026-01-01T00:00:00Z");
  let result = null;
  const service = createCalendarToolService({ now: () => at });
  const request = service.createReadRequest({
    ruleId: "rule-1", ruleRevision: "rule-a", deviceId: "device-a",
    tool: "calendar_list_calendars", arguments: {}, resolve: (value) => { result = value; },
  });
  at += 60_001;
  assert.equal(service.getRequests("device-a").length, 0);
  assert.equal(result?.ok, false);
  assert.equal(result?.error?.code, "request_expired");
  assert.equal(service.acceptResult({
    requestId: request.requestId, deviceId: "device-a", requestHash: "x",
    result: { ok: true, data: {} },
  }).status, 404);
});

test("expires a request on its own when the device never polls", () => {
  let timeout = null;
  let result = null;
  const service = createCalendarToolService({
    scheduleTimer: (fn, delay) => {
      timeout = { fn, delay };
      return 1;
    },
    clearTimer: () => {},
  });
  service.createReadRequest({
    ruleId: "rule-1", ruleRevision: "rule-a", deviceId: "device-a",
    tool: "calendar_list_calendars", arguments: {}, resolve: (value) => { result = value; },
  });
  assert.equal(timeout.delay, 60_000);
  timeout.fn();
  assert.equal(result?.error?.code, "request_expired");
  assert.equal(service.getRequests("device-a").length, 0);
});

test("does not replace a pending request when a deterministic request id is reused", () => {
  const service = createCalendarToolService({ sendPush: async () => true });
  const first = service.createReadRequest({
    requestId: "same-request", ruleId: "rule", ruleRevision: "revision", deviceId: "device",
    tool: "calendar_list_calendars", arguments: {}, resolve: () => {},
  });
  const second = service.createReadRequest({
    requestId: "same-request", ruleId: "rule", ruleRevision: "revision", deviceId: "device",
    tool: "calendar_search_events", arguments: { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" }, resolve: () => {},
  });
  assert.equal(first.requestId, "same-request");
  assert.equal(second.error.error.code, "request_conflict");
  assert.equal(service.getRequests("device").length, 1);
});

test("uses the same UTF-8 length-prefixed request id for schedule delivery and cancellation", () => {
  const requestId = calendarScheduleRequestId(["thread-1", "turn-1", "call-1", "calendar_list_calendars"]);
  assert.equal(requestId.length, 64);
  assert.equal(requestId, calendarScheduleRequestId(["thread-1", "turn-1", "call-1", "calendar_list_calendars"]));
  assert.notEqual(requestId, calendarScheduleRequestId(["thread-1", "turn-1", "call-1", "calendar_get_event"]));
});

test("schedule handler preserves typed app-server ids and only accepts three read tools", async () => {
  let created = null;
  const handler = createCalendarScheduleRequestHandler({
    createReadRequest: (request) => {
      created = request;
      request.resolve({ ok: true, data: { calendars: [] } });
      return { requestId: request.requestId };
    },
  });
  const payload = {
    id: "42",
    method: "item/tool/call",
    ruleId: "rule-1",
    ruleRevision: "revision-1",
    deviceId: "device-1",
    params: {
      callId: "call-1", threadId: "thread-1", turnId: "turn-1", namespace: "calendar",
      tool: "calendar_list_calendars", arguments: {},
    },
  };
  const response = await handler(payload);
  assert.equal(typeof payload.id, "string");
  assert.equal(created.ruleId, "rule-1");
  assert.equal(created.requestId.length, 64);
  assert.deepEqual(JSON.parse(response.contentItems[0].text), { ok: true, data: { calendars: [] } });
  assert.deepEqual(calendarScheduleDynamicTools()[0].tools.map((tool) => tool.name), [
    "calendar_list_calendars", "calendar_search_events", "calendar_get_event",
  ]);
  assert.equal(calendarScheduleDynamicTools()[0].tools.every((tool) => tool.deferLoading === true), true);
});

test("schedule handler reports incompatible Dynamic Tools phases without accepting writes", async () => {
  const handler = createCalendarScheduleRequestHandler({
    createReadRequest: () => assert.fail("write tool must not create a calendar request"),
  });
  const response = await handler({
    id: 42,
    method: "item/tool/call",
    params: {
      callId: "call", threadId: "thread", turnId: "turn", namespace: "calendar",
      tool: "calendar_create_event", arguments: {},
    },
  });
  const result = JSON.parse(response.contentItems[0].text);
  assert.equal(result.error.code, "codex_dynamic_tools_incompatible");
  assert.equal(result.error.phase, "tool_call_parse");
});

test("schedule handler reports an incompatible tool response instead of serializing unsafe data", async () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const handler = createCalendarScheduleRequestHandler({
    createReadRequest: (request) => {
      request.resolve({ ok: true, data: cyclic });
      return { requestId: request.requestId };
    },
  });
  const response = await handler({
    id: 42,
    method: "item/tool/call",
    ruleId: "rule", ruleRevision: "revision", deviceId: "device",
    params: { callId: "call", threadId: "thread", turnId: "turn", namespace: "calendar", tool: "calendar_list_calendars", arguments: {} },
  });
  const result = JSON.parse(response.contentItems[0].text);
  assert.equal(result.error.code, "codex_dynamic_tools_incompatible");
  assert.equal(result.error.phase, "tool_response");
});
