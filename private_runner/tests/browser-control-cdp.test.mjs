import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareBrowserControl, validateBrowserControlTarget, validBrowserControlInput } from "../src/browser-control-cdp.mjs";
const target = { cdpUrl: "ws://127.0.0.1:9222/devtools/page/TAB", origin: "https://example.com", label: "Login" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const frameMessage = (sessionId = 1) => ({ method: "Page.screencastFrame", params: { sessionId, data: "aW1hZ2U=", metadata: { deviceWidth: 1600, deviceHeight: 1200 } } });
async function peer(t, respond) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await new Promise((r) => server.once("listening", r));
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  const messages = []; let socket;
  server.on("connection", (connection) => { socket = connection; socket.on("message", (raw) => {
    const message = JSON.parse(String(raw)); messages.push(message);
    const result = respond?.(message, socket) ?? ({ "Page.enable": {}, "Page.getFrameTree": { frameTree: { frame: { id: "FRAME", url: target.origin } } },
      "Page.getLayoutMetrics": { cssVisualViewport: { clientWidth: 800, clientHeight: 600, offsetX: 0, offsetY: 0 } } }[message.method] || {});
    if (result === false) return;
    socket.send(JSON.stringify({ id: message.id, ...result.error ? { error: result.error } : { result } }));
  }); });
  return { messages, target: { ...target, cdpUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/TAB` }, emit: (message) => socket.send(JSON.stringify(message)), raw: (text) => socket.send(text), close: () => socket.terminate() };
}
test("only explicit local page targets and bounded primitive inputs are accepted", () => {
  assert.deepEqual(validateBrowserControlTarget(target), target);
  for (const patch of [{ cdpUrl: "ws://example.com:9222/devtools/page/TAB" }, { cdpUrl: "wss://127.0.0.1:9222/devtools/page/TAB" }, { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/TAB" }, { origin: "https://example.com/path" }, { label: "" }, { selector: "#secret" }, { value: "secret" }]) assert.throws(() => validateBrowserControlTarget({ ...target, ...patch }));
  assert.equal(validBrowserControlInput({ type: "text", text: "日本語" }), true);
  for (const input of [{ type: "text", text: "" }, { type: "text", text: "x".repeat(4097) }, { type: "key", key: "F12" }, { type: "move", x: NaN, y: 0 }, { type: "scroll", x: 0, y: 0, deltaX: 0, deltaY: 3000 }, { type: "text", text: "x", code: "js" }]) assert.equal(validBrowserControlInput(input), false);
});
test("no stream until explicit start; rendered-frame CSS coordinates ignore image pixels and DPR", async (t) => {
  const f = await peer(t); const frames = [];
  const browser = await prepareBrowserControl(f.target, { onFrame: (frame) => frames.push(frame) }); t.after(browser.close);
  assert.deepEqual(f.messages.map((m) => m.method), ["Page.enable", "Page.getFrameTree"]);
  await browser.start(); f.emit(frameMessage()); await tick(); assert.equal(frames.length, 1);
  assert.equal(frames[0].width, 800); await browser.ack(frames[0].frameId);
  await browser.input({ type: "down", x: 0.25, y: 0.5 }, frames[0].frameId);
  await browser.input({ type: "up", x: 0.25, y: 0.5 }, frames[0].frameId);
  await browser.input({ type: "text", text: "ダミー" }, frames[0].frameId);
  assert.deepEqual(f.messages.find((m) => m.method === "Input.dispatchMouseEvent").params, { type: "mousePressed", x: 200, y: 300, button: "left", buttons: 1, clickCount: 1 });
  assert.equal(f.messages.at(-1).method, "Input.insertText");
  assert.equal(f.messages.some((m) => /Runtime|DOM|Network|Console|captureScreenshot/.test(m.method)), false);
});
test("one unrendered frame at a time, pause releases mouse and invalidates old image/coordinates", async (t) => {
  const f = await peer(t), frames = []; const browser = await prepareBrowserControl(f.target, { onFrame: (frame) => frames.push(frame) }); t.after(browser.close);
  await browser.start(); f.emit(frameMessage(1)); await tick(); f.emit(frameMessage(2)); await tick(); assert.equal(frames.length, 1);
  await browser.ack(frames[0].frameId); await browser.input({ type: "down", x: 0.5, y: 0.5 }, frames[0].frameId);
  await browser.pause(); assert.equal(f.messages.at(-1).method, "Page.stopScreencast");
  assert.equal(f.messages.findLast((m) => m.method === "Input.dispatchMouseEvent").params.type, "mouseReleased");
  assert.deepEqual(f.messages.filter((m) => m.method === "Emulation.setFocusEmulationEnabled").map((m) => m.params.enabled), [true, false]);
  await browser.start(); await assert.rejects(browser.input({ type: "text", text: "stale" }, frames[0].frameId));
});
test("remote focus is acquired before streaming without native window manipulation", async (t) => {
  const f = await peer(t), phases = [];
  const browser = await prepareBrowserControl(f.target, { onDiagnostic: (phase) => phases.push(phase) }); t.after(browser.close);
  await browser.start();
  const focus = f.messages.findIndex((m) => m.method === "Emulation.setFocusEmulationEnabled");
  assert.equal(f.messages[focus].params.enabled, true);
  assert.ok(focus < f.messages.findIndex((m) => m.method === "Page.startScreencast"));
  assert.equal(f.messages.some((m) => m.method.startsWith("Browser.")), false);
  assert.deepEqual(phases, ["focus_enabled", "stream_started"]);
});
test("viewport changes release a held drag and invalidate old input coordinates before the new image is drawn", async (t) => {
  let width = 800, height = 600, offsetY = 0, invalidations = 0;
  const f = await peer(t, (message) => message.method === "Page.getLayoutMetrics" ? { cssVisualViewport: { clientWidth: width, clientHeight: height, offsetX: 0, offsetY } } : undefined);
  const frames = [], browser = await prepareBrowserControl(f.target, { onFrame: (frame) => frames.push(frame), onViewInvalidated: () => invalidations++ }); t.after(browser.close);
  await browser.start(); f.emit(frameMessage(1)); await tick(); await browser.ack(frames[0].frameId);
  await browser.input({ type: "down", x: 0.5, y: 0.5 }, frames[0].frameId);
  width = 1600; height = 1200; f.emit(frameMessage(2)); await tick();
  assert.equal(frames.length, 2); assert.equal(f.messages.findLast((m) => m.method === "Input.dispatchMouseEvent").params.type, "mouseReleased");
  await assert.rejects(browser.input({ type: "up", x: 0.5, y: 0.5 }, frames[0].frameId), { code: "stale_frame" });
  await assert.rejects(browser.input({ type: "text", text: "not displayed" }, frames[1].frameId), { code: "stale_frame" });
  await browser.ack(frames[1].frameId); await browser.input({ type: "down", x: 0.5, y: 0.5 }, frames[1].frameId); await browser.input({ type: "up", x: 0.5, y: 0.5 }, frames[1].frameId);
  assert.deepEqual(f.messages.filter((m) => m.method === "Input.dispatchMouseEvent").map((m) => m.params.type), ["mousePressed", "mouseReleased", "mousePressed", "mouseReleased"]);
  await browser.input({ type: "down", x: 0.5, y: 0.5 }, frames[1].frameId); offsetY = 5; f.emit(frameMessage(3)); await tick();
  assert.equal(invalidations, 2); await assert.rejects(browser.input({ type: "up", x: 0.5, y: 0.5 }, frames[1].frameId), { code: "stale_frame" });
  await browser.ack(frames[2].frameId); await browser.input({ type: "down", x: 0.5, y: 0.5 }, frames[2].frameId); await browser.input({ type: "up", x: 0.5, y: 0.5 }, frames[2].frameId);
});
test("missing first frames and missing render acknowledgements have bounded, distinct failures", async (t) => {
  for (const rendered of [false, true]) {
    const f = await peer(t), reasons = [];
    const browser = await prepareBrowserControl(f.target, { frameTimeoutMs: 30, onInvalidated: (reason) => reasons.push(reason) }); t.after(browser.close);
    await browser.start(); if (rendered) f.emit(frameMessage());
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(reasons, [rendered ? "render_ack_timeout" : "frame_timeout"]);
  }
});
test("pause or close during focus acquisition releases the override and cannot start a late stream", async (t) => {
  for (const action of ["pause", "close"]) {
    let finishFocus;
    const f = await peer(t, (m, socket) => {
      if (m.method !== "Emulation.setFocusEmulationEnabled" || !m.params.enabled) return;
      finishFocus = () => socket.send(JSON.stringify({ id: m.id, result: {} })); return false;
    });
    const browser = await prepareBrowserControl(f.target); t.after(browser.close);
    const starting = browser.start(); const rejected = action === "close" ? assert.rejects(starting) : null;
    await tick();
    if (action === "pause") { await browser.pause(); finishFocus(); await starting; }
    else { browser.close(); await rejected; }
    await tick();
    assert.deepEqual(f.messages.filter((m) => m.method === "Emulation.setFocusEmulationEnabled").map((m) => m.params.enabled), [true, false]);
    assert.equal(f.messages.some((m) => m.method === "Page.startScreencast"), false);
  }
});
test("navigation during focus acquisition invalidates frames without cancelling stream startup", async (t) => {
  let finishFocus;
  const f = await peer(t, (m, socket) => {
    if (m.method !== "Emulation.setFocusEmulationEnabled" || !m.params.enabled) return;
    finishFocus = () => socket.send(JSON.stringify({ id: m.id, result: {} })); return false;
  });
  const frames = [], browser = await prepareBrowserControl(f.target, { onFrame: (frame) => frames.push(frame) }); t.after(browser.close);
  const starting = browser.start(); await tick();
  f.emit({ method: "Page.frameStartedNavigating", params: { frameId: "FRAME" } });
  f.emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME", url: "https://login.example/" } } }); await tick();
  finishFocus(); await starting;
  assert.equal(f.messages.some((m) => m.method === "Page.startScreencast"), true);
  f.emit(frameMessage()); await tick(); assert.equal(frames.length, 1);
});
test("navigation clears pending frame, rejects old rendered frame, and updates origin without following tabs", async (t) => {
  const f = await peer(t), frames = [], origins = []; let cleared = 0;
  const browser = await prepareBrowserControl(f.target, { onFrame: (frame) => frames.push(frame), onOrigin: (origin) => origins.push(origin), onViewInvalidated: () => cleared++ }); t.after(browser.close);
  await browser.start(); f.emit(frameMessage(1)); await tick();
  f.emit({ method: "Page.frameStartedNavigating", params: { frameId: "FRAME" } });
  f.emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME", url: "https://login.example/private?value=must-not-forward" } } }); await tick();
  await browser.ack(frames[0].frameId); await assert.rejects(browser.input({ type: "text", text: "stale" }, frames[0].frameId));
  f.emit(frameMessage(2)); await tick(); assert.equal(frames.length, 2); await browser.ack(frames[1].frameId);
  await browser.input({ type: "text", text: "current" }, frames[1].frameId);
  assert.deepEqual(origins, ["https://login.example"]); assert.equal(cleared, 2);
});
test("late layout response cannot resurrect a frame after navigation or pause/start", async (t) => {
  for (const mode of ["navigation", "pause"]) {
    let resolveLayout; const f = await peer(t, (m, socket) => { if (m.method === "Page.getLayoutMetrics") { resolveLayout = () => socket.send(JSON.stringify({ id: m.id, result: { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } } })); return false; } });
    const frames = []; const browser = await prepareBrowserControl(f.target, { onFrame: (frame) => frames.push(frame) }); t.after(browser.close);
    await browser.start(); f.emit(frameMessage()); await tick();
    if (mode === "pause") { await browser.pause(); await browser.start(); }
    else f.emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME", url: target.origin } } });
    await tick(); resolveLayout(); await tick(); assert.equal(frames.length, 0);
  }
});
test("pause during the initial frame-tree read prevents a late stream start", async (t) => {
  let reads = 0, resolveRead;
  const f = await peer(t, (m, socket) => { if (m.method === "Page.getFrameTree" && ++reads === 2) { resolveRead = () => socket.send(JSON.stringify({ id: m.id, result: { frameTree: { frame: { id: "FRAME", url: target.origin } } } })); return false; } });
  const browser = await prepareBrowserControl(f.target); t.after(browser.close);
  const starting = browser.start(); await tick(); await browser.pause(); resolveRead(); await starting;
  assert.equal(f.messages.some((m) => m.method === "Page.startScreencast"), false);
});
test("same-document and cancelled navigation resume frames and stale input is explicitly unapplied", async (t) => {
  const f = await peer(t), frames = []; const browser = await prepareBrowserControl(f.target, { onFrame: (frame) => frames.push(frame) }); t.after(browser.close);
  await browser.start(); f.emit(frameMessage(1)); await tick(); await browser.ack(frames[0].frameId);
  f.emit({ method: "Page.frameStartedNavigating", params: { frameId: "FRAME" } });
  f.emit({ method: "Page.navigatedWithinDocument", params: { frameId: "FRAME", url: target.origin + "/#next" } }); await tick();
  await assert.rejects(browser.input({ type: "text", text: "must not send" }, frames[0].frameId), { code: "stale_frame" });
  f.emit(frameMessage(2)); await tick(); assert.equal(frames.length, 2); await browser.ack(frames[1].frameId);
  f.emit({ method: "Page.frameStartedNavigating", params: { frameId: "FRAME" } }); f.emit({ method: "Page.frameStoppedLoading", params: { frameId: "FRAME" } }); await tick();
  f.emit(frameMessage(3)); await tick(); assert.equal(frames.length, 3);
  assert.equal(f.messages.some((m) => m.method === "Input.insertText"), false);
});
test("navigation releases a held pointer and old up cannot poison a new-page click", async (t) => {
  const f = await peer(t), frames = []; const browser = await prepareBrowserControl(f.target, { onFrame: (frame) => frames.push(frame) }); t.after(browser.close);
  await browser.start(); f.emit(frameMessage(1)); await tick(); await browser.ack(frames[0].frameId);
  await browser.input({ type: "down", x: 0.2, y: 0.2 }, frames[0].frameId);
  f.emit({ method: "Page.navigatedWithinDocument", params: { frameId: "FRAME", url: target.origin + "/#next" } }); await tick();
  await assert.rejects(browser.input({ type: "up", x: 0.2, y: 0.2 }, frames[0].frameId), { code: "stale_frame" });
  f.emit(frameMessage(2)); await tick(); await browser.ack(frames[1].frameId);
  await browser.input({ type: "down", x: 0.4, y: 0.4 }, frames[1].frameId); await browser.input({ type: "up", x: 0.4, y: 0.4 }, frames[1].frameId);
  const events = f.messages.filter((m) => m.method === "Input.dispatchMouseEvent");
  assert.deepEqual(events.map((m) => m.params.type), ["mousePressed", "mouseReleased", "mousePressed", "mouseReleased"]);
});
test("a late pointer response cannot restore pressed state after pausing", async (t) => {
  let finishDown, delayDown = true;
  const f = await peer(t, (m, socket) => { if (m.method === "Input.dispatchMouseEvent" && m.params.type === "mousePressed" && delayDown) { delayDown = false; finishDown = () => socket.send(JSON.stringify({ id: m.id, result: {} })); return false; } });
  const frames = []; const browser = await prepareBrowserControl(f.target, { onFrame: (frame) => frames.push(frame) }); t.after(browser.close);
  await browser.start(); f.emit(frameMessage(1)); await tick(); await browser.ack(frames[0].frameId);
  const down = browser.input({ type: "down", x: 0.2, y: 0.2 }, frames[0].frameId); await tick(); await browser.pause(); finishDown(); await down;
  await browser.start(); f.emit(frameMessage(2)); await tick(); await browser.ack(frames[1].frameId);
  await browser.input({ type: "down", x: 0.4, y: 0.4 }, frames[1].frameId); await browser.input({ type: "up", x: 0.4, y: 0.4 }, frames[1].frameId);
});
test("unexpected connection errors are fixed and intentional close does not invalidate", async (t) => {
  for (const mode of ["close", "malformed", "abort"]) {
    const f = await peer(t); let invalidations = 0; const controller = new AbortController();
    const browser = await prepareBrowserControl(f.target, { signal: controller.signal, onInvalidated: () => invalidations++ }); t.after(browser.close);
    if (mode === "close") f.close(); else if (mode === "malformed") f.raw("{"); else controller.abort();
    await tick(); assert.equal(invalidations, mode === "abort" ? 0 : 1);
  }
});

for (const headed of process.platform === "darwin" ? [false, true] : [false]) test(`isolated ${headed ? "minimized headed" : "DPR 2 headless"} Chromium controls custom panel/slider/checkbox/confirmation and Japanese input`, { skip: !process.env.BITTY_TEST_CHROMIUM_EXECUTABLE, timeout: 45_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-browser-control-test-"));
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0}button,input{position:absolute}#open{left:40px;top:40px;width:120px;height:40px}#panel{display:none;position:absolute;left:40px;top:100px;width:400px;height:260px;background:#ddd}#slider{position:absolute;left:20px;top:20px;width:300px;height:40px;background:#aaa}#terms{left:20px;top:90px;width:30px;height:30px}#confirm{left:120px;top:90px;width:120px;height:40px}#text{left:40px;top:400px;width:300px;height:40px}</style><button id="open">Open panel</button><div id="panel"><div id="slider"></div><input id="terms" type="checkbox"><button id="confirm">Confirm</button></div><input id="text"><script>window.chosen=0;window.confirmed=false;const panel=document.getElementById('panel'),slider=document.getElementById('slider');document.getElementById('open').onclick=()=>panel.style.display='block';slider.onpointerdown=e=>{slider.setPointerCapture(e.pointerId);window.chosen=e.offsetX};slider.onpointermove=e=>{if(e.buttons)window.chosen=e.offsetX};document.getElementById('confirm').onclick=()=>window.confirmed=document.getElementById('terms').checked&&window.chosen>200;</script>`;
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); }); await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = spawn(process.env.BITTY_TEST_CHROMIUM_EXECUTABLE, [...(headed ? [] : ["--headless"]), "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-crash-reporter", "--disable-breakpad", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${directory}`, `${origin}/form`], { stdio: "ignore" });
  const sockets = [];
  t.after(async () => { for (const s of sockets) s.terminate(); chrome.kill("SIGKILL"); await new Promise((r) => { if (chrome.exitCode !== null || chrome.signalCode) r(); else chrome.once("exit", r); }); await new Promise((r) => server.close(r)); await fs.rm(directory, { recursive: true, force: true }); });
  let port, tab; const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { try { port = Number((await fs.readFile(path.join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0]); if (port) break; } catch {} await tick(); }
  assert.ok(port);
  while (Date.now() < deadline) { tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === "page" && p.url.startsWith(origin)); if (tab) break; await tick(); }
  assert.ok(tab);
  let socket = new WebSocket(tab.webSocketDebuggerUrl); sockets.push(socket); await new Promise((r, j) => { socket.once("open", r); socket.once("error", j); });
  let seq = 0; const waiting = new Map(); const receive = (raw) => { const m = JSON.parse(String(raw)); waiting.get(m.id)?.(m.result); waiting.delete(m.id); }; socket.on("message", receive);
  const call = (method, params) => new Promise((r) => { const id = ++seq; waiting.set(id, r); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  while (!await evaluate('!!document.querySelector("#text")')) await tick();
  if (headed) {
    const { windowId } = await call("Browser.getWindowForTarget");
    await call("Browser.setWindowBounds", { windowId, bounds: { width: 540, height: 900 } });
    await call("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    const closed = new Promise((resolve) => socket.once("close", resolve)); socket.close(); await closed;
    await new Promise((resolve) => setTimeout(resolve, 3500));
  } else await call("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 2, mobile: false });
  let currentFrame, browser, frameCount = 0;
  browser = await prepareBrowserControl({ ...target, cdpUrl: tab.webSocketDebuggerUrl, origin }, { onFrame: (frame) => { currentFrame = frame; frameCount++; void browser.ack(frame.frameId); } }); t.after(browser.close);
  await browser.start(); while (!currentFrame && Date.now() < deadline) await tick(); assert.ok(currentFrame);
  if (headed) {
    socket = new WebSocket(tab.webSocketDebuggerUrl); sockets.push(socket); await new Promise((r, j) => { socket.once("open", r); socket.once("error", j); }); socket.on("message", receive);
    assert.equal(await evaluate("document.visibilityState"), "visible");
  } else { assert.equal(currentFrame.width, 800); assert.equal(currentFrame.height, 600); }
  const pointer = (type, x, y) => browser.input({ type, x: x / currentFrame.width, y: y / currentFrame.height }, currentFrame.frameId);
  const click = async (x, y) => { await pointer("down", x, y); await pointer("up", x, y); await tick(); };
  await click(90, 60); await pointer("down", 80, 140); await pointer("move", 320, 140); await pointer("up", 320, 140);
  await click(75, 205); await click(220, 210); await click(160, 420);
  await browser.input({ type: "text", text: "日本語テスト" }, currentFrame.frameId);
  await browser.input({ type: "key", key: "Backspace" }, currentFrame.frameId);
  assert.deepEqual(await evaluate('({confirmed:window.confirmed,text:document.getElementById("text").value})'), { confirmed: true, text: "日本語テス" });
  assert.ok(frameCount >= 1);
  const previousFrame = currentFrame.frameId;
  await evaluate('location.hash="next";document.body.style.background="blue"');
  const hashDeadline = Date.now() + 3000;
  while (currentFrame.frameId === previousFrame && Date.now() < hashDeadline) await tick();
  assert.ok(currentFrame.frameId > previousFrame, "same-document navigation resumes page frames");
  await browser.pause(); const pausedCount = frameCount; await evaluate('document.body.style.background="red"'); await new Promise((r) => setTimeout(r, 100)); assert.equal(frameCount, pausedCount);
  if (headed) assert.equal(await evaluate("document.visibilityState"), "hidden");
  await browser.start(); const resumed = Date.now() + 3000;
  while (frameCount === pausedCount && Date.now() < resumed) await tick();
  assert.ok(frameCount > pausedCount, "reopening delivers a fresh frame");
  browser.close(); const closedCount = frameCount; await evaluate('document.body.style.background="green"'); await new Promise((r) => setTimeout(r, 100)); assert.equal(frameCount, closedCount);
  if (headed) assert.equal(await evaluate("document.visibilityState"), "hidden");
});
