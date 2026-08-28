import assert from "node:assert/strict";
import test from "node:test";

import { createAgentService } from "../src/agent/agent-service.mjs";

function operationStore() {
  const entries = new Map();
  return {
    async inspect(subjectId, operationId, requestHash) {
      const existing = entries.get(`${subjectId}:${operationId}`);
      if (!existing) return { status: "missing" };
      if (existing.requestHash !== requestHash) return { status: "conflict" };
      return { status: "existing", runId: existing.runId, result: existing.result };
    },
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
  const directoryLastReadAt = new Map();
  const key = (ref) => `${ref.backendId}:${ref.nativeSessionId}`;
  return {
    async bind(ref, canonicalCwd, mode, options = {}) {
      const existingMode = modes.get(key(ref));
      if (existingMode && existingMode.mode !== mode) return { status: "mode_conflict", mode: existingMode.mode };
      const existingBinding = bindings.get(key(ref));
      if (existingBinding && existingBinding.canonicalCwd !== canonicalCwd && options.reconcileCwd !== true) {
        return { status: "cwd_conflict", binding: existingBinding };
      }
      const binding = { ...(existingBinding || ref), canonicalCwd };
      if (Object.hasOwn(options, "settings")) {
        if (options.settings?.modelId) binding.modelId = options.settings.modelId;
        else delete binding.modelId;
        if (options.settings?.reasoningEffort) binding.reasoningEffort = options.settings.reasoningEffort;
        else delete binding.reasoningEffort;
      }
      bindings.set(key(ref), binding);
      modes.set(key(ref), existingMode || { mode, lease: null, generation: 0 });
      return { status: "bound", mode };
    },
    async getBinding(ref) { return bindings.get(key(ref)) || null; },
    async getReadState(_ref, cwd) {
      const lastReadAt = directoryLastReadAt.get(cwd);
      return lastReadAt ? { lastReadAt, revision: 1 } : null;
    },
    async getMode(ref) { return modes.get(key(ref)) || null; },
    async acquire({ sessionRef, mode, owner, runId }) {
      const entry = modes.get(key(sessionRef)) || { mode, lease: null, generation: 0 };
      if (entry.mode !== mode) return { status: "mode_conflict", mode: entry.mode };
      if (entry.lease) return { status: "busy", lease: entry.lease };
      entry.generation += 1;
      entry.lease = { generation: entry.generation, owner, runId, state: "active" };
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
    async handoff(ref, mode, options = {}) {
      const entry = modes.get(key(ref)) || { lease: null, generation: 0 };
      // 実storeと同じ: 同一モードへのhandoffはlease保持中でもno-op成功
      if (entry.mode === mode) {
        if (options.clearSettings) {
          const binding = bindings.get(key(ref));
          if (binding) {
            delete binding.modelId;
            delete binding.reasoningEffort;
          }
        }
        return { status: "unchanged", mode };
      }
      if (entry.lease) return { status: "busy", mode: entry.mode, lease: entry.lease };
      entry.mode = mode;
      modes.set(key(ref), entry);
      if (options.clearSettings) {
        const binding = bindings.get(key(ref));
        if (binding) {
          delete binding.modelId;
          delete binding.reasoningEffort;
        }
      }
      return { status: "changed", mode };
    },
    async setSettings(ref, settings = {}) {
      const binding = bindings.get(key(ref));
      if (!binding) return { status: "missing" };
      if (settings.modelId) binding.modelId = settings.modelId;
      else delete binding.modelId;
      if (settings.reasoningEffort) binding.reasoningEffort = settings.reasoningEffort;
      else delete binding.reasoningEffort;
      return { status: "updated" };
    },
    async recordActivity(ref, canonicalCwd) {
      const binding = bindings.get(key(ref));
      if (!binding || binding.canonicalCwd !== canonicalCwd) return { status: "missing" };
      return { status: "updated" };
    },
    setDirectoryLastReadAt(cwd, lastReadAt) { directoryLastReadAt.set(cwd, lastReadAt); },
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
  const activityCalls = [];
  const store = sessionStore();
  store.recordActivity = async (...args) => {
    activityCalls.push(args);
    return { status: "updated" };
  };
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
    sessionStore: store,
    resolveCanonicalCwd: async (cwd) => cwd,
    generateRunId: () => "run-1",
    now: () => "2026-08-21T00:00:00.000Z",
    onRunEvent: (event) => {
      if (event.type === "turn.completed") assert.equal(activityCalls.length, 1);
    },
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
  assert.deepEqual(activityCalls, [[
    { backendId: "test", nativeSessionId: "session-1" },
    "/workspace",
    "2026-08-21T00:00:00.000Z",
  ]]);
  assert.throws(
    () => service.subscribe(run.runId, { afterSequence: Number.NaN, onEvent() {} }, { subjectId: "user-1" }),
    (error) => error.code === "turn_rejected",
  );
});

test("does not record Agent activity for interrupted or failed turns", async () => {
  const activityCalls = [];
  const store = sessionStore();
  store.recordActivity = async (...args) => {
    activityCalls.push(args);
    return { status: "updated" };
  };
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, input, resolveSession }) {
      await resolveSession({ backendId: "test", nativeSessionId: input.blocks[0].text });
      emit("turn.started", {});
      if (input.blocks[0].text === "failed") throw new Error("failed");
      return { outcome: "interrupted" };
    },
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: store,
    resolveCanonicalCwd: async (cwd) => cwd,
  });

  const interrupted = await service.startTurn(startRequest({
    input: { blocks: [{ type: "text", text: "interrupted" }] },
    clientOperationId: "interrupted-operation",
  }), { subjectId: "user-1" });
  const failed = await service.startTurn(startRequest({
    input: { blocks: [{ type: "text", text: "failed" }] },
    clientOperationId: "failed-operation",
  }), { subjectId: "user-1" });

  assert.equal((await interrupted.completion).outcome, "interrupted");
  assert.equal((await failed.completion).outcome, "failed");
  assert.deepEqual(activityCalls, []);
});

for (const { existing, terminal } of [
  { existing: true, terminal: "interrupted" },
  { existing: true, terminal: "failed" },
  { existing: false, terminal: "interrupted" },
  { existing: false, terminal: "failed" },
]) {
  test(`${existing ? "resumed" : "new"} ${terminal} turn exposes settings before completion`, async () => {
    const store = sessionStore();
    const sessionRef = { backendId: "test", nativeSessionId: existing ? "existing-session" : "new-session" };
    if (existing) await store.bind(sessionRef, "/workspace", "neutral");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let settingsStored;
    const stored = new Promise((resolve) => { settingsStored = resolve; });
    if (existing) {
      const setSettings = store.setSettings;
      store.setSettings = async (...args) => {
        const result = await setSettings(...args);
        settingsStored();
        return result;
      };
    } else {
      const bind = store.bind;
      store.bind = async (...args) => {
        const result = await bind(...args);
        if (Object.hasOwn(args[3] || {}, "settings")) settingsStored();
        return result;
      };
    }
    const backend = {
      backendId: "test",
      defaultDiscoveredSessionMode: "neutral",
      getStatus: async () => ({
        ...status(),
        capabilities: {
          session: { list: true, history: { read: true } },
          model: { select: true, effort: true, effortOptions: ["low", "high"] },
        },
      }),
      resolveSessionCwd: async () => "/workspace",
      listSessions: async () => ({
        sessions: [{ sessionRef, modelId: "native-old", reasoningEffort: "low" }],
      }),
      readHistory: async () => ({ items: [], modelId: "native-old", reasoningEffort: "low" }),
      async startTurn({ emit, resolveSession }) {
        if (!existing) await resolveSession(sessionRef);
        emit("turn.started", {});
        await gate;
        if (terminal === "failed") {
          const error = new Error("native failed");
          error.nativeActivity = "stopped";
          throw error;
        }
        return { outcome: "interrupted" };
      },
    };
    const service = createAgentService({
      backends: [backend],
      operationStore: operationStore(),
      sessionStore: store,
      resolveCanonicalCwd: async (cwd) => cwd,
    });
    const run = await service.startTurn(startRequest({
      ...(existing ? { sessionRef } : {}),
      model: "selected-model",
      effort: "high",
    }), { subjectId: "user-1" });
    await stored;

    assert.deepEqual(await service.listSessions({ backendId: "test", cwd: "/workspace" }), {
      sessions: [{ sessionRef, modelId: "selected-model", reasoningEffort: "high" }],
    });
    assert.deepEqual(await service.readHistory({ sessionRef }), {
      items: [],
      modelId: "selected-model",
      reasoningEffort: "high",
      sessionRef,
      canonicalCwd: "/workspace",
      activeRun: null,
    });
    release();
    assert.equal((await run.completion).outcome, terminal);
    assert.equal((await store.getBinding(sessionRef)).reasoningEffort, "high");
  });
}

