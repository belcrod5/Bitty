import assert from "node:assert/strict";
import test from "node:test";

import { createAgentService } from "../src/agent/agent-service.mjs";

function operationStore() {
  const entries = new Map();
  return {
    async claim(subjectId, operationId, requestHash, runId) {
      const key = `${subjectId}:${operationId}`;
      const existing = entries.get(key);
      if (existing && existing.requestHash !== requestHash) return { status: "conflict" };
      if (existing) return { status: "existing", runId: existing.runId };
      entries.set(key, { requestHash, runId, result: null });
      return { status: "claimed", runId };
    },
    async complete(subjectId, operationId, result) {
      entries.get(`${subjectId}:${operationId}`).result = result;
    },
  };
}

function sessionStore() {
  const bindings = new Map();
  const modes = new Map();
  const key = (ref) => `${ref.backendId}:${ref.nativeSessionId}`;
  return {
    async bind(ref, canonicalCwd, mode) {
      const existingMode = modes.get(key(ref));
      if (existingMode && existingMode.mode !== mode) return { status: "mode_conflict", mode: existingMode.mode };
      bindings.set(key(ref), { ...ref, canonicalCwd });
      modes.set(key(ref), existingMode || { mode, lease: null, generation: 0 });
      return { status: "bound", mode };
    },
    async getBinding(ref) { return bindings.get(key(ref)) || null; },
    async getMode(ref) { return modes.get(key(ref)) || null; },
    async acquire({ sessionRef, mode, owner, runId }) {
      const entry = modes.get(key(sessionRef)) || { mode, lease: null, generation: 0 };
      if (entry.mode !== mode) return { status: "mode_conflict", mode: entry.mode };
      if (entry.lease) return { status: "busy", lease: entry.lease };
      entry.generation += 1;
      entry.lease = { generation: entry.generation, owner, runId };
      modes.set(key(sessionRef), entry);
      return { status: "acquired", lease: entry.lease };
    },
    async settle(ref, generation, state) {
      const entry = modes.get(key(ref));
      if (!entry?.lease || entry.lease.generation !== generation) return { status: "stale" };
      if (state === "released") entry.lease = null;
      else entry.lease = { ...entry.lease, state: "recovering" };
      return { status: state };
    },
    async updateIdentity(ref, generation, nativeProcessIdentity) {
      const entry = modes.get(key(ref));
      if (!entry?.lease || entry.lease.generation !== generation) return { status: "stale" };
      entry.lease = { ...entry.lease, nativeProcessIdentity };
      return { status: "updated" };
    },
    async handoff(ref, mode) {
      const entry = modes.get(key(ref)) || { lease: null, generation: 0 };
      if (entry.lease) return { status: "busy", mode: entry.mode, lease: entry.lease };
      entry.mode = mode;
      modes.set(key(ref), entry);
      return { status: "changed", mode };
    },
  };
}

function status() {
  return {
    backendId: "test",
    available: true,
    readiness: { ready: true },
    capabilities: {
      action: {
        policyProfiles: [{ id: "ask", label: "Ask", interactive: true, decisions: ["allow", "deny"] }],
      },
    },
  };
}

function startRequest(overrides = {}) {
  return {
    backendId: "test",
    cwd: "/workspace",
    input: { blocks: [{ type: "text", text: "hello" }] },
    clientOperationId: "operation-1",
    ...overrides,
  };
}

test("emits one ordered lifecycle and resolves completion to the terminal payload", async () => {
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, resolveSession }) {
      await resolveSession({ backendId: "test", nativeSessionId: "session-1" });
      emit("turn.started", {});
      emit("item.started", { itemId: "item-1", itemType: "assistant" });
      emit("content.delta", { itemId: "item-1", contentIndex: 0, delta: "hello" });
      emit("item.completed", { itemId: "item-1", revision: 1 });
      return { outcome: "completed" };
    },
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    generateRunId: () => "run-1",
    now: () => "2026-08-21T00:00:00.000Z",
  });

  const run = await service.startTurn(startRequest(), { subjectId: "user-1" });
  const events = [];
  for await (const event of run.events) events.push(event);
  const result = await run.completion;

  assert.deepEqual(events.map((event) => event.type), [
    "turn.accepted",
    "session.resolved",
    "turn.started",
    "item.started",
    "content.delta",
    "item.completed",
    "turn.completed",
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(events.at(-1).payload, result);
  assert.deepEqual(result, {
    runId: "run-1",
    sessionRef: { backendId: "test", nativeSessionId: "session-1" },
    outcome: "completed",
  });
  assert.throws(
    () => service.subscribe(run.runId, { afterSequence: Number.NaN, onEvent() {} }),
    (error) => error.code === "turn_rejected",
  );
});

test("deduplicates a client operation and rejects conflicting reuse", async () => {
  let starts = 0;
  let release;
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, resolveSession }) {
      starts += 1;
      await resolveSession({ backendId: "test", nativeSessionId: "session-1" });
      emit("turn.started", {});
      await new Promise((resolve) => { release = resolve; });
      return { outcome: "completed" };
    },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    generateRunId: () => "run-1",
  });

  const first = await service.startTurn(startRequest(), { subjectId: "user-1" });
  const duplicate = await service.startTurn(startRequest(), { subjectId: "user-1" });
  assert.equal(duplicate.runId, first.runId);
  assert.equal(starts, 1);
  await assert.rejects(
    service.startTurn(startRequest({ input: { blocks: [{ type: "text", text: "different" }] } }), { subjectId: "user-1" }),
    (error) => error.code === "operation_conflict",
  );
  release();
  await first.completion;
});

