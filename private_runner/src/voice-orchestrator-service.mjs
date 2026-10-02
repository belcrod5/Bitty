import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createVoiceContextService, readVoiceEventState } from "./voice-context-service.mjs";
import { createVoiceSubagentService } from "./voice-subagents.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ICON_BYTES = 1024 * 1024;
const iconPattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const failure = (message, code = "turn_rejected") => Object.assign(new Error(message), { code });

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

export function createVoiceOrchestratorService({ rootDir, createClient, getAgentService, subjectId, onCompleted }) {
  const root = path.resolve(rootDir);
  const registryFile = path.join(root, "orchestrators.json");
  const orchestratorRoot = path.join(root, "orchestrators");
  let registry;
  let main;
  let memoryStore;
  let workspaceDirectory;
  let storeFailure;
  const contexts = new Map();
  const reservations = new Set();
  const operationOwners = new Map();
  const subagents = getAgentService ? createVoiceSubagentService({ rootDir: root, getAgentService, subjectId }) : null;
  const managedSessions = (id) => subagents ? {
    refresh: () => subagents.refresh(id), contextOf: subagents.contextOf,
    handleTool: (request) => subagents.handleTool(id, request),
  } : undefined;
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
  const publicList = async () => ({ orchestrators: await Promise.all(registry.orchestrators.map(async ({ id, name, icon }) =>
    ({ id, name, icon, unreadCount: await (await loadedContext(id)).unread() }))),
  selectedId: registry.selectedId });

  async function allEventPairs(mainPairs) {
    const all = [...mainPairs];
    const retainedOwners = new Map();
    const mainActive = JSON.parse(await safeFile(path.join(root, "active.json")));
    rememberOperations(retainedOwners, readVoiceEventState(await safeFile(path.join(root, mainActive.logicalConversationId, "events.jsonl")),
      mainActive.prunedThroughPairSeq || 0).operationIds, "main");
    for (const { id } of registry?.orchestrators || []) {
      if (id === "main") continue;
      const directory = path.join(orchestratorRoot, id);
      const active = JSON.parse(await safeFile(path.join(directory, "active.json")));
      if (!UUID.test(active.logicalConversationId)) throw failure("Orchestrator conversation is invalid", "voice_store_corrupt");
      const buffer = await safeFile(path.join(directory, active.logicalConversationId, "events.jsonl"));
      const child = readVoiceEventState(buffer, active.prunedThroughPairSeq || 0);
      rememberOperations(retainedOwners, child.operationIds, id);
      all.push(...child.pairs);
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
      || !old.orchestrators.every(({ id, name, icon }) => (id === "main" || UUID.test(id))
        && typeof name === "string" && name.trim() && typeof icon === "string")
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
      memoryConversationId: registry.memoryConversationId || undefined,
      memoryEventPairs: allEventPairs, pairExclusive, managedSessions: managedSessions("main") });
    try {
      const opened = await main.open();
      memoryStore = await main.getMemoryStore();
      workspaceDirectory = await main.getWorkspaceDirectory();
      contexts.set("main", main);
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
      sharedWorkspaceDirectory: workspaceDirectory, sharedMemoryStore: memoryStore, pairExclusive,
      managedSessions: managedSessions(id) });
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
    async create(name, icon = "", model, effort, systemInstruction) {
      const item = { id: randomUUID(), name: validateName(name), icon: validateIcon(icon) };
      return exclusive(async () => {
        await load();
        await fs.mkdir(orchestratorRoot, { recursive: true, mode: 0o700 });
        const service = createVoiceContextService({ rootDir: path.join(orchestratorRoot, item.id), createClient,
          sharedWorkspaceDirectory: workspaceDirectory, sharedMemoryStore: memoryStore, pairExclusive,
          managedSessions: managedSessions(item.id) });
        await service.open();
        if (model !== undefined || effort !== undefined || systemInstruction !== undefined) {
          const defaults = await service.getSettings();
          await service.configure(model ?? defaults.model, effort ?? defaults.effort,
            systemInstruction ?? defaults.systemInstruction);
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
        const service = await loadedContext(id);
        if (changes.model !== undefined || changes.effort !== undefined || changes.systemInstruction !== undefined) {
          const current = await service.getSettings();
          await service.configure(changes.model ?? current.model, changes.effort ?? current.effort,
            changes.systemInstruction ?? current.systemInstruction);
        }
        const orchestrators = registry.orchestrators.map((item) => item.id === id ? { id, name, icon } : item);
        await saveRegistry({ ...registry, orchestrators });
        return { id, name, icon, ...await publicList() };
      });
    },
    async remove(id) {
      idOf(id);
      if (id === "main") throw failure("Main orchestrator cannot be deleted");
      return exclusive(async () => {
        await load();
        const service = await loadedContext(id);
        if (await service.isBusy()) throw failure("Orchestrator is busy", "session_busy");
        if (subagents && (await subagents.refresh(id)).records.some((record) =>
          !["completed", "failed", "interrupted"].includes(record.status))) {
          throw failure("Orchestrator has an outstanding delegated session", "session_busy");
        }
        const next = { ...registry, selectedId: registry.selectedId === id ? "main" : registry.selectedId,
          orchestrators: registry.orchestrators.filter((item) => item.id !== id) };
        await saveRegistry(next);
        contexts.delete(id);
        await fs.rm(path.join(orchestratorRoot, id), { recursive: true });
        await subagents?.retain(new Set(next.orchestrators.map((item) => item.id)));
        return publicList();
      });
    },
    async getSettings(id) {
      const service = await context(idOf(id));
      const item = registry.orchestrators.find((entry) => entry.id === id);
      return { ...await service.getSettings(), ...item, orchestratorId: id };
    },
    async configure(id, model, effort, systemInstruction) {
      return exclusive(async () => {
        await load();
        return (await loadedContext(idOf(id))).configure(model, effort, systemInstruction);
      });
    },
    async clearMemory() { return exclusive(async () => {
      await load();
      for (const service of contexts.values()) if (await service.isBusy()) throw failure("Voice conversation is busy", "session_busy");
      return main.clearMemory();
    }); },
    async clearMessages(id) { return exclusive(async () => {
      await load();
      const result = await (await loadedContext(idOf(id))).clearMessages();
      return result;
    }); },
    async history(id) { return (await context(idOf(id))).history(); },
    async open(id) { return withCounts(id, await (await context(idOf(id))).open()); },
    async status(id, conversationId, operationId) {
      return withCounts(id, await (await context(idOf(id))).status(conversationId, operationId));
    },
    async interrupt(id, conversationId, operationId) {
      return (await context(idOf(id))).interrupt(conversationId, operationId);
    },
    async start(message, notify, onApproval, hooks) {
      const id = idOf(message.payload?.orchestratorId);
      return exclusive(async () => {
        await load();
        const service = await loadedContext(id);
        const operationId = message.payload?.clientOperationId;
        const reservation = `${id}:${operationId}`;
        await allEventPairs([]);
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
          hooks?.onAccepted?.();
        }, onSettled: () => {
          reservations.delete(reservation);
          hooks?.onSettled?.();
        } }));
      });
    },
  };
}
