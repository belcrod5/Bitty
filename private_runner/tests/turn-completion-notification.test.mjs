import assert from "node:assert/strict";
import test from "node:test";

import {
  createTurnCompletionNotifier,
  derivePushDirectoryTitle,
} from "../src/turn-completion-notification.mjs";

function createHarness(overrides = {}) {
  const broadcasts = [];
  const sends = [];
  const removals = [];
  const warnings = [];
  const logs = [];
  const bindingCalls = [];
  const devices = overrides.devices || [
    { deviceId: "device-1", apnsToken: "token-1", env: "sandbox" },
  ];
  const notifier = createTurnCompletionNotifier({
    pushEnabled: overrides.pushEnabled ?? true,
    apnsClient: overrides.apnsClient || {
      async sendToDevice(token, payload, options) {
        sends.push({ token, payload, options });
        return { ok: true, status: 200 };
      },
    },
    pushSummarizer: overrides.pushSummarizer || {
      async summarize(text) { return `summary: ${text}`; },
    },
    pushDeviceStore: overrides.pushDeviceStore || {
      async listDevices() { return devices; },
      async removeDevice(deviceId) { removals.push(deviceId); },
    },
    getPushUnreadSnapshot: overrides.getPushUnreadSnapshot || (async ({ directorySets }) => ({
      targetUnread: true,
      unreadCounts: directorySets.map(() => 0),
    })),
    getVoiceUnreadCount: overrides.getVoiceUnreadCount || (async () => 0),
    getVoiceReplyUnread: overrides.getVoiceReplyUnread || (async () => ({ unread: true })),
    getNormalUnreadCount: overrides.getNormalUnreadCount || (async () => 0),
    getAgentSessionBinding: overrides.getAgentSessionBinding || (async (sessionRef) => {
      bindingCalls.push(sessionRef);
      return { canonicalCwd: "/work/project-a" };
    }),
    broadcast(payload) { broadcasts.push(payload); },
    log: {
      log(message) { logs.push(String(message)); },
      warn(message) { warnings.push(String(message)); },
    },
    now: overrides.now || Date.now,
  });
  return { notifier, broadcasts, sends, removals, warnings, logs, bindingCalls };
}

test("voice completion pushes a logical orchestrator target with combined badge", async () => {
  const harness = createHarness({
    devices: [{ deviceId: "one", apnsToken: "token", env: "sandbox", directories: ["/work"] }],
    getVoiceUnreadCount: async (id) => id ? 1 : 2,
    getNormalUnreadCount: async () => 3,
  });
  await harness.notifier.notifyVoiceCompleted({ orchestratorId: "main", orchestratorName: "メイン",
    logicalConversationId: "logical-1", clientOperationId: "operation-1", completedOrdinal: 2,
    text: "finished" });
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].payload.aps.category, "VOICE_COMPLETED");
  assert.equal(harness.sends[0].payload.aps.badge, 5);
  assert.equal(harness.sends[0].payload.orchestratorId, "main");
  assert.equal(harness.sends[0].payload.sessionId, undefined);
  assert.deepEqual(harness.logs, ["[push] voice completion push sent devices=1/1 orchestrator=main"]);
  await harness.notifier.notifyVoiceCompleted({ orchestratorId: "main", logicalConversationId: "logical-1",
    clientOperationId: "operation-1", completedOrdinal: 2, text: "finished" });
  assert.equal(harness.sends.length, 1);
});

test("voice completion suppresses Push when that exact reply was read", async () => {
  const read = createHarness({ getVoiceReplyUnread: async () => ({ unread: false }) });
  await read.notifier.notifyVoiceCompleted({ orchestratorId: "main", logicalConversationId: "logical-1",
    clientOperationId: "operation-1", completedOrdinal: 1, text: "answer" });
  assert.equal(read.sends.length, 0);
});

