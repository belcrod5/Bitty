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
  const f = await fixture(t, { limits: { batchThreshold: 1, interval: 0, pendingPairs: 2, inputBytes: 6000 } });
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

const skill = { purpose: "Review work", triggers: "When reviewing this project", inputs: "Current changes",
  steps: "Read instructions, inspect changes, run a focused check", outputs: "Brief findings", exceptions: "Skip unrelated changes",
  approvals: "Publishing and external actions require current approval" };
const candidate = (seq = 1, extra = {}) => ({ kind: "procedure", content: "Review workflow", conditions: "This chat's project only",
  orchestratorId: "main", evidence: [seq], reason: "Repeated explicit requests", skill, ...extra });
const ref = (item) => ({ id: item.id, version: item.version });
async function seed(f, values = [candidate()]) {
  f.args.analyze = async () => ({ text: JSON.stringify({ candidates: values }) });
  // reopen so the injected analysis function belongs to this service
  await f.service.close(); f.service = await f.open(); await configure(f.service);
  await f.service.observe([f.pair(1)]); await f.service.runDue();
  return (await f.service.status()).candidates;
}

test("bulk adoption is atomic, conditional and scoped; withdrawal changes digest including zero items", async (t) => {
  const f = await fixture(t);
  const [item] = await seed(f);
  assert.equal((await f.service.retrieve({ orchestratorId: "main", input: "review" })).items.length, 0);
  await assert.rejects(f.service.decide({ items: [ref(item), { id: randomUUID(), version: 1 }], action: "adopt" }), { code: "learning_conflict" });
  assert.equal((await f.service.status()).candidates[0].status, "candidate");
  await f.service.decide({ items: [ref(item)], action: "adopt" });
  const applied = await f.service.retrieve({ orchestratorId: "main", input: "Review workflow" });
  assert.equal(applied.items.length, 1); assert.match(applied.instruction, /current user request/);
  assert.equal((await f.service.retrieve({ orchestratorId: randomUUID(), input: "review" })).items.length, 0);
  await f.service.decide({ items: applied.items.map(ref), action: "retire" });
  const removed = await f.service.retrieve({ orchestratorId: "main", input: "review" });
  assert.equal(removed.items.length, 0); assert.notEqual(removed.selectedDigest, applied.selectedDigest);
  assert.deepEqual(applied.excludedPairSeqs, []);
  assert.deepEqual(removed.excludedPairSeqs, item.evidence.map(({ pairSeq }) => pairSeq));
});

test("skills require explicit publication, exact caller/version/hash; manual modifications block republish", async (t) => {
  const f = await fixture(t); let [item] = await seed(f);
  await f.service.decide({ items: [ref(item)], action: "adopt" }); item = (await f.service.status()).candidates[0];
  assert.equal(item.published, undefined);
  await f.service.decide({ items: [ref(item)], action: "publish" }); item = (await f.service.status()).candidates[0];
  const request = { orchestratorId: "main", id: item.id, ...item.published };
  assert.match((await f.service.readSkill(request)).markdown, /approvals/);
  await assert.rejects(f.service.readSkill({ ...request, orchestratorId: randomUUID() }), { code: "learning_skill_unavailable" });
  await assert.rejects(f.service.readSkill({ ...request, version: 1 }), { code: "learning_skill_unavailable" });
  await fs.writeFile(path.join(f.workspace, "orchestrator-learning", "skills", item.id, `${item.published.version}.md`), "Manual edit");
  await assert.rejects(f.service.readSkill(request), { code: "learning_skill_modified" });
  await assert.rejects(f.service.decide({ items: [ref(item)], action: "publish" }), { code: "learning_skill_modified" });
});

test("publication keeps current and previous artifact; explicit forgetting removes files and excludes replay", async (t) => {
  const f = await fixture(t); let [item] = await seed(f);
  await f.service.decide({ items: [ref(item)], action: "adopt" });
  for (let index = 0; index < 4; index++) {
    item = (await f.service.status()).candidates[0]; await f.service.decide({ items: [ref(item)], action: "publish" });
  }
  item = (await f.service.status()).candidates[0];
  const folder = path.join(f.workspace, "orchestrator-learning", "skills", item.id);
  assert.equal((await fs.readdir(folder)).length, 2);
  await f.service.forget({ items: [ref(item)] });
  await assert.rejects(fs.stat(folder), { code: "ENOENT" });
  assert.equal((await f.service.status()).candidates.length, 0);
  await f.service.observe([f.pair(1)]); assert.equal((await f.service.status()).pendingCount, 0);
});

test("forgetting cleanup failure remains retryable after restart without recreating forgotten learning", async (t) => {
  const f = await fixture(t); let [item] = await seed(f);
  await f.service.decide({ items: [ref(item)], action: "adopt" }); item = (await f.service.status()).candidates[0];
  await f.service.decide({ items: [ref(item)], action: "publish" }); item = (await f.service.status()).candidates[0];
  const folder = path.join(f.workspace, "orchestrator-learning", "skills", item.id);
  await fs.writeFile(path.join(folder, "user-note.txt"), "do not delete");
  await assert.rejects(f.service.forget({ items: [ref(item)] }), { code: "learning_skill_modified" });
  assert.equal((await f.service.status()).candidates.length, 0);
  await f.service.close(); const restarted = await f.open();
  assert.equal((await restarted.status()).status, "paused");
  await fs.unlink(path.join(folder, "user-note.txt"));
  await restarted.forget({ items: [ref(item)] });
  await assert.rejects(fs.stat(folder), { code: "ENOENT" });
});

