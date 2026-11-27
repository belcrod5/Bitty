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
  const auth = { local: false, ownerSubjectId: "owner", sessionId: "authenticated-phone" };
  const controlId = randomUUID();
  const sent = [], inputs = []; const ws = { bufferedAmount: 0 }; let closed = 0, started = 0, paused = 0, prepared = 0, callbacks;
  const sendEnvelope = (socket, message) => { sent.push({ ws: socket, ...message }); return true; };
  const appControl = createAppControlService({ sendEnvelope });
  appControl.handleMessage(ws, { channel: "control", op: "app.control.register", payload: { version: 1, clientInstanceId: "phone" } }, auth);
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
  const prepare = async (_target, cb) => { prepared++; callbacks = cb; return { start: async () => { started++; }, pause: async () => { paused++; }, ack: async () => {}, input: async (value) => { inputs.push(value); }, close: () => { closed++; } }; };
  const service = createBrowserControlService({ appControl, sendEnvelope, prepare, ...serviceOptions });
  t.after(() => { service.close(); appControl.close(); });
  const body = { requestId: randomUUID(), context, target };
  const command = async (action, extra = {}, socket = ws, device = true) => {
    const requestId = randomUUID();
    service.handleMessage(socket, { channel: "control", op: "browser.control.command", requestId, payload: { requestId: body.requestId, action, ...(action !== "cancel" ? { controlId } : {}), ...extra } }, device === true ? auth : device);
    for (let n = 0; n < 20; n++) { await tick(); const reply = sent.find((entry) => entry.requestId === requestId); if (reply) return reply.payload; }
    return null;
  };
  return { service, appControl, body, ws, auth, controlId, sent, inputs, snapshot, origin, session, control, command, prepared: () => prepared, callbacks: () => callbacks, counts: () => ({ closed, started, paused }) };
}

test("chat/device binding survives microphone teardown, chat switches and completed AI turns", async (t) => {
  const f = fixture(t); f.snapshot({ surfaceId: "" });
  assert.equal((await f.service.request("owner", f.body)).status, "pending");
  f.control.finish(); f.snapshot({ chatTarget: { ...f.session, cwd: "/other" } });
  f.snapshot();
  assert.deepEqual(f.counts(), { closed: 0, started: 0, paused: 0 });
  assert.equal((await f.command("start")).status, "active");
  assert.equal((await f.command("pause")).status, "pending");
  assert.equal((await f.command("start")).status, "active");
  assert.equal((await f.command("finish")).status, "completed");
  assert.deepEqual(f.counts(), { closed: 2, started: 2, paused: 0 });
});

test("unresolved, finished and foreign contexts cannot create a card; accepted disconnected turns can", async (t) => {
  const f = fixture(t); f.control.finish(); await assert.rejects(f.service.request("owner", f.body), { code: "context_expired" });
  const g = fixture(t, { initialSessionId: null }); await assert.rejects(g.service.request("owner", g.body), { code: "session_unresolved" });
  await assert.rejects(g.service.request("other", g.body), { code: "context_expired" });
  const h = fixture(t); h.appControl.disconnect(h.ws);
  assert.equal((await h.service.request("owner", h.body)).status, "pending"); assert.equal(h.prepared(), 0);
});

test("an accepted turn can create card metadata after the original app backgrounds", async (t) => {
  const f = fixture(t);
  f.appControl.handleMessage(f.ws, { channel: "control", op: "app.control.update", payload: {
    connectionGeneration: f.origin.connectionGeneration, foreground: false, surfaces: [], chats: [],
  } }, f.auth);
  assert.equal(f.appControl.getContext("owner", f.body.context).status, "client_background");
  assert.deepEqual(await f.service.request("owner", f.body), { requestId: f.body.requestId, status: "pending" });
  assert.equal(f.prepared(), 0);
  assert.deepEqual(f.counts(), { closed: 0, started: 0, paused: 0 });
  assert.equal(f.sent.find((message) => message.op === "browser.control.request").payload.target.sessionRef.nativeSessionId, "chat");
});