test("voice Push rechecks the exact reply after summary without losing another unread reply", async () => {
  let release;
  const summaryGate = new Promise((resolve) => { release = resolve; });
  let readThrough = 0;
  const harness = createHarness({
    pushSummarizer: { async summarize() { await summaryGate; return "summary"; } },
    getVoiceReplyUnread: async (_id, _conversationId, ordinal) => ({ unread: ordinal > readThrough }),
    getVoiceUnreadCount: async () => 1,
    getNormalUnreadCount: async () => 0,
  });
  const first = harness.notifier.notifyVoiceCompleted({ orchestratorId: "main", logicalConversationId: "logical",
    clientOperationId: "one", completedOrdinal: 1, text: "first" });
  await new Promise((resolve) => setImmediate(resolve));
  readThrough = 1;
  release();
  await first;
  assert.equal(harness.sends.length, 0);
  await harness.notifier.notifyVoiceCompleted({ orchestratorId: "main", logicalConversationId: "logical",
    clientOperationId: "two", completedOrdinal: 2, text: "second" });
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].payload.completedOrdinal, 2);
});

test("voice alert survives one device's normal badge lookup failure", async () => {
  const harness = createHarness({
    devices: [
      { deviceId: "bad", apnsToken: "bad-token", env: "sandbox", directories: ["/bad"] },
      { deviceId: "good", apnsToken: "good-token", env: "sandbox", directories: ["/good"] },
    ],
    getVoiceUnreadCount: async () => 2,
    getNormalUnreadCount: async (directories) => {
      if (directories[0] === "/bad") throw new Error("directory unavailable");
      return 3;
    },
  });
  await harness.notifier.notifyVoiceCompleted({ orchestratorId: "main", logicalConversationId: "logical",
    clientOperationId: "one", completedOrdinal: 1, text: "answer" });
  assert.equal(harness.sends.length, 2);
  assert.equal(harness.sends.find((item) => item.token === "bad-token").payload.aps.badge, undefined);
  assert.equal(harness.sends.find((item) => item.token === "good-token").payload.aps.badge, 5);
});

test("voice alert survives aggregate badge lookup failure", async () => {
  const harness = createHarness({ getVoiceUnreadCount: async () => { throw new Error("count unavailable"); } });
  await harness.notifier.notifyVoiceCompleted({ orchestratorId: "main", logicalConversationId: "logical",
    clientOperationId: "one", completedOrdinal: 1, text: "answer" });
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].payload.aps.badge, undefined);
});

function completion(overrides = {}) {
  return {
    backendId: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    sessionId: "session-1",
    agentMessageText: "finished successfully",
    directory: "/work/project-a",
    origin: "location_schedule",
    ...overrides,
  };
}

test("broadcasts and sends one TURN_COMPLETED push with the existing payload shape", async () => {
  const harness = createHarness();
  await harness.notifier.notifyTurnCompleted(completion());

  assert.equal(harness.broadcasts.length, 1);
  assert.deepEqual(
    { ...harness.broadcasts[0], completedAt: "ignored" },
    {
      backendId: "codex",
      sessionId: "session-1",
      threadId: "thread-1",
      directory: "/work/project-a",
      previewText: "finished successfully",
      completedAt: "ignored",
    }
  );
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].token, "token-1");
  assert.deepEqual(harness.sends[0].options, { env: "sandbox" });
  assert.deepEqual(harness.sends[0].payload, {
    aps: {
      alert: { title: "project-a", body: "summary: finished successfully" },
      sound: "default",
      category: "TURN_COMPLETED",
      "thread-id": "session-1",
    },
    sessionId: "session-1",
    backendId: "codex",
    directory: "/work/project-a",
    turnId: "turn-1",
  });
  assert.deepEqual(harness.logs, [
    "[push] turn completion push sent devices=1/1 session=session-1",
  ]);
});

