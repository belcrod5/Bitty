import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openOrchestratorLearning } from "../src/orchestrator-learning-service.mjs";

const MODELS = [{ modelId: "model-a", effortOptions: ["low"] }, { modelId: "model-b", effortOptions: ["high"] }];
async function fixture(t, options = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "learning-test-"));
  const memoryConversationId = randomUUID();
  let time = Date.parse("2026-10-20T12:00:00Z");
  const calls = [], settlements = [];
  const ledger = { reserve: async (input) => { calls.push(input); return { ok: true, call: { callId: randomUUID() } }; },
    settle: async (id, input) => { settlements.push(input); return { ok: true }; }, status: async () => ({ budget: {} }) };
  const args = { workspace, memoryConversationId, initialThrough: options.initialThrough || 0,
    analyze: async () => ({ text: '{"candidates":[]}' }), ledger, now: () => time,
    limits: { batchThreshold: 1, interval: 0, ...options.limits }, ...options };
  const services = [];
  const open = async () => { const service = await openOrchestratorLearning(args); services.push(service); return service; };
  const service = await open();
  t.after(async () => { for (const value of services) await value.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const pair = (pairSeq, extra = {}) => ({ memoryConversationId, pairSeq, orchestratorId: "main",
    logicalConversationId: randomUUID(), clientOperationId: randomUUID(), completedAt: new Date(time).toISOString(),
    user: "Keep reports short.", assistant: "Understood.", ...extra });
  return { service, open, args, ledger, calls, settlements, pair, workspace, advance: (ms) => { time += ms; } };
}
const configure = (service, model = "model-a", effort = "low", settingsRevision = 1) => service.configure({ model, effort, settingsRevision }, MODELS);

test("initial high water excludes historical pairs; restart observes missing completion once", async (t) => {
  const f = await fixture(t, { initialThrough: 10 });
  await f.service.observe([f.pair(8), f.pair(10)]);
  assert.equal((await f.service.status()).pendingCount, 0);
  await f.service.close();
  const recovered = await f.open();
  const eleven = f.pair(11);
  await recovered.observe([eleven]); await recovered.observe([eleven]);
  assert.equal((await recovered.status()).pendingCount, 1);
  assert.deepEqual((await recovered.status()).gaps, [{ from: 1, through: 10, reason: "before_observation" }]);
});

test("no model means no paid call, and sources unavailable during recovery are explicit", async (t) => {
  const f = await fixture(t);
  await f.service.observe([f.pair(3)], 5); await f.service.runDue();
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.service.status()).gaps, [
    { from: 1, through: 2, reason: "source_unavailable" }, { from: 4, through: 5, reason: "source_unavailable" }]);
});

test("candidate evidence and source chat are validated, duplicates do not multiply candidates", async (t) => {
  const f = await fixture(t, { analyze: async ({ input }) => { const seq = JSON.parse(input).pairs[0].pairSeq;
    return { text: JSON.stringify({ candidates: [{ kind: "preference", content: "Short reports", conditions: "Reports only",
      orchestratorId: "main", evidence: [seq], reason: "Explicit user preference" }] }) }; } });
  await configure(f.service);
  await f.service.observe([f.pair(1)]); await f.service.runDue();
  await f.service.observe([f.pair(2)]); await f.service.runDue();
  const status = await f.service.status();
  assert.equal(status.candidates.length, 1); assert.equal(status.candidates[0].status, "candidate");
  assert.equal(status.processedThrough, 2); assert.equal(status.pendingCount, 0);
  assert.equal(status.candidates[0].evidence[0].pairSeq, 1);
});

test("malformed or cross-chat candidates never commit, retries survive restart", async (t) => {
  const f = await fixture(t, { analyze: async () => ({ text: JSON.stringify({ candidates: [{ kind: "preference",
    content: "Wrong", conditions: "Always", orchestratorId: randomUUID(), evidence: [1], reason: "wrong scope" }] }) }) });
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue();
  assert.equal((await f.service.status()).processedThrough, 0);
  await f.service.close();
  const restarted = await f.open();
  f.advance(70_000); await restarted.runDue(); f.advance(70_000); await restarted.runDue();
  const status = await restarted.status();
  assert.equal(status.status, "retry_exhausted"); assert.equal(status.pendingCount, 1);
  assert.equal(f.calls.length, 3); assert.equal(status.candidates.length, 0);
});

test("settings snapshot stays with in-flight batch and subsequent batch sees new configuration", async (t) => {
  let release, started;
  const began = new Promise((resolve) => { started = resolve; });
  const seen = [];
  const f = await fixture(t, { analyze: async (args) => { seen.push(args.model); if (seen.length === 1) {
    started(); await new Promise((resolve) => { release = resolve; }); } return { text: '{"candidates":[]}' }; } });
  await configure(f.service); await f.service.observe([f.pair(1)]);
  const running = f.service.runDue(); await began;
  await configure(f.service, "model-b", "high", 2); await f.service.observe([f.pair(2)]);
  release(); await running; await f.service.runDue();
  assert.deepEqual(seen, ["model-a", "model-b"]);
  await assert.rejects(configure(f.service), { code: "learning_settings_conflict" });
});

