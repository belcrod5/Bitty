import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { spawn, execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const execFile = promisify(callback), source = fileURLToPath(new URL("../../", import.meta.url));
const origin = `chrome-extension://${"a".repeat(32)}/`;
const encode = (value) => { const data = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(data.length); return Buffer.concat([header, data]); };
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/bitty-native-")), logs = path.join(root, "logs"), keyPath = path.join(logs, "token"), socketPath = path.join(logs, "runner.sock");
  await fs.mkdir(logs, { mode: 0o700 }); await fs.writeFile(keyPath, "N".repeat(43), { mode: 0o600 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, logs, keyPath, socketPath };
}
async function native(t, config, argument = origin) {
  const launcher = path.join(config.root, "launch.mjs");
  await fs.writeFile(launcher, `import { runBrowserControlNativeHost } from ${JSON.stringify(pathToFileURL(path.join(source, "private_runner/src/browser-control-native-host.mjs")).href)};\nrunBrowserControlNativeHost(${JSON.stringify({ ...config, extensionOrigin: origin })}).catch(()=>{process.stderr.write('native_host_failed\\n');process.exitCode=1;});`);
  const child = spawn(process.execPath, [launcher, argument], { stdio: ["pipe", "pipe", "pipe"] });
  const packets = []; let buffer = Buffer.alloc(0), stderr = "";
  child.stdout.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
      const size = buffer.readUInt32LE(); packets.push(JSON.parse(buffer.subarray(4, size + 4).toString())); buffer = buffer.subarray(size + 4);
    }
  });
  child.stderr.on("data", (data) => { stderr += String(data); }); child.stdin.on("error", () => {});
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  t.after(async () => { child.stdin.end(); if (child.exitCode === null) await Promise.race([exited, new Promise((r) => setTimeout(() => { child.kill("SIGTERM"); r(); }, 1000))]); });
  return { child, packets, exited, stderr: () => stderr, send: (value) => child.stdin.write(encode(value)) };
}
const wait = async (condition) => { const end = Date.now() + 5000; while (!condition()) { if (Date.now() > end) throw new Error("test_timeout"); await new Promise((r) => setTimeout(r, 10)); } };
test("native host uses authenticated Unix only, frames stdout, bounds traffic, and never replays after reconnect", async (t) => {
  const f = await fixture(t), received = [], sockets = [];
  const server = createServer(), wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    assert.equal(req.url, "/browser-extension"); assert.equal(req.socket.remoteAddress, undefined); assert.equal(req.headers.authorization, `Bearer ${"N".repeat(43)}`);
    wss.handleUpgrade(req, socket, head, (ws) => { sockets.push(ws); ws.on("message", (raw) => received.push(JSON.parse(String(raw)))); });
  });
  await new Promise((r) => server.listen(f.socketPath, r)); await fs.chmod(f.socketPath, 0o600);
  t.after(() => { for (const socket of sockets) socket.terminate(); server.close(); wss.close(); });
  const host = await native(t, f); await wait(() => received.length === 1);
  assert.deepEqual(received[0], { type: "hello", version: 1 });
  sockets[0].send(JSON.stringify({ channel: "agent", op: "PRIVATE_OTHER_CHANNEL", payload: "PRIVATE" }));
  sockets[0].send(JSON.stringify({ type: "ready" }));
  await wait(() => host.packets.length === 1); assert.deepEqual(host.packets, [{ type: "ready" }]);
  const large = { type: "cdp", controlId: "test", message: { method: "Page.screencastFrame", params: { data: "x".repeat(2 * 1024 * 1024) } } };
  host.send(large); await wait(() => received.length === 2); assert.equal(received[1].message.params.data.length, 2 * 1024 * 1024);
  sockets[0].close(); await wait(() => host.packets.some((packet) => packet.type === "reset"));
  host.send({ type: "reply", id: "MUST_NOT_REPLAY", ok: true });
  await wait(() => sockets.length === 2 && received.filter((m) => m.type === "hello").length === 2);
  assert.equal(received.some((message) => message.id === "MUST_NOT_REPLAY"), false);
  assert.equal(host.stderr(), ""); host.child.stdin.end(); assert.equal(await host.exited, 0);
});
test("native host rejects foreign extension origins and oversized/malformed frames without exposing their contents", async (t) => {
  const f = await fixture(t), foreign = await native(t, f, "chrome-extension://foreign/");
  assert.equal(await foreign.exited, 1); assert.equal(foreign.stderr().includes("foreign"), false); assert.deepEqual(foreign.packets, []);
  const host = await native(t, f), header = Buffer.alloc(4); header.writeUInt32LE(3 * 1024 * 1024 + 1); host.child.stdin.write(header);
  assert.equal(await host.exited, 0); assert.deepEqual(host.packets, []); assert.equal(host.stderr(), "bitty_browser_host_invalid_message\n");
});
test("installer is read-only by default, installs stable copied payloads, and refuses unsafe paths before overwriting", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await fixture(t), home = path.join(f.root, "home");
  await fs.mkdir(home, { mode: 0o700 });
  const run = (...args) => execFile(process.execPath, [path.join(source, "scripts/browser-control/install-extension.mjs"), "--home", home, ...args],
    { env: { ...process.env, RUNNER_CONTROL_SOCKET: f.socketPath } });
  const dry = JSON.parse((await run()).stdout); assert.equal(dry.mode, "dry-run"); assert.deepEqual(await fs.readdir(home), []);
  const applied = JSON.parse((await run("--apply")).stdout), payload = path.dirname(applied.extensionPath);
  const launcher = path.join(payload, "native-host.mjs"), manifestPath = path.join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bitty.browser_control.json");
  assert.equal((await fs.stat(launcher)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(payload, "host.mjs"))).mode & 0o777, 0o600);
  const keyPath = path.join(payload, "native-key"), key = await fs.readFile(keyPath, "utf8");
  assert.match(key.trim(), /^[A-Za-z0-9_-]{43}$/); assert.equal((await fs.stat(keyPath)).mode & 0o777, 0o600);
  const reinstall = await run("--apply"); assert.equal(await fs.readFile(keyPath, "utf8"), key); assert.equal(reinstall.stdout.includes(key.trim()), false);
  assert.ok((await fs.readFile(path.join(payload, "node_modules/ws/LICENSE"), "utf8")).includes("MIT"));
  assert.equal((await fs.readFile(launcher, "utf8")).includes(path.join(source, "private_runner/src")), false);
  assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, "utf8")).allowed_origins, [`chrome-extension://${applied.extensionId}/`]);
  const before = await fs.readFile(path.join(applied.extensionPath, "background.js"), "utf8");
  await fs.rm(manifestPath); await fs.symlink(path.join(f.root, "keep"), manifestPath);
  await assert.rejects(run("--apply")); assert.equal(await fs.readFile(path.join(applied.extensionPath, "background.js"), "utf8"), before);
  await fs.unlink(manifestPath); await fs.chmod(applied.extensionPath, 0o777); await assert.rejects(run("--apply"));
});
