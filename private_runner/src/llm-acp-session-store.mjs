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
  const fileSystem = deps.fileSystem || fs;

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
      return await fileSystem.realpath(absolute);
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

  function buildAcpSessionStorePayload(lastReadAtBySessionId = acpSessionLastReadAtBySessionId) {
    const sessions = {};
    const orderedEntries = Array.from(acpSessionRootBySessionId.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [sessionId, rootRelativePath] of orderedEntries) {
      const updatedAt = normalizeSessionUpdatedAt(acpSessionUpdatedAtBySessionId.get(sessionId)) || new Date(0).toISOString();
      const lastReadAt = normalizeSessionUpdatedAt(lastReadAtBySessionId.get(sessionId));
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
      const raw = await fileSystem.readFile(acpSessionStorePath, "utf8");
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
      const storedRoot = normalizeSessionRootRelativePath(value?.rootRelativePath || value?.directory);
      const rootRelativePath = path.isAbsolute(storedRoot)
        ? await resolveDirectoryIdentity(storedRoot)
        : storedRoot;
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

  async function persistAcpSessionStore(lastReadAtBySessionId = acpSessionLastReadAtBySessionId) {
    if (!sessionRootBindingEnabled) return;
    const parentDir = path.dirname(acpSessionStorePath);
    await fileSystem.mkdir(parentDir, { recursive: true });
    const payload = buildAcpSessionStorePayload(lastReadAtBySessionId);
    const tmpPath = acpSessionStorePath + "." + randomUUID() + ".tmp";
    await fileSystem.writeFile(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    await fileSystem.rename(tmpPath, acpSessionStorePath);
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

  async function listAcpSessionsForDirectories(requestedDirectories) {
    await ensureAcpSessionStoreLoaded();
    const requestedRoots = await Promise.all(
      (Array.isArray(requestedDirectories) ? requestedDirectories : [])
        .map((directory) => resolveDirectoryIdentity(directory)),
    );
    const rootsBySessionId = new Map(acpSessionRootBySessionId);
    const updatedAtBySessionId = new Map(acpSessionUpdatedAtBySessionId);
    const lastReadAtBySessionId = new Map(acpSessionLastReadAtBySessionId);
    return requestedRoots.map((requestedRoot) => {
      const sessions = [];
      for (const [sessionId, directory] of rootsBySessionId.entries()) {
        if (!path.isAbsolute(directory) || path.resolve(directory) !== requestedRoot) continue;
        const updatedAt = normalizeSessionUpdatedAt(updatedAtBySessionId.get(sessionId)) || new Date(0).toISOString();
        const lastReadAt = normalizeSessionUpdatedAt(lastReadAtBySessionId.get(sessionId));
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
      return { directory: requestedRoot, sessions };
    });
  }

  async function listAcpSessionsForDirectory(requestedDirectory) {
    const [result] = await listAcpSessionsForDirectories([requestedDirectory]);
    return result?.sessions || [];
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

  async function markAcpSessionsRead(sessionIds, lastReadAt) {
    const startedAtMs = Date.now();
    const results = (Array.isArray(sessionIds) ? sessionIds : []).map((sessionId) => ({
      sessionId,
      updated: false,
      entryFound: false,
    }));
    await ensureAcpSessionStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const nextLastReadAtBySessionId = new Map(acpSessionLastReadAtBySessionId);
      let changed = false;
      for (const result of results) {
        if (!acpSessionRootBySessionId.has(result.sessionId)) continue;
        result.entryFound = true;
        const previous = normalizeSessionUpdatedAt(nextLastReadAtBySessionId.get(result.sessionId));
        if (previous === lastReadAt) continue;
        nextLastReadAtBySessionId.set(result.sessionId, lastReadAt);
        result.updated = true;
        changed = true;
      }
      if (!changed) return;
      await persistAcpSessionStore(nextLastReadAtBySessionId);
      acpSessionLastReadAtBySessionId.clear();
      for (const entry of nextLastReadAtBySessionId) acpSessionLastReadAtBySessionId.set(...entry);
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    await op;
    const elapsedMs = Math.max(0, Date.now() - startedAtMs);
    return results.map((result) => ({ ...result, elapsedMs }));
  }

  async function markAcpDirectoryRead(directory, lastReadAt) {
    const startedAtMs = Date.now();
    await ensureAcpSessionStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const nextLastReadAtBySessionId = new Map(acpSessionLastReadAtBySessionId);
      const selectedSessionIds = [];
      const updatedSessionIds = [];
      for (const [sessionId, sessionDirectory] of acpSessionRootBySessionId.entries()) {
        if (!path.isAbsolute(sessionDirectory) || path.resolve(sessionDirectory) !== directory) continue;
        selectedSessionIds.push(sessionId);
        const previous = normalizeSessionUpdatedAt(nextLastReadAtBySessionId.get(sessionId));
        if (previous === lastReadAt) continue;
        nextLastReadAtBySessionId.set(sessionId, lastReadAt);
        updatedSessionIds.push(sessionId);
      }
      if (updatedSessionIds.length > 0) {
        await persistAcpSessionStore(nextLastReadAtBySessionId);
        acpSessionLastReadAtBySessionId.clear();
        for (const entry of nextLastReadAtBySessionId) acpSessionLastReadAtBySessionId.set(...entry);
      }
      return {
        selectedSessionIds,
        updatedSessionIds,
        elapsedMs: Math.max(0, Date.now() - startedAtMs),
      };
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
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
    listAcpSessionsForDirectories,
    listAcpSessionsForDirectory,
    markAcpDirectoryRead,
    markAcpSessionsRead,
    migrateAcpSessionDirectoryIdentity,
    resolveSessionIdForRootDir,
  };
}