test("linearizes interrupt before a later backend success", async () => {
  let release;
  let interrupted = false;
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, resolveSession }) {
      await resolveSession({ backendId: "test", nativeSessionId: "session-1" });
      emit("turn.started", {});
      await new Promise((resolve) => { release = resolve; });
      return { outcome: "completed" };
    },
    async interrupt() {
      interrupted = true;
      release();
    },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    generateRunId: () => "run-1",
  });
  const run = await service.startTurn(startRequest(), { subjectId: "user-1" });
  await new Promise((resolve) => setImmediate(resolve));
  await service.interrupt(run.runId);
  const result = await run.completion;
  assert.equal(interrupted, true);
  assert.equal(result.outcome, "interrupted");
});

test("serializes admission so concurrent operations cannot start the same native session", async () => {
  let starts = 0;
  let release;
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit }) {
      starts += 1;
      emit("turn.started", {});
      await new Promise((resolve) => { release = resolve; });
      return { outcome: "completed" };
    },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    generateRunId: (() => {
      let id = 0;
      return () => `run-${++id}`;
    })(),
  });
  const sessionRef = { backendId: "test", nativeSessionId: "session-1" };
  const firstPromise = service.startTurn(startRequest({ sessionRef, cwd: "", clientOperationId: "operation-1" }), {
    subjectId: "user-1",
  });
  const secondPromise = service.startTurn(startRequest({ sessionRef, cwd: "", clientOperationId: "operation-2" }), {
    subjectId: "user-1",
  });
  const first = await firstPromise;
  await assert.rejects(secondPromise, (error) => error.code === "session_busy");
  assert.equal(starts, 1);
  release();
  await first.completion;
});

test("resolves active actions before the terminal event", async () => {
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, resolveSession }) {
      await resolveSession({ backendId: "test", nativeSessionId: "session-1" });
      emit("turn.started", {});
      emit("action.requested", { requestId: "approval-1", kind: "approval", decisions: ["allow", "deny"] });
      return { outcome: "completed" };
    },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    generateRunId: () => "run-1",
  });
  const run = await service.startTurn(startRequest(), { subjectId: "user-1" });
  const types = [];
  for await (const event of run.events) types.push(event.type);
  assert.deepEqual(types.slice(-3), ["action.requested", "action.resolved", "turn.completed"]);
});

test("recovers an old-process lease before admitting a resumed turn", async () => {
  const sessions = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-recovery" };
  await sessions.bind(sessionRef, "/workspace", "neutral");
  const acquired = await sessions.acquire({ sessionRef, mode: "neutral", owner: "old", runId: "old-run" });
  await sessions.settle(sessionRef, acquired.lease.generation, "recovering");
  let recoveryCount = 0;
  const backend = {
    backendId: "test",
    defaultDiscoveredSessionMode: "neutral",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    recoverSession: async ({ lease }) => {
      recoveryCount += 1;
      assert.equal(lease.state, "recovering");
      return { nativeActivity: "stopped" };
    },
    async startTurn({ emit }) {
      emit("turn.started", { nativeTurnId: "turn-recovered" });
      return { outcome: "completed" };
    },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd,
  });
  const run = await service.startTurn(startRequest({
    sessionRef,
    cwd: "/workspace",
    clientOperationId: "recover-operation",
  }), { subjectId: "subject" });
  assert.equal((await run.completion).outcome, "completed");
  assert.equal(recoveryCount, 1);
  assert.equal((await sessions.getMode(sessionRef)).lease, null);
});

test("canonicalizes a discovered session cwd before binding it", async () => {
  const sessions = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-discovered" };
  const backend = {
    backendId: "test",
    defaultDiscoveredSessionMode: "neutral",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace-link",
    async startTurn({ emit }) {
      emit("turn.started", {});
      return { outcome: "completed" };
    },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd === "/workspace-link" ? "/workspace-real" : cwd,
  });

  const run = await service.startTurn(startRequest({
    sessionRef,
    cwd: "",
    clientOperationId: "discover-operation",
  }), { subjectId: "subject" });

  assert.equal((await run.completion).outcome, "completed");
  assert.equal((await sessions.getBinding(sessionRef)).canonicalCwd, "/workspace-real");
});

test("compact uses the Backend operation under the neutral session lease", async () => {
  const sessions = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-1" };
  await sessions.bind(sessionRef, "/workspace", "neutral");
  let compactCalls = 0;
  const backend = {
    backendId: "test",
    getStatus: async () => ({
      ...status(),
      capabilities: { ...status().capabilities, operations: { compact: true } },
    }),
    resolveSessionCwd: async () => "/workspace",
    async compactSession({ sessionRef: received }) {
      compactCalls += 1;
      return { sessionRef: received, method: "thread/compact/start", accepted: true };
    },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd,
  });

  const result = await service.compactSession({ sessionRef });
  assert.equal(compactCalls, 1);
  assert.equal(result.accepted, true);
  assert.equal((await sessions.getMode(sessionRef)).lease, null);
});
