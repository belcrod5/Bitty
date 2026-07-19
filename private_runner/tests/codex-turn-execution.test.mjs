import assert from "node:assert/strict";
import test from "node:test";

import { executeCodexTurn } from "../src/codex-turn-execution.mjs";

function fakeClient(notifications = [{ method: "turn/completed", params: {} }]) {
  const calls = [];
  const listeners = new Set();
  return {
    calls,
    listeners,
    openPromise: Promise.resolve(),
    notify(method, params) { calls.push({ kind: "notify", method, params }); },
    async request(method, params) {
      calls.push({ kind: "request", method, params });
      if (method === "thread/start") return { thread: { id: "thread-new" } };
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      if (method === "turn/start") {
        for (const notification of notifications) {
          for (const listener of listeners) listener(notification.method, notification.params);
        }
        return { turn: { id: "turn-1" } };
      }
      return {};
    },
    waitForTurnCompletion() { return Promise.resolve(); },
    addNotificationListener(listener) {
      calls.push({ kind: "listener-added" });
      listeners.add(listener);
      return () => {
        calls.push({ kind: "listener-removed" });
        listeners.delete(listener);
      };
    },
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
  assert.deepEqual(result, { threadId: "thread-new", turnId: "turn-1", lastAgentMessageText: "" });
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

test("captures the final agent message and removes its notification listener", async () => {
  const client = fakeClient([
    { method: "item/agentMessage/delta", params: { delta: "partial " } },
    { method: "item/agentMessage/delta", params: { delta: "answer" } },
    { method: "item/completed", params: { item: { type: "commandExecution", text: "ignored" } } },
    {
      method: "item/completed",
      params: { item: { type: "agentMessage", content: [{ type: "text", text: "final answer" }] } },
    },
    { method: "turn/completed", params: {} },
  ]);

  const result = await executeCodexTurn({
    client,
    clientName: "location-schedule",
    inputText: "run",
    cwd: "/work/project",
  });

  assert.equal(result.lastAgentMessageText, "final answer");
  assert.equal(client.calls.findIndex((call) => call.kind === "listener-added")
    < client.calls.findIndex((call) => call.method === "turn/start"), true);
  assert.equal(client.calls.filter((call) => call.kind === "listener-removed").length, 1);
  assert.equal(client.listeners.size, 0);
});

test("treats an interrupted turn as failure and still removes its listener", async () => {
  const client = fakeClient([
    { method: "item/agentMessage/delta", params: { delta: "incomplete" } },
    { method: "turn/interrupted", params: {} },
  ]);

  await assert.rejects(
    executeCodexTurn({ client, clientName: "queued-turn", inputText: "run", cwd: "/work/project" }),
    /ended without completing/
  );
  assert.equal(client.calls.filter((call) => call.kind === "listener-removed").length, 1);
  assert.equal(client.listeners.size, 0);
});

test("does not treat a failed turn/completed payload as success", async () => {
  const client = fakeClient([
    { method: "item/agentMessage/delta", params: { delta: "failed response" } },
    { method: "turn/completed", params: { turn: { status: "failed" } } },
  ]);
  await assert.rejects(
    executeCodexTurn({ client, clientName: "location-schedule", inputText: "run", cwd: "/work/project" }),
    /ended without completing/
  );
});

test("requires a notification listener API so completion capture cannot be skipped", async () => {
  const client = fakeClient();
  delete client.addNotificationListener;
  await assert.rejects(
    executeCodexTurn({ client, clientName: "location-schedule", inputText: "run", cwd: "/work/project" }),
    /client\.addNotificationListener is required/
  );
});
