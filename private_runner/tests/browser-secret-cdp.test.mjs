import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareBrowserSecretInput, validateBrowserInputTarget } from "../src/browser-secret-cdp.mjs";

const target = { cdpUrl: "ws://127.0.0.1:9222/devtools/page/TAB", selector: "#password", origin: "https://example.com", label: "Password" };
test("only local CDP page connections and explicit origins are accepted", () => {
  assert.deepEqual(validateBrowserInputTarget(target), target);
  for (const patch of [
    { cdpUrl: "ws://example.com:9222/devtools/page/TAB" }, { cdpUrl: "wss://127.0.0.1:9222/devtools/page/TAB" },
    { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/TAB" }, { cdpUrl: `${target.cdpUrl}?token=x` },
    { cdpUrl: "ws://user:pass@127.0.0.1:9222/devtools/page/TAB" }, { origin: "https://example.com/path" },
    { selector: "" }, { label: "" }, { frameId: "bad/frame" }, { value: "secret" },
  ]) assert.throws(() => validateBrowserInputTarget({ ...target, ...patch }));
});

async function peer(t, respond) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  const messages = [];
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const message = JSON.parse(String(raw)); messages.push(message);
    const result = respond?.(message, socket) ?? ({
      "Page.enable": {}, "Page.getFrameTree": { frameTree: { frame: { id: "FRAME", loaderId: "LOADER", url: target.origin } } },
      "Page.createIsolatedWorld": { executionContextId: 42 }, "Runtime.evaluate": { result: { objectId: "ELEMENT" } },
      "Runtime.callFunctionOn": { result: { value: true } },
    }[message.method]);
    if (result) socket.send(JSON.stringify({ id: message.id, ...result.error ? { error: result.error } : { result } }));
  }));
  return { messages, target: { ...target, cdpUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/TAB` } };
}

test("writes the unchanged value only through callFunctionOn, and never enables observation", async (t) => {
  const f = await peer(t);
  const browser = await prepareBrowserSecretInput(f.target); t.after(browser.close);
  await browser.fill("  exact test value\n");
  const calls = f.messages.filter((m) => m.method === "Runtime.callFunctionOn");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params.arguments, [{ value: "  exact test value\n" }, { value: target.selector }]);
  assert.equal(calls[0].params.objectId, "ELEMENT");
  assert.equal(calls[0].params.silent, true);
  assert.deepEqual(f.messages.map((m) => m.method), ["Page.enable", "Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate", "Page.getFrameTree", "Runtime.callFunctionOn"]);
});

test("navigation, abort and raw CDP exceptions fail without exposing browser errors", async (t) => {
  for (const mode of ["navigation", "abort", "exception"]) {
    let reads = 0;
    const f = await peer(t, (m) => {
      if (mode === "navigation" && m.method === "Page.getFrameTree" && ++reads > 1) return { frameTree: { frame: { id: "FRAME", loaderId: "CHANGED", url: target.origin } } };
      if (mode === "exception" && m.method === "Runtime.callFunctionOn") return { error: { message: "RAW_PRIVATE_VALUE" } };
    });
    const controller = new AbortController();
    const browser = await prepareBrowserSecretInput(f.target, { signal: controller.signal }); t.after(browser.close);
    if (mode === "abort") controller.abort();
    await assert.rejects(browser.fill("RAW_PRIVATE_VALUE"), (error) => error.message === "browser_input_unavailable");
    if (mode !== "exception") assert.equal(f.messages.some((m) => m.method === "Runtime.callFunctionOn"), false);
  }
});

test("navigation and unexpected browser close invalidate once, intentional abort does not", async (t) => {
  for (const mode of ["navigation", "close", "malformed", "abort"]) {
    let socket;
    const f = await peer(t, (_message, connection) => { socket = connection; });
    let invalidations = 0;
    const controller = new AbortController();
    const browser = await prepareBrowserSecretInput(f.target, { signal: controller.signal, onInvalidated: () => { invalidations++; } });
    t.after(browser.close);
    if (mode === "navigation") {
      socket.send(JSON.stringify({ method: "Page.frameNavigated", params: {} }));
      socket.send(JSON.stringify({ method: "Page.frameDetached", params: {} }));
    } else if (mode === "close") socket.terminate();
    else if (mode === "malformed") socket.send("{");
    else controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(invalidations, mode === "abort" ? 0 : 1);
  }
});

test("real Chromium fills exact text, dispatches events and rejects changed documents/elements", {
  skip: !process.env.BITTY_TEST_CHROMIUM_EXECUTABLE, timeout: 40_000,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-browser-input-test-"));
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><input id="password" type="password"><script>window.events=[];for(const type of ["input","change"])document.querySelector("input").addEventListener(type,()=>events.push(type));</script>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = spawn(process.env.BITTY_TEST_CHROMIUM_EXECUTABLE, ["--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-crash-reporter", "--disable-breakpad", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${directory}`, `${origin}/form`], { stdio: "ignore" });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    chrome.kill("SIGKILL");
    await new Promise((resolve) => { if (chrome.exitCode !== null || chrome.signalCode) resolve(); else chrome.once("exit", resolve); });
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  let port;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { port = Number((await fs.readFile(path.join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0]); if (port) break; } catch {}
    if (chrome.exitCode !== null || chrome.signalCode) throw new Error("Isolated Chromium exited before CDP became ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(port, "Isolated Chromium did not expose CDP");
  let tab;
  while (Date.now() < deadline) {
    tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === "page" && p.url.startsWith(origin));
    if (tab) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(tab);
  const socket = new WebSocket(tab.webSocketDebuggerUrl); sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let sequence = 0; const waiting = new Map();
  socket.on("message", (raw) => { const m = JSON.parse(String(raw)); waiting.get(m.id)?.(m.result); waiting.delete(m.id); });
  const call = (method, params) => new Promise((resolve) => { const id = ++sequence; waiting.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  const inputTarget = { ...target, cdpUrl: tab.webSocketDebuggerUrl, origin };
  // Wait for the fixture document, without touching any existing browser/profile.
  while (!await evaluate('!!document.querySelector("#password")')) await new Promise((resolve) => setTimeout(resolve, 25));
  const browser = await prepareBrowserSecretInput(inputTarget); t.after(browser.close);
  await browser.fill("  fixture password  ");
  assert.deepEqual(await evaluate('({value:document.querySelector("#password").value,events})'), { value: "  fixture password  ", events: ["input", "change"] });
  const replaced = await prepareBrowserSecretInput(inputTarget); t.after(replaced.close);
  await evaluate('document.querySelector("#password").replaceWith(document.querySelector("#password").cloneNode())');
  await assert.rejects(replaced.fill("replacement must stay empty"));
  assert.equal(await evaluate('document.querySelector("#password").value'), "  fixture password  ");
  const rejected = await prepareBrowserSecretInput(inputTarget); t.after(rejected.close);
  await evaluate('document.querySelector("#password").addEventListener("input",e=>{e.target.value=""})');
  await assert.rejects(rejected.fill("site rejects this"));
  const navigated = await prepareBrowserSecretInput(inputTarget); t.after(navigated.close);
  await call("Page.navigate", { url: `${origin}/another-document` });
  await assert.rejects(navigated.fill("must not enter next document"));
});
