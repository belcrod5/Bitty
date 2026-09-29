import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openVoiceMemoryStore } from "../src/voice-memory-store.mjs";

async function atomicWrite(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally { await handle.close(); }
  try { await fs.rename(temp, file); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
  await syncDirectory(path.dirname(file));
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ownedDirectory(directory, create = true) {
  if (create) {
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid directory");
  return directory;
}

const pair = (pairSeq) => ({ pairSeq, user: `user-${pairSeq}`, assistant: `assistant-${pairSeq}` });
const update = (seq) => JSON.stringify({
  index: "# Topics\n\n- [Project](topics/project.md)\n",
  topics: [{ name: "project.md", content: `- [確定] value-${seq} [pairSeq: ${seq}]\n` }],
});

async function fixture(t, { eventPairs = [] } = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "voice-memory-store-test-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const workspace = path.join(parent, "workspace");
  await fs.mkdir(workspace);
  const conversationId = randomUUID();
  const options = { workspace, conversationId, eventPairs,
    atomicWrite, syncDirectory, ownedDirectory };
  const store = await openVoiceMemoryStore(options);
  return { workspace, conversationId, options, store };
}

test("bounded raw, recent, generation retention, and cursor follow successful topic updates", async (t) => {
  const { workspace, conversationId, store } = await fixture(t, { eventPairs: Array.from({ length: 40 }, (_, i) => pair(i + 1)) });
  assert.equal(store.atCapacity, true);
  await assert.rejects(store.appendPair(pair(41)), /capacity/);
  await store.publish(update(30), 30);
  assert.equal(store.cursor, 30);
  assert.deepEqual(store.rawPairs.map(({ pairSeq }) => pairSeq), Array.from({ length: 30 }, (_, i) => i + 11));
  for (let seq = 41; seq <= 50; seq++) await store.appendPair(pair(seq));
  await store.publish(update(40), 40);
  for (let seq = 51; seq <= 60; seq++) await store.appendPair(pair(seq));
  await store.publish(update(50), 50);
  assert.deepEqual(store.rawPairs.map(({ pairSeq }) => pairSeq), Array.from({ length: 30 }, (_, i) => i + 31));
  const memory = path.join(workspace, "voice-memory");
  assert.deepEqual((await fs.readdir(path.join(memory, "raw", conversationId))).sort(), [
    "00000031-00000040.jsonl", "00000041-00000050.jsonl", "00000051-00000060.jsonl", "raw-state.json",
  ]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(memory, "recent.json"), "utf8")),
    Array.from({ length: 10 }, (_, i) => pair(i + 51)));
  assert.equal((await fs.readdir(path.join(memory, "generations"))).length, 2);
  assert.match(await fs.readFile(path.join(memory, "index.md"), "utf8"), /Recent pairs/);
});

test("transient pairs can advance the cursor without changing topics", async (t) => {
  const { store, options, workspace } = await fixture(t, { eventPairs: Array.from({ length: 11 }, (_, i) => pair(i + 1)) });
  const memory = path.join(workspace, "voice-memory");
  const first = JSON.parse(await fs.readFile(path.join(memory, "generations",
    (await fs.readFile(path.join(memory, "index.md"), "utf8")).match(/generation=([0-9a-f-]{36})/)[1], "state.json"), "utf8"));
  await store.publish(JSON.stringify({ index: "# Topics\n", topics: [] }), 1);
  const next = JSON.parse(await fs.readFile(path.join(memory, "generations",
    (await fs.readFile(path.join(memory, "index.md"), "utf8")).match(/generation=([0-9a-f-]{36})/)[1], "state.json"), "utf8"));
  assert.equal(next.processedThroughPairSeq, 1);
  assert.equal(next.digest, first.digest);
  assert.equal((await openVoiceMemoryStore(options)).cursor, 1);
  await assert.rejects(store.publish(JSON.stringify({ index: "# Topics\n\n- [Bad](topics/bad.md)\n",
    topics: [{ name: "bad.md", content: "- [確定] Bad [legacy]\n" }] }), 2), /source/);
});

test("opens generations written before the legacy state field was removed", async (t) => {
  const { options, workspace } = await fixture(t);
  const memory = path.join(workspace, "voice-memory");
  const generation = (await fs.readFile(path.join(memory, "index.md"), "utf8")).match(/generation=([0-9a-f-]{36})/)[1];
  const stateFile = path.join(memory, "generations", generation, "state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  await atomicWrite(stateFile, JSON.stringify({ ...state, legacyCategorized: false }));
  assert.equal((await openVoiceMemoryStore(options)).cursor, 0);
});

test("Finder metadata is ignored in voice-memory scans but unknown names are rejected", async (t) => {
  const { store, options, workspace } = await fixture(t, { eventPairs: Array.from({ length: 12 }, (_, i) => pair(i + 1)) });
  const memory = path.join(workspace, "voice-memory");
  const pointer = await fs.readFile(path.join(memory, "index.md"), "utf8");
  const firstGeneration = pointer.match(/generation=([0-9a-f-]{36})/)[1];
  for (const folder of [memory, path.join(memory, "generations"), path.join(memory, "generations", firstGeneration, "topics"),
    path.join(memory, "raw"), path.join(memory, "raw", options.conversationId)]) {
    await fs.writeFile(path.join(folder, ".DS_Store"), "Finder metadata");
  }
  await store.publish(update(1), 1);
  await store.publish(update(2), 2);
  const latest = (await fs.readFile(path.join(memory, "index.md"), "utf8")).match(/generation=([0-9a-f-]{36})/)[1];
  await fs.writeFile(path.join(memory, "generations", latest, "topics", ".DS_Store"), "Finder metadata");
  const generations = (await fs.readdir(path.join(memory, "generations"))).filter((name) => name !== ".DS_Store");
  assert.equal(generations.length, 2);
  assert.equal((await openVoiceMemoryStore(options)).cursor, 2);
  await fs.writeFile(path.join(memory, "generations", "unexpected"), "x");
  await assert.rejects(openVoiceMemoryStore(options), /generation directory/);
  await fs.rm(path.join(memory, "generations", "unexpected"));
  await fs.writeFile(path.join(memory, "raw", "unexpected"), "x");
  await assert.rejects(openVoiceMemoryStore(options), /raw directory name/);
});

test("interrupted initialization tolerates only Finder metadata", async (t) => {
  const { options, workspace } = await fixture(t);
  const memory = path.join(workspace, "voice-memory");
  await fs.rm(memory, { recursive: true });
  await fs.mkdir(path.join(memory, "generations"), { recursive: true });
  await fs.mkdir(path.join(memory, "raw"));
  for (const folder of [memory, path.join(memory, "generations"), path.join(memory, "raw")]) {
    await fs.writeFile(path.join(folder, ".DS_Store"), "Finder metadata");
  }
  assert.equal((await openVoiceMemoryStore(options)).cursor, 0);
  await fs.rm(memory, { recursive: true });
  await fs.mkdir(path.join(memory, "generations"), { recursive: true });
  await fs.mkdir(path.join(memory, "raw"));
  await fs.writeFile(path.join(memory, "generations", "unexpected"), "x");
  await assert.rejects(openVoiceMemoryStore(options), /pointer is missing/);
});

test("failed pointer publish keeps cursor and raw; restart removes orphan candidate", async (t) => {
  const { options, workspace, store } = await fixture(t, { eventPairs: Array.from({ length: 11 }, (_, i) => pair(i + 1)) });
  const pointer = path.join(workspace, "voice-memory", "index.md");
  const original = await fs.readFile(pointer, "utf8");
  const originalRename = fs.rename;
  t.mock.method(fs, "rename", (from, to) => String(to) === pointer ? Promise.reject(new Error("pointer failed")) : originalRename(from, to));
  await assert.rejects(store.publish(update(1), 1), /pointer failed/);
  assert.equal(store.cursor, 0);
  assert.equal(await fs.readFile(pointer, "utf8"), original);
  assert.equal(store.rawPairs.length, 11);
  t.mock.restoreAll();
  const reopened = await openVoiceMemoryStore(options);
  assert.equal(reopened.cursor, 0);
  assert.equal((await fs.readdir(path.join(workspace, "voice-memory", "generations"))).length, 1);
});

test("failure after pointer switch resumes one raw prune without repeating topic update", async (t) => {
  const { options, workspace, store } = await fixture(t, { eventPairs: Array.from({ length: 40 }, (_, i) => pair(i + 1)) });
  const raw = path.join(workspace, "voice-memory", "raw", options.conversationId);
  const old = path.join(raw, "00000001-00000010.jsonl");
  const originalRm = fs.rm;
  t.mock.method(fs, "rm", (file, ...args) => String(file) === old ? Promise.reject(new Error("prune failed")) : originalRm(file, ...args));
  await assert.rejects(store.publish(update(30), 30), /prune failed/);
  assert.equal(store.cursor, 30);
  assert.equal(await fs.stat(old).then(() => true, () => false), true);
  t.mock.restoreAll();
  const reopened = await openVoiceMemoryStore(options);
  assert.equal(reopened.cursor, 30);
  assert.equal(await fs.stat(old).then(() => true, () => false), false);
  assert.equal((await fs.readdir(path.join(workspace, "voice-memory", "generations"))).length, 2);
  assert.deepEqual(reopened.rawPairs.map(({ pairSeq }) => pairSeq), Array.from({ length: 30 }, (_, i) => i + 11));
});

test("curator changes reject duplicate names, traversal, empty topics, and oversized output", async (t) => {
  const { store } = await fixture(t, { eventPairs: Array.from({ length: 11 }, (_, i) => pair(i + 1)) });
  const index = "# Topics\n\n- [Project](topics/project.md)\n";
  for (const changes of [
    [{ name: "../escape.md", content: "- [確定] bad [pairSeq: 1]" }],
    [{ name: "project.md", content: "" }],
    [{ name: "project.md", content: "- [確定] value [pairSeq: 1]" }, { name: "project.md", content: null }],
  ]) await assert.rejects(store.publish(JSON.stringify({ index, topics: changes }), 1));
  await assert.rejects(store.publish("x".repeat(256_001), 1), /too large/);
  assert.equal(store.cursor, 0);
});

test("conversation reset preserves old topic citations without colliding with new pair numbers", async (t) => {
  const { store, options, workspace, conversationId } = await fixture(t, {
    eventPairs: Array.from({ length: 11 }, (_, i) => pair(i + 1)),
  });
  await store.publish(update(1), 1);
  const nextConversationId = randomUUID();
  await store.resetConversation(nextConversationId);
  assert.equal(store.cursor, 0);
  assert.match(store.summaryContext.topics["project.md"], new RegExp(`conversationId: ${conversationId} pairSeq: 1`));
  await store.appendPair(pair(1));
  const reopened = await openVoiceMemoryStore({ ...options, conversationId: nextConversationId, previousConversationId: conversationId,
    eventPairs: [pair(1)] });
  assert.equal(reopened.lastPairSeq, 1);
  assert.equal((await fs.readdir(path.join(workspace, "voice-memory", "raw"))).length, 1);
});

test("missing required leading or trailing raw segments fail closed", async (t) => {
  const { options, workspace } = await fixture(t, {
    eventPairs: Array.from({ length: 21 }, (_, i) => pair(i + 1)),
  });
  const raw = path.join(workspace, "voice-memory", "raw", options.conversationId);
  const first = path.join(raw, "00000001-00000010.jsonl");
  const contents = await fs.readFile(first);
  await fs.rm(first);
  await assert.rejects(openVoiceMemoryStore(options), /required range/);
  await fs.writeFile(first, contents);
  await fs.rm(path.join(raw, "00000021-00000030.jsonl"));
  await assert.rejects(openVoiceMemoryStore(options), /required range/);
});

test("duplicate append repairs recent after an interrupted recent write", async (t) => {
  const { store, workspace } = await fixture(t);
  const recent = path.join(workspace, "voice-memory", "recent.json");
  const originalRename = fs.rename;
  t.mock.method(fs, "rename", (from, to) => String(to) === recent ? Promise.reject(new Error("recent failed")) : originalRename(from, to));
  await assert.rejects(store.appendPair(pair(1)), /recent failed/);
  t.mock.restoreAll();
  await store.appendPair(pair(1));
  assert.deepEqual(JSON.parse(await fs.readFile(recent, "utf8")), [pair(1)]);
});

test("raw segment over ten rows or over size limit fails closed", async (t) => {
  const { options, workspace } = await fixture(t, {
    eventPairs: Array.from({ length: 11 }, (_, i) => pair(i + 1)),
  });
  const raw = path.join(workspace, "voice-memory", "raw", options.conversationId);
  const first = path.join(raw, "00000001-00000010.jsonl");
  const original = await fs.readFile(first, "utf8");
  await fs.writeFile(first, original + `${JSON.stringify(pair(1))}\n`);
  await assert.rejects(openVoiceMemoryStore(options), /length/);
  await fs.writeFile(first, "x".repeat(16_000_001) + "\n");
  await assert.rejects(openVoiceMemoryStore(options), /size/);
});

test("initial candidate without a pointer is rebuilt from authoritative events", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "voice-memory-init-test-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const workspace = path.join(parent, "workspace");
  await fs.mkdir(workspace);
  const conversationId = randomUUID();
  const options = { workspace, conversationId, eventPairs: [pair(1)], atomicWrite, syncDirectory, ownedDirectory };
  const pointer = path.join(workspace, "voice-memory", "index.md");
  const originalRename = fs.rename;
  t.mock.method(fs, "rename", (from, to) => String(to) === pointer
    ? Promise.reject(new Error("pointer interrupted")) : originalRename(from, to));
  await assert.rejects(openVoiceMemoryStore(options), /pointer interrupted/);
  t.mock.restoreAll();
  const reopened = await openVoiceMemoryStore(options);
  assert.deepEqual(reopened.summaryContext, { index: "# Topics\n", topics: {} });
  assert.deepEqual(reopened.rawPairs, [pair(1)]);
});

test("initialization recovers a segment written before its raw range marker", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "voice-memory-init-test-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const workspace = path.join(parent, "workspace");
  await fs.mkdir(workspace);
  const conversationId = randomUUID();
  const options = { workspace, conversationId,
    eventPairs: Array.from({ length: 20 }, (_, i) => pair(i + 6)), atomicWrite, syncDirectory, ownedDirectory };
  let rangeWrites = 0;
  const originalRename = fs.rename;
  t.mock.method(fs, "rename", (from, to) => {
    if (String(to).endsWith("raw-state.json") && ++rangeWrites === 2) return Promise.reject(new Error("range interrupted"));
    return originalRename(from, to);
  });
  await assert.rejects(openVoiceMemoryStore(options), /range interrupted/);
  t.mock.restoreAll();
  const reopened = await openVoiceMemoryStore(options);
  assert.equal(reopened.cursor, 5);
  assert.deepEqual(reopened.rawPairs.map(({ pairSeq }) => pairSeq), Array.from({ length: 20 }, (_, i) => i + 6));
});

test("topic update can combine namespaced old evidence and new pair evidence", async (t) => {
  const { store, conversationId } = await fixture(t, {
    eventPairs: Array.from({ length: 11 }, (_, i) => pair(i + 1)),
  });
  await store.publish(update(1), 1);
  await store.resetConversation(randomUUID());
  for (let seq = 1; seq <= 11; seq++) await store.appendPair(pair(seq));
  const index = "# Topics\n\n- [Project](topics/project.md)\n";
  const content = `- [更新済み] old [conversationId: ${conversationId} pairSeq: 1]\n- [確定] new [pairSeq: 1]\n`;
  await store.publish(JSON.stringify({ index, topics: [{ name: "project.md", content }] }), 1);
  assert.equal(store.summaryContext.topics["project.md"], content);
  await assert.rejects(store.publish(JSON.stringify({ index, topics: [{ name: "project.md",
    content: `- [確定] invalid [conversationId: ${randomUUID()} pairSeq: 1]\n` }] }), 2));
});