for (const existing of [true, false]) {
  test(`${existing ? "resumed" : "new"} turn fails before native start when settings persistence fails`, async () => {
    const store = sessionStore();
    const sessionRef = { backendId: "test", nativeSessionId: existing ? "existing-session" : "new-session" };
    if (existing) await store.bind(sessionRef, "/workspace", "neutral");
    let restorePersistence;
    if (existing) {
      const setSettings = store.setSettings;
      store.setSettings = async () => { throw new Error("settings disk write failed"); };
      restorePersistence = () => { store.setSettings = setSettings; };
    } else {
      const bind = store.bind;
      store.bind = async (...args) => {
        if (Object.hasOwn(args[3] || {}, "settings")) throw new Error("settings disk write failed");
        return await bind(...args);
      };
      restorePersistence = () => { store.bind = bind; };
    }
    let nativeStarts = 0;
    const backend = {
      backendId: "test",
      defaultDiscoveredSessionMode: "neutral",
      getStatus: async () => ({
        ...status(),
        capabilities: { model: { select: true, effort: true, effortOptions: ["high"] } },
      }),
      resolveSessionCwd: async () => "/workspace",
      async startTurn({ emit, resolveSession }) {
        if (!existing) await resolveSession(sessionRef);
        nativeStarts += 1;
        emit("turn.started", {});
        return { outcome: "completed" };
      },
    };
    const service = createAgentService({
      backends: [backend],
      operationStore: operationStore(),
      sessionStore: store,
      resolveCanonicalCwd: async (cwd) => cwd,
    });
    const run = await service.startTurn(startRequest({
      ...(existing ? { sessionRef } : {}),
      model: "selected-model",
      effort: "high",
    }), { subjectId: "user-1" });
    const result = await run.completion;
    assert.equal(result.outcome, "failed");
    assert.match(result.error.message, /settings disk write failed/);
    assert.equal(nativeStarts, 0);
    if (existing) {
      assert.equal((await store.getMode(sessionRef)).lease, null);
    } else {
      assert.equal(result.sessionRef, undefined);
      assert.equal(await store.getBinding(sessionRef), null);
      assert.equal(await store.getMode(sessionRef), null);
    }
    restorePersistence();
    const retry = await service.startTurn(startRequest({
      ...(existing ? { sessionRef } : {}),
      model: "selected-model",
      effort: "high",
      clientOperationId: "retry-operation",
    }), { subjectId: "user-1" });
    const retryResult = await retry.completion;
    assert.equal(retryResult.outcome, "completed");
    assert.deepEqual(retryResult.sessionRef, sessionRef);
    assert.equal((await store.getBinding(sessionRef)).reasoningEffort, "high");
    assert.equal(nativeStarts, 1);
  });
}

test("accepts a turn during an active compact and executes it after the lease is released", async () => {
  const store = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-1" };
  let releaseCompact;
  const compactGate = new Promise((resolve) => { releaseCompact = resolve; });
  let releaseFirstTurn;
  const firstTurnGate = new Promise((resolve) => { releaseFirstTurn = resolve; });
  const startedInputs = [];
  const backend = {
    backendId: "test",
    getStatus: async () => ({
      ...status(),
      capabilities: {
        ...status().capabilities,
        operations: { compact: true },
        session: { history: { read: true } },
        model: { select: true, effort: true, effortOptions: ["high"] },
      },
    }),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, input }) {
      const text = input.blocks[0].text;
      startedInputs.push(text);
      emit("turn.started", {});
      if (text === "first") await firstTurnGate;
      emit("item.started", { itemId: "item-1", itemType: "assistant" });
      emit("item.completed", { itemId: "item-1", revision: 1 });
      return { outcome: "completed" };
    },
    async compactSession() {
      await compactGate;
      return { sessionRef, accepted: true };
    },
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: store,
    resolveCanonicalCwd: async (cwd) => cwd,
    compactLeasePollMs: 10,
    compactWaitTimeoutMs: 2000,
    now: () => "2026-08-22T00:00:00.000Z",
  });
  await store.bind(sessionRef, "/workspace", "neutral");

  const compactPromise = service.compactSession({ sessionRef });
  // compactがleaseを取るまで待つ
  while (!(await store.getMode(sessionRef))?.lease) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // compact中の複数送信はsession_busyにならずFIFOで受理される
  const requests = ["first", "second", "third"].map((text, index) => startRequest({
    sessionRef,
    cwd: "",
    input: { blocks: [{ type: "text", text }] },
    model: `${text}-model`,
    effort: "high",
    clientOperationId: `operation-${index + 1}`,
  }));
  const runs = await Promise.all(requests.map((request) => service.startTurn(request, { subjectId: "user-1" })));
  assert.deepEqual(runs.map((run) => run.queued), [true, true, true]);
  const replayedFirst = await service.startTurn(requests[0], { subjectId: "user-1" });
  assert.equal(replayedFirst.runId, runs[0].runId);
  assert.equal(replayedFirst.queued, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(startedInputs, []);
  assert.equal((await store.getBinding(sessionRef)).modelId, "third-model");

  releaseCompact();
  await compactPromise;
  while (startedInputs.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await store.getBinding(sessionRef)).modelId, "first-model");
  try {
    const replayedSecond = await service.startTurn(requests[1], { subjectId: "user-1" });
    assert.equal(replayedSecond.runId, runs[1].runId);
    assert.equal(replayedSecond.queued, true);
  } finally {
    releaseFirstTurn();
  }
  const results = await Promise.all(runs.map((run) => run.completion));
  assert.deepEqual(results.map((result) => result.outcome), ["completed", "completed", "completed"]);
  assert.deepEqual(startedInputs, ["first", "second", "third"]);
  assert.equal((await store.getBinding(sessionRef)).modelId, "third-model");
  // turn終了後はleaseが解放されている
  assert.equal((await store.getMode(sessionRef))?.lease, null);
});

test("interrupting a turn that waits for compaction settles it as interrupted", async () => {
  const store = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-1" };
  let releaseCompact;
  const compactGate = new Promise((resolve) => { releaseCompact = resolve; });
  const startedInputs = [];
  const backend = {
    backendId: "test",
    getStatus: async () => ({
      ...status(),
      capabilities: {
        ...status().capabilities,
        operations: { compact: true },
        session: { history: { read: true } },
      },
    }),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, input }) {
      startedInputs.push(input.blocks[0].text);
      emit("turn.started", {});
      return { outcome: "completed" };
    },
    async compactSession() {
      await compactGate;
      return { sessionRef, accepted: true };
    },
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: store,
    resolveCanonicalCwd: async (cwd) => cwd,
    compactLeasePollMs: 10,
    compactWaitTimeoutMs: 2000,
    now: () => "2026-08-22T00:00:00.000Z",
  });
  await store.bind(sessionRef, "/workspace", "neutral");

  const compactPromise = service.compactSession({ sessionRef });
  while (!(await store.getMode(sessionRef))?.lease) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const [run, nextRun] = await Promise.all([
    service.startTurn(startRequest({ sessionRef, cwd: "", input: { blocks: [{ type: "text", text: "first" }] } }), { subjectId: "user-1" }),
    service.startTurn(startRequest({
      sessionRef,
      cwd: "",
      input: { blocks: [{ type: "text", text: "second" }] },
      clientOperationId: "operation-2",
    }), { subjectId: "user-1" }),
  ]);
  const reopened = await service.readHistory({ sessionRef }, { subjectId: "user-1" });
  assert.equal(reopened.activeRun.runId, run.runId);
  assert.equal(reopened.activeRun.state, "queued");
  assert.equal((await service.readHistory({ sessionRef }, { subjectId: "other" })).activeRun, null);
  await service.interrupt(run.runId, { subjectId: "user-1" });
  const result = await run.completion;
  assert.equal(result.outcome, "interrupted");
  assert.deepEqual(startedInputs, []);

  releaseCompact();
  await compactPromise;
  assert.equal((await nextRun.completion).outcome, "completed");
  assert.deepEqual(startedInputs, ["second"]);
});

