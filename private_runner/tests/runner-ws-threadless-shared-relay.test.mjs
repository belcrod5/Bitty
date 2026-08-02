import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_MOCK = "1";
process.env.RUNNER_TOKEN = process.env.RUNNER_TOKEN || "test-token";
process.env.RUNNER_LOG_REQUESTS = "0";
// Point the upstream at a closed local port so relay creation never reaches a live server.
process.env.CODEX_WS_PROXY_UPSTREAM_URL = "ws://127.0.0.1:59997";

const { __TESTING__ } = await import("../src/server-runtime.mjs");

function createRunnerWsConnectionForTest() {
  const sent = [];
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = (data) => {
    sent.push(JSON.parse(String(data)));
  };
  ws.close = () => {
    ws.readyState = 3;
    ws.emit("close");
  };
  ws.sent = sent;
  __TESTING__.runnerWsServer.emit("connection", ws, {
    url: "/runner-ws",
    headers: { host: "127.0.0.1" },
    socket: { remoteAddress: "test" },
  });
  return ws;
}

function sendLlmRpc(ws, { operationId, sessionId, threadId = "", requestId, payload }) {
  ws.emit("message", JSON.stringify({
    channel: "llm",
    op: "rpc",
    requestId,
    operationId,
    sessionId,
    ...(threadId ? { threadId } : {}),
    payload,
  }), false);
}

function trackNewRelays() {
  const before = new Set(__TESTING__.codexWsRelaysById.keys());
  return () => Array.from(__TESTING__.codexWsRelaysById.values())
    .filter((relay) => !before.has(relay.relayId));
}

function pendingMethods(relay) {
  return relay.pendingToUpstream.map((item) => JSON.parse(String(item.data)).method || "");
}

function cleanupRelays(relays) {
  for (const relay of relays) {
    if (!relay.closed) __TESTING__.cleanupCodexRelay(relay, "test_cleanup");
  }
}

test("threadless single-shot RPCs share one relay per runner-ws connection", () => {
  const newRelays = trackNewRelays();
  const ws = createRunnerWsConnectionForTest();
  const op1 = { operationId: "op-list-1", sessionId: "session-list-1" };
  const op2 = { operationId: "op-list-2", sessionId: "session-list-2" };

  sendLlmRpc(ws, { ...op1, requestId: "rq-1", payload: { jsonrpc: "2.0", id: 101, method: "initialize", params: {} } });
  sendLlmRpc(ws, { ...op1, payload: { jsonrpc: "2.0", method: "initialized", params: {} } });
  sendLlmRpc(ws, { ...op1, requestId: "rq-2", payload: { jsonrpc: "2.0", id: 102, method: "thread/list", params: { limit: 50 } } });
  sendLlmRpc(ws, { ...op2, requestId: "rq-3", payload: { jsonrpc: "2.0", id: 201, method: "initialize", params: {} } });
  sendLlmRpc(ws, { ...op2, requestId: "rq-4", payload: { jsonrpc: "2.0", id: 202, method: "thread/list", params: { limit: 50 } } });

  const created = newRelays();
  assert.equal(created.length, 1, "both operations must share a single relay");
  const shared = created[0];
  assert.equal(shared.runnerWsSharedThreadless, true);
  assert.equal(shared.clients.has(ws), true);
  assert.deepEqual(
    pendingMethods(shared),
    ["initialize", "initialized", "thread/list", "initialize", "thread/list"],
  );
  // Single-shot operations are not registered in the identity index (no resume).
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.resolveExact(op1).ok, false);
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.resolveExact(op2).ok, false);
  assert.equal(
    ws.sent.filter((message) => message.op === "llm_rpc_forwarded").length,
    4,
  );

  ws.close();
  assert.equal(shared.closed, true, "shared relay must be cleaned up when the connection closes");
  assert.equal(__TESTING__.codexWsRelaysById.has(shared.relayId), false);
  cleanupRelays(created);
});

