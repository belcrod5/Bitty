import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAppControlService } from "../src/app-control-service.mjs";
import { createBrowserSecretInputService, createBrowserSecretInputHttp } from "../src/browser-secret-input.mjs";
import { RUNNER_AUTHENTICATION } from "../src/runner-login-http.mjs";

const target = { cdpUrl: "ws://127.0.0.1:9222/devtools/page/TAB", selector: "#password", origin: "https://example.com", label: "Password" };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, options = {}) {
  const sent = []; const filled = []; const ws = {}; let closed = 0;
  const sendEnvelope = (socket, message) => { sent.push({ ws: socket, ...message }); return true; };
  const appControl = createAppControlService({ sendEnvelope });
  appControl.handleMessage(ws, { channel: "control", op: "app.control.register", payload: { version: 1, clientInstanceId: "phone" } });
  const connectionGeneration = sent.at(-1).payload.connectionGeneration;
  const session = { kind: "session", sessionRef: { backendId: "claude", nativeSessionId: "chat" }, cwd: "/repo" };
  const update = (generation = 1, foreground = true) => appControl.handleMessage(ws, {
    channel: "control", op: "app.control.update", payload: { connectionGeneration, foreground,
      surfaces: [{ surfaceId: "panel", generation, target: session, desired: "stopped", observed: "stopped" }] },
  });
  update();
  const control = appControl.acceptTurn(ws, { clientInstanceId: "phone", connectionGeneration, surfaceId: "panel", ownerGeneration: 1, target: session },
    { subjectId: "owner", callerOperationId: "turn", target: session });
  const context = control.instruction.match(/ctx_[a-f0-9-]+/)[0];
  const prepare = async () => ({ fill: async (value) => { filled.push(value); }, close: () => { closed++; } });
  const service = createBrowserSecretInputService({ appControl, sendEnvelope, prepare, ...options });
  t.after(() => { service.close(); appControl.close(); });
  const body = { requestId: randomUUID(), context, target };
  const respond = async (payload, socket = ws, device = true) => {
    const requestId = randomUUID();
    service.handleMessage(socket, { channel: "control", op: "browser.input.respond", requestId, payload }, device);
    for (let n = 0; n < 10; n++) {
      await tick();
      const reply = sent.find((entry) => entry.requestId === requestId);
      if (reply) return reply.payload;
    }
    return null;
  };
  return { service, body, ws, sent, filled, update, control, respond, closed: () => closed };
}

test("origin-only request goes to the same device; exact value never appears in status, events or replay", async (t) => {
  const f = fixture(t);
  const pending = await f.service.request("owner", f.body);
  assert.equal(pending.status, "pending");
  const request = f.sent.find((entry) => entry.op === "browser.input.request");
  assert.equal(request.ws, f.ws);
  assert.equal(request.payload.origin.target.sessionRef.backendId, "claude");
  assert.equal(request.payload.destinationOrigin, target.origin);
  assert.equal(request.payload.selector, undefined);
  const value = "  PRIVATE whitespace\n";
  const completed = await f.respond({ requestId: f.body.requestId, value });
  assert.equal(completed.status, "completed");
  assert.deepEqual(f.filled, [value]);
  assert.equal(JSON.stringify(f.sent).includes(value), false);
  assert.equal(JSON.stringify(await f.service.request("owner", f.body)).includes("PRIVATE"), false);
  assert.equal((await f.respond({ requestId: f.body.requestId, value })).status, "request_unavailable");
  assert.equal(f.filled.length, 1);
  assert.equal(f.closed(), 1);
});

test("another device, local agent connection and another subject cannot submit/read the request", async (t) => {
  const f = fixture(t); await f.service.request("owner", f.body);
  const payload = { requestId: f.body.requestId, value: "PRIVATE" };
  assert.equal((await f.respond(payload, {})).status, "request_unavailable");
  assert.equal((await f.respond(payload, f.ws, false)).status, "request_unavailable");
  assert.equal(f.service.getResult("other", f.body.requestId).status, "not_found");
  await assert.rejects(f.service.request("other", f.body), { code: "request_conflict" });
  assert.deepEqual(f.filled, []);
  assert.equal(f.service.getResult("owner", f.body.requestId).status, "pending");
});

