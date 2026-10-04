import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";

import { createOrchestratorActivity } from "../src/orchestrator-activity.mjs";
import { createAgentHttpHandler, createAgentWsConnection } from "../src/agent/agent-transport.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function nativeClient(parents = {}) {
  const listeners = new Set();
  let reads = 0;
  return {
    get reads() { return reads; },
    request: async (_method, { threadId }) => {
      reads++;
      return { thread: { id: threadId, parentThreadId: parents[threadId] } };
    },
    addNotificationListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(method, params) { for (const listener of listeners) listener(method, params); },
    get listenerCount() { return listeners.size; },
  };
}

test("native parent lookup assigns the registered root and observes tool start/end", async () => {
  const client = nativeClient({ child: "root" });
  const activity = createOrchestratorActivity();
  const release = activity.registerRoot({ threadId: "root", orchestratorId: "voice-a", client });
  const item = { id: "item", type: "commandExecution", command: "true" };
  client.emit("item/started", { threadId: "child", turnId: "turn", item });
  await tick();
  let tool = activity.snapshot().activities.find((entry) => entry.kind === "tool");
  assert.equal(tool.orchestratorId, "voice-a");
  assert.equal(tool.status, "running");
  assert.equal(client.reads, 1);
  client.emit("item/completed", { threadId: "child", turnId: "turn",
    item: { ...item, status: "completed", exitCode: 0 } });
  await tick();
  tool = activity.snapshot().activities.find((entry) => entry.kind === "tool");
  assert.equal(tool.status, "completed");
  release();
  assert.equal(client.listenerCount, 0);
});

test("unknown ancestry, mismatched read, and root release never borrow another actor", async () => {
  const first = nativeClient({ child: "root-a", unrelated: "elsewhere" });
  const second = nativeClient({ other: "root-b" });
  const activity = createOrchestratorActivity();
  const releaseA = activity.registerRoot({ threadId: "root-a", orchestratorId: "A", client: first });
  const releaseB = activity.registerRoot({ threadId: "root-b", orchestratorId: "B", client: second });
  const response = new EventEmitter();
  response.statusCode = 200;
  activity.observeHttp({ headers: { "x-bitty-display-caller": "child" } }, response, { label: "取得中" });
  response.emit("finish");
  await tick();
  assert.equal(activity.snapshot().activities[0].orchestratorId, "A");
  assert.equal(activity.snapshot().activities[0].status, "completed");
  releaseA();
  const unknown = new EventEmitter();
  activity.observeHttp({ headers: { "x-bitty-display-caller": "unrelated" } }, unknown, { label: "取得中" });
  await tick();
  assert.equal(activity.snapshot().activities.length, 1);
  releaseB();
});

test("failed root listener installation leaves no actor binding", async () => {
  const activity = createOrchestratorActivity();
  assert.throws(() => activity.registerRoot({ threadId: "root", orchestratorId: "voice",
    client: { addNotificationListener() { throw new Error("listener unavailable"); } } }), /listener unavailable/);
  const response = new EventEmitter();
  activity.observeHttp({ headers: { "x-bitty-display-caller": "root" } }, response, { label: "取得中" });
  await tick();
  assert.equal(activity.snapshot().activities.length, 0);
});

test("ten native parent hops resolve once while unrelated tool notifications stay hidden", async () => {
  const parents = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
    `child-${index}`, index === 9 ? "root" : `child-${index + 1}`,
  ]));
  const client = nativeClient(parents);
  const updates = [];
  const activity = createOrchestratorActivity({ broadcast: (value) => updates.push(value) });
  const release = activity.registerRoot({ threadId: "root", orchestratorId: "voice", client });
  for (let i = 0; i < 2; i++) {
    const response = new EventEmitter();
    activity.observeHttp({ headers: { "x-bitty-display-caller": "child-0" } }, response, { label: "取得中" });
  }
  await tick();
  assert.equal(client.reads, 10);
  assert.equal(activity.snapshot().activities.length, 2);
  const before = updates.length;
  client.emit("item/started", { threadId: "foreign", turnId: "other", item: { id: "one", type: "commandExecution" } });
  await tick();
  assert.equal(activity.snapshot().activities.length, 2);
  assert.equal(updates.length, before);
  release();
});

