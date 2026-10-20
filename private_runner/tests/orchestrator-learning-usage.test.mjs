import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOrchestratorLearningUsage } from "../src/orchestrator-learning-usage.mjs";

const reservation = (extra = {}) => ({ batchId: "batch-1", attempt: 1, settingsRevision: 1,
  model: "model-a", effort: "high", estimatedInputTokens: 1000, maxOutputTokens: 4000, ...extra });
const price = (extra = {}) => ({ version: "local-2026-10", source: "user-configured-contract", currency: "USD",
  validFrom: "2026-01-01T00:00:00Z", contract: "api", model: "model-a",
  ratesPerMillion: { input: 10, cachedInput: 1, output: 30 }, ...extra });
const measured = (extra = {}) => ({ status: "completed", reportedModel: "model-a", usage: {
  inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400, reasoningOutputTokens: 100,
  cachedInputIncluded: true, reasoningOutputIncluded: true, source: "runtime-turn-difference", schema: "v2", ...extra } });

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrator-learning-usage-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let time = Date.parse("2026-10-20T12:00:00Z");
  const config = { directory, now: () => time, ...options };
  const store = createOrchestratorLearningUsage(config);
  return { directory, store, config, advance: (ms) => { time += ms; } };
}

function aggregate(history) {
  return Object.values(history.days).flatMap((day) => Object.values(day.buckets));
}

test("reservations are durable before return, calls serialize, and restart consumes unknown reservations", async (t) => {
  const { store, config, directory } = await fixture(t, { limits: { dailyCalls: 2, dailyTokens: 10_000 } });
  const calls = await Promise.all([store.reserve(reservation()), store.reserve(reservation({ attempt: 2 })), store.reserve(reservation({ attempt: 3 }))]);
  assert.deepEqual(calls.map((call) => call.ok), [true, true, false]);
  const disk = JSON.parse(await fs.readFile(path.join(directory, "ledger.json"), "utf8"));
  assert.equal(disk.calls.length, 2);
  assert.equal(disk.calls[0].status, "pending");
  const restarted = createOrchestratorLearningUsage(config);
  assert.deepEqual((await restarted.status()).budget, { day: "2026-10-20", calls: 2, tokens: 10_000, maxCalls: 2, maxTokens: 10_000 });
  assert.equal((await restarted.history()).calls[0].status, "unknown");
  assert.equal((await restarted.history()).calls[0].usage.inputTokens, null);
  assert.equal((await restarted.reserve(reservation())).ok, false);
});

test("late usage replaces a reservation once and cached/reasoning counters do not inflate total tokens or price", async (t) => {
  const { store } = await fixture(t);
  await store.configurePrice(price());
  const { call } = await store.reserve(reservation());
  await store.settle(call.callId, { status: "failed", reasonCode: "connection-lost" });
  assert.equal((await store.status()).budget.tokens, 5000);
  const result = await store.settle(call.callId, measured());
  assert.equal(result.call.cost.amount, 0.0124);
  assert.equal(result.call.cost.kind, "rate-estimate");
  assert.equal(result.budget.tokens, 1200);
  await store.settle(call.callId, measured());
  const buckets = aggregate(await store.history());
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].totals.calls, 1);
  assert.equal(buckets[0].totals.budgetTokens, 1200);
  assert.equal(buckets[0].totals.estimatedAmount, 0.0124);
  assert.equal(buckets[0].totals.reasoningOutputTokens, 100);
});

test("missing, partial, and inconsistent usage remains distinct from zero", async (t) => {
  const { store } = await fixture(t);
  const { call } = await store.reserve(reservation());
  const partial = await store.settle(call.callId, { status: "interrupted", usage: { outputTokens: 300 } });
  assert.equal(partial.call.usage.state, "partial");
  assert.equal(partial.call.usage.inputTokens, null);
  assert.equal(partial.budget.tokens, 5000);
  const zero = await store.settle(call.callId, { status: "completed", usage: { inputTokens: 0, outputTokens: 0 } });
  assert.equal(zero.call.usage.state, "measured");
  assert.equal(zero.budget.tokens, 0);
  const inconsistent = await store.settle(call.callId, { status: "completed", usage: { inputTokens: 100, outputTokens: 200, totalTokens: 400 } });
  assert.equal(inconsistent.call.usage.state, "partial");
  assert.equal(inconsistent.budget.tokens, 5000);
});

