import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createVoiceContextService, readVoiceEventState } from "./voice-context-service.mjs";
import { openOrchestratorLearning } from "./orchestrator-learning-service.mjs";
import { createOrchestratorLearningUsage } from "./orchestrator-learning-usage.mjs";
import { createVoiceSubagentService } from "./voice-subagents.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ICON_BYTES = 1024 * 1024;
const iconPattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const failure = (message, code = "turn_rejected") => Object.assign(new Error(message), { code });
const TTS_PROVIDERS = new Set(["elevenlabs", "google", "aivisspeech"]);

function validateTtsVoice(provider, voiceId) {
  if (!TTS_PROVIDERS.has(provider) || typeof voiceId !== "string" || voiceId.length > 200) {
    throw failure("Orchestrator TTS voice is invalid");
  }
  return { ttsProvider: provider, voiceId: voiceId.trim() };
}

function validateName(name) {
  if (typeof name !== "string" || !name.trim() || [...name].length > 80) throw failure("Orchestrator name is invalid");
  return name.trim();
}

function validateIcon(icon) {
  if (icon === null || icon === "") return "";
  const match = typeof icon === "string" && icon.match(iconPattern);
  if (!match) throw failure("Orchestrator icon must be PNG, JPEG, or WebP");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_ICON_BYTES || bytes.toString("base64") !== match[2]
    || (match[1] === "png" && !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    || (match[1] === "jpeg" && (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9))
    || (match[1] === "webp" && (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP"))) {
    throw failure("Orchestrator icon is invalid");
  }
  return icon;
}

export function createVoiceOrchestratorService({ rootDir, createClient, getAgentService, subjectId,
  onCompleted, onChecklistChanged, onLearningUnreadChanged, activity, defaultTtsProvider = "aivisspeech" }) {
  const root = path.resolve(rootDir);
  const registryFile = path.join(root, "orchestrators.json");
  const orchestratorRoot = path.join(root, "orchestrators");
  let registry;
  let main;
  let memoryStore;
  let workspaceDirectory;
  let learning;
  let learningLedger;
  let learningError;
  let recoveredLearningPairs = [];
  const observePair = (orchestratorId) => async (pair) => {
    if (learning) await learning.observe([{ ...pair, orchestratorId, memoryConversationId: memoryStore.conversationId }]);
    else recoveredLearningPairs.push({ ...pair, orchestratorId });
  };
  const learningContext = (orchestratorId) => ({
    retrieve: (args) => learning ? learning.retrieve({ ...args, orchestratorId }) : Promise.resolve({ contextRevision: 0,
      selectedDigest: "unavailable", items: [], invalidated: Boolean(args.exposedItems?.length), excludedPairSeqs: null, instruction: "" }),
    delivered: (args) => learning?.delivered({ ...args, orchestratorId }),
    recordRead: (args) => learning?.recordRead(args),
    tool: async ({ tool, arguments: args, operationId, input }) => {
      if (!learning) throw failure("Learning is unavailable", "learning_store_unavailable");
      if (tool === "read_context" && Object.keys(args).sort().join() === "sourceItemIds,targets")
        return { selection: await learning.retrieve({ orchestratorId, input, targets: args.targets }), sourceItemIds: args.sourceItemIds };
      if (tool === "read_skill" && Object.keys(args).sort().join() === "hash,id,version") return learning.readSkill({ ...args, orchestratorId });
      if (tool === "propose_batch") return learning.proposeBatch({ ...args, orchestratorId, operationId });
      throw failure("Unknown learning tool", "learning_request_invalid");
    },
  });
  let storeFailure;
  const contexts = new Map();
  const reservations = new Set();
  const operationOwners = new Map();
  const subagents = getAgentService ? createVoiceSubagentService({ rootDir: root, getAgentService, subjectId }) : null;
  const managedSessions = (id) => subagents ? {
    refresh: () => subagents.refresh(id), contextOf: subagents.contextOf,
    handleTool: (request) => subagents.handleTool(id, request),
  } : undefined;
  const hasOutstandingActivity = (id) => (threadId) => Boolean(activity?.hasOutstanding?.({
    orchestratorId: id, rootThreadId: threadId,
  }));
  const withCounts = async (id, value) => {
    if (!subagents) return value;
    const { runningCount, totalCount } = await subagents.refresh(id);
    return { ...value, subagentRunningCount: runningCount, subagentTotalCount: totalCount };
  };
  let serial = Promise.resolve();
  let pairSerial = Promise.resolve();
  const exclusive = (work) => {
    const result = serial.then(work);
    serial = result.catch(() => {});
    return result;
  };
  const pairExclusive = (work) => {
    const result = pairSerial.then(work);
    pairSerial = result.catch(() => {});
    void result.then(() => main.scheduleSummary()).catch(() => {});
    return result;
  };
  const safeFile = async (file) => {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure("Voice store file is invalid", "voice_store_corrupt");
    return fs.readFile(file);
  };
  const saveRegistry = async (next) => {
    const temp = `${registryFile}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(next));
      await handle.sync();
      await handle.close();
      await fs.rename(temp, registryFile);
      const directory = await fs.open(root, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.rm(temp, { force: true });
      storeFailure = failure("Voice orchestrator registry could not be synced", "voice_store_unavailable");
      throw storeFailure;
    }
    registry = next;
  };
  const publicList = async () => ({ orchestrators: await Promise.all(registry.orchestrators.map(async (item) =>
    ({ ...item, ttsProvider: item.ttsProvider || defaultTtsProvider, voiceId: item.voiceId || "",
      unreadCount: await (await loadedContext(item.id)).unread(),
      ...(item.id === "main" && learning ? { learningUnreadCount: learning.unreadCount() } : {}) }))),
  selectedId: registry.selectedId });

  async function allEventPairs(mainPairs) {
    const all = [...mainPairs];
    const recoveryThrough = memoryStore?.lastPairSeq;
    const learningPairs = [];
    const retainedOwners = new Map();
    const mainActive = JSON.parse(await safeFile(path.join(root, "active.json")));
    const mainEvents = readVoiceEventState(await safeFile(path.join(root, mainActive.logicalConversationId, "events.jsonl")),
      mainActive.prunedThroughPairSeq || 0);
    rememberOperations(retainedOwners, mainEvents.operationIds, "main");
    learningPairs.push(...mainEvents.completedPairs.map((pair) => ({ ...pair, orchestratorId: "main",
      logicalConversationId: mainActive.logicalConversationId })));
    for (const { id } of registry?.orchestrators || []) {
      if (id === "main") continue;
      const directory = path.join(orchestratorRoot, id);
      const active = JSON.parse(await safeFile(path.join(directory, "active.json")));
      if (!UUID.test(active.logicalConversationId)) throw failure("Orchestrator conversation is invalid", "voice_store_corrupt");
      const buffer = await safeFile(path.join(directory, active.logicalConversationId, "events.jsonl"));
      const child = readVoiceEventState(buffer, active.prunedThroughPairSeq || 0);
      rememberOperations(retainedOwners, child.operationIds, id);
      all.push(...child.pairs);
      learningPairs.push(...child.completedPairs.map((pair) => ({ ...pair, orchestratorId: id,
        logicalConversationId: active.logicalConversationId })));
    }
    all.sort((a, b) => a.pairSeq - b.pairSeq);
    if (all.some((pair, index) => index && pair.pairSeq === all[index - 1].pairSeq)) {
      throw failure("Voice memory pair sequence is duplicated", "voice_store_corrupt");
    }
    for (const reservation of reservations) {
      const [owner, operationId] = reservation.split(":");
      rememberOperations(retainedOwners, [operationId], owner);
    }
    operationOwners.clear();
    for (const [operationId, owner] of retainedOwners) operationOwners.set(operationId, owner);
    recoveredLearningPairs = learningPairs;
    if (learning) await learning.observe(learningPairs.map((pair) => ({ ...pair,
      memoryConversationId: memoryStore.conversationId })), recoveryThrough).catch(() => {});
    return all;
  }

  function rememberOperations(owners, operationIds, id) {
    for (const operationId of operationIds) {
      if (owners.has(operationId) && owners.get(operationId) !== id) {
        throw failure("Voice operation ID is duplicated across orchestrators", "voice_store_corrupt");
      }
      owners.set(operationId, id);
    }
  }

  async function load() {
    if (storeFailure) throw storeFailure;
    if (registry) {
      await subagents?.retain(new Set(registry.orchestrators.map((item) => item.id)));
      return;
    }
    const old = await safeFile(registryFile).then((buffer) => JSON.parse(buffer.toString("utf8")), (error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (old && (!Array.isArray(old.orchestrators) || old.orchestrators[0]?.id !== "main"
      || !old.orchestrators.every(({ id, name, icon, ttsProvider, voiceId }) => (id === "main" || UUID.test(id))
        && typeof name === "string" && name.trim() && typeof icon === "string"
        && (ttsProvider === undefined || TTS_PROVIDERS.has(ttsProvider))
        && (voiceId === undefined || typeof voiceId === "string" && voiceId.length <= 200))
      || new Set(old.orchestrators.map(({ id }) => id)).size !== old.orchestrators.length
      || !old.orchestrators.some(({ id }) => id === old.selectedId)
      || !UUID.test(old.memoryConversationId))) throw failure("Voice orchestrator registry is invalid", "voice_store_corrupt");
    let recoveredMemoryConversationId = "";
    if (!old) {
      const orphaned = await fs.readdir(orchestratorRoot).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      if (orphaned.some((entry) => entry !== ".DS_Store")) {
        throw failure("Voice orchestrator registry is missing", "voice_store_corrupt");
      }
      const previous = await fs.readFile(path.join(root, "active.json"), "utf8")
        .then(JSON.parse, (error) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (previous && UUID.test(previous.logicalConversationId)) {
        const workspace = path.join(path.dirname(root), "workspaces",
          previous.workspaceConversationId || previous.logicalConversationId, "voice-memory");
        const pointer = await fs.readFile(path.join(workspace, "index.md"), "utf8")
          .catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
        const generation = pointer.match(/^<!-- voice-memory:v1 generation=([0-9a-f-]{36})/i)?.[1];
        if (generation) {
          const state = JSON.parse(await safeFile(path.join(workspace, "generations", generation, "state.json")));
          if (!UUID.test(state.conversationId)) throw failure("Voice memory conversation is invalid", "voice_store_corrupt");
          recoveredMemoryConversationId = state.conversationId;
        }
      }
    }
    registry = old || { orchestrators: [{ id: "main", name: "メイン", icon: "" }],
      selectedId: "main", memoryConversationId: recoveredMemoryConversationId };
    main = createVoiceContextService({ rootDir: root, createClient,
      getOrchestratorName: () => registry.orchestrators.find((item) => item.id === "main")?.name,
      taskChecklistPath: "task-checklists/main.md",
      onChecklistChanged: (conversationId) => onChecklistChanged?.({ orchestratorId: "main", logicalConversationId: conversationId }),
      memoryConversationId: registry.memoryConversationId || undefined,
      memoryEventPairs: allEventPairs, pairExclusive, managedSessions: managedSessions("main"),
      onDurablePair: observePair("main"), learningContext: learningContext("main"),
      hasOutstandingActivity: hasOutstandingActivity("main") });
    try {
      const opened = await main.open();
      memoryStore = await main.getMemoryStore();
      workspaceDirectory = await main.getWorkspaceDirectory();
      contexts.set("main", main);
      try {
        const learningDirectory = path.join(workspaceDirectory, "orchestrator-learning");
        await fs.mkdir(learningDirectory, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
        const stat = await fs.lstat(learningDirectory);
        if (!stat.isDirectory() || stat.isSymbolicLink()
          || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw failure("Unsafe learning directory");
        learningLedger = createOrchestratorLearningUsage({ directory: path.join(learningDirectory, "usage") });
        const recovered = await learningLedger.recover();
        if (!recovered.ok) throw failure("Learning usage storage is unavailable", "learning_store_unavailable");
        learning = await openOrchestratorLearning({ workspace: workspaceDirectory,
          memoryConversationId: memoryStore.conversationId, initialThrough: memoryStore.lastPairSeq,
          analyze: (args) => main.analyzeLearning(args), ledger: learningLedger,
          isBusy: () => reservations.size > 0, onUnreadChanged: onLearningUnreadChanged });
        await learning.observe(recoveredLearningPairs.map((pair) => ({ ...pair,
          memoryConversationId: memoryStore.conversationId })), memoryStore.lastPairSeq).catch(() => {});
      } catch (error) {
        learningError = { code: "learning_store_unavailable", message: "Learning storage is unavailable; normal conversation is unaffected." };
      }
      if (!old) await saveRegistry({ ...registry, memoryConversationId: memoryStore.conversationId });
      if (!registry.memoryConversationId || !UUID.test(opened.logicalConversationId)) {
        throw failure("Voice orchestrator registry is invalid", "voice_store_corrupt");
      }
      await subagents?.retain(new Set(registry.orchestrators.map((item) => item.id)));
    } catch (error) {
      registry = undefined;
      main = undefined;
      throw error;
    }
  }

  async function loadedContext(id) {
    if (!registry.orchestrators.some((item) => item.id === id)) throw failure("Orchestrator was not found", "not_found");
    if (contexts.has(id)) return contexts.get(id);
    const service = createVoiceContextService({ rootDir: path.join(orchestratorRoot, id), createClient,
      getOrchestratorName: () => registry.orchestrators.find((item) => item.id === id)?.name,
      taskChecklistPath: `task-checklists/${id}.md`,
      onChecklistChanged: (conversationId) => onChecklistChanged?.({ orchestratorId: id, logicalConversationId: conversationId }),
      sharedWorkspaceDirectory: workspaceDirectory, sharedMemoryStore: memoryStore, pairExclusive,
      onDurablePair: observePair(id), learningContext: learningContext(id),
      managedSessions: managedSessions(id), hasOutstandingActivity: hasOutstandingActivity(id) });
    contexts.set(id, service);
    try { await service.open(); }
    catch (error) { contexts.delete(id); throw error; }
    return service;
  }

  async function context(id) {
    await exclusive(load);
    return loadedContext(id);
  }

  function idOf(id) {
    if (id !== "main" && !UUID.test(id)) throw failure("Orchestrator ID is invalid");
    return id;
  }

  return {
    async list() { return exclusive(async () => { await load(); return publicList(); }); },
    async unreadCount() { const { orchestrators } = await this.list();
      return orchestrators.reduce((sum, item) => sum + item.unreadCount, 0); },
    async unreadState(id) { return (await context(idOf(id))).unread(); },
    async replyUnread(id, conversationId, completedOrdinal) {
      return (await context(idOf(id))).replyUnread(conversationId, completedOrdinal);
    },
    async markRead(id, conversationId, completedOrdinal) {
      return (await context(idOf(id))).markRead(conversationId, completedOrdinal);
    },
    async select(id) {
      idOf(id);
      return exclusive(async () => {
        await load();
        await loadedContext(id);
        await saveRegistry({ ...registry, selectedId: id });
        return publicList();
      });
    },
    async create(name, icon = "", model, effort, systemInstruction, topicModel, topicEffort,
      ttsProvider = defaultTtsProvider, voiceId = "", overviewModel, overviewEffort) {
      const item = { id: randomUUID(), name: validateName(name), icon: validateIcon(icon),
        ...validateTtsVoice(ttsProvider, voiceId) };
      return exclusive(async () => {
        await load();
        await fs.mkdir(orchestratorRoot, { recursive: true, mode: 0o700 });
        const service = createVoiceContextService({ rootDir: path.join(orchestratorRoot, item.id), createClient,
          getOrchestratorName: () => registry.orchestrators.find((entry) => entry.id === item.id)?.name,
          taskChecklistPath: `task-checklists/${item.id}.md`,
          onChecklistChanged: (conversationId) => onChecklistChanged?.({ orchestratorId: item.id, logicalConversationId: conversationId }),
          sharedWorkspaceDirectory: workspaceDirectory, sharedMemoryStore: memoryStore, pairExclusive,
          onDurablePair: observePair(item.id),
          managedSessions: managedSessions(item.id), hasOutstandingActivity: hasOutstandingActivity(item.id) });
        await service.open();
        if (model !== undefined || effort !== undefined || systemInstruction !== undefined
          || topicModel !== undefined || topicEffort !== undefined
          || overviewModel !== undefined || overviewEffort !== undefined) {
          const defaults = await service.getSettings();
          await service.configure(model ?? defaults.model, effort ?? defaults.effort,
            systemInstruction ?? defaults.systemInstruction,
            topicModel ?? defaults.topicModel, topicEffort ?? defaults.topicEffort, overviewModel, overviewEffort);
        }
        await saveRegistry({ ...registry, orchestrators: [...registry.orchestrators, item] });
        contexts.set(item.id, service);
        return { ...item, ...await publicList() };
      });
    },
    async update(id, changes) {
      idOf(id);
      const name = validateName(changes?.name);
      const icon = validateIcon(changes?.icon);
      return exclusive(async () => {
        await load();
        const orchestrators = registry.orchestrators.map((item) => item.id === id
          ? { ...item, name, icon, ...validateTtsVoice(changes.ttsProvider ?? item.ttsProvider ?? defaultTtsProvider,
            changes.voiceId ?? (changes.ttsProvider && changes.ttsProvider !== item.ttsProvider ? "" : item.voiceId ?? "")) } : item);
        const service = await loadedContext(id);
        const nameChanged = name !== registry.orchestrators.find((item) => item.id === id).name;
        if (nameChanged || changes.model !== undefined || changes.effort !== undefined || changes.systemInstruction !== undefined
          || changes.topicModel !== undefined || changes.topicEffort !== undefined
          || changes.overviewModel !== undefined || changes.overviewEffort !== undefined) {
          const current = await service.getSettings();
          await service.configure(changes.model ?? current.model, changes.effort ?? current.effort,
            changes.systemInstruction ?? current.systemInstruction,
            changes.topicModel ?? current.topicModel, changes.topicEffort ?? current.topicEffort,
            changes.overviewModel, changes.overviewEffort, nameChanged);
        }
        await saveRegistry({ ...registry, orchestrators });
        return { ...orchestrators.find((item) => item.id === id), ...await publicList() };
      });
    },
    async remove(id) {
      idOf(id);
      if (id === "main") throw failure("Main orchestrator cannot be deleted");
      return exclusive(async () => {
        await load();
        const service = await loadedContext(id);
        if (await service.isBusy()) throw failure("Orchestrator is busy", "session_busy");
        const next = { ...registry, selectedId: registry.selectedId === id ? "main" : registry.selectedId,
          orchestrators: registry.orchestrators.filter((item) => item.id !== id) };
        await saveRegistry(next);
        contexts.delete(id);
        await learning?.removeOrchestrator(id).catch(() => {});
        await fs.rm(path.join(orchestratorRoot, id), { recursive: true });
        await subagents?.retain(new Set(next.orchestrators.map((item) => item.id)));
        return publicList();
      });
    },
    async learningStatus() {
      await exclusive(load);
      if (!learning) return { mode: "observation", enabled: false, status: "paused", settings: { model: "", effort: "", settingsRevision: 1 },
        error: learningError, candidates: [], gaps: [], pendingCount: 0, observedThrough: 0, processedThrough: 0, usage: null };
      return learning.status();
    },
    async configureLearning(settings) {
      await exclusive(load);
      if (!learning) throw failure("Learning storage is unavailable", "learning_store_unavailable");
      const models = settings.model === "" && settings.effort === "" ? [] : (await main.getSettings()).models;
      await learning.configure(settings, models);
      return learning.status();
    },
    async manageLearning(operation, payload) {
      await exclusive(load);
      if (!learning) throw failure("Learning storage is unavailable", "learning_store_unavailable");
      const methods = { read: "markRead", decide: "decide", change: "requestChange", correct: "correctEvaluation", cancel: "cancelEvaluationCorrections", forget: "forget", proposal: "proposalDecision", retry: "retry" };
      if (!methods[operation]) throw failure("Unknown learning operation", "learning_request_invalid");
      await learning[methods[operation]](payload);
      return learning.status();
    },
    async learningDelivery({ orchestratorId, operationId }) {
      await exclusive(load);
      idOf(orchestratorId);
      return { delivery: await learning?.delivery({ orchestratorId, operationId }) || null };
    },
    async learningUsage(options) {
      await exclusive(load);
      if (!learningLedger) throw failure("Learning usage storage is unavailable", "learning_store_unavailable");
      return learningLedger.history(options);
    },
    async configureLearningPrice(snapshot) {
      await exclusive(load);
      if (!learningLedger) throw failure("Learning usage storage is unavailable", "learning_store_unavailable");
      return learningLedger.configurePrice(snapshot);
    },
    async getSettings(id) {
      const service = await context(idOf(id));
      const item = registry.orchestrators.find((entry) => entry.id === id);
      return { ...await service.getSettings(), ...item, ttsProvider: item.ttsProvider || defaultTtsProvider,
        voiceId: item.voiceId || "", orchestratorId: id };
    },
    async configure(id, model, effort, systemInstruction, topicModel, topicEffort, overviewModel, overviewEffort) {
      return exclusive(async () => {
        await load();
        return (await loadedContext(idOf(id))).configure(model, effort, systemInstruction, topicModel, topicEffort,
          overviewModel, overviewEffort);
      });
    },
    async clearMemory() { return exclusive(async () => {
      await load();
      for (const { id } of registry.orchestrators) {
        if (await (await loadedContext(id)).isBusy()) throw failure("Voice conversation is busy", "session_busy");
      }
      const result = await main.clearMemory();
      for (const [id, service] of contexts) {
        if (id !== "main") await service.clearMemory({ clearStore: false });
      }
      return result;
    }); },
    async clearMessages(id) { return exclusive(async () => {
      await load();
      const result = await (await loadedContext(idOf(id))).clearMessages();
      return result;
    }); },
    async taskOverview() { return (await context("main")).taskOverview(); },
    async history(id) { return (await context(idOf(id))).history(); },
    async respondToChecklistCompletion(id, sourceHash, version, decision) {
      return (await context(idOf(id))).respondToChecklistCompletion(sourceHash, version, decision);
    },
    async isBusy(id) { return (await context(idOf(id))).isBusy(); },
    async open(id) { return withCounts(id, await (await context(idOf(id))).open()); },
    async status(id, conversationId, operationId) {
      return withCounts(id, await (await context(idOf(id))).status(conversationId, operationId));
    },
    async interrupt(id, conversationId, operationId) {
      return (await context(idOf(id))).interrupt(conversationId, operationId);
    },
    async respondToResetConfirmation(id, payload) {
      return (await context(idOf(id))).respondToResetConfirmation(payload);
    },
    async start(message, notify, onApproval, hooks) {
      const id = idOf(message.payload?.orchestratorId);
      return exclusive(async () => {
        await load();
        const service = await loadedContext(id);
        const orchestrator = registry.orchestrators.find((item) => item.id === id);
        const operationId = message.payload?.clientOperationId;
        const reservation = `${id}:${operationId}`;
        // A completion must finish its durable observation before a recovery scan advances the high water.
        await pairExclusive(() => allEventPairs([]));
        if (operationOwners.has(operationId) && operationOwners.get(operationId) !== id) {
          throw failure("Voice operation ID belongs to another orchestrator", "operation_conflict");
        }
        if (memoryStore.remainingCapacity <= reservations.size && !reservations.has(reservation)) {
          try { await service.status(message.payload?.logicalConversationId, operationId); }
          catch { throw failure("Voice memory is awaiting a successful update", "voice_memory_full"); }
        }
        const { orchestratorId, ...payload } = message.payload;
        return withCounts(id, await service.start({ ...message, payload }, (result) => {
          reservations.delete(reservation);
          const settled = { ...result, orchestratorId: id };
          void withCounts(id, settled).catch(() => settled).then(notify)
            .catch(() => console.warn("[voice] client completion delivery failed"));
          if (result.status === "completed" && onCompleted) {
            const name = registry.orchestrators.find((item) => item.id === id)?.name;
            void Promise.resolve().then(() => onCompleted(settled, name))
              .catch(() => console.warn("[voice] completion observer failed"));
          }
        }, onApproval, { ...hooks, onAccepted: () => {
          operationOwners.set(operationId, id);
          reservations.add(reservation);
          hooks?.onAccepted?.({ ttsProvider: orchestrator.ttsProvider || defaultTtsProvider,
            voiceId: orchestrator.voiceId || "" });
        }, onNativeRoot: ({ threadId, client }) => activity?.registerRoot({ threadId, client, orchestratorId: id }), onSettled: () => {
          reservations.delete(reservation);
          hooks?.onSettled?.();
        } }));
      });
    },
  };
}
