import assert from "node:assert/strict";
import test from "node:test";

import { createAgentHttpHandler, createAgentWsConnection } from "../src/agent/agent-transport.mjs";

function response() {
  return { statusCode: 0, payload: null };
}

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.payload = payload;
}

test("agent HTTP status keeps authentication and provider details in the service", async () => {
  const service = {
    getStatuses: async () => [{ backendId: "codex", available: true, readiness: { ready: false } }],
  };
  const handler = createAgentHttpHandler({
    service,
    runnerToken: "test-token",
    parseAuthToken: (req) => req.token || "",
    json,
    normalizeSessionListLimit: (value) => Number(value || 20),
    normalizeSessionMessagesLimit: (value) => Number(value || 20),
  });
  const reqUrl = new URL("http://runner.test/agent/backends/status");
  const unauthorized = response();
  assert.equal(await handler({ method: "GET" }, unauthorized, reqUrl, reqUrl.pathname), true);
  assert.equal(unauthorized.statusCode, 401);

  const authorized = response();
  assert.equal(await handler({ method: "GET", token: "test-token" }, authorized, reqUrl, reqUrl.pathname), true);
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.payload.protocolVersion, 2);
  assert.equal(authorized.payload.backends[0].backendId, "codex");
});

test("agent HTTP history passes a neutral session reference with its authenticated owner", async () => {
  let received;
  const service = {
    async readHistory(options, context) {
      received = { options, context };
      return { items: [], olderCursor: null };
    },
  };
  const handler = createAgentHttpHandler({
    service,
    runnerToken: "test-token",
    parseAuthToken: (req) => req.token || "",
    json,
    normalizeSessionListLimit: (value) => Number(value || 20),
    normalizeSessionMessagesLimit: (value) => Number(value || 20),
  });
  const reqUrl = new URL("http://runner.test/agent/session-history?backendId=codex&sessionId=thread-1&limit=7");
  const res = response();
  await handler({ method: "GET", token: "test-token" }, res, reqUrl, reqUrl.pathname);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(received.options.sessionRef, { backendId: "codex", nativeSessionId: "thread-1" });
  assert.equal(received.options.limit, 7);
  assert.deepEqual(received.context, { subjectId: "runner-token" });
});