test("partial total usage above the reservation is charged without inventing missing breakdowns", async (t) => {
  const { store, config } = await fixture(t);
  const { call } = await store.reserve(reservation());
  const result = await store.settle(call.callId, { status: "completed", usage: { totalTokens: 7000 } });
  assert.equal(result.call.usage.state, "partial");
  assert.equal(result.call.usage.inputTokens, null);
  assert.equal(result.call.usage.outputTokens, null);
  assert.equal(result.budget.tokens, 7000);
  const restarted = createOrchestratorLearningUsage(config);
  assert.equal((await restarted.status()).budget.tokens, 7000);
  assert.equal((await restarted.status()).today.reservationChargedTokens, 7000);
});

test("unknown price, unconfirmed model/inclusion, and cache writes are unpriced without inventing zero cost", async (t) => {
  const { store } = await fixture(t);
  const first = await store.reserve(reservation());
  assert.equal((await store.settle(first.call.callId, measured())).call.cost.amount, null);
  await store.configurePrice(price());
  const second = await store.reserve(reservation({ attempt: 2 }));
  assert.equal((await store.settle(second.call.callId, { status: "completed", usage: measured().usage })).call.reportedModel, null);
  assert.equal((await store.settle(second.call.callId, { status: "completed", usage: measured().usage })).call.cost.reason, "price-model-unconfirmed");
  assert.equal((await store.settle(second.call.callId, measured({ cacheWriteInputTokens: 10 }))).call.cost.reason, "cache-write-price-unavailable");
  const third = await store.reserve(reservation({ attempt: 3 }));
  assert.equal((await store.settle(third.call.callId, measured({ cachedInputIncluded: null }))).call.cost.reason, "usage-inclusion-unconfirmed");
});

test("price snapshots and currencies survive reconfiguration, rather than repricing earlier calls", async (t) => {
  const { store } = await fixture(t);
  await store.configurePrice(price());
  const first = await store.reserve(reservation());
  await store.configurePrice(price({ version: "other-contract", currency: "JPY", ratesPerMillion: { input: 1000, cachedInput: 100, output: 3000 } }));
  const second = await store.reserve(reservation({ attempt: 2 }));
  await store.settle(first.call.callId, measured());
  await store.settle(second.call.callId, measured());
  const buckets = aggregate(await store.history());
  assert.equal(buckets.length, 2);
  assert.deepEqual(new Set(buckets.map((bucket) => bucket.dimensions.currency)), new Set(["USD", "JPY"]));
  assert.equal((await store.history()).calls[0].priceSnapshot.ratesPerMillion.input, 10);
});

test("reported provider is distinct from requested provider and runtime in details and aggregates", async (t) => {
  const { store, config } = await fixture(t);
  const { call } = await store.reserve(reservation({ provider: "requested-provider", runtime: "codex-app-server" }));
  const result = await store.settle(call.callId, { ...measured(), reportedProvider: "actual-provider" });
  assert.equal(result.call.provider, "requested-provider");
  assert.equal(result.call.reportedProvider, "actual-provider");
  assert.equal(result.call.runtime, "codex-app-server");
  const restarted = createOrchestratorLearningUsage(config);
  assert.equal((await restarted.status()).blockedReason, null);
  assert.equal(aggregate(await restarted.history())[0].dimensions.reportedProvider, "actual-provider");
});

