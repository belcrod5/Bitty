import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareOrchestratorIsolation } from "../scripts/prepare-orchestrator-isolation.mjs";
import { createVoiceContextService } from "../src/voice-context-service.mjs";
import { createVoiceOrchestratorService } from "../src/voice-orchestrator-service.mjs";
import { openOrchestratorLearning } from "../src/orchestrator-learning-service.mjs";
import { createOrchestratorLearningUsage } from "../src/orchestrator-learning-usage.mjs";
import { openVoiceMemoryStore } from "../src/voice-memory-store.mjs";

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrator-preparation-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const rootDir = path.join(temp, "voice_context", "v1");
  const main = createVoiceContextService({ rootDir, createClient: () => { throw new Error("No model calls in preparation tests"); } });
  const opened = await main.open();
  const workspace = await main.getWorkspaceDirectory();
  const memory = await main.getMemoryStore();
  const owner = randomUUID();
  const childLogicalId = randomUUID();
  const childDir = path.join(rootDir, "orchestrators", owner);
  await fs.mkdir(path.join(childDir, childLogicalId), { recursive: true });
  const active = JSON.parse(await fs.readFile(path.join(rootDir, "active.json"), "utf8"));
  await fs.writeFile(path.join(childDir, "active.json"), JSON.stringify({ ...active, logicalConversationId: childLogicalId,
    nativeThreadId: "old-shared-parent", systemInstruction: "Child expertise", checklistReadPending: false,
    checklistCompletion: { decision: "declined", sourceHash: "a".repeat(64), version: "b".repeat(64) } }));
  await fs.writeFile(path.join(childDir, "task-checklist-overview.json"), "old shared task summary");
  const registry = { orchestrators: [{ id: "main", name: "メイン", icon: "" }, { id: owner, name: "Expert", icon: "" }],
    selectedId: owner, memoryConversationId: memory.conversationId };
  await fs.writeFile(path.join(rootDir, "orchestrators.json"), JSON.stringify(registry));
  const records = new Map();
  async function pair(seq, id = owner) {
    const logical = id === "main" ? opened.logicalConversationId : childLogicalId;
    const directory = id === "main" ? rootDir : childDir;
    const value = { pairSeq: seq, user: `Question ${seq}`, assistant: `Answer ${seq}` };
    const operation = randomUUID();
    const rows = records.get(id) || [];
    for (const event of [{ type: "accepted", text: value.user }, { type: "dispatching" },
      { type: "native_started", threadId: "old-parent", turnId: randomUUID() }, { type: "completed", pairSeq: seq, text: value.assistant }])
      rows.push({ seq: rows.length + 1, at: new Date().toISOString(), clientOperationId: operation, ...event,
        ...(event.type === "completed" && id === owner ? { checklistCompletion: {
          decision: "declined", sourceHash: "a".repeat(64), version: "b".repeat(64) } } : {}) });
    records.set(id, rows);
    await fs.writeFile(path.join(directory, logical, "events.jsonl"), `${rows.map((event) => JSON.stringify(event)).join("\n")}\n`);
    await memory.appendPair(value);
    return { ...value, memoryConversationId: memory.conversationId, orchestratorId: id, logicalConversationId: logical,
      clientOperationId: operation, completedAt: new Date().toISOString() };
  }
  await fs.writeFile(path.join(childDir, childLogicalId, "events.jsonl"), "");
  const prepare = (apply = false) => prepareOrchestratorIsolation({ rootDir, runnerPort: port, codexPort: port, apply });
  return { temp, rootDir, workspace, memory, owner, opened, childDir, childLogicalId, pair, port, prepare };
}