test("AI evaluations stay immutable; score-only and reason corrections are batched without new pairs", async (t) => {
  const seen = [];
  const f = await fixture(t, { analyze: async ({ input }) => {
    const value = JSON.parse(input); seen.push(value);
    return { text: JSON.stringify({ candidates: [], evaluations: value.pairs.length ? [{ orchestratorId: "main", goal: "Short reports",
      score: null, reason: "No confirming feedback", unknowns: "Satisfaction unknown", evidence: [1] }] : [],
      corrections: value.feedback.map((entry) => ({ id: entry.id, reason: "Score alone does not establish a new preference", candidateIndex: null })) }) };
  } });
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue();
  const evaluation = (await f.service.status()).evaluations[0];
  const contextBefore = await f.service.retrieve({ orchestratorId: "main", input: "Reports" });
  await f.service.correctEvaluation({ evaluationId: evaluation.id, version: 1, score: 35, reason: "" });
  const contextAfter = await f.service.retrieve({ orchestratorId: "main", input: "Reports" });
  assert.equal(contextAfter.contextRevision, contextBefore.contextRevision);
  assert.equal(contextAfter.selectedDigest, contextBefore.selectedDigest);
  await f.service.runDue();
  const status = await f.service.status(); assert.equal(status.evaluations[0].score, null);
  assert.equal(status.evaluations[0].corrections[0].score, 35);
  assert.match(status.evaluations[0].corrections[0].resolution.reason, /Score alone/);
  assert.equal(seen.length, 2); assert.equal(seen[1].pairs.length, 0); assert.equal(seen[1].feedback.length, 1);
});

test("explicit edit, merge and retirement proposals use same budgeted analysis and survive successive edits", async (t) => {
  let iteration = 0;
  const f = await fixture(t, { analyze: async ({ input }) => {
    const value = JSON.parse(input); iteration++;
    const feedback = value.feedback || [];
    const replacements = feedback[0]?.items.map((item) => item.id);
    return { text: JSON.stringify({ candidates: [candidate(1, { content: `Workflow ${iteration}`, ...(replacements ? { replaces: replacements } : {}) })],
      corrections: feedback.map((entry) => ({ id: entry.id, reason: "Edited requested procedure", candidateIndex: 0 })) }) };
  } });
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue();
  let item = (await f.service.status()).candidates[0]; await f.service.decide({ items: [ref(item)], action: "adopt" });
  for (let index = 0; index < 2; index++) {
    item = (await f.service.status()).candidates.find((entry) => entry.status === "active");
    await f.service.requestChange({ items: [ref(item)], instruction: "Improve the procedure without changing scope" });
    await f.service.runDue();
    const draft = (await f.service.status()).candidates.findLast((entry) => entry.status === "candidate");
    assert.ok(draft, `Edit ${index + 1} must not be suppressed by predecessor exclusion`);
    await f.service.decide({ items: [ref(draft)], action: "adopt" });
  }
  assert.equal(f.calls.length, 3); assert.equal((await f.service.status()).candidates.filter((entry) => entry.status === "active").length, 1);
  const predecessor = (await f.service.status()).candidates.filter((entry) => entry.status === "retired").at(-1);
  await f.service.decide({ items: [ref(predecessor)], action: "restore" });
  assert.equal((await f.service.status()).candidates.filter((entry) => entry.status === "active").length, 1);
});

test("delivery, successful reads and inherited reads stay distinct and forgetting removes all references", async (t) => {
  const f = await fixture(t); let [item] = await seed(f);
  await f.service.decide({ items: [ref(item)], action: "adopt" }); item = (await f.service.status()).candidates[0];
  await f.service.decide({ items: [ref(item)], action: "publish" }); item = (await f.service.status()).candidates[0];
  const snapshot = await f.service.retrieve({ orchestratorId: "main", input: "review" });
  const operationId = randomUUID(); await f.service.delivered({ orchestratorId: "main", operationId, threadId: "parent", turnId: "one", snapshot });
  const read = await f.service.readSkill({ orchestratorId: "main", id: item.id, ...item.published });
  await f.service.recordRead({ operationId, callId: "read-one", skill: read });
  const nextOperation = randomUUID(); await f.service.delivered({ orchestratorId: "main", operationId: nextOperation, threadId: "parent", turnId: "two", snapshot });
  const second = await f.service.delivery({ orchestratorId: "main", operationId: nextOperation });
  assert.equal(second.items.length, 1); assert.equal(second.reads.length, 0); assert.equal(second.inheritedReads[0].callId, "read-one");
  await f.service.forget({ items: [ref(item)] });
  assert.equal(await f.service.delivery({ orchestratorId: "main", operationId }), null);
});

test("batch targets are bounded, rejection prevents repeated proposals and adoption grants no execution", async (t) => {
  const f = await fixture(t); let [item] = await seed(f, [candidate(1, { kind: "batch_proposal", skill: undefined })]);
  await f.service.decide({ items: [ref(item)], action: "adopt" }); item = (await f.service.status()).candidates[0];
  const args = { orchestratorId: "main", operationId: randomUUID(), itemId: item.id, version: item.version,
    targets: ["file-a", "file-b"], operation: "format selected files", exclusions: "all other files", order: "alphabetically",
    onFailure: "stop and report; do not retry uncertain results", sourceItemIds: ["tool-read-list"] };
  const proposal = await f.service.proposeBatch(args); assert.equal(proposal.executionAuthorized, false);
  await f.service.proposalDecision({ id: proposal.id, decision: "declined" });
  await assert.rejects(f.service.proposeBatch({ ...args, targets: ["file-b", "file-a"] }), { code: "learning_proposal_repeated" });
  assert.equal((await f.service.status()).proposals[0].status, "declined");
});