test("notifies once when a provider-neutral Agent turn completes", async () => {
  const harness = createHarness();
  const sessionRef = { backendId: "claude", nativeSessionId: "session-neutral" };
  const events = [
    { type: "turn.started", runId: "run-neutral", sessionRef, payload: { nativeTurnId: "turn-neutral" } },
    { type: "item.started", runId: "run-neutral", sessionRef, payload: { itemId: "assistant-1", itemType: "assistant" } },
    { type: "content.delta", runId: "run-neutral", sessionRef, payload: { itemId: "assistant-1", delta: "streamed " } },
    {
      type: "item.completed",
      runId: "run-neutral",
      sessionRef,
      payload: { itemId: "assistant-1", itemType: "assistant", content: [{ type: "text", text: "earlier answer" }] },
    },
    {
      type: "item.started",
      runId: "run-neutral",
      sessionRef,
      payload: { itemId: "assistant-2", itemType: "assistant" },
    },
    {
      type: "item.completed",
      runId: "run-neutral",
      sessionRef,
      payload: { itemId: "assistant-2", itemType: "assistant", content: [{ type: "text", text: "final answer" }] },
    },
    { type: "turn.completed", runId: "run-neutral", sessionRef, payload: {} },
  ];
  for (const event of events) await harness.notifier.onAgentRunEvent(event);
  await harness.notifier.onAgentRunEvent(events.at(-1));

  assert.deepEqual(harness.bindingCalls, [sessionRef]);
  assert.equal(harness.broadcasts.length, 1);
  assert.equal(harness.broadcasts[0].backendId, "claude");
  assert.equal(harness.broadcasts[0].sessionId, "session-neutral");
  assert.equal(harness.broadcasts[0].previewText, "final answer");
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].payload.backendId, "claude");
  assert.equal(harness.sends[0].payload.turnId, "turn-neutral");
  assert.equal(harness.sends[0].payload.directory, "/work/project-a");
});

test("does not notify for interrupted or failed Agent turns", async () => {
  const harness = createHarness();
  for (const [runId, terminalType] of [
    ["run-interrupted", "turn.interrupted"],
    ["run-failed", "turn.failed"],
  ]) {
    const sessionRef = { backendId: "codex", nativeSessionId: runId };
    await harness.notifier.onAgentRunEvent({
      type: "turn.started", runId, sessionRef, payload: { nativeTurnId: `${runId}-turn` },
    });
    await harness.notifier.onAgentRunEvent({
      type: "item.started", runId, sessionRef, payload: { itemId: `${runId}-assistant`, itemType: "assistant" },
    });
    await harness.notifier.onAgentRunEvent({
      type: "content.delta", runId, sessionRef, payload: { itemId: `${runId}-assistant`, delta: "partial" },
    });
    await harness.notifier.onAgentRunEvent({ type: terminalType, runId, sessionRef, payload: {} });
    await harness.notifier.onAgentRunEvent({ type: "turn.completed", runId, sessionRef, payload: {} });
  }

  assert.deepEqual(harness.bindingCalls, []);
  assert.equal(harness.broadcasts.length, 0);
  assert.equal(harness.sends.length, 0);
});

test("sets an absolute badge from each device directory subscription", async () => {
  const snapshotCalls = [];
  const harness = createHarness({
    devices: [{
      deviceId: "device-1",
      apnsToken: "token-1",
      env: "sandbox",
      directories: ["/one", "/two"],
    }, {
      deviceId: "device-2",
      apnsToken: "token-2",
      env: "sandbox",
      directories: ["/two", "/one"],
    }],
    getPushUnreadSnapshot: async (request) => {
      snapshotCalls.push(request);
      return { targetUnread: true, unreadCounts: [7] };
    },
  });
  await harness.notifier.notifyTurnCompleted(completion());
  assert.deepEqual(snapshotCalls, [{
    directorySets: [["/one", "/two"]],
    targetBackendId: "codex",
    targetSessionId: "session-1",
    targetDirectory: "/work/project-a",
  }]);
  assert.equal(harness.sends.length, 2);
  assert.equal(harness.sends[0].payload.aps.badge, 7);
  assert.equal(harness.sends[1].payload.aps.badge, 7);
});