test("a failed queued head releases the FIFO for the next turn", async () => {
  const store = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-1" };
  let releaseCompact;
  const compactGate = new Promise((resolve) => { releaseCompact = resolve; });
  const startedInputs = [];
  const backend = {
    backendId: "test",
    getStatus: async () => ({
      ...status(),
      capabilities: { ...status().capabilities, operations: { compact: true } },
    }),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, input }) {
      const text = input.blocks[0].text;
      startedInputs.push(text);
      if (text === "first") {
        const error = new Error("failed before native start");
        error.nativeActivity = "not_started";
        throw error;
      }
      emit("turn.started", {});
      return { outcome: "completed" };
    },
    async compactSession() {
      await compactGate;
      return { sessionRef, accepted: true };
    },
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: store,
    resolveCanonicalCwd: async (cwd) => cwd,
    compactLeasePollMs: 10,
    compactWaitTimeoutMs: 2000,
    now: () => "2026-08-22T00:00:00.000Z",
  });
  await store.bind(sessionRef, "/workspace", "neutral");

  const compactPromise = service.compactSession({ sessionRef });
  while (!(await store.getMode(sessionRef))?.lease) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const runs = await Promise.all(["first", "second"].map((text, index) => service.startTurn(startRequest({
    sessionRef,
    cwd: "",
    input: { blocks: [{ type: "text", text }] },
    clientOperationId: `operation-${index + 1}`,
  }), { subjectId: "user-1" })));

  releaseCompact();
  await compactPromise;
  const results = await Promise.all(runs.map((run) => run.completion));
  assert.deepEqual(results.map((result) => result.outcome), ["failed", "completed"]);
  assert.deepEqual(startedInputs, ["first", "second"]);
});

test("fails a queued turn with timeout when compaction never releases the lease", async () => {
  const store = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-1" };
  let releaseCompact;
  const compactGate = new Promise((resolve) => { releaseCompact = resolve; });
  const backend = {
    backendId: "test",
    getStatus: async () => ({
      ...status(),
      capabilities: { ...status().capabilities, operations: { compact: true } },
    }),
    resolveSessionCwd: async () => "/workspace",
    async startTurn() { return { outcome: "completed" }; },
    async compactSession() {
      await compactGate;
      return { sessionRef, accepted: true };
    },
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: store,
    resolveCanonicalCwd: async (cwd) => cwd,
    compactLeasePollMs: 10,
    compactWaitTimeoutMs: 50,
    now: () => "2026-08-22T00:00:00.000Z",
  });
  await store.bind(sessionRef, "/workspace", "neutral");

  const compactPromise = service.compactSession({ sessionRef });
  while (!(await store.getMode(sessionRef))?.lease) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const run = await service.startTurn(startRequest({ sessionRef, cwd: "" }), { subjectId: "user-1" });
  const result = await run.completion;
  assert.equal(result.outcome, "failed");
  assert.equal(result.error.code, "timeout");

  releaseCompact();
  await compactPromise;
});

test("fails a queued turn with session_busy when a non-compact holder takes the lease", async () => {
  const store = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-1" };
  let releaseCompact;
  const compactGate = new Promise((resolve) => { releaseCompact = resolve; });
  const backend = {
    backendId: "test",
    getStatus: async () => ({
      ...status(),
      capabilities: { ...status().capabilities, operations: { compact: true } },
    }),
    resolveSessionCwd: async () => "/workspace",
    async startTurn() { return { outcome: "completed" }; },
    async compactSession() {
      await compactGate;
      return { sessionRef, accepted: true };
    },
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: store,
    resolveCanonicalCwd: async (cwd) => cwd,
    compactLeasePollMs: 10,
    compactWaitTimeoutMs: 2000,
    now: () => "2026-08-22T00:00:00.000Z",
  });
  await store.bind(sessionRef, "/workspace", "neutral");

  const compactPromise = service.compactSession({ sessionRef });
  while (!(await store.getMode(sessionRef))?.lease) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const run = await service.startTurn(startRequest({ sessionRef, cwd: "" }), { subjectId: "user-1" });
  // compact leaseがcompact以外の保持者(通常run)に置き換わったら待機を打ち切る
  const mode = await store.getMode(sessionRef);
  mode.generation += 1;
  mode.lease = { generation: mode.generation, owner: "agent-service", runId: "agent_run_other", state: "active" };
  const result = await run.completion;
  assert.equal(result.outcome, "failed");
  assert.equal(result.error.code, "session_busy");

  releaseCompact();
  await compactPromise;
});

function listBackend(backendId, { sessions, listError, listSupported = true } = {}) {
  return {
    backendId,
    getStatus: async () => ({
      backendId,
      available: true,
      readiness: { ready: true },
      capabilities: { session: { list: listSupported } },
    }),
    resolveSessionCwd: async () => "/workspace",
    startTurn: async () => ({ outcome: "completed" }),
    listSessions: async () => {
      if (listError) throw listError;
      return { sessions };
    },
    readHistory: async () => ({ items: [] }),
  };
}

test("all-backends session list merges every listing backend by updatedAt and keeps partial failures diagnosable", async () => {
  const codexRef = { backendId: "codex", nativeSessionId: "codex-1" };
  const claudeRef = { backendId: "claude", nativeSessionId: "claude-1" };
  const codexSessions = [{ sessionRef: codexRef, updatedAt: "2026-08-22T02:00:00.000Z" }];
  const claudeSessions = [
    { sessionRef: claudeRef, updatedAt: "2026-08-22T03:00:00.000Z" },
    { sessionRef: { backendId: "claude", nativeSessionId: "claude-2" }, updatedAt: "2026-08-22T01:00:00.000Z" },
  ];
  const sessions = sessionStore();
  await sessions.bind(codexRef, "/workspace", "neutral");
  await sessions.bind(claudeRef, "/workspace", "neutral");
  (await sessions.getBinding(codexRef)).lastReadAt = "2026-08-22T04:00:00.000Z";
  (await sessions.getBinding(claudeRef)).lastReadAt = "2026-08-22T05:00:00.000Z";
  const service = createAgentService({
    backends: [
      listBackend("codex", { sessions: codexSessions }),
      listBackend("claude", { sessions: claudeSessions }),
      listBackend("nolist", { sessions: [], listSupported: false }),
    ],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd,
  });
  const merged = await service.listSessions({ cwd: "/workspace" });
  assert.deepEqual(
    merged.sessions.map((session) => [session.sessionRef.nativeSessionId, session.lastReadAt]),
    [["claude-1", "2026-08-22T05:00:00.000Z"], ["codex-1", "2026-08-22T04:00:00.000Z"], ["claude-2", undefined]]);
  assert.equal(merged.errors, undefined);

  const scoped = await service.listSessions({ backendId: "codex", cwd: "/workspace" });
  assert.equal(scoped.sessions[0].lastReadAt, "2026-08-22T04:00:00.000Z");

  const failure = Object.assign(new Error("claude transcript scan failed"), { code: "history_unavailable" });
  const partialService = createAgentService({
    backends: [
      listBackend("codex", { sessions: codexSessions }),
      listBackend("claude", { listError: failure }),
    ],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
  });
  const partial = await partialService.listSessions({ backendId: "all", cwd: "/workspace" });
  assert.deepEqual(partial.sessions.map((session) => session.sessionRef.nativeSessionId), ["codex-1"]);
  assert.deepEqual(partial.errors, [{
    code: "history_unavailable",
    backendId: "claude",
    retryable: false,
    message: "claude transcript scan failed",
  }]);

  const allFailedService = createAgentService({
    backends: [listBackend("claude", { listError: failure })],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
  });
  await assert.rejects(
    allFailedService.listSessions({ cwd: "/workspace" }),
    (error) => /transcript scan failed/.test(error.message),
  );

  await assert.rejects(
    service.listSessions({ cwd: "/workspace", cursor: "not-a-composite-cursor" }),
    (error) => error.code === "turn_rejected" && /cursor is invalid/.test(error.message),
  );
});

test("session list prefers revisioned read state over legacy session timestamps", async () => {
  const explicitRef = { backendId: "claude", nativeSessionId: "explicit" };
  const nativeRef = { backendId: "claude", nativeSessionId: "native" };
  const unboundRef = { backendId: "claude", nativeSessionId: "unbound" };
  const sessions = sessionStore();
  await sessions.bind(explicitRef, "/workspace", "neutral");
  (await sessions.getBinding(explicitRef)).lastReadAt = new Date(0).toISOString();
  sessions.setDirectoryLastReadAt("/workspace", "2026-08-25T01:00:00.000Z");
  const service = createAgentService({
    backends: [listBackend("claude", { sessions: [
      { sessionRef: explicitRef, updatedAt: "2026-08-25T02:00:00.000Z" },
      { sessionRef: nativeRef, updatedAt: "2026-08-25T02:00:00.000Z", lastReadAt: "2026-08-25T00:30:00.000Z" },
      { sessionRef: unboundRef, updatedAt: "2026-08-25T00:30:00.000Z" },
    ] })],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd,
  });

  const listed = await service.listSessions({ backendId: "claude", cwd: "/workspace" });
  assert.deepEqual(listed.sessions.map((session) => session.lastReadAt), [
    "2026-08-25T01:00:00.000Z",
    "2026-08-25T01:00:00.000Z",
    "2026-08-25T01:00:00.000Z",
  ]);
});