test("a superseded accepted turn cannot create a browser card", async (t) => {
  const f = fixture(t);
  const next = f.appControl.acceptTurn(f.ws, f.origin, { subjectId: "owner", callerOperationId: "next-turn", target: f.session });
  assert.ok(next);
  await assert.rejects(f.service.request("owner", f.body), { code: "context_expired" });
  assert.equal(f.prepared(), 0);
  assert.equal(f.sent.some((message) => message.op === "browser.control.request"), false);
  const context = next.instruction.match(/ctx_[a-f0-9-]+/)[0];
  assert.equal((await f.service.request("owner", { ...f.body, context })).status, "pending");
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
  assert.equal((await f.command("start", {}, {}, { ...f.auth, sessionId: "another-device" })).status, "request_unavailable");
  assert.equal((await f.command("start", {}, f.ws, false)).status, "request_unavailable");
  await f.command("cancel");
  assert.equal((await f.service.request("owner", { ...f.body, requestId: randomUUID() })).status, "pending");
});

test("images/text are device-only and command/status replies cannot echo private browser content", async (t) => {
  const f = fixture(t); await f.service.request("owner", f.body); await f.command("start");
  f.callbacks().onFrame({ frameId: 1, data: "PRIVATE_FRAME", width: 100, height: 200 });
  f.callbacks().onOrigin("https://login.example"); f.callbacks().onViewInvalidated();
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
  assert.equal(f.service.getResult("owner", f.body.requestId).status, "pending");
  assert.equal(f.sent.some((m) => m.op === "browser.control.frame"), false);
  const g = fixture(t); await g.service.request("owner", g.body); await g.command("start"); g.service.disconnect(g.ws);
  assert.equal(g.service.getResult("owner", g.body.requestId).status, "pending");
  const h = fixture(t); await h.service.request("owner", h.body); await h.command("start"); h.callbacks().onInvalidated();
  assert.equal(h.service.getResult("owner", h.body.requestId).status, "pending");
});

test("cancel/pause interrupt a queued input and late start cannot revive control", async (t) => {
  let resolveStart, callback; const calls = [];
  const f = fixture(t, { prepare: async (_target, cb) => { callback = cb; return { start: () => new Promise((r) => { resolveStart = r; }), pause: async () => { calls.push("pause"); }, input: async () => calls.push("input"), close: () => calls.push("close") }; } });
  await f.service.request("owner", f.body); const starting = f.command("start"); await tick();
  assert.equal((await f.command("pause")).status, "pending"); resolveStart(); await starting;
  assert.equal(f.service.getResult("owner", f.body.requestId).status, "pending");
  assert.deepEqual(calls, ["close"]);
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
  assert.deepEqual(logs.map((event) => event.phase), ["prepared", "start", "stream_started", "frame_sent", "render_ack_received", "interrupted"]);
  assert.equal(JSON.stringify(logs).includes("PRIVATE"), false);
  assert.deepEqual(Object.keys(logs.at(-1)).sort(), ["elapsedMs", "framesSent", "phase", "reason", "renderAckCommands", "requestId"]);
  assert.equal(logs.at(-1).framesSent, 2); assert.equal(logs.at(-1).renderAckCommands, 2);
  const g = fixture(t); await g.service.request("owner", g.body); await g.command("start"); g.callbacks().onInvalidated("frame_timeout");
  assert.equal(g.service.getResult("owner", g.body.requestId).status, "pending");
  const h = fixture(t); await h.service.request("owner", h.body); await h.command("start");
  await h.command("input", { sequence: 1, frameId: 1, input: { type: "key", key: "Enter" } });
  h.callbacks().onInvalidated("frame_timeout");
  assert.equal(h.service.getResult("owner", h.body.requestId).status, "pending");
});

