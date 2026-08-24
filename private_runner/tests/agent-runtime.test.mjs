import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createPrivateRunnerAgentRuntime } from "../src/agent/agent-runtime.mjs";
import { createTurnCompletionNotifier } from "../src/turn-completion-notification.mjs";

function completionClient() {
  const listeners = new Set();
  const requestHandlers = new Set();
  let resolveCompletion;
  return {
    openPromise: Promise.resolve(),
    notify() {},
    async request(method, params) {
      if (method === "thread/start") return { thread: { id: "thread-new" } };
      if (method === "turn/start") {
        queueMicrotask(() => {
          const identity = { threadId: params.threadId, turnId: "turn-1" };
          for (const listener of listeners) {
            listener("item/completed", {
              ...identity,
              item: { id: "message-1", type: "agentMessage", text: "finished" },
            });
            listener("turn/completed", { ...identity, turn: { status: "completed" } });
          }
          resolveCompletion();
        });
        return { turn: { id: "turn-1" } };
      }
      return {};
    },
    waitForTurnCompletion() {
      return {
        promise: new Promise((resolve) => { resolveCompletion = resolve; }),
        expect() {},
      };
    },
    addNotificationListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    addServerRequestHandler(handler) {
      requestHandlers.add(handler);
      return () => requestHandlers.delete(handler);
    },
    close() {},
  };
}

test("Codex Agent history preserves message timestamps", async (t) => {
  const runtime = createPrivateRunnerAgentRuntime({
    claudeBinary: "claude",
    runnerToken: "test-token",
    dynamicTools: null,
    stores: {
      bindSession: async () => ({ status: "bound" }),
      getSessionBinding: async () => null,
      getSessionMode: async () => null,
      acquireSessionLease: async () => ({ status: "acquired", lease: {} }),
      settleSessionLease: async () => ({ status: "released" }),
      updateSessionLeaseIdentity: async () => ({ status: "updated" }),
      handoffSessionMode: async () => ({ status: "handed_off" }),
      recordSessionActivity: async () => ({ status: "updated" }),
      inspectOperation: async () => null,
      claimOperation: async () => ({ status: "claimed" }),
      completeOperation: async () => ({ status: "completed" }),
      listWorkspaces: async () => [],
      approveWorkspace: async () => null,
      revokeWorkspace: async () => false,
      getModelInfo: async () => null,
      setModelInfo: async () => {},
    },
    createCodexClient: () => { throw new Error("not used"); },
    normalizeSessionId: (value) => String(value || ""),
    findSession: async () => ({ sessionId: "thread-1", cwd: "/workspace" }),
    resolveSessionDirectory: (session) => session.cwd,
    listSessions: async () => ({ sessions: [] }),
    listMessages: async () => ({
      modelRef: "gpt-5.6-sol",
      reasoningEffort: "medium",
      messages: [{
        itemId: "message-1",
        role: "assistant",
        content: "hello",
        at: "2026-08-24T01:02:03.456Z",
      }],
    }),
    resolveCanonicalCwd: async (cwd) => cwd,
    parseAuthToken: () => "",
    json: () => {},
    normalizeSessionListLimit: (value) => value,
    normalizeSessionMessagesLimit: (value) => value,
    readJsonBody: async () => ({}),
  });
  t.after(() => runtime.close());

  const history = await runtime.service.readHistory({
    sessionRef: { backendId: "codex", nativeSessionId: "thread-1" },
    limit: 20,
  });

  assert.deepEqual(history.items, [{
    id: "message-1",
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    createdAt: "2026-08-24T01:02:03.456Z",
  }]);
  assert.equal(history.modelId, "gpt-5.6-sol");
  assert.equal(history.reasoningEffort, "medium");
});

test("Agent runtime composes completion notification with the production event fanout", async (t) => {
  const serverRuntime = await readFile(new URL("../src/server-runtime.mjs", import.meta.url), "utf8");
  assert.match(
    serverRuntime,
    /runEventObservers:\s*\[approvalPushService\.onRunEvent, turnCompletionNotifier\.onAgentRunEvent\]/,
  );
  const broadcasts = [];
  const observedTypes = [];
  const notifier = createTurnCompletionNotifier({
    pushEnabled: false,
    pushDeviceStore: {},
    getPushUnreadSnapshot: async () => ({ targetUnread: true, unreadCounts: [] }),
    getAgentSessionBinding: async () => ({ canonicalCwd: "/workspace" }),
    broadcast: (payload) => broadcasts.push(payload),
    log: { warn() {} },
  });
  const runtime = createPrivateRunnerAgentRuntime({
    claudeBinary: "claude",
    runnerToken: "test-token",
    dynamicTools: null,
    stores: {
      bindSession: async () => ({ status: "bound" }),
      getSessionBinding: async () => null,
      getSessionMode: async () => null,
      acquireSessionLease: async () => ({ status: "acquired", lease: { generation: 1 } }),
      settleSessionLease: async () => ({ status: "released" }),
      updateSessionLeaseIdentity: async () => ({ status: "updated" }),
      handoffSessionMode: async () => ({ status: "handed_off" }),
      recordSessionActivity: async () => ({ status: "updated" }),
      inspectOperation: async () => null,
      claimOperation: async () => ({ status: "claimed" }),
      completeOperation: async () => ({ status: "completed" }),
      listWorkspaces: async () => [],
      approveWorkspace: async () => null,
      revokeWorkspace: async () => false,
      getModelInfo: async () => null,
      setModelInfo: async () => {},
    },
    createCodexClient: completionClient,
    normalizeSessionId: (value) => String(value || ""),
    findSession: async () => null,
    resolveSessionDirectory: () => "",
    listSessions: async () => ({ sessions: [] }),
    listMessages: async () => ({ messages: [] }),
    resolveCanonicalCwd: async (cwd) => cwd,
    parseAuthToken: () => "",
    json: () => {},
    normalizeSessionListLimit: (value) => value,
    normalizeSessionMessagesLimit: (value) => value,
    readJsonBody: async () => ({}),
    runEventObservers: [
      (event) => {
        observedTypes.push(event.type);
        if (event.type === "item.completed") throw new Error("observer failure");
      },
      notifier.onAgentRunEvent,
    ],
  });
  t.after(() => runtime.close());

  const run = await runtime.service.startTurn({
    backendId: "codex",
    cwd: "/workspace",
    input: { blocks: [{ type: "text", text: "hello" }] },
    clientOperationId: "operation-1",
  }, { subjectId: runtime.ownerSubjectId });
  assert.equal((await run.completion).outcome, "completed");
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(observedTypes.includes("turn.completed"));
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].backendId, "codex");
  assert.equal(broadcasts[0].sessionId, "thread-new");
  assert.equal(broadcasts[0].previewText, "finished");
});
