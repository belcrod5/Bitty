import assert from "node:assert/strict";
import test from "node:test";

import { executeCodexTurn } from "../src/codex-turn-execution.mjs";

function fakeClient() {
  const calls = [];
  return {
    calls,
    openPromise: Promise.resolve(),
    notify(method, params) { calls.push({ kind: "notify", method, params }); },
    async request(method, params) {
      calls.push({ kind: "request", method, params });
      if (method === "thread/start") return { thread: { id: "thread-new" } };
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      return {};
    },
    waitForTurnCompletion() { return Promise.resolve(); },
  };
}

test("starts an ordinary new thread and forwards configured turn options", async () => {
  const client = fakeClient();
  const result = await executeCodexTurn({
    client,
    clientName: "location-schedule",
    inputText: "run checks",
    cwd: "/work/project",
    model: "gpt-5.6-sol",
    effort: "high",
    approvalPolicy: "on-request",
  });
  assert.deepEqual(result, { threadId: "thread-new", turnId: "turn-1" });
  assert.equal(client.calls.some((call) => call.method === "thread/resume"), false);
  assert.deepEqual(client.calls.find((call) => call.method === "turn/start")?.params, {
    threadId: "thread-new",
    input: [{ type: "text", text: "run checks" }],
    cwd: "/work/project",
    approvalPolicy: "on-request",
    model: "gpt-5.6-sol",
    effort: "high",
  });
});

test("resumes a queued turn's existing thread through the same operation", async () => {
  const client = fakeClient();
  await executeCodexTurn({
    client,
    clientName: "queued-turn",
    threadId: "thread-existing",
    inputText: "continue",
    cwd: "/work/project",
  });
  assert.equal(client.calls.some((call) => call.method === "thread/start"), false);
  assert.equal(client.calls.find((call) => call.method === "thread/resume")?.params.threadId, "thread-existing");
});
