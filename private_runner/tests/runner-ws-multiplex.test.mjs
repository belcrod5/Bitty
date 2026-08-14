import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_MOCK = "1";
process.env.RUNNER_TOKEN = process.env.RUNNER_TOKEN || "test-token";
process.env.RUNNER_LOG_REQUESTS = "0";

const { __TESTING__ } = await import("../src/server-runtime.mjs");

function createRelayForRunnerWsTest() {
  const upstreamSent = [];
  return {
    relayId: "relay-runner-ws-test",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    endpoint: "/runner-ws",
    remote: "test",
    upstreamUrl: "ws://upstream.test",
    upstreamWs: {
      readyState: 1,
      send(data) {
        upstreamSent.push(String(data));
      },
    },
    upstreamOpen: true,
    pendingToUpstream: [],
    clients: new Set(),
    threadId: "",
    turnStatus: "",
    turnStarted: false,
    turnCompleted: false,
    currentTurnId: "",
    currentTurnStartSeq: 0,
    lastAgentMessageText: "",
    assistantThinkingPrefixSent: false,
    assistantThinkingBodyText: "",
    assistantThinkingBodyTextByItemId: new Map(),
    assistantThinkingCurrentItemId: "",
    assistantThinkingTurnActive: false,
    assistantThinkingTurnId: "",
    pendingApprovalRequestIds: new Set(),
    requestIdByRpcId: new Map(),
    requestMethodByRpcId: new Map(),
    requestMetaByRpcId: new Map(),
    runnerWsLlmOperationId: "",
    runnerWsLlmSessionId: "",
    upstreamInitializeResultSeen: false,
    upstreamInitializeResult: null,
    upstreamInitializedNotificationForwarded: false,
    lastSeq: 0,
    eventLog: [],
    cleanupTimer: null,
    closed: false,
    upstreamSent,
  };
}

function createEnvelopeClientForRunnerWsTest() {
  const sent = [];
  return {
    readyState: 1,
    send(data) {
      sent.push(JSON.parse(String(data)));
    },
    sent,
  };
}

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

test("runner-ws LLM relay keys prefer thread, then session, then operation", () => {
  assert.equal(
    __TESTING__.resolveRunnerWsLlmRelayKey({
      threadId: "thread-1",
      sessionId: "session-1",
      operationId: "operation-1",
    }),
    "thread:thread-1"
  );

  assert.equal(
    __TESTING__.resolveRunnerWsLlmRelayKey({
      sessionId: "session-1",
      operationId: "operation-1",
    }),
    "session:session-1"
  );

  assert.deepEqual(
    __TESTING__.runnerWsLlmRelayKeyCandidates({
      operationId: "operation-1",
    }),
    ["operation:operation-1"]
  );

  assert.equal(__TESTING__.resolveRunnerWsLlmRelayKey({}), "connection:fallback");
});

test("runner-ws TTS approval target avoids guessing with multiple attached jobs", () => {
  assert.equal(
    __TESTING__.resolveRunnerWsTtsApprovalTargetJobId({ streamId: "job-explicit" }, {}, new Set(["job-a", "job-b"])),
    "job-explicit"
  );
  assert.equal(
    __TESTING__.resolveRunnerWsTtsApprovalTargetJobId({}, { jobId: "job-payload" }, new Set(["job-a", "job-b"])),
    "job-payload"
  );
  assert.equal(
    __TESTING__.resolveRunnerWsTtsApprovalTargetJobId({}, {}, new Set(["job-only"])),
    "job-only"
  );
  assert.equal(
    __TESTING__.resolveRunnerWsTtsApprovalTargetJobId({}, {}, new Set(["job-a", "job-b"])),
    ""
  );
});

test("runner-ws TTS operation map resolves repeated starts to the original job", async () => {
  const operationId = `test-operation-${Date.now()}`;
  const job = __TESTING__.startLlmStreamJob({
    mode: "text",
    text: "hello",
    ttsProvider: "__test_unsupported__",
  }, {
    endpoint: "/runner-ws",
    remoteAddress: "test",
    publicBaseUrl: "http://127.0.0.1",
  });

  assert.equal(__TESTING__.rememberRunnerWsTtsOperationJob(operationId, job), true);
  assert.equal(__TESTING__.resolveRunnerWsTtsOperationJob(operationId)?.jobId, job.jobId);
  assert.equal(__TESTING__.resolveRunnerWsTtsOperationJob(operationId)?.jobId, job.jobId);

  await job.runPromise;
});

test("runner-ws LLM identity index keeps exact pre-turn pairs recoverable after detach", () => {
  const relay = __TESTING__.createCodexRelayContext({
    endpoint: "/runner-ws",
    remote: "test",
    upstreamUrl: "ws://upstream.test",
    upstreamWs: { readyState: 1, send() {} },
  });
  const operationId = `llm-operation-${Date.now()}`;
  const sessionId = `llm-session-${Date.now()}`;

  assert.equal(
    __TESTING__.runnerWsLlmRelayIdentities.claim(relay, { operationId, sessionId }).ok,
    true,
  );
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.resolveExact({ operationId, sessionId }).relay?.relayId, relay.relayId);
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.resolveExact({ operationId }).reason, "relay_identity_required");
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.has(relay), true);

  __TESTING__.cleanupOrScheduleDetachedRelay(relay, "test_detached");
  assert.equal(relay.closed, false);
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.resolveExact({ operationId, sessionId }).relay?.relayId, relay.relayId);

  if (relay.cleanupTimer) {
    clearTimeout(relay.cleanupTimer);
    relay.cleanupTimer = null;
  }
  __TESTING__.cleanupCodexRelay(relay, "test_cleanup");
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.has(relay), false);
});