test("normal completion badge also includes unread voice replies", async () => {
  const harness = createHarness({
    devices: [{ deviceId: "one", apnsToken: "token", env: "sandbox", directories: ["/work"] }],
    getPushUnreadSnapshot: async () => ({ targetUnread: true, unreadCounts: [3] }),
    getVoiceUnreadCount: async () => 2,
  });
  await harness.notifier.notifyTurnCompleted(completion());
  assert.equal(harness.sends[0].payload.aps.badge, 5);
  assert.equal(harness.sends[0].payload.aps.category, "TURN_COMPLETED");
});

test("voice count failure does not lose a normal completion alert or set a wrong badge", async () => {
  const harness = createHarness({
    devices: [{ deviceId: "one", apnsToken: "token", env: "sandbox", directories: ["/work"] }],
    getPushUnreadSnapshot: async () => ({ targetUnread: true, unreadCounts: [3] }),
    getVoiceUnreadCount: async () => { throw new Error("voice store unavailable"); },
  });
  await harness.notifier.notifyTurnCompleted(completion());
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].payload.aps.category, "TURN_COMPLETED");
  assert.equal(harness.sends[0].payload.aps.badge, undefined);
  assert.match(harness.warnings[0], /voice unread count failed/);
});

test("uses the snapshot-resolved directory when completion metadata has no cwd", async () => {
  const snapshotCalls = [];
  const harness = createHarness({
    devices: [{
      deviceId: "device-1",
      apnsToken: "token-1",
      env: "sandbox",
      directories: ["/registered/project-a"],
    }],
    getPushUnreadSnapshot: async (request) => {
      snapshotCalls.push(request);
      return {
        directory: "/registered/project-a",
        targetUnread: true,
        unreadCounts: [3],
      };
    },
  });

  await harness.notifier.notifyTurnCompleted(completion({ directory: "" }));

  assert.deepEqual(snapshotCalls, [{
    directorySets: [["/registered/project-a"]],
    targetBackendId: "codex",
    targetSessionId: "session-1",
    targetDirectory: "",
  }]);
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].payload.directory, "/registered/project-a");
  assert.equal(harness.sends[0].payload.aps.alert.title, "project-a");
  assert.equal(harness.sends[0].payload.aps.badge, 3);
});

test("suppresses completion when the exact unread snapshot fails", async () => {
  const harness = createHarness({
    devices: [{
      deviceId: "device-1",
      apnsToken: "token-1",
      env: "sandbox",
      directories: ["/one"],
    }],
    getPushUnreadSnapshot: async () => { throw new Error("snapshot failed"); },
  });
  await harness.notifier.notifyTurnCompleted(completion());
  assert.equal(harness.sends.length, 0);
  assert.match(harness.warnings.join("\n"), /snapshot failed/);
});

test("checks unread before summarization so a read during summarization does not drop the push", async () => {
  // 完了時点で未読なら通知する仕様。要約生成(最大数秒)の間に既読化されても
  // 判定は要約前に固定されている必要がある。判定が要約後だとこのテストは
  // unread=false を観測して通知が落ちる。
  let unread = true;
  const order = [];
  const harness = createHarness({
    pushSummarizer: {
      async summarize(text) {
        order.push("summarize");
        unread = false; // 要約中にクライアントが既読化した状況を再現
        return `summary: ${text}`;
      },
    },
    getPushUnreadSnapshot: async (request) => {
      order.push("snapshot");
      assert.equal(request.targetSessionId, "session-1");
      assert.equal(request.targetBackendId, "codex");
      assert.equal(request.targetDirectory, "/work/project-a");
      return { targetUnread: unread, unreadCounts: [] };
    },
  });
  await harness.notifier.notifyTurnCompleted(completion());
  assert.deepEqual(order, ["snapshot", "summarize"]);
  assert.equal(harness.sends.length, 1);
});

test("deduplicates the same turn across execution origins", async () => {
  const harness = createHarness();
  await harness.notifier.notifyTurnCompleted(completion({ origin: "location_schedule" }));
  await harness.notifier.notifyTurnCompleted(completion({ origin: "relay" }));
  assert.equal(harness.broadcasts.length, 1);
  assert.equal(harness.sends.length, 1);
});

