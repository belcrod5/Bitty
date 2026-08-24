import assert from "node:assert/strict";
import test from "node:test";

import { createCodexBackend, executeCodexTurn, startCodexTurn } from "../src/codex-turn-execution.mjs";
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

function startCodexActionRun({ method, decision, dynamicTools = null }) {
  const client = fakeClient([]);
  let finishTurn;
  const completion = new Promise((resolve) => { finishTurn = resolve; });
  let nativeResponse;
  const originalRequest = client.request.bind(client);
  client.request = async (requestMethod, params) => {
    if (requestMethod !== "turn/start") return await originalRequest(requestMethod, params);
    client.calls.push({ kind: "request", method: requestMethod, params });
    queueMicrotask(async () => {
      const handler = [...client.serverRequestHandlers][0];
      nativeResponse = await handler({
        id: "native-request-1",
        method,
        params: method === "item/tool/call"
          ? { tool: "calendar_list_calendars", arguments: {} }
          : { reason: "Approve test action" },
      });
      for (const listener of client.listeners) {
        listener("turn/completed", { threadId: params.threadId, turnId: "turn-1", turn: { status: "completed" } });
      }
      finishTurn();
    });
    return { turn: { id: "turn-1" } };
  };
  client.waitForTurnCompletion = () => ({ promise: completion, expect() {} });
  client.close = () => {};
  const backend = createCodexBackend({
    createClient: () => client,
    resolveSessionCwd: async () => "/work/project",
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
    dynamicTools,
    generateActionId: () => "action-1",
  });
  const events = [];
  let resolveRequested;
  const requested = new Promise((resolve) => { resolveRequested = resolve; });
  const turn = backend.startTurn({
    runId: "run-action",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "run checks" }] },
    policyProfileId: "codex-on-request",
    signal: new AbortController().signal,
    resolveSession: async () => {},
    emit(type, payload) {
      events.push({ type, payload });
      if (type === "action.requested") resolveRequested(payload);
    },
  });
  return {
    backend,
    events,
    requested,
    turn,
    nativeResponse: () => nativeResponse,
    respond: async (payload = {}) => {
      const request = await requested;
      await backend.respondToAction({
        runId: "run-action",
        requestId: request.requestId,
        decision,
        ...payload,
      });
      await turn;
      return request;
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
  assert.equal(client.calls.find((call) => call.method === "initialize")?.params.capabilities.experimentalApi, true);
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

test("Codex Backend maps native turn events without changing App Server RPCs", async () => {
  const client = fakeClient([
    { method: "item/agentMessage/delta", params: { itemId: "message-1", delta: "partial" } },
    {
      method: "item/completed",
      params: { item: { id: "message-1", type: "agentMessage", content: [{ type: "text", text: "final" }] } },
    },
    {
      method: "item/completed",
      params: { item: { id: "message-2", type: "agentMessage", content: [{ type: "text", text: "without delta" }] } },
    },
    { method: "turn/completed", params: { turn: { status: "completed" } } },
  ]);
  client.close = () => { client.closed = true; };
  const backend = createCodexBackend({
    createClient: () => client,
    resolveSessionCwd: async () => "/work/project",
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  });
  const events = [];
  const result = await backend.startTurn({
    runId: "run-1",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "run checks" }] },
    policyProfileId: "codex-on-request",
    signal: new AbortController().signal,
    resolveSession: async (sessionRef) => events.push({ type: "session.resolved", payload: { sessionRef } }),
    emit: (type, payload) => events.push({ type, payload }),
  });

  assert.deepEqual(result, { outcome: "completed" });
  assert.deepEqual(events.map((event) => event.type), [
    "session.resolved",
    "turn.started",
    "item.started",
    "content.delta",
    "item.completed",
    "item.started",
    "item.completed",
  ]);
  assert.deepEqual(
    events.filter((event) => event.type === "item.started" || event.type === "item.completed")
      .map((event) => event.payload.itemType),
    ["assistant", "assistant", "assistant", "assistant"],
  );
  assert.equal(events.at(-1).payload.content[0].text, "without delta");
  assert.deepEqual(client.calls.find((call) => call.method === "turn/start")?.params.input, [
    { type: "text", text: "run checks" },
  ]);
  assert.equal(client.closed, true);
});

test("Codex Backend preserves command details in provider-neutral tool events", async () => {
  const client = fakeClient([
    {
      method: "item/started",
      params: { item: { id: "call-1", type: "commandExecution", command: ["find", ".", "-type", "f"] } },
    },
    {
      method: "item/completed",
      params: { item: { id: "call-1", type: "commandExecution", status: "completed", exitCode: 0 } },
    },
    { method: "turn/completed", params: { turn: { status: "completed" } } },
  ]);
  client.close = () => {};
  const backend = createCodexBackend({
    createClient: () => client,
    resolveSessionCwd: async () => "/work/project",
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  });
  const events = [];

  await backend.startTurn({
    runId: "run-command",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "find files" }] },
    policyProfileId: "codex-on-request",
    signal: new AbortController().signal,
    resolveSession: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
  });

  assert.deepEqual(events.filter((event) => event.type.startsWith("tool.")), [
    {
      type: "tool.started",
      payload: {
        toolCallId: "call-1",
        name: "exec_command",
        inputSummary: "find . -type f",
      },
    },
    {
      type: "tool.completed",
      payload: {
        toolCallId: "call-1",
        name: "exec_command",
        inputSummary: "find . -type f",
        status: "completed",
        exitCode: 0,
      },
    },
  ]);
  assert.equal(events.some((event) => event.type === "item.started" || event.type === "item.completed"), false);
});