test("shared relay tags responses per operation and keeps threadId unbound", () => {
  const newRelays = trackNewRelays();
  const ws = createRunnerWsConnectionForTest();
  const op1 = { operationId: "op-tag-1", sessionId: "session-tag-1" };
  const op2 = { operationId: "op-tag-2", sessionId: "session-tag-2" };

  sendLlmRpc(ws, { ...op1, requestId: "rq-t1", payload: { jsonrpc: "2.0", id: 301, method: "thread/list", params: {} } });
  sendLlmRpc(ws, { ...op2, requestId: "rq-t2", payload: { jsonrpc: "2.0", id: 302, method: "thread/list", params: {} } });
  const created = newRelays();
  assert.equal(created.length, 1);
  const shared = created[0];

  ws.sent.length = 0;
  __TESTING__.handleCodexRelayUpstreamMessage(
    shared,
    JSON.stringify({ jsonrpc: "2.0", id: 302, result: { data: [{ id: "thread-b" }] } }),
    false,
    { endpoint: "/runner-ws", remote: "test" },
  );
  __TESTING__.handleCodexRelayUpstreamMessage(
    shared,
    JSON.stringify({ jsonrpc: "2.0", id: 301, result: { data: [{ id: "thread-a" }] } }),
    false,
    { endpoint: "/runner-ws", remote: "test" },
  );

  const rpcEnvelopes = ws.sent.filter((message) => message.channel === "llm" && message.op === "rpc");
  assert.deepEqual(
    rpcEnvelopes.map((message) => [message.operationId, message.sessionId, message.payload.id]),
    [
      [op2.operationId, op2.sessionId, 302],
      [op1.operationId, op1.sessionId, 301],
    ],
  );
  assert.equal(shared.threadId, "", "list responses must not bind a threadId on the shared relay");
  assert.equal(shared.eventLog.length, 0, "shared relay must not accumulate an event log");
  assert.equal(shared.lastSeq, 2);

  ws.close();
  cleanupRelays(created);
});

test("turn-owning RPC gets a dedicated relay with the operation's handshake replayed", () => {
  const newRelays = trackNewRelays();
  const ws = createRunnerWsConnectionForTest();
  const listOp = { operationId: "op-list-3", sessionId: "session-list-3" };
  const turnOp = { operationId: "op-turn-1", sessionId: "session-turn-1" };

  sendLlmRpc(ws, { ...listOp, requestId: "rq-l1", payload: { jsonrpc: "2.0", id: 401, method: "thread/list", params: {} } });
  sendLlmRpc(ws, { ...turnOp, requestId: "rq-i1", payload: { jsonrpc: "2.0", id: 501, method: "initialize", params: { capabilities: { experimentalApi: true } } } });
  sendLlmRpc(ws, { ...turnOp, payload: { jsonrpc: "2.0", method: "initialized", params: {} } });
  assert.equal(newRelays().length, 1, "handshake alone must stay on the shared relay");

  sendLlmRpc(ws, { ...turnOp, requestId: "rq-s1", payload: { jsonrpc: "2.0", id: 502, method: "thread/start", params: { cwd: "/tmp/example" } } });
  const created = newRelays();
  assert.equal(created.length, 2, "thread/start must create a dedicated relay");
  const shared = created.find((relay) => relay.runnerWsSharedThreadless);
  const dedicated = created.find((relay) => !relay.runnerWsSharedThreadless);
  assert.ok(shared && dedicated);
  assert.deepEqual(
    pendingMethods(dedicated),
    ["initialize", "initialized", "thread/start"],
    "the dedicated relay's upstream must receive the operation's handshake before thread/start",
  );
  // The turn operation keeps normal identity-index behaviour on its dedicated relay.
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.resolveExact(turnOp).relay, dedicated);

  // Later messages of the turn operation stay on the dedicated relay.
  sendLlmRpc(ws, {
    ...turnOp,
    requestId: "rq-s2",
    threadId: "thread-new-1",
    payload: { jsonrpc: "2.0", id: 503, method: "turn/start", params: { threadId: "thread-new-1", input: [] } },
  });
  assert.equal(newRelays().length, 2, "turn/start must not create another relay");
  assert.equal(pendingMethods(dedicated).at(-1), "turn/start");
  assert.equal(pendingMethods(shared).includes("thread/start"), false);
  assert.equal(pendingMethods(shared).includes("turn/start"), false);

  ws.close();
  cleanupRelays(newRelays());
});

