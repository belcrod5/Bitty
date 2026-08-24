import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";

import { createCodexRelayInitiator } from "../src/codex-relay-initiator.mjs";

const upstream = new WebSocketServer({ port: 0 });
await new Promise((resolve) => upstream.once("listening", resolve));
const address = upstream.address();

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_MOCK = "1";
process.env.RUNNER_TOKEN = "test-token";
process.env.CODEX_WS_PROXY_UPSTREAM_URL = `ws://127.0.0.1:${address.port}`;
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-relay-initiated-"));
process.env.ACP_SESSION_STORE_PATH = path.join(tempRoot, "sessions.json");

const { __TESTING__ } = await import("../src/server-runtime.mjs");

test.after(async () => {
  for (const relay of Array.from(__TESTING__.codexWsRelaysById.values())) {
    __TESTING__.cleanupCodexRelay(relay, "test_cleanup");
  }
  await new Promise((resolve) => upstream.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function waitFor(check, timeoutMs = 2000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

test("runner initiator preserves only safe upstream error codes", async () => {
  for (const [upstreamCode, expectedCode] of [
    ["session_busy", "session_busy"],
    ["unsafe code", undefined],
    ["x".repeat(201), undefined],
  ]) {
    const relay = { threadId: "thread-existing" };
    const initiator = createCodexRelayInitiator({
      relay,
      operationId: "operation-test",
      forward: (_relay, raw, _isBinary, params) => {
        const request = JSON.parse(raw);
        params.clientWs.send(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32009, message: "busy", data: { code: upstreamCode } },
        }));
      },
    });
    await assert.rejects(
      initiator.client.request("turn/start"),
      (error) => error.message === "busy" && error.code === expectedCode,
    );
    initiator.close();
  }
});

test("runner initiator rejects pending RPCs immediately when its relay closes", async () => {
  for (const [reason, expectedCode] of [
    ["session_busy", "session_busy"],
    ["unsafe reason", "relay_closed"],
  ]) {
    const initiator = createCodexRelayInitiator({
      relay: { threadId: "thread-existing" },
      operationId: "operation-test",
      forward: (_relay, _raw, _isBinary, params) => {
        params.clientWs.send(JSON.stringify({ type: "runner_relay_closed", reason }));
      },
    });
    await assert.rejects(
      initiator.client.request("thread/resume"),
      (error) => error.message === "Codex relay closed" && error.code === expectedCode,
    );
    await assert.rejects(
      initiator.client.request("turn/start"),
      (error) => error.message === "Codex relay closed" && error.code === expectedCode,
    );
  }
});

test("runner-initiated turns use the normal relay and leave approvals for later clients", async () => {
  const received = [];
  let upstreamSocket;
  upstream.once("connection", (ws) => {
    upstreamSocket = ws;
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      received.push(message);
      if (message.method === "initialize") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ready: true } }));
      } else if (message.method === "thread/start") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-scheduled" } } }));
      } else if (message.method === "turn/start") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-scheduled" } } }));
      }
    });
  });

  const result = await __TESTING__.startNormalCodexTurn({
    inputText: "run scheduled checks",
    cwd: "/work/project",
    model: "gpt-5.6-sol",
    effort: "high",
    serviceName: "scheduled-codex",
  });

  assert.deepEqual(result, { threadId: "thread-scheduled", turnId: "turn-scheduled" });
  assert.equal(upstreamSocket.readyState, WebSocket.OPEN);
  const threadStart = received.find((message) => message.method === "thread/start");
  const turnStart = received.find((message) => message.method === "turn/start");
  assert.equal(threadStart.params.cwd, "/work/project");
  assert.equal(threadStart.params.serviceName, "scheduled-codex");
  assert.equal(threadStart.params.approvalPolicy, "on-request");
  assert.deepEqual(turnStart.params, {
    threadId: "thread-scheduled",
    input: [{ type: "text", text: "run scheduled checks" }],
    cwd: "/work/project",
    approvalPolicy: "on-request",
    model: "gpt-5.6-sol",
    effort: "high",
  });

  const relay = __TESTING__.pickBestRelayForThread("thread-scheduled");
  assert.ok(relay);
  assert.equal(relay.clients.size, 0);
  assert.ok(relay.cleanupTimer);

  upstreamSocket.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 91,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-scheduled", turnId: "turn-scheduled", command: "npm test" },
  }));
  await waitFor(() => relay.pendingApprovalRequestIds.has(91));
  assert.equal(relay.cleanupTimer, null);

  const replayed = [];
  const lateClient = {
    readyState: WebSocket.OPEN,
    send(raw) { replayed.push(JSON.parse(String(raw))); },
  };
  __TESTING__.attachClientToCodexRelay(relay, lateClient, { replayAfterSeq: 0 });
  assert.equal(replayed.filter((message) => message.id === 91).length, 1);

  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({ jsonrpc: "2.0", id: 91, result: { decision: "accept" } }),
    false,
    { clientWs: lateClient, threadId: "thread-scheduled" },
  );
  await waitFor(() => received.some((message) => message.id === 91 && message.result));
  assert.equal(relay.pendingApprovalRequestIds.size, 0);
  assert.equal(relay.cleanupTimer, null);

  __TESTING__.removeClientFromRelay(relay, lateClient);
  __TESTING__.cleanupOrScheduleDetachedRelay(relay, "test_detached");
  assert.ok(relay.cleanupTimer);
});
