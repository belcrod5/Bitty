import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "runner-children-"));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_MOCK = "1";
process.env.RUNNER_TOKEN = "synthetic-token";
process.env.CODEX_WS_DEBUG_FILE = path.join(temp, "ws-debug.jsonl");
const { __TESTING__ } = await import("../src/server-runtime.mjs");
test.after(async () => fs.rm(temp, { recursive: true, force: true }));

test("raw child notifications reach Runner consumers before foreign-thread relay filtering", async () => {
  const sent = [];
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = (data) => sent.push(JSON.parse(data));
  __TESTING__.runnerWsServer.emit("connection", socket, { url: "/runner-ws", headers: { host: "127.0.0.1" }, socket: { remoteAddress: "test" } });
  const relay = { relayId: "synthetic-relay", threadId: "unrelated-owner", clients: new Set(), closed: false };
  const send = (method, params) => __TESTING__.handleCodexRelayUpstreamMessage(relay, JSON.stringify({ method, params }), false);
  try {
    for (let i = 0; i < 100; i++) send("item/completed", { threadId: "actual-parent", item: { id: `item-${i}`, type: "commandExecution" } });
    assert.equal(sent.filter((entry) => entry.op === "session_children_changed").length, 0);
    send("item/completed", { threadId: "actual-parent", item: { type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["actual-child"] } });
    send("thread/status/changed", { threadId: "actual-child", status: "idle" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.filter((entry) => entry.op === "session_children_changed").map((entry) => entry.payload.parentSessionRef), [
      { backendId: "codex", nativeSessionId: "actual-parent" }, { backendId: "codex", nativeSessionId: "actual-parent" },
    ]);
    assert.equal(relay.lastSeq, undefined, "foreign child events must still not enter the owner's relay replay");
  } finally { socket.readyState = 3; socket.emit("close"); }
});