test("chat owner changes, background, turn end and disconnect cancel without filling", async (t) => {
  for (const change of [(f) => f.update(2), (f) => f.update(1, false), (f) => f.control.finish(), (f) => f.service.disconnect(f.ws)]) {
    const f = fixture(t); await f.service.request("owner", f.body);
    change(f); f.service.reconcile(f.ws);
    assert.equal((await f.respond({ requestId: f.body.requestId, value: "PRIVATE" })).status, "request_unavailable");
    assert.equal(f.service.getResult("owner", f.body.requestId).status, "cancelled");
    assert.deepEqual(f.filled, []);
  }
});

test("user cancellation, expiry and a second concurrent form are bounded", async (t) => {
  const f = fixture(t, { timeoutMs: 20 });
  await f.service.request("owner", f.body);
  await assert.rejects(f.service.request("owner", { ...f.body, requestId: randomUUID() }), { code: "input_busy" });
  assert.equal((await f.respond({ requestId: f.body.requestId, cancel: true })).status, "cancelled");
  const next = { ...f.body, requestId: randomUUID() };
  await f.service.request("owner", next);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.service.getResult("owner", next.requestId).status, "expired");
  assert.deepEqual(f.filled, []);
});

test("late preparation and cancelled in-flight fills close the browser and never report success", async (t) => {
  let prepared; let closed = 0;
  const f = fixture(t, { prepare: () => new Promise((resolve) => { prepared = resolve; }) });
  const starting = f.service.request("owner", f.body);
  f.control.finish(); f.service.reconcile(f.ws);
  prepared({ fill: async () => { throw new Error("should not fill"); }, close: () => { closed++; } });
  assert.equal((await starting).status, "cancelled");
  assert.equal(closed, 1);

  let fillDone;
  const g = fixture(t, { prepare: async () => ({ fill: () => new Promise((resolve) => { fillDone = resolve; }), close() {} }) });
  await g.service.request("owner", g.body);
  g.service.handleMessage(g.ws, { channel: "control", op: "browser.input.respond", payload: { requestId: g.body.requestId, value: "PRIVATE" } }, true);
  assert.equal(g.service.getResult("owner", g.body.requestId).status, "filling");
  g.service.disconnect(g.ws); fillDone(); await tick();
  assert.equal(g.service.getResult("owner", g.body.requestId).status, "input_status_unknown");
  assert.equal(g.sent.some((m) => m.payload?.status === "completed"), false);
});

test("raw injection errors become status only; malformed values do not claim or trim a request", async (t) => {
  const f = fixture(t, { prepare: async () => ({ fill: async () => { throw new Error("PRIVATE value reflected by browser"); }, close() {} }) });
  await f.service.request("owner", f.body);
  for (const patch of [{ value: "" }, { value: 42 }, { value: "x", extra: "data" }, { value: "x", cancel: true }]) {
    assert.equal((await f.respond({ requestId: f.body.requestId, ...patch })).status, "invalid_response");
  }
  assert.equal((await f.respond({ requestId: f.body.requestId, value: "PRIVATE" })).status, "input_status_unknown");
  assert.equal(JSON.stringify(f.sent).includes("PRIVATE"), false);
});

test("HTTP creates/reads only with local authentication and never accepts a secret submit", async (t) => {
  const f = fixture(t); const replies = [];
  const handler = createBrowserSecretInputHttp({ service: f.service, readJsonBody: async () => f.body,
    json: (_res, status, payload) => replies.push({ status, payload }) });
  const req = { method: "POST" };
  assert.equal(await handler(req, {}, "/browser-input/requests"), true);
  assert.equal(replies.at(-1).status, 403);
  req[RUNNER_AUTHENTICATION] = { local: false, ownerSubjectId: "owner" };
  await handler(req, {}, "/browser-input/requests"); assert.equal(replies.at(-1).status, 403);
  req[RUNNER_AUTHENTICATION].local = true;
  await handler(req, {}, "/browser-input/requests"); assert.equal(replies.at(-1).payload.status, "pending");
  await handler(req, {}, `/browser-input/requests/${f.body.requestId}/submit`); assert.equal(replies.at(-1).status, 404);
  req.method = "GET";
  await handler(req, {}, `/browser-input/requests/${f.body.requestId}`); assert.equal(replies.at(-1).payload.status, "pending");
});