test("offline preparation moves the whole shared store to main, retains provenance and backs up originals", async (t) => {
  const f = await fixture(t);
  await f.pair(1, "main");
  const sourcePair = await f.pair(2);
  const models = [{ modelId: "model-a", effortOptions: ["low"] }];
  const ledger = { reserve: async () => ({ ok: true, call: { callId: randomUUID() } }),
    settle: async () => ({ ok: true }), status: async () => ({ budget: {} }) };
  const learning = await openOrchestratorLearning({ workspace: f.workspace, memoryConversationId: f.memory.conversationId,
    initialThrough: 0, ledger, limits: { batchThreshold: 1, interval: 0 }, analyze: async () => ({ text: JSON.stringify({
      candidates: [{ kind: "procedure", content: "Short reports", conditions: "Reports only", orchestratorId: f.owner,
        skill: Object.fromEntries(["purpose", "triggers", "inputs", "steps", "outputs", "exceptions", "approvals"].map((key) => [key, `${key} for report workflow`])),
        evidence: [2], reason: "Explicit request" }], evaluations: [{ orchestratorId: f.owner, goal: "Short reports", score: 100,
        reason: "Explicit feedback", unknowns: "", evidence: [2], itemId: null }] }) }) });
  await learning.configure({ model: "model-a", effort: "low", settingsRevision: 1 }, models);
  await learning.observe([sourcePair]); await learning.runDue();
  let state = await learning.status();
  await learning.decide({ items: [{ id: state.candidates[0].id, version: 1 }], action: "adopt" });
  state = await learning.status();
  await learning.decide({ items: [{ id: state.candidates[0].id, version: 2 }], action: "publish" });
  await learning.configure({ model: "", effort: "", settingsRevision: 2 }, models);
  state = await learning.status();
  await learning.correctEvaluation({ evaluationId: state.evaluations[0].id, version: state.evaluations[0].version,
    score: 0, reason: "Make the reports even shorter" });
  const pending = await f.pair(3);
  await learning.observe([pending]);
  await learning.close();
  const file = path.join(f.workspace, "orchestrator-learning", "state.json");
  const original = JSON.parse(await fs.readFile(file, "utf8"));
  original.candidates[0].scope.shared = true;
  original.evaluations[0].itemId = original.candidates[0].id;
  original.evaluations[0].itemVersion = original.candidates[0].version;
  original.uses.push({ operationId: randomUUID(), orchestratorId: f.owner, items: [], reads: [], inheritedReads: [] });
  original.proposals.push({ id: randomUUID(), orchestratorId: f.owner, status: "declined", targets: [] });
  original.batch = { id: randomUUID(), pairs: [pending], attempts: 1, sourceHash: "old-request" };
  await fs.writeFile(file, JSON.stringify(original));
  const usageDir = path.join(f.workspace, "orchestrator-learning", "usage");
  const oldUsage = createOrchestratorLearningUsage({ directory: usageDir });
  const reserved = await oldUsage.reserve({ batchId: "old-batch", attempt: 1, settingsRevision: 1,
    model: "model-a", effort: "low", estimatedInputTokens: 100, maxOutputTokens: 10 });
  await oldUsage.settle(reserved.call.callId, { status: "completed", reportedModel: "model-a", usage: { inputTokens: 20, outputTokens: 5 } });
  const ledgerBytes = await fs.readFile(path.join(usageDir, "ledger.json"), "utf8");
  await fs.mkdir(path.join(f.workspace, "orchestrator-learning", "skills"), { recursive: true });
  await fs.writeFile(path.join(f.workspace, "orchestrator-learning", "skills", "historical.md"), "All skill versions retained");
  await fs.writeFile(path.join(f.workspace, "artifact.txt"), "All old files belong to main");
  const beforeActive = await fs.readFile(path.join(f.rootDir, "active.json"), "utf8");
  const dry = await f.prepare();
  assert.equal(dry.status, "dry_run");
  assert.equal(dry.memoryThrough, 3);
  assert.equal(await fs.readFile(path.join(f.rootDir, "active.json"), "utf8"), beforeActive);
  assert.equal((await fs.readdir(path.dirname(f.rootDir))).some((name) => name.includes("preparing") || name.includes("before-isolation")), false);
  const published = original.candidates[0].published;
  const skillSource = path.join(f.workspace, "orchestrator-learning", "skills", original.candidates[0].id, `${published.version}.md`);
  const originalMarkdown = await fs.readFile(skillSource, "utf8");
  await fs.writeFile(skillSource, "Tampered published skill");
  await assert.rejects(f.prepare(true), /differs from the saved hash/);
  assert.equal(await fs.readFile(path.join(f.rootDir, "active.json"), "utf8"), beforeActive);
  await assert.rejects(fs.stat(path.join(f.rootDir, "workspace")), { code: "ENOENT" });
  await fs.writeFile(skillSource, originalMarkdown);
  const applied = await f.prepare(true);
  assert.equal(applied.status, "prepared");
  assert.equal(await fs.readFile(path.join(applied.backup, "active.json"), "utf8"), beforeActive);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), original, "legacy source unchanged");
  const ownedWorkspace = path.join(f.rootDir, "workspace");
  const owned = JSON.parse(await fs.readFile(path.join(ownedWorkspace, "orchestrator-learning", "state.json"), "utf8"));
  assert.equal(owned.candidates.length, 1);
  assert.equal(owned.candidates[0].scope.orchestratorId, "main");
  assert.deepEqual(owned.candidates[0].scope, { orchestratorId: "main" });
  assert.equal(owned.candidates[0].sourceOrchestratorId, f.owner);
  assert.equal(owned.candidates[0].scope.shared, undefined);
  assert.equal(owned.candidates[0].evidence[0].orchestratorId, "main");
  assert.equal(owned.candidates[0].evidence[0].sourceOrchestratorId, f.owner);
  assert.equal(owned.candidates[0].evidence[0].logicalConversationId, f.childLogicalId);
  assert.equal(owned.candidates[0].evidence[0].memoryConversationId, f.memory.conversationId);
  assert.equal(owned.pending[0].orchestratorId, "main");
  assert.equal(owned.evaluations[0].scope.orchestratorId, "main");
  assert.equal(owned.corrections[0].scope.orchestratorId, "main");
  assert.equal(owned.uses[0].orchestratorId, "main");
  assert.equal(owned.proposals[0].orchestratorId, "main");
  assert.equal(owned.batch, null);
  assert.equal(owned.epoch, original.epoch + 1);
  assert.equal(await fs.readFile(path.join(ownedWorkspace, "orchestrator-learning", "usage", "ledger.json"), "utf8"), ledgerBytes);
  assert.equal(await fs.readFile(path.join(ownedWorkspace, "orchestrator-learning", "skills", "historical.md"), "utf8"), "All skill versions retained");
  assert.equal(await fs.readFile(path.join(ownedWorkspace, "artifact.txt"), "utf8"), "All old files belong to main");
  const mainActive = JSON.parse(await fs.readFile(path.join(f.rootDir, "active.json"), "utf8"));
  assert.equal(mainActive.memoryConversationId, f.memory.conversationId);
  assert.equal(mainActive.memoryFloorPairSeq, 1);
  const childActive = JSON.parse(await fs.readFile(path.join(f.childDir, "active.json"), "utf8"));
  assert.equal(childActive.memoryFloorPairSeq, 3);
  assert.equal(childActive.nativeThreadId, null);
  assert.equal(childActive.systemInstruction, "Child expertise");
  assert.equal(childActive.checklistCompletion, undefined);
  assert.equal(childActive.checklistReadPending, undefined);
  await assert.rejects(fs.stat(path.join(f.childDir, "task-checklist-overview.json")), { code: "ENOENT" });
  assert.notEqual(childActive.memoryConversationId, mainActive.memoryConversationId);
  const runtime = createVoiceOrchestratorService({ rootDir: f.rootDir, createClient: () => { throw new Error("No model calls"); } });
  assert.equal((await runtime.open(f.owner)).logicalConversationId, f.childLogicalId, "sibling workspace initializes normally");
  assert.equal((await runtime.learningStatus(f.owner)).candidates.length, 0);
  const childRaw = JSON.parse(await fs.readFile(path.join(f.childDir, "workspace", "voice-memory", "raw", childActive.memoryConversationId, "raw-state.json"), "utf8"));
  assert.equal(childRaw.lastPairSeq, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(ownedWorkspace, "voice-memory", "recent.json"), "utf8")).map((pair) => pair.pairSeq), [1, 2, 3]);
  assert.equal((await runtime.history(f.owner)).messages.length, 4, "old UI history stays visible");
  assert.equal(JSON.parse(await fs.readFile(path.join(f.childDir, "active.json"), "utf8")).checklistCompletion, undefined,
    "old event recovery cannot restore shared task metadata into the empty expert");

  const transferredUsage = createOrchestratorLearningUsage({ directory: path.join(ownedWorkspace, "orchestrator-learning", "usage") });
  assert.equal((await transferredUsage.history()).calls[0].callId, reserved.call.callId);
  const restored = await openOrchestratorLearning({ workspace: ownedWorkspace, memoryConversationId: f.memory.conversationId,
    initialThrough: 3, orchestratorId: "main", ledger, limits: { batchThreshold: 1, interval: 0 }, analyze: async ({ input }) => {
      const batch = JSON.parse(input);
      return { text: JSON.stringify({ candidates: [
        { kind: "procedure", content: "Short reports", conditions: "Reports only", orchestratorId: "main", evidence: [2], reason: "Repeated old preference" },
        { kind: "preference", content: "Even shorter reports", conditions: "Reports only",
        orchestratorId: "main", evidence: [2], reason: "Existing correction", replaces: [owned.candidates[0].id] }],
        corrections: batch.feedback.map((entry) => ({ id: entry.id, reason: "Applied correction", candidateIndex: 1 })) }) };
    } });
  t.after(() => restored.close());
  assert.equal((await restored.readSkill({ orchestratorId: "main", id: owned.candidates[0].id, ...published })).markdown, originalMarkdown);
  await restored.configure({ model: "model-a", effort: "low", settingsRevision: 3 }, models);
  await restored.runDue();
  const corrected = await restored.status();
  assert.equal(corrected.candidates.length, 2, "old instruction is deduplicated and the existing correction still creates a replacement");
  assert.equal(corrected.candidates[1].scope.orchestratorId, "main");
  assert.equal(corrected.evaluations[0].corrections[0].resolution.itemId, corrected.candidates[1].id);
  await restored.forget({ items: [{ id: corrected.candidates[1].id, version: 1 }] });
  await restored.close();
  assert.equal((await f.prepare(true)).status, "already_prepared", "rerun never restores forgotten learning from the old store");
});

