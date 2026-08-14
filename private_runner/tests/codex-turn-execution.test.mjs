import assert from "node:assert/strict";
import test from "node:test";

import { executeCodexTurn, startCodexTurn } from "../src/codex-turn-execution.mjs";
import { calendarScheduleDynamicTools } from "../src/calendar-tool-service.mjs";

function fakeClient(notifications = [{ method: "turn/completed", params: {} }]) {
  const calls = [];
  const listeners = new Set();
  const serverRequestHandlers = new Set();
  return {
    calls,
    listeners,
    serverRequestHandlers,
    serverResponses: [],
    openPromise: Promise.resolve(),
    notify(method, params) { calls.push({ kind: "notify", method, params }); },
    async request(method, params) {
      calls.push({ kind: "request", method, params });
      if (method === "thread/start") return { thread: { id: "thread-new" } };
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      if (method === "modelProvider/capabilities/read") return { namespaceTools: true };
      if (method === "plugin/list") return { marketplaces: [] };
      if (method === "mcpServerStatus/list") return { data: [], nextCursor: null };
      if (method === "turn/start") {
        if (this.serverRequest) {
          for (const handler of serverRequestHandlers) {
            this.serverResponses.push({ id: this.serverRequest.id, result: await handler(this.serverRequest) });
          }
        }
        for (const notification of notifications) {
          const paramsWithOwner = {
            threadId: params.threadId,
            turnId: "turn-1",
            ...notification.params,
          };
          for (const listener of listeners) listener(notification.method, paramsWithOwner);
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
    addServerRequestHandler(handler) {
      serverRequestHandlers.add(handler);
      return () => serverRequestHandlers.delete(handler);
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

test("starts a turn without requiring or waiting for completion APIs", async () => {
  const client = fakeClient([]);
  delete client.addNotificationListener;
  delete client.waitForTurnCompletion;

  const result = await startCodexTurn({
    client,
    clientName: "scheduled-turn",
    inputText: "run checks",
    cwd: "/work/project",
    model: "gpt-5.6-sol",
    effort: "high",
  });

  assert.equal(result.threadId, "thread-new");
  assert.equal(result.turnId, "turn-1");
  assert.equal(typeof result.cleanup, "function");
  assert.equal(client.calls.filter((call) => call.method === "turn/start").length, 1);
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

test("ignores child subagent events until the requested parent thread and turn complete", async () => {
  const client = fakeClient([
    {
      method: "item/agentMessage/delta",
      params: { threadId: "child-thread", turnId: "child-turn", delta: "child answer" },
    },
    {
      method: "turn/completed",
      params: { threadId: "child-thread", turnId: "child-turn", turn: { status: "completed" } },
    },
    {
      method: "item/agentMessage/delta",
      params: { delta: "parent answer" },
    },
    {
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    },
  ]);

  const result = await executeCodexTurn({
    client,
    clientName: "queued-turn",
    inputText: "run",
    cwd: "/work/project",
  });

  assert.equal(result.lastAgentMessageText, "parent answer");
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

test("calendar schedules create a closed-down thread with only three dynamic tools", async () => {
  const client = fakeClient();
  const originalRequest = client.request;
  client.request = async (method, params) => {
    if (method === "plugin/list") {
      client.calls.push({ kind: "request", method, params });
      return { marketplaces: [{ name: "marketplace-a", path: "/plugins/marketplace-a", plugins: [{ name: "plugin-a", enabled: true }] }] };
    }
    return originalRequest.call(client, method, params);
  };
  client.serverRequest = {
    id: "server-request-42",
    method: "item/tool/call",
    params: { tool: "calendar_list_calendars", callId: "call", threadId: "thread-new", turnId: "turn-1", namespace: "calendar", arguments: {} },
  };
  let handled = null;
  const result = await executeCodexTurn({
    client,
    clientName: "calendar-schedule",
    inputText: "read my calendar",
    cwd: "/empty",
    approvalPolicy: "never",
    calendarSchedule: {
      ruleId: "rule-1",
      ruleRevision: "revision-1",
      deviceId: "device-1",
      dynamicTools: calendarScheduleDynamicTools(),
      handleServerRequest: async (request) => {
        handled = request;
        return { success: true, contentItems: [{ type: "inputText", text: "{}" }] };
      },
    },
  });

  assert.equal(result.threadId, "thread-new");
  assert.equal(client.calls.find((call) => call.method === "initialize")?.params.capabilities.experimentalApi, true);
  assert.deepEqual(client.calls.filter((call) => call.method === "config/read").length, 1);
  assert.deepEqual(client.calls.filter((call) => call.method === "plugin/list").length, 1);
  assert.deepEqual(client.calls.find((call) => call.method === "plugin/read")?.params, { pluginName: "plugin-a", marketplacePath: "/plugins/marketplace-a" });
  const start = client.calls.find((call) => call.method === "thread/start")?.params;
  assert.equal(start.dynamicTools.length, 1);
  assert.equal(start.dynamicTools[0].type, "namespace");
  assert.equal(start.dynamicTools[0].name, "calendar");
  assert.deepEqual(start.dynamicTools[0].tools.map((tool) => tool.name), [
    "calendar_list_calendars", "calendar_search_events", "calendar_get_event",
  ]);
  assert.equal(start.dynamicTools[0].tools.every((tool) => tool.deferLoading === true), true);
  assert.equal(start.config.web_search, "disabled");
  assert.deepEqual(start.config.apps, { _default: { enabled: false, approvals_reviewer: null, destructive_enabled: false, open_world_enabled: false, default_tools_approval_mode: null } });
  assert.match(start.developerInstructions, /untrusted external data/);
  const turn = client.calls.find((call) => call.method === "turn/start")?.params;
  assert.deepEqual(turn.sandboxPolicy, {
    type: "externalSandbox",
    networkAccess: "restricted",
  });
  assert.equal(client.calls.findIndex((call) => call.method === "mcpServerStatus/list")
    < client.calls.findIndex((call) => call.method === "turn/start"), true);
  assert.equal(handled.id, "server-request-42");
  assert.equal(handled.ruleId, "rule-1");
  assert.deepEqual(client.serverResponses, [{
    id: "server-request-42",
    result: { success: true, contentItems: [{ type: "inputText", text: "{}" }] },
  }]);
});

test("calendar schedules fail closed before turn/start when MCP status is not empty", async () => {
  const client = fakeClient();
  const originalRequest = client.request;
  client.request = async (method, params) => (
    method === "mcpServerStatus/list" ? { data: [{ name: "forbidden" }], nextCursor: null } : originalRequest.call(client, method, params)
  );
  await assert.rejects(
    executeCodexTurn({
      client, clientName: "calendar-schedule", inputText: "read", cwd: "/empty", calendarSchedule: {
        ruleId: "rule", ruleRevision: "revision", deviceId: "device", dynamicTools: calendarScheduleDynamicTools(), handleServerRequest: async () => ({}),
      },
    }),
    /calendar_api_failed/
  );
  assert.equal(client.calls.some((call) => call.method === "turn/start"), false);
  assert.equal(client.serverRequestHandlers.size, 0);
});

test("calendar thread-start incompatibility is explicit and never falls back", async () => {
  const client = fakeClient();
  const originalRequest = client.request;
  client.request = async (method, params) => {
    if (method === "thread/start") {
      client.calls.push({ kind: "request", method, params });
      throw new Error("unsupported dynamic tools");
    }
    return originalRequest.call(client, method, params);
  };
  await assert.rejects(
    executeCodexTurn({
      client, clientName: "calendar-schedule", inputText: "read", cwd: "/empty", calendarSchedule: {
        ruleId: "rule", ruleRevision: "revision", deviceId: "device", dynamicTools: calendarScheduleDynamicTools(), handleServerRequest: async () => ({}),
      },
    }),
    /codex_dynamic_tools_incompatible.*thread_start/
  );
  assert.equal(client.calls.filter((call) => call.method === "thread/start").length, 1);
  assert.equal(client.calls.some((call) => call.method === "thread/resume"), false);
  assert.equal(client.serverRequestHandlers.size, 0);
});

test("calendar schedules fail clearly when namespace tools are unavailable", async () => {
  const client = fakeClient();
  const originalRequest = client.request;
  client.request = async (method, params) => (
    method === "modelProvider/capabilities/read"
      ? { namespaceTools: false }
      : originalRequest.call(client, method, params)
  );

  await assert.rejects(
    executeCodexTurn({
      client, clientName: "calendar-schedule", inputText: "read", cwd: "/empty", calendarSchedule: {
        ruleId: "rule", ruleRevision: "revision", deviceId: "device", dynamicTools: calendarScheduleDynamicTools(), handleServerRequest: async () => ({}),
      },
    }),
    /codex_dynamic_tools_incompatible.*thread_start/
  );
  assert.equal(client.calls.some((call) => call.method === "thread/start"), false);
});

test("calendar schedules report capability API incompatibility clearly", async () => {
  const client = fakeClient();
  const originalRequest = client.request;
  client.request = async (method, params) => {
    if (method === "modelProvider/capabilities/read") throw new Error("unsupported method");
    return originalRequest.call(client, method, params);
  };

  await assert.rejects(
    executeCodexTurn({
      client, clientName: "calendar-schedule", inputText: "read", cwd: "/empty", calendarSchedule: {
        ruleId: "rule", ruleRevision: "revision", deviceId: "device", dynamicTools: calendarScheduleDynamicTools(), handleServerRequest: async () => ({}),
      },
    }),
    /codex_dynamic_tools_incompatible.*thread_start/
  );
  assert.equal(client.calls.some((call) => call.method === "thread/start"), false);
});
