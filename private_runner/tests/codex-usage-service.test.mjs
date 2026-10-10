import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexUsageService, codexUsageFromWham } from "../src/codex-usage-service.mjs";
import { createTurnCompletionNotifier } from "../src/turn-completion-notification.mjs";

const window = (usedPercent, resetsAt = 2000, windowDurationMins = 300) => ({ usedPercent, resetsAt, windowDurationMins });
const update = (usedPercent, resetsAt = 2000) => ({ rateLimits: { primary: window(usedPercent, resetsAt) } });
async function fixture(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-codex-usage-"));
  const sent = [], changed = [];
  let nowMs = 1_000_000;
  const options = { storePath: path.join(dir, "usage.json"), now: () => nowMs,
    onChanged: (event) => changed.push(event), onLimitReached: (event) => sent.push(event) };
  try { await callback({ service: createCodexUsageService(options), options, sent, changed, advance: (value) => { nowMs = value; } }); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test("concurrent agents and ingress APIs reserve one account episode before asynchronous fanout", async () => {
  await fixture(async ({ service, options, sent }) => {
    let release;
    options.onLimitReached = async (event) => { sent.push(event); await new Promise((resolve) => { release = resolve; }); };
    service = createCodexUsageService(options);
    const first = service.observe("account-a", codexUsageFromWham({ rate_limit: { primary_window:
      { used_percent: 100, reset_at: 2000, limit_window_seconds: 18000 } } }));
    await service.snapshot("account-a");
    const duplicates = Array.from({ length: 20 }, () => service.observeNotification("account-a", "account/rateLimits/updated", update(100)));
    await Promise.all(duplicates);
    assert.equal(sent.length, 1);
    release();
    await first;
    const second = service.observe("account-b", update(100));
    await service.snapshot("account-b");
    release();
    await second;
    assert.equal(sent.length, 2);
  });
});

test("accounts, persisted restarts and distinct exhaustion windows do not create duplicate pushes", async () => {
  await fixture(async ({ service, options, sent }) => {
    await service.observe("a", update(100));
    await service.observe("b", update(100));
    await service.observe("a", { rateLimits: { secondary: window(100, 9000, 10080) } });
    await createCodexUsageService(options).observe("a", update(100));
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((event) => event.accountId), ["a", "b"]);
  });
});

test("lower and older late snapshots cannot rearm an episode; reset and recovery can", async () => {
  await fixture(async ({ service, sent, advance }) => {
    await service.observe("a", update(100));
    await service.observe("a", update(20));
    await service.observe("a", update(100, 1900));
    assert.equal(sent.length, 1);
    assert.match((await service.snapshot("a")).statusText, /0% left/);
    advance(2_001_000);
    const recovered = await service.observe("a", update(20, 3000));
    assert.equal(recovered.usageLimitReached, false);
    await service.observe("a", update(100, 3000));
    assert.equal(sent.length, 2);
  });
});

test("a newly exhausted reset window starts a new episode even if recovery was not observed", async () => {
  await fixture(async ({ service, sent, advance }) => {
    await service.observe("a", update(100));
    advance(2_001_000);
    await service.observe("a", update(100, 3000));
    await service.observe("a", update(100, 3000));
    assert.equal(sent.length, 2);
  });
});

test("typed failure alone notifies, sparse nullable updates do not recover cached allowed state", async () => {
  await fixture(async ({ service, sent }) => {
    await service.observe("a", { ...update(50), ordinaryUsageAllowed: true });
    await service.observeNotification("a", "error", { error: { codexErrorInfo: "usageLimitExceeded" } });
    await service.observe("a", { ...update(50), ordinaryUsageAllowed: null });
    await service.observeNotification("a", "turn/completed", { turn: { status: "failed", error: { codexErrorInfo: "usageLimitExceeded" } } });
    assert.equal(sent.length, 1);
    assert.equal((await service.snapshot("a")).usageLimitReached, true);
    await service.observe("a", { ordinaryUsageAllowed: true });
    await service.observeNotification("a", "error", { error: { codexErrorInfo: "usageLimitExceeded" } });
    assert.equal(sent.length, 2);
  });
});

test("transient rate limits, invalid quotas, other buckets and mismatched accounts never notify", async () => {
  await fixture(async ({ service, sent }) => {
    await service.observeNotification("a", "error", { error: { codexErrorInfo: "rateLimitExceeded" } });
    await service.observe("a", { accountId: "b", ...update(100) });
    await service.observe("a", { rateLimits: { primary: { usedPercent: null }, secondary: { usedPercent: "100" } } });
    await service.observe("a", { rateLimits: { limitId: "other-model", primary: window(100) } });
    assert.equal(sent.length, 0);
    assert.equal((await service.snapshot("a")).statusText, "");
  });
});

test("sparse window positions and nullable metadata preserve both quota durations", async () => {
  await fixture(async ({ service }) => {
    await service.observe("a", { rateLimits: { primary: window(10), secondary: window(30, 9000, 10080) } });
    await service.observe("a", { rateLimits: { primary: window(40, 9000, 10080), secondary: null } });
    const snapshot = await service.snapshot("a");
    assert.match(snapshot.statusText, /5h limit:[^\n]*90% left/);
    assert.match(snapshot.statusText, /Weekly limit:[^\n]*60% left/);
  });
});

test("explicit permission and usable credits govern blocks, null permission cannot infer recovery", async () => {
  await fixture(async ({ service, sent, advance }) => {
    await service.observe("a", { ...update(100), ordinaryUsageAllowed: false,
      rateLimits: { ...update(100).rateLimits, credits: { hasCredits: true, unlimited: false } } });
    assert.equal(sent.length, 0);
    await service.observe("a", { rateLimits: { credits: { hasCredits: false, unlimited: false } } });
    assert.equal(sent.length, 1);
    advance(2_001_000);
    await service.observe("a", { ...update(0, 3000), ordinaryUsageAllowed: null });
    assert.equal((await service.snapshot("a")).usageLimitReached, true);
    await service.observe("a", { ordinaryUsageAllowed: true });
    assert.equal((await service.snapshot("a")).usageLimitReached, false);
  });
});

test("one episode fans out once per device without invoking the exhausted Codex summarizer", async () => {
  await fixture(async ({ options }) => {
    const deliveries = [], removed = [];
    const notifier = createTurnCompletionNotifier({ pushEnabled: true,
      pushSummarizer: { summarize() { throw new Error("must not invoke Codex"); } },
      pushDeviceStore: { listDevices: async () => [{ deviceId: "one", apnsToken: "token1", env: "production" },
        { deviceId: "two", apnsToken: "token2", env: "sandbox" }], removeDevice: async (id) => removed.push(id) },
      apnsClient: { sendToDevice: async (token, payload, config) => {
        deliveries.push({ token, payload, config }); return token === "token2" ? { status: 410 } : { ok: true }; } },
    });
    const service = createCodexUsageService({ ...options, onLimitReached: notifier.notifyUsageLimitReached });
    await Promise.all(Array.from({ length: 20 }, () => service.observe("a", update(100))));
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0].payload.aps.category, "CODEX_USAGE_LIMIT");
    assert.equal(deliveries[0].payload.sessionId, undefined);
    assert.deepEqual(removed, ["two"]);
  });
});