test("retrieval ranks relevant items beyond the first five and never guesses unverified target constraints", async (t) => {
  const f = await fixture(t);
  const items = Array.from({ length: 7 }, (_, index) => candidate(1, { kind: "preference", skill: undefined,
    content: `Policy ${index}`, matchTerms: [`request-${index}`], ...(index === 6 ? { targetConstraints: ["repo-confirmed"] } : {}) }));
  await seed(f, items);
  await f.service.decide({ items: (await f.service.status()).candidates.map(ref), action: "adopt" });
  assert.equal((await f.service.retrieve({ orchestratorId: "main", input: "unrelated" })).items.length, 0);
  assert.equal((await f.service.retrieve({ orchestratorId: "main", input: "request-6" })).items.length, 0);
  const matched = await f.service.retrieve({ orchestratorId: "main", input: "request-6", targets: ["repo-confirmed"] });
  assert.deepEqual(matched.items.map((entry) => entry.content), ["Policy 6"]);
  assert.deepEqual(matched.items[0].verifiedTargets, ["repo-confirmed"]);
});

test("forgetting an ancestor removes the entire successor chain, including active content and history", async (t) => {
  let index = 0;
  const f = await fixture(t, { analyze: async ({ input }) => { const value = JSON.parse(input); index++;
    return { text: JSON.stringify({ candidates: [candidate(1, { content: `Version ${index}`,
      ...(value.feedback[0] ? { replaces: value.feedback[0].items.map((item) => item.id) } : {}) })],
      corrections: value.feedback.map((entry) => ({ id: entry.id, reason: "Requested edit", candidateIndex: 0 })) }) }; } });
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue();
  let item = (await f.service.status()).candidates[0]; const ancestor = item.id;
  await f.service.decide({ items: [ref(item)], action: "adopt" });
  for (let step = 0; step < 2; step++) {
    item = (await f.service.status()).candidates.find((entry) => entry.status === "active");
    await f.service.requestChange({ items: [ref(item)], instruction: "Edit this workflow" }); await f.service.runDue();
    item = (await f.service.status()).candidates.find((entry) => entry.status === "candidate");
    await f.service.decide({ items: [ref(item)], action: "adopt" });
  }
  item = (await f.service.status()).candidates.find((entry) => entry.id === ancestor);
  await f.service.forget({ items: [ref(item)] });
  const status = await f.service.status(); assert.equal(status.candidates.length, 0); assert.equal(status.changes.length, 0);
  assert.equal((await f.service.retrieve({ orchestratorId: "main", input: "Version" })).items.length, 0);
});

test("shared edit candidates inherit the adopted scope instead of losing their shared publication boundary", async (t) => {
  let count = 0;
  const f = await fixture(t, { analyze: async ({ input }) => { const value = JSON.parse(input); count++;
    return { text: JSON.stringify({ candidates: [candidate(1, { content: `Shared ${count}`,
      ...(value.feedback.length ? { replaces: value.feedback[0].items.map((item) => item.id) } : {}) })],
      corrections: value.feedback.map((entry) => ({ id: entry.id, reason: "Shared edit requested", candidateIndex: 0 })) }) }; } });
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue();
  let item = (await f.service.status()).candidates[0]; await f.service.decide({ items: [ref(item)], action: "adopt" });
  item = (await f.service.status()).candidates[0]; await f.service.decide({ items: [ref(item)], action: "share" });
  item = (await f.service.status()).candidates[0]; await f.service.requestChange({ items: [ref(item)], instruction: "Improve shared steps" });
  await f.service.runDue(); const draft = (await f.service.status()).candidates.find((entry) => entry.status === "candidate");
  assert.equal(draft.scope.shared, true); await f.service.decide({ items: [ref(draft)], action: "adopt" });
  assert.equal((await f.service.status()).candidates.find((entry) => entry.status === "active").scope.shared, true);
});

test("natural user feedback is linked to the exact proposal and cannot use assistant quotes or silence", async (t) => {
  const f = await fixture(t); let [item] = await seed(f, [candidate(1, { kind: "batch_proposal", skill: undefined })]);
  await f.service.decide({ items: [ref(item)], action: "adopt" }); item = (await f.service.status()).candidates[0];
  const proposal = await f.service.proposeBatch({ orchestratorId: "main", operationId: randomUUID(), itemId: item.id, version: item.version,
    targets: ["a"], operation: "format", exclusions: "others", order: "listed", onFailure: "stop", sourceItemIds: ["list"] });
  await f.service.close();
  f.args.analyze = async ({ input }) => { const value = JSON.parse(input); assert.equal(value.proposals[0].id, proposal.id);
    return { text: JSON.stringify({ candidates: [], proposalFeedback: [{ proposalId: proposal.id, action: "declined", pairSeq: 2,
      userQuote: "その提案は不要です", reason: "Current user explicitly declined the bounded proposal" }] }) }; };
  const restarted = await f.open(); await restarted.observe([f.pair(2, { user: "その提案は不要です", assistant: "わかりました" })]); await restarted.runDue();
  const saved = (await restarted.status()).proposals[0]; assert.equal(saved.status, "declined"); assert.equal(saved.feedback[0].targetHash, proposal.targetHash);
  assert.equal(saved.outcome, undefined);
});