test("preparation refuses live services, link escapes, occupied destinations and unsynced memory without changing data", async (t) => {
  const f = await fixture(t);
  await f.pair(1, "main");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(f.port, "127.0.0.1", resolve));
  await assert.rejects(f.prepare(true), /is active/);
  await new Promise((resolve) => server.close(resolve));
  const escape = path.join(f.workspace, "outside-link");
  await fs.symlink(os.tmpdir(), escape);
  await assert.rejects(f.prepare(true), /without links/);
  await fs.unlink(escape);
  await fs.mkdir(path.join(f.rootDir, "workspace"));
  await assert.rejects(f.prepare(true), /refusing to overwrite/);
  await fs.rmdir(path.join(f.rootDir, "workspace"));
  await fs.mkdir(path.join(f.childDir, "workspace"));
  await assert.rejects(f.prepare(true), /refusing to overwrite/);
  await fs.rmdir(path.join(f.childDir, "workspace"));
  const rawFile = path.join(f.workspace, "voice-memory", "raw", f.memory.conversationId, "raw-state.json");
  const raw = JSON.parse(await fs.readFile(rawFile, "utf8"));
  await fs.writeFile(rawFile, JSON.stringify({ ...raw, lastPairSeq: 0 }));
  await assert.rejects(f.prepare(true), /behind saved events/);
  assert.equal((await fs.readdir(path.dirname(f.rootDir))).filter((name) => name.includes("before-isolation") || name.includes("preparing")).length, 0);
});

