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
    currentTurnStartSeq: 0,
    lastAgentMessageText: "",
    assistantThinkingPrefixSent: false,
    assistantThinkingBodyText: "",
    assistantThinkingBodyTextByItemId: new Map(),
    assistantThinkingCurrentItemId: "",
    assistantThinkingTurnActive: false,
    assistantThinkingTurnId: "",
    turnCompletedNotificationSent: false,
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

test("runner-ws LLM notifications without rpc id keep current operation metadata", () => {
  const relay = createRelayForRunnerWsTest();
  const client = createEnvelopeClientForRunnerWsTest();
  __TESTING__.attachClientToCodexRelay(relay, client, { envelopeMode: true });

  __TESTING__.forwardCodexRelayClientData(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "turn/start",
      params: { threadId: "thread-1", prompt: "hello" },
    }),
    false,
    {
      requestId: "request-1",
      operationId: "operation-1",
      sessionId: "session-1",
      threadId: "thread-1",
      endpoint: "/runner-ws",
      remote: "test",
    }
  );

  assert.equal(relay.upstreamSent.length, 1);

  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({ jsonrpc: "2.0", id: 4, result: {} }),
    false,
    { endpoint: "/runner-ws", remote: "test" }
  );
  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "pong" },
    }),
    false,
    { endpoint: "/runner-ws", remote: "test" }
  );
  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-1", status: "completed" },
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
    assert.equal(message.threadId, "thread-1");
  }

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
    assert.equal(message.threadId, "thread-1");
  }
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
      params: { threadId: "thread-1", delta: "pong" },
    }),
    false,
    { endpoint: "/runner-ws", remote: "test" }
  );
  __TESTING__.handleCodexRelayUpstreamMessage(
    relay,
    JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-1", status: "completed" },
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
