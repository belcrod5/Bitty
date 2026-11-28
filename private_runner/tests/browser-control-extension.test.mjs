import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createBrowserControlExtension } from "../src/browser-control-extension.mjs";
import { prepareBrowserControl } from "../src/browser-control-cdp.mjs";

const origin = "https://example.com", tick = () => new Promise((r) => setTimeout(r, 10));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const auth = { local: true, ownerSubjectId: "owner" };
function broker(t) {
  const sent = [];
  const extension = createBrowserControlExtension({ timeoutMs: 40, sendMessage: (ws, message) => { sent.push({ ws, ...message }); return true; } });
  t.after(extension.close);
  const ws = {}, receive = (payload, socket = ws, context = auth) => extension.handleMessage(socket, payload, context);
  receive({ type: "hello", version: 1 });
  const answer = (request, patch = {}) => receive({ type: "reply", id: request.id, ok: true, ...patch });
  return { extension, sent, ws, receive, answer };
}
test("only local extension metadata can select a bridge; ambiguous profiles and stale identities fail closed", async (t) => {
  const f = broker(t), promise = f.extension.discover("owner", origin);
  f.answer(f.sent.at(-1), { targets: [{ targetId: "PAGE", tabId: 3, origin, title: "PRIVATE", url: origin + "/private" }] });
  const discovery = await promise;
  assert.deepEqual(discovery.targets, [{ targetId: "PAGE", tabId: 3, origin }]);
  const other = {};
  f.receive({ type: "hello", version: 1 }, other, { ...auth, local: false });
  assert.equal(f.sent.filter((m) => m.type === "ready").length, 1);
  f.receive({ type: "hello", version: 1 }, other);
  await assert.rejects(f.extension.discover("owner", origin), { code: "browser_extension_ambiguous" });
  f.extension.disconnect(other);
  f.extension.disconnect(f.ws); f.receive({ type: "hello", version: 1 });
  assert.throws(() => f.extension.open("owner", { browserId: discovery.browserId, targetId: "PAGE", origin }), { code: "browser_extension_connection_changed" });
});
test("extension channel reuses page CDP, fences private packets by control, and closes on lost bridge", async (t) => {
  const f = broker(t), discoveryPromise = f.extension.discover("owner", origin);
  f.answer(f.sent.at(-1), { targets: [{ targetId: "PAGE", tabId: 1, origin }] });
  const { browserId } = await discoveryPromise;
  const target = { browserId, targetId: "PAGE", origin, label: "Operate" }, frames = [], reasons = [];
  const preparing = prepareBrowserControl(target, { connectExtension: (target) => f.extension.open("owner", target), onFrame: (frame) => frames.push(frame), onInvalidated: (reason) => reasons.push(reason) });
  await tick(); const attach = f.sent.find((m) => m.type === "attach"); f.answer(attach);
  const response = (request, result = {}) => f.receive({ type: "cdp", controlId: request.controlId, message: { id: request.message.id, result } });
  await tick(); response(f.sent.at(-1)); await tick(); response(f.sent.at(-1), { frameTree: { frame: { id: "FRAME", url: origin } } });
  const page = await preparing; t.after(page.close);
  const starting = page.start();
  for (let n = 0; n < 4; n++) { await tick(); response(f.sent.at(-1), n === 0 ? { frameTree: { frame: { id: "FRAME", url: origin } } } : {}); }
  await starting;
  const packet = { method: "Page.screencastFrame", params: { sessionId: 1, data: "aW1hZ2U=" } };
  f.receive({ type: "cdp", controlId: randomUUID(), message: packet });
  f.receive({ type: "cdp", controlId: attach.controlId, message: packet });
  await tick(); response(f.sent.at(-1), { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }); await tick();
  assert.equal(frames.length, 1);
  f.extension.disconnect(f.ws); assert.deepEqual(reasons, ["connection_closed"]);
});
test("attach timeout detaches the exact run; a late reply cannot open its socket", async (t) => {
  const f = broker(t), discoveryPromise = f.extension.discover("owner", origin);
  f.answer(f.sent.at(-1), { targets: [] }); const { browserId } = await discoveryPromise;
  const socket = f.extension.open("owner", { browserId, targetId: "PAGE", origin }); let opens = 0;
  socket.on("open", () => opens++); await new Promise((r) => socket.once("close", r));
  const attach = f.sent.find((m) => m.type === "attach"); f.answer(attach); await tick();
  assert.equal(opens, 0); assert.ok(f.sent.some((m) => m.type === "detach" && m.controlId === attach.controlId));
});
test("dedicated extension sockets reject remote roles, malformed/binary packets and handle socket errors", (t) => {
  const f = broker(t), socket = new EventEmitter(), closes = []; socket.close = (...args) => closes.push(args);
  f.extension.connect(socket, { ...auth, local: false }); assert.equal(closes.length, 1);
  f.extension.connect(socket, auth); socket.emit("message", "{", false); assert.equal(closes.length, 2);
  socket.emit("message", Buffer.from("{}"), true); assert.equal(closes.length, 3);
  assert.doesNotThrow(() => socket.emit("error", new Error("PRIVATE")));
});