async function previousStartup(f) {
  await f.pair(1, "main"); await f.pair(2); await f.pair(3);
  const source = await openOrchestratorLearning({ workspace: f.workspace, memoryConversationId: f.memory.conversationId, initialThrough: 3 });
  await source.close();
  for (const [id, directory] of [["main", f.rootDir], [f.owner, f.childDir]]) {
    const workspace = path.join(directory, "workspace");
    await fs.mkdir(workspace);
    const memoryId = randomUUID();
    await openVoiceMemoryStore({ workspace, conversationId: memoryId, eventPairs: [], initialThroughPairSeq: 1,
      atomicWrite: (file, text) => fs.writeFile(file, text), syncDirectory: async () => {},
      ownedDirectory: async (folder) => { await fs.mkdir(folder, { recursive: true }); return folder; } });
    const learning = await openOrchestratorLearning({ workspace, memoryConversationId: memoryId, initialThrough: 1, orchestratorId: id });
    await learning.close();
    const file = path.join(directory, "active.json");
    const active = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...active, isolationVersion: 1, legacyWorkspaceDirectory: f.workspace,
      memoryFloorPairSeq: 3, memoryConversationId: id === "main" ? randomUUID() : memoryId }));
    await fs.writeFile(path.join(workspace, "notes.txt"), `Existing files from ${id}`);
  }
}

