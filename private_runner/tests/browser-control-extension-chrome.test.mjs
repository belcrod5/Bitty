import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { installBrowserControlExtension } from "../../scripts/browser-control/install-extension.mjs";
import { createBrowserControlExtension } from "../src/browser-control-extension.mjs";
import { prepareBrowserControl } from "../src/browser-control-cdp.mjs";
import { authenticateBrowserControlNativeKey } from "../src/browser-control-native-auth.mjs";
import { runnerBearerToken, RUNNER_AUTHENTICATION } from "../src/runner-login-http.mjs";
import { installRunnerWebSocketUpgradeHandler } from "../src/runner-websocket-upgrade.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url)), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eventually = async (check) => { const deadline = Date.now() + 10_000; for (;;) { const result = await check(); if (result) return result; if (Date.now() > deadline) throw new Error("isolated_extension_timeout"); await sleep(30); } };

test("isolated Chrome hands the same live tab through the installed extension and Native Messaging, without repeated approval", {
  skip: process.platform !== "darwin" || !process.env.BITTY_TEST_CHROMIUM_EXECUTABLE, timeout: 45_000,
}, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/bitty-extension-real-")), home = path.join(root, "home"), fixtureRepo = path.join(root, "repo");
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(path.join(fixtureRepo, "private_runner/src"), { recursive: true });
  const logs = path.join(fixtureRepo, "private_runner/logs"); await fs.mkdir(logs, { mode: 0o700 });
  await fs.writeFile(path.join(fixtureRepo, "private_runner/package.json"), "{}");
  await fs.symlink(path.join(repo, "private_runner/node_modules"), path.join(fixtureRepo, "private_runner/node_modules"), "dir");
  for (const name of ["browser-control-native-host.mjs", "browser-control-native-auth.mjs"]) await fs.copyFile(path.join(repo, "private_runner/src", name), path.join(fixtureRepo, "private_runner/src", name));
  await fs.cp(path.join(repo, "private_runner/browser-extension"), path.join(fixtureRepo, "private_runner/browser-extension"), { recursive: true });
  const previousSocket = process.env.RUNNER_CONTROL_SOCKET; delete process.env.RUNNER_CONTROL_SOCKET;
  let installed;
  try { installed = await installBrowserControlExtension({ repoRoot: fixtureRepo, home, apply: true }); }
  finally { if (previousSocket === undefined) delete process.env.RUNNER_CONTROL_SOCKET; else process.env.RUNNER_CONTROL_SOCKET = previousSocket; }
  const socketPath = path.join(logs, "runner-control.sock"), keyPath = path.join(path.dirname(installed.extensionPath), "native-key");
  const native = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024 });
  const broker = createBrowserControlExtension({ sendMessage: (ws, payload) => { ws.send(JSON.stringify(payload)); return true; } });
  const runner = createServer((_req, res) => { res.writeHead(404); res.end(); }); let nativeConnections = 0;
  installRunnerWebSocketUpgradeHandler({ server: runner, runnerWsPath: "/runner-ws", browserExtensionWsServer: native,
    authenticateBrowserExtension: async (req) => {
      await authenticateBrowserControlNativeKey(runnerBearerToken(req), keyPath);
      const auth = { local: true, ownerSubjectId: "isolated-owner" }; req[RUNNER_AUTHENTICATION] = auth; return auth;
    }, appendDebug() {} });
  native.on("connection", (ws, req) => { nativeConnections++; broker.connect(ws, req[RUNNER_AUTHENTICATION]); });
  await new Promise((r) => runner.listen(socketPath, r)); await fs.chmod(socketPath, 0o600);
  let companionReady = false;
  const pageServer = createServer((req, res) => {
    if (req.url === "/companion-ready") { companionReady = true; res.end("ok"); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/child") { res.end('<!doctype html><input id="child" style="position:absolute;left:10px;top:10px;width:180px;height:40px"><script>child.oninput=()=>parent.postMessage({typed:child.value==="子の入力"},"*")</script>'); return; }
    res.end(`<!doctype html><meta charset="utf-8"><style>body{margin:0}input{position:absolute;left:30px;top:30px;width:250px;height:40px}button{position:absolute;left:30px;top:100px;width:150px;height:40px}iframe{position:absolute;left:350px;top:30px;width:250px;height:140px;border:0}</style><input id="input"><button id="button">test</button><iframe src="http://localhost:${pageServer.address().port}/child"></iframe><script>window.clicked=false;button.onclick=()=>window.clicked=true;window.onmessage=e=>{if(e.data?.typed)window.childTyped=true};</script>`);
  });
  await new Promise((r) => pageServer.listen(0, "127.0.0.1", r)); const origin = `http://127.0.0.1:${pageServer.address().port}`;
  const profile = path.join(home, "Library/Application Support/Google/Chrome"), sockets = []; let chrome, browser;
  t.after(async () => {
    browser?.close(); broker.close(); for (const socket of sockets) socket.terminate(); for (const socket of native.clients) socket.terminate();
    chrome?.kill("SIGTERM");
    if (chrome && chrome.exitCode === null && !chrome.signalCode) await Promise.race([new Promise((r) => chrome.once("exit", r)), sleep(2000).then(() => chrome.kill("SIGKILL"))]);
    native.close(); runner.closeAllConnections(); runner.close(); pageServer.closeAllConnections(); pageServer.close(); await fs.rm(root, { recursive: true, force: true });
  });
  chrome = spawn(process.env.BITTY_TEST_CHROMIUM_EXECUTABLE, ["--start-minimized", "--remote-debugging-port=0", "--enable-unsafe-extension-debugging", "--site-per-process", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-proxy-server", `--user-data-dir=${profile}`, `${origin}/test`], { stdio: "ignore" });
  const port = await eventually(async () => { try { return Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { return null; } });
  const connect = async (url) => { const socket = new WebSocket(url); sockets.push(socket); await new Promise((r, j) => { socket.once("open", r); socket.once("error", j); }); return socket; };
  let sequence = 0;
  const call = (socket, method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { socket.off("message", receive); reject(new Error("isolated_diagnostic_timeout")); }, 3000);
    const receive = (raw) => { const reply = JSON.parse(String(raw)); if (reply.id !== id) return; clearTimeout(timer); socket.off("message", receive); reply.error ? reject(new Error("isolated_diagnostic_failed")) : resolve(reply.result); };
    socket.on("message", receive); socket.send(JSON.stringify({ id, method, params }));
  });
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(), chromeSocket = await connect(version.webSocketDebuggerUrl);
  const tab = await eventually(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((page) => page.type === "page" && page.url === `${origin}/test`));
  const pageSocket = await connect(tab.webSocketDebuggerUrl);
  await eventually(async () => (await call(pageSocket, "Runtime.evaluate", { expression: 'document.readyState==="complete"&&!!document.getElementById("input")', returnByValue: true })).result.value);
  await call(pageSocket, "Runtime.evaluate", { expression: "window.aiState=123", returnByValue: true });
  const companion = path.join(root, "companion"); await fs.mkdir(companion);
  await fs.writeFile(path.join(companion, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Isolated companion", version: "1.0.0", permissions: ["debugger"], host_permissions: [`${origin}/*`], background: { service_worker: "worker.js" } }));
  await fs.writeFile(path.join(companion, "worker.js"), `(async()=>{const target=(await chrome.debugger.getTargets()).find(p=>p.url===${JSON.stringify(`${origin}/test`)});await chrome.debugger.attach({tabId:target.tabId},"1.3");await chrome.debugger.sendCommand({tabId:target.tabId},"Runtime.enable");globalThis.stillAttached=true;chrome.debugger.onDetach.addListener(()=>globalThis.stillAttached=false);await fetch(${JSON.stringify(`${origin}/companion-ready`)});})();`);
  const companionId = (await call(chromeSocket, "Extensions.loadUnpacked", { path: companion })).id;
  await eventually(() => companionReady);
  assert.equal((await call(chromeSocket, "Extensions.loadUnpacked", { path: installed.extensionPath })).id, installed.extensionId);
  const discover = () => broker.discover("isolated-owner", origin);
  const discovery = await eventually(async () => { try { return await discover(); } catch { return null; } });
  assert.equal(discovery.targets.length, 1); assert.equal(discovery.targets[0].targetId, tab.id);
  const target = { browserId: discovery.browserId, targetId: tab.id, origin, label: "Isolated test" }, focuses = [], invalidated = [];
  let frame;
  const options = { connectExtension: (target) => broker.open("isolated-owner", target), onFrame: (next) => { frame = next; void browser?.ack(next.frameId).catch(() => {}); }, onFocus: (next) => focuses.push(next), onInvalidated: (reason) => invalidated.push(reason) };
  browser = await prepareBrowserControl(target, options); await browser.start(); await eventually(() => frame);
  const click = async (x, y) => { for (const type of ["down", "up"]) await browser.input({ type, x: x / frame.width, y: y / frame.height }, frame.frameId); };
  await click(100, 120); await click(100, 50); await eventually(() => focuses.at(-1)?.editable);
  const mainFocus = focuses.at(-1).focusRevision;
  await browser.input({ type: "text", text: "日本語テスト", focusRevision: mainFocus }, frame.frameId);
  await click(380, 60); await eventually(() => focuses.at(-1)?.editable && focuses.at(-1).focusRevision !== mainFocus);
  await browser.input({ type: "text", text: "子の入力", focusRevision: focuses.at(-1).focusRevision }, frame.frameId);
  const state = async () => (await call(pageSocket, "Runtime.evaluate", { expression: 'window.aiState===123&&window.clicked===true&&document.getElementById("input").value==="日本語テスト"&&window.childTyped===true', returnByValue: true })).result.value;
  await sleep(100);
  assert.deepEqual((await call(pageSocket, "Runtime.evaluate", { expression: '({ai:window.aiState===123,clicked:window.clicked===true,typed:document.getElementById("input").value==="日本語テスト",child:window.childTyped===true})', returnByValue: true })).result.value, { ai: true, clicked: true, typed: true, child: true });
  browser.close(); frame = null;
  browser = await prepareBrowserControl(target, options); await browser.start(); await eventually(() => frame); assert.equal(await state(), true);
  const previousConnections = nativeConnections;
  for (const socket of native.clients) socket.terminate();
  await eventually(() => invalidated.includes("connection_closed"));
  const rediscovered = await eventually(async () => { if (nativeConnections <= previousConnections) return null; try { return await discover(); } catch { return null; } });
  assert.notEqual(rediscovered.browserId, target.browserId); assert.equal(rediscovered.targets[0].targetId, tab.id);
  assert.throws(() => broker.open("isolated-owner", target), { code: "browser_extension_connection_changed" });
  frame = null; browser = await prepareBrowserControl({ ...target, browserId: rediscovered.browserId }, options); await browser.start(); await eventually(() => frame);
  assert.equal(await state(), true); browser.close(); browser = null;
  const companionTarget = (await call(chromeSocket, "Target.getTargets")).targetInfos.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${companionId}/`));
  const companionSocket = await connect(`ws://127.0.0.1:${port}/devtools/page/${companionTarget.targetId}`);
  assert.equal((await call(companionSocket, "Runtime.evaluate", { expression: "globalThis.stillAttached===true", returnByValue: true })).result.value, true);
  assert.equal(await state(), true); assert.equal(pageSocket.readyState, WebSocket.OPEN);
  frame = null; let navigationInvalidations = 0;
  browser = await prepareBrowserControl({ ...target, browserId: rediscovered.browserId }, { ...options, onViewInvalidated: () => navigationInvalidations++ });
  await browser.start(); await eventually(() => frame); const oldFrameId = frame.frameId;
  frame = null; await call(pageSocket, "Page.navigate", { url: `${origin}/next` });
  await eventually(() => navigationInvalidations && frame && frame.frameId !== oldFrameId);
  await assert.rejects(browser.input({ type: "text", text: "must not replay" }, oldFrameId), { code: "stale_frame" });
  assert.deepEqual(invalidated, ["connection_closed"], "a real document navigation must not interrupt control");
  browser.close(); browser = null;
});