test("bounded details compact atomically into daily buckets and later unmatched usage cannot change totals", async (t) => {
  const { store, config } = await fixture(t, { limits: { detailCount: 1 } });
  const first = await store.reserve(reservation());
  await store.settle(first.call.callId, measured());
  const second = await store.reserve(reservation({ attempt: 2 }));
  const history = await store.history();
  assert.equal(history.calls.length, 1);
  assert.equal(history.calls[0].callId, second.call.callId);
  assert.equal(history.days["2026-10-20"].compacted.count, 1);
  assert.match(history.days["2026-10-20"].compacted.callIdHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(history.days["2026-10-20"].compacted.reasons, ["capacity"]);
  const before = (await store.status()).budget;
  assert.equal((await store.settle(first.call.callId, measured({ inputTokens: 1 }))).reason, "call-not-retained");
  assert.deepEqual((await store.status()).budget, before);
  const restarted = createOrchestratorLearningUsage(config);
  assert.deepEqual((await restarted.status()).budget, before);
  assert.equal(aggregate(await restarted.history()).reduce((n, bucket) => n + bucket.totals.calls, 0), 2);
});

test("retained late settlement moves old contribution instead of counting it twice after aggregation", async (t) => {
  const { store } = await fixture(t, { limits: { detailCount: 2 } });
  const calls = [];
  for (let attempt = 1; attempt <= 3; attempt++) calls.push((await store.reserve(reservation({ attempt }))).call);
  const late = calls[1];
  await store.settle(late.callId, measured());
  await store.settle(late.callId, measured());
  assert.equal((await store.status()).budget.tokens, 11_200);
  assert.equal(aggregate(await store.history()).reduce((n, bucket) => n + bucket.totals.calls, 0), 3);
});

test("storage failure prevents the call, pauses later reservations, and explicit recovery reloads durable state", async (t) => {
  let fail = true;
  const fileSystem = { ...fs, rename: async (...args) => { if (fail) throw new Error("disk unavailable"); return fs.rename(...args); } };
  const { store } = await fixture(t, { fileSystem });
  await assert.rejects(store.reserve(reservation()), /disk unavailable/);
  assert.equal((await store.reserve(reservation())).reason, "usage-storage-failed");
  fail = false;
  assert.equal((await store.recover()).ok, true);
  assert.equal((await store.status()).budget.calls, 0);
  assert.equal((await store.reserve(reservation())).ok, true);
});

test("aggregate capacity pauses learning without discarding accounted calls", async (t) => {
  const { store } = await fixture(t, { limits: { aggregateBytes: 10 } });
  assert.equal((await store.reserve(reservation())).reason, "usage-capacity-exceeded");
  assert.equal((await store.status()).detailCount, 0);
  assert.equal((await store.status()).budget.calls, 0);
});

test("UTC date budgets reset on date change, while deleting logs cannot refill today's budget", async (t) => {
  const { store, config, advance } = await fixture(t, { limits: { dailyCalls: 1 } });
  const { call } = await store.reserve(reservation());
  await store.detachLearning();
  assert.equal((await store.history()).calls[0].batchId, null);
  assert.equal((await store.clearHistory()).ok, true);
  assert.equal((await store.history()).calls.length, 0);
  assert.equal((await store.settle(call.callId, measured())).reason, "call-not-retained");
  assert.equal((await store.reserve(reservation())).ok, false);
  const restarted = createOrchestratorLearningUsage(config);
  assert.equal((await restarted.status()).budget.tokens, 5000);
  advance(24 * 60 * 60 * 1000);
  assert.equal((await restarted.reserve(reservation())).ok, true);
  assert.equal((await restarted.history()).days["2026-10-20"], undefined);
});

test("anonymous budget expiry preserves later same-day calls across rollover and restart", async (t) => {
  const { store, config, advance } = await fixture(t);
  await store.reserve(reservation());
  await store.clearHistory();
  const retained = await store.reserve(reservation({ attempt: 2 }));
  await store.settle(retained.call.callId, measured());
  advance(24 * 60 * 60 * 1000);
  await store.reserve(reservation({ attempt: 3 }));
  const restarted = createOrchestratorLearningUsage(config);
  assert.equal((await restarted.status()).blockedReason, null);
  assert.equal((await restarted.status()).budget.calls, 1);
  assert.equal((await restarted.status()).budget.tokens, 5000);
  const oldDay = (await restarted.history()).days["2026-10-20"];
  assert.equal(oldDay.buckets.anonymous, undefined);
  assert.equal(oldDay.compacted.count, 0);
  assert.equal(Object.values(oldDay.buckets).reduce((sum, bucket) => sum + bucket.totals.calls, 0), 1);
});

test("logs retain only defined metadata and malformed persisted state fails closed", async (t) => {
  const { store, config, directory } = await fixture(t);
  const { call } = await store.reserve(reservation({ prompt: "secret prompt", apiKey: "secret key" }));
  await store.settle(call.callId, { ...measured(), answer: "private answer" });
  const raw = await fs.readFile(path.join(directory, "ledger.json"), "utf8");
  assert.doesNotMatch(raw, /secret prompt|secret key|private answer/);
  await fs.writeFile(path.join(directory, "ledger.json"), "{broken");
  const restarted = createOrchestratorLearningUsage(config);
  assert.equal((await restarted.reserve(reservation())).reason, "usage-ledger-unreadable");
});

test("unsafe token sums cannot corrupt accounting and overflowing price estimates stay unpriced", async (t) => {
  const { store } = await fixture(t);
  await store.configurePrice(price({ ratesPerMillion: { input: 1e308, cachedInput: 1e308, output: 1e308 } }));
  const { call } = await store.reserve(reservation());
  await assert.rejects(store.settle(call.callId, measured({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 })), /Unsafe learning usage total/);
  assert.equal((await store.status()).budget.tokens, 5000);
  const result = await store.settle(call.callId, measured());
  assert.equal(result.call.cost.amount, null);
  assert.equal(result.call.cost.reason, "cost-overflow");
  assert.deepEqual((await store.status()).today.estimatedCosts, []);
});

test("valid JSON with corrupt budget fields is rejected rather than replenishing limits", async (t) => {
  const { store, config, directory } = await fixture(t);
  await store.reserve(reservation());
  const file = path.join(directory, "ledger.json");
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  Object.values(raw.days["2026-10-20"].buckets)[0].totals.budgetTokens = -1000;
  await fs.writeFile(file, JSON.stringify(raw));
  const restarted = createOrchestratorLearningUsage(config);
  assert.equal((await restarted.reserve(reservation())).reason, "usage-ledger-unreadable");
});

test("usage directory and ledger symlinks are rejected without reading or changing their targets", async (t) => {
  const { directory } = await fixture(t);
  const target = path.join(directory, "target");
  await fs.mkdir(target);
  const linkedDirectory = path.join(directory, "linked-usage");
  await fs.symlink(target, linkedDirectory);
  const linkedStore = createOrchestratorLearningUsage({ directory: linkedDirectory });
  assert.equal((await linkedStore.reserve(reservation())).reason, "usage-ledger-unreadable");
  assert.deepEqual(await fs.readdir(target), []);

  const sentinel = path.join(directory, "sentinel.json");
  await fs.writeFile(sentinel, "sentinel");
  const usageDirectory = path.join(directory, "safe-usage");
  await fs.mkdir(usageDirectory);
  await fs.symlink(sentinel, path.join(usageDirectory, "ledger.json"));
  const fileLinkedStore = createOrchestratorLearningUsage({ directory: usageDirectory });
  assert.equal((await fileLinkedStore.reserve(reservation())).reason, "usage-ledger-unreadable");
  assert.equal(await fs.readFile(sentinel, "utf8"), "sentinel");
  assert.equal((await fs.lstat(path.join(usageDirectory, "ledger.json"))).isSymbolicLink(), true);
});

test("a ledger replaced by a symlink between calls prevents writing and pauses new calls", async (t) => {
  const { store, directory } = await fixture(t);
  const { call } = await store.reserve(reservation());
  const sentinel = path.join(directory, "sentinel.json");
  await fs.writeFile(sentinel, "sentinel");
  await fs.rm(path.join(directory, "ledger.json"));
  await fs.symlink(sentinel, path.join(directory, "ledger.json"));
  await assert.rejects(store.settle(call.callId, measured()), /Unsafe learning usage file/);
  assert.equal((await store.reserve(reservation())).reason, "usage-storage-failed");
  assert.equal(await fs.readFile(sentinel, "utf8"), "sentinel");
});

test("missing or understated daily accounting cannot restore consumed budget after restart", async (t) => {
  for (const corrupt of [
    (raw) => { raw.days = {}; },
    (raw) => { raw.days["2026-10-20"].buckets = {}; },
    (raw) => { Object.values(raw.days["2026-10-20"].buckets)[0].totals.budgetTokens = 0; },
  ]) {
    const { store, config, directory } = await fixture(t, { limits: { dailyCalls: 1 } });
    const { call } = await store.reserve(reservation());
    await store.settle(call.callId, measured());
    const file = path.join(directory, "ledger.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    corrupt(raw);
    await fs.writeFile(file, JSON.stringify(raw));
    const restarted = createOrchestratorLearningUsage(config);
    assert.equal((await restarted.status()).blockedReason, "usage-ledger-unreadable");
    assert.equal((await restarted.reserve(reservation())).reason, "usage-ledger-unreadable");
  }
});

test("unsupported external or unknown token breakdowns remain partial and conservatively reserved", async (t) => {
  const { store, config } = await fixture(t);
  const cases = [
    { cachedInputTokens: 1000, cachedInputIncluded: false },
    { cachedInputTokens: 1000, cachedInputIncluded: null },
    { reasoningOutputTokens: 1000, reasoningOutputIncluded: false },
    { cacheWriteInputTokens: 1000, cacheWriteInputIncluded: null },
  ];
  for (let index = 0; index < cases.length; index++) {
    const { call } = await store.reserve(reservation({ attempt: index + 1 }));
    const result = await store.settle(call.callId, { status: "completed", reportedModel: "model-a",
      usage: { inputTokens: 100, outputTokens: 20, ...cases[index] } });
    assert.equal(result.call.usage.state, "partial");
    assert.equal(result.budget.tokens, 5000 * (index + 1));
  }
  const restarted = createOrchestratorLearningUsage(config);
  assert.equal((await restarted.status()).blockedReason, null);
  assert.equal((await restarted.status()).budget.tokens, 20_000);
});

test("restart after aggregate retention expires safely prunes formerly consistent accounting", async (t) => {
  const { store, config, advance } = await fixture(t);
  const { call } = await store.reserve(reservation());
  await store.settle(call.callId, measured());
  advance(401 * 24 * 60 * 60 * 1000);
  const restarted = createOrchestratorLearningUsage(config);
  assert.equal((await restarted.status()).blockedReason, null);
  assert.equal((await restarted.status()).budget.calls, 0);
  assert.deepEqual((await restarted.history()).days, {});
});