async function background(t, overrides = {}) {
  const messages = [], calls = [], listeners = {}, timers = new Set();
  const signal = (key) => ({ addListener: (fn) => { listeners[key] = fn; } });
  const chrome = { runtime: { connectNative: () => ({ postMessage: (message) => messages.push(message), onMessage: signal("message"), onDisconnect: signal("disconnect") }), onStartup: signal("startup"), onInstalled: signal("installed") },
    debugger: { getTargets: async () => [{ id: "PAGE", tabId: 1, type: "page", url: origin + "/private?SECRET", title: "PRIVATE" }],
      attach: async (...args) => { calls.push(["attach", ...args]); return overrides.attach?.(...args); },
      detach: async (...args) => { calls.push(["detach", ...args]); return overrides.detach?.(...args); },
      sendCommand: async (source, method, params) => { calls.push([method, source, params]); return await overrides.command?.(source, method, params) || {}; }, onEvent: signal("event"), onDetach: signal("detached") } };
  vm.runInNewContext(await readFile(new URL("../browser-extension/background.js", import.meta.url), "utf8"), { chrome, URL,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, Math.min(ms, 20)); timers.add(timer); return timer; }, clearTimeout });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const receive = async (message) => { listeners.message(message); await tick(); };
  const attach = async (controlId = randomUUID()) => { await receive({ type: "attach", controlId, id: randomUUID(), targetId: "PAGE", origin }); return controlId; };
  const cdp = async (controlId, method, params = {}, sessionId) => receive({ type: "cdp", controlId, message: { id: calls.length + 1, method, params, ...(sessionId ? { sessionId } : {}) } });
  return { calls, messages, listeners, receive, attach, cdp };
}
test("pending attachment cancellation waits for late attach/detach before handing the same tab to its replacement", async (t) => {
  const attached = deferred(), detached = deferred(); let attaches = 0;
  const f = await background(t, { attach: () => ++attaches === 1 ? attached.promise : undefined, detach: () => detached.promise, command: () => new Promise(() => {}) });
  const first = await f.attach(); await f.receive({ type: "detach", controlId: first });
  const next = await f.attach(); assert.equal(attaches, 1);
  attached.resolve(); await tick(); assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
  assert.equal(attaches, 1); detached.resolve(); await tick(); await tick();
  assert.equal(attaches, 2); assert.ok(f.messages.some((m) => m.type === "reply" && m.ok));
  assert.equal(f.calls.filter(([method]) => method === "Page.stopScreencast").length, 0, "cancelled pending attaches have no renderer cleanup to wait for");
  await f.receive({ type: "detach", controlId: next });
});
test("a hung mouse command is released and detached within a bound; late completion cannot detach the replacement", async (t) => {
  const pressed = deferred(), detached = deferred(); let detaches = 0;
  const f = await background(t, { command: (source, method, params) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed" ? pressed.promise : undefined,
    detach: () => ++detaches === 1 ? detached.promise : undefined });
  const first = await f.attach(); await f.cdp(first, "Input.dispatchMouseEvent", { type: "mousePressed", x: 20, y: 30 });
  await f.receive({ type: "detach", controlId: first }); const second = await f.attach();
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(f.calls.some(([method, , params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased"));
  assert.equal(detaches, 1); assert.equal(f.calls.filter(([method]) => method === "attach").length, 1);
  pressed.resolve(); await tick(); assert.equal(f.calls.filter(([method]) => method === "attach").length, 1);
  detached.resolve(); await tick(); await tick(); assert.equal(f.calls.filter(([method]) => method === "attach").length, 2);
  assert.equal(f.messages.some((m) => m.type === "cdp" && m.controlId === first), false);
  await f.receive({ type: "detach", controlId: second });
});
test("native port loss during attachment cancels the late owner without starting a page command", async (t) => {
  const attached = deferred();
  const f = await background(t, { attach: () => attached.promise, command: () => new Promise(() => {}) });
  await f.attach(); f.listeners.disconnect(); attached.resolve(); await tick(); await tick();
  assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
  assert.equal(f.calls.some(([method]) => method.startsWith("Page.")), false);
});
test("metadata is filtered and cleanup never evaluates destroyed contexts or foreign iframe sessions", async (t) => {
  const f = await background(t);
  await f.receive({ type: "discover", id: randomUUID(), origin });
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages.at(-1).targets)), [{ targetId: "PAGE", tabId: 1, origin }]);
  const run = await f.attach(), worldName = `bitty-browser-${randomUUID()}`;
  await f.cdp(run, "Page.addScriptToEvaluateOnNewDocument", { worldName });
  f.listeners.event({ tabId: 1 }, "Runtime.executionContextCreated", { context: { name: worldName, id: 7 } });
  f.listeners.event({ tabId: 1 }, "Runtime.executionContextDestroyed", { executionContextId: 7 });
  f.listeners.event({ tabId: 1 }, "Runtime.executionContextCreated", { context: { name: worldName, id: 8 } });
  f.listeners.event({ tabId: 1 }, "Runtime.executionContextsCleared", {});
  await f.cdp(run, "Runtime.evaluate", { expression: "SHOULD_NOT_RUN" }, "foreign-session");
  await f.cdp(run, "Network.enable");
  await f.receive({ type: "detach", controlId: run });
  assert.equal(f.calls.some(([method]) => method === "Network.enable"), false);
  assert.equal(f.calls.some(([method, , params]) => method === "Runtime.evaluate" && (params.contextId === 7 || params.contextId === 8 || params.expression === "SHOULD_NOT_RUN")), false);
});
