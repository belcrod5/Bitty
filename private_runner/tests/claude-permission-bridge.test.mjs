import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createClaudePermissionBridge } from "../src/claude-permission-bridge.mjs";

const SHIM_PATH = fileURLToPath(new URL("../tools/claude-permission-prompt-mcp.mjs", import.meta.url));

async function tempSocketDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-claude-perm-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// bridgeへ1行送って応答(1行)を受け取る。shimの代わりにテストが直接socketへ話す。
function sendRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.on("connect", () => {
      socket.write(`${typeof payload === "string" ? payload : JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); });
    socket.on("error", reject);
    socket.on("close", () => {
      const line = buffer.split("\n")[0] || "";
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`response was not JSON: ${JSON.stringify(line)} (${error.message})`));
      }
    });
  });
}

test("claude permission bridge resolves allow/deny round trips and handles concurrent requests", async (t) => {
  const socketDirectory = await tempSocketDirectory(t);
  const requests = [];
  const bridge = await createClaudePermissionBridge({
    socketDirectory,
    onRequest: async (request) => {
      requests.push(request);
      // toolNameで並行リクエストの対応付けを検証する
      return request.toolName === "Write" ? { decision: "allow" } : { decision: "deny", message: "no" };
    },
  });
  t.after(() => bridge.close());

  const [allowResult, denyResult] = await Promise.all([
    sendRequest(bridge.socketPath, { token: bridge.token, toolName: "Write", input: { a: 1 }, toolUseId: "t1" }),
    sendRequest(bridge.socketPath, { token: bridge.token, toolName: "Bash", input: { cmd: "ls" }, toolUseId: "t2" }),
  ]);
  assert.deepEqual(allowResult, { decision: "allow" });
  assert.deepEqual(denyResult, { decision: "deny", message: "no" });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((r) => r.toolName).sort(), ["Bash", "Write"]);
});

test("claude permission bridge fails closed on a token mismatch", async (t) => {
  const socketDirectory = await tempSocketDirectory(t);
  let called = false;
  const bridge = await createClaudePermissionBridge({
    socketDirectory,
    onRequest: async () => { called = true; return { decision: "allow" }; },
  });
  t.after(() => bridge.close());

  const result = await sendRequest(bridge.socketPath, { token: "wrong-token", toolName: "Write", input: {}, toolUseId: "t1" });
  assert.equal(result.decision, "deny");
  assert.equal(called, false);
});

test("claude permission bridge fails closed on malformed JSON", async (t) => {
  const socketDirectory = await tempSocketDirectory(t);
  const bridge = await createClaudePermissionBridge({
    socketDirectory,
    onRequest: async () => ({ decision: "allow" }),
  });
  t.after(() => bridge.close());

  const result = await sendRequest(bridge.socketPath, "not json at all");
  assert.equal(result.decision, "deny");
});

test("claude permission bridge fails closed when a line exceeds the byte limit", async (t) => {
  const socketDirectory = await tempSocketDirectory(t);
  const bridge = await createClaudePermissionBridge({
    socketDirectory,
    onRequest: async () => ({ decision: "allow" }),
  });
  t.after(() => bridge.close());

  const result = await new Promise((resolve, reject) => {
    const socket = net.createConnection(bridge.socketPath);
    let buffer = "";
    socket.on("connect", () => {
      // newlineを送らないまま256KBを超える塊を一度に書き込む
      socket.write(Buffer.alloc(300 * 1024, "a"));
    });
    socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); });
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        resolve(JSON.parse(buffer.split("\n")[0] || ""));
      } catch (error) {
        reject(error);
      }
    });
  });
  assert.equal(result.decision, "deny");
});

test("claude permission bridge denies unanswered connections and removes the socket on close", async (t) => {
  const socketDirectory = await tempSocketDirectory(t);
  let releasePending;
  const pendingGate = new Promise((resolve) => { releasePending = resolve; });
  const bridge = await createClaudePermissionBridge({
    socketDirectory,
    onRequest: async () => {
      await pendingGate;
      return { decision: "allow" };
    },
  });

  const pending = sendRequest(bridge.socketPath, { token: bridge.token, toolName: "Write", input: {}, toolUseId: "t1" });
  // onRequestが実際に呼ばれて保留状態になるまで少し待つ
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.close();
  const result = await pending;
  assert.equal(result.decision, "deny");
  releasePending();

  await assert.rejects(fs.access(bridge.socketPath));
});

test("claude permission bridge denies when onRequest throws or rejects", async (t) => {
  const socketDirectory = await tempSocketDirectory(t);
  const bridge = await createClaudePermissionBridge({
    socketDirectory,
    onRequest: async () => { throw new Error("boom"); },
  });
  t.after(() => bridge.close());

  const result = await sendRequest(bridge.socketPath, { token: bridge.token, toolName: "Write", input: {}, toolUseId: "t1" });
  assert.equal(result.decision, "deny");
});

test("claude permission bridge socket directory is created with mode 0700", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-claude-perm-parent-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const socketDirectory = path.join(parent, "sockets");
  const bridge = await createClaudePermissionBridge({
    socketDirectory,
    onRequest: async () => ({ decision: "allow" }),
  });
  t.after(() => bridge.close());
  const stat = await fs.stat(socketDirectory);
  assert.equal(stat.mode & 0o777, 0o700);
});

// --- MCP shim (実child process) ---

function spawnShim(env) {
  return spawn(process.execPath, [SHIM_PATH], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function readJsonRpcLines(child, count) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const lines = [];
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          lines.push(JSON.parse(line));
        } catch (error) {
          reject(error);
          return;
        }
        if (lines.length >= count) {
          child.stdout.off("data", onData);
          resolve(lines);
        }
      }
    };
    child.stdout.on("data", onData);
  });
}

test("claude permission prompt shim completes the JSON-RPC handshake and forwards approvals over the bridge", async (t) => {
  const socketDirectory = await tempSocketDirectory(t);
  const seen = [];
  const bridge = await createClaudePermissionBridge({
    socketDirectory,
    onRequest: async (request) => {
      seen.push(request);
      return { decision: "allow" };
    },
  });
  t.after(() => bridge.close());

  const child = spawnShim({ BITTY_PERMISSION_SOCKET: bridge.socketPath, BITTY_PERMISSION_TOKEN: bridge.token });
  t.after(() => child.kill());

  const initReply = readJsonRpcLines(child, 1);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
  const [init] = await initReply;
  assert.equal(init.result.protocolVersion, "2024-11-05");
  assert.deepEqual(init.result.capabilities, { tools: {} });

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const listReply = readJsonRpcLines(child, 1);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  const [list] = await listReply;
  assert.equal(list.result.tools[0].name, "approval_prompt");

  const callReply = readJsonRpcLines(child, 1);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "approval_prompt", arguments: { tool_name: "Write", input: { file_path: "a.txt" }, tool_use_id: "tool-1" } },
  })}\n`);
  const [call] = await callReply;
  const body = JSON.parse(call.result.content[0].text);
  assert.deepEqual(body, { behavior: "allow", updatedInput: { file_path: "a.txt" } });
  assert.equal(seen[0].toolName, "Write");
  assert.deepEqual(seen[0].input, { file_path: "a.txt" });
});

