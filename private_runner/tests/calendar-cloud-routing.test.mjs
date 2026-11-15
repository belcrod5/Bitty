import assert from "node:assert/strict";
import test from "node:test";
import { createCalendarRelayService } from "../src/calendar-relay-service.mjs";
import { createCalendarToolDispatcher } from "../src/calendar-tool-service.mjs";

const tool = (name = "calendar_list_calendars") => ({ id: "cloud-call", method: "item/tool/call", params: { namespace: "calendar", tool: name, arguments: {}, threadId: "thread", turnId: "turn" } });
const result = { success: true, contentItems: [{ type: "inputText", text: '{"ok":true,"data":{"calendars":[]}}' }] };
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, dispatchTool) {
  const sent = [], devices = [], owner = { ws: {}, threadId: "thread", turnId: "turn" };
  const relay = { threadId: "thread", currentTurnId: "turn", upstreamOpen: true, upstreamWs: { readyState: 1, send: (value) => sent.push(JSON.parse(value)) }, clients: new Set([owner.ws]), calendarOwner: owner, calendarRequests: new Map() };
  const service = createCalendarRelayService({ WebSocket: { OPEN: 1 }, dispatchTool,
    sendRpcToClient: (...args) => devices.push(args), sendRelayControl() {}, sendRunnerWsEnvelope() {}, isEnvelopeClient: () => true });
  t.after(() => service.cleanupRelayState(relay));
  return { sent, devices, owner, relay, service, send: (request = tool()) => service.handleUpstreamToolCall(relay, request, JSON.stringify(request)) };
}

test("cloud relay reads have no iPhone owner dependency and queued responses await the cloud result", async (t) => {
  const f = fixture(t, async () => result);
  f.relay.calendarOwner = null; f.relay.clients.clear();
  assert.equal(f.send(), true);
  assert.equal(f.relay.calendarRequests.size, 1);
  await flush();
  assert.deepEqual(f.sent, [{ id: "cloud-call", result }]);
  assert.deepEqual(f.devices, []);
  assert.deepEqual(await f.service.runnerInitiatedResponse(tool()), result);
});

test("closing iPhone during a cloud read does not abort or redirect it", async (t) => {
  let resolve, signal;
  const f = fixture(t, (_request, requestSignal) => { signal = requestSignal; return new Promise((done) => { resolve = done; }); });
  f.send(); await flush();
  f.service.terminateOwnerRequests(f.relay, f.owner.ws);
  f.relay.clients.delete(f.owner.ws);
  assert.equal(signal.aborted, false);
  assert.equal(f.relay.calendarRequests.size, 1);
  resolve(result); await flush();
  assert.deepEqual(f.sent, [{ id: "cloud-call", result }]);
  assert.deepEqual(f.devices, []);
});

for (const reason of ["interrupt", "timeout", "cleanup"]) {
  test(`cloud ${reason} aborts once and suppresses late results and forged device replies`, async (t) => {
    let resolve, signal;
    const f = fixture(t, (_request, requestSignal) => { signal = requestSignal; return new Promise((done) => { resolve = done; }); });
    f.send(); await flush();
    f.service.handleClientResponse(f.relay, { id: "cloud-call", result }, "forged", false, { ws: f.owner.ws });
    assert.deepEqual(f.sent, []);
    if (reason === "cleanup") f.service.cleanupRelayState(f.relay);
    else f.service.terminate(f.relay, f.relay.calendarRequests.get("s:cloud-call"), reason);
    assert.equal(signal.aborted, true);
    assert.equal(f.sent.length, reason === "cleanup" ? 0 : 1);
    resolve(result); await flush();
    assert.equal(f.sent.length, reason === "cleanup" ? 0 : 1);
    assert.deepEqual(f.devices, []);
  });
}

test("cloud-disabled local writes without a device need foreground; cloud-enabled writes never reach EventKit", async (t) => {
  const local = fixture(t, async () => null);
  local.relay.calendarOwner = null; local.relay.clients.clear();
  local.send(tool("calendar_create_event")); await flush();
  assert.equal(JSON.parse(local.sent[0].result.contentItems[0].text).error.code, "foreground_required");
  const dispatch = createCalendarToolDispatcher({ cloudService: { status: async () => ({ enabled: true }), execute: async () => { throw Object.assign(new Error(), { code: "icloud_read_only" }); } } });
  const cloud = fixture(t, dispatch);
  cloud.send(tool("calendar_create_event")); await flush();
  assert.equal(JSON.parse(cloud.sent[0].result.contentItems[0].text).error.code, "icloud_read_only");
  assert.deepEqual(cloud.devices, []);
});


test("raw missing, foreign or stale identity never queries cloud", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return result; });
  for (const params of [{ threadId: "" }, { turnId: "" }, { threadId: "foreign" }, { turnId: "old" }]) {
    const request = tool(); Object.assign(request.params, params);
    f.send(request);
  }
  await flush();
  assert.equal(calls, 0);
  assert.equal(f.sent.length, 4);
  assert.ok(f.sent.every((value) => JSON.parse(value.result.contentItems[0].text).error.code === "invalid_arguments"));
});

test("raw cloud access requires known relay identity or an explicitly pending turn", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return result; });
  f.relay.calendarOwner = null; f.relay.threadId = "";
  f.send(); await flush();
  assert.equal(calls, 0);
  f.relay.threadId = "thread"; f.relay.currentTurnId = "";
  f.send(); await flush();
  assert.equal(calls, 0);
  f.relay.turnStarted = true; f.relay.turnCompleted = false;
  f.send(); await flush();
  assert.equal(calls, 1);
});