test("session state adopts the newer of binding activity and native updatedAt", async () => {
  const boundRef = { backendId: "claude", nativeSessionId: "bound" };
  const staleRef = { backendId: "claude", nativeSessionId: "stale-binding" };
  const sessions = sessionStore();
  await sessions.bind(boundRef, "/workspace", "neutral");
  await sessions.bind(staleRef, "/workspace", "neutral");
  // ターン完了時のrecordActivity相当。native側(rollout mtime由来)より新しい。
  (await sessions.getBinding(boundRef)).updatedAt = "2026-08-27T10:00:00.000Z";
  // 逆にnative側の方が新しいケース(binding記録後にrolloutが更新された)。
  (await sessions.getBinding(staleRef)).updatedAt = "2026-08-27T01:00:00.000Z";
  const service = createAgentService({
    backends: [listBackend("claude", { sessions: [
      { sessionRef: boundRef, updatedAt: "2026-08-27T09:00:00.000Z" },
      { sessionRef: staleRef, updatedAt: "2026-08-27T02:00:00.000Z" },
      { sessionRef: { backendId: "claude", nativeSessionId: "unbound" }, updatedAt: "2026-08-27T03:00:00.000Z" },
    ] })],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd,
  });

  const listed = await service.listSessions({ backendId: "claude", cwd: "/workspace" });
  assert.deepEqual(
    Object.fromEntries(listed.sessions.map((session) => [session.sessionRef.nativeSessionId, session.updatedAt])),
    {
      bound: "2026-08-27T10:00:00.000Z",
      "stale-binding": "2026-08-27T02:00:00.000Z",
      unbound: "2026-08-27T03:00:00.000Z",
    },
  );
});

test("all-scope snapshot tolerates one backend failure and fails only when all fail", async () => {
  const warnings = [];
  let codexFails = false;
  let claudeFails = true;
  const codex = listBackend("codex", { sessions: [] });
  const claude = listBackend("claude", { sessions: [] });
  codex.listSessionsForDirectories = async ({ cwds }) => {
    if (codexFails) throw new Error("codex listing failed");
    return { groups: cwds.map((cwd) => ({ cwd, sessions: [
      { sessionRef: { backendId: "codex", nativeSessionId: "codex-session" }, canonicalCwd: cwd },
    ] })) };
  };
  claude.listSessionsForDirectories = async ({ cwds }) => {
    if (claudeFails) throw new Error("claude listing failed");
    return { groups: cwds.map((cwd) => ({ cwd, sessions: [
      { sessionRef: { backendId: "claude", nativeSessionId: "claude-session" }, canonicalCwd: cwd },
    ] })) };
  };
  const service = createAgentService({
    backends: [codex, claude],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    log: { warn: (message) => warnings.push(String(message)) },
  });

  const snapshot = await service.listSessionSnapshot({ cwds: ["/workspace"] });
  assert.deepEqual(
    snapshot.groups[0].sessions.map((session) => session.sessionRef.backendId),
    ["codex"],
  );
  // 部分失敗の印: 消費側(Skiaボードingest)がウォーターマーク前進を
  // 見送れるよう、欠けているBackendを明示する。
  assert.equal(snapshot.partial, true);
  assert.deepEqual(snapshot.failedBackendIds, ["claude"]);
  assert.match(warnings.join("\n"), /session snapshot skipped backend=claude: claude listing failed/);

  // 全Backend成功時はpartialの印が付かない。
  claudeFails = false;
  const fullSnapshot = await service.listSessionSnapshot({ cwds: ["/workspace"] });
  assert.equal("partial" in fullSnapshot, false);
  assert.equal("failedBackendIds" in fullSnapshot, false);

  codexFails = true;
  claudeFails = true;
  await assert.rejects(
    service.listSessionSnapshot({ cwds: ["/workspace"] }),
    /listing failed/,
  );
});

test("logs run event observer failures instead of silently dropping them", async () => {
  const warnings = [];
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ resolveSession, emit }) {
      await resolveSession({ backendId: "test", nativeSessionId: "session-1" });
      emit("turn.started", {});
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
    onRunEvent: async (event) => {
      if (event.type === "turn.completed") throw new Error("observer failed");
    },
    log: { warn: (message) => warnings.push(String(message)) },
  });

  const run = await service.startTurn(startRequest(), { subjectId: "user-1" });
  const result = await run.completion;
  assert.equal(result.outcome, "completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(
    warnings.join("\n"),
    /run event observer failed type=turn\.completed run=run-1: observer failed/,
  );
});

test("multi-directory snapshot uses backend batch listing and fails closed", async () => {
  const calls = [];
  const backend = listBackend("claude", { sessions: [] });
  backend.listSessionsForDirectories = async (options) => {
    calls.push(options);
    return { groups: options.cwds.map((cwd, index) => ({
      cwd,
      sessions: [{
        sessionRef: { backendId: "claude", nativeSessionId: `session-${index}` },
        canonicalCwd: cwd,
        updatedAt: `2026-08-25T0${index + 1}:00:00.000Z`,
      }],
    })) };
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
  });

  const snapshot = await service.listSessionSnapshot({
    cwds: ["/one", "/two"],
    includeSubagents: false,
  });
  assert.deepEqual(calls, [{ cwds: ["/one", "/two"], includeSubagents: false }]);
  assert.deepEqual(snapshot.groups.map((group) => group.sessions[0].sessionRef.nativeSessionId), [
    "session-0",
    "session-1",
  ]);

  backend.listSessionsForDirectories = async () => { throw new Error("catalog failed"); };
  await assert.rejects(
    service.listSessionSnapshot({ cwds: ["/one", "/two"] }),
    /catalog failed/,
  );
});

test("scoped session snapshot calls only the target backend", async () => {
  const calls = [];
  let codexFails = false;
  let claudeFails = true;
  const codex = listBackend("codex", { sessions: [] });
  const claude = listBackend("claude", { sessions: [] });
  codex.listSessionsForDirectories = async ({ cwds }) => {
    calls.push("codex");
    if (codexFails) throw new Error("codex listing failed");
    return { groups: cwds.map((cwd) => ({ cwd, sessions: [
      { sessionRef: { backendId: "codex", nativeSessionId: "codex-session" }, canonicalCwd: cwd },
    ] })) };
  };
  claude.listSessionsForDirectories = async ({ cwds }) => {
    calls.push("claude");
    if (claudeFails) throw new Error("claude listing failed");
    return { groups: cwds.map((cwd) => ({ cwd, sessions: [
      { sessionRef: { backendId: "claude", nativeSessionId: "claude-session" }, canonicalCwd: cwd },
    ] })) };
  };
  const service = createAgentService({
    backends: [codex, claude, listBackend("nolist", { sessions: [], listSupported: false })],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
  });

  const codexSnapshot = await service.listSessionSnapshot({ backendId: "codex", cwds: ["/workspace"] });
  assert.equal(codexSnapshot.groups[0].sessions[0].sessionRef.backendId, "codex");
  assert.deepEqual(calls, ["codex"]);

  codexFails = true;
  claudeFails = false;
  const claudeSnapshot = await service.listSessionSnapshot({ backendId: "claude", cwds: ["/workspace"] });
  assert.equal(claudeSnapshot.groups[0].sessions[0].sessionRef.backendId, "claude");
  assert.deepEqual(calls, ["codex", "claude"]);

  await assert.rejects(
    service.listSessionSnapshot({ backendId: "codex", cwds: ["/workspace"] }),
    /codex listing failed/,
  );
  await assert.rejects(
    service.listSessionSnapshot({ backendId: "missing", cwds: ["/workspace"] }),
    (error) => error.code === "backend_unavailable",
  );
  await assert.rejects(
    service.listSessionSnapshot({ backendId: "nolist", cwds: ["/workspace"] }),
    (error) => error.code === "capability_unsupported",
  );
});

test("session snapshot rejects malformed backend batch groups", async () => {
  let result;
  const backend = listBackend("codex", { sessions: [] });
  backend.listSessionsForDirectories = async () => result;
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
  });
  const validGroups = () => [
    { cwd: "/one", sessions: [] },
    { cwd: "/two", sessions: [] },
  ];
  const invalidResults = [
    { groups: [{ cwd: "/one", sessions: [] }] },
    { groups: [{ cwd: "/one", sessions: [] }, { cwd: "/one", sessions: [] }] },
    { groups: [{ cwd: "/one", sessions: [] }, { cwd: "/unknown", sessions: [] }] },
    { groups: [{ cwd: "/one" }, validGroups()[1]] },
    { groups: [
      { cwd: "/one", sessions: [{
        sessionRef: { backendId: "claude", nativeSessionId: "wrong-provider" },
        canonicalCwd: "/one",
      }] },
      validGroups()[1],
    ] },
    { groups: [
      { cwd: "/one", sessions: [{
        sessionRef: { backendId: "codex", nativeSessionId: "wrong-cwd" },
        canonicalCwd: "/two",
      }] },
      validGroups()[1],
    ] },
  ];

  for (result of invalidResults) {
    await assert.rejects(
      service.listSessionSnapshot({ backendId: "codex", cwds: ["/one", "/two"] }),
      (error) => error.code === "protocol_error",
    );
  }
});