test("pending approvals suspend detached cleanup until the final response is forwarded", () => {
  const sent = [];
  const relay = __TESTING__.createCodexRelayContext({
    endpoint: "/codex-ws",
    remote: "test",
    upstreamUrl: "ws://upstream.test",
    upstreamWs: { readyState: 1, send(data) { sent.push(String(data)); }, close() {} },
  });
  relay.upstreamOpen = true;
  relay.turnStarted = true;
  relay.pendingApprovalRequestIds.add(41);
  relay.cleanupTimer = setTimeout(() => {}, 60_000);

  __TESTING__.cleanupOrScheduleDetachedRelay(relay, "test_detached");
  assert.equal(relay.closed, false);
  assert.equal(relay.cleanupTimer, null);

  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({ jsonrpc: "2.0", id: 41, result: { decision: "accept" } }),
    false,
  );
  assert.equal(sent.length, 1);
  assert.equal(relay.pendingApprovalRequestIds.size, 0);
  assert.ok(relay.cleanupTimer);

  __TESTING__.cleanupCodexRelay(relay, "test_cleanup");
});

test("duplicate thread cleanup preserves the pending relay and rejects the new duplicate", () => {
  const upstream = () => ({ readyState: 1, send() {}, close() {} });
  const canonical = __TESTING__.createCodexRelayContext({
    endpoint: "/codex-ws", remote: "test", upstreamUrl: "ws://upstream.test", upstreamWs: upstream(),
  });
  canonical.threadId = "thread-pending-canonical";
  canonical.pendingApprovalRequestIds.add(7);
  const duplicate = __TESTING__.createCodexRelayContext({
    endpoint: "/codex-ws", remote: "test", upstreamUrl: "ws://upstream.test", upstreamWs: upstream(),
  });
  duplicate.threadId = canonical.threadId;

  __TESTING__.cleanupNoClientRelaysForThread(canonical.threadId, duplicate, "test_duplicate");
  assert.equal(canonical.closed, false);
  assert.equal(duplicate.closed, true);
  assert.equal(__TESTING__.pickBestRelayForThread(canonical.threadId), canonical);

  __TESTING__.cleanupCodexRelay(canonical, "test_cleanup");
});

test("relay admission is a hard cap when every relay is connected or approval-protected", () => {
  const created = [];
  const makeUpstream = () => ({ readyState: 1, send() {}, close() {} });
  let capacityError = null;
  try {
    while (!capacityError) {
      try {
        __TESTING__.ensureCodexRelayCapacity();
        const relay = __TESTING__.createCodexRelayContext({
          endpoint: "/codex-ws", remote: "test", upstreamUrl: "ws://upstream.test", upstreamWs: makeUpstream(),
        });
        if (created.length === 0) relay.pendingApprovalRequestIds.add(1);
        else relay.clients.add({ readyState: 1, send() {} });
        created.push(relay);
      } catch (error) {
        capacityError = error;
      }
    }
    const sizeAtCapacity = __TESTING__.codexWsRelaysById.size;
    assert.equal(capacityError?.code, "codex_relay_capacity");
    assert.throws(() => __TESTING__.ensureCodexRelayCapacity(), { code: "codex_relay_capacity" });
    assert.equal(__TESTING__.codexWsRelaysById.size, sizeAtCapacity);
    assert.equal(created[0].closed, false);
  } finally {
    for (const relay of created) __TESTING__.cleanupCodexRelay(relay, "test_cleanup");
  }
});

test("relay admission evicts only the oldest eligible relay from a mixed set", () => {
  const created = [];
  const makeUpstream = () => ({ readyState: 1, send() {}, close() {} });
  const create = (updatedAtMs) => {
    const relay = __TESTING__.createCodexRelayContext({
      endpoint: "/codex-ws", remote: "test", upstreamUrl: "ws://upstream.test", upstreamWs: makeUpstream(),
    });
    relay.updatedAtMs = updatedAtMs;
    created.push(relay);
    return relay;
  };

  try {
    const pending = create(1);
    pending.pendingApprovalRequestIds.add(1);
    const connected = create(2);
    connected.clients.add({ readyState: 1, send() {} });
    const oldestEligible = create(3);
    const newerEligible = create(4);
    while (created.length < __TESTING__.CODEX_WS_RELAY_MAX_ACTIVE) {
      const filler = create(100 + created.length);
      filler.clients.add({ readyState: 1, send() {} });
    }

    __TESTING__.ensureCodexRelayCapacity();

    assert.equal(oldestEligible.closed, true);
    assert.equal(newerEligible.closed, false);
    assert.equal(pending.closed, false);
    assert.equal(connected.closed, false);
    assert.equal(__TESTING__.codexWsRelaysById.size, __TESTING__.CODEX_WS_RELAY_MAX_ACTIVE - 1);
  } finally {
    for (const relay of created) __TESTING__.cleanupCodexRelay(relay, "test_cleanup");
  }
});