function reconnect(f, socket, auth = f.auth, conversation = f.session, foreground = true) {
  f.appControl.handleMessage(socket, { channel: "control", op: "app.control.register", payload: { version: 1, clientInstanceId: "new-app-instance" } }, auth);
  const connectionGeneration = f.sent.at(-1).payload.connectionGeneration;
  f.appControl.handleMessage(socket, { channel: "control", op: "app.control.update", payload: { connectionGeneration, foreground, surfaces: [],
    chats: [{ chatId: "new-mounted-chat", generation: 1, target: conversation }] } }, auth);
}
function sync(f, socket, auth = f.auth) {
  f.service.handleMessage(socket, { channel: "control", op: "browser.control.sync", requestId: randomUUID(), payload: {} }, auth);
  return f.sent.at(-1).payload.requests;
}
test("offline card creation opens no browser and only its authenticated device recovers metadata", async (t) => {
  const f = fixture(t); f.appControl.disconnect(f.ws);
  await f.service.request("owner", f.body); assert.equal(f.prepared(), 0);
  const restored = {}, foreign = {};
  reconnect(f, restored); assert.equal(sync(f, restored)[0].requestId, f.body.requestId);
  assert.deepEqual(sync(f, foreign, { ...f.auth, sessionId: "other-device" }), []);
  assert.deepEqual(sync(f, foreign, { ...f.auth, ownerSubjectId: "other-owner" }), []);
  assert.deepEqual(sync(f, foreign, { local: true, ownerSubjectId: "owner" }), []);
  assert.equal((await f.command("start", { controlId: randomUUID() }, restored)).status, "active"); assert.equal(f.prepared(), 1);
});
test("a card created after reconnect is delivered to the recovered original device", async (t) => {
  const f = fixture(t), restored = {}; f.appControl.disconnect(f.ws); reconnect(f, restored); sync(f, restored);
  await f.service.request("owner", f.body);
  assert.equal(f.sent.some((message) => message.ws === restored && message.op === "browser.control.request"), true);
  assert.equal(f.prepared(), 0);
});
test("explicit Open supersedes a half-open Wi-Fi connection without transferring input or old frames", async (t) => {
  const f = fixture(t); await f.service.request("owner", f.body); await f.command("start"); const oldCallbacks = f.callbacks();
  await f.command("input", { frameId: 1, sequence: 1, input: { type: "text", text: "already-applied" } });
  const restored = {}; reconnect(f, restored);
  assert.equal(sync(f, restored)[0].status, "active"); const newControlId = randomUUID();
  assert.equal((await f.command("start", { controlId: newControlId }, restored)).status, "active");
  assert.equal(f.service.getResult("owner", f.body.requestId).inputStatusUnknown, true);
  const before = f.sent.length; oldCallbacks.onFrame({ frameId: 1, data: "PRIVATE_OLD", width: 10, height: 10 });
  oldCallbacks.onOrigin("https://old.example"); oldCallbacks.onInvalidated("connection_closed"); assert.equal(f.sent.length, before);
  assert.equal((await f.command("input", { frameId: 1, sequence: 2, input: { type: "text", text: "MUST_NOT_REPLAY" } })).status, "request_unavailable");
  assert.equal((await f.command("input", { controlId: newControlId, frameId: 1, sequence: 1, input: { type: "key", key: "Enter" } }, restored)).status, "active");
  assert.deepEqual(f.inputs, [{ type: "text", text: "already-applied" }, { type: "key", key: "Enter" }]);
});
test("background and leaving the original canonical chat release active control", async (t) => {
  const f = fixture(t); await f.service.request("owner", f.body); await f.command("start");
  f.snapshot({ chatTarget: { ...f.session, cwd: "/other" } }); f.service.refreshConnection(f.ws);
  assert.equal(f.service.getResult("owner", f.body.requestId).status, "pending"); assert.equal(f.counts().closed, 1);
  assert.equal((await f.command("input", { frameId: 1, sequence: 1, input: { type: "key", key: "Enter" } })).status, "request_unavailable");
  f.snapshot(); await f.command("start", { controlId: randomUUID() });
  f.appControl.handleMessage(f.ws, { channel: "control", op: "app.control.update", payload: { connectionGeneration: f.origin.connectionGeneration, foreground: false, surfaces: [], chats: [] } });
  f.service.refreshConnection(f.ws); assert.equal(f.service.getResult("owner", f.body.requestId).status, "pending"); assert.equal(f.counts().closed, 2);
});
test("disconnect discards queued input, preserves uncertainty and does not auto-start on recovery", async (t) => {
  let release; const inputs = [];
  const f = fixture(t, { prepare: async () => ({ start: async () => {}, close() {}, input: async (input) => { inputs.push(input); await new Promise((resolve) => { release = resolve; }); } }) });
  await f.service.request("owner", f.body); await f.command("start");
  const first = f.command("input", { frameId: 1, sequence: 1, input: { type: "text", text: "first" } }); await tick();
  const second = f.command("input", { frameId: 1, sequence: 2, input: { type: "text", text: "unsent" } }); await tick();
  f.service.disconnect(f.ws); release(); await first; await second;
  assert.deepEqual(inputs, [{ type: "text", text: "first" }]);
  assert.deepEqual(f.service.getResult("owner", f.body.requestId), { requestId: f.body.requestId, status: "pending", inputStatusUnknown: true });
  const restored = {}; reconnect(f, restored); assert.equal(sync(f, restored)[0].status, "pending"); assert.deepEqual(inputs, [{ type: "text", text: "first" }]);
});
test("expired and revoked cards cannot reserve pages or open even without an intervening sync", async (t) => {
  let clock = Date.now(), active = true;
  const f = fixture(t, { now: () => clock, isSessionActive: () => active }); await f.service.request("owner", f.body);
  clock += 24 * 60 * 60_000;
  assert.equal((await f.command("start")).status, "request_unavailable"); assert.equal(f.service.getResult("owner", f.body.requestId).status, "expired");
  const next = { ...f.body, requestId: randomUUID() }; await f.service.request("owner", next); active = false;
  assert.equal(f.service.getResult("owner", next.requestId).status, "expired"); assert.equal(f.prepared(), 0);
});
test("revocation blocks active images immediately and unknown device identity grants no card", async (t) => {
  let active = true; const f = fixture(t, { isSessionActive: () => active }); await f.service.request("owner", f.body); await f.command("start"); active = false;
  f.callbacks().onFrame({ frameId: 1, data: "PRIVATE_REVOKED", width: 10, height: 10 });
  assert.equal(f.sent.some((message) => message.op === "browser.control.frame"), false); assert.equal(f.service.getResult("owner", f.body.requestId).status, "expired");
});
test("render ACK timeout before Wi-Fi close keeps the same card recoverable without replay", async (t) => {
  const f = fixture(t); await f.service.request("owner", f.body); await f.command("start");
  await f.command("input", { frameId: 1, sequence: 1, input: { type: "key", key: "Enter" } });
  f.callbacks().onInvalidated("render_ack_timeout");
  assert.deepEqual(f.service.getResult("owner", f.body.requestId), { requestId: f.body.requestId, status: "pending", inputStatusUnknown: true });
  assert.equal((await f.command("start", { controlId: randomUUID() })).status, "active");
  assert.deepEqual(f.inputs, [{ type: "key", key: "Enter" }]);
});
test("Open waits for the original chat snapshot and cancellation during prepare cannot revive it", async (t) => {
  const f = fixture(t); await f.service.request("owner", f.body); const socket = {};
  f.appControl.handleMessage(socket, { channel: "control", op: "app.control.register", payload: { version: 1, clientInstanceId: "phone-new" } }, f.auth);
  const connectionGeneration = f.sent.at(-1).payload.connectionGeneration;
  const opening = f.command("start", { controlId: randomUUID() }, socket); await tick(); assert.equal(f.prepared(), 0);
  f.appControl.handleMessage(socket, { channel: "control", op: "app.control.update", payload: { connectionGeneration, foreground: true, surfaces: [], chats: [{ chatId: "new", generation: 1, target: f.session }] } }, f.auth);
  await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(f.service.getResult("owner", f.body.requestId).status, "active"); await opening;
  let prepared; const calls = [];
  const g = fixture(t, { prepare: () => new Promise((resolve) => { prepared = resolve; }) }); await g.service.request("owner", g.body);
  const pending = g.command("start"); await tick(); await g.command("cancel");
  prepared({ start: async () => calls.push("start"), close: () => calls.push("close") }); await pending;
  assert.deepEqual(calls, ["close"]); assert.equal(g.service.getResult("owner", g.body.requestId).status, "cancelled");
});