test("structured analysis schema and validation agree on string unknowns; invalid output updates the same call reason", async (t) => {
  let schema;
  const f = await fixture(t, { analyze: async (args) => { schema = args.outputSchema;
    return { text: JSON.stringify({ candidates: [], evaluations: [{ orchestratorId: "main", goal: "Reports", score: null,
      reason: "Unconfirmed", unknowns: [], evidence: [1] }] }) }; } });
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue();
  assert.equal(schema.properties.evaluations.items.properties.unknowns.type, "string");
  assert.equal(f.calls.length, 1); assert.equal(f.settlements.at(-1).status, "failed");
  assert.equal(f.settlements.at(-1).reasonCode, "learning_output_invalid"); assert.equal((await f.service.status()).processedThrough, 0);
});

test("modifying a retained previous artifact blocks publication before any automatic deletion", async (t) => {
  const f = await fixture(t); let [item] = await seed(f);
  await f.service.decide({ items: [ref(item)], action: "adopt" });
  for (let index = 0; index < 2; index++) { item = (await f.service.status()).candidates[0]; await f.service.decide({ items: [ref(item)], action: "publish" }); }
  item = (await f.service.status()).candidates[0];
  const previous = path.join(f.workspace, "orchestrator-learning", "skills", item.id, `${item.previousPublished.version}.md`);
  await fs.writeFile(previous, "user edited previous version");
  await assert.rejects(f.service.decide({ items: [ref(item)], action: "publish" }), { code: "learning_skill_modified" });
  assert.equal(await fs.readFile(previous, "utf8"), "user edited previous version");
  assert.equal((await f.service.status()).candidates[0].version, item.version);
});

test("candidate rejection, evaluation corrections and change requests invalidate analysis without replacing response context", async (t) => {
  const f = await fixture(t); const [item] = await seed(f);
  const before = await f.service.retrieve({ orchestratorId: "main", input: "Review" });
  await f.service.requestChange({ items: [ref(item)], instruction: "Clarify the procedure" });
  const afterRequest = await f.service.retrieve({ orchestratorId: "main", input: "Review" });
  assert.equal(afterRequest.contextRevision, before.contextRevision); assert.equal(afterRequest.selectedDigest, before.selectedDigest);
  await f.service.decide({ items: [ref(item)], action: "reject" });
  const afterReject = await f.service.retrieve({ orchestratorId: "main", input: "Review" });
  assert.equal(afterReject.contextRevision, before.contextRevision); assert.equal(afterReject.selectedDigest, before.selectedDigest);
});

test("reasoned evaluation correction can revise an active successor using its legitimately inherited evidence", async (t) => {
  let number = 0;
  const f = await fixture(t, { analyze: async ({ input }) => { const value = JSON.parse(input); number++;
    const feedback = value.feedback[0]; const active = value.items.find((item) => item.status === "active");
    const candidates = number === 3 ? [] : [candidate(1, { content: `Policy version ${number}`,
      ...(active ? { replaces: [active.id] } : {}) })];
    return { text: JSON.stringify({ candidates,
      evaluations: number === 3 ? [{ orchestratorId: "main", itemId: active.id, goal: "Review workflow", score: 50,
        reason: "Only partly fits", unknowns: "More user feedback needed", evidence: [2] }] : [],
      corrections: feedback ? [{ id: feedback.id, candidateIndex: 0, reason: "Adjusted using explicit correction reason" }] : [] }) }; } });
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue();
  let item = (await f.service.status()).candidates[0]; await f.service.decide({ items: [ref(item)], action: "adopt" });
  item = (await f.service.status()).candidates.find((item) => item.status === "active");
  await f.service.requestChange({ items: [ref(item)], instruction: "Improve steps" }); await f.service.runDue();
  item = (await f.service.status()).candidates.find((item) => item.status === "candidate"); await f.service.decide({ items: [ref(item)], action: "adopt" });
  await f.service.observe([f.pair(2)]); await f.service.runDue();
  const evaluation = (await f.service.status()).evaluations[0];
  await f.service.correctEvaluation({ evaluationId: evaluation.id, version: 1, score: 30, reason: "Keep exceptions explicit in each step" });
  await f.service.runDue();
  const status = await f.service.status(); assert.ok(status.candidates.find((item) => item.status === "candidate"));
  assert.ok(status.evaluations[0].corrections[0].resolution.itemId);
});

test("late completed context or skill read cannot resurrect content after explicit forgetting", async (t) => {
  const f = await fixture(t); let [item] = await seed(f);
  await f.service.decide({ items: [ref(item)], action: "adopt" }); item = (await f.service.status()).candidates[0];
  await f.service.decide({ items: [ref(item)], action: "publish" }); item = (await f.service.status()).candidates[0];
  const selection = await f.service.retrieve({ orchestratorId: "main", input: "Review workflow" });
  const operationId = randomUUID();
  await f.service.delivered({ orchestratorId: "main", operationId, threadId: "parent", turnId: "turn", snapshot: { ...selection, items: [] } });
  await f.service.forget({ items: [ref(item)] });
  await f.service.recordRead({ operationId, callId: "late-context", skill: { selection } });
  await f.service.recordRead({ operationId, callId: "late-skill", skill: { id: item.id, name: item.content, ...item.published } });
  const proof = await f.service.delivery({ orchestratorId: "main", operationId });
  assert.equal(proof.items.length, 0); assert.equal(proof.reads.length, 0);
  assert.ok(!JSON.stringify(await f.service.status()).includes(item.content));
});