test("all-backends paging re-queries only backends that returned a cursor", async () => {
  const calls = [];
  function pagingBackend(backendId, pagesByCursor) {
    return {
      backendId,
      getStatus: async () => ({
        backendId,
        available: true,
        readiness: { ready: true },
        capabilities: { session: { list: true } },
      }),
      resolveSessionCwd: async () => "/workspace",
      startTurn: async () => ({ outcome: "completed" }),
      listSessions: async ({ cursor }) => {
        calls.push({ backendId, cursor: String(cursor || "") });
        return pagesByCursor[String(cursor || "")];
      },
      readHistory: async () => ({ items: [] }),
    };
  }
  const service = createAgentService({
    backends: [
      pagingBackend("codex", {
        "": {
          sessions: [{ sessionRef: { backendId: "codex", nativeSessionId: "codex-1" }, updatedAt: "2026-08-22T04:00:00.000Z" }],
          cursor: "codex-p2",
        },
        "codex-p2": {
          sessions: [{ sessionRef: { backendId: "codex", nativeSessionId: "codex-2" }, updatedAt: "2026-08-22T02:00:00.000Z" }],
        },
      }),
      pagingBackend("claude", {
        "": {
          sessions: [{ sessionRef: { backendId: "claude", nativeSessionId: "claude-1" }, updatedAt: "2026-08-22T03:00:00.000Z" }],
        },
      }),
    ],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    now: () => "2026-08-22T00:00:00.000Z",
  });

  // 項目別cursorが無いBackendは全体カット対象外(従来の合成のまま)
  const page1 = await service.listSessions({ cwd: "/workspace", limit: 1 });
  assert.deepEqual(page1.sessions.map((session) => session.sessionRef.nativeSessionId), ["codex-1", "claude-1"]);
  assert.ok(page1.cursor);

  const page2 = await service.listSessions({ cwd: "/workspace", limit: 1, cursor: page1.cursor });
  assert.deepEqual(page2.sessions.map((session) => session.sessionRef.nativeSessionId), ["codex-2"]);
  assert.equal(page2.cursor, undefined);
  // cursorを返さなかった(=出し切った)Backendを2ページ目で先頭から再列挙しない
  assert.deepEqual(calls, [
    { backendId: "codex", cursor: "" },
    { backendId: "claude", cursor: "" },
    { backendId: "codex", cursor: "codex-p2" },
  ]);
});

function keysetBackend(backendId, pagesByCursor) {
  const item = (id, updatedAt) => ({
    sessionRef: { backendId, nativeSessionId: id },
    updatedAt,
    cursor: `${backendId}@${id}`,
  });
  return {
    backend: {
      backendId,
      getStatus: async () => ({
        backendId,
        available: true,
        readiness: { ready: true },
        capabilities: { session: { list: true } },
      }),
      resolveSessionCwd: async () => "/workspace",
      startTurn: async () => ({ outcome: "completed" }),
      listSessions: async ({ cursor }) => pagesByCursor[String(cursor || "")],
      readHistory: async () => ({ items: [] }),
    },
    item,
  };
}

