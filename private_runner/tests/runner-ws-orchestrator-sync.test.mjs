import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Load the real dispatch in an isolated workspace; never open the user's stores or server ports.
const runnerRoot = fileURLToPath(new URL("..", import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "runner-orchestrator-sync-"));
await fs.cp(path.join(runnerRoot, "src"), path.join(temp, "private_runner/src"), { recursive: true });
await fs.symlink(path.join(runnerRoot, "node_modules"), path.join(temp, "private_runner/node_modules"));
const originalCwd = process.cwd();
process.chdir(temp);
Object.assign(process.env, { RUNNER_SKIP_SERVER_START: "1", RUNNER_MOCK: "1", RUNNER_TOKEN: "synthetic-token",
  RUNNER_LOG_REQUESTS: "0", CODEX_WS_DEBUG_FILE: path.join(temp, "ws-debug.jsonl"),
  CODEX_AUTH_STORE_DIR: path.join(temp, "auth"), ACP_SESSION_STORE_PATH: path.join(temp, "agent-sessions.json") });
const { __TESTING__ } = await import(pathToFileURL(path.join(temp, "private_runner/src/server-runtime.mjs")));
test.after(async () => { process.chdir(originalCwd); await fs.rm(temp, { recursive: true, force: true }); });

function connect() {
  const sent = [];
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = (data) => sent.push(JSON.parse(data));
  socket.close = () => { socket.readyState = 3; socket.emit("close"); };
  __TESTING__.runnerWsServer.emit("connection", socket,
    { url: "/runner-ws", headers: { host: "127.0.0.1" }, socket: { remoteAddress: "synthetic" } });
  let sequence = 0;
  return { sent, socket, request: async (op, payload) => {
    const requestId = `read-${++sequence}`;
    socket.emit("message", JSON.stringify({ channel: "agent", op, requestId, payload }), false);
    for (let i = 0; i < 50; i++) {
      const response = sent.find((message) => message.requestId === requestId);
      if (response) return response;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("synthetic RPC did not finish");
  } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("socket opt-in synchronizes metadata once, retains legacy lists and resends changed metadata", async () => {
  let current = { etag: "metadata-1", selectedId: "main", orchestrators: [
    { id: "main", name: "Main", icon: `data:image/png;base64,${"A".repeat(200_000)}`, unreadCount: 0, learningUnreadCount: 0 },
  ] };
  let release;
  let delayNext = false;
  __TESTING__.voiceContextService.list = () => {
    if (delayNext) { delayNext = false; return new Promise((resolve) => { release = resolve; }); }
    return Promise.resolve(current);
  };
  __TESTING__.voiceContextService.markRead = async () => ({ changed: true });
  const modern = connect(); const legacy = connect(); let resumed;
  try {
    const first = await modern.request("voice.orchestrators.list", { updates: "conditional" });
    assert.equal(first.payload.orchestrators[0].icon, current.orchestrators[0].icon);
    const old = await legacy.request("voice.orchestrators.list");
    assert.equal(old.payload.orchestrators[0].icon, current.orchestrators[0].icon);
    current = { ...current, orchestrators: [{ ...current.orchestrators[0], unreadCount: 3 }] };
    await modern.request("voice.read", {}); await tick();
    const unchanged = modern.sent.filter((message) => message.op === "voice.unread.changed").at(-1);
    assert.deepEqual(unchanged.payload, { etag: "metadata-1", notModified: true,
      unreadCounts: [{ id: "main", unreadCount: 3, learningUnreadCount: 0 }] });
    assert.equal(legacy.sent.find((message) => message.op === "voice.unread.changed").payload.orchestrators[0].icon, current.orchestrators[0].icon);
    assert.ok(Buffer.byteLength(JSON.stringify(unchanged)) < Buffer.byteLength(JSON.stringify(first)) / 100);
    assert.ok((await modern.request("voice.orchestrators.list")).payload.orchestrators, "a non-opt-in call on the same socket remains a full response");
    modern.socket.close();
    resumed = connect();
    assert.equal((await resumed.request("voice.orchestrators.list", { updates: "conditional", ifNoneMatch: "metadata-1" })).payload.notModified, true);
    delayNext = true;
    const pending = resumed.request("voice.orchestrators.list", { updates: "conditional", ifNoneMatch: "metadata-1" });
    await tick();
    current = { ...current, etag: "metadata-2", orchestrators: [{ ...current.orchestrators[0], icon: "changed-icon" }] };
    await legacy.request("voice.read", {}); await tick();
    assert.equal(resumed.sent.filter((message) => message.op === "voice.unread.changed").at(-1).payload.orchestrators[0].icon, "changed-icon");
    release(current);
    assert.equal((await pending).payload.notModified, true, "full notification may establish metadata before the pending reply");
    await legacy.request("voice.read", {}); await tick();
    assert.equal(resumed.sent.filter((message) => message.op === "voice.unread.changed").at(-1).payload.notModified, true);
    assert.ok((await legacy.request("voice.orchestrators.list")).payload.orchestrators);
  } finally { modern.socket.close(); legacy.socket.close(); resumed?.socket.close(); }
});


test("directory identity projection avoids the explorer payload and preserves invalid-path errors", async () => {
  const directory = path.join(temp, "identity-directory");
  await fs.mkdir(directory);
  const file = path.join(directory, "example.txt");
  await fs.writeFile(file, "fixture");
  const canonical = await fs.realpath(directory);
  assert.deepEqual(await __TESTING__.listLlmDirectories(directory, true), { basePath: canonical });
  const explorer = await __TESTING__.listLlmDirectories(directory);
  assert.equal(explorer.basePath, canonical);
  assert.equal(explorer.files.length, 1);
  await assert.rejects(__TESTING__.listLlmDirectories(path.join(directory, "missing"), true), (error) => error.apiStatus === 404);
  await assert.rejects(__TESTING__.listLlmDirectories(file, true), (error) => error.apiStatus === 500);
});