test("introducing a quota duration while swapping provider positions keeps both windows", async () => {
  await fixture(async ({ service }) => {
    await service.observe("a", update(10));
    await service.observe("a", { rateLimits: { primary: window(40, 9000, 10080), secondary: window(20) } });
    const snapshot = await service.snapshot("a");
    assert.match(snapshot.statusText, /5h limit:[^\n]*80% left/);
    assert.match(snapshot.statusText, /Weekly limit:[^\n]*60% left/);
  });
});

test("fresh spend-control recovery clears only that block, nullable updates preserve it", async () => {
  await fixture(async ({ service, sent }) => {
    await service.observe("a", { rateLimits: { primary: window(50), spendControlReached: true } });
    await service.observe("a", { rateLimits: { spendControlReached: null } });
    assert.equal((await service.snapshot("a")).usageLimitReached, true);
    await service.observe("a", { rateLimits: { spendControlReached: false } });
    assert.equal((await service.snapshot("a")).usageLimitReached, false);
    await service.observe("a", update(100));
    await service.observe("a", { rateLimits: { spendControlReached: true } });
    await service.observe("a", { rateLimits: { spendControlReached: false } });
    assert.equal((await service.snapshot("a")).usageLimitReached, true);
    assert.equal(sent.length, 2);
  });
});

test("a pre-failure read cannot recover with stale permission or credits and rearm notifications", async () => {
  await fixture(async ({ service, sent, advance }) => {
    await service.observe("a", { ...update(50), ordinaryUsageAllowed: true });
    advance(1_001_000);
    await service.observeNotification("a", "error", { error: { codexErrorInfo: "usageLimitExceeded" } });
    const failure = await service.snapshot("a");
    await service.observe("a", { ...update(50), ordinaryUsageAllowed: true, rateLimits: {
      primary: window(50), credits: { hasCredits: true, unlimited: false }, spendControlReached: false,
    } }, { observedAt: 1_000_000 });
    assert.deepEqual(await service.snapshot("a"), failure);
    await service.observeNotification("a", "error", { error: { codexErrorInfo: "usageLimitExceeded" } });
    assert.equal(sent.length, 1);
  });
});

test("explicitly denied usage can begin a later reset episode without an observed recovery gap", async () => {
  await fixture(async ({ service, sent, advance }) => {
    await service.observe("a", { ...update(100), ordinaryUsageAllowed: false });
    advance(2_001_000);
    await service.observe("a", { ...update(100, 3000), ordinaryUsageAllowed: false });
    await service.observe("a", { ...update(100, 3000), ordinaryUsageAllowed: false });
    assert.equal(sent.length, 2);
  });
});

test("later exhausted rolling quota overrides an earlier healthy permission", async () => {
  await fixture(async ({ service, sent }) => {
    await service.observe("a", { ...update(50), ordinaryUsageAllowed: true });
    await service.observeNotification("a", "account/rateLimits/updated", update(100));
    assert.equal(sent.length, 1);
    await service.observeNotification("a", "error", { error: { codexErrorInfo: "usageLimitExceeded" } });
    assert.equal(sent.length, 1);
  });
});

test("a failed foreground broadcast cannot consume the background account alert", async () => {
  await fixture(async ({ options, sent }) => {
    const service = createCodexUsageService({ ...options, onChanged: () => { throw new Error("socket closed"); } });
    await service.observe("a", update(100));
    assert.equal(sent.length, 1);
  });
});

test("an old denied read cannot replace a newer recovery and produce a false alert", async () => {
  await fixture(async ({ service, sent, advance }) => {
    await service.observe("a", { ...update(100), ordinaryUsageAllowed: false });
    advance(1_002_000);
    await service.observe("a", { ordinaryUsageAllowed: true, rateLimits: { credits: { hasCredits: true, unlimited: false } } });
    const recovery = await service.snapshot("a");
    await service.observe("a", { ...update(100), ordinaryUsageAllowed: false, rateLimits: {
      primary: window(100), credits: { hasCredits: false, unlimited: false },
    } }, { observedAt: 1_001_000 });
    assert.deepEqual(await service.snapshot("a"), recovery);
    assert.equal(sent.length, 1);
  });
});