test("explicit retry grants exactly one persisted attempt using current settings and rejects duplicate stale requests", async (t) => {
  const seen = [];
  const f = await fixture(t, { analyze: async ({ model }) => { seen.push(model); throw new Error("synthetic failure"); } });
  await configure(f.service); await f.service.observe([f.pair(1)]);
  for (let index = 0; index < 3; index++) { f.advance(70_000); await f.service.runDue(); }
  const exhausted = await f.service.status(); assert.equal(exhausted.status, "retry_exhausted");
  await configure(f.service, "model-b", "high", 2);
  const status = await f.service.status(); assert.equal(status.status, "retry_exhausted");
  const request = { batchId: status.retry.batchId, settingsRevision: status.settings.settingsRevision };
  await f.service.retry(request); await assert.rejects(f.service.retry(request), { code: "learning_conflict" });
  await f.service.close(); const restarted = await f.open();
  f.advance(70_000); await restarted.runDue();
  const after = await restarted.status(); assert.equal(after.status, "retry_exhausted");
  assert.equal(after.retry.attempts, 4); assert.equal(after.retry.ceiling, 4); assert.equal(f.calls.at(-1).attempt, 4);
  assert.equal(seen.at(-1), "model-b"); assert.equal(after.pendingCount, 1);
  f.advance(70_000); await restarted.runDue(); assert.equal(f.calls.length, 4);
});

test("invalid persisted retry ceilings and negative attempts cannot disable the retry limit", async (t) => {
  const f = await fixture(t, { analyze: async () => { throw new Error("failed"); } });
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue(); await f.service.close();
  const file = path.join(f.workspace, "orchestrator-learning", "state.json");
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  state.batch.retryCeiling = "bad"; await fs.writeFile(file, JSON.stringify(state));
  await assert.rejects(f.open(), { code: "learning_store_invalid" });
  state.batch.retryCeiling = 4; state.batch.attempts = -1; await fs.writeFile(file, JSON.stringify(state));
  await assert.rejects(f.open(), { code: "learning_store_invalid" });
});

test("optional proposal context is trimmed before excluding a source pair that fits on its own", async (t) => {
  const seen = [];
  const f = await fixture(t, { analyze: async ({ input }) => { const value = JSON.parse(input); seen.push(value);
    return { text: JSON.stringify({ candidates: value.pairs[0].pairSeq === 1 ? [candidate(1, { kind: "batch_proposal", skill: undefined })] : [] }) }; } });
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue();
  let item = (await f.service.status()).candidates[0]; await f.service.decide({ items: [ref(item)], action: "adopt" }); item = (await f.service.status()).candidates[0];
  for (let index = 0; index < 3; index++) await f.service.proposeBatch({ orchestratorId: "main", operationId: randomUUID(), itemId: item.id, version: item.version,
    targets: [`target-${index}-${"x".repeat(190)}`], operation: "a".repeat(990) + index,
    exclusions: "b".repeat(1000), order: "c".repeat(1000), onFailure: "d".repeat(1000), sourceItemIds: ["list"] });
  await f.service.observe([f.pair(2, { user: "e".repeat(9000) })]); await f.service.runDue();
  const status = await f.service.status(); assert.equal(status.processedThrough, 2);
  assert.equal(status.gaps.length, 0); assert.equal(seen.length, 2);
  assert.ok(seen[1].proposals.length < 3, "drop optional references instead of the valid user source");
});

test("evaluation period follows its cited pairs instead of unrelated pairs in the same batch", async (t) => {
  const f = await fixture(t, { limits: { batchThreshold: 2, interval: 0 }, analyze: async () => ({ text: JSON.stringify({ candidates: [], evaluations: [
    { orchestratorId: "main", goal: "First request", score: null, reason: "No feedback", unknowns: "Unconfirmed", evidence: [1] },
  ] }) }) });
  const first = f.pair(1); f.advance(60_000); const second = f.pair(2);
  await configure(f.service); await f.service.observe([first, second]); await f.service.runDue();
  const evaluation = (await f.service.status()).evaluations[0];
  assert.deepEqual(evaluation.period, { from: first.completedAt, until: first.completedAt });
});

async function evaluationFixture(t, options = {}) {
  const f = await fixture(t, { analyze: async ({ input }) => {
    const value = JSON.parse(input);
    return { text: JSON.stringify({ candidates: [], evaluations: value.pairs.length ? [{ orchestratorId: "main", goal: "Short reports",
      score: 100, reason: "Explicit feedback", unknowns: "", evidence: [1] }] : [],
      corrections: value.feedback.map((entry) => ({ id: entry.id, reason: "Acknowledged", candidateIndex: null })) }) };
  }, ...options });
  await configure(f.service); await f.service.observe([f.pair(1)]); await f.service.runDue();
  await configure(f.service, "", "", 2);
  const evaluation = (await f.service.status()).evaluations[0];
  return { ...f, evaluation, reference: { evaluationId: evaluation.id, version: evaluation.version }, file: path.join(f.workspace, "orchestrator-learning/state.json") };
}

