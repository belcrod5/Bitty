import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";

import { createCodexScheduleService } from "../src/codex-schedule-service.mjs";

const upstream = new WebSocketServer({ port: 0 });
await new Promise((resolve) => upstream.once("listening", resolve));

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_MOCK = "1";
process.env.RUNNER_TOKEN = "test-token";
process.env.CODEX_WS_PROXY_UPSTREAM_URL = `ws://127.0.0.1:${upstream.address().port}`;
const agentStoreRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-scheduled-agent-"));
const agentStorePath = path.join(agentStoreRoot, "sessions.json");
process.env.ACP_SESSION_STORE_PATH = agentStorePath;

const { __TESTING__ } = await import("../src/server-runtime.mjs");

test.after(async () => {
  await new Promise((resolve) => upstream.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.rm(agentStoreRoot, { recursive: true, force: true });
});

test("new-chat schedules start through the neutral Agent transport", { timeout: 5_000 }, async (t) => {
  const received = [];
  let upstreamSocket;
  const handleConnection = (socket) => {
    upstreamSocket = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      received.push(message);
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      } else if (message.method === "modelProvider/capabilities/read") {
        socket.send(JSON.stringify({
          jsonrpc: "2.0", id: message.id, result: { namespaceTools: true },
        }));
      } else if (message.method === "plugin/list") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { marketplaces: [] } }));
      } else if (message.method === "mcpServerStatus/list") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { data: [], nextCursor: null } }));
      } else if (message.method === "thread/start") {
        socket.send(JSON.stringify({
          jsonrpc: "2.0", id: message.id, result: { thread: { id: "scheduled-thread" } },
        }));
      } else if (message.method === "turn/start") {
        socket.send(JSON.stringify({
          jsonrpc: "2.0", id: message.id, result: { turn: { id: "scheduled-turn" } },
        }));
      } else if (message.method && message.id !== undefined) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      }
    });
  };
  upstream.on("connection", handleConnection);
  t.after(() => upstream.off("connection", handleConnection));

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scheduled-agent-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let current = new Date("2026-08-13T00:00:00.000Z");
  const service = createCodexScheduleService({
    definitionsPath: path.join(directory, "definitions.json"),
    runtimePath: path.join(directory, "runtime.json"),
    parseCodexOptions: (modelRef, reasoningEffort) => ({
      modelInfo: { modelRef, model: modelRef.split("/")[1] },
      reasoningEffort,
    }),
    validateCwd: async () => {},
    startScheduledCodexTurn: __TESTING__.startScheduledCodexTurn,
    now: () => new Date(current),
    scheduleTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  await service.replaceSchedules({
    baseRevision: 0,
    schedules: [{
      id: "11111111-1111-4111-8111-111111111111",
      name: "Scheduled Agent",
      enabled: true,
      startLocal: "2026-08-14T09:00:00",
      timeZone: "Asia/Tokyo",
      rrule: null,
      cwd: "/work/scheduled-project",
      modelRef: "openai-codex/gpt-5.6-sol",
      reasoningEffort: "xhigh",
      prompt: "Run the scheduled action",
      threadId: null,
    }],
  });
  current = new Date("2026-08-14T00:00:00.000Z");
  await service.evaluate();

  const snapshot = await service.snapshot();
  assert.equal(
    snapshot.schedules[0].lastDispatch.status,
    "fired",
    JSON.stringify(snapshot.schedules[0].lastDispatch),
  );
  assert.deepEqual(snapshot.schedules[0].lastDispatch.result, {
    kind: "llm", threadId: "scheduled-thread", turnId: "scheduled-turn",
  });
  assert.equal(received.some((message) => message.method === "thread/resume"), false);
  const threadStart = received.find((message) => message.method === "thread/start");
  const turnStart = received.find((message) => message.method === "turn/start");
  assert.equal(threadStart.params.cwd, "/work/scheduled-project");
  assert.equal(threadStart.params.approvalPolicy, "on-request");
  assert.equal(turnStart.params.model, "gpt-5.6-sol");
  assert.equal(turnStart.params.effort, "xhigh");
  assert.deepEqual(turnStart.params.input, [{ type: "text", text: "Run the scheduled action" }]);

  const store = JSON.parse(await fs.readFile(agentStorePath, "utf8"));
  const mode = store.agentSessionModes.find((entry) => (
    entry.backendId === "codex" && entry.nativeSessionId === "scheduled-thread"
  ));
  assert.equal(mode?.mode, "neutral");
  assert.equal(__TESTING__.pickBestRelayForThread("scheduled-thread"), null);

  upstreamSocket.send(JSON.stringify({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId: "scheduled-thread",
      turnId: "scheduled-turn",
      turn: { id: "scheduled-turn", status: "completed" },
    },
  }));
});
