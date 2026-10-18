import assert from "node:assert/strict";
import test from "node:test";
import { createWidgetRefreshNotifier } from "../src/widget-refresh-notifier.mjs";

function fixture(overrides = {}) {
  let now = 0;
  const timers = [], sent = [], removed = [];
  const notifier = createWidgetRefreshNotifier({ enabled: true, now: () => now,
    schedule: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    deviceStore: { listDevices: async () => [{ deviceId: "device", apnsToken: "TOKEN", env: "sandbox" }],
      removeDevice: async (id) => removed.push(id) },
    apnsClient: { sendToDevice: async (...args) => { sent.push(args); return { ok: true }; } }, ...overrides });
  return { notifier, timers, sent, removed, setNow: (value) => { now = value; } };
}

test("coalesces changes and sends only opaque silent hints within the 3/hour budget", async () => {
  const f = fixture();
  f.notifier.changed(); f.notifier.changed(); f.notifier.changed();
  assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, 0);
  await f.timers.shift().callback();
  assert.deepEqual(f.sent[0], ["TOKEN", { aps: { "content-available": 1 }, bittyWidgetRefresh: 1 },
    { env: "sandbox", pushType: "background", priority: 5, collapseId: "bitty-widget-refresh" }]);
  f.setNow(60_000); f.notifier.changed(); f.notifier.changed();
  assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, 19 * 60_000);
  f.setNow(20 * 60_000); await f.timers.shift().callback();
  assert.equal(f.sent.length, 2); assert.equal(f.timers.length, 0);
});

test("changes during in-flight delivery get one trailing refresh instead of being lost", async () => {
  let finish;
  const f = fixture({ apnsClient: { sendToDevice: () => new Promise((resolve) => { finish = resolve; }) } });
  f.notifier.changed(); const delivery = f.timers.shift().callback();
  await Promise.resolve(); f.notifier.changed();
  finish({ ok: true }); await delivery;
  assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, 20 * 60_000);
});

test("disabled push cannot schedule deliveries and failed device delivery never rejects agent work", async () => {
  const disabled = fixture({ enabled: false }); disabled.notifier.changed(); assert.equal(disabled.timers.length, 0);
  const failing = fixture({ apnsClient: { sendToDevice: async () => { throw new Error("offline"); } } });
  failing.notifier.changed(); await failing.timers.shift().callback();
});