test("all-backends first page is the global top-limit; deferred items arrive on later pages", async () => {
  const codex = keysetBackend("codex", {});
  const claude = keysetBackend("claude", {});
  // codex: c1(04:00) > c2(02:00)、claude: l1(03:00) > l2(01:00)
  const c1 = codex.item("c1", "2026-08-22T04:00:00.000Z");
  const c2 = codex.item("c2", "2026-08-22T02:00:00.000Z");
  const l1 = claude.item("l1", "2026-08-22T03:00:00.000Z");
  const l2 = claude.item("l2", "2026-08-22T01:00:00.000Z");
  Object.assign(codex.backend, {
    listSessions: async ({ cursor }) => ({
      "": { sessions: [c1, c2] },
      "codex@c1": { sessions: [c2] },
    })[String(cursor || "")],
  });
  Object.assign(claude.backend, {
    listSessions: async ({ cursor }) => ({
      "": { sessions: [l1, l2] },
      "claude@l1": { sessions: [l2] },
    })[String(cursor || "")],
  });
  const service = createAgentService({
    backends: [codex.backend, claude.backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    now: () => "2026-08-22T00:00:00.000Z",
  });

  const page1 = await service.listSessions({ cwd: "/workspace", limit: 2 });
  // 全体の新しい順トップ2だけを返す(古いl2やc2が新しい未返却項目より先に出ない)
  assert.deepEqual(page1.sessions.map((session) => session.sessionRef.nativeSessionId), ["c1", "l1"]);
  assert.equal(page1.sessions.every((session) => !("cursor" in session)), true);
  assert.ok(page1.cursor);

  const page2 = await service.listSessions({ cwd: "/workspace", limit: 2, cursor: page1.cursor });
  assert.deepEqual(page2.sessions.map((session) => session.sessionRef.nativeSessionId), ["c2", "l2"]);
  assert.equal(page2.cursor, undefined);
});

test("all-backends cut keeps a fully deferred backend at its current position", async () => {
  const codex = keysetBackend("codex", {});
  const claude = keysetBackend("claude", {});
  const c1 = codex.item("c1", "2026-08-22T10:00:00.000Z");
  const c2 = codex.item("c2", "2026-08-22T09:00:00.000Z");
  const l1 = claude.item("l1", "2026-08-22T05:00:00.000Z");
  const claudeCalls = [];
  Object.assign(codex.backend, {
    listSessions: async () => ({ sessions: [c1, c2] }),
  });
  Object.assign(claude.backend, {
    listSessions: async ({ cursor }) => {
      claudeCalls.push(String(cursor || ""));
      return { sessions: [l1] };
    },
  });
  const service = createAgentService({
    backends: [codex.backend, claude.backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    now: () => "2026-08-22T00:00:00.000Z",
  });

  const page1 = await service.listSessions({ cwd: "/workspace", limit: 2 });
  assert.deepEqual(page1.sessions.map((session) => session.sessionRef.nativeSessionId), ["c1", "c2"]);
  assert.ok(page1.cursor);

  // codexは出し切ったので再照会されず、claudeは先頭位置のまま2ページ目で返る
  const page2 = await service.listSessions({ cwd: "/workspace", limit: 2, cursor: page1.cursor });
  assert.deepEqual(page2.sessions.map((session) => session.sessionRef.nativeSessionId), ["l1"]);
  assert.equal(page2.cursor, undefined);
  assert.deepEqual(claudeCalls, ["", ""]);
});

test("all-backends paging carries a temporarily failing backend forward and retries it on the next page", async () => {
  const codex = keysetBackend("codex", {});
  const claude = keysetBackend("claude", {});
  const c1 = codex.item("c1", "2026-08-22T10:00:00.000Z");
  const c2 = codex.item("c2", "2026-08-22T09:00:00.000Z");
  const c3 = codex.item("c3", "2026-08-22T08:00:00.000Z");
  const l1 = claude.item("l1", "2026-08-22T07:00:00.000Z");
  Object.assign(codex.backend, {
    listSessions: async ({ cursor }) => ({
      "": { sessions: [c1], cursor: "codex@c1" },
      "codex@c1": { sessions: [c2], cursor: "codex@c2" },
      "codex@c2": { sessions: [c3] },
    })[String(cursor || "")],
  });
  let claudeFailsOnce = false;
  const claudeCalls = [];
  Object.assign(claude.backend, {
    listSessions: async ({ cursor }) => {
      claudeCalls.push(String(cursor || ""));
      if (claudeFailsOnce) {
        claudeFailsOnce = false;
        throw Object.assign(new Error("claude transcript scan failed"), { code: "history_unavailable" });
      }
      return { sessions: [l1] };
    },
  });
  const service = createAgentService({
    backends: [codex.backend, claude.backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    now: () => "2026-08-22T00:00:00.000Z",
  });

  const page1 = await service.listSessions({ cwd: "/workspace", limit: 1 });
  assert.deepEqual(page1.sessions.map((session) => session.sessionRef.nativeSessionId), ["c1"]);

  // 2ページ目でclaudeが一時失敗しても、複合cursorから脱落せず次ページで再試行される
  claudeFailsOnce = true;
  const page2 = await service.listSessions({ cwd: "/workspace", limit: 1, cursor: page1.cursor });
  assert.deepEqual(page2.sessions.map((session) => session.sessionRef.nativeSessionId), ["c2"]);
  assert.equal(page2.errors?.[0]?.backendId, "claude");
  assert.ok(page2.cursor);

  const page3 = await service.listSessions({ cwd: "/workspace", limit: 1, cursor: page2.cursor });
  assert.deepEqual(page3.sessions.map((session) => session.sessionRef.nativeSessionId), ["c3"]);
  assert.equal(page3.errors, undefined);
  assert.ok(page3.cursor);

  const page4 = await service.listSessions({ cwd: "/workspace", limit: 1, cursor: page3.cursor });
  assert.deepEqual(page4.sessions.map((session) => session.sessionRef.nativeSessionId), ["l1"]);
  // claudeは毎ページ先頭位置("")のまま再試行されている
  assert.deepEqual(claudeCalls, ["", "", "", ""]);
});

test("single-backend scope strips per-item cursors from the wire like the all-backends scope", async () => {
  const codex = keysetBackend("codex", {});
  const c1 = codex.item("c1", "2026-08-22T10:00:00.000Z");
  Object.assign(codex.backend, {
    listSessions: async () => ({ sessions: [c1], cursor: "codex@c1" }),
  });
  const service = createAgentService({
    backends: [codex.backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    now: () => "2026-08-22T00:00:00.000Z",
  });

  const page = await service.listSessions({ backendId: "codex", cwd: "/workspace", limit: 1 });
  assert.deepEqual(page.sessions.map((session) => session.sessionRef.nativeSessionId), ["c1"]);
  assert.equal(page.sessions.every((session) => !("cursor" in session)), true);
  assert.equal(page.cursor, "codex@c1");
});

test("rejects an effort outside the backend's advertised effort catalog before backend execution", async () => {
  let starts = 0;
  const backend = {
    backendId: "test",
    getStatus: async () => ({
      ...status(),
      capabilities: {
        ...status().capabilities,
        model: { select: true, effort: true, effortOptions: ["low", "medium", "high"] },
      },
    }),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, resolveSession }) {
      starts += 1;
      await resolveSession({ backendId: "test", nativeSessionId: "session-1" });
      emit("turn.started", {});
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
    generateRunId: () => "run-effort",
    now: () => "2026-08-21T00:00:00.000Z",
  });

  await assert.rejects(
    service.startTurn(startRequest({ effort: "ultra" }), { subjectId: "user-1" }),
    (error) => error.code === "capability_unsupported" && /effort value/.test(error.message),
  );
  assert.equal(starts, 0);

  const run = await service.startTurn(startRequest({ effort: "high" }), { subjectId: "user-1" });
  for await (const event of run.events) void event;
  await run.completion;
  assert.equal(starts, 1);
});

test("deduplicates a client operation and rejects conflicting reuse", async () => {
  let starts = 0;
  let settingWrites = 0;
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
  const store = sessionStore();
  const bind = store.bind;
  const setSettings = store.setSettings;
  store.setSettings = async (...args) => {
    settingWrites += 1;
    return await setSettings(...args);
  };
  store.bind = async (...args) => {
    if (Object.hasOwn(args[3] || {}, "settings")) settingWrites += 1;
    return await bind(...args);
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: store,
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
  assert.equal(settingWrites, 1);
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
  await service.interrupt(run.runId, { subjectId: "user-1" });
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

  // busyで拒否された新規operationIdはclaimされておらず、session解放後に再利用できる。
  const retried = await service.startTurn(startRequest({ sessionRef, cwd: "", clientOperationId: "operation-2" }), {
    subjectId: "user-1",
  });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal((await retried.completion).outcome, "completed");
  assert.equal(starts, 2);
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

test("rejects allow_for_session when the active action did not advertise it", async () => {
  let release;
  let emitAction;
  const actionGate = new Promise((resolve) => { emitAction = resolve; });
  let actionReady;
  const actionWasRequested = new Promise((resolve) => { actionReady = resolve; });
  let backendResponses = 0;
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, resolveSession }) {
      await resolveSession({ backendId: "test", nativeSessionId: "session-1" });
      emit("turn.started", {});
      await actionGate;
      emit("action.requested", { requestId: "approval-1", kind: "approval", decisions: ["allow", "deny"] });
      actionReady();
      await new Promise((resolve) => { release = resolve; });
      return { outcome: "completed" };
    },
    async respondToAction() { backendResponses += 1; },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    generateRunId: () => "run-unadvertised-decision",
  });
  const run = await service.startTurn(startRequest(), { subjectId: "user-1" });
  const subscription = service.subscribe(run.runId, {
    onEvent() {},
    actionConsumerId: "consumer-1",
    actionScope: "approval",
  }, { subjectId: "user-1" });
  emitAction();
  await actionWasRequested;
  await assert.rejects(
    service.respondToAction(
      { runId: run.runId, requestId: "approval-1", decision: "allow_for_session" },
      { subjectId: "user-1", actionConsumerId: "consumer-1" },
    ),
    (error) => error.code === "turn_rejected" && /not supported/.test(error.message),
  );
  assert.equal(backendResponses, 0);
  subscription.unsubscribe();
  release();
  await run.completion;
});

test("an authenticated push responder races the current approval consumer without bypassing action validation", async () => {
  let emitAction;
  const actionGate = new Promise((resolve) => { emitAction = resolve; });
  let release;
  let actionReady;
  const actionWasRequested = new Promise((resolve) => { actionReady = resolve; });
  const backendResponses = [];
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, resolveSession }) {
      await resolveSession({ backendId: "test", nativeSessionId: "session-1" });
      emit("turn.started", {});
      await actionGate;
      emit("action.requested", { requestId: "approval-1", kind: "approval", decisions: ["allow", "deny"] });
      actionReady();
      await new Promise((resolve) => { release = resolve; });
      return { outcome: "completed" };
    },
    async respondToAction(response) { backendResponses.push(response); },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    generateRunId: () => "run-push-approval",
  });
  const run = await service.startTurn(startRequest(), { subjectId: "user-1" });
  const subscription = service.subscribe(run.runId, {
    onEvent() {},
    actionConsumerId: "ui-consumer",
    actionScope: "approval",
  }, { subjectId: "user-1" });
  emitAction();
  await actionWasRequested;

  await assert.rejects(
    service.respondToAction(
      { runId: run.runId, requestId: "approval-1", decision: "allow" },
      { subjectId: "user-1" },
    ),
    (error) => error.code === "action_expired",
  );
  await assert.rejects(
    service.respondToAction(
      { runId: run.runId, requestId: "approval-1", decision: "allow" },
      { subjectId: "user-1", actionConsumerId: "other-consumer" },
    ),
    (error) => error.code === "action_expired",
  );
  await service.respondToAction(
    { runId: run.runId, requestId: "approval-1", decision: "allow" },
    { subjectId: "user-1", approvalResponder: true },
  );
  assert.equal(backendResponses.length, 1);

  subscription.unsubscribe();
  release();
  await run.completion;
});

test("observes every published event once without subscribers or replay", async () => {
  const observed = [];
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, resolveSession }) {
      await resolveSession({ backendId: "test", nativeSessionId: "session-1" });
      emit("turn.started", {});
      emit("action.requested", { requestId: "approval-1", kind: "approval", decisions: ["allow", "deny"] });
      assert.equal(observed.at(-1)?.type, "action.requested");
      return { outcome: "completed" };
    },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    generateRunId: () => "run-observed",
    onRunEvent: (event) => { observed.push(event); },
  });
  const run = await service.startTurn(startRequest(), { subjectId: "user-1" });
  await run.completion;
  const observedCount = observed.length;
  service.subscribe(run.runId, { onEvent() {} }, { subjectId: "user-1" }).unsubscribe();
  assert.equal(observed.length, observedCount);
  assert.deepEqual(observed.map((event) => event.type), [
    "turn.accepted", "session.resolved", "turn.started", "action.requested", "action.resolved", "turn.completed",
  ]);
});

test("isolates synchronous and asynchronous observer failures from run execution", async () => {
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit }) {
      emit("turn.started", {});
      emit("provider.event", { backendId: "test", nativeType: "async-failure", data: {} });
      return { outcome: "completed" };
    },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    onRunEvent(event) {
      if (event.type === "turn.accepted") throw new Error("sync observer failure");
      if (event.type === "provider.event") return Promise.reject(new Error("async observer failure"));
    },
  });
  const run = await service.startTurn(startRequest({
    sessionRef: { backendId: "test", nativeSessionId: "session-1" },
  }), { subjectId: "user-1" });
  assert.equal((await run.completion).outcome, "completed");
  await new Promise((resolve) => setImmediate(resolve));
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

