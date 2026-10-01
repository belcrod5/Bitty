import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentService } from "../src/agent/agent-service.mjs";
import { createVoiceSubagentService } from "../src/voice-subagents.mjs";
import { operationStore, sessionStore, status } from "./agent-service-fixtures.mjs";

const subjectId = "voice-owner";
const call = (tool, args, callId) => ({ method: "item/tool/call", params: {
  namespace: "voice_subagent", tool, threadId: "voice-thread", turnId: "voice-turn",
  callId, arguments: args,
} });
const resultOf = async (service, orchestratorId, request) => JSON.parse(
  (await service.handleTool(orchestratorId, request)).contentItems[0].text,
);
async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("state did not settle");
}

test("voice delegation tracks structured Runner identity, actions, restart, and orchestrator scope", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-subagents-test-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  let nextSession = 0;
  let nextRun = 0;
  const gates = new Map();
  const operations = operationStore();
  const sessions = sessionStore();
  const backend = {
    backendId: "test", getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, resolveSession, input, runId, sessionRef }) {
      const text = input.blocks[0].text;
      const sessionId = sessionRef?.nativeSessionId || `session-${++nextSession}`;
      if (!sessionRef) await resolveSession({ backendId: "test", nativeSessionId: sessionId });
      emit("turn.started", {});
      if (text === "first task") {
        emit("action.requested", { requestId: "approval-1", kind: "approval", decisions: ["allow", "deny"] });
        await new Promise((resolve) => gates.set(runId, resolve));
        emit("action.resolved", { requestId: "approval-1", outcome: "allowed" });
      }
      if (text !== "silent task") {
        emit("item.started", { itemId: `answer-${runId}`, itemType: "assistant" });
        emit("item.completed", { itemId: `answer-${runId}`, itemType: "assistant",
          content: [{ type: "text", text: `done: ${text}` }] });
      }
      return { outcome: "completed" };
    },
    async respondToAction({ runId }) { gates.get(runId)?.(); },
    listSessions: async () => ({ sessions: [] }), readHistory: async () => ({ items: [] }),
  };
  const agent = createAgentService({
    backends: [backend], operationStore: operations, sessionStore: sessions,
    workspaceAdmission: { assertAllowed: async (_owner, cwd) => cwd },
    resolveCanonicalCwd: async (cwd) => cwd,
    generateRunId: () => `run-${++nextRun}`,
  });
  const service = createVoiceSubagentService({ rootDir, getAgentService: () => agent, subjectId });
  const firstCall = call("delegate", { backendId: "test", cwd: "/workspace", request: "first task" }, "call-1");
  const [first, concurrentRetry, conflict] = await Promise.all([
    resultOf(service, "main", firstCall), resultOf(service, "main", firstCall),
    resultOf(service, "main", call("delegate",
      { backendId: "test", cwd: "/workspace", request: "changed task" }, "call-1")),
  ]);
  assert.equal(first.ok, true);
  assert.equal(first.runId, "run-1");
  assert.equal(concurrentRetry.runId, "run-1");
  assert.equal(conflict.ok, false);
  await waitFor(async () => (await service.refresh("main")).records[0]?.status === "awaiting_action");
  const active = await service.refresh("main");
  assert.equal(active.records[0].sessionId, "session-1");
  assert.deepEqual([active.runningCount, active.totalCount], [1, 1]);
  assert.equal(active.records[0].actions[0].requestId, "approval-1");
  assert.deepEqual((await service.refresh("other")).records, []);
  const afterRunnerRestart = createAgentService({ backends: [backend], operationStore: operations,
    sessionStore: sessions, workspaceAdmission: { assertAllowed: async (_owner, cwd) => cwd },
    resolveCanonicalCwd: async (cwd) => cwd });
  const afterVoiceRestart = createVoiceSubagentService({ rootDir,
    getAgentService: () => afterRunnerRestart, subjectId });
  assert.equal((await afterVoiceRestart.refresh("main")).records[0].status, "unknown");
  assert.equal((await resultOf(service, "main", call("delegate",
    { backendId: "test", cwd: "/workspace", request: "first task" }, "call-1"))).runId, "run-1");
  assert.equal(nextRun, 1);
  assert.equal((await resultOf(service, "main", call("respond",
    { runId: "run-1", requestId: "approval-1", decision: "allow" }, "call-2"))).ok, true);
  await waitFor(async () => (await service.refresh("main")).records[0]?.status === "completed");
  assert.equal((await service.refresh("main")).records[0].result, "done: first task");
  const followup = await resultOf(service, "main", call("delegate",
    { backendId: "test", sessionId: "session-1", request: "second task" }, "call-3"));
  assert.equal(followup.runId, "run-2");
  await waitFor(async () => (await service.refresh("main")).records[0]?.result === "done: second task");
  assert.deepEqual([(await service.refresh("main")).runningCount, (await service.refresh("main")).totalCount], [0, 1]);
  const oldRetry = await resultOf(service, "main", call("delegate",
    { backendId: "test", cwd: "/workspace", request: "first task" }, "call-1"));
  assert.equal(oldRetry.runId, "run-1");
  assert.equal((await service.refresh("main")).records[0].request, "second task");
  assert.equal((await service.refresh("main")).totalCount, 1);
  const silent = await resultOf(service, "other", call("delegate",
    { backendId: "test", cwd: "/workspace", request: "silent task" }, "call-4"));
  assert.equal(silent.runId, "run-3");
  await waitFor(async () => (await service.refresh("other")).records[0]?.status === "completed");
  assert.equal((await service.refresh("other")).records[0].sessionId, "session-2");
  assert.equal((await service.refresh("other")).records[0].result, "");
  const restarted = createVoiceSubagentService({ rootDir, getAgentService: () => agent, subjectId });
  assert.equal((await restarted.refresh("main")).records[0].sessionId, "session-1");
  assert.match(restarted.contextOf(await restarted.refresh("main")), /second task/);
  assert.equal((await restarted.refresh("other")).records[0].sessionId, "session-2");
});

test("an accepted child is interrupted when ownership cannot be persisted", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-subagents-failure-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const interrupted = [];
  const agent = {
    getStatuses: async () => [status()],
    startTurn: async () => ({ runId: "run-untracked", requestHash: "request-hash" }),
    interrupt: async (runId) => { interrupted.push(runId); },
  };
  const service = createVoiceSubagentService({ rootDir: path.join(root, "missing"),
    getAgentService: () => agent, subjectId });
  const result = await resultOf(service, "main", call("delegate",
    { backendId: "test", cwd: "/workspace", request: "task" }, "failed-store"));
  assert.equal(result.ok, false);
  assert.deepEqual(interrupted, ["run-untracked"]);
});