test("evaluation corrections reject empty values; trimmed identical latest feedback and AI no-op do not create work", async (t) => {
  const f = await evaluationFixture(t);
  const before = await fs.readFile(f.file, "utf8");
  for (const input of [{ score: null, reason: "" }, { score: null, reason: "  \n " }, { score: 101 }, { score: -1 }, { score: 1.5 }])
    await assert.rejects(f.service.correctEvaluation({ ...f.reference, ...input }), { code: "learning_request_invalid" });
  await f.service.correctEvaluation({ ...f.reference, score: 100 });
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  await f.service.correctEvaluation({ ...f.reference, score: 0, reason: "  Too long  " });
  let status = await f.service.status();
  assert.equal(status.evaluations[0].corrections[0].score, 0); assert.equal(status.evaluations[0].corrections[0].reason, "Too long");
  const saved = await fs.readFile(f.file, "utf8");
  await f.service.correctEvaluation({ ...f.reference, score: 0, reason: "Too long " });
  assert.equal(await fs.readFile(f.file, "utf8"), saved); assert.equal(f.calls.length, 1);
  await f.service.correctEvaluation({ ...f.reference, score: null, reason: "  Keep exceptions  " });
  status = await f.service.status(); assert.equal(status.evaluations[0].score, 100);
  assert.equal(status.evaluations[0].corrections.length, 2); assert.equal(status.evaluations[0].corrections[1].reason, "Keep exceptions");
});

test("pending cancellation validates the whole selection, keeps audit and context, and survives restart", async (t) => {
  const f = await evaluationFixture(t);
  await f.service.correctEvaluation({ ...f.reference, score: 30 });
  await f.service.correctEvaluation({ ...f.reference, score: 40 });
  const status = await f.service.status(); const ids = status.evaluations[0].corrections.map((entry) => entry.id);
  const before = JSON.parse(await fs.readFile(f.file, "utf8"));
  for (const payload of [{ correctionIds: [ids[0], randomUUID()] }, { correctionIds: [ids[0], ids[0]] },
    { correctionIds: ids, version: 9 }, { correctionIds: ids, evaluationId: randomUUID() }]) {
    await assert.rejects(f.service.cancelEvaluationCorrections({ ...f.reference, ...payload }));
    assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")), before);
  }
  await f.service.cancelEvaluationCorrections({ ...f.reference, correctionIds: [ids[1]] });
  let after = JSON.parse(await fs.readFile(f.file, "utf8"));
  assert.equal(after.contextRevision, before.contextRevision); assert.equal(after.corrections[0].cancelledAt, undefined);
  assert.ok(after.corrections[1].cancelledAt); assert.equal(after.evaluations[0].score, 100);
  const once = await fs.readFile(f.file, "utf8");
  await f.service.cancelEvaluationCorrections({ ...f.reference, correctionIds: [ids[1]] });
  assert.equal(await fs.readFile(f.file, "utf8"), once);
  await f.service.close(); const restarted = await f.open();
  assert.ok((await restarted.status()).evaluations[0].corrections[1].cancelledAt);
  await restarted.cancelEvaluationCorrections({ ...f.reference, correctionIds: ids });
  await configure(restarted, "model-a", "low", 3); await restarted.runDue();
  assert.equal(f.calls.length, 1); assert.equal((await restarted.status()).evaluations[0].corrections.length, 2);
});

test("applied feedback cannot be cancelled and mixed selection is atomic", async (t) => {
  const f = await evaluationFixture(t);
  await f.service.correctEvaluation({ ...f.reference, score: 40 });
  await configure(f.service, "model-a", "low", 3); await f.service.runDue();
  await configure(f.service, "", "", 4); await f.service.correctEvaluation({ ...f.reference, score: 50 });
  const corrections = (await f.service.status()).evaluations[0].corrections;
  assert.ok(corrections[0].resolution); const before = await fs.readFile(f.file, "utf8");
  await assert.rejects(f.service.cancelEvaluationCorrections({ ...f.reference, correctionIds: corrections.map((entry) => entry.id) }), { code: "learning_conflict" });
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  await f.service.correctEvaluation({ ...f.reference, score: 50 });
  assert.equal((await f.service.status()).evaluations[0].corrections.length, 2);
});

test("cancelling in-flight feedback discards its result but preserves pending pairs and measured usage", async (t) => {
  let number = 0, started, release, aborted;
  const began = new Promise((resolve) => { started = resolve; });
  const f = await evaluationFixture(t, { analyze: async ({ input, signal, onLearningUsage }) => {
    const value = JSON.parse(input); number += 1;
    onLearningUsage({ inputTokens: 100, outputTokens: 20 });
    if (number === 2) { signal.addEventListener("abort", () => { aborted = true; }); started(); await new Promise((resolve) => { release = resolve; }); }
    return { text: JSON.stringify({ candidates: [], evaluations: number === 1 ? [{ orchestratorId: "main", goal: "Short reports", score: 100,
      reason: "Explicit", unknowns: "", evidence: [1] }] : [],
      corrections: value.feedback.map((entry) => ({ id: entry.id, reason: "Late result", candidateIndex: null })) }),
      usage: { inputTokens: 100, outputTokens: 20 } };
  } });
  await f.service.correctEvaluation({ ...f.reference, score: 30 });
  const id = (await f.service.status()).evaluations[0].corrections[0].id;
  await f.service.observe([f.pair(2)]); await configure(f.service, "model-a", "low", 3);
  const running = f.service.runDue(); await began;
  const before = JSON.parse(await fs.readFile(f.file, "utf8"));
  await f.service.cancelEvaluationCorrections({ ...f.reference, correctionIds: [id] });
  await configure(f.service, "", "", 4); release(); await running;
  const status = await f.service.status();
  assert.equal(aborted, true); assert.equal(status.pendingCount, 1); assert.equal(status.processedThrough, 1);
  assert.ok(status.evaluations[0].corrections[0].cancelledAt); assert.equal(status.evaluations[0].corrections[0].resolution, undefined);
  assert.equal(JSON.parse(await fs.readFile(f.file, "utf8")).contextRevision, before.contextRevision);
  assert.equal(f.calls.length, 2); assert.ok(f.settlements.some((entry) => entry.reasonCode === "learning_result_stale" && entry.inputTokens === 100 && entry.outputTokens === 20));
});

