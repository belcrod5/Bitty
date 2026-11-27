import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAppControlService } from "../src/app-control-service.mjs";
import { createBrowserControlService, createBrowserControlHttp } from "../src/browser-control.mjs";
import { RUNNER_AUTHENTICATION } from "../src/runner-login-http.mjs";
const target = { cdpUrl: "ws://127.0.0.1:9222/devtools/page/TAB", origin: "https://example.com", label: "Login" };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, options = {}) {
  const { initialSessionId = "chat", backendId = "claude", ...serviceOptions } = options;
  const sent = [], inputs = []; const ws = { bufferedAmount: 0 }; let closed = 0, started = 0, paused = 0, callbacks;
  const sendEnvelope = (socket, message) => { sent.push({ ws: socket, ...message }); return true; };
  const appControl = createAppControlService({ sendEnvelope });
  appControl.handleMessage(ws, { channel: "control", op: "app.control.register", payload: { version: 1, clientInstanceId: "phone" } });
  const connectionGeneration = sent.at(-1).payload.connectionGeneration;
  const session = { kind: "session", sessionRef: { backendId, nativeSessionId: initialSessionId }, cwd: "/repo" };
  const snapshot = ({ surfaceId = "panel", chatTarget = session } = {}) => appControl.handleMessage(ws, {
    channel: "control", op: "app.control.update", payload: { connectionGeneration, foreground: true,
      surfaces: surfaceId ? [{ surfaceId, generation: 1, target: session, desired: "stopped", observed: "stopped" }] : [],
      chats: [{ chatId: "conversation", generation: 1, target: chatTarget }],
  } });
  snapshot();
  const origin = { clientInstanceId: "phone", connectionGeneration, surfaceId: "panel", ownerGeneration: 1, target: session, chatId: "conversation", chatGeneration: 1 };
  const control = appControl.acceptTurn(ws, origin, { subjectId: "owner", callerOperationId: "turn", target: session });
  const context = control.instruction.match(/ctx_[a-f0-9-]+/)[0];
  const prepare = async (_target, cb) => { callbacks = cb; return { start: async () => { started++; }, pause: async () => { paused++; }, ack: async () => {}, input: async (value) => { inputs.push(value); }, close: () => { closed++; } }; };
  const service = createBrowserControlService({ appControl, sendEnvelope, prepare, ...serviceOptions });
  t.after(() => { service.close(); appControl.close(); });
  const body = { requestId: randomUUID(), context, target };
  const command = async (action, extra = {}, socket = ws, device = true) => {
    const requestId = randomUUID();
    service.handleMessage(socket, { channel: "control", op: "browser.control.command", requestId, payload: { requestId: body.requestId, action, ...extra } }, device);
    for (let n = 0; n < 20; n++) { await tick(); const reply = sent.find((entry) => entry.requestId === requestId); if (reply) return reply.payload; }
    return null;
  };
  return { service, appControl, body, ws, sent, inputs, snapshot, origin, session, control, command, callbacks: () => callbacks, counts: () => ({ closed, started, paused }) };
}

test("chat/device binding survives microphone teardown, chat switches and completed AI turns", async (t) => {
  const f = fixture(t); f.snapshot({ surfaceId: "" });
  assert.equal((await f.service.request("owner", f.body)).status, "pending");
  f.control.finish(); f.snapshot({ chatTarget: { ...f.session, cwd: "/other" } });
  assert.deepEqual(f.counts(), { closed: 0, started: 0, paused: 0 });
  assert.equal((await f.command("start")).status, "active");
  assert.equal((await f.command("pause")).status, "pending");
  assert.equal((await f.command("start")).status, "active");
  assert.equal((await f.command("finish")).status, "completed");
  assert.deepEqual(f.counts(), { closed: 1, started: 2, paused: 1 });
});

test("unresolved/finished/foreign/disconnected contexts cannot create a card", async (t) => {
  const f = fixture(t); f.control.finish(); await assert.rejects(f.service.request("owner", f.body), { code: "context_expired" });
  const g = fixture(t, { initialSessionId: null }); await assert.rejects(g.service.request("owner", g.body), { code: "session_unresolved" });
  await assert.rejects(g.service.request("other", g.body), { code: "context_expired" });
  g.appControl.disconnect(g.ws); await assert.rejects(g.service.request("owner", g.body), { code: "client_offline" });
});

