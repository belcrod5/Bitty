import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

const COLORS = new Set(["gray", "red", "yellow", "green", "black"]);
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const DEFAULT_TITLE_MODEL_ID = "gpt-6-luna";
const sessionKey = (backendId, sessionId) => JSON.stringify([backendId, sessionId]);

export class ClientStateStoreUnavailableError extends Error {
  constructor(cause) {
    super(`failed to load client state: ${cause instanceof Error ? cause.message : cause}`);
  }
}

export function createClientStateStore(storePath) {
  let loaded = false;
  let queue = Promise.resolve();
  let state = {
    version: 1,
    revision: 0,
    titleModelId: DEFAULT_TITLE_MODEL_ID,
    titleReasoningEffort: "low",
    directories: [],
    sessions: {},
    composerHistory: [],
    drafts: {},
  };

  async function load() {
    if (loaded) return;
    try {
      const parsed = JSON.parse(await fs.readFile(storePath, "utf8"));
      if (parsed?.version !== 1 || !Number.isSafeInteger(parsed.revision)
        || !Array.isArray(parsed.directories) || !parsed.sessions || !parsed.drafts
        || !Array.isArray(parsed.composerHistory)) throw new Error("invalid client state store");
      delete parsed.migrationConflicts;
      const savedTitleModelId = typeof parsed.titleModelId === "string" ? parsed.titleModelId.trim().slice(0, 200) : "";
      state = {
        ...parsed,
        titleModelId: savedTitleModelId || DEFAULT_TITLE_MODEL_ID,
        titleReasoningEffort: savedTitleModelId && REASONING_EFFORTS.has(parsed.titleReasoningEffort)
          ? parsed.titleReasoningEffort : "low",
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw new ClientStateStoreUnavailableError(error);
    }
    loaded = true;
  }

  function serialize(operation) {
    const result = queue.then(async () => {
      await load();
      return operation();
    });
    queue = result.catch(() => {});
    return result;
  }

  function snapshot() {
    return structuredClone(state);
  }

  function requiredString(value, name, max = 2048) {
    const text = String(value || "").trim();
    if (!text || text.length > max) throw new Error(`${name} is invalid`);
    return text;
  }

  function directory(value) {
    const path = requiredString(value?.path, "path");
    return {
      id: requiredString(value?.id, "id", 200),
      path,
      displayName: requiredString(value?.displayName, "displayName", 200),
      markerColor: COLORS.has(value?.markerColor) ? value.markerColor : "none",
    };
  }

  function apply(operation) {
    switch (operation?.type) {
      case "directory.upsert": {
        const next = directory(operation.directory);
        const index = state.directories.findIndex((item) => item.path === next.path || item.id === next.id);
        state.directories = state.directories.filter((item) => item.path !== next.path && item.id !== next.id);
        state.directories.splice(index < 0 ? state.directories.length : index, 0, next);
        if (state.directories.length > 100) throw new Error("too many directories");
        return true;
      }
      case "directory.remove": {
        const id = requiredString(operation.id, "id", 200);
        state.directories = state.directories.filter((item) => item.id !== id);
        return true;
      }
      case "session.set": {
        const key = sessionKey(requiredString(operation.backendId, "backendId", 100), requiredString(operation.sessionId, "sessionId", 200));
        const previous = state.sessions[key] || { title: "", markerColor: "none" };
        const next = { ...previous };
        if (Object.hasOwn(operation, "title")) {
          next.title = String(operation.title || "").replace(/\s+/gu, " ").trim().slice(0, 200);
          next.titleSource = "manual";
        }
        if (Object.hasOwn(operation, "markerColor")) {
          if (operation.markerColor !== "none" && !COLORS.has(operation.markerColor)) throw new Error("invalid markerColor");
          next.markerColor = operation.markerColor;
        }
        state.sessions[key] = next;
        return true;
      }
      case "title-settings.set": {
        const modelId = requiredString(operation.modelId, "modelId", 200);
        const effort = String(operation.reasoningEffort || "").trim();
        if (!REASONING_EFFORTS.has(effort)) throw new Error("invalid title reasoningEffort");
        state.titleModelId = modelId;
        state.titleReasoningEffort = effort;
        return true;
      }
      case "composer.append": {
        const text = requiredString(operation.text, "text", 100_000);
        state.composerHistory = [text, ...state.composerHistory].slice(0, 40);
        return true;
      }
      case "draft.set": {
        const key = sessionKey(requiredString(operation.backendId, "backendId", 100), requiredString(operation.sessionId, "sessionId", 200));
        const text = String(operation.text ?? "");
        if (text.length > 100_000) throw new Error("draft too long");
        if (text.trim()) state.drafts[key] = { text, updatedAt: Date.now() };
        else delete state.drafts[key];
        const keys = Object.keys(state.drafts).sort((a, b) => state.drafts[b].updatedAt - state.drafts[a].updatedAt);
        for (const oldKey of keys.slice(10)) delete state.drafts[oldKey];
        return true;
      }
      default: throw new Error("invalid operation");
    }
  }

  async function commit(change) {
    const before = snapshot();
    try {
      if (!change()) return false;
      state.revision += 1;
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporaryPath, storePath);
      return true;
    } catch (error) {
      state = before;
      throw error;
    }
  }

  async function mutate(operation) {
    return serialize(async () => {
      await commit(() => apply(operation));
      return snapshot();
    });
  }

  function getSessionTitles(sessionRefs) {
    return serialize(() => sessionRefs.map((ref) => (
      state.sessions[sessionKey(ref.backendId, ref.nativeSessionId)]?.title || ""
    )));
  }

  function getTitleSettings() {
    return serialize(() => ({ modelId: state.titleModelId, reasoningEffort: state.titleReasoningEffort }));
  }

  function setGeneratedTitle(sessionRef, title) {
    return serialize(() => commit(() => {
      const key = sessionKey(sessionRef.backendId, sessionRef.nativeSessionId);
      const previous = state.sessions[key];
      if (previous?.titleSource === "manual" || previous?.title) return false;
      state.sessions[key] = { ...previous, title, markerColor: previous?.markerColor || "none", titleSource: "generated" };
      return true;
    }));
  }

  return {
    snapshot: () => serialize(snapshot),
    mutate,
    getSessionTitles,
    getTitleSettings,
    setGeneratedTitle,
    getRegisteredDirectoryPaths: () => serialize(() => state.directories.map(({ path }) => path)),
  };
}
