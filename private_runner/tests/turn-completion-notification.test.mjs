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
    broadcast(payload) { broadcasts.push(payload); },
    log: { warn(message) { warnings.push(String(message)); } },
    now: overrides.now || Date.now,
  });
  return { notifier, broadcasts, sends, removals, warnings };
}

function completion(overrides = {}) {
  return {
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
      sessionId: "session-1",
      threadId: "thread-1",
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
    turnId: "turn-1",
  });
});

test("deduplicates the same turn across execution origins", async () => {
  const harness = createHarness();
  await harness.notifier.notifyTurnCompleted(completion({ origin: "location_schedule" }));
  await harness.notifier.notifyTurnCompleted(completion({ origin: "relay" }));
  assert.equal(harness.broadcasts.length, 1);
  assert.equal(harness.sends.length, 1);
});

test("does nothing without a thread id or completed agent text", async () => {
  const harness = createHarness();
  await harness.notifier.notifyTurnCompleted(completion({ threadId: "" }));
  await harness.notifier.notifyTurnCompleted(completion({ agentMessageText: "  " }));
  assert.equal(harness.broadcasts.length, 0);
  assert.equal(harness.sends.length, 0);
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
