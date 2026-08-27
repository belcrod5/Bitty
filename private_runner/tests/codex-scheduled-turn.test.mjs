import assert from "node:assert/strict";
import test from "node:test";

import { createScheduledCodexTurnStarter } from "../src/codex-scheduled-turn.mjs";

function deferred() {
  let resolve;
  return { promise: new Promise((done) => { resolve = done; }), resolve };
}

test("scheduled turns resume the requested session and subscribe only to dynamic tools", async () => {
  const completion = deferred();
  let startRequest;
  let subscribeOptions;
  const service = {
    async startTurn(request) {
      startRequest = request;
      return { runId: "run-1", completion: completion.promise };
    },
    subscribe(_runId, options) {
      subscribeOptions = options;
      options.onEvent({
        type: "session.resolved",
        payload: { sessionRef: { backendId: "codex", nativeSessionId: "thread-existing" } },
      });
      options.onEvent({ type: "turn.started", payload: { nativeTurnId: "turn-1" } });
      return { activeActions: [], unsubscribe() {} };
    },
  };
  const start = createScheduledCodexTurnStarter({
    agentService: service,
    subjectId: "owner",
    dynamicToolResponse: () => ({ ok: true }),
  });

  const result = await start({
    inputText: "check project",
    cwd: "/work/project",
    model: "gpt-5.6",
    effort: "high",
    threadId: "thread-existing",
    clientOperationId: "schedule:1",
  });

  assert.deepEqual(result, { threadId: "thread-existing", turnId: "turn-1" });
  assert.deepEqual(startRequest.sessionRef, {
    backendId: "codex", nativeSessionId: "thread-existing",
  });
  assert.equal(startRequest.policyProfileId, "codex-on-request");
  assert.equal(subscribeOptions.actionScope, "dynamic_tool");
  completion.resolve({ outcome: "completed" });
});

test("scheduled turns execute dynamic tools without claiming approvals", async () => {
  const completion = deferred();
  const calls = [];
  const service = {
    async startTurn() {
      return { runId: "run-2", completion: completion.promise };
    },
    subscribe(_runId, options) {
      options.onEvent({
        type: "session.resolved",
        payload: { sessionRef: { backendId: "codex", nativeSessionId: "thread-new" } },
      });
      options.onEvent({ type: "turn.started", payload: { nativeTurnId: "turn-2" } });
      return {
        activeActions: [{
          requestId: "tool-1",
          kind: "dynamic_tool",
          input: { method: "calendar/list", params: { date: "2026-08-27" } },
        }],
        unsubscribe() {},
      };
    },
    async claimAction(request, context) { calls.push(["claim", request, context]); },
    async respondToAction(request, context) { calls.push(["respond", request, context]); },
    async interrupt() { calls.push(["interrupt"]); },
  };
  const start = createScheduledCodexTurnStarter({
    agentService: service,
    subjectId: "owner",
    dynamicToolResponse: (request) => ({ handled: request.method }),
  });

  await start({
    inputText: "check calendar",
    cwd: "/work/project",
    clientOperationId: "schedule:2",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.map(([kind]) => kind), ["claim", "respond"]);
  assert.equal(calls[1][1].decision, "result");
  assert.deepEqual(calls[1][1].result, { handled: "calendar/list" });
  completion.resolve({ outcome: "completed" });
});

test("raw targets remain unsupported instead of being migrated", async () => {
  const service = {
    async startTurn() {
      const error = new Error("session requires an explicit neutral handoff");
      error.code = "session_busy";
      throw error;
    },
  };
  const start = createScheduledCodexTurnStarter({
    agentService: service,
    subjectId: "owner",
    dynamicToolResponse: () => ({}),
  });

  await assert.rejects(start({
    inputText: "old session",
    cwd: "/work/project",
    threadId: "raw-thread",
    clientOperationId: "schedule:3",
  }), (error) => error.code === "session_busy");
});