test("history returns native cwd and repairs an idle raw stale binding", async () => {
  const sessions = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-history" };
  await sessions.bind(sessionRef, "/stale-workspace", "raw");
  const backend = {
    backendId: "test",
    getStatus: async () => ({
      ...status(),
      capabilities: { session: { history: { read: true } } },
    }),
    resolveSessionCwd: async () => "/workspace-link",
    readHistory: async () => ({ items: [] }),
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd === "/workspace-link" ? "/workspace-real" : cwd,
  });

  const page = await service.readHistory({ sessionRef });

  assert.equal(page.canonicalCwd, "/workspace-real");
  assert.deepEqual(page.sessionRef, sessionRef);
  assert.equal((await sessions.getBinding(sessionRef)).canonicalCwd, "/workspace-real");
});

test("history exposes only the authenticated subject's active neutral run", async () => {
  const sessions = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-active" };
  await sessions.bind(sessionRef, "/workspace", "neutral");
  let finishTurn;
  const turnGate = new Promise((resolve) => { finishTurn = resolve; });
  const backend = {
    backendId: "test",
    getStatus: async () => ({
      ...status(),
      capabilities: { ...status().capabilities, session: { history: { read: true } } },
    }),
    resolveSessionCwd: async () => "/workspace",
    readHistory: async () => ({ items: [] }),
    async startTurn({ emit }) {
      emit("turn.started", {});
      await turnGate;
      return { outcome: "completed" };
    },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd,
    generateRunId: () => "run-active",
    now: () => "2026-08-23T00:00:00.000Z",
  });

  const run = await service.startTurn(startRequest({ sessionRef, cwd: "" }), { subjectId: "owner" });
  await new Promise((resolve) => setImmediate(resolve));
  const owned = await service.readHistory({ sessionRef }, { subjectId: "owner" });
  const foreign = await service.readHistory({ sessionRef }, { subjectId: "other" });

  assert.deepEqual(owned.activeRun, {
    runId: "run-active",
    sessionRef,
    state: "running",
    startedAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    waitingForAction: false,
  });
  assert.equal(foreign.activeRun, null);

  finishTurn();
  await run.completion;
  assert.equal((await service.readHistory({ sessionRef }, { subjectId: "owner" })).activeRun, null);
});

test("a claimed dynamic action stays orphaned and stoppable after its consumer disconnects", async () => {
  const sessions = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-actions" };
  await sessions.bind(sessionRef, "/workspace", "neutral");
  let finishTurn;
  let emitAction;
  const turnGate = new Promise((resolve) => { finishTurn = resolve; });
  const backendResponses = [];
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit }) {
      emitAction = emit;
      emit("turn.started", {});
      emit("action.requested", {
        requestId: "approval-1",
        kind: "permission",
        decisions: ["allow", "deny"],
      });
      emit("action.requested", {
        requestId: "tool-1",
        kind: "dynamic_tool",
        decisions: ["result"],
      });
      await turnGate;
      return { outcome: "completed" };
    },
    async respondToAction(response) { backendResponses.push(response); },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd,
  });
  const run = await service.startTurn(startRequest({ sessionRef, cwd: "" }), { subjectId: "owner" });
  await new Promise((resolve) => setImmediate(resolve));
  const approvalConsumer = {};
  const dynamicConsumer = {};
  const allConsumer = {};
  const approvalEvents = [];
  const dynamicEvents = [];
  const allEvents = [];
  const passiveEvents = [];
  const approvalSubscription = service.subscribe(run.runId, {
    afterSequence: 0,
    actionConsumerId: approvalConsumer,
    actionScope: "approval",
    onEvent: (event) => approvalEvents.push(event),
  }, { subjectId: "owner" });
  const dynamicSubscription = service.subscribe(run.runId, {
    afterSequence: 0,
    actionConsumerId: dynamicConsumer,
    actionScope: "dynamic_tool",
    onEvent: (event) => dynamicEvents.push(event),
  }, { subjectId: "owner" });
  const allSubscription = service.subscribe(run.runId, {
    afterSequence: 0,
    actionConsumerId: allConsumer,
    actionScope: "all",
    onEvent: (event) => allEvents.push(event),
  }, { subjectId: "owner" });
  const passiveSubscription = service.subscribe(run.runId, {
    afterSequence: 0,
    onEvent: (event) => passiveEvents.push(event),
  }, { subjectId: "owner" });

  assert.deepEqual(approvalSubscription.activeActions.map((action) => action.requestId), ["approval-1"]);
  assert.deepEqual(dynamicSubscription.activeActions.map((action) => action.requestId), ["tool-1"]);
  assert.deepEqual(allSubscription.activeActions.map((action) => action.requestId), []);
  assert.equal(approvalEvents.some((event) => event.type === "action.requested"), false);
  assert.equal(dynamicEvents.some((event) => event.type === "action.requested"), false);
  assert.equal(allEvents.some((event) => event.type === "action.requested"), false);
  assert.throws(
    () => service.subscribe(run.runId, { onEvent() {} }, { subjectId: "other" }),
    (error) => error.code === "turn_rejected",
  );
  await assert.rejects(
    service.interrupt(run.runId, { subjectId: "other" }),
    (error) => error.code === "turn_rejected",
  );

  approvalSubscription.unsubscribe();
  assert.deepEqual(
    allEvents.filter((event) => event.type === "action.requested").map((event) => event.payload.requestId),
    ["approval-1"],
  );
  emitAction("action.requested", {
    requestId: "tool-2",
    kind: "dynamic_tool",
    decisions: ["result"],
  });
  assert.equal(passiveEvents.some((event) => event.type === "action.requested"), false);
  assert.equal(dynamicEvents.some((event) => event.payload?.requestId === "tool-2"), true);
  assert.equal(allEvents.some((event) => event.payload?.requestId === "tool-2"), false);
  await assert.rejects(
    service.respondToAction(
      { runId: run.runId, requestId: "approval-1", decision: "deny" },
      { subjectId: "owner", actionConsumerId: approvalConsumer },
    ),
    (error) => error.code === "action_expired",
  );
  await assert.rejects(
    service.respondToAction(
      { runId: run.runId, requestId: "approval-1", decision: "deny" },
      { subjectId: "other", actionConsumerId: allConsumer },
    ),
    (error) => error.code === "turn_rejected",
  );
  await service.respondToAction(
    { runId: run.runId, requestId: "approval-1", decision: "deny" },
    { subjectId: "owner", actionConsumerId: allConsumer },
  );
  await assert.rejects(
    service.claimAction(
      { runId: run.runId, requestId: "tool-1" },
      { subjectId: "other", actionConsumerId: dynamicConsumer },
    ),
    (error) => error.code === "turn_rejected",
  );
  await service.claimAction(
    { runId: run.runId, requestId: "tool-1" },
    { subjectId: "owner", actionConsumerId: dynamicConsumer },
  );
  await service.respondToAction(
    { runId: run.runId, requestId: "tool-1", decision: "result", result: { ok: true } },
    { subjectId: "owner", actionConsumerId: dynamicConsumer },
  );
  await assert.rejects(
    service.respondToAction(
      { runId: run.runId, requestId: "tool-1", decision: "result", result: { ok: false } },
      { subjectId: "owner", actionConsumerId: dynamicConsumer },
    ),
    (error) => error.code === "action_expired",
  );
  assert.deepEqual(backendResponses.map((response) => response.requestId), ["approval-1", "tool-1"]);

  await service.claimAction(
    { runId: run.runId, requestId: "tool-2" },
    { subjectId: "owner", actionConsumerId: dynamicConsumer },
  );
  await assert.rejects(
    service.claimAction(
      { runId: run.runId, requestId: "tool-2" },
      { subjectId: "owner", actionConsumerId: dynamicConsumer },
    ),
    (error) => error.code === "action_expired",
  );
  dynamicSubscription.unsubscribe();
  allSubscription.unsubscribe();
  const replacementConsumer = {};
  const replacementEvents = [];
  const replacement = service.subscribe(run.runId, {
    actionConsumerId: replacementConsumer,
    actionScope: "all",
    onEvent: (event) => replacementEvents.push(event),
  }, { subjectId: "owner" });
  assert.equal(replacement.activeActions.some((action) => action.requestId === "tool-2"), false);
  assert.equal(
    replacementEvents.some((event) => event.type === "action.requested" && event.payload.requestId === "tool-2"),
    false,
  );
  await assert.rejects(
    service.claimAction(
      { runId: run.runId, requestId: "tool-2" },
      { subjectId: "owner", actionConsumerId: replacementConsumer },
    ),
    (error) => error.code === "action_expired",
  );
  await service.interrupt(run.runId, { subjectId: "owner" });
  finishTurn();
  assert.equal((await run.completion).outcome, "interrupted");
  replacement.unsubscribe();
  passiveSubscription.unsubscribe();
});

