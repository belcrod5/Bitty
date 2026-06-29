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