test("legacy empty pending feedback is not analyzed and stale restored batches are invalidated", async (t) => {
  const seen = [];
  const f = await evaluationFixture(t);
  await f.service.close();
  const saved = JSON.parse(await fs.readFile(f.file, "utf8"));
  const legacy = { id: randomUUID(), ...f.reference, evaluationVersion: 1, score: null, reason: "  ", at: new Date().toISOString(), scope: { orchestratorId: "main" } };
  saved.corrections.push(legacy);
  saved.batch = { id: randomUUID(), epoch: saved.epoch, pairs: [], sources: [], items: [], feedback: [legacy], evaluations: saved.evaluations,
    attempts: 1, settings: saved.settings, sourceHash: "old", retryAt: 0 };
  await fs.writeFile(f.file, JSON.stringify(saved));
  f.args.analyze = async ({ input }) => { seen.push(JSON.parse(input)); return { text: '{"candidates":[]}' }; };
  const restarted = await f.open();
  assert.equal(JSON.parse(await fs.readFile(f.file, "utf8")).batch, null);
  await configure(restarted, "model-a", "low", 3); await restarted.runDue();
  assert.equal(seen.length, 0); assert.equal(f.calls.length, 1);
  await restarted.cancelEvaluationCorrections({ ...f.reference, correctionIds: [legacy.id] });
  assert.ok((await restarted.status()).evaluations[0].corrections[0].cancelledAt);
});

test("unrelated pair analysis continues when cancelling a legacy empty correction", async (t) => {
  let number = 0, started, release, signal;
  const began = new Promise((resolve) => { started = resolve; });
  const f = await evaluationFixture(t, { analyze: async ({ input, signal: runningSignal }) => {
    const value = JSON.parse(input); number += 1;
    if (number === 2) { signal = runningSignal; started(); await new Promise((resolve) => { release = resolve; }); }
    return { text: JSON.stringify({ candidates: [], evaluations: number === 1 ? [{ orchestratorId: "main", goal: "Short reports", score: 100,
      reason: "Explicit", unknowns: "", evidence: [1] }] : [], corrections: value.feedback.map((entry) => ({ id: entry.id, reason: "Ack", candidateIndex: null })) }) };
  } });
  await f.service.close(); const saved = JSON.parse(await fs.readFile(f.file, "utf8"));
  const id = randomUUID(); saved.corrections.push({ id, evaluationId: f.evaluation.id, evaluationVersion: 1,
    score: null, reason: "", at: new Date().toISOString(), scope: { orchestratorId: "main" } });
  await fs.writeFile(f.file, JSON.stringify(saved)); const restarted = await f.open();
  await restarted.observe([f.pair(2)]); await configure(restarted, "model-a", "low", 3);
  const running = restarted.runDue(); await began;
  await restarted.cancelEvaluationCorrections({ ...f.reference, correctionIds: [id] });
  assert.equal(signal.aborted, false); release(); await running;
  const status = await restarted.status(); assert.equal(status.processedThrough, 2);
  assert.ok(status.evaluations[0].corrections[0].cancelledAt); assert.equal(f.calls.length, 2);
});

test("cancelled and legacy empty corrections expire normally without pinning old evaluations", async (t) => {
  const f = await evaluationFixture(t);
  await f.service.correctEvaluation({ ...f.reference, score: 40 });
  const id = (await f.service.status()).evaluations[0].corrections[0].id;
  await f.service.cancelEvaluationCorrections({ ...f.reference, correctionIds: [id] });
  f.advance(91 * 86400_000);
  await f.service.observe([f.pair(2)]);
  const status = await f.service.status(); assert.equal(status.evaluations.length, 0);
  assert.equal(JSON.parse(await fs.readFile(f.file, "utf8")).corrections.length, 0);
});

test("cancelling a correction belonging to a different evaluation never partially cancels the local selection", async (t) => {
  const f = await evaluationFixture(t);
  await f.service.correctEvaluation({ ...f.reference, score: 30 }); await f.service.close();
  const saved = JSON.parse(await fs.readFile(f.file, "utf8"));
  const otherId = randomUUID(), foreignCorrection = randomUUID();
  saved.evaluations.push({ ...saved.evaluations[0], id: otherId, goal: "Another goal" });
  saved.corrections.push({ ...saved.corrections[0], id: foreignCorrection, evaluationId: otherId });
  await fs.writeFile(f.file, JSON.stringify(saved)); const restarted = await f.open();
  const before = await fs.readFile(f.file, "utf8");
  await assert.rejects(restarted.cancelEvaluationCorrections({ ...f.reference, correctionIds: [saved.corrections[0].id, foreignCorrection] }), { code: "learning_conflict" });
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});