test("cards for first sessions bind to their resolved original session", async (t) => {
  for (const backendId of ["codex", "claude"]) {
    const f = fixture(t, { initialSessionId: null, backendId });
    f.control.bindResolvedSession({ backendId, nativeSessionId: "resolved" }, "/repo");
    assert.equal((await f.service.request("owner", f.body)).status, "pending");
    assert.equal(f.sent.find((m) => m.op === "browser.control.request").payload.target.sessionRef.nativeSessionId, "resolved");
  }
});

test("page reservation prevents competing cards, while status/replay expose only fixed metadata", async (t) => {
  const f = fixture(t); await f.service.request("owner", f.body);
  await assert.rejects(f.service.request("owner", { ...f.body, requestId: randomUUID() }), { code: "capacity_exceeded" });
  assert.deepEqual(await f.service.request("owner", f.body), { requestId: f.body.requestId, status: "pending" });
  assert.equal(f.service.getResult("other", f.body.requestId).status, "not_found");
  assert.equal((await f.command("start", {}, {}, true)).status, "request_unavailable");
  assert.equal((await f.command("start", {}, f.ws, false)).status, "request_unavailable");
  await f.command("cancel");
  assert.equal((await f.service.request("owner", { ...f.body, requestId: randomUUID() })).status, "pending");
});

test("images/text are device-only and command/status replies cannot echo private browser content", async (t) => {
  const f = fixture(t); await f.service.request("owner", f.body); await f.command("start");
  f.callbacks().onFrame({ frameId: 1, data: "PRIVATE_FRAME", width: 100, height: 200 });
  f.callbacks().onOrigin("https://login.example"); f.callbacks().onNavigation();
  assert.equal((await f.command("input", { sequence: 1, frameId: 1, input: { type: "text", text: "PRIVATE_TEXT" } })).status, "active");
  assert.deepEqual(f.inputs, [{ type: "text", text: "PRIVATE_TEXT" }]);
  const frames = f.sent.filter((m) => m.op === "browser.control.frame"); assert.equal(frames.length, 1); assert.equal(frames[0].ws, f.ws);
  const publicReplies = f.sent.filter((m) => !["browser.control.frame", "browser.control.origin"].includes(m.op));
  assert.equal(JSON.stringify(publicReplies).includes("PRIVATE"), false);
  assert.deepEqual(f.service.getResult("owner", f.body.requestId), { requestId: f.body.requestId, status: "active" });
  assert.equal((await f.command("input", { sequence: 1, frameId: 1, input: { type: "text", text: "replay" } })).status, "invalid_command");
  await f.command("finish"); assert.equal((await f.command("start")).status, "request_unavailable");
});

test("invalid input is rejected before execution and backend errors become fixed terminal status", async (t) => {
  const f = fixture(t, { prepare: async () => ({ start: async () => {}, input: async () => { throw new Error("PRIVATE_ERROR"); }, close() {} }) });
  await f.service.request("owner", f.body); await f.command("start");
  for (const input of [{ type: "text", text: "" }, { type: "key", key: "F12" }, { type: "down", x: 2, y: 0 }, { type: "text", text: "x", extra: true }]) {
    assert.equal((await f.command("input", { sequence: 1, frameId: 1, input })).status, "invalid_command");
  }
  assert.equal((await f.command("input", { sequence: 1, frameId: 1, input: { type: "text", text: "PRIVATE" } })).status, "control_status_unknown");
  assert.equal(JSON.stringify(f.sent).includes("PRIVATE"), false);
});

test("a provably stale command is not applied and does not terminate manual control", async (t) => {
  const f = fixture(t, { prepare: async () => ({ start: async () => {}, input: async () => { throw Object.assign(new Error("fixed"), { code: "stale_frame" }); }, close() {} }) });
  await f.service.request("owner", f.body); await f.command("start");
  assert.deepEqual(await f.command("input", { sequence: 1, frameId: 1, input: { type: "text", text: "PRIVATE_STALE" } }), { requestId: f.body.requestId, status: "active", inputStatus: "not_applied" });
  assert.deepEqual(f.service.getResult("owner", f.body.requestId), { requestId: f.body.requestId, status: "active" });
  assert.equal(JSON.stringify(f.sent).includes("PRIVATE"), false);
});
test("disconnect, invalidation and backpressure close bindings and do not resume automatically", async (t) => {
  const f = fixture(t); await f.service.request("owner", f.body); await f.command("start");
  f.ws.bufferedAmount = 2 * 1024 * 1024 + 1; f.callbacks().onFrame({ frameId: 1, data: "IMAGE", width: 10, height: 10 });
  assert.equal(f.service.getResult("owner", f.body.requestId).status, "expired");
  assert.equal(f.sent.some((m) => m.op === "browser.control.frame"), false);
  const g = fixture(t); await g.service.request("owner", g.body); await g.command("start"); g.service.disconnect(g.ws);
  assert.equal(g.service.getResult("owner", g.body.requestId).status, "control_status_unknown");
  const h = fixture(t); await h.service.request("owner", h.body); h.callbacks().onInvalidated();
  assert.equal(h.service.getResult("owner", h.body.requestId).status, "invalidated");
});