test("keeps completion deduplication scoped to the provider identity", async () => {
  const harness = createHarness();
  await harness.notifier.notifyTurnCompleted(completion({ backendId: "codex" }));
  await harness.notifier.notifyTurnCompleted(completion({ backendId: "claude" }));
  assert.equal(harness.broadcasts.length, 2);
  assert.equal(harness.sends.length, 2);
});

test("requires a thread id but broadcasts text-free completion boundaries without pushing", async () => {
  const harness = createHarness();
  await harness.notifier.notifyTurnCompleted(completion({ threadId: "" }));
  assert.equal(harness.broadcasts.length, 0);

  await harness.notifier.notifyTurnCompleted(completion({ agentMessageText: "  " }));
  assert.equal(harness.broadcasts.length, 1);
  assert.equal(harness.broadcasts[0].previewText, "");
  assert.equal(harness.sends.length, 0);
});

test("a text-free lifecycle boundary does not suppress a later same-turn push", async () => {
  const harness = createHarness();
  await harness.notifier.notifyTurnCompleted(completion({ agentMessageText: "" }));
  await harness.notifier.notifyTurnCompleted(completion({ agentMessageText: "finished later" }));

  assert.equal(harness.broadcasts.length, 1);
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].payload.aps.alert.body, "summary: finished later");
});

test("broadcasts without APNs when push is disabled", async () => {
  const harness = createHarness({ pushEnabled: false });
  await harness.notifier.notifyTurnCompleted(completion());
  assert.equal(harness.broadcasts.length, 1);
  assert.equal(harness.sends.length, 0);
});

test("contains device-store, summarizer, broadcast, and APNs failures", async (t) => {
  await t.test("device list failure", async () => {
    const harness = createHarness({
      pushDeviceStore: {
        async listDevices() { throw new Error("store failed"); },
        async removeDevice() {},
      },
    });
    await harness.notifier.notifyTurnCompleted(completion());
    assert.equal(harness.broadcasts.length, 1);
    assert.match(harness.warnings.join("\n"), /store failed/);
  });

  await t.test("summarizer failure", async () => {
    const harness = createHarness({
      pushSummarizer: { async summarize() { throw new Error("summary failed"); } },
    });
    await harness.notifier.notifyTurnCompleted(completion());
    assert.match(harness.warnings.join("\n"), /summary failed/);
  });

  await t.test("broadcast and APNs failures", async () => {
    const warnings = [];
    const notifier = createTurnCompletionNotifier({
      pushEnabled: true,
      apnsClient: { async sendToDevice() { throw new Error("apns failed"); } },
      pushSummarizer: { async summarize(text) { return text; } },
      pushDeviceStore: {
        async listDevices() { return [{ deviceId: "device-1", apnsToken: "token-1", env: "sandbox" }]; },
        async removeDevice() {},
      },
      getPushUnreadSnapshot: async () => ({ targetUnread: true, unreadCounts: [] }),
      broadcast() { throw new Error("broadcast failed"); },
      log: { warn(message) { warnings.push(String(message)); } },
    });
    await notifier.notifyTurnCompleted(completion());
    assert.match(warnings.join("\n"), /broadcast failed/);
    assert.match(warnings.join("\n"), /apns failed/);
  });
});

test("removes an APNs device reported as unregistered", async () => {
  const removals = [];
  const harness = createHarness({
    apnsClient: { async sendToDevice() { return { ok: false, status: 410 }; } },
    pushDeviceStore: {
      async listDevices() { return [{ deviceId: "gone", apnsToken: "token-gone", env: "sandbox" }]; },
      async removeDevice(deviceId) { removals.push(deviceId); },
    },
  });
  await harness.notifier.notifyTurnCompleted(completion());
  assert.deepEqual(removals, ["gone"]);
});