test("filtered action events preserve run-global ordering for every subscriber", async () => {
  let emitEvent;
  let requestAction;
  let finishTurn;
  const actionGate = new Promise((resolve) => { requestAction = resolve; });
  const turnGate = new Promise((resolve) => { finishTurn = resolve; });
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    async startTurn({ emit, resolveSession }) {
      emitEvent = emit;
      await resolveSession({ backendId: "test", nativeSessionId: "sequence-session" });
      emit("turn.started", {});
      await actionGate;
      emit("action.requested", {
        requestId: "approval-1",
        kind: "permission",
        decisions: ["allow", "deny"],
      });
      await turnGate;
      return { outcome: "completed" };
    },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
  });
  const run = await service.startTurn(startRequest(), { subjectId: "owner" });
  const consumerEvents = [];
  const passiveEvents = [];
  const replacementEvents = [];
  const consumer = service.subscribe(run.runId, {
    actionConsumerId: {},
    actionScope: "approval",
    onEvent: (event) => consumerEvents.push(event),
  }, { subjectId: "owner" });
  const passive = service.subscribe(run.runId, {
    onEvent: (event) => passiveEvents.push(event),
  }, { subjectId: "owner" });
  const replacement = service.subscribe(run.runId, {
    actionConsumerId: {},
    actionScope: "approval",
    onEvent: (event) => replacementEvents.push(event),
  }, { subjectId: "owner" });
  requestAction();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    consumerEvents.filter((event) => event.type === "action.requested").map((event) => event.payload.requestId),
    ["approval-1"],
  );
  assert.equal(passiveEvents.some((event) => event.type === "action.requested"), false);
  assert.equal(replacementEvents.some((event) => event.type === "action.requested"), false);

  emitEvent("provider.event", { backendId: "test", nativeType: "before-handoff", data: {} });
  const sequenceBeforeHandoff = replacementEvents.at(-1).sequence;
  consumer.unsubscribe();
  const handedOff = replacementEvents.at(-1);
  assert.equal(handedOff.type, "action.requested");
  assert.equal(handedOff.payload.requestId, "approval-1");
  assert.equal(handedOff.sequence > sequenceBeforeHandoff, true);
  emitEvent("action.resolved", { requestId: "approval-1", outcome: "expired" });
  const freshEvents = [];
  const fresh = service.subscribe(run.runId, {
    onEvent: (event) => freshEvents.push(event),
  }, { subjectId: "owner" });
  emitEvent("item.started", { itemId: "assistant-1", itemType: "assistant" });
  emitEvent("content.delta", { itemId: "assistant-1", delta: "after action" });
  emitEvent("item.completed", { itemId: "assistant-1", revision: 1 });
  finishTurn();
  await run.completion;

  for (const events of [replacementEvents, passiveEvents, freshEvents]) {
    assert.equal(events.some((event) => event.type === "action.resolved"), true);
    assert.equal(events.some((event) => event.type === "content.delta"), true);
    assert.equal(events.at(-1).type, "turn.completed");
    assert.equal(events.every((event, index) => index === 0 || event.sequence > events[index - 1].sequence), true);
  }
  assert.equal(freshEvents.some((event) => event.type === "action.requested"), false);
  passive.unsubscribe();
  replacement.unsubscribe();
  fresh.unsubscribe();
});

test("a fresh subscription reports an explicitly truncated replay window", async () => {
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, resolveSession }) {
      await resolveSession({ backendId: "test", nativeSessionId: "session-truncated" });
      emit("turn.started", {});
      emit("item.started", { itemId: "item-1", itemType: "assistant" });
      emit("content.delta", { itemId: "item-1", delta: "latest" });
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
    replayLimit: 2,
    generateRunId: () => "run-truncated",
  });
  const run = await service.startTurn(startRequest(), { subjectId: "owner" });
  await run.completion;
  const replayed = [];
  const subscription = service.subscribe(
    run.runId,
    { afterSequence: 0, onEvent: (event) => replayed.push(event) },
    { subjectId: "owner" },
  );

  assert.equal(subscription.replayTruncated, true);
  assert.equal(subscription.replayFromSequence, 5);
  assert.deepEqual(replayed.map((event) => event.sequence), [5, 6]);

  const staleReplay = [];
  const stale = service.subscribe(
    run.runId,
    { afterSequence: 1, onEvent: (event) => staleReplay.push(event) },
    { subjectId: "owner" },
  );
  assert.equal(stale.replayTruncated, true);
  assert.equal(stale.replayFromSequence, 5);
  assert.deepEqual(staleReplay.map((event) => event.sequence), [5, 6]);
});

test("turn execution fails closed when native cwd disagrees with its binding", async () => {
  const sessions = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-mismatch" };
  await sessions.bind(sessionRef, "/bound-workspace", "neutral");
  const backend = {
    backendId: "test",
    getStatus: async () => status(),
    resolveSessionCwd: async () => "/native-workspace",
    async startTurn() {
      assert.fail("Backend turn must not start with a mismatched native cwd");
    },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd,
  });

  await assert.rejects(
    service.startTurn(startRequest({
      sessionRef,
      cwd: "/native-workspace",
      clientOperationId: "mismatch-operation",
    }), { subjectId: "subject" }),
    (error) => error.code === "session_cwd_mismatch",
  );
  assert.equal((await sessions.getBinding(sessionRef)).canonicalCwd, "/bound-workspace");
});

test("history repairs an idle neutral stale binding toward the native cwd", async () => {
  // native cwdはBackendの真実。idleなら(raw同様)neutral bindingもnativeへ収束させる。
  // 収束先は常にbackend.resolveSessionCwdでありクライアント入力ではないため、
  // requested cwd照合のfail-closed性は変わらない。
  const sessions = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-history-mismatch" };
  await sessions.bind(sessionRef, "/bound-workspace", "neutral");
  const backend = {
    backendId: "test",
    getStatus: async () => ({
      ...status(),
      capabilities: { session: { history: { read: true } } },
    }),
    resolveSessionCwd: async () => "/native-workspace",
    readHistory: async () => ({ items: [] }),
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd,
  });

  const page = await service.readHistory({ sessionRef });

  assert.equal(page.canonicalCwd, "/native-workspace");
  assert.equal((await sessions.getBinding(sessionRef)).canonicalCwd, "/native-workspace");
});

test("history keeps a leased mismatched binding fail-closed", async () => {
  const sessions = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-history-leased" };
  await sessions.bind(sessionRef, "/bound-workspace", "neutral");
  await sessions.acquire({ sessionRef, mode: "neutral", owner: "agent-service", runId: "run-leased" });
  const backend = {
    backendId: "test",
    getStatus: async () => ({
      ...status(),
      capabilities: { session: { history: { read: true } } },
    }),
    resolveSessionCwd: async () => "/native-workspace",
    readHistory: async () => ({ items: [] }),
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd,
  });

  await assert.rejects(
    service.readHistory({ sessionRef }),
    (error) => error.code === "session_cwd_mismatch",
  );
  assert.equal((await sessions.getBinding(sessionRef)).canonicalCwd, "/bound-workspace");
});

test("raw handoff clears stored neutral settings so newer native metadata wins", async () => {
  const sessions = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-raw" };
  await sessions.bind(sessionRef, "/workspace", "neutral");
  await sessions.setSettings(sessionRef, { modelId: "stored-old", reasoningEffort: "high" });
  const backend = {
    backendId: "test",
    defaultDiscoveredSessionMode: "raw",
    getStatus: async () => ({
      ...status(),
      capabilities: { session: { list: true, history: { read: true } } },
    }),
    resolveSessionCwd: async () => "/workspace",
    listSessions: async () => ({
      sessions: [{ sessionRef, modelId: "native-new", reasoningEffort: "low" }],
    }),
    readHistory: async () => ({ items: [], modelId: "native-new", reasoningEffort: "low" }),
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd,
  });

  assert.equal((await service.handoffSession({ sessionRef, targetMode: "raw" })).mode, "raw");
  assert.equal((await sessions.getBinding(sessionRef)).modelId, undefined);
  assert.deepEqual(await service.listSessions({ backendId: "test", cwd: "/workspace" }), {
    sessions: [{ sessionRef, modelId: "native-new", reasoningEffort: "low" }],
  });
  assert.deepEqual(await service.readHistory({ sessionRef }), {
    items: [],
    modelId: "native-new",
    reasoningEffort: "low",
    sessionRef,
    canonicalCwd: "/workspace",
    activeRun: null,
  });
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
