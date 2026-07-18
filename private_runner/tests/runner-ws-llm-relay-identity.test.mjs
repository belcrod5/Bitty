import assert from "node:assert/strict";
import test from "node:test";
import { createRunnerWsLlmRelayIdentityIndex } from "../src/runner-ws-llm-relay-identity.mjs";

test("LLM relay identity pairs expire together and fail closed", () => {
  let nowMs = 100;
  const relays = new Map();
  const relay = { relayId: "relay-1", closed: false };
  relays.set(relay.relayId, relay);
  const identities = createRunnerWsLlmRelayIdentityIndex({
    getRelay: (relayId) => relays.get(relayId), ttlMs: 10, now: () => nowMs,
  });
  const pair = { operationId: "operation-1", sessionId: "session-1" };
  assert.equal(identities.claim(relay, pair).ok, true);
  nowMs = 105;
  assert.equal(identities.resolveExact(pair).relay, relay);
  nowMs = 111;
  assert.equal(identities.resolveExact(pair).reason, "relay_identity_not_found");
});

test("invalid identity resumes do not refresh TTL", () => {
  const cases = [
    {
      name: "thread mismatch",
      relay: { threadId: "thread-1", lastSeq: 0, eventLog: [] },
      resume: { threadId: "thread-wrong", replayAfterSeq: 0 },
      reason: "relay_identity_mismatch",
    },
    {
      name: "future seq",
      relay: { threadId: "", lastSeq: 4, eventLog: [{ seq: 1 }] },
      resume: { replayAfterSeq: 5 },
      reason: "relay_seq_ahead",
    },
    {
      name: "seq zero history gap",
      relay: { threadId: "", lastSeq: 5, eventLog: [{ seq: 5 }] },
      resume: { replayAfterSeq: 0 },
      reason: "relay_event_history_gap",
    },
  ];
  for (const scenario of cases) {
    let nowMs = 100;
    const relay = { relayId: `relay-${scenario.name}`, closed: false, ...scenario.relay };
    const identities = createRunnerWsLlmRelayIdentityIndex({
      getRelay: (relayId) => relayId === relay.relayId ? relay : null,
      ttlMs: 10,
      now: () => nowMs,
    });
    const pair = { operationId: `operation-${scenario.name}`, sessionId: `session-${scenario.name}` };
    assert.equal(identities.claim(relay, pair).ok, true);
    nowMs = 105;
    assert.equal(identities.authorizeResume(pair, scenario.resume).reason, scenario.reason);
    nowMs = 111;
    assert.equal(identities.resolveExact(pair).reason, "relay_identity_not_found");
  }
});

test("successful identity resume refreshes both identity mappings", () => {
  let nowMs = 100;
  const relay = { relayId: "relay-refresh", closed: false, threadId: "", lastSeq: 0, eventLog: [] };
  const identities = createRunnerWsLlmRelayIdentityIndex({
    getRelay: (relayId) => relayId === relay.relayId ? relay : null,
    ttlMs: 10,
    now: () => nowMs,
  });
  const pair = { operationId: "operation-refresh", sessionId: "session-refresh" };
  assert.equal(identities.claim(relay, pair).ok, true);
  nowMs = 105;
  assert.equal(identities.authorizeResume(pair, { replayAfterSeq: 0 }).ok, true);
  nowMs = 111;
  assert.equal(identities.resolveExact(pair).relay, relay);
});

test("LLM relay identity never moves an operation or session to another relay", () => {
  const first = { relayId: "relay-a", closed: false };
  const second = { relayId: "relay-b", closed: false };
  const relays = new Map([[first.relayId, first], [second.relayId, second]]);
  const identities = createRunnerWsLlmRelayIdentityIndex({
    getRelay: (relayId) => relays.get(relayId),
  });
  assert.equal(identities.claim(first, { operationId: "op-a", sessionId: "session-a" }).ok, true);
  assert.equal(
    identities.claim(second, { operationId: "op-a", sessionId: "session-b" }).reason,
    "runner_ws_llm_identity_collision",
  );
  assert.equal(
    identities.claim(second, { operationId: "op-b", sessionId: "session-a" }).reason,
    "runner_ws_llm_identity_collision",
  );
  assert.equal(identities.resolveExact({ operationId: "op-a", sessionId: "session-a" }).relay, first);
  assert.equal(identities.resolveExact({ operationId: "op-a", sessionId: "session-b" }).reason, "relay_identity_mismatch");
});