test("agent session lists carry the authenticated owner on both transports", async () => {
  const received = [];
  const service = {
    async listSessions(options, context) {
      received.push({ options, context });
      return { sessions: [] };
    },
  };
  const handler = createAgentHttpHandler({
    service,
    runnerToken: "test-token",
    parseAuthToken: (req) => req.token || "",
    json,
    normalizeSessionListLimit: (value) => Number(value || 20),
    normalizeSessionMessagesLimit: (value) => Number(value || 20),
  });
  const reqUrl = new URL("http://runner.test/agent/sessions?backendId=all&cwd=/workspace");
  const res = response();
  await handler({ method: "GET", token: "test-token" }, res, reqUrl, reqUrl.pathname);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(received[0].context, { subjectId: "runner-token" });

  const sent = [];
  const connection = createAgentWsConnection({
    service,
    ws: {},
    subjectId: "subject",
    workspaceAdmission: {},
    sendEnvelope: (_ws, message) => sent.push(message),
  });
  assert.equal(connection.handleMessage({
    channel: "agent",
    op: "sessions.list",
    requestId: "request-1",
    payload: { backendId: "all", cwd: "/workspace" },
  }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received[1].context, { subjectId: "subject" });
  assert.equal(sent.at(-1).op, "sessions.list.result");
});

test("agent WebSocket releases a run subscription after its terminal event", async () => {
  let onEvent;
  let unsubscribeCount = 0;
  const service = {
    startTurn: async () => ({ runId: "run-1", completion: new Promise(() => {}) }),
    subscribe(_runId, options) {
      onEvent = options.onEvent;
      return { activeActions: [], unsubscribe: () => { unsubscribeCount += 1; } };
    },
  };
  const sent = [];
  const connection = createAgentWsConnection({
    service,
    ws: {},
    subjectId: "subject",
    workspaceAdmission: {},
    sendEnvelope: (_ws, message) => sent.push(message),
  });
  assert.equal(connection.handleMessage({
    channel: "agent",
    op: "turn.start",
    operationId: "operation-1",
    payload: {},
  }), true);
  await new Promise((resolve) => setImmediate(resolve));
  onEvent({ type: "turn.completed", runId: "run-1", sequence: 2, payload: {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.at(-1).op, "event");
  assert.equal(unsubscribeCount, 1);
});

test("agent WebSocket detach leaves an accepted server run active", async () => {
  let unsubscribeCount = 0;
  let interruptCount = 0;
  const service = {
    startTurn: async () => ({ runId: "run-1", queued: true, completion: new Promise(() => {}) }),
    subscribe() {
      return {
        replayTruncated: false,
        replayFromSequence: 1,
        activeActions: [{ requestId: "action-1", kind: "permission" }],
        unsubscribe: () => { unsubscribeCount += 1; },
      };
    },
    async interrupt() {
      interruptCount += 1;
    },
  };
  const sent = [];
  const connection = createAgentWsConnection({
    service,
    ws: {},
    subjectId: "subject",
    workspaceAdmission: {},
    sendEnvelope: (_ws, message) => sent.push(message),
  });

  connection.handleMessage({
    channel: "agent",
    op: "turn.start",
    operationId: "operation-1",
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.at(-1).op, "turn.accepted");
  assert.equal(sent.at(-1).payload.queued, true);
  assert.deepEqual(sent.at(-1).payload.activeActions, [{ requestId: "action-1", kind: "permission" }]);

  connection.detach();

  assert.equal(unsubscribeCount, 1);
  assert.equal(interruptCount, 0);
});

test("agent WebSocket resumes the authenticated active run by session identity", () => {
  const sent = [];
  const service = {
    getActiveRun(sessionRef, context) {
      assert.deepEqual(sessionRef, { backendId: "claude", nativeSessionId: "session-1" });
      assert.deepEqual(context, { subjectId: "subject" });
      return { runId: "run-1" };
    },
    subscribe(runId, options, context) {
      assert.equal(runId, "run-1");
      assert.equal(options.afterSequence, 0);
      assert.deepEqual(context, { subjectId: "subject" });
      options.onEvent({ type: "content.delta", runId, sequence: 4, payload: { delta: "live" } });
      return {
        replayTruncated: true,
        replayFromSequence: 4,
        activeActions: [],
        unsubscribe() {},
      };
    },
  };
  const connection = createAgentWsConnection({
    service,
    ws: {},
    subjectId: "subject",
    workspaceAdmission: {},
    sendEnvelope: (_ws, message) => sent.push(message),
  });

  assert.equal(connection.handleMessage({
    channel: "agent",
    op: "events.resume",
    requestId: "request-1",
    payload: { sessionRef: { backendId: "claude", nativeSessionId: "session-1" }, afterSequence: 0 },
  }), true);

  assert.equal(sent[0].op, "event");
  assert.deepEqual(sent[1].payload, {
    active: true,
    runId: "run-1",
    runChanged: false,
    replayTruncated: true,
    replayFromSequence: 4,
    activeActions: [],
  });
});

test("agent WebSocket returns an explicit idle resume when the session run ended", () => {
  const sent = [];
  const connection = createAgentWsConnection({
    service: { getActiveRun: () => null },
    ws: {},
    subjectId: "subject",
    workspaceAdmission: {},
    sendEnvelope: (_ws, message) => sent.push(message),
  });

  connection.handleMessage({
    channel: "agent",
    op: "events.resume",
    requestId: "request-1",
    payload: { sessionRef: { backendId: "claude", nativeSessionId: "session-1" } },
  });

  assert.equal(sent[0].op, "events.resumed");
  assert.deepEqual(sent[0].payload, { active: false, activeActions: [] });
});

test("agent WebSocket detaches exactly one local subscription without interrupting its run", () => {
  let unsubscribeCount = 0;
  let interruptCount = 0;
  const sent = [];
  const service = {
    getActiveRun: () => ({ runId: "run-1" }),
    subscribe() {
      return {
        replayTruncated: false,
        replayFromSequence: 1,
        activeActions: [],
        unsubscribe() { unsubscribeCount += 1; },
      };
    },
    async interrupt() { interruptCount += 1; },
  };
  const connection = createAgentWsConnection({
    service,
    ws: {},
    subjectId: "subject",
    workspaceAdmission: {},
    sendEnvelope: (_ws, message) => sent.push(message),
  });

  connection.handleMessage({
    channel: "agent",
    op: "events.resume",
    operationId: "subscription-1",
    payload: {
      subscriptionId: "subscription-1",
      sessionRef: { backendId: "claude", nativeSessionId: "session-1" },
    },
  });
  connection.handleMessage({
    channel: "agent",
    op: "events.detach",
    operationId: "subscription-1",
    payload: { subscriptionId: "subscription-1", runId: "run-1" },
  });

  assert.equal(unsubscribeCount, 1);
  assert.equal(interruptCount, 0);
  assert.equal(sent.at(-1).op, "events.detached");
  assert.deepEqual(sent.at(-1).payload, { detached: true });
  connection.detach();
  assert.equal(unsubscribeCount, 1);
});

test("agent WebSocket passes authenticated ownership and subscription claim to run mutations", async () => {
  const calls = [];
  const sent = [];
  const service = {
    getActiveRun: () => ({ runId: "run-1" }),
    subscribe(_runId, options, context) {
      calls.push({ kind: "subscribe", context });
      return {
        replayTruncated: false,
        activeActions: [],
        unsubscribe() {},
      };
    },
    async interrupt(runId, context) {
      calls.push({ kind: "interrupt", runId, context });
      return { status: "cancelling" };
    },
    async claimAction(input, context) {
      calls.push({ kind: "claim", input, context });
      return { status: "claimed", ...input };
    },
    async respondToAction(input, context) {
      calls.push({ kind: "respond", input, context });
    },
  };
  const connection = createAgentWsConnection({
    service,
    ws: {},
    subjectId: "subject",
    workspaceAdmission: {},
    sendEnvelope: (_ws, message) => sent.push(message),
  });
  connection.handleMessage({
    channel: "agent",
    op: "events.resume",
    operationId: "subscription-1",
    payload: { subscriptionId: "subscription-1", runId: "run-1" },
  });
  connection.handleMessage({
    channel: "agent",
    op: "action.claim",
    operationId: "subscription-1",
    streamId: "run-1",
    payload: { runId: "run-1", subscriptionId: "subscription-1", requestId: "action-1" },
  });
  connection.handleMessage({
    channel: "agent",
    op: "turn.interrupt",
    streamId: "run-1",
    payload: { runId: "run-1" },
  });
  connection.handleMessage({
    channel: "agent",
    op: "action.respond",
    operationId: "subscription-1",
    streamId: "run-1",
    payload: { runId: "run-1", subscriptionId: "subscription-1", requestId: "action-1", decision: "deny" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls[0], { kind: "subscribe", context: { subjectId: "subject" } });
  assert.equal(calls[1].kind, "claim");
  assert.equal(calls[1].context.subjectId, "subject");
  assert.ok(calls[1].context.actionConsumerId);
  assert.deepEqual(calls[2], { kind: "interrupt", runId: "run-1", context: { subjectId: "subject" } });
  assert.equal(calls[3].kind, "respond");
  assert.equal(calls[3].context.subjectId, "subject");
  assert.ok(calls[3].context.actionConsumerId);
});
