import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readVoiceEventState } from "../src/voice-context-service.mjs";
import { openVoiceMemoryStore } from "../src/voice-memory-store.mjs";
import { openOrchestratorLearning } from "../src/orchestrator-learning-service.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exists = (file) => fs.lstat(file).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error));
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
async function writeJson(file, value) {
  const handle = await fs.open(file, "w", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
}

async function assertStopped(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Runner and Codex ports must be specified explicitly");
  for (const host of ["127.0.0.1", "::1"]) await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); reject(new Error(`Port ${port} is active. Stop Runner and Codex before preparation.`)); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`Could not verify stopped port ${port}`)); });
    socket.once("error", (error) => {
      socket.destroy();
      if (["ECONNREFUSED", "EAFNOSUPPORT"].includes(error.code)) resolve(); else reject(error);
    });
  });
}

// Copy only ordinary data, never links out of the source tree. Originals are retained.
async function copyTree(source, destination) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
    throw new Error("Preparation requires ordinary files and directories without links");
  if (stat.isDirectory()) {
    if (destination) await fs.mkdir(destination, { mode: 0o700 });
    for (const name of await fs.readdir(source)) await copyTree(path.join(source, name), destination && path.join(destination, name));
    if (destination) {
      const directory = await fs.open(destination, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } else if (destination) {
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    await fs.chmod(destination, stat.mode & 0o777);
    const file = await fs.open(destination, "r");
    try { await file.sync(); } finally { await file.close(); }
  }
}

function assignMain(value) {
  if (Array.isArray(value)) return value.map(assignMain);
  if (!value || typeof value !== "object") return value;
  const next = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, assignMain(entry)]));
  if (Object.hasOwn(next, "orchestratorId") && next.orchestratorId !== "main") {
    next.sourceOrchestratorId = next.orchestratorId;
    next.orchestratorId = "main";
  }
  if (next.scope?.sourceOrchestratorId) {
    next.sourceOrchestratorId = next.scope.sourceOrchestratorId;
    delete next.scope.sourceOrchestratorId;
  }
  if (Object.hasOwn(next, "shared")) delete next.shared;
  return next;
}

