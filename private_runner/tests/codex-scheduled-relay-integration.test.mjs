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
const agentStoreRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-scheduled-relay-agent-"));
process.env.ACP_SESSION_STORE_PATH = path.join(agentStoreRoot, "sessions.json");

const { __TESTING__ } = await import("../src/server-runtime.mjs");

test.after(async () => {
  for (const relay of Array.from(__TESTING__.codexWsRelaysById.values())) {
    __TESTING__.cleanupCodexRelay(relay, "test_cleanup");
  }
  await new Promise((resolve) => upstream.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.rm(agentStoreRoot, { recursive: true, force: true });
});

test("a due schedule starts through the normal relay and stops tracking at turn acceptance", async (t) => {
  const received = [];
  upstream.once("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      received.push(message);
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      } else if (message.method === "thread/start") {
        socket.send(JSON.stringify({
          jsonrpc: "2.0", id: message.id, result: { thread: { id: "scheduled-thread" } },
        }));
      } else if (message.method === "turn/start") {
        socket.send(JSON.stringify({
          jsonrpc: "2.0", id: message.id, result: { turn: { id: "scheduled-turn" } },
        }));
      }
    });
  });

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scheduled-relay-test-"));
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
    startNormalCodexTurn: __TESTING__.startNormalCodexTurn,
    now: () => new Date(current),
    scheduleTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  await service.replaceSchedules({
    baseRevision: 0,
    schedules: [{
      id: "11111111-1111-4111-8111-111111111111",
      name: "Scheduled relay",
      enabled: true,
      startLocal: "2026-08-14T09:00:00",
      timeZone: "Asia/Tokyo",
      rrule: null,
      cwd: "/work/scheduled-project",
      modelRef: "openai-codex/gpt-5.6-sol",
      reasoningEffort: "xhigh",
      prompt: "Run the scheduled action",
    }],
  });
  current = new Date("2026-08-14T00:00:00.000Z");
  await service.evaluate();

  const snapshot = await service.snapshot();
  assert.equal(snapshot.schedules[0].lastDispatch.status, "fired");
  assert.equal(snapshot.schedules[0].lastDispatch.threadId, "scheduled-thread");
  assert.equal(snapshot.schedules[0].lastDispatch.turnId, "scheduled-turn");
  const threadStart = received.find((message) => message.method === "thread/start");
  const turnStart = received.find((message) => message.method === "turn/start");
  assert.equal(threadStart.params.approvalPolicy, "on-request");
  assert.equal(turnStart.params.approvalPolicy, "on-request");
  assert.equal(turnStart.params.cwd, "/work/scheduled-project");
  assert.equal(turnStart.params.model, "gpt-5.6-sol");
  assert.equal(turnStart.params.effort, "xhigh");
  assert.deepEqual(turnStart.params.input, [{ type: "text", text: "Run the scheduled action" }]);
  assert.ok(__TESTING__.pickBestRelayForThread("scheduled-thread"));
});
