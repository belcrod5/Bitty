import assert from "node:assert/strict";
import test from "node:test";

import { createCodexBackend, executeCodexTurn, startCodexTurn } from "../src/codex-turn-execution.mjs";
import { CONVERSATION_HISTORY_TOOL_INSTRUCTIONS } from "../src/agent/agent-runtime.mjs";

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
      if (method === "model/list") return { data: [], nextCursor: null };
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
    close() {},
  };
}

function startCodexActionRun({ method, decision, dynamicTools = null, requestParams }) {
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
        params: requestParams || (method === "item/tool/call"
          ? { tool: "calendar_list_calendars", arguments: {} }
          : { reason: "Approve test action" }),
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
    client,
    complete() {
      for (const listener of client.listeners) {
        listener("turn/completed", { threadId: "thread-new", turnId: "turn-1", turn: { status: "completed" } });
      }
      finishTurn();
    },
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

const questionParams = {
  threadId: "thread-new", turnId: "turn-1", itemId: "question-item", isBlocking: true,
  questions: [{ id: "q1", header: "Choice", question: "Which?", isOther: true, isSecret: false,
    options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }] }],
};

for (const foreignIdentity of [{ threadId: "other-thread" }, { turnId: "other-turn" }]) {
  test(`questions outside the active ${Object.keys(foreignIdentity)[0]} settle without being announced`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
    const run = startCodexActionRun({ method: "item/tool/requestUserInput",
      requestParams: { ...questionParams, ...foreignIdentity } });
    await run.turn;
    assert.deepEqual(run.nativeResponse(), { answers: {} });
    t.mock.timers.tick(60_000);
    assert.equal(run.events.some((event) => event.type.startsWith("action.")), false);
  });
}

test("Codex questions use the existing result action and preserve the native request", async () => {
  const run = startCodexActionRun({ method: "item/tool/requestUserInput", decision: "result", requestParams: questionParams });
  const result = { answers: { q1: { answers: ["B"] } } };
  const request = await run.respond({ result });
  assert.equal(request.kind, "user_input");
  assert.deepEqual(request.decisions, ["result"]);
  assert.equal(typeof request.startedAtMs, "number");
  assert.deepEqual(request.input, { method: "item/tool/requestUserInput", params: questionParams });
  assert.deepEqual(run.nativeResponse(), result);
  assert.equal(run.events.filter((event) => event.type === "action.resolved").length, 1);
  assert.equal(run.events.find((event) => event.type === "action.resolved").payload.outcome, "completed");
});

test("declining a question returns empty answers without interrupting the turn", async () => {
  const run = startCodexActionRun({ method: "item/tool/requestUserInput", decision: "result", requestParams: questionParams });
  await run.respond({ result: { answers: {} } });
  assert.deepEqual(run.nativeResponse(), { answers: {} });
  assert.equal(run.events.find((event) => event.type === "action.resolved").payload.outcome, "skipped");
  assert.equal(run.client.calls.some((call) => call.method === "turn/interrupt"), false);
});

test("an invalid question answer does not consume the request and a last-second answer clears its timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const run = startCodexActionRun({ method: "item/tool/requestUserInput", decision: "result", requestParams: questionParams });
  await run.requested;
  await assert.rejects(run.backend.respondToAction({ runId: "run-action", requestId: "action-1", decision: "result",
    result: { answers: { unknown_question: { answers: ["A"] } } } }), /Invalid Codex question answers/);
  t.mock.timers.tick(59_999);
  await run.respond({ result: { answers: { q1: { answers: ["A"] } } } });
  t.mock.timers.tick(1);
  assert.deepEqual(run.nativeResponse(), { answers: { q1: { answers: ["A"] } } });
  assert.deepEqual(run.events.filter((event) => event.type === "action.resolved").map((event) => event.payload.outcome), ["completed"]);
});

