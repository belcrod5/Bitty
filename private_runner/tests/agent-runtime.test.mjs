import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import test from "node:test";

import { createPrivateRunnerAgentRuntime } from "../src/agent/agent-runtime.mjs";
import { ClientStateStoreUnavailableError } from "../src/client-state-store.mjs";
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

test("Codex Agent history preserves timestamps and unavailable client titles fall back", async (t) => {
  const canonicalWorkspace = await realpath(".");
  const aliasWorkspace = `${canonicalWorkspace}/.`;
  let titleLookupError = null;
  const warnings = [];
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
      setSessionSettings: async () => ({ status: "updated" }),
      recordSessionActivity: async () => ({ status: "updated" }),
      getSessionReadState: async () => null,
      inspectOperation: async () => null,
      claimOperation: async () => ({ status: "claimed" }),
      completeOperation: async () => ({ status: "completed" }),
      listWorkspaces: async () => [],
      listRegisteredDirectories: async () => [canonicalWorkspace],
      approveWorkspace: async () => null,
      revokeWorkspace: async () => false,
      getModelInfo: async () => null,
      setModelInfo: async () => {},
    },
    createCodexClient: () => { throw new Error("not used"); },
    listCodexModels: async () => [],
    normalizeSessionId: (value) => String(value || ""),
    findSession: async () => ({ sessionId: "thread-1", cwd: canonicalWorkspace }),
    resolveSessionDirectory: (session) => session.cwd,
    listSessions: async () => ({
      sessions: [{
        sessionId: "thread-1",
        directory: canonicalWorkspace,
        firstUserMessage: "Native title",
        updatedAt: "2026-08-24T02:00:00.000Z",
        lastReadAt: "2026-08-24T03:00:00.000Z",
      }],
    }),
    getSessionTitles: async () => {
      if (titleLookupError) throw titleLookupError;
      return ["Shared title"];
    },
    listSessionsForDirectories: async (directories) => directories.map((directory) => ({
      directory,
      sessions: [{
        sessionId: "batch-thread",
        cwd: aliasWorkspace,
        createdAt: "2026-08-24T01:00:00.000Z",
        updatedAt: "2026-08-24T04:00:00.000Z",
      }],
    })),
    listMessages: async () => ({
      modelRef: "gpt-5.6-sol",
      reasoningEffort: "medium",
      messages: [{
        itemId: "message-1",
        role: "assistant",
        content: "hello",
        at: "2026-08-24T01:02:03.456Z",
        outputTokens: 8,
      }],
    }),
    resolveCanonicalCwd: async (cwd) => cwd === aliasWorkspace ? canonicalWorkspace : cwd,
    parseAuthToken: () => "",
    json: () => {},
    normalizeSessionListLimit: (value) => value,
    normalizeSessionMessagesLimit: (value) => value,
    readJsonBody: async () => ({}),
    log: { warn: (message) => warnings.push(String(message)) },
  });
  t.after(() => runtime.close());

  const listed = await runtime.service.listSessions({ backendId: "codex", cwd: canonicalWorkspace });
  assert.equal(listed.sessions[0].lastReadAt, "2026-08-24T03:00:00.000Z");
  assert.equal(listed.sessions[0].title, "Shared title");
  titleLookupError = new ClientStateStoreUnavailableError(new Error("invalid client state store"));
  const fallback = await runtime.service.listSessions({ backendId: "codex", cwd: canonicalWorkspace });
  assert.equal(fallback.sessions[0].title, "Native title");
  assert.match(warnings[0], /client state titles unavailable:.*invalid client state store/);
  titleLookupError = new Error("programmer error");
  await assert.rejects(
    runtime.service.listSessions({ backendId: "codex", cwd: canonicalWorkspace }),
    /programmer error/,
  );

  const snapshot = await runtime.service.listSessionSnapshot({
    backendId: "codex",
    cwds: [aliasWorkspace],
  });
  assert.equal(snapshot.groups[0].cwd, canonicalWorkspace);
  assert.equal(snapshot.groups[0].sessions[0].canonicalCwd, canonicalWorkspace);
  assert.equal(snapshot.groups[0].sessions[0].createdAt, "2026-08-24T01:00:00.000Z");

  const history = await runtime.service.readHistory({
    sessionRef: { backendId: "codex", nativeSessionId: "thread-1" },
    limit: 20,
  });

  assert.deepEqual(history.items, [{
    id: "message-1",
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    createdAt: "2026-08-24T01:02:03.456Z",
    outputTokens: 8,
  }]);
  assert.equal(history.modelId, "gpt-5.6-sol");
  assert.equal(history.reasoningEffort, "medium");
});