test("native nonzero exit, turn terminal, and root close settle only owned tools", async () => {
  const client = nativeClient({ child: "root" });
  const activity = createOrchestratorActivity();
  const release = activity.registerRoot({ threadId: "root", orchestratorId: "voice", client });
  client.emit("item/started", { threadId: "child", turnId: "first", item: { id: "a", type: "fileChange" } });
  client.emit("item/started", { threadId: "child", turnId: "second", item: { id: "b", type: "commandExecution" } });
  await tick();
  client.emit("item/completed", { threadId: "child", turnId: "second",
    item: { id: "b", type: "commandExecution", status: "completed", exitCode: -1 } });
  client.emit("turn/interrupted", { threadId: "child", turnId: "first" });
  await tick();
  const states = activity.snapshot().activities.filter((item) => item.kind === "tool")
    .map((item) => [item.label, item.status]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(states, [["コマンド", "failed"], ["ファイル編集", "interrupted"]].sort((a, b) => a[0].localeCompare(b[0])));
  release();
  assert.equal(client.listenerCount, 0);
});

test("native turn terminal uses turn.id and a delayed lookup cannot revive a closed root", async () => {
  let resolveRead;
  const client = nativeClient({ child: "root" });
  const request = client.request;
  client.request = (...args) => new Promise((resolve) => { resolveRead = () => request(...args).then(resolve); });
  const activity = createOrchestratorActivity();
  const release = activity.registerRoot({ threadId: "root", orchestratorId: "voice", client });
  client.emit("item/started", { threadId: "root", turnId: "turn", item: { id: "a", type: "commandExecution" } });
  await tick();
  assert.equal(activity.snapshot().activities[0].status, "running");
  client.emit("turn/completed", { threadId: "root", turn: { id: "turn", status: "completed" } });
  await tick();
  assert.equal(activity.snapshot().activities[0].status, "unknown");
  client.emit("item/started", { threadId: "child", turnId: "later", item: { id: "b", type: "fileChange" } });
  await tick();
  release();
  resolveRead();
  await tick();
  await tick();
  assert.equal(activity.snapshot().activities.length, 1);
});

test("a child turn terminal following its start cannot leave a late running tool", async () => {
  let resolveRead;
  const client = nativeClient({ child: "root" });
  const request = client.request;
  client.request = (...args) => new Promise((resolve) => { resolveRead = () => request(...args).then(resolve); });
  const activity = createOrchestratorActivity();
  activity.registerRoot({ threadId: "root", orchestratorId: "voice", client });
  client.emit("item/started", { threadId: "child", turnId: "turn", item: { id: "a", type: "commandExecution" } });
  client.emit("turn/completed", { threadId: "child", turn: { id: "turn", status: "completed" } });
  resolveRead();
  await tick();
  await tick();
  assert.deepEqual(activity.snapshot().activities.map((item) => item.status), ["unknown"]);
});

test("one finished activity expires without removing another running activity", async () => {
  const client = nativeClient();
  const activity = createOrchestratorActivity();
  activity.registerRoot({ threadId: "root", orchestratorId: "voice", client });
  const finishedResponse = new EventEmitter();
  finishedResponse.statusCode = 200;
  activity.observeHttp({ headers: { "x-bitty-display-caller": "root" } }, finishedResponse, { label: "取得中" });
  const runningResponse = new EventEmitter();
  activity.observeHttp({ headers: { "x-bitty-display-caller": "root" } }, runningResponse, { label: "会話中" });
  finishedResponse.emit("finish");
  assert.deepEqual(activity.snapshot().activities.map((item) => item.status).sort(), ["completed", "running"]);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(activity.snapshot().activities.map((item) => item.status), ["running"]);
});

test("HTTP transport observes only authenticated requests and survives display failures", async () => {
  const seen = [];
  const handler = createAgentHttpHandler({
    service: { getStatuses: async () => [] },
    runnerToken: "bearer", parseAuthToken: (req) => req.headers.authorization?.slice(7),
    json: (res, status, body) => { res.statusCode = status; res.body = body; res.emit("finish"); },
    activity: { observeHttp: (...args) => { seen.push(args); throw new Error("display failed"); } },
  });
  const response = () => Object.assign(new EventEmitter(), { statusCode: 0 });
  const url = new URL("http://localhost/agent/backends/status");
  const bad = response();
  await handler({ method: "GET", headers: { authorization: "Bearer wrong" } }, bad, url, url.pathname);
  assert.equal(bad.statusCode, 401);
  assert.equal(seen.length, 0);
  const good = response();
  await handler({ method: "GET", headers: { authorization: "Bearer bearer" } }, good, url, url.pathname);
  assert.equal(good.statusCode, 200);
  assert.equal(seen.length, 1);
});

test("an actual aborted HTTP request settles its activity without changing the handler", async (t) => {
  const client = nativeClient();
  const activity = createOrchestratorActivity();
  const release = activity.registerRoot({ threadId: "root", orchestratorId: "voice", client });
  t.after(release);
  let entered;
  const reachedService = new Promise((resolve) => { entered = resolve; });
  let closed;
  const responseClosed = new Promise((resolve) => { closed = resolve; });
  const handler = createAgentHttpHandler({
    service: { getStatuses: () => { entered(); return new Promise(() => {}); } },
    runnerToken: "bearer", parseAuthToken: (req) => req.headers.authorization?.slice(7),
    json: (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); },
    activity,
  });
  const server = http.createServer((req, res) => {
    res.once("close", closed);
    void handler(req, res, new URL(req.url, "http://localhost"), req.url);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = http.get({ hostname: "127.0.0.1", port: server.address().port,
    path: "/agent/backends/status", headers: { authorization: "Bearer bearer", "x-bitty-display-caller": "root" } });
  request.on("error", () => {});
  await reachedService;
  assert.equal(activity.snapshot().activities[0].status, "running");
  request.destroy();
  await responseClosed;
  assert.equal(activity.snapshot().activities[0].status, "interrupted");
});

test("run observation uses existing replay/live subscribe and outlives WS detach", async () => {
  const client = nativeClient();
  const activity = createOrchestratorActivity();
  const release = activity.registerRoot({ threadId: "root", orchestratorId: "voice", client });
  let observer;
  let unsubscribeCount = 0;
  const service = {
    startTurn: async () => ({ runId: "run-1", queued: false }),
    subscribe: (_runId, options, context) => {
      assert.equal(context.subjectId, "owner");
      if (options.actionConsumerId === null) {
        observer = options.onEvent;
        options.onEvent({ type: "session.resolved", sessionRef: { backendId: "claude", nativeSessionId: "target" } });
        options.onEvent({ type: "tool.started", payload: { toolCallId: "command-1", name: "exec_command",
          inputSummary: "secret command text" } });
        options.onEvent({ type: "item.started", payload: { itemId: "file-1", itemType: "fileChange" } });
        options.onEvent({ type: "item.started", payload: { itemId: "message-1", itemType: "assistant" } });
      }
      return { replayTruncated: false, replayFromSequence: 1, activeActions: [],
        unsubscribe: () => { unsubscribeCount++; } };
    },
  };
  const sent = [];
  const connection = createAgentWsConnection({ service, ws: {}, sendEnvelope: (_ws, message) => sent.push(message),
    subjectId: "owner", activity, displayCaller: "root" });
  connection.handleMessage({ channel: "agent", op: "turn.start", requestId: "request", operationId: "operation",
    payload: { backendId: "claude", cwd: "/tmp/allowed", input: { blocks: [] } } });
  const pendingActivityId = activity.snapshot().activities.find((item) => item.kind === "run")?.id;
  await tick();
  connection.detach();
  const run = activity.snapshot().activities.find((item) => item.kind === "run");
  assert.equal(run.id, pendingActivityId);
  assert.equal(run.id.includes("run-1"), false);
  assert.equal(run.orchestratorId, "voice");
  assert.deepEqual(run.sessionRef, { backendId: "claude", nativeSessionId: "target" });
  assert.equal(run.status, "running");
  assert.deepEqual(activity.snapshot().activities.filter((entry) => entry.kind === "tool")
    .map((entry) => entry.label).sort(), ["コマンド", "ファイル編集"].sort());
  assert.equal(JSON.stringify(activity.snapshot()).includes("secret command text"), false);
  observer({ type: "tool.completed", payload: { toolCallId: "command-1", status: "failed", exitCode: -1 } });
  observer({ type: "turn.completed" });
  assert.equal(activity.snapshot().activities.find((item) => item.kind === "run").status, "completed");
  assert.deepEqual(activity.snapshot().activities.filter((entry) => entry.kind === "tool")
    .map((entry) => entry.status).sort(), ["failed", "unknown"]);
  assert.equal(unsubscribeCount >= 1, true);
  assert.equal(sent.some((item) => item.op === "turn.accepted"), true);
  release();
});

test("target run keeps its actor after root closes and moves all tools when the target resolves", async () => {
  const client = nativeClient();
  const activity = createOrchestratorActivity();
  const release = activity.registerRoot({ threadId: "root", orchestratorId: "voice", client });
  let emit;
  const service = { subscribe: (_runId, { onEvent }) => {
    emit = onEvent;
    return { unsubscribe() {} };
  } };
  activity.observeRun({ runId: "private-run-id", caller: "root", service, subjectId: "owner" });
  emit({ type: "tool.started", payload: { toolCallId: "first", name: "exec_command" } });
  const first = activity.snapshot().activities.find((item) => item.kind === "tool");
  assert.equal(first.orchestratorId, "voice");
  release();
  emit({ type: "session.resolved", sessionRef: { backendId: "claude", nativeSessionId: "target" } });
  assert.equal(activity.snapshot().activities.find((item) => item.id === first.id).sessionRef.nativeSessionId, "target");
  emit({ type: "tool.started", payload: { toolCallId: "second", name: "exec_command" } });
  const tools = activity.snapshot().activities.filter((item) => item.kind === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools.every((item) => item.orchestratorId === "voice" && item.sessionRef.nativeSessionId === "target"), true);
  emit({ type: "turn.completed" });
  assert.equal(activity.snapshot().activities.find((item) => item.kind === "run").status, "completed");
  assert.equal(JSON.stringify(activity.snapshot()).includes("private-run-id"), false);
});

test("a completed run replays its short tool and terminal without claiming actions", () => {
  const client = nativeClient();
  const activity = createOrchestratorActivity();
  const release = activity.registerRoot({ threadId: "root", orchestratorId: "voice", client });
  let unsubscribed = 0;
  activity.observeRun({ runId: "internal-id", caller: "root", subjectId: "owner",
    result: { outcome: "completed" },
    service: { subscribe(_runId, options) {
      assert.equal(options.actionConsumerId, null);
      options.onEvent({ type: "session.resolved", sessionRef: { backendId: "codex", nativeSessionId: "session" } });
      options.onEvent({ type: "tool.started", payload: { toolCallId: "brief", name: "exec_command" } });
      options.onEvent({ type: "tool.completed", payload: { toolCallId: "brief", status: "completed" } });
      options.onEvent({ type: "turn.completed" });
      return { unsubscribe() { unsubscribed++; } };
    } } });
  assert.deepEqual(activity.snapshot().activities.map((item) => [item.kind, item.status]).sort(),
    [["run", "completed"], ["tool", "completed"]].sort());
  assert.equal(unsubscribed, 1);
  assert.equal(JSON.stringify(activity.snapshot()).includes("internal-id"), false);
  release();
});
