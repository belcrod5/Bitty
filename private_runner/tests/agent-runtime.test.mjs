import assert from "node:assert/strict";
import test from "node:test";

import { createPrivateRunnerAgentRuntime } from "../src/agent/agent-runtime.mjs";

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
});