test("claude permission prompt shim truncates a large input over the socket but keeps the full input in updatedInput", async (t) => {
  const socketDirectory = await tempSocketDirectory(t);
  let receivedInput;
  const bridge = await createClaudePermissionBridge({
    socketDirectory,
    onRequest: async (request) => {
      receivedInput = request.input;
      return { decision: "allow" };
    },
  });
  t.after(() => bridge.close());

  const child = spawnShim({ BITTY_PERMISSION_SOCKET: bridge.socketPath, BITTY_PERMISSION_TOKEN: bridge.token });
  t.after(() => child.kill());

  const bigContent = "x".repeat(10_000);
  const callReply = readJsonRpcLines(child, 1);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "approval_prompt", arguments: { tool_name: "Write", input: { content: bigContent }, tool_use_id: "tool-1" } },
  })}\n`);
  const [call] = await callReply;
  const body = JSON.parse(call.result.content[0].text);
  assert.equal(body.updatedInput.content, bigContent);
  assert.equal(receivedInput._truncated, true);
  assert.ok(receivedInput.preview.length <= 2048);
});

test("claude permission prompt shim processes concurrent tools/call requests independently", async (t) => {
  const socketDirectory = await tempSocketDirectory(t);
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const bridge = await createClaudePermissionBridge({
    socketDirectory,
    onRequest: async (request) => {
      if (request.toolName === "Slow") await gate;
      return { decision: request.toolName === "Slow" ? "allow" : "deny" };
    },
  });
  t.after(() => bridge.close());

  const child = spawnShim({ BITTY_PERMISSION_SOCKET: bridge.socketPath, BITTY_PERMISSION_TOKEN: bridge.token });
  t.after(() => child.kill());

  const bothReplies = readJsonRpcLines(child, 2);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "approval_prompt", arguments: { tool_name: "Slow", input: {}, tool_use_id: "tool-1" } },
  })}\n`);
  // 1件目の応答待ち中でも2件目が処理される(直列化しない)
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "approval_prompt", arguments: { tool_name: "Fast", input: {}, tool_use_id: "tool-2" } },
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseFirst();
  const replies = await bothReplies;
  const byId = Object.fromEntries(replies.map((reply) => [reply.id, JSON.parse(reply.result.content[0].text)]));
  assert.equal(byId[1].behavior, "allow");
  assert.equal(byId[2].behavior, "deny");
});

test("claude permission prompt shim exits when stdin closes", async (t) => {
  const socketDirectory = await tempSocketDirectory(t);
  const bridge = await createClaudePermissionBridge({
    socketDirectory,
    onRequest: async () => ({ decision: "allow" }),
  });
  t.after(() => bridge.close());

  const child = spawnShim({ BITTY_PERMISSION_SOCKET: bridge.socketPath, BITTY_PERMISSION_TOKEN: bridge.token });
  const exitPromise = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  child.stdin.end();
  const code = await exitPromise;
  assert.equal(code, 0);
});