test("known empty previous startup is explicitly consolidated, including drifted active IDs, without losing old files", async (t) => {
  const f = await fixture(t);
  await previousStartup(f);
  const actual = JSON.parse(await fs.readFile(path.join(f.rootDir, "workspace", "orchestrator-learning", "state.json"), "utf8"));
  const active = JSON.parse(await fs.readFile(path.join(f.rootDir, "active.json"), "utf8"));
  const legacyFile = path.join(f.workspace, "orchestrator-learning", "state.json");
  const sourceLearning = JSON.parse(await fs.readFile(legacyFile, "utf8"));
  const candidate = { id: randomUUID(), status: "active", kind: "preference", version: 1,
    content: "Keep old adopted knowledge", conditions: "Reports only", reason: "Explicit old instruction",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), scope: { orchestratorId: "main", shared: true },
    evidence: [{ memoryConversationId: f.memory.conversationId, pairSeq: 1, orchestratorId: "main",
      logicalConversationId: f.opened.logicalConversationId, clientOperationId: randomUUID() }] };
  sourceLearning.candidates.push(candidate);
  await fs.writeFile(legacyFile, JSON.stringify(sourceLearning));
  actual.candidates.push({ ...candidate, scope: { orchestratorId: "main" },
    evidence: candidate.evidence.map((entry) => ({ ...entry, memoryConversationId: actual.memoryConversationId })) });
  await fs.writeFile(path.join(f.rootDir, "workspace", "orchestrator-learning", "state.json"), JSON.stringify(actual));
  assert.notEqual(actual.memoryConversationId, active.memoryConversationId);
  assert.ok(actual.observedThrough < active.memoryFloorPairSeq);
  assert.equal((await f.prepare()).status, "dry_run");
  const result = await f.prepare(true);
  for (const id of ["main", f.owner]) {
    assert.equal(await fs.readFile(path.join(f.rootDir, "workspace", "previous-isolation", id, "notes.txt"), "utf8"), `Existing files from ${id}`);
    const directory = id === "main" ? f.rootDir : f.childDir;
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "active.json"), "utf8")).legacyWorkspaceDirectory, undefined);
  }
  assert.equal(await fs.readFile(path.join(result.backup, "workspace", "notes.txt"), "utf8"), "Existing files from main");
  assert.equal(JSON.parse(await fs.readFile(path.join(f.rootDir, "active.json"), "utf8")).memoryConversationId, f.memory.conversationId);
  const transferred = JSON.parse(await fs.readFile(path.join(f.rootDir, "workspace", "orchestrator-learning", "state.json"), "utf8"));
  assert.equal(transferred.candidates[0].id, candidate.id);
  assert.equal(transferred.candidates[0].status, "active");
  assert.equal((await f.prepare(true)).status, "already_prepared");
});

test("previous startup with new knowledge or uncommitted raw data stops instead of hiding a required merge", async (t) => {
  const f = await fixture(t);
  await previousStartup(f);
  const file = path.join(f.rootDir, "workspace", "orchestrator-learning", "state.json");
  const original = await fs.readFile(file, "utf8");
  const changed = JSON.parse(original);
  changed.candidates.push({ id: randomUUID(), content: "New specialist knowledge" });
  await fs.writeFile(file, JSON.stringify(changed));
  await assert.rejects(f.prepare(true), /changed knowledge/);
  assert.equal(await fs.readFile(file, "utf8"), JSON.stringify(changed));
  await fs.writeFile(file, original);
  const raw = path.join(f.rootDir, "workspace", "voice-memory", "raw", changed.memoryConversationId, "00000001-00000010.jsonl");
  await fs.writeFile(raw, "uncommitted new source");
  await assert.rejects(f.prepare(true), /changed knowledge/);
  assert.equal((await fs.readdir(path.dirname(f.rootDir))).filter((name) => name.includes("before-isolation") || name.includes("preparing")).length, 0);
});