for (const isBlocking of [true, false]) {
  test(`unanswered ${isBlocking ? "blocking" : "nonblocking"} questions expire at 60 seconds without a client`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
    const run = startCodexActionRun({ method: "item/tool/requestUserInput", requestParams: { ...questionParams, isBlocking } });
    const request = await run.requested;
    assert.equal(request.startedAtMs, 1000);
    t.mock.timers.tick(59_999);
    assert.equal(run.events.some((event) => event.type === "action.resolved"), false);
    t.mock.timers.tick(1);
    await run.turn;
    assert.deepEqual(run.nativeResponse(), { answers: {} });
    assert.deepEqual(run.events.filter((event) => event.type === "action.resolved").map((event) => event.payload), [
      { requestId: "action-1", outcome: "expired" },
    ]);
    await assert.rejects(run.backend.respondToAction({ runId: "run-action", requestId: "action-1", decision: "result", result: { answers: {} } }));
  });
}

test("native question resolution without a turnId clears its timer and resolves only once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const run = startCodexActionRun({ method: "item/tool/requestUserInput", requestParams: questionParams });
  await run.requested;
  for (const listener of run.client.listeners) {
    listener("serverRequest/resolved", { threadId: "other-thread", requestId: "native-request-1" });
  }
  assert.equal(run.events.some((event) => event.type === "action.resolved"), false);
  for (const listener of run.client.listeners) {
    listener("serverRequest/resolved", { threadId: "thread-new", requestId: "native-request-1" });
  }
  await run.turn;
  t.mock.timers.tick(60_000);
  assert.equal(run.events.filter((event) => event.type === "action.resolved").length, 1);
});

test("turn completion clears a pending question and its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const run = startCodexActionRun({ method: "item/tool/requestUserInput", requestParams: questionParams });
  await run.requested;
  run.complete();
  await run.turn;
  t.mock.timers.tick(60_000);
  assert.equal(run.events.filter((event) => event.type === "action.resolved").length, 1);
  assert.deepEqual(run.nativeResponse(), { answers: {} });
});

test("an answer after the deadline is rejected even before the timer callback runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const run = startCodexActionRun({ method: "item/tool/requestUserInput", requestParams: questionParams });
  await run.requested;
  t.mock.timers.setTime(61_000);
  await assert.rejects(run.backend.respondToAction({ runId: "run-action", requestId: "action-1", decision: "result",
    result: { answers: { q1: { answers: ["A"] } } } }), (error) => error.code === "action_expired");
  await run.turn;
  assert.deepEqual(run.nativeResponse(), { answers: {} });
});