test("resolved empty legacy feedback with no linked learning can be cancelled without rewriting its audit", async (t) => {
  const f = await evaluationFixture(t); await f.service.close();
  const saved = JSON.parse(await fs.readFile(f.file, "utf8"));
  const legacy = [null, null, null].map((itemId) => ({ id: randomUUID(), evaluationId: f.evaluation.id, evaluationVersion: 1,
    score: null, reason: "", at: new Date().toISOString(), scope: { orchestratorId: "main" }, resolution: { reason: "No meaningful input", itemId } }));
  const meaningful = { ...legacy[0], id: randomUUID(), score: 30 };
  const linked = { ...legacy[0], id: randomUUID(), resolution: { reason: "Created learning", itemId: randomUUID() } };
  const unknown = { ...legacy[0], id: randomUUID(), resolution: { reason: "Missing outcome link" } };
  saved.corrections.push(...legacy, meaningful, linked, unknown);
  await fs.writeFile(f.file, JSON.stringify(saved)); const restarted = await f.open();
  for (const protectedEntry of [meaningful, linked, unknown]) {
    const before = await fs.readFile(f.file, "utf8");
    await assert.rejects(restarted.cancelEvaluationCorrections({ ...f.reference, correctionIds: [legacy[0].id, protectedEntry.id] }), { code: "learning_conflict" });
    assert.equal(await fs.readFile(f.file, "utf8"), before);
  }
  await restarted.cancelEvaluationCorrections({ ...f.reference, correctionIds: [legacy[0].id] });
  await restarted.cancelEvaluationCorrections({ ...f.reference, correctionIds: legacy.map((entry) => entry.id) });
  let status = await restarted.status();
  for (let i = 0; i < 3; i++) {
    assert.ok(status.evaluations[0].corrections[i].cancelledAt);
    assert.equal(status.evaluations[0].corrections[i].resolution.reason, "No meaningful input");
  }
  assert.equal(JSON.parse(await fs.readFile(f.file, "utf8")).contextRevision, saved.contextRevision);
  assert.equal(status.evaluations[0].corrections[3].cancelledAt, undefined);
  assert.equal(status.evaluations[0].corrections[4].cancelledAt, undefined);
  await restarted.close(); const recovered = await f.open(); status = await recovered.status();
  assert.ok(status.evaluations[0].corrections.slice(0, 3).every((entry) => entry.cancelledAt));
  assert.equal(status.evaluations[0].score, 100); assert.equal(f.calls.length, 1);
});

for (const action of ["retire", "forget"]) {
  test(`${action} excludes evidence and inherited policy outputs, including completion after the decision`, async (t) => {
    const f = await fixture(t); let [item] = await seed(f);
    await f.service.configure({ model: "", effort: "", settingsRevision: 2 }, MODELS);
    await f.service.decide({ items: [ref(item)], action: "adopt" }); item = (await f.service.status()).candidates[0];
    const snapshot = await f.service.retrieve({ orchestratorId: "main", input: "review" });
    const first = randomUUID(), inherited = randomUUID();
    await f.service.delivered({ orchestratorId: "main", operationId: first, threadId: "parent", turnId: "one", snapshot });
    await f.service.recordRead({ operationId: first, callId: "read", skill: { id: item.id, version: item.version, hash: "proof", name: item.content } });
    await f.service.delivered({ orchestratorId: "main", operationId: inherited, threadId: "parent", turnId: "two", snapshot: { ...snapshot, items: [] } });
    assert.equal((await f.service.delivery({ orchestratorId: "main", operationId: inherited })).items.length, 0);
    if (action === "forget") await f.service.forget({ items: [ref(item)] });
    else await f.service.decide({ items: [ref(item)], action });
    await f.service.observe([f.pair(2, { clientOperationId: first }), f.pair(3, { clientOperationId: inherited }), f.pair(4)]);
    const restarted = await f.open();
    const current = await restarted.retrieve({ orchestratorId: "main", input: "review" });
    assert.deepEqual(current.excludedPairSeqs.sort(), [1, 2, 3]);
    assert.equal(current.items.length, 0);
    if (action === "forget") assert.equal((await restarted.status()).pendingCount, 1, "late forgotten outputs cannot re-enter analysis");
  });
}

test("a retrieval delivered after forgetting cannot reintroduce content or replay its later completion", async (t) => {
  const f = await fixture(t); let [item] = await seed(f);
  await f.service.configure({ model: "", effort: "", settingsRevision: 2 }, MODELS);
  await f.service.decide({ items: [ref(item)], action: "adopt" }); item = (await f.service.status()).candidates[0];
  const snapshot = await f.service.retrieve({ orchestratorId: "main", input: "review" });
  await f.service.forget({ items: [ref(item)] });
  const operationId = randomUUID();
  await f.service.delivered({ orchestratorId: "main", operationId, threadId: "parent", turnId: "late", snapshot });
  assert.deepEqual((await f.service.delivery({ orchestratorId: "main", operationId })).items, []);
  await f.service.observe([f.pair(2, { clientOperationId: operationId })]);
  assert.deepEqual((await f.service.retrieve({ orchestratorId: "main", input: "review" })).excludedPairSeqs, [1, 2]);
  assert.equal((await f.service.status()).pendingCount, 0);
});