test("runner-ws LLM identity allows multiple operations on one relay without rebinding IDs", () => {
  const relay = __TESTING__.createCodexRelayContext({
    endpoint: "/runner-ws",
    remote: "test",
    upstreamUrl: "ws://upstream.test",
    upstreamWs: { readyState: 1, send() {} },
  });
  const suffix = `${Date.now()}-${Math.random()}`;
  const first = { operationId: `operation-a-${suffix}`, sessionId: `session-${suffix}` };
  const second = { operationId: `operation-b-${suffix}`, sessionId: first.sessionId };

  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.claim(relay, first).ok, true);
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.claim(relay, second).ok, true);
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.resolveExact(first).relay, relay);
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.resolveExact(second).relay, relay);
  assert.equal(
    __TESTING__.runnerWsLlmRelayIdentities.claim(relay, {
      operationId: first.operationId,
      sessionId: `different-${suffix}`,
    }).reason,
    "runner_ws_llm_identity_collision",
  );
  assert.equal(
    __TESTING__.runnerWsLlmRelayIdentities.resolveExact({
      operationId: first.operationId,
      sessionId: `different-${suffix}`,
    }).reason,
    "relay_identity_mismatch",
  );
  __TESTING__.cleanupCodexRelay(relay, "test_cleanup");
});

test("runner-ws identity resume replays pre-turn response without forwarding the RPC again", () => {
  const relay = createRelayForRunnerWsTest();
  relay.relayId = `relay-identity-replay-${Date.now()}`;
  __TESTING__.codexWsRelaysById.set(relay.relayId, relay);
  const identity = {
    operationId: `operation-replay-${Date.now()}`,
    sessionId: `session-replay-${Date.now()}`,
  };
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.claim(relay, identity).ok, true);
  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} }),
    false,
    { ...identity, requestId: "rpc-1", endpoint: "/runner-ws", remote: "test" },
  );
  assert.equal(relay.upstreamSent.length, 1);
  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ready: true } }),
    false,
    { endpoint: "/runner-ws", remote: "test" },
  );
  assert.equal(relay.eventLog.length, 1);

  const ws = createRunnerWsConnectionForTest();
  ws.sent.length = 0;
  ws.emit("message", JSON.stringify({
    channel: "relay",
    op: "resume",
    requestId: "resume-1",
    ...identity,
    seq: 0,
  }), false);

  assert.equal(relay.upstreamSent.length, 1);
  assert.equal(ws.sent[0].channel, "llm");
  assert.equal(ws.sent[0].seq, 1);
  assert.equal(ws.sent[1].op, "attached");
  assert.equal(ws.sent[1].requestId, "resume-1");
  assert.equal(ws.sent[1].operationId, identity.operationId);
  assert.equal(ws.sent[1].sessionId, identity.sessionId);
  assert.equal(ws.sent[1].payload.match, "identity");
  ws.close();
  __TESTING__.cleanupCodexRelay(relay, "test_cleanup");
});

test("runner-ws identity resume rejects seq zero gaps and future seq without attaching", () => {
  const relay = createRelayForRunnerWsTest();
  relay.relayId = `relay-identity-gap-${Date.now()}`;
  relay.threadId = "thread-1";
  relay.lastSeq = 5;
  relay.eventLog = [{ seq: 5, atMs: Date.now(), data: "{}" }];
  __TESTING__.codexWsRelaysById.set(relay.relayId, relay);
  const identity = {
    operationId: `operation-gap-${Date.now()}`,
    sessionId: `session-gap-${Date.now()}`,
  };
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.claim(relay, identity).ok, true);
  relay.cleanupTimer = setTimeout(() => {}, 60_000);
  const cleanupTimer = relay.cleanupTimer;

  for (const [seq, reason, threadId] of [
    [0, "relay_event_history_gap", ""],
    [1, "relay_event_history_gap", ""],
    [6, "relay_seq_ahead", ""],
    [5, "relay_identity_mismatch", "thread-wrong"],
  ]) {
    const ws = createRunnerWsConnectionForTest();
    ws.sent.length = 0;
    ws.emit("message", JSON.stringify({
      channel: "relay", op: "resume", ...identity, seq,
      ...(threadId ? { threadId } : {}),
    }), false);
    assert.equal(ws.sent.at(-1)?.op, "resume_miss");
    assert.equal(ws.sent.at(-1)?.payload.reason, reason);
    assert.equal(relay.clients.has(ws), false);
    assert.equal(relay.cleanupTimer, cleanupTimer);
    ws.close();
  }
  clearTimeout(relay.cleanupTimer);
  relay.cleanupTimer = null;
  __TESTING__.cleanupCodexRelay(relay, "test_cleanup");
});

