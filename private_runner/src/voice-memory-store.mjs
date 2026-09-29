import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const SEGMENT_PAIRS = 10;
const RETAINED_PAIRS = 30;
const MAX_RAW_PAIRS = 40;
const TOPIC_NAME = /^[a-z0-9][a-z0-9-]{0,40}\.md$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POINTER = /^<!-- voice-memory:v1 generation=([0-9a-f-]{36})(?: previous=([0-9a-f-]{36}))? -->\n/;
const SOURCE = /^- \[(確定|未確定|一時値|更新済み)\] .+\[(?:conversationId: ([0-9a-f-]{36}) )?pairSeq: (\d+(?:, \d+)*)\]$/;

const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const segmentName = (seq) => {
  const start = Math.floor((seq - 1) / SEGMENT_PAIRS) * SEGMENT_PAIRS + 1;
  return `${String(start).padStart(8, "0")}-${String(start + SEGMENT_PAIRS - 1).padStart(8, "0")}.jsonl`;
};
const digestOf = (index, topics) => {
  const hash = createHash("sha256").update(index);
  for (const [name, content] of [...topics].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update(content);
  return hash.digest("hex");
};

export async function openVoiceMemoryStore({ workspace, conversationId, previousConversationId, eventPairs,
  atomicWrite, syncDirectory, ownedDirectory }) {
  const directory = path.join(workspace, "voice-memory");
  const generations = path.join(directory, "generations");
  const rawRoot = path.join(directory, "raw");
  const pointerFile = path.join(directory, "index.md");
  const initializingFile = path.join(directory, "initializing.json");
  let currentConversationId = conversationId;
  let rawDirectory = path.join(rawRoot, currentConversationId);
  let pointer;
  let state;
  let index;
  let topics;
  let rawPairs = [];
  let sourceCursors = {};
  let rawRange = { firstPairSeq: 0, lastPairSeq: 0 };

  if (!UUID.test(conversationId) || (previousConversationId && !UUID.test(previousConversationId))) {
    throw new Error("Voice conversation ID is invalid");
  }

  function validateIndex(value, files) {
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 32_000) throw new Error("Voice memory index is invalid");
    if (!value.startsWith("# Topics\n") || value.split("\n").some((line) => line.trim() && line !== "# Topics"
      && !/^- \[[^\]]+\]\(topics\/[a-z0-9][a-z0-9-]{0,40}\.md\)$/.test(line))) {
      throw new Error("Voice memory index contains unsupported content");
    }
    const linked = [...value.matchAll(/\]\(topics\/([^)]+)\)/g)].map((match) => match[1]);
    if ([...value.matchAll(/\]\(([^)]+)\)/g)].some((match) => !match[1].startsWith("topics/"))
      || new Set(linked).size !== linked.length || linked.some((name) => !TOPIC_NAME.test(name))
      || linked.sort().join("\0") !== [...files].sort().join("\0")) {
      throw new Error("Voice memory index does not match topics");
    }
  }

  function validateTopic(name, content, cursor, sources = sourceCursors) {
    if (!TOPIC_NAME.test(name) || typeof content !== "string" || !content.trim()
      || Buffer.byteLength(content) > 64_000) {
      throw new Error("Voice memory topic is invalid");
    }
    for (const line of content.split("\n").filter((line) => line.trim() && !line.startsWith("#"))) {
      const match = line.match(SOURCE);
      const limit = match?.[2] ? sources[match[2]] : cursor;
      if (!match || (match[2] && (!UUID.test(match[2]) || !Number.isSafeInteger(limit)))
        || match[3].split(", ").some((seq) => !Number.isSafeInteger(Number(seq))
          || Number(seq) < 1 || Number(seq) > limit)) throw new Error("Voice memory topic source is invalid");
    }
  }

  async function readGeneration(id) {
    const folder = path.join(generations, id);
    await ownedDirectory(folder, false);
    await ownedDirectory(path.join(folder, "topics"), false);
    const nextState = JSON.parse(await fs.readFile(path.join(folder, "state.json"), "utf8"));
    if (!UUID.test(nextState.conversationId) || !Number.isSafeInteger(nextState.processedThroughPairSeq)
      || nextState.processedThroughPairSeq < 0) throw new Error("Voice memory cursor is invalid");
    const sources = nextState.sourceCursors || {};
    if (!isRecord(sources) || Object.entries(sources).some(([id, cursor]) => !UUID.test(id)
      || !Number.isSafeInteger(cursor) || cursor < 0 || id === nextState.conversationId)) {
      throw new Error("Voice memory source namespace is invalid");
    }
    const nextIndex = await fs.readFile(path.join(folder, "index.md"), "utf8");
    const names = (await fs.readdir(path.join(folder, "topics"))).filter((name) => name !== ".DS_Store");
    const nextTopics = new Map();
    for (const name of names) {
      if (!TOPIC_NAME.test(name)) throw new Error("Voice memory topic filename is invalid");
      const file = path.join(folder, "topics", name);
      if (!(await fs.lstat(file)).isFile()) throw new Error("Voice memory topic file is invalid");
      const content = await fs.readFile(file, "utf8");
      validateTopic(name, content, nextState.processedThroughPairSeq, sources);
      nextTopics.set(name, content);
    }
    validateIndex(nextIndex, nextTopics.keys());
    if (nextState.digest !== digestOf(nextIndex, nextTopics)) throw new Error("Voice memory generation digest differs");
    return { state: nextState, index: nextIndex, topics: nextTopics, sourceCursors: sources };
  }

  async function cleanGenerations() {
    for (const id of await fs.readdir(generations)) {
      if (id === ".DS_Store") continue;
      if (id === pointer.generation || id === pointer.previous) continue;
      if (!UUID.test(id)) throw new Error("Voice memory generation directory is invalid");
      const folder = path.join(generations, id);
      const stat = await fs.lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Voice memory generation directory is invalid");
      await fs.rm(folder, { recursive: true });
    }
    await syncDirectory(generations);
  }

  async function cleanRawDirectories() {
    for (const id of await fs.readdir(rawRoot)) {
      if (id === ".DS_Store") continue;
      if (id === currentConversationId) continue;
      if (!UUID.test(id)) throw new Error("Voice raw directory name is invalid");
      await ownedDirectory(path.join(rawRoot, id), false);
      await fs.rm(path.join(rawRoot, id), { recursive: true });
    }
    await syncDirectory(rawRoot);
  }

  async function commit(nextIndex, nextTopics, cursor, nextConversationId = currentConversationId,
    keepPrevious = true, nextSources = sourceCursors) {
    validateIndex(nextIndex, nextTopics.keys());
    for (const [name, content] of nextTopics) validateTopic(name, content, cursor, nextSources);
    const usedSources = {};
    for (const content of nextTopics.values()) {
      for (const [, id] of content.matchAll(/\[conversationId: ([0-9a-f-]{36}) pairSeq: /g)) {
        if (!Number.isSafeInteger(nextSources[id])) throw new Error("Voice memory source namespace is invalid");
        usedSources[id] = nextSources[id];
      }
    }
    const id = randomUUID();
    const folder = path.join(generations, id);
    await fs.mkdir(folder, { mode: 0o700 });
    await fs.mkdir(path.join(folder, "topics"), { mode: 0o700 });
    for (const [name, content] of nextTopics) await atomicWrite(path.join(folder, "topics", name), content);
    await atomicWrite(path.join(folder, "index.md"), nextIndex);
    await atomicWrite(path.join(folder, "state.json"), JSON.stringify({
      conversationId: nextConversationId, processedThroughPairSeq: cursor,
      sourceCursors: usedSources, digest: digestOf(nextIndex, nextTopics),
    }));
    await syncDirectory(path.join(folder, "topics"));
    await syncDirectory(folder);
    await syncDirectory(generations);
    const previous = keepPrevious ? pointer?.generation : undefined;
    const nextPointer = `<!-- voice-memory:v1 generation=${id}${previous ? ` previous=${previous}` : ""} -->\n`
      + `# Voice memory\n\n- [Topics](generations/${id}/index.md)\n- [Recent pairs](recent.json)\n- [Retained raw pairs](raw/${nextConversationId}/)\n`;
    await atomicWrite(pointerFile, nextPointer);
    pointer = { generation: id, previous };
    state = { conversationId: nextConversationId, processedThroughPairSeq: cursor };
    currentConversationId = nextConversationId;
    sourceCursors = usedSources;
    index = nextIndex;
    topics = nextTopics;
    await cleanGenerations();
  }

  async function readRaw() {
    rawRange = JSON.parse(await fs.readFile(path.join(rawDirectory, "raw-state.json"), "utf8"));
    if (!isRecord(rawRange) || rawRange.conversationId !== currentConversationId
      || !Number.isSafeInteger(rawRange.firstPairSeq) || !Number.isSafeInteger(rawRange.lastPairSeq)
      || rawRange.firstPairSeq < 0 || rawRange.lastPairSeq < 0
      || (rawRange.firstPairSeq === 0) !== (rawRange.lastPairSeq === 0)
      || rawRange.firstPairSeq > rawRange.lastPairSeq) throw new Error("Voice raw range is invalid");
    const names = (await fs.readdir(rawDirectory)).filter((name) => name !== "raw-state.json" && name !== ".DS_Store").sort();
    const loaded = [];
    for (const name of names) {
      if (!/^\d{8}-\d{8}\.jsonl$/.test(name)) throw new Error("Voice raw segment filename is invalid");
      const file = path.join(rawDirectory, name);
      if (!(await fs.lstat(file)).isFile()) throw new Error("Voice raw segment is invalid");
      const content = await fs.readFile(file, "utf8");
      if (!content.endsWith("\n") || Buffer.byteLength(content) > 16_000_000) throw new Error("Voice raw segment size is invalid");
      const rows = content.trim().split("\n");
      if (rows.length > SEGMENT_PAIRS || !rows[0]) throw new Error("Voice raw segment length is invalid");
      for (const row of rows) {
        const pair = JSON.parse(row);
        if (!Number.isSafeInteger(pair?.pairSeq) || pair.pairSeq < 1 || segmentName(pair.pairSeq) !== name
          || typeof pair.user !== "string" || typeof pair.assistant !== "string"
          || (loaded.length && pair.pairSeq !== loaded.at(-1).pairSeq + 1)) {
          throw new Error("Voice raw pair sequence is invalid");
        }
        loaded.push(pair);
      }
    }
    if (loaded.length > MAX_RAW_PAIRS) throw new Error("Voice raw pair capacity is invalid");
    if (rawRange.firstPairSeq && (!loaded.length || loaded[0].pairSeq > rawRange.firstPairSeq
      || loaded.at(-1).pairSeq < rawRange.lastPairSeq)) {
      throw new Error("Voice raw required range is missing");
    }
    if (loaded.length && loaded.at(-1).pairSeq > rawRange.lastPairSeq) {
      const extra = loaded.filter((pair) => pair.pairSeq > rawRange.lastPairSeq);
      if (extra.some((pair) => !eventPairs.some((eventPair) => JSON.stringify(eventPair) === JSON.stringify(pair)))) {
        throw new Error("Voice raw uncommitted tail is invalid");
      }
      await writeRawRange(loaded[0].pairSeq, loaded.at(-1).pairSeq);
    }
    rawPairs = loaded;
  }

  async function writeRawRange(firstPairSeq, lastPairSeq) {
    rawRange = { conversationId: currentConversationId, firstPairSeq, lastPairSeq };
    await atomicWrite(path.join(rawDirectory, "raw-state.json"), JSON.stringify(rawRange));
  }

  async function writeRecent() {
    await atomicWrite(path.join(directory, "recent.json"), JSON.stringify(rawPairs.slice(-10)));
  }

  async function pruneRaw() {
    const last = rawPairs.at(-1)?.pairSeq || 0;
    const through = Math.min(state.processedThroughPairSeq, last - RETAINED_PAIRS);
    let deletedThrough = 0;
    const toDelete = [];
    for (const name of await fs.readdir(rawDirectory)) {
      if (name === "raw-state.json" || name === ".DS_Store") continue;
      if (!/^\d{8}-\d{8}\.jsonl$/.test(name)) throw new Error("Voice raw segment filename is invalid");
      const end = Number(name.slice(9, 17));
      if (end <= through) { toDelete.push(name); deletedThrough = Math.max(deletedThrough, end); }
    }
    if (toDelete.length) await writeRawRange(deletedThrough + 1, last);
    for (const name of toDelete) await fs.rm(path.join(rawDirectory, name));
    await syncDirectory(rawDirectory);
    rawPairs = rawPairs.filter((pair) => pair.pairSeq > deletedThrough);
  }

  async function appendPair(pair) {
    const last = rawPairs.at(-1);
    if (last && pair.pairSeq <= last.pairSeq) {
      const stored = rawPairs.find((entry) => entry.pairSeq === pair.pairSeq);
      if (!stored || JSON.stringify(stored) !== JSON.stringify(pair)) throw new Error("Voice raw pair differs from event");
      await writeRecent();
      await pruneRaw();
      return;
    }
    if (rawPairs.length >= MAX_RAW_PAIRS) throw new Error("Voice raw pair capacity reached");
    if (!last && pair.pairSeq > state.processedThroughPairSeq + 1) throw new Error("Voice raw pair gap");
    if (last && pair.pairSeq !== last.pairSeq + 1) throw new Error("Voice raw pair gap");
    const name = segmentName(pair.pairSeq);
    const sameSegment = rawPairs.filter((entry) => segmentName(entry.pairSeq) === name);
    await atomicWrite(path.join(rawDirectory, name), `${[...sameSegment, pair].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    rawPairs.push(pair);
    await writeRawRange(rawPairs[0].pairSeq, pair.pairSeq);
    await writeRecent();
    await pruneRaw();
  }

  let exists = await fs.lstat(directory).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (exists) {
    await ownedDirectory(directory, false);
    const hasPointer = await fs.lstat(pointerFile).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (!hasPointer) {
      const entries = await fs.readdir(directory);
      const marker = await fs.readFile(initializingFile, "utf8").then(JSON.parse, (error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const generationEntries = await fs.readdir(generations).catch((error) => error.code === "ENOENT" ? [] : ["unknown"]);
      const rawEntries = await fs.readdir(rawRoot).catch((error) => error.code === "ENOENT" ? [] : ["unknown"]);
      if (entries.some((entry) => !["generations", "raw", "initializing.json", ".DS_Store"].includes(entry))
        || (marker && (!isRecord(marker) || marker.conversationId !== conversationId))
        || (!marker && (generationEntries.some((entry) => entry !== ".DS_Store")
          || rawEntries.some((entry) => entry !== ".DS_Store")))) {
        throw new Error("Voice memory pointer is missing");
      }
      await fs.rm(directory, { recursive: true });
      await syncDirectory(workspace);
      exists = false;
    }
  }
  await ownedDirectory(directory);
  await ownedDirectory(generations);
  await ownedDirectory(rawRoot);
  if (!exists) {
    await ownedDirectory(rawDirectory);
    await atomicWrite(initializingFile, JSON.stringify({ conversationId }));
    await writeRawRange(0, 0);
    const initialCursor = (eventPairs[0]?.pairSeq || 1) - 1;
    await commit("# Topics\n", new Map(), initialCursor);
    for (const pair of eventPairs) await appendPair(pair);
    await fs.rm(initializingFile);
    await syncDirectory(directory);
  } else {
    const content = await fs.readFile(pointerFile, "utf8");
    const match = content.match(POINTER);
    if (!match || !UUID.test(match[1]) || (match[2] && !UUID.test(match[2]))
      || !(await fs.lstat(pointerFile)).isFile()) throw new Error("Voice memory pointer is invalid");
    pointer = { generation: match[1], previous: match[2] };
    ({ state, index, topics, sourceCursors } = await readGeneration(pointer.generation));
    currentConversationId = state.conversationId;
    rawDirectory = path.join(rawRoot, state.conversationId);
    await ownedDirectory(rawDirectory, false);
    await readRaw();
    if (state.conversationId !== conversationId) {
      if (state.conversationId !== previousConversationId) throw new Error("Voice memory belongs to another conversation");
      await resetConversation(conversationId);
    }
    for (const pair of eventPairs) {
      if (pair.pairSeq > (rawPairs.at(-1)?.pairSeq || state.processedThroughPairSeq)) await appendPair(pair);
      else {
        const stored = rawPairs.find((entry) => entry.pairSeq === pair.pairSeq);
        if (stored && JSON.stringify(stored) !== JSON.stringify(pair)) throw new Error("Voice raw pair differs from event");
        if (!stored && pair.pairSeq > state.processedThroughPairSeq) throw new Error("Voice raw event pair is missing");
      }
    }
    await writeRecent();
    await pruneRaw();
    await cleanGenerations();
    await cleanRawDirectories();
    await fs.rm(initializingFile, { force: true });
  }

  async function resetConversation(nextConversationId) {
    if (!UUID.test(nextConversationId)) throw new Error("Voice conversation ID is invalid");
    const oldRawDirectory = rawDirectory;
    const nextRawDirectory = path.join(rawRoot, nextConversationId);
    await ownedDirectory(nextRawDirectory);
    await atomicWrite(path.join(nextRawDirectory, "raw-state.json"), JSON.stringify({
      conversationId: nextConversationId, firstPairSeq: 0, lastPairSeq: 0,
    }));
    await syncDirectory(nextRawDirectory);
    const nextTopics = new Map([...topics].map(([name, content]) => [name,
      content.replace(/\[pairSeq: (\d+(?:, \d+)*)\]/g,
        `[conversationId: ${currentConversationId} pairSeq: $1]`)]));
    const nextSources = { ...sourceCursors, [currentConversationId]: state.processedThroughPairSeq };
    await commit(index, nextTopics, 0, nextConversationId, false, nextSources);
    rawDirectory = nextRawDirectory;
    rawPairs = [];
    rawRange = { conversationId: nextConversationId, firstPairSeq: 0, lastPairSeq: 0 };
    await writeRecent();
    if (oldRawDirectory !== nextRawDirectory) await fs.rm(oldRawDirectory, { recursive: true });
    await cleanRawDirectories();
  }

  return {
    get cursor() { return state.processedThroughPairSeq; },
    get rawPairs() { return [...rawPairs]; },
    get lastPairSeq() { return Math.max(state.processedThroughPairSeq, rawPairs.at(-1)?.pairSeq || 0); },
    get memoryCharacterCount() { return Array.from([...topics.values()].join("\n")).length; },
    get atCapacity() { return rawPairs.length >= MAX_RAW_PAIRS; },
    get summaryContext() { return { index, topics: Object.fromEntries(topics) }; },
    appendPair,
    async publish(text, throughPairSeq) {
      if (typeof text !== "string" || Buffer.byteLength(text) > 256_000) throw new Error("Voice memory update is too large");
      let patch;
      try { patch = JSON.parse(text); } catch { throw new Error("Voice memory update is not JSON"); }
      if (!isRecord(patch) || Object.keys(patch).sort().join() !== "index,topics"
        || !Array.isArray(patch.topics) || patch.topics.length > 24) throw new Error("Voice memory update is invalid");
      const nextTopics = new Map(topics);
      const changed = new Set();
      for (const change of patch.topics) {
        if (!isRecord(change) || Object.keys(change).sort().join() !== "content,name"
          || !TOPIC_NAME.test(change.name) || changed.has(change.name)) throw new Error("Voice memory topic change is invalid");
        changed.add(change.name);
        if (change.content === null) nextTopics.delete(change.name);
        else {
          validateTopic(change.name, change.content, throughPairSeq, sourceCursors);
          nextTopics.set(change.name, change.content);
        }
      }
      if ((throughPairSeq === state.processedThroughPairSeq)
        || throughPairSeq < state.processedThroughPairSeq
        || (throughPairSeq > state.processedThroughPairSeq
          && throughPairSeq > (rawPairs.at(-1)?.pairSeq || 0) - 10)) {
        throw new Error("Voice memory update cursor is invalid");
      }
      await commit(patch.index, nextTopics, throughPairSeq, currentConversationId, true, sourceCursors);
      await pruneRaw();
    },
    async clear() {
      const cursor = (rawPairs[0]?.pairSeq || Math.max(state.processedThroughPairSeq, rawPairs.at(-1)?.pairSeq || 0) + 1) - 1;
      await commit("# Topics\n", new Map(), cursor, currentConversationId, false, {});
    },
    resetConversation,
  };
}
