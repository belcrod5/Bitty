import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAppControlService } from "../src/app-control-service.mjs";
import { createBrowserSecretInputService, createBrowserSecretInputHttp } from "../src/browser-secret-input.mjs";
import { RUNNER_AUTHENTICATION } from "../src/runner-login-http.mjs";

const target = { cdpUrl: "ws://127.0.0.1:9222/devtools/page/TAB", selector: "#password", origin: "https://example.com", label: "Password" };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, options = {}) {
  const { initialSessionId = "chat", backendId = "claude", ...serviceOptions } = options;
  const sent = []; const filled = []; const ws = {}; let closed = 0;
  const sendEnvelope = (socket, message) => { sent.push({ ws: socket, ...message }); return true; };
  const appControl = createAppControlService({ sendEnvelope });
  appControl.handleMessage(ws, { channel: "control", op: "app.control.register", payload: { version: 1, clientInstanceId: "phone" } });
  const connectionGeneration = sent.at(-1).payload.connectionGeneration;
  const session = { kind: "session", sessionRef: { backendId, nativeSessionId: initialSessionId }, cwd: "/repo" };
  const snapshot = ({ generation = 1, foreground = true, surfaceId = "panel", chatTarget = session, withChat = true } = {}) => appControl.handleMessage(ws, {
    channel: "control", op: "app.control.update", payload: { connectionGeneration, foreground,
      surfaces: surfaceId ? [{ surfaceId, generation, target: session, desired: "stopped", observed: "stopped" }] : [],
      chats: withChat ? [{ chatId: "conversation", generation, target: chatTarget }] : [],
  } });
  const update = (generation = 1, foreground = true) => snapshot({ generation, foreground });
  update();
  const origin = { clientInstanceId: "phone", connectionGeneration, surfaceId: "panel", ownerGeneration: 1, target: session, chatId: "conversation", chatGeneration: 1 };
  const control = appControl.acceptTurn(ws, origin,
    { subjectId: "owner", callerOperationId: "turn", target: session });
  const context = control.instruction.match(/ctx_[a-f0-9-]+/)[0];
  const prepare = async () => ({ fill: async (value) => { filled.push(value); }, close: () => { closed++; } });
  const service = createBrowserSecretInputService({ appControl, sendEnvelope, prepare, ...serviceOptions });
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
  return { service, appControl, body, ws, sent, filled, update, snapshot, origin, session, control, respond, closed: () => closed };
}

test("typed chat survives microphone teardown/remount while old voice commands stay invalid", async (t) => {
  const f = fixture(t);
  f.snapshot({ surfaceId: "" });
  assert.equal(f.appControl.getContext("owner", f.body.context).status, "owner_changed");
  // The stable conversation exists before any replacement microphone is mounted.
  assert.equal((await f.service.request("owner", f.body)).status, "pending");
  f.snapshot({ surfaceId: "new-microphone" });
  assert.equal(f.appControl.getContext("owner", f.body.context).status, "owner_changed");
  assert.equal(f.service.getResult("owner", f.body.requestId).status, "pending");
  assert.equal((await f.respond({ requestId: f.body.requestId, value: "direct private input" })).status, "completed");
  assert.deepEqual(f.filled, ["direct private input"]);
  const context = f.appControl.getContext("owner", f.body.context);
  for (const action of ["stop", "handoff"]) {
    const voice = await f.appControl.submit("owner", { context: f.body.context, operationId: `${context.epoch}.${randomUUID()}`, action, expectedGeneration: 1,
      ...(action === "handoff" ? { target: f.session } : {}) });
    assert.equal(voice.status, "owner_changed");
  }
});

test("a new typed turn can request private input without any microphone registration", async (t) => {
  const f = fixture(t);
  f.snapshot({ surfaceId: "" });
  const control = f.appControl.acceptTurn(f.ws, { ...f.origin, surfaceId: "conversation" }, {
    subjectId: "owner", target: f.session, callerOperationId: "typed-without-microphone",
  });
  assert.ok(control);
  const context = control.instruction.match(/ctx_[a-f0-9-]+/)[0];
  assert.equal((await f.service.request("owner", { ...f.body, context })).status, "pending");
  assert.equal((await f.respond({ requestId: f.body.requestId, value: "typed private value" })).status, "completed");
  assert.deepEqual(f.filled, ["typed private value"]);
  const view = f.appControl.getContext("owner", context);
  assert.equal((await f.appControl.submit("owner", { context, operationId: `${view.epoch}.${randomUUID()}`, action: "stop", expectedGeneration: 1 })).status, "owner_changed");
});