test("Codex Backend status advertises its full decision superset", async () => {
  const client = fakeClient();
  const backend = createCodexBackend({
    createClient: () => client,
    resolveSessionCwd: async () => "/work/project",
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  });
  const status = await backend.getStatus();
  assert.deepEqual(status.capabilities.action.decisions, ["allow", "allow_for_session", "deny"]);
  assert.deepEqual(status.capabilities.action.policyProfiles[0].decisions, ["allow", "allow_for_session", "deny"]);
});

for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
  test(`Codex Backend maps allow_for_session for ${method}`, async () => {
    const run = startCodexActionRun({ method, decision: "allow_for_session" });
    const requested = await run.respond();
    assert.deepEqual(requested.decisions, ["allow", "allow_for_session", "deny"]);
    assert.deepEqual(run.nativeResponse(), { decision: "acceptForSession" });
    assert.deepEqual(run.events.find((event) => event.type === "action.resolved")?.payload, {
      requestId: "action-1",
      outcome: "allowed",
      decision: "allow_for_session",
    });
  });
}

test("Codex Backend keeps unknown approval methods on one-time allow and deny", async () => {
  const allowed = startCodexActionRun({ method: "item/future/requestApproval", decision: "allow" });
  assert.deepEqual((await allowed.respond()).decisions, ["allow", "deny"]);
  assert.deepEqual(allowed.nativeResponse(), { decision: "accept" });
  assert.deepEqual(allowed.events.find((event) => event.type === "action.resolved")?.payload, {
    requestId: "action-1", outcome: "allowed", decision: "allow",
  });

  const denied = startCodexActionRun({ method: "item/future/requestApproval", decision: "deny" });
  assert.deepEqual((await denied.respond()).decisions, ["allow", "deny"]);
  assert.deepEqual(denied.nativeResponse(), { decision: "decline" });
  assert.deepEqual(denied.events.find((event) => event.type === "action.resolved")?.payload, {
    requestId: "action-1", outcome: "denied", decision: "deny",
  });
});

test("Codex Backend keeps dynamic tool responses on the result path", async () => {
  const dynamicTools = [{ type: "namespace", name: "calendar", tools: [] }];
  const run = startCodexActionRun({ method: "item/tool/call", decision: "result", dynamicTools });
  const result = { success: true, contentItems: [] };
  assert.deepEqual((await run.respond({ result })).decisions, ["result"]);
  assert.deepEqual(run.nativeResponse(), result);
  assert.deepEqual(run.events.find((event) => event.type === "action.resolved")?.payload, {
    requestId: "action-1", outcome: "completed",
  });
});

test("Codex Backend emits turn usage with its context window for the context length display", async () => {
  const client = fakeClient([
    {
      method: "turn/completed",
      params: {
        turn: {
          status: "completed",
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          context_window: 272000,
        },
      },
    },
  ]);
  client.close = () => {};
  const backend = createCodexBackend({
    createClient: () => client,
    resolveSessionCwd: async () => "/work/project",
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  });
  const events = [];
  const result = await backend.startTurn({
    runId: "run-usage",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "run checks" }] },
    policyProfileId: "codex-on-request",
    signal: new AbortController().signal,
    resolveSession: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
  });

  assert.deepEqual(result, { outcome: "completed" });
  const usage = events.find((event) => event.type === "usage.updated")?.payload.usage;
  assert.deepEqual(usage, {
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    context_window: 272000,
  });
});

test("Codex Backend compacts through the existing App Server methods", async () => {
  const client = fakeClient([]);
  client.close = () => {};
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    const result = await request(method, params);
    if (method === "thread/compact/start") {
      for (const listener of client.listeners) listener("thread/compacted", { threadId: params.threadId });
    }
    return result;
  };
  const backend = createCodexBackend({
    createClient: () => client,
    resolveSessionCwd: async () => "/work/project",
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  });

  assert.deepEqual(await backend.compactSession({
    sessionRef: { backendId: "codex", nativeSessionId: "thread-existing" },
  }), {
    sessionRef: { backendId: "codex", nativeSessionId: "thread-existing" },
    method: "thread/compact/start",
    accepted: true,
  });
  assert.deepEqual(client.calls.filter((call) => call.kind === "request").map((call) => call.method), [
    "initialize", "thread/read", "thread/resume", "thread/compact/start",
  ]);
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
  assert.deepEqual(client.calls.find((call) => call.method === "thread/resume")?.params, {
    threadId: "thread-existing",
    cwd: "/work/project",
    excludeTurns: true,
  });
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
