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