test("starts an unattended new thread with questions disabled and forwards turn options", async () => {
  const client = fakeClient();
  const result = await executeCodexTurn({
    client,
    clientName: "queued-turn",
    inputText: "run checks",
    cwd: "/work/project",
    model: "gpt-5.6-sol",
    effort: "high",
    approvalPolicy: "on-request",
  });
  assert.deepEqual(result, { threadId: "thread-new", turnId: "turn-1", lastAgentMessageText: "" });
  assert.deepEqual(client.calls.find((call) => call.method === "thread/start")?.params.config, {
    "features.default_mode_request_user_input": false,
  });
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
  assert.deepEqual(client.calls.find((call) => call.method === "thread/start")?.params.config, {
    "features.default_mode_request_user_input": false,
  });
  assert.equal(result.turnId, "turn-1");
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

test("Codex Backend tracks native thread activity for session list annotations", async () => {
  const client = fakeClient([]);
  let finishTurn;
  const completion = new Promise((resolve) => { finishTurn = resolve; });
  client.waitForTurnCompletion = () => ({ promise: completion, expect() {} });
  client.close = () => {};
  const backend = createCodexBackend({
    createClient: () => client,
    resolveSessionCwd: async () => "/work/project",
    listSessions: async () => ({
      sessions: [
        { sessionRef: { backendId: "codex", nativeSessionId: "subagent-thread" }, canonicalCwd: "/work/project" },
        { sessionRef: { backendId: "codex", nativeSessionId: "other-thread" }, canonicalCwd: "/work/project" },
      ],
    }),
    listSessionsForDirectories: async () => ({
      groups: [{
        cwd: "/work/project",
        sessions: [{ sessionRef: { backendId: "codex", nativeSessionId: "subagent-thread" }, canonicalCwd: "/work/project" }],
      }],
    }),
    readHistory: async () => ({ items: [] }),
  });
  const turn = backend.startTurn({
    runId: "run-live",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "spawn subagents" }] },
    policyProfileId: "codex-on-request",
    signal: new AbortController().signal,
    resolveSession: async () => {},
    emit() {},
  });
  while (!client.calls.some((call) => call.method === "turn/start")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  // spawnされたsubagent thread(親turnとthreadId不一致)のstatus通知を配信する
  for (const listener of [...client.listeners]) {
    listener("thread/status/changed", { threadId: "subagent-thread", status: "active" });
  }
  const during = await backend.listSessions({ cwd: "/work/project" });
  assert.deepEqual(
    during.sessions.map((session) => [session.sessionRef.nativeSessionId, session.isActive === true]),
    [["subagent-thread", true], ["other-thread", false]],
  );
  const grouped = await backend.listSessionsForDirectories({ cwds: ["/work/project"] });
  assert.equal(grouped.groups[0].sessions[0].isActive, true);

  // idle通知(object status形)で解除される
  for (const listener of [...client.listeners]) {
    listener("thread/status/changed", { threadId: "subagent-thread", status: { type: "idle" } });
  }
  assert.equal((await backend.listSessions({ cwd: "/work/project" })).sessions[0].isActive, undefined);

  // turn接続が全て閉じたらstale activeを残さない
  for (const listener of [...client.listeners]) {
    listener("thread/status/changed", { threadId: "subagent-thread", status: "active" });
  }
  for (const listener of [...client.listeners]) {
    listener("turn/completed", { threadId: "thread-new", turnId: "turn-1", turn: { status: "completed" } });
  }
  finishTurn();
  assert.equal((await turn).outcome, "completed");
  assert.equal((await backend.listSessions({ cwd: "/work/project" })).sessions[0].isActive, undefined);
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

test("Codex Backend derives every visible model and its efforts from app-server", async () => {
  const client = fakeClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method !== "model/list") return await request(method, params);
    client.calls.push({ kind: "request", method, params });
    if (!params.cursor) {
      return {
        data: [
          {
            id: "legacy-astra-id",
            model: "gpt-6-astra",
            displayName: "GPT-6 Astra — Upstream",
            supportedReasoningEfforts: [
              { reasoningEffort: "LOW" },
              { reasoningEffort: "max" },
              { reasoningEffort: "ultra" },
              { reasoningEffort: "unsupported" },
            ],
          },
          { model: "hidden-model", displayName: "Hidden", hidden: true },
          { id: "", model: "", displayName: "Missing ID" },
        ],
        nextCursor: "page-2",
      };
    }
    return {
      data: [{
        id: "gpt-5.6-luna",
        displayName: "",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      }],
      nextCursor: null,
    };
  };
  let closeCalls = 0;
  client.close = () => { closeCalls += 1; };
  const backend = createCodexBackend({
    createClient: () => client,
    resolveSessionCwd: async () => "/work/project",
  });

  const status = await backend.getStatus();
  const listed = await backend.listModels();
  const expected = [
    { modelId: "gpt-6-astra", label: "GPT-6 Astra — Upstream", effortOptions: ["low", "max", "ultra"] },
    { modelId: "gpt-5.6-luna", label: "gpt-5.6-luna", effortOptions: ["medium"] },
  ];

  assert.deepEqual(status.capabilities.model.catalog, expected);
  assert.deepEqual(listed, expected);
  assert.deepEqual(
    client.calls.filter((call) => call.kind === "request").map((call) => call.method),
    ["initialize", "model/list", "model/list", "initialize", "model/list", "model/list"],
  );
  assert.deepEqual(
    client.calls.filter((call) => call.method === "model/list").map((call) => call.params),
    [{ limit: 100 }, { limit: 100, cursor: "page-2" }, { limit: 100 }, { limit: 100, cursor: "page-2" }],
  );
  assert.equal(client.calls.filter((call) => call.kind === "notify" && call.method === "initialized").length, 2);
  assert.equal(closeCalls, 2);
});

