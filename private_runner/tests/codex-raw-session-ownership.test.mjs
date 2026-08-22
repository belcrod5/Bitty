import assert from "node:assert/strict";
import test from "node:test";

import { createCodexRawSessionOwnership } from "../src/agent/codex-raw-session-ownership.mjs";

function createOwnership(overrides = {}) {
  const calls = [];
  const ownership = createCodexRawSessionOwnership({
    bindSession: async (...args) => { calls.push(["bind", ...args]); return { status: "bound" }; },
    getSessionBinding: async () => null,
    acquireLease: async (...args) => { calls.push(["acquire", ...args]); return { status: "acquired", lease: { generation: 4 } }; },
    settleLease: async (...args) => { calls.push(["settle", ...args]); return { status: args[2] }; },
    resolveCanonicalCwd: async (cwd) => `/real${cwd}`,
    makeConflictError: (code, message) => Object.assign(new Error(message), { code }),
    errorMessage: (error) => error.message,
    sendRpc: (...args) => calls.push(["send", ...args]),
    ...overrides,
  });
  return { ownership, calls };
}

test("raw Codex admission binds one mode and acquires a durable generation lease", async () => {
  const { ownership, calls } = createOwnership();
  const relay = { relayId: "relay-1", threadId: "thread-1", threadCwd: "/workspace", clients: new Set() };
  await ownership.admit(relay, { params: { threadId: "thread-1" } }, { operationId: "op-1" });
  assert.deepEqual(relay.agentLease, {
    sessionRef: { backendId: "codex", nativeSessionId: "thread-1" },
    generation: 4,
    kind: "turn",
  });
  assert.equal(calls[0][0], "bind");
  assert.equal(calls[1][0], "acquire");
  await ownership.settle(relay, "released");
  assert.equal(relay.agentLease, null);
  assert.equal(calls[2][0], "settle");
});

test("authoritative native cwd requests idle raw binding reconciliation", async () => {
  const { ownership, calls } = createOwnership();

  await ownership.bind(
    { relayId: "relay-1" },
    "thread-1",
    "/workspace",
    { reconcileCwd: true },
  );

  assert.deepEqual(calls[0], [
    "bind",
    { backendId: "codex", nativeSessionId: "thread-1" },
    "/real/workspace",
    "raw",
    { reconcileCwd: true },
  ]);
});

test("raw compact and turn admission share the same session lease", async () => {
  const { ownership } = createOwnership();
  const relay = { relayId: "relay-1", threadId: "thread-1", threadCwd: "/workspace", clients: new Set() };
  await ownership.admit(relay, { id: 1, params: { threadId: "thread-1" } }, {}, "compact");
  assert.equal(relay.agentLease.kind, "compact");
  await assert.rejects(
    ownership.admit(relay, { id: 2, params: { threadId: "thread-1" } }, {}, "turn"),
    (error) => error.code === "session_busy",
  );
  await ownership.settle(relay, "released", "compact");
  assert.equal(relay.agentLease, null);
});

test("the next raw admission waits for durable lease settlement", async () => {
  let releaseSettlement;
  const settlement = new Promise((resolve) => { releaseSettlement = resolve; });
  let acquisitions = 0;
  const { ownership } = createOwnership({
    acquireLease: async () => {
      acquisitions += 1;
      return { status: "acquired", lease: { generation: acquisitions } };
    },
    settleLease: async () => settlement,
  });
  const relay = { relayId: "relay-1", threadId: "thread-1", threadCwd: "/workspace", clients: new Set() };

  await ownership.admit(relay, { id: 1, params: { threadId: "thread-1" } }, {}, "turn");
  const settling = ownership.settle(relay, "completed", "turn");
  const nextAdmission = ownership.admit(relay, { id: 2, params: { threadId: "thread-1" } }, {}, "turn");
  await Promise.resolve();
  assert.equal(acquisitions, 1);

  releaseSettlement();
  await Promise.all([settling, nextAdmission]);
  assert.equal(acquisitions, 2);
  assert.equal(relay.agentLease.generation, 2);
});

test("raw admission waits for authoritative cwd reconciliation", async () => {
  let finishReconciliation;
  const reconciliation = new Promise((resolve) => { finishReconciliation = resolve; });
  let acquisitions = 0;
  const { ownership } = createOwnership({
    acquireLease: async () => {
      acquisitions += 1;
      return { status: "acquired", lease: { generation: 1 } };
    },
  });
  const relay = {
    relayId: "relay-1",
    threadId: "thread-1",
    threadCwd: "/workspace",
    clients: new Set(),
    agentBindingReconciliation: reconciliation,
  };

  const admission = ownership.admit(relay, { params: { threadId: "thread-1" } }, {}, "turn");
  await Promise.resolve();
  assert.equal(acquisitions, 0);

  finishReconciliation({ error: null });
  await admission;
  assert.equal(acquisitions, 1);
  assert.equal(relay.agentBindingReconciliation, null);
});

test("raw admission waits for a newer reconciliation queued while it is waiting", async () => {
  let finishFirst;
  let finishSecond;
  const first = new Promise((resolve) => { finishFirst = resolve; });
  const second = new Promise((resolve) => { finishSecond = resolve; });
  let acquisitions = 0;
  const { ownership } = createOwnership({
    acquireLease: async () => {
      acquisitions += 1;
      return { status: "acquired", lease: { generation: 1 } };
    },
  });
  const relay = {
    relayId: "relay-1",
    threadId: "thread-1",
    threadCwd: "/workspace",
    clients: new Set(),
    agentBindingReconciliation: first,
  };

  const admission = ownership.admit(relay, { params: { threadId: "thread-1" } }, {}, "turn");
  relay.agentBindingReconciliation = second;
  finishFirst({ error: null });
  await Promise.resolve();
  assert.equal(acquisitions, 0);

  finishSecond({ error: null });
  await admission;
  assert.equal(acquisitions, 1);
});

test("raw admission rejects a failed authoritative cwd reconciliation", async () => {
  const error = Object.assign(new Error("neutral binding mismatch"), { code: "session_mode_conflict" });
  const { ownership, calls } = createOwnership();
  const relay = {
    relayId: "relay-1",
    threadId: "thread-1",
    threadCwd: "/workspace",
    clients: new Set(),
    agentBindingReconciliation: Promise.resolve({ error }),
  };

  await assert.rejects(
    ownership.admit(relay, { params: { threadId: "thread-1" } }, {}, "turn"),
    (caught) => caught === error,
  );
  assert.equal(calls.some(([kind]) => kind === "bind" || kind === "acquire"), false);
});

test("raw Codex admission rejects a session already handed to neutral transport", async () => {
  const { ownership } = createOwnership({ bindSession: async () => ({ status: "mode_conflict" }) });
  await assert.rejects(
    ownership.admit(
      { relayId: "relay-1", threadId: "thread-1", threadCwd: "/workspace", clients: new Set() },
      { params: { threadId: "thread-1" } },
      { operationId: "op-1" },
    ),
    (error) => error.code === "session_mode_conflict",
  );
});