test("a shared relay with a dead upstream is replaced on the next RPC", () => {
  const newRelays = trackNewRelays();
  const ws = createRunnerWsConnectionForTest();

  sendLlmRpc(ws, {
    operationId: "op-dead-1", sessionId: "session-dead-1", requestId: "rq-d1",
    payload: { jsonrpc: "2.0", id: 801, method: "thread/list", params: {} },
  });
  const first = newRelays()[0];
  assert.equal(first.runnerWsSharedThreadless, true);
  first.upstreamWs = { readyState: 3, send() {}, close() {}, terminate() {} }; // CLOSED

  sendLlmRpc(ws, {
    operationId: "op-dead-2", sessionId: "session-dead-2", requestId: "rq-d2",
    payload: { jsonrpc: "2.0", id: 802, method: "thread/list", params: {} },
  });
  assert.equal(first.closed, true, "the stale shared relay must be cleaned up");
  const created = newRelays();
  assert.equal(created.length, 1, "cleaned-up relay leaves only the replacement");
  assert.equal(created[0].runnerWsSharedThreadless, true);
  assert.notEqual(created[0].relayId, first.relayId);
  assert.deepEqual(pendingMethods(created[0]), ["thread/list"]);

  ws.close();
  cleanupRelays(created);
});

test("shared threadless relays stay separate across runner-ws connections", () => {
  const newRelays = trackNewRelays();
  const wsA = createRunnerWsConnectionForTest();
  const wsB = createRunnerWsConnectionForTest();

  sendLlmRpc(wsA, {
    operationId: "op-conn-a", sessionId: "session-conn-a", requestId: "rq-a",
    payload: { jsonrpc: "2.0", id: 601, method: "thread/list", params: {} },
  });
  sendLlmRpc(wsB, {
    operationId: "op-conn-b", sessionId: "session-conn-b", requestId: "rq-b",
    payload: { jsonrpc: "2.0", id: 602, method: "thread/list", params: {} },
  });

  const created = newRelays();
  assert.equal(created.length, 2, "each connection must get its own shared relay");
  assert.notEqual(created[0].relayId, created[1].relayId);
  for (const relay of created) {
    assert.equal(relay.runnerWsSharedThreadless, true);
    assert.equal(relay.clients.size, 1);
  }

  wsA.close();
  wsB.close();
  cleanupRelays(created);
});

test("threadful and legacy no-identity RPCs keep their existing routing", () => {
  const newRelays = trackNewRelays();
  const ws = createRunnerWsConnectionForTest();

  sendLlmRpc(ws, {
    operationId: "op-read-1", sessionId: "session-read-1", requestId: "rq-r1",
    threadId: "thread-existing-1",
    payload: { jsonrpc: "2.0", id: 701, method: "thread/read", params: { threadId: "thread-existing-1" } },
  });
  let created = newRelays();
  assert.equal(created.length, 1);
  assert.equal(created[0].runnerWsSharedThreadless, false, "threadful RPCs must not use the shared relay");
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.resolveExact({
    operationId: "op-read-1", sessionId: "session-read-1",
  }).relay, created[0]);

  // Legacy envelopes without operationId/sessionId keep the connection:fallback relay.
  ws.emit("message", JSON.stringify({
    channel: "llm", op: "rpc",
    payload: { jsonrpc: "2.0", id: 702, method: "initialize", params: {} },
  }), false);
  created = newRelays();
  assert.equal(created.length, 2, "the legacy RPC must use its own connection:fallback relay");
  assert.equal(created.every((relay) => !relay.runnerWsSharedThreadless), true);

  ws.close();
  cleanupRelays(created);
});
