import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_MOCK = "1";
process.env.RUNNER_TOKEN = process.env.RUNNER_TOKEN || "test-token";

const { __TESTING__ } = await import("../src/server-runtime.mjs");

test("runner-ws parser accepts string operationId", () => {
  const parsed = __TESTING__.parseRunnerWsEnvelope(JSON.stringify({
    channel: "llm",
    op: "rpc",
    requestId: "req-1",
    operationId: "op-1",
    payload: {},
  }), false);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.message.operationId, "op-1");
});

test("runner-ws parser rejects non-string operationId", () => {
  const parsed = __TESTING__.parseRunnerWsEnvelope(JSON.stringify({
    channel: "llm",
    op: "rpc",
    operationId: 123,
    payload: {},
  }), false);

  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "operationId must be a string");
});

test("runner-ws error envelopes preserve operationId metadata", () => {
  const envelope = __TESTING__.runnerWsErrorEnvelope("bad_request", "bad request", {
    requestId: "req-1",
    operationId: "op-1",
  });

  assert.equal(envelope.requestId, "req-1");
  assert.equal(envelope.operationId, "op-1");
});

test("runner-ws connection count can be scoped by client instance", () => {
  const first = {};
  const second = {};
  const third = {};
  const activeClients = new Set([first, second, third]);
  const clientInstanceIds = new WeakMap([
    [first, "client-1"],
    [second, "client-1"],
    [third, "client-2"],
  ]);

  assert.equal(
    __TESTING__.countRunnerWsConnectionsForClient(activeClients, clientInstanceIds, "client-1"),
    2
  );
  assert.equal(
    __TESTING__.countRunnerWsConnectionsForClient(activeClients, clientInstanceIds, "client-2"),
    1
  );
  assert.equal(
    __TESTING__.countRunnerWsConnectionsForClient(activeClients, clientInstanceIds, ""),
    3
  );
});
