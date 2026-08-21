import assert from "node:assert/strict";
import test from "node:test";

import { createCodexRawSessionOwnership } from "../src/agent/codex-raw-session-ownership.mjs";

function createOwnership(overrides = {}) {
  const calls = [];
  const ownership = createCodexRawSessionOwnership({
    enabled: true,
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
  ownership.settle(relay, "released");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(relay.agentLease, null);
  assert.equal(calls[2][0], "settle");
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
  ownership.settle(relay, "released", "compact");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(relay.agentLease, null);
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