test("cancel/pause interrupt a queued input and late start cannot revive control", async (t) => {
  let resolveStart, callback; const calls = [];
  const f = fixture(t, { prepare: async (_target, cb) => { callback = cb; return { start: () => new Promise((r) => { resolveStart = r; }), pause: async () => { calls.push("pause"); }, input: async () => calls.push("input"), close: () => calls.push("close") }; } });
  await f.service.request("owner", f.body); const starting = f.command("start"); await tick();
  assert.equal((await f.command("pause")).status, "pending"); resolveStart(); await starting;
  assert.equal(f.service.getResult("owner", f.body.requestId).status, "pending");
  assert.deepEqual(calls, ["pause"]);
  assert.equal((await f.command("cancel")).status, "cancelled"); callback.onFrame({ frameId: 1, data: "late", width: 10, height: 10 });
  assert.equal(f.sent.some((m) => m.op === "browser.control.frame"), false);
});

test("HTTP accepts local request/status only, never user action or frame retrieval", async (t) => {
  const f = fixture(t), replies = [];
  const handler = createBrowserControlHttp({ service: f.service, readJsonBody: async () => f.body, json: (_res, status, payload) => replies.push({ status, payload }) });
  const req = { method: "POST" }; await handler(req, {}, "/browser-control/requests"); assert.equal(replies.at(-1).status, 403);
  req[RUNNER_AUTHENTICATION] = { local: true, ownerSubjectId: "owner" }; await handler(req, {}, "/browser-control/requests"); assert.equal(replies.at(-1).payload.status, "pending");
  for (const suffix of ["input", "frame", "start"]) { await handler(req, {}, `/browser-control/requests/${f.body.requestId}/${suffix}`); assert.equal(replies.at(-1).status, 404); }
});
test("diagnostics distinguish absent frames and rendered ACKs without images, values or raw errors", async (t) => {
  const logs = []; const f = fixture(t, { log: (event) => logs.push(event) });
  await f.service.request("owner", f.body); await f.command("start");
  f.callbacks().onDiagnostic("stream_started"); f.callbacks().onDiagnostic("PRIVATE_UNEXPECTED_PHASE");
  f.callbacks().onFrame({ frameId: 1, data: "PRIVATE_FRAME", width: 800, height: 600 });
  f.callbacks().onFrame({ frameId: 2, data: "PRIVATE_FRAME", width: 800, height: 600 });
  await f.command("ack", { frameId: 1 }); await f.command("ack", { frameId: 2 });
  await f.command("input", { sequence: 1, frameId: 1, input: { type: "text", text: "PRIVATE_TEXT" } });
  f.callbacks().onInvalidated("PRIVATE_RAW_ERROR");
  assert.deepEqual(logs.map((event) => event.phase), ["prepared", "start", "stream_started", "frame_sent", "render_ack_received", "control_status_unknown"]);
  assert.equal(JSON.stringify(logs).includes("PRIVATE"), false);
  assert.deepEqual(Object.keys(logs.at(-1)).sort(), ["elapsedMs", "phase", "reason", "requestId"]);
  const g = fixture(t); await g.service.request("owner", g.body); await g.command("start"); g.callbacks().onInvalidated("frame_timeout");
  assert.equal(g.service.getResult("owner", g.body.requestId).status, "failed");
  const h = fixture(t); await h.service.request("owner", h.body); await h.command("start");
  await h.command("input", { sequence: 1, frameId: 1, input: { type: "key", key: "Enter" } });
  h.callbacks().onInvalidated("frame_timeout");
  assert.equal(h.service.getResult("owner", h.body.requestId).status, "control_status_unknown");
});