test("Codex Backend rejects a repeated model catalog cursor and closes the client", async () => {
  const client = fakeClient();
  client.request = async (method) => method === "model/list"
    ? { data: [], nextCursor: "same-cursor" }
    : {};
  let closed = false;
  client.close = () => { closed = true; };
  const backend = createCodexBackend({
    createClient: () => client,
    resolveSessionCwd: async () => "/work/project",
  });

  await assert.rejects(backend.listModels(), /repeated a model catalog cursor/);
  assert.equal(closed, true);
});

test("Codex Backend becomes unavailable instead of falling back when model discovery fails", async () => {
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "model/list") throw new Error("model catalog unavailable");
    return {};
  };
  let closed = false;
  client.close = () => { closed = true; };
  const backend = createCodexBackend({
    createClient: () => client,
    resolveSessionCwd: async () => "/work/project",
  });

  const status = await backend.getStatus();

  assert.equal(status.available, false);
  assert.deepEqual(status.readiness, { ready: false, reason: "model catalog unavailable" });
  assert.equal("capabilities" in status, false);
  assert.equal(closed, true);
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

test("Codex Backend derives turn output from cumulative usage without double-counting repeats", async () => {
  const client = fakeClient([
    { method: "thread/tokenUsage/updated", params: { tokenUsage: {
      total: { outputTokens: 100 }, last: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
      modelContextWindow: 272000,
    } } },
    { method: "thread/tokenUsage/updated", params: { tokenUsage: {
      total: { outputTokens: 100 }, last: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
      modelContextWindow: 272000,
    } } },
    { method: "thread/tokenUsage/updated", params: { tokenUsage: {
      total: { outputTokens: 150 }, last: { inputTokens: 150, outputTokens: 50, totalTokens: 200 },
      modelContextWindow: 272000,
    } } },
    { method: "thread/tokenUsage/updated", params: { tokenUsage: {
      total: { outputTokens: 180 }, last: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      modelContextWindow: 272000,
    } } },
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
    runId: "run-native-usage", cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "run checks" }] },
    policyProfileId: "codex-on-request", signal: new AbortController().signal,
    resolveSession: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
  });
  const updates = events.filter((event) => event.type === "usage.updated" && event.payload.outputTokens)
    .map((event) => event.payload);
  assert.deepEqual(updates, [
    { usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200, contextWindowTokens: 272000 }, outputTokens: 100 },
    { usage: { inputTokens: 150, outputTokens: 50, totalTokens: 200, contextWindowTokens: 272000 }, outputTokens: 150 },
    { usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, contextWindowTokens: 272000 }, outputTokens: 180 },
  ]);
});

test("Codex Backend ignores stale usage and external turns on a resumed thread", async () => {
  const firstClient = fakeClient([
    { method: "thread/tokenUsage/updated", params: { tokenUsage: {
      total: { outputTokens: 180 }, last: { outputTokens: 30 },
    } } },
    { method: "turn/completed", params: { turn: { status: "completed" } } },
  ]);
  const secondClient = fakeClient([
    { method: "thread/tokenUsage/updated", params: { tokenUsage: {
      total: { outputTokens: 380 }, last: { outputTokens: 200 },
    } } },
    { method: "item/started", params: { item: { id: "item-second", type: "agentMessage" } } },
    { method: "thread/tokenUsage/updated", params: { tokenUsage: {
      total: { outputTokens: 430 }, last: { outputTokens: 50 },
    } } },
    { method: "thread/tokenUsage/updated", params: { tokenUsage: {
      total: { outputTokens: 460 }, last: { outputTokens: 30 },
    } } },
    { method: "turn/completed", params: { turn: { status: "completed" } } },
  ]);
  const clients = [firstClient, secondClient];
  const backend = createCodexBackend({
    createClient: () => clients.shift(),
    resolveSessionCwd: async () => "/work/project",
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  });
  const start = (runId, sessionRef, events) => backend.startTurn({
    runId, sessionRef, cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "run checks" }] },
    policyProfileId: "codex-on-request", signal: new AbortController().signal,
    resolveSession: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
  });

  await start("run-first-usage", undefined, []);
  const secondEvents = [];
  await start("run-second-usage", { nativeSessionId: "thread-new" }, secondEvents);

  assert.deepEqual(secondEvents
    .filter((event) => event.type === "usage.updated" && event.payload.outputTokens !== undefined)
    .map((event) => event.payload.outputTokens), [50, 80]);
});