test("cards survive chat switches, new turns, turn completion and more than two minutes", async (t) => {
  let now = Date.now();
  const f = fixture(t, { now: () => now });
  await f.service.request("owner", f.body);
  f.snapshot({ chatTarget: { ...f.session, cwd: "/another-repo" } });
  f.control.finish(); now += 20 * 60_000;
  f.snapshot();
  assert.ok(f.appControl.acceptTurn(f.ws, f.origin, { subjectId: "owner", callerOperationId: "next-user-turn", target: f.session }));
  assert.equal(f.service.getResult("owner", f.body.requestId).status, "pending");
  assert.equal((await f.respond({ requestId: f.body.requestId, value: "later input" })).status, "completed");
});

test("creation follows an active accepted turn even after switching chats and resolving a first session", async (t) => {
  for (const backendId of ["codex", "claude"]) {
    const f = fixture(t, { initialSessionId: null, backendId });
    f.snapshot({ chatTarget: { ...f.session, cwd: "/another-chat" } });
    const other = f.appControl.acceptTurn(f.ws, { ...f.origin, target: { ...f.session, cwd: "/another-chat" } }, {
      subjectId: "owner", target: { ...f.session, cwd: "/another-chat" }, callerOperationId: "other-turn",
    });
    assert.ok(other);
    const resolved = { backendId, nativeSessionId: "new-native-session" };
    f.control.bindResolvedSession(resolved, "/repo");
    assert.equal((await f.service.request("owner", f.body)).status, "pending");
    const request = f.sent.find((event) => event.op === "browser.input.request");
    assert.deepEqual(request.payload.target.sessionRef, resolved);
    f.control.finish();
    assert.equal((await f.respond({ requestId: f.body.requestId, value: "private" })).status, "completed");
  }
});

test("creation rejects finished, foreign, disconnected and unresolved turn bindings", async (t) => {
  const f = fixture(t); f.control.finish();
  await assert.rejects(f.service.request("owner", f.body), { code: "context_expired" });
  const g = fixture(t, { initialSessionId: null });
  await assert.rejects(g.service.request("owner", g.body), { code: "session_unresolved" });
  await assert.rejects(g.service.request("other", g.body), { code: "context_expired" });
  g.appControl.disconnect(g.ws);
  await assert.rejects(g.service.request("owner", g.body), { code: "client_offline" });
});

test("voice-only clients cannot create browser input without an accepted chat origin", async (t) => {
  const f = fixture(t); f.snapshot({ withChat: false });
  const { chatId, chatGeneration, ...voiceOnly } = f.origin;
  const control = f.appControl.acceptTurn(f.ws, voiceOnly, { subjectId: "owner", target: f.session, callerOperationId: "old-client" });
  const context = control.instruction.match(/ctx_[a-f0-9-]+/)[0];
  assert.equal(f.appControl.getContext("owner", context).status, "ready");
  await assert.rejects(f.service.request("owner", { ...f.body, context }), { code: "capability_unsupported" });
});

test("forged chat generation cannot borrow a valid microphone origin or supersede a real chat turn", async (t) => {
  const f = fixture(t);
  assert.equal(f.appControl.acceptTurn(f.ws, { ...f.origin, chatGeneration: 99 }, {
    subjectId: "owner", target: f.session, callerOperationId: "forged-turn",
  }), null);
  assert.equal((await f.service.request("owner", f.body)).status, "pending");
});

test("origin-only request goes to the same device; exact value never appears in status, events or replay", async (t) => {
  const f = fixture(t);
  const pending = await f.service.request("owner", f.body);
  assert.equal(pending.status, "pending");
  const request = f.sent.find((entry) => entry.op === "browser.input.request");
  assert.equal(request.ws, f.ws);
  assert.equal(request.payload.target.sessionRef.backendId, "claude");
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

test("multiple cards are independent and invalidation/disconnect safely terminate their browser bindings", async (t) => {
  const invalidators = [];
  const f = fixture(t, { prepare: async (_target, { onInvalidated }) => {
    invalidators.push(onInvalidated); return { fill: async () => {}, close() {} };
  } });
  await f.service.request("owner", f.body);
  const next = { ...f.body, requestId: randomUUID() };
  await f.service.request("owner", next);
  invalidators[0]();
  assert.equal(f.service.getResult("owner", f.body.requestId).status, "invalidated");
  assert.equal(f.service.getResult("owner", next.requestId).status, "pending");
  f.service.disconnect(f.ws);
  assert.equal(f.service.getResult("owner", next.requestId).status, "expired");
  assert.equal((await f.respond({ requestId: next.requestId, value: "must not fill" })).status, "request_unavailable");
});

test("late preparation and cancelled in-flight fills close the browser and never report success", async (t) => {
  let prepared; let closed = 0;
  const f = fixture(t, { prepare: () => new Promise((resolve) => { prepared = resolve; }) });
  const starting = f.service.request("owner", f.body);
  f.service.disconnect(f.ws);
  prepared({ fill: async () => { throw new Error("should not fill"); }, close: () => { closed++; } });
  assert.equal((await starting).status, "expired");
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
