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
  const key = (ref) => `${ref.backendId}:${ref.nativeSessionId}`;
  return {
    async bind(ref, canonicalCwd, mode, options = {}) {
      const existingMode = modes.get(key(ref));
      if (existingMode && existingMode.mode !== mode) return { status: "mode_conflict", mode: existingMode.mode };
      const existingBinding = bindings.get(key(ref));
      if (existingBinding && existingBinding.canonicalCwd !== canonicalCwd && options.reconcileCwd !== true) {
        return { status: "cwd_conflict", binding: existingBinding };
      }
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
    async handoff(ref, mode) {
      const entry = modes.get(key(ref)) || { lease: null, generation: 0 };
      // 実storeと同じ: 同一モードへのhandoffはlease保持中でもno-op成功
      if (entry.mode === mode) return { status: "unchanged", mode };
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
      capabilities: { ...status().capabilities, operations: { compact: true } },
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
    clientOperationId: `operation-${index + 1}`,
  }));
  const runs = await Promise.all(requests.map((request) => service.startTurn(request, { subjectId: "user-1" })));
  assert.deepEqual(runs.map((run) => run.queued), [true, true, true]);
  const replayedFirst = await service.startTurn(requests[0], { subjectId: "user-1" });
  assert.equal(replayedFirst.runId, runs[0].runId);
  assert.equal(replayedFirst.queued, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(startedInputs, []);

  releaseCompact();
  await compactPromise;
  while (startedInputs.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
      capabilities: { ...status().capabilities, operations: { compact: true } },
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
  await service.interrupt(run.runId);
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
  const codexSessions = [
    { sessionRef: { backendId: "codex", nativeSessionId: "codex-1" }, updatedAt: "2026-08-22T02:00:00.000Z" },
  ];
  const claudeSessions = [
    { sessionRef: { backendId: "claude", nativeSessionId: "claude-1" }, updatedAt: "2026-08-22T03:00:00.000Z" },
    { sessionRef: { backendId: "claude", nativeSessionId: "claude-2" }, updatedAt: "2026-08-22T01:00:00.000Z" },
  ];
  const service = createAgentService({
    backends: [
      listBackend("codex", { sessions: codexSessions }),
      listBackend("claude", { sessions: claudeSessions }),
      listBackend("nolist", { sessions: [], listSupported: false }),
    ],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    now: () => "2026-08-22T00:00:00.000Z",
  });

  const merged = await service.listSessions({ cwd: "/workspace" });
  assert.deepEqual(merged.sessions.map((session) => session.sessionRef.nativeSessionId), [
    "claude-1", "codex-1", "claude-2",
  ]);
  assert.equal(merged.errors, undefined);

  const scoped = await service.listSessions({ backendId: "codex", cwd: "/workspace" });
  assert.deepEqual(scoped.sessions.map((session) => session.sessionRef.nativeSessionId), ["codex-1"]);

  const failure = Object.assign(new Error("claude transcript scan failed"), { code: "history_unavailable" });
  const partialService = createAgentService({
    backends: [
      listBackend("codex", { sessions: codexSessions }),
      listBackend("claude", { listError: failure }),
    ],
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd,
    now: () => "2026-08-22T00:00:00.000Z",
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
    now: () => "2026-08-22T00:00:00.000Z",
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
  service.subscribe(run.runId, { onEvent() {} }).unsubscribe();
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

test("resumes an existing session with the history-resolved cwd and the same model", async () => {
  const sessions = sessionStore();
  const sessionRef = { backendId: "test", nativeSessionId: "session-resume" };
  const backend = {
    backendId: "test",
    defaultDiscoveredSessionMode: "neutral",
    getStatus: async () => ({
      ...status(),
      capabilities: {
        session: { history: { read: true } },
        model: { select: true },
      },
    }),
    resolveSessionCwd: async () => "/workspace-link",
    readHistory: async () => ({ items: [], modelId: "gpt-5" }),
    async startTurn({ emit }) {
      emit("turn.started", {});
      return { outcome: "completed", sessionRef };
    },
  };
  const service = createAgentService({
    backends: [backend],
    operationStore: operationStore(),
    sessionStore: sessions,
    resolveCanonicalCwd: async (cwd) => cwd === "/workspace-link" ? "/workspace-real" : cwd,
    generateRunId: () => "resume-run",
  });
  const history = await service.readHistory({ sessionRef });

  const run = await service.startTurn(startRequest({
    sessionRef,
    cwd: history.canonicalCwd,
    model: "gpt-5",
    clientOperationId: "resume-operation",
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