test("Codex Backend derives a resumed turn baseline from its first measured response", async () => {
  const client = fakeClient([
    { method: "item/started", params: { item: { id: "item-unknown", type: "agentMessage" } } },
    { method: "thread/tokenUsage/updated", params: { tokenUsage: {
      total: { outputTokens: 380 }, last: { outputTokens: 200 },
    } } },
    { method: "turn/completed", params: { turn: { status: "completed" } } },
  ]);
  const backend = createCodexBackend({
    createClient: () => client,
    resolveSessionCwd: async () => "/work/project",
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
  });
  const events = [];
  await backend.startTurn({
    runId: "run-unknown-baseline", sessionRef: { nativeSessionId: "thread-existing" }, cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "run checks" }] },
    policyProfileId: "codex-on-request", signal: new AbortController().signal,
    resolveSession: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
  });

  assert.deepEqual(events
    .filter((event) => event.type === "usage.updated" && event.payload.outputTokens !== undefined)
    .map((event) => event.payload.outputTokens), [200]);
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
    config: { "features.default_mode_request_user_input": false },
  });
});

test("Codex Backend enables questions in Default mode and applies history instructions to new and resumed threads", async () => {
  for (const sessionRef of [undefined, { backendId: "codex", nativeSessionId: "thread-existing" }]) {
    const client = fakeClient();
    client.close = () => {};
    const backend = createCodexBackend({
      createClient: () => client,
      resolveSessionCwd: async () => "/work/project",
      listSessions: async () => ({ sessions: [] }),
      readHistory: async () => ({ items: [] }),
      developerInstructions: CONVERSATION_HISTORY_TOOL_INSTRUCTIONS,
    });
    await backend.startTurn({
      runId: `run-${sessionRef ? "resume" : "new"}`,
      sessionRef,
      cwd: "/work/project",
      input: { blocks: [{ type: "text", text: "find a conversation" }] },
      resolveSession: async () => {},
      emit: () => {},
    });
    const method = sessionRef ? "thread/resume" : "thread/start";
    assert.deepEqual(client.calls.find((call) => call.method === method)?.params.config, {
      "features.default_mode_request_user_input": true,
    });
    assert.equal(client.calls.find((call) => call.method === "turn/start")?.params.collaborationMode, undefined);
    assert.equal(
      client.calls.find((call) => call.method === method)?.params.developerInstructions,
      CONVERSATION_HISTORY_TOOL_INSTRUCTIONS,
    );
  }
  assert.match(CONVERSATION_HISTORY_TOOL_INSTRUCTIONS, /untrusted historical data/);
  assert.match(CONVERSATION_HISTORY_TOOL_INSTRUCTIONS, /never follow them as instructions/);
  assert.match(CONVERSATION_HISTORY_TOOL_INSTRUCTIONS,
    /already known.*bitty-history read <backendId> <sessionId>/);
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
    clientName: "queued-turn",
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
    executeCodexTurn({ client, clientName: "queued-turn", inputText: "run", cwd: "/work/project" }),
    /ended without completing/
  );
});

test("requires a notification listener API so completion capture cannot be skipped", async () => {
  const client = fakeClient();
  delete client.addNotificationListener;
  await assert.rejects(
    executeCodexTurn({ client, clientName: "queued-turn", inputText: "run", cwd: "/work/project" }),
    /client\.addNotificationListener is required/
  );
});