test("allows the same turn after the six-hour deduplication TTL", async () => {
  let nowMs = 1000;
  const harness = createHarness({ pushEnabled: false, now: () => nowMs });
  await harness.notifier.notifyTurnCompleted(completion());
  nowMs += 6 * 60 * 60 * 1000 - 1;
  await harness.notifier.notifyTurnCompleted(completion());
  assert.equal(harness.broadcasts.length, 1);
  nowMs += 1;
  await harness.notifier.notifyTurnCompleted(completion());
  assert.equal(harness.broadcasts.length, 2);
});

test("bounds deduplication memory and evicts the oldest of 1001 turns", async () => {
  let nowMs = 0;
  const harness = createHarness({ pushEnabled: false, now: () => nowMs++ });
  for (let index = 0; index <= 1000; index += 1) {
    await harness.notifier.notifyTurnCompleted(completion({ threadId: `thread-${index}` }));
  }
  await harness.notifier.notifyTurnCompleted(completion({ threadId: "thread-0" }));
  assert.equal(harness.broadcasts.length, 1002);
});

test("derives and caps notification titles from the working directory", () => {
  assert.equal(derivePushDirectoryTitle("/Volumes/SSD-500GB-SanDisk/work/test_folder"), "test_folder");
  assert.equal(derivePushDirectoryTitle("/work/test_folder/"), "test_folder");
  assert.equal(derivePushDirectoryTitle("relative/dir"), "dir");
  assert.equal(derivePushDirectoryTitle(""), "");
  assert.equal(derivePushDirectoryTitle("/"), "/");
  assert.equal(derivePushDirectoryTitle(`/work/${"x".repeat(200)}`), `${"x".repeat(57)}...`);
});


test("schedule failure pushes do not require a session, unread state or LLM summarization", async () => {
  const harness = createHarness({
    devices: [{ deviceId: "a", apnsToken: "a", env: "sandbox" }, { deviceId: "b", apnsToken: "b", env: "production" }],
    pushSummarizer: { summarize() { throw new Error("must not summarize failures"); } },
    getPushUnreadSnapshot() { throw new Error("must not require a session"); },
  });
  const failure = { schedule: { id: "schedule-1", name: "Parking check", action: { kind: "llm", cwd: "/work", threadId: null } },
    occurrenceAt: "2026-10-02T00:00:00.000Z", result: null, errorCode: "capability_unsupported", errorMessage: "model value is not supported" };
  await harness.notifier.notifyScheduleFailed(failure);
  await harness.notifier.notifyScheduleFailed(failure);
  assert.equal(harness.sends.length, 2);
  const payload = harness.sends[0].payload;
  assert.equal(payload.aps.category, "SCHEDULE_FAILED");
  assert.match(payload.aps.alert.body, /Parking check.*model value is not supported/);
  assert.equal(payload.scheduleId, "schedule-1");
  assert.equal(payload.sessionId, undefined);
  assert.equal(payload.aps.badge, undefined);
  assert.equal(harness.broadcasts.length, 0);
  await harness.notifier.notifyScheduleFailed({ ...failure, occurrenceAt: "2026-10-03T00:00:00.000Z", result: { threadId: "started-thread" } });
  assert.equal(harness.sends.length, 4);
  assert.equal(harness.sends[2].payload.sessionId, "started-thread");
  assert.equal(harness.sends[2].payload.backendId, "codex");
});

test("failure push delivery isolates APNs errors and removes expired tokens", async () => {
  const harness = createHarness({ devices: [{ deviceId: "expired", apnsToken: "expired" }, { deviceId: "throwing", apnsToken: "throwing" }],
    apnsClient: { async sendToDevice(token) { if (token === "expired") return { ok: false, status: 410 }; throw new Error("offline"); } },
  });
  await harness.notifier.notifyScheduleFailed({ schedule: { id: "schedule-1", name: "check", action: { kind: "script", cwd: "/work" } },
    occurrenceAt: "2026-10-02T00:00:00.000Z", errorCode: "script_failed", errorMessage: "failed" });
  assert.deepEqual(harness.removals, ["expired"]);
  assert.equal(harness.warnings.length, 1);
});
