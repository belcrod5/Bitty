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
  assert.equal(authorized.payload.protocolVersion, 1);
  assert.equal(authorized.payload.backends[0].backendId, "codex");
});

test("agent HTTP history passes only a neutral session reference to the service", async () => {
  let received;
  const service = {
    async readHistory(options) {
      received = options;
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
  assert.deepEqual(received.sessionRef, { backendId: "codex", nativeSessionId: "thread-1" });
  assert.equal(received.limit, 7);
});

test("agent WebSocket releases a run subscription after its terminal event", async () => {
  let onEvent;
  let unsubscribeCount = 0;
  const service = {
    startTurn: async () => ({ runId: "run-1", completion: new Promise(() => {}) }),
    subscribe(_runId, options) {
      onEvent = options.onEvent;
      return { resumeMiss: false, activeActions: [], unsubscribe: () => { unsubscribeCount += 1; } };
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