export async function prepareOrchestratorIsolation({ rootDir, runnerPort, codexPort, apply = false }) {
  await assertStopped(runnerPort);
  await assertStopped(codexPort);
  const root = await fs.realpath(rootDir);
  await copyTree(root);
  const registryFile = path.join(root, "orchestrators.json");
  const registry = await exists(registryFile) ? await readJson(registryFile)
    : { orchestrators: [{ id: "main", name: "メイン", icon: "" }], selectedId: "main" };
  if (!Array.isArray(registry.orchestrators) || registry.orchestrators[0]?.id !== "main"
    || !registry.orchestrators.every(({ id }) => id === "main" || UUID.test(id))
    || new Set(registry.orchestrators.map(({ id }) => id)).size !== registry.orchestrators.length)
    throw new Error("Invalid orchestration registry");
  if (await exists(path.join(root, "subagents.json"))) {
    const delegates = await readJson(path.join(root, "subagents.json"));
    if (!Array.isArray(delegates) || delegates.some((entry) => !["completed", "failed", "interrupted"].includes(entry.status)))
      throw new Error("Finish or interrupt delegated operations in the old Runner before preparation");
  }
  const stores = [];
  for (const { id } of registry.orchestrators) {
    const directory = id === "main" ? root : path.join(root, "orchestrators", id);
    const active = await readJson(path.join(directory, "active.json"));
    if (!UUID.test(active.logicalConversationId) || active.workspaceConversationId && !UUID.test(active.workspaceConversationId))
      throw new Error("Invalid conversation ID");
    const events = readVoiceEventState(await fs.readFile(path.join(directory, active.logicalConversationId, "events.jsonl")),
      active.prunedThroughPairSeq || 0);
    if (active.pendingDispatch || events.unresolvedOperationIds.length)
      throw new Error("Finish or interrupt unresolved operations in the old Runner before preparation");
    stores.push({ id, directory, active, events });
  }
  const previousStartup = stores.some(({ active }) => active.legacyWorkspaceDirectory);
  if (!previousStartup && stores.every(({ active }) => active.isolationVersion === 1)) {
    if (!await exists(path.join(root, "workspace"))) throw new Error("Prepared main workspace is missing");
    return { status: "already_prepared" };
  }
  if (stores.some(({ active }) => previousStartup ? active.isolationVersion !== 1 || !active.legacyWorkspaceDirectory
    : active.isolationVersion !== undefined)) throw new Error("Mixed preparation versions require inspection");
  if (!previousStartup) for (const { directory } of stores) if (await exists(path.join(directory, "workspace")))
    throw new Error("An isolated destination already exists; refusing to overwrite it");
  const main = stores[0];
  const legacyRoot = await fs.realpath(path.join(path.dirname(root), "workspaces"));
  const sourceWorkspace = previousStartup ? await fs.realpath(main.active.legacyWorkspaceDirectory)
    : path.join(legacyRoot, main.active.workspaceConversationId || main.active.logicalConversationId);
  if (path.dirname(sourceWorkspace) !== legacyRoot || !UUID.test(path.basename(sourceWorkspace)))
    throw new Error("Invalid legacy workspace location");
  await copyTree(sourceWorkspace);
  const memoryRoot = path.join(sourceWorkspace, "voice-memory");
  const pointer = await fs.readFile(path.join(memoryRoot, "index.md"), "utf8");
  const generation = pointer.match(/^<!-- voice-memory:v1 generation=([0-9a-f-]{36})(?: previous=[0-9a-f-]{36})? -->\n/)?.[1];
  if (!UUID.test(generation)) throw new Error("Invalid shared memory pointer");
  const memory = await readJson(path.join(memoryRoot, "generations", generation, "state.json"));
  if (!UUID.test(memory.conversationId) || registry.memoryConversationId && registry.memoryConversationId !== memory.conversationId)
    throw new Error("Shared memory namespace differs from registry");
  const raw = await readJson(path.join(memoryRoot, "raw", memory.conversationId, "raw-state.json"));
  const through = Math.max(memory.processedThroughPairSeq, raw.lastPairSeq);
  const lastEvent = Math.max(...stores.map(({ active, events }) => Math.max(active.prunedThroughPairSeq || 0, events.pairs.at(-1)?.pairSeq || 0)));
  if (!Number.isSafeInteger(through) || through < lastEvent)
    throw new Error("Shared memory is behind saved events. Recover it with the old Runner before preparation.");
  const learningFile = path.join(sourceWorkspace, "orchestrator-learning", "state.json");
  const learning = await exists(learningFile) ? await readJson(learningFile) : null;
  if (learning && (learning.memoryConversationId !== memory.conversationId || !Array.isArray(learning.candidates)))
    throw new Error("Shared learning namespace differs from memory");
  if (learning && learning.observedThrough < through)
    throw new Error("Shared learning is behind saved memory. Recover it with the old Runner before preparation.");
  if (previousStartup) for (const { id, directory, active, events } of stores) {
    const stop = () => { throw new Error("Previous startup contains changed knowledge; preserve it and inspect before consolidation"); };
    if (await fs.realpath(active.legacyWorkspaceDirectory) !== sourceWorkspace) stop();
    const workspace = path.join(directory, "workspace");
    const emptyMemory = path.join(workspace, "voice-memory");
    const ownedPointer = await fs.readFile(path.join(emptyMemory, "index.md"), "utf8");
    const ownedGeneration = ownedPointer.match(/^<!-- voice-memory:v1 generation=([0-9a-f-]{36}) -->\n/)?.[1];
    if (!UUID.test(ownedGeneration)) stop();
    const generationDirectory = path.join(emptyMemory, "generations", ownedGeneration);
    const ownedMemory = await readJson(path.join(generationDirectory, "state.json"));
    const ownedId = ownedMemory.conversationId;
    if (!UUID.test(ownedId) || !Number.isSafeInteger(ownedMemory.processedThroughPairSeq)
      || ownedMemory.processedThroughPairSeq > active.memoryFloorPairSeq || active.memoryFloorPairSeq > through
      || events.pairs.some((pair) => pair.pairSeq > active.memoryFloorPairSeq)
      || Object.keys(ownedMemory.sourceCursors || {}).length
      || (await fs.readdir(path.join(generationDirectory, "topics"))).length
      || await fs.readFile(path.join(generationDirectory, "index.md"), "utf8") !== "# Topics\n") stop();
    const ownedRaw = await readJson(path.join(emptyMemory, "raw", ownedId, "raw-state.json"));
    if (ownedRaw.conversationId !== ownedId || ownedRaw.firstPairSeq !== 0 || ownedRaw.lastPairSeq !== 0
      || (await fs.readdir(path.join(emptyMemory, "raw", ownedId))).some((name) => !["raw-state.json", ".DS_Store"].includes(name))
      || (await fs.readdir(path.join(emptyMemory, "raw"))).some((name) => ![ownedId, ".DS_Store"].includes(name))
      || (await fs.readdir(path.join(emptyMemory, "generations"))).some((name) => ![ownedGeneration, ".DS_Store"].includes(name))) stop();
    const owned = await readJson(path.join(workspace, "orchestrator-learning", "state.json"));
    let expected = (learning?.candidates || []).filter((item) => item.scope.orchestratorId === id
      && item.evidence.length && item.evidence.every((entry) => entry.orchestratorId === id));
    let size;
    do {
      size = expected.length;
      const ids = new Set(expected.map((item) => item.id));
      expected = expected.filter((item) => !item.replaces || item.replaces.every((predecessor) => ids.has(predecessor)));
    } while (size !== expected.length);
    expected = expected.map((item) => ({ ...item, scope: { orchestratorId: id },
      evidence: item.evidence.map((entry) => ({ ...entry, memoryConversationId: ownedId })) }));
    if (owned.memoryConversationId !== ownedId || owned.epoch !== 1 || owned.contextRevision !== 1
      || owned.observedThrough !== ownedMemory.processedThroughPairSeq || owned.processedThrough !== owned.observedThrough
      || owned.batch || owned.lastStartedAt !== 0 || owned.settings.settingsRevision !== 1
      || owned.settings.model !== (learning?.settings.model || "") || owned.settings.effort !== (learning?.settings.effort || "")
      || ["pending", "evaluations", "corrections", "changes", "uses", "proposals", "excluded", "requests", "cleanup"].some((key) => !Array.isArray(owned[key]) || owned[key].length)
      || JSON.stringify(owned.candidates) !== JSON.stringify(expected)) stop();
    const usageFile = path.join(workspace, "orchestrator-learning", "usage", "ledger.json");
    if (await exists(usageFile)) {
      const usage = await readJson(usageFile);
      if (usage.calls.length || Object.keys(usage.days).length || usage.priceSnapshot) stop();
    }
  }
  const summary = { status: apply ? "prepared" : "dry_run", orchestrators: stores.length,
    learningItems: learning?.candidates.length || 0, memoryThrough: through };
  if (!apply) return summary;

  const suffix = randomUUID();
  const staging = `${root}.preparing-${suffix}`;
  const backup = `${root}.before-isolation-${suffix}`;
  let published = false;
  try {
    await copyTree(root, staging);
    if (previousStartup) for (const { id } of stores)
      await fs.rm(path.join(id === "main" ? staging : path.join(staging, "orchestrators", id), "workspace"), { recursive: true });
    await copyTree(sourceWorkspace, path.join(staging, "workspace"));
    if (previousStartup) {
      const archive = path.join(staging, "workspace", "previous-isolation");
      await fs.mkdir(archive, { mode: 0o700 });
      for (const { id, directory } of stores) await copyTree(path.join(directory, "workspace"), path.join(archive, id));
    }
    if (learning) {
      const owned = assignMain(learning);
      // Pending evidence is retained; the old in-flight request is archived in the untouched backup.
      owned.batch = null;
      owned.epoch += 1;
      delete owned.migration;
      await writeJson(path.join(staging, "workspace", "orchestrator-learning", "state.json"), owned);
    }
    for (const { id, active, events } of stores) {
      const directory = id === "main" ? staging : path.join(staging, "orchestrators", id);
      const next = { ...active, isolationVersion: 1,
        memoryConversationId: id === "main" ? memory.conversationId : randomUUID(),
        memoryFloorPairSeq: Math.max(active.prunedThroughPairSeq || 0, events.pairs.at(-1)?.pairSeq || 0),
        nativeThreadId: null, parentGeneration: (active.parentGeneration || 0) + 1,
        completedOnParent: 0, contextLimitReached: false,
        completedCount: active.completedCount === undefined ? events.completedPairs.length
          : active.completedCount + events.completedPairs.filter((pair) => pair.pairSeq > (active.countedThroughPairSeq || 0)).length,
        readCompletedCount: active.completedCount === undefined ? events.completedPairs.length : active.readCompletedCount || 0,
        countedThroughPairSeq: Math.max(active.prunedThroughPairSeq || 0, events.pairs.at(-1)?.pairSeq || 0) };
      for (const key of ["legacyWorkspaceDirectory", "nativeTurnId", "pendingSwitch", "pendingConfirmation", "learningSnapshot", "nativeLearningEnabled",
        "nativeCalendarReadEnabled", "nativeAgentsEnabled", "nativeChecklistWriteEnabled", "nativeChecklistCompletionEnabled", "nativeChecklistCompletionVersion"])
        delete next[key];
      if (id !== "main") {
        for (const key of ["workspaceInitialized", "checklistCompletion", "checklistReadPending", "topicJudgeMetrics"]) delete next[key];
        await fs.rm(path.join(directory, "task-checklist-overview.json"), { force: true });
      }
      await writeJson(path.join(directory, "active.json"), next);
      // Old summary work must never resume in a freshly isolated runtime.
      const pending = path.join(directory, active.logicalConversationId, "memory-pending.json");
      if (await exists(pending)) await fs.rename(pending, `${pending}.before-isolation`);
    }
    const ownedWorkspace = path.join(staging, "workspace");
    // Validate copied formats using the ordinary readers before publishing any change.
    await openVoiceMemoryStore({ workspace: ownedWorkspace, conversationId: memory.conversationId, eventPairs: [],
      atomicWrite: async (file, text) => { await fs.writeFile(file, text, { mode: 0o600 }); },
      syncDirectory: async (directory) => { const handle = await fs.open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } },
      ownedDirectory: async (directory, create = true) => {
        if (create) await fs.mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
        if (!(await fs.lstat(directory)).isDirectory()) throw new Error("Invalid memory directory");
        return directory;
      } });
    if (learning) {
      const validated = await openOrchestratorLearning({ workspace: ownedWorkspace, memoryConversationId: memory.conversationId,
        initialThrough: through, orchestratorId: "main", isBusy: () => true });
      await validated.close();
      for (const item of learning.candidates) for (const artifact of [item.published, item.previousPublished].filter(Boolean)) {
        const markdown = await fs.readFile(path.join(ownedWorkspace, "orchestrator-learning", "skills", item.id, `${artifact.version}.md`), "utf8");
        if (Buffer.byteLength(markdown) > 16_000 || createHash("sha256").update(JSON.stringify(markdown)).digest("hex") !== artifact.hash)
          throw new Error("Published skill artifact differs from the saved hash");
      }
    }
    delete registry.memoryConversationId;
    await writeJson(path.join(staging, "orchestrators.json"), registry);
    await assertStopped(runnerPort);
    await assertStopped(codexPort);
    await fs.rename(root, backup);
    try { await fs.rename(staging, root); published = true; }
    catch (error) { await fs.rename(backup, root); throw error; }
    const parent = await fs.open(path.dirname(root), "r");
    try { await parent.sync(); } finally { await parent.close(); }
    return { ...summary, backup };
  } finally {
    if (!published) await fs.rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length < 6 || ![6, 7].includes(args.length) || args[0] !== "--root" || args[2] !== "--runner-port"
    || args[4] !== "--codex-port" || args.length === 7 && args[6] !== "--apply") {
    process.stderr.write("Usage: node prepare-orchestrator-isolation.mjs --root <context/v1> --runner-port <port> --codex-port <port> [--apply]\n");
    process.exitCode = 1;
  } else {
    try {
      const result = await prepareOrchestratorIsolation({ rootDir: args[1], runnerPort: Number(args[3]),
        codexPort: Number(args[5]), apply: args[6] === "--apply" });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