test("runner-ws identity mismatch neither creates a relay nor forwards or acknowledges RPC", () => {
  const relay = createRelayForRunnerWsTest();
  relay.relayId = `relay-identity-collision-${Date.now()}`;
  __TESTING__.codexWsRelaysById.set(relay.relayId, relay);
  const identity = {
    operationId: `operation-collision-${Date.now()}`,
    sessionId: `session-collision-${Date.now()}`,
  };
  assert.equal(__TESTING__.runnerWsLlmRelayIdentities.claim(relay, identity).ok, true);
  const ws = createRunnerWsConnectionForTest();
  ws.sent.length = 0;
  const relayCount = __TESTING__.codexWsRelaysById.size;
  ws.emit("message", JSON.stringify({
    channel: "llm", op: "rpc", requestId: "collision-rpc",
    operationId: identity.operationId, sessionId: `${identity.sessionId}-wrong`,
    payload: { jsonrpc: "2.0", id: 9, method: "initialize", params: {} },
  }), false);

  assert.equal(__TESTING__.codexWsRelaysById.size, relayCount);
  assert.equal(relay.upstreamSent.length, 0);
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].channel, "control");
  assert.equal(ws.sent[0].op, "error");
  assert.equal(ws.sent[0].payload.error, "runner_ws_llm_identity_collision");
  assert.equal(ws.sent.some((message) => message.op === "llm_rpc_received"), false);
  ws.close();
  __TESTING__.cleanupCodexRelay(relay, "test_cleanup");
});

test("runner-ws unknown identity resume misses without creating a relay", () => {
  const ws = createRunnerWsConnectionForTest();
  ws.sent.length = 0;
  const relayCount = __TESTING__.codexWsRelaysById.size;
  ws.emit("message", JSON.stringify({
    channel: "relay", op: "resume", requestId: "unknown-resume",
    operationId: "unknown-operation", sessionId: "unknown-session", seq: 0,
  }), false);
  assert.equal(__TESTING__.codexWsRelaysById.size, relayCount);
  assert.equal(ws.sent.at(-1)?.op, "resume_miss");
  assert.equal(ws.sent.at(-1)?.payload.reason, "relay_identity_not_found");
  ws.close();
});

test("runner-ws keeps existing threadId relay resume compatible", () => {
  const relay = createRelayForRunnerWsTest();
  relay.relayId = `relay-thread-resume-${Date.now()}`;
  __TESTING__.codexWsRelaysById.set(relay.relayId, relay);
  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({
      jsonrpc: "2.0", id: 10, method: "turn/start",
      params: { threadId: "thread-legacy", input: [] },
    }),
    false,
    { endpoint: "/runner-ws", remote: "test", threadId: "thread-legacy" },
  );
  const ws = createRunnerWsConnectionForTest();
  ws.sent.length = 0;
  ws.emit("message", JSON.stringify({
    channel: "relay", op: "resume", threadId: "thread-legacy", seq: 0,
  }), false);
  assert.equal(ws.sent.at(-1)?.op, "attached");
  assert.equal(ws.sent.at(-1)?.threadId, "thread-legacy");
  assert.equal(ws.sent.at(-1)?.payload.match, "thread");
  ws.close();
  __TESTING__.cleanupCodexRelay(relay, "test_cleanup");
});

test("runner-ws TTS start requires operationId", () => {
  const ws = createRunnerWsConnectionForTest();
  ws.sent.length = 0;

  ws.emit("message", JSON.stringify({
    channel: "tts",
    op: "start",
    requestId: "tts-start-without-operation",
    payload: {
      mode: "text",
      text: "hello",
      ttsProvider: "__test_unsupported__",
    },
  }), false);

  assert.deepEqual(ws.sent[0], {
    channel: "control",
    op: "error",
    requestId: "tts-start-without-operation",
    payload: {
      error: "runner_ws_tts_operation_id_required",
      message: "operationId is required for tts:start",
      requestId: "tts-start-without-operation",
      sessionId: "",
      streamId: "",
    },
  });
});

test("runner-ws LLM notifications without rpc id keep current operation metadata", (t) => {
  const threadId = `thread-notification-${Date.now()}-${Math.random()}`;
  const relay = createRelayForRunnerWsTest();
  const client = createEnvelopeClientForRunnerWsTest();
  const notificationClient = createRunnerWsConnectionForTest();
  notificationClient.sent.length = 0;
  t.after(() => notificationClient.close());
  __TESTING__.attachClientToCodexRelay(relay, client, { envelopeMode: true });

  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "turn/start",
      params: { threadId, prompt: "hello" },
    }),
    false,
    {
      requestId: "request-1",
      operationId: "operation-1",
      sessionId: "session-1",
      threadId,
      endpoint: "/runner-ws",
      remote: "test",
    }
  );

  assert.equal(relay.upstreamSent.length, 1);

  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({ jsonrpc: "2.0", id: 4, result: { turn: { id: "turn-notification" } } }),
    false,
    { endpoint: "/runner-ws", remote: "test" }
  );
  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId, turnId: "turn-notification", delta: "pong" },
    }),
    false,
    { endpoint: "/runner-ws", remote: "test" }
  );
  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId, turn: { id: "turn-notification" }, status: "completed" },
    }),
    false,
    { endpoint: "/runner-ws", remote: "test" }
  );

  const llmEnvelopes = client.sent.filter((message) => (
    message.channel === "llm" && message.op === "rpc"
  ));
  const notificationEnvelopes = llmEnvelopes.filter((message) => (
    message.payload?.method === "item/agentMessage/delta" ||
    message.payload?.method === "turn/completed"
  ));

  assert.deepEqual(
    notificationEnvelopes.map((message) => message.payload.method),
    ["item/agentMessage/delta", "turn/completed"]
  );
  for (const message of notificationEnvelopes) {
    assert.equal(message.operationId, "operation-1");
    assert.equal(message.sessionId, "session-1");
    assert.equal(message.threadId, threadId);
  }

  const completionNotifications = notificationClient.sent.filter((message) => (
    message.channel === "llm" && message.op === "turn_completed_notification"
  ));
  assert.equal(completionNotifications.length, 1);
  assert.equal(completionNotifications[0].threadId, threadId);
  assert.match(completionNotifications[0].payload.previewText, /pong$/);

  const replayClient = createEnvelopeClientForRunnerWsTest();
  const replayed = __TESTING__.attachClientToCodexRelay(relay, replayClient, {
    envelopeMode: true,
    replayAfterSeq: 1,
  });
  assert.equal(replayed, 2);

  const replayedNotifications = replayClient.sent.filter((message) => (
    message.channel === "llm" && message.op === "rpc"
  ));
  assert.deepEqual(
    replayedNotifications.map((message) => message.payload.method),
    ["item/agentMessage/delta", "turn/completed"]
  );
  for (const message of replayedNotifications) {
    assert.equal(message.operationId, "operation-1");
    assert.equal(message.sessionId, "session-1");
    assert.equal(message.threadId, threadId);
  }
});

