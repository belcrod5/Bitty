import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

const COLORS = new Set(["gray", "red", "yellow", "green", "black"]);
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
      state = parsed;
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
      case "migrate": {
        if (!Array.isArray(operation.directories) || !Array.isArray(operation.composerHistory)
          || typeof operation.sessions !== "object" || operation.sessions === null
          || typeof operation.drafts !== "object" || operation.drafts === null) throw new Error("invalid migration");
        let changed = false;
        let complete = true;
        for (const raw of operation.directories) {
          const next = directory(raw);
          const existing = state.directories.find((item) => item.path === next.path || item.id === next.id);
          if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(next)) complete = false;
          } else if (state.directories.length < 100) {
            state.directories.push(next);
            changed = true;
          } else complete = false;
        }
        for (const [key, value] of Object.entries(operation.sessions)) {
          const pair = JSON.parse(key);
          if (!Array.isArray(pair) || pair.length !== 2) throw new Error("invalid session key");
          const backendId = requiredString(pair[0], "backendId", 100);
          const sessionId = requiredString(pair[1], "sessionId", 200);
          const title = String(value?.title || "").replace(/\s+/gu, " ").trim().slice(0, 200);
          const markerColor = COLORS.has(value?.markerColor) ? value.markerColor : "none";
          if (!title && markerColor === "none") continue;
          const storedKey = sessionKey(backendId, sessionId);
          const existing = state.sessions[storedKey] || { title: "", markerColor: "none" };
          const next = { ...existing };
          if (title) {
            if (!existing.title) next.title = title;
            else if (existing.title !== title) complete = false;
          }
          if (markerColor !== "none") {
            if (existing.markerColor === "none") next.markerColor = markerColor;
            else if (existing.markerColor !== markerColor) complete = false;
          }
          if (JSON.stringify(next) !== JSON.stringify(existing)) {
            state.sessions[storedKey] = next;
            changed = true;
          }
        }
        const existingHistoryCount = new Map();
        for (const text of state.composerHistory) existingHistoryCount.set(text, (existingHistoryCount.get(text) || 0) + 1);
        for (const text of operation.composerHistory.filter((item) => typeof item === "string" && item.trim())) {
          const existingCount = existingHistoryCount.get(text) || 0;
          if (existingCount > 0) {
            existingHistoryCount.set(text, existingCount - 1);
            continue;
          }
          if (state.composerHistory.length < 40) {
            state.composerHistory.push(text);
            changed = true;
          } else complete = false;
        }
        for (const [key, value] of Object.entries(operation.drafts)) {
          const pair = JSON.parse(key);
          if (!Array.isArray(pair) || pair.length !== 2) throw new Error("invalid draft key");
          const text = String(value?.text || "");
          if (!text.trim()) continue;
          const storedKey = sessionKey(requiredString(pair[0], "backendId", 100), requiredString(pair[1], "sessionId", 200));
          if (state.drafts[storedKey]) {
            if (state.drafts[storedKey].text !== text) complete = false;
          } else if (Object.keys(state.drafts).length < 10) {
            state.drafts[storedKey] = { text, updatedAt: Date.now() };
            changed = true;
          } else complete = false;
        }
        return { changed, complete };
      }
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
        if (Object.hasOwn(operation, "title")) next.title = String(operation.title || "").replace(/\s+/gu, " ").trim().slice(0, 200);
        if (Object.hasOwn(operation, "markerColor")) {
          if (operation.markerColor !== "none" && !COLORS.has(operation.markerColor)) throw new Error("invalid markerColor");
          next.markerColor = operation.markerColor;
        }
        state.sessions[key] = next;
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

  async function mutate(operation) {
    return serialize(async () => {
      const before = snapshot();
      try {
        const outcome = apply(operation);
        const changed = typeof outcome === "boolean" ? outcome : outcome.changed;
        const migration = operation?.type === "migrate"
          ? { migrationApplied: changed, migrationComplete: outcome.complete }
          : {};
        if (!changed) return { ...snapshot(), ...migration };
        state.revision += 1;
        await fs.mkdir(path.dirname(storePath), { recursive: true });
        const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
        await fs.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporaryPath, storePath);
        return { ...snapshot(), ...migration };
      } catch (error) {
        state = before;
        throw error;
      }
    });
  }

  return { snapshot: () => serialize(snapshot), mutate };
}