test("removed chat invalidates an in-flight result without affecting new observations", async (t) => {
  let release, started;
  const began = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, { analyze: async () => { started(); await new Promise((resolve) => { release = resolve; });
    return { text: '{"candidates":[]}' }; } });
  const id = randomUUID();
  await configure(f.service); await f.service.observe([f.pair(1, { orchestratorId: id })]);
  const running = f.service.runDue(); await began; await f.service.removeOrchestrator(id); release(); await running;
  const status = await f.service.status(); assert.equal(status.pendingCount, 0); assert.equal(status.processedThrough, 0);
  assert.equal(status.gaps[0].reason, "orchestrator_removed");
});

test("retention bounds pending input, and a huge pair is excluded without charging", async (t) => {
  const f = await fixture(t, { limits: { batchThreshold: 1, interval: 0, pendingPairs: 2, inputBytes: 2000 } });
  await f.service.observe([f.pair(1), f.pair(2), f.pair(3, { user: "x".repeat(5000) })]);
  assert.equal((await f.service.status()).pendingCount, 2);
  await configure(f.service); await f.service.runDue(); await f.service.runDue();
  const status = await f.service.status(); assert.equal(status.pendingCount, 0);
  assert.equal(status.gaps.at(-1).reason, "input_too_large"); assert.equal(f.calls.length, 1);
});

test("usage settlement rejection prevents candidate commit; response usage survives model failure", async (t) => {
  const f = await fixture(t, { analyze: async ({ onLearningUsage }) => { onLearningUsage({ usage: { inputTokens: 8, outputTokens: 2 } }); throw new Error("failed"); } });
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue();
  assert.equal(f.settlements[0].status, "failed"); assert.equal(f.settlements[0].usage.inputTokens, 8);
  f.args.analyze = async () => ({ text: '{"candidates":[]}' });
  f.ledger.settle = async () => ({ ok: false, reason: "storage-failed" });
  f.advance(70_000); await f.service.runDue();
  assert.equal((await f.service.status()).status, "paused"); assert.equal((await f.service.status()).processedThrough, 0);
});

test("daily budget pause resumes the next UTC day without resetting source attempts", async (t) => {
  const f = await fixture(t);
  let denied = true;
  f.ledger.reserve = async () => denied ? { ok: false, reason: "daily-budget-exceeded" }
    : { ok: true, call: { callId: randomUUID() } };
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue();
  assert.equal((await f.service.status()).status, "paused");
  await f.service.observe([f.pair(2)]);
  assert.equal((await f.service.status()).pendingCount, 2);
  assert.equal((await f.service.status()).observedThrough, 2);
  denied = false; f.advance(86400_000); await f.service.runDue();
  assert.equal((await f.service.status()).processedThrough, 2);
});

test("storage corruption and symlinks are not silently overwritten", async (t) => {
  const f = await fixture(t); await f.service.close();
  const file = path.join(f.workspace, "orchestrator-learning", "state.json");
  await fs.writeFile(file, "{}");
  await assert.rejects(f.open(), { code: "learning_store_invalid" });
  await fs.rm(file); await fs.symlink(path.join(f.workspace, "target.json"), file);
  await assert.rejects(f.open());
});

test("clearing model stops paid retries and resuming uses new settings without resetting attempts", async (t) => {
  const seen = [];
  const f = await fixture(t, { analyze: async ({ model }) => { seen.push(model); throw new Error("test failure"); } });
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue();
  await f.service.configure({ model: "", effort: "", settingsRevision: 2 }, MODELS);
  f.advance(70_000); await f.service.runDue(); assert.equal(seen.length, 1);
  await configure(f.service, "model-b", "high", 3); await f.service.runDue();
  assert.deepEqual(seen, ["model-a", "model-b"]); assert.equal(f.calls.at(-1).attempt, 2);
});

test("busy response defers analysis and only one analysis runs while new sources arrive", async (t) => {
  let busy = true, release, started;
  const began = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, { isBusy: () => busy, analyze: async () => {
    started(); await new Promise((resolve) => { release = resolve; }); return { text: '{"candidates":[]}' }; } });
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue(); assert.equal(f.calls.length, 0);
  busy = false; const running = f.service.runDue(); await began;
  await f.service.observe([f.pair(2)]); await f.service.runDue(); assert.equal(f.calls.length, 1);
  release(); await running; assert.equal((await f.service.status()).pendingCount, 1);
});