test("runner-ws does not complete or notify the parent from a child subagent turn", (t) => {
  const threadId = `thread-parent-${Date.now()}-${Math.random()}`;
  const relay = createRelayForRunnerWsTest();
  const owner = createEnvelopeClientForRunnerWsTest();
  const notificationClient = createRunnerWsConnectionForTest();
  notificationClient.sent.length = 0;
  t.after(() => notificationClient.close());
  __TESTING__.attachClientToCodexRelay(relay, owner, { envelopeMode: true });

  __TESTING__.forwardCodexRelayClientData(relay, JSON.stringify({
    jsonrpc: "2.0",
    id: 41,
    method: "turn/start",
    params: { threadId, prompt: "hello" },
  }), false, {
    requestId: "parent-request",
    operationId: "parent-operation",
    sessionId: threadId,
    threadId,
    endpoint: "/runner-ws",
    remote: "test",
  });
  __TESTING__.handleCodexRelayUpstreamMessage(relay, JSON.stringify({
    jsonrpc: "2.0",
    id: 41,
    result: { turn: { id: "parent-turn" } },
  }), false, { endpoint: "/runner-ws", remote: "test" });

  for (const payload of [
    { method: "item/agentMessage/delta", params: { threadId, turnId: "child-turn", delta: "child answer" } },
    { method: "turn/completed", params: { threadId, turnId: "child-turn", status: "completed" } },
  ]) {
    __TESTING__.handleCodexRelayUpstreamMessage(
      relay,
      JSON.stringify({ jsonrpc: "2.0", ...payload }),
      false,
      { endpoint: "/runner-ws", remote: "test" },
    );
  }

  assert.equal(relay.turnCompleted, false);
  assert.equal(relay.lastAgentMessageText, "");
  assert.equal(notificationClient.sent.some((message) => message.op === "turn_completed_notification"), false);
  assert.equal(owner.sent.some((message) => (
    message.op === "rpc"
    && String(message.payload?.params?.turnId || message.payload?.params?.turn?.id || "") === "child-turn"
  )), false);

  for (const payload of [
    { method: "item/agentMessage/delta", params: { threadId, turnId: "parent-turn", delta: "parent answer" } },
    { method: "turn/completed", params: { threadId, turnId: "parent-turn", status: "completed" } },
  ]) {
    __TESTING__.handleCodexRelayUpstreamMessage(
      relay,
      JSON.stringify({ jsonrpc: "2.0", ...payload }),
      false,
      { endpoint: "/runner-ws", remote: "test" },
    );
  }

  const completions = notificationClient.sent.filter((message) => message.op === "turn_completed_notification");
  assert.equal(completions.length, 1);
  assert.match(completions[0].payload.previewText, /parent answer$/);
  assert.deepEqual(
    owner.sent
      .filter((message) => message.op === "rpc" && message.payload?.params?.turnId === "parent-turn")
      .map((message) => message.payload.method),
    ["item/agentMessage/delta", "turn/completed"],
  );
});

test("runner-ws duplicate initialize on a reused relay returns cached result", () => {
  const relay = createRelayForRunnerWsTest();
  const client = createEnvelopeClientForRunnerWsTest();
  __TESTING__.attachClientToCodexRelay(relay, client, { envelopeMode: true });

  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "bitty-test" } },
    }),
    false,
    {
      requestId: "operation-1:1:initialize:id1",
      operationId: "operation-1",
      sessionId: "session-1",
      endpoint: "/runner-ws",
      remote: "test",
    }
  );

  assert.equal(relay.upstreamSent.length, 1);

  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "codex-test", version: "1.0.0" },
        capabilities: { threads: true },
      },
    }),
    false,
    { endpoint: "/runner-ws", remote: "test" }
  );

  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }),
    false,
    {
      requestId: "operation-1:2:initialized",
      operationId: "operation-1",
      sessionId: "session-1",
      endpoint: "/runner-ws",
      remote: "test",
    }
  );

  assert.equal(relay.upstreamSent.length, 2);
  assert.equal(JSON.parse(relay.upstreamSent[1]).method, "initialized");

  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "bitty-test" } },
    }),
    false,
    {
      requestId: "operation-2:1:initialize:id1",
      operationId: "operation-2",
      sessionId: "session-2",
      endpoint: "/runner-ws",
      remote: "test",
    }
  );

  assert.equal(relay.upstreamSent.length, 2);

  const duplicateInitializeResponses = client.sent.filter((message) => (
    message.channel === "llm" &&
    message.op === "rpc" &&
    message.operationId === "operation-2" &&
    message.sessionId === "session-2" &&
    message.payload?.id === 1 &&
    message.payload?.result?.serverInfo?.name === "codex-test"
  ));
  assert.equal(duplicateInitializeResponses.length, 1);

  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }),
    false,
    {
      requestId: "operation-2:2:initialized",
      operationId: "operation-2",
      sessionId: "session-2",
      endpoint: "/runner-ws",
      remote: "test",
    }
  );

  assert.equal(relay.upstreamSent.length, 2);
});

