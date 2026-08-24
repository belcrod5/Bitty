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

test("targeted schedules resume normally and fail busy without replacing an active relay", async (t) => {
  const received = [];
  const handleConnection = (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      received.push(message);
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      } else if (message.method === "thread/resume") {
        socket.send(JSON.stringify({
          jsonrpc: "2.0", id: message.id, result: { thread: { id: message.params.threadId } },
        }));
      } else if (message.method === "turn/start") {
        socket.send(JSON.stringify({
          jsonrpc: "2.0", id: message.id, result: { turn: { id: "scheduled-turn" } },
        }));
      }
    });
  };
  upstream.on("connection", handleConnection);
  t.after(() => upstream.off("connection", handleConnection));

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
      threadId: "scheduled-thread",
    }],
  });
  current = new Date("2026-08-14T00:00:00.000Z");
  await service.evaluate();

  const snapshot = await service.snapshot();
  assert.equal(snapshot.schedules[0].lastDispatch.status, "fired");
  assert.equal(snapshot.schedules[0].lastDispatch.threadId, "scheduled-thread");
  assert.equal(snapshot.schedules[0].lastDispatch.turnId, "scheduled-turn");
  assert.equal(received.some((message) => message.method === "thread/start"), false);
  const threadResume = received.find((message) => message.method === "thread/resume");
  const turnStart = received.find((message) => message.method === "turn/start");
  assert.deepEqual(threadResume.params, {
    threadId: "scheduled-thread",
    cwd: "/work/scheduled-project",
    excludeTurns: true,
  });
  assert.equal(turnStart.params.approvalPolicy, "on-request");
  assert.equal(turnStart.params.cwd, "/work/scheduled-project");
  assert.equal(turnStart.params.model, "gpt-5.6-sol");
  assert.equal(turnStart.params.effort, "xhigh");
  assert.deepEqual(turnStart.params.input, [{ type: "text", text: "Run the scheduled action" }]);
  const activeRelay = __TESTING__.pickBestRelayForThread("scheduled-thread");
  assert.ok(activeRelay?.agentLease);

  await service.createSchedule({
    baseRevision: 1,
    schedule: {
      name: "Busy scheduled relay",
      enabled: true,
      startLocal: "2026-08-14T09:01:00",
      timeZone: "Asia/Tokyo",
      rrule: null,
      cwd: "/work/scheduled-project",
      modelRef: "openai-codex/gpt-5.6-sol",
      reasoningEffort: "xhigh",
      prompt: "Do not interrupt the active turn",
      threadId: "scheduled-thread",
    },
  }, "22222222-2222-4222-8222-222222222222");
  current = new Date("2026-08-14T00:01:00.000Z");
  await service.evaluate();

  const busy = (await service.snapshot()).schedules.find((schedule) => (
    schedule.id === "22222222-2222-4222-8222-222222222222"
  ));
  assert.ok(busy);
  assert.equal(activeRelay.closed, false);
  assert.ok(activeRelay.agentLease);
  assert.equal(busy.lastDispatch.status, "failed");
  assert.equal(busy.lastDispatch.errorCode, "session_busy");
  assert.equal(received.filter((message) => message.method === "thread/resume").length, 2);
  assert.equal(received.filter((message) => message.method === "turn/start").length, 1);

  activeRelay.pendingApprovalRequestIds.add(91);
  await service.createSchedule({
    baseRevision: 2,
    schedule: {
      name: "Pending approval collision",
      enabled: true,
      startLocal: "2026-08-14T09:02:00",
      timeZone: "Asia/Tokyo",
      rrule: null,
      cwd: "/work/scheduled-project",
      modelRef: "openai-codex/gpt-5.6-sol",
      reasoningEffort: "xhigh",
      prompt: "Do not replace the approval owner",
      threadId: "scheduled-thread",
    },
  }, "33333333-3333-4333-8333-333333333333");
  current = new Date("2026-08-14T00:02:00.000Z");
  const pendingStartedAt = Date.now();
  await service.evaluate();
  const pendingElapsedMs = Date.now() - pendingStartedAt;

  const pendingCollision = (await service.snapshot()).schedules.find((schedule) => (
    schedule.id === "33333333-3333-4333-8333-333333333333"
  ));
  assert.ok(pendingCollision);
  assert.equal(activeRelay.closed, false);
  assert.equal(activeRelay.pendingApprovalRequestIds.has(91), true);
  assert.equal(pendingCollision.lastDispatch.status, "failed");
  assert.equal(
    pendingCollision.lastDispatch.errorCode,
    "session_busy",
    JSON.stringify(pendingCollision.lastDispatch),
  );
  assert.equal(received.filter((message) => message.method === "thread/resume").length, 2);
  assert.equal(received.filter((message) => message.method === "turn/start").length, 1);
  assert.ok(pendingElapsedMs < 1_000, `pending collision took ${pendingElapsedMs}ms`);
});
