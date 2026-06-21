import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

export function createLlmAcpSessionStore(deps = {}) {
  const {
    acpSessionStorePath,
    compareSessionHistoryEntries,
    generateLlmExecutionSessionId,
    makeApiError,
    normalizeLlmExecutionSessionId,
    normalizeSessionRootRelativePath,
    normalizeSessionUpdatedAt,
    sessionRootBindingEnabled,
    workspaceRoot,
  } = deps;

  let acpSessionStoreLoadPromise = null;
  let acpSessionStoreWriteQueue = Promise.resolve();
  const acpSessionRootBySessionId = new Map();
  const acpSessionUpdatedAtBySessionId = new Map();
  const acpSessionLastReadAtBySessionId = new Map();
  const acpLatestSessionByRootRelativePath = new Map();

  async function resolveDirectoryIdentity(rawDirectory) {
    const normalized = normalizeSessionRootRelativePath(rawDirectory);
    const absolute = path.isAbsolute(normalized)
      ? path.resolve(normalized)
      : path.resolve(workspaceRoot, normalized);
    try {
      return await fs.realpath(absolute);
    } catch {
      return absolute;
    }
  }

  function rebuildAcpLatestSessionByRootRelativePath() {
    acpLatestSessionByRootRelativePath.clear();
    for (const [sessionId, rootRelativePath] of acpSessionRootBySessionId.entries()) {
      const updatedAt = normalizeSessionUpdatedAt(acpSessionUpdatedAtBySessionId.get(sessionId));
      const existingSessionId = acpLatestSessionByRootRelativePath.get(rootRelativePath);
      if (!existingSessionId) {
        acpLatestSessionByRootRelativePath.set(rootRelativePath, sessionId);
        continue;
      }
      const existingUpdatedAt = normalizeSessionUpdatedAt(acpSessionUpdatedAtBySessionId.get(existingSessionId));
      const shouldReplace =
        (updatedAt && !existingUpdatedAt) ||
        (updatedAt && existingUpdatedAt && updatedAt > existingUpdatedAt) ||
        (updatedAt === existingUpdatedAt && sessionId.localeCompare(existingSessionId) > 0);
      if (shouldReplace) {
        acpLatestSessionByRootRelativePath.set(rootRelativePath, sessionId);
      }
    }
  }

  function buildAcpSessionStorePayload() {
    const sessions = {};
    const orderedEntries = Array.from(acpSessionRootBySessionId.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [sessionId, rootRelativePath] of orderedEntries) {
      const updatedAt = normalizeSessionUpdatedAt(acpSessionUpdatedAtBySessionId.get(sessionId)) || new Date(0).toISOString();
      const lastReadAt = normalizeSessionUpdatedAt(acpSessionLastReadAtBySessionId.get(sessionId));
      sessions[sessionId] = {
        directory: rootRelativePath,
        rootRelativePath,
        updatedAt,
        lastReadAt: lastReadAt || "",
      };
    }
    const latestByDirectory = {};
    const latestEntries = Array.from(acpLatestSessionByRootRelativePath.entries())
      .sort((a, b) => a[0].localeCompare(b[0]));
    for (const [directory, sessionId] of latestEntries) {
      latestByDirectory[directory] = sessionId;
    }
    return {
      version: 3,
      updatedAt: new Date().toISOString(),
      sessions,
      latestByDirectory,
    };
  }

  async function loadAcpSessionStore() {
    if (!sessionRootBindingEnabled) return;
    let parsed = {};
    try {
      const raw = await fs.readFile(acpSessionStorePath, "utf8");
      parsed = raw ? JSON.parse(raw) : {};
    } catch (err) {
      if (!err || typeof err !== "object" || err.code !== "ENOENT") {
        throw err;
      }
    }
    acpSessionRootBySessionId.clear();
    acpSessionUpdatedAtBySessionId.clear();
    acpSessionLastReadAtBySessionId.clear();
    acpLatestSessionByRootRelativePath.clear();
    const sessions = parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object"
      ? parsed.sessions
      : {};
    const fallbackUpdatedAt = new Date().toISOString();
    for (const [rawSessionId, value] of Object.entries(sessions)) {
      let sessionId = "";
      try {
        sessionId = normalizeLlmExecutionSessionId(rawSessionId);
      } catch {
        continue;
      }
      if (!sessionId) continue;
      const rootRelativePath = normalizeSessionRootRelativePath(value?.rootRelativePath || value?.directory);
      const updatedAt = normalizeSessionUpdatedAt(value?.updatedAt) || fallbackUpdatedAt;
      const lastReadAt = normalizeSessionUpdatedAt(value?.lastReadAt);
      acpSessionRootBySessionId.set(sessionId, rootRelativePath);
      acpSessionUpdatedAtBySessionId.set(sessionId, updatedAt);
      if (lastReadAt) {
        acpSessionLastReadAtBySessionId.set(sessionId, lastReadAt);
      }
    }
    rebuildAcpLatestSessionByRootRelativePath();
  }

  async function ensureAcpSessionStoreLoaded() {
    if (!sessionRootBindingEnabled) return;
    if (!acpSessionStoreLoadPromise) {
      acpSessionStoreLoadPromise = loadAcpSessionStore().catch((err) => {
        acpSessionStoreLoadPromise = null;
        throw err;
      });
    }
    await acpSessionStoreLoadPromise;
  }

  async function persistAcpSessionStore() {
    if (!sessionRootBindingEnabled) return;
    const parentDir = path.dirname(acpSessionStorePath);
    await fs.mkdir(parentDir, { recursive: true });
    const payload = buildAcpSessionStorePayload();
    const tmpPath = acpSessionStorePath + "." + randomUUID() + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    await fs.rename(tmpPath, acpSessionStorePath);
  }

  async function resolveSessionIdForRootDir(requestedSessionId, rootRelativePath) {
    const normalizedRequestedSessionId = normalizeLlmExecutionSessionId(requestedSessionId);
    if (normalizedRequestedSessionId) {
      return normalizedRequestedSessionId;
    }
    if (!sessionRootBindingEnabled) {
      return generateLlmExecutionSessionId();
    }
    const normalizedRootRelativePath = await resolveDirectoryIdentity(rootRelativePath);
    await ensureAcpSessionStoreLoaded();
    const reusedSessionId = acpLatestSessionByRootRelativePath.get(normalizedRootRelativePath);
    if (reusedSessionId) {
      return reusedSessionId;
    }
    return generateLlmExecutionSessionId();
  }

  async function bindSessionToRootDir(sessionId, rootRelativePath) {
    if (!sessionRootBindingEnabled) return;
    const normalizedSessionId = normalizeLlmExecutionSessionId(sessionId);
    if (!normalizedSessionId) return;
    const normalizedRootRelativePath = await resolveDirectoryIdentity(rootRelativePath);

    await ensureAcpSessionStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const nowIso = new Date().toISOString();
      const existingRoot = acpSessionRootBySessionId.get(normalizedSessionId);
      if (existingRoot && existingRoot !== normalizedRootRelativePath) {
        throw makeApiError(
          409,
          "session_root_mismatch",
          "sessionId is already bound to another rootDir",
          {
            sessionId: normalizedSessionId,
            expectedRootRelativePath: existingRoot,
            requestedRootRelativePath: normalizedRootRelativePath,
          }
        );
      }
      let changed = false;
      if (!existingRoot) {
        acpSessionRootBySessionId.set(normalizedSessionId, normalizedRootRelativePath);
        changed = true;
      }
      const previousUpdatedAt = normalizeSessionUpdatedAt(acpSessionUpdatedAtBySessionId.get(normalizedSessionId));
      if (previousUpdatedAt !== nowIso) {
        acpSessionUpdatedAtBySessionId.set(normalizedSessionId, nowIso);
        changed = true;
      }
      const latestSessionId = acpLatestSessionByRootRelativePath.get(normalizedRootRelativePath);
      if (latestSessionId !== normalizedSessionId) {
        acpLatestSessionByRootRelativePath.set(normalizedRootRelativePath, normalizedSessionId);
        changed = true;
      }
      if (!acpSessionLastReadAtBySessionId.has(normalizedSessionId)) {
        acpSessionLastReadAtBySessionId.set(normalizedSessionId, nowIso);
        changed = true;
      }
      if (changed) {
        await persistAcpSessionStore();
      }
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    await op;
  }

  async function listAcpSessionsForDirectory(requestedDirectory) {
    await ensureAcpSessionStoreLoaded();
    const sessions = [];
    const requestedRoot = await resolveDirectoryIdentity(requestedDirectory);
    for (const [sessionId, directory] of acpSessionRootBySessionId.entries()) {
      if (!path.isAbsolute(directory) || path.resolve(directory) !== requestedRoot) continue;
      const updatedAt = normalizeSessionUpdatedAt(acpSessionUpdatedAtBySessionId.get(sessionId)) || new Date(0).toISOString();
      const lastReadAt = normalizeSessionUpdatedAt(acpSessionLastReadAtBySessionId.get(sessionId));
      sessions.push({
        sessionId,
        directory: requestedRoot,
        cwd: requestedRoot,
        updatedAt,
        lastReadAt: lastReadAt || "",
        source: "acp",
      });
    }
    sessions.sort(compareSessionHistoryEntries);
    return sessions;
  }

  async function migrateAcpSessionDirectoryIdentity(sourceDirectory, targetDirectory) {
    const source = normalizeSessionRootRelativePath(sourceDirectory);
    const target = await resolveDirectoryIdentity(targetDirectory);
    if (path.isAbsolute(source)) return { migratedSessions: 0 };
    await ensureAcpSessionStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      let migratedSessions = 0;
      for (const [sessionId, directory] of acpSessionRootBySessionId.entries()) {
        if (directory !== source) continue;
        acpSessionRootBySessionId.set(sessionId, target);
        migratedSessions += 1;
      }
      if (migratedSessions > 0) {
        rebuildAcpLatestSessionByRootRelativePath();
        await persistAcpSessionStore();
      }
      return { migratedSessions };
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  async function markAcpSessionRead(sessionId, lastReadAt) {
    const startedAtMs = Date.now();
    let updated = false;
    await ensureAcpSessionStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      if (!acpSessionRootBySessionId.has(sessionId)) return;
      const previous = normalizeSessionUpdatedAt(acpSessionLastReadAtBySessionId.get(sessionId));
      if (previous === lastReadAt) return;
      acpSessionLastReadAtBySessionId.set(sessionId, lastReadAt);
      updated = true;
      await persistAcpSessionStore();
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    await op;
    return {
      updated,
      elapsedMs: Math.max(0, Date.now() - startedAtMs),
    };
  }

  async function getAcpSessionStoreStats() {
    await ensureAcpSessionStoreLoaded();
    return {
      directories: acpLatestSessionByRootRelativePath.size,
      sessions: acpSessionRootBySessionId.size,
    };
  }

  return {
    bindSessionToRootDir,
    getAcpSessionStoreStats,
    listAcpSessionsForDirectory,
    markAcpSessionRead,
    migrateAcpSessionDirectoryIdentity,
    resolveSessionIdForRootDir,
  };
}