test("runner-ws binds thread/start result threadId to the initialized relay", () => {
  const upstreamSent = [];
  const relay = __TESTING__.createCodexRelayContext({
    endpoint: "/runner-ws",
    remote: "test",
    upstreamUrl: "ws://upstream.test",
    upstreamWs: {
      readyState: 1,
      send(data) {
        upstreamSent.push(String(data));
      },
    },
  });
  relay.upstreamOpen = true;
  const client = createEnvelopeClientForRunnerWsTest();
  __TESTING__.attachClientToCodexRelay(relay, client, { envelopeMode: true });

  try {
    __TESTING__.forwardCodexRelayClientData(
      relay,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "bitty-test" } },
      }),
      false,
      {
        requestId: "operation-1:1:initialize:id1",
        operationId: "operation-1",
        sessionId: "session-1",
        endpoint: "/runner-ws",
        remote: "test",
      }
    );
    __TESTING__.handleCodexRelayUpstreamMessage(
      relay,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "codex-test", version: "1.0.0" },
          capabilities: { threads: true },
        },
      }),
      false,
      { endpoint: "/runner-ws", remote: "test" }
    );

    __TESTING__.forwardCodexRelayClientData(
      relay,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "thread/start",
        params: { prompt: "hello" },
      }),
      false,
      {
        requestId: "operation-1:2:thread-start:id2",
        operationId: "operation-1",
        sessionId: "session-1",
        endpoint: "/runner-ws",
        remote: "test",
      }
    );
    __TESTING__.handleCodexRelayUpstreamMessage(
      relay,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { threadId: "thread-from-start" },
      }),
      false,
      { endpoint: "/runner-ws", remote: "test" }
    );

    assert.equal(relay.threadId, "thread-from-start");
    const selectedRelay = __TESTING__.pickBestRelayForThread("thread-from-start");
    assert.equal(selectedRelay, relay);
    assert.equal(selectedRelay.upstreamInitializeResultSeen, true);

    const runnerWs = createRunnerWsConnectionForTest();
    runnerWs.emit(
      "message",
      JSON.stringify({
        channel: "llm",
        op: "rpc",
        requestId: "operation-2:1:turn-start:id3",
        operationId: "operation-2",
        sessionId: "session-1",
        threadId: "thread-from-start",
        payload: {
          jsonrpc: "2.0",
          id: 3,
          method: "turn/start",
          params: { threadId: "thread-from-start", prompt: "again" },
        },
      }),
      false
    );

    assert.equal(upstreamSent.length, 3);
    assert.equal(JSON.parse(upstreamSent[2]).method, "turn/start");

    runnerWs.emit(
      "message",
      JSON.stringify({
        channel: "llm",
        op: "rpc",
        requestId: "operation-2:2:ping:id4",
        operationId: "operation-2",
        sessionId: "session-1",
        payload: {
          jsonrpc: "2.0",
          id: 4,
          method: "test/ping",
          params: {},
        },
      }),
      false
    );

    assert.equal(upstreamSent.length, 4);
    assert.equal(JSON.parse(upstreamSent[3]).method, "test/ping");
    assert.equal(selectedRelay.clients.has(runnerWs), true);
  } finally {
    relay.closed = true;
    relay.clients.clear();
  }
});