test("resumed Codex main run warms a cold identity index before active classification", async (t) => {
  const cwd = await realpath(".");
  let cachedEntry = null;
  let resolveClient;
  const pendingClient = new Promise((resolve) => { resolveClient = resolve; });
  const runtime = createPrivateRunnerAgentRuntime({
    claudeBinary: "claude", runnerToken: "test-token", dynamicTools: null,
    stores: {
      bindSession: async () => ({ status: "bound" }),
      getSessionBinding: async () => ({ canonicalCwd: cwd }),
      getSessionMode: async () => ({ mode: "neutral" }),
      acquireSessionLease: async () => ({ status: "acquired", lease: { generation: 1 } }),
      settleSessionLease: async () => ({ status: "released" }),
      updateSessionLeaseIdentity: async () => ({ status: "updated" }),
      handoffSessionMode: async () => ({ status: "handed_off" }),
      setSessionSettings: async () => ({ status: "updated" }),
      recordSessionActivity: async () => ({ status: "updated" }),
      getSessionReadState: async () => null,
      inspectOperation: async () => null,
      claimOperation: async () => ({ status: "claimed" }),
      completeOperation: async () => ({ status: "completed" }),
      listWorkspaces: async () => [],
      listRegisteredDirectories: async () => [cwd],
      approveWorkspace: async () => null,
      revokeWorkspace: async () => false,
      getModelInfo: async () => null,
      setModelInfo: async () => {},
    },
    createCodexClient: () => ({ ...completionClient(), openPromise: pendingClient }),
    listCodexModels: async () => [], normalizeSessionId: (value) => String(value || ""),
    findSession: async () => { cachedEntry = { sessionId: "main-session", cwd, isSubagent: false }; return cachedEntry; },
    selectCachedSession: () => cachedEntry,
    resolveSessionDirectory: (entry) => entry.cwd,
    listSessions: async () => ({ sessions: [] }),
    listSessionsForDirectories: async (cwds) => cwds.map((directory) => ({ directory, sessions: [] })),
    listMessages: async () => ({ messages: [] }),
    resolveCanonicalCwd: async (cwd) => cwd,
    getRegisteredDirectoryPaths: async () => [cwd],
    parseAuthToken: () => "", json: () => {}, normalizeSessionListLimit: (value) => value,
    normalizeSessionMessagesLimit: (value) => value, readJsonBody: async () => ({}),
  });
  t.after(() => { resolveClient(); return runtime.close(); });
  const run = await runtime.service.startTurn({
    backendId: "codex", sessionRef: { backendId: "codex", nativeSessionId: "main-session" },
    cwd, input: { blocks: [{ type: "text", text: "hello" }] }, clientOperationId: "op-cold-cache",
  }, { subjectId: runtime.ownerSubjectId });
  assert.equal(cachedEntry.isSubagent, false);
  assert.deepEqual(await runtime.service.countActiveSessions({ cwds: [cwd] },
    { subjectId: runtime.ownerSubjectId }), { count: 1 });
  void run.completion;
});

test("Agent runtime composes completion notification with the production event fanout", async (t) => {
  const serverRuntime = await readFile(new URL("../src/server-runtime.mjs", import.meta.url), "utf8");
  assert.match(
    serverRuntime,
    /runEventObservers:\s*\[approvalPushService\.onRunEvent, turnCompletionNotifier\.onAgentRunEvent\]/,
  );
  const broadcasts = [];
  const observedTypes = [];
  const warnings = [];
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
      setSessionSettings: async () => ({ status: "updated" }),
      recordSessionActivity: async () => ({ status: "updated" }),
      getSessionReadState: async () => null,
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
    listCodexModels: async () => [],
    normalizeSessionId: (value) => String(value || ""),
    findSession: async () => null,
    resolveSessionDirectory: () => "",
    listSessions: async () => ({ sessions: [] }),
    listSessionsForDirectories: async (directories) => directories.map((directory) => ({
      directory,
      sessions: [],
    })),
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
    log: { warn: (message) => warnings.push(String(message)) },
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
  // 一部observerの失敗は他observer(通知)を止めず、無音破棄もされない
  assert.match(
    warnings.join("\n"),
    /run event observer failed type=item\.completed run=.*: observer failure/,
  );
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].backendId, "codex");
  assert.equal(broadcasts[0].sessionId, "thread-new");
  assert.equal(broadcasts[0].previewText, "finished");
});