test("runner-ws thread/read rider does not steal notification identity from the turn owner", () => {
  const relay = createRelayForRunnerWsTest();
  const client = createEnvelopeClientForRunnerWsTest();
  __TESTING__.attachClientToCodexRelay(relay, client, { envelopeMode: true });

  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "turn/start",
      params: { threadId: "thread-1", prompt: "hello" },
    }),
    false,
    {
      requestId: "owner-op:1:turn-start:id1",
      operationId: "owner-op",
      sessionId: "owner-session",
      threadId: "thread-1",
      endpoint: "/runner-ws",
      remote: "test",
    }
  );
  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { turn: { id: "turn-1" } } }),
    false,
    { endpoint: "/runner-ws", remote: "test" }
  );

  // A panel-hydration probe rides the same (thread-keyed) relay mid-turn.
  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/read",
      params: { threadId: "thread-1", includeTurns: true },
    }),
    false,
    {
      requestId: "reader-op:1:thread-read:id2",
      operationId: "reader-op",
      sessionId: "reader-session",
      threadId: "thread-1",
      endpoint: "/runner-ws",
      remote: "test",
    }
  );
  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: "thread-1", status: "active" } } }),
    false,
    { endpoint: "/runner-ws", remote: "test" }
  );
  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", delta: "pong" },
    }),
    false,
    { endpoint: "/runner-ws", remote: "test" }
  );
  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-1", turnId: "turn-1", status: "completed" },
    }),
    false,
    { endpoint: "/runner-ws", remote: "test" }
  );

  const llmEnvelopes = client.sent.filter((message) => message.channel === "llm" && message.op === "rpc");
  const readResponse = llmEnvelopes.find((message) => message.payload?.id === 2);
  assert.equal(readResponse.operationId, "reader-op");
  assert.equal(readResponse.sessionId, "reader-session");

  const notifications = llmEnvelopes.filter((message) => (
    message.payload?.method === "item/agentMessage/delta" ||
    message.payload?.method === "turn/completed"
  ));
  assert.equal(notifications.length, 2);
  for (const message of notifications) {
    assert.equal(message.operationId, "owner-op");
    assert.equal(message.sessionId, "owner-session");
  }

  // The event log must record the owner identity too, so an identity resume replays
  // the turn's notifications to the owner, not to the rider.
  const loggedNotifications = relay.eventLog.filter((entry) => (
    String(entry.data).includes("item/agentMessage/delta") ||
    String(entry.data).includes("turn/completed")
  ));
  assert.equal(loggedNotifications.length, 2);
  for (const entry of loggedNotifications) {
    assert.equal(entry.operationId, "owner-op");
    assert.equal(entry.sessionId, "owner-session");
  }
});

test("runner-ws cached initialize answer does not rebind the relay identity", () => {
  const relay = createRelayForRunnerWsTest();
  const client = createEnvelopeClientForRunnerWsTest();
  __TESTING__.attachClientToCodexRelay(relay, client, { envelopeMode: true });
  relay.runnerWsLlmOperationId = "owner-op";
  relay.runnerWsLlmSessionId = "owner-session";
  relay.upstreamInitializeResultSeen = true;
  relay.upstreamInitializeResult = { serverInfo: { name: "codex-test" } };

  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} }),
    false,
    {
      requestId: "reader-op:1:initialize:id9",
      operationId: "reader-op",
      sessionId: "reader-session",
      endpoint: "/runner-ws",
      remote: "test",
    }
  );

  assert.equal(relay.upstreamSent.length, 0);
  assert.equal(relay.runnerWsLlmOperationId, "owner-op");
  assert.equal(relay.runnerWsLlmSessionId, "owner-session");
  const cachedResponse = client.sent.find((message) => message.payload?.id === 9);
  assert.equal(cachedResponse.operationId, "reader-op");
});

test("relay keeps numeric and string RPC ids distinct in response routing", () => {
  const relay = createRelayForRunnerWsTest();
  const client = createEnvelopeClientForRunnerWsTest();
  __TESTING__.attachClientToCodexRelay(relay, client, { envelopeMode: true });

  for (const id of [42, "42", "request-alpha"]) {
    __TESTING__.forwardCodexRelayClientData(
      relay,
      JSON.stringify({ jsonrpc: "2.0", id, method: "thread/read", params: { threadId: "thread-1" } }),
      false,
      { requestId: `request-${typeof id}-${id}`, operationId: "operation", sessionId: "session", threadId: "thread-1", clientWs: client }
    );
  }
  assert.deepEqual([...relay.requestIdByRpcId.keys()].sort(), ["n:42", "s:42", "s:request-alpha"]);

  for (const id of ["42", 42, "request-alpha"]) {
    __TESTING__.handleCodexRelayUpstreamMessage(
      relay,
      JSON.stringify({ jsonrpc: "2.0", id, result: { thread: { id: "thread-1" } } }),
      false,
      { endpoint: "/runner-ws", remote: "test" }
    );
  }
  assert.equal(relay.requestIdByRpcId.size, 0);
  const replies = client.sent.filter((message) => message.channel === "llm" && message.payload?.result);
  assert.equal(replies.some((message) => message.payload.id === 42), true);
  assert.equal(replies.some((message) => message.payload.id === "42"), true);
  assert.equal(replies.some((message) => message.payload.id === "request-alpha"), true);
});

test("calendar requests stay with their owner and are excluded from replayable events", () => {
  const relay = createRelayForRunnerWsTest();
  const owner = createEnvelopeClientForRunnerWsTest();
  const observer = createEnvelopeClientForRunnerWsTest();
  __TESTING__.attachClientToCodexRelay(relay, owner, { envelopeMode: true });
  __TESTING__.attachClientToCodexRelay(relay, observer, { envelopeMode: true });
  owner.sent.length = 0;
  observer.sent.length = 0;
  relay.calendarOwner = { ws: owner, operationId: "op-owner", sessionId: "session-owner", threadId: "thread-1", turnId: "turn-1" };
  relay.calendarRequests = new Map();

  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({ jsonrpc: "2.0", id: "42", method: "item/tool/call", params: { namespace: "calendar", tool: "calendar_list_calendars", callId: "call-1", threadId: "thread-1", turnId: "turn-1", arguments: {} } }),
    false,
    { endpoint: "/runner-ws", remote: "test" }
  );
  assert.equal(relay.calendarRequests.size, 1);
  assert.equal(observer.sent.length, 0);
  assert.equal(relay.eventLog.length, 0);

  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({ jsonrpc: "2.0", id: "42", result: { success: true } }),
    false,
    { clientWs: observer, operationId: "op-observer", sessionId: "session-observer", threadId: "thread-1" }
  );
  assert.equal(relay.calendarRequests.size, 1);
  assert.equal(relay.upstreamSent.length, 0);

  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({ jsonrpc: "2.0", id: "42", result: { success: true } }),
    false,
    { clientWs: owner, operationId: "op-owner", sessionId: "session-owner", threadId: "thread-1", turnId: "turn-1" }
  );
  assert.equal(relay.calendarRequests.size, 0);
  assert.equal(JSON.parse(relay.upstreamSent[0]).id, "42");

  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({ jsonrpc: "2.0", method: "item/started", params: { item: { type: "dynamicToolCall", toolName: "calendar_list_calendars" } } }),
    false,
    { endpoint: "/runner-ws", remote: "test" }
  );
  assert.equal(relay.eventLog.length, 0);
  assert.equal(observer.sent.length, 0);
});

test("calendar cancellation responds once and uses the same wire payload for direct and envelope clients", () => {
  for (const envelopeMode of [false, true]) {
    const relay = createRelayForRunnerWsTest();
    const client = envelopeMode ? createEnvelopeClientForRunnerWsTest() : {
      readyState: 1,
      sent: [],
      send(data) { this.sent.push(JSON.parse(String(data))); },
    };
    __TESTING__.attachClientToCodexRelay(relay, client, { envelopeMode });
    relay.calendarRequests = new Map();
    const request = {
      id: 5,
      requestId: "deterministic-request",
      tool: "calendar_create_event",
      owner: { ws: client, operationId: "operation", sessionId: "session", threadId: "thread-1", turnId: "turn-1" },
      turnId: "turn-1",
      done: false,
      timer: setTimeout(() => {}, 60_000),
    };
    relay.calendarRequests.set("n:5", request);
    __TESTING__.terminateCalendarRequest(relay, request, "timeout");
    __TESTING__.terminateCalendarRequest(relay, request, "timeout");
    assert.equal(relay.upstreamSent.length, 1);
    __TESTING__.forwardCodexRelayClientData(
      relay,
      JSON.stringify({ jsonrpc: "2.0", id: 5, result: { success: true } }),
      false,
      { clientWs: client, operationId: "operation", sessionId: "session", threadId: "thread-1", turnId: "turn-1" }
    );
    assert.equal(relay.upstreamSent.length, 1);
    const cancellation = envelopeMode
      ? client.sent.find((message) => message.op === "calendar_request_cancel")?.payload
      : client.sent.find((message) => message.type === "runner_relay_calendar_request_cancel")?.payload;
    assert.equal(cancellation.requestId, "deterministic-request");
    assert.equal(cancellation.appServerRequestId.value, 5);
  }
});

test("owner disconnect and turn interrupt terminate a calendar request exactly once", () => {
  for (const reason of ["owner_disconnect", "interrupt"]) {
    const relay = createRelayForRunnerWsTest();
    const owner = createEnvelopeClientForRunnerWsTest();
    __TESTING__.attachClientToCodexRelay(relay, owner, { envelopeMode: true });
    owner.sent.length = 0;
    relay.calendarOwner = { ws: owner, operationId: "operation", sessionId: "session", threadId: "thread-1", turnId: "turn-1" };
    relay.calendarRequests = new Map();
    const request = {
      id: reason === "interrupt" ? "interrupt-id" : "disconnect-id",
      requestId: `request-${reason}`,
      tool: "calendar_list_calendars",
      owner: relay.calendarOwner,
      turnId: "turn-1",
      done: false,
      timer: setTimeout(() => {}, 60_000),
    };
    relay.calendarRequests.set(`s:${request.id}`, request);
    if (reason === "owner_disconnect") {
      __TESTING__.removeClientFromRelay(relay, owner);
    } else {
      __TESTING__.forwardCodexRelayClientData(
        relay,
        JSON.stringify({ jsonrpc: "2.0", id: 9, method: "turn/interrupt", params: { threadId: "thread-1" } }),
        false,
        { clientWs: owner, operationId: "operation", sessionId: "session", threadId: "thread-1" }
      );
    }
    assert.equal(request.done, true);
    assert.equal(relay.upstreamSent.length, reason === "interrupt" ? 2 : 1);
    assert.equal(relay.calendarRequests.size, 0);
  }
});

test("queued turns with retained calendar tools receive fixed errors without echoing tool arguments", () => {
  const read = __TESTING__.runnerInitiatedCalendarResponse({
    method: "item/tool/call",
    params: { tool: "calendar_search_events", arguments: { start: "private-start", end: "private-end" } },
  });
  const write = __TESTING__.runnerInitiatedCalendarResponse({
    method: "item/tool/call",
    params: { tool: "calendar_create_event", arguments: { title: "private-title" } },
  });
  assert.equal(JSON.parse(read.contentItems[0].text).error.code, "device_unavailable");
  assert.equal(JSON.parse(write.contentItems[0].text).error.code, "foreground_required");
  assert.equal(JSON.stringify([read, write]).includes("private-"), false);
});
