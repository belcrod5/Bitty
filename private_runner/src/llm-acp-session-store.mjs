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
  const agentOperations = new Map();
  const agentOperationsClaimedHere = new Set();
  const agentSessionBindings = new Map();
  const agentSessionModes = new Map();
  const agentWorkspaces = new Map();
  // Backendが実行時に学習したモデル事実(context window等)。transcriptには残らない
  // ため、履歴再表示のcontext使用率計算にはこの永続値を使う。
  const agentModelInfo = new Map();
  const agentProcessEpoch = String(deps.agentProcessEpoch || randomUUID()).trim();
  const agentOperationMaxEntries = Math.max(1, Number(deps.agentOperationMaxEntries || 1000));
  const agentOperationTtlMs = Math.max(60_000, Number(deps.agentOperationTtlMs || 24 * 60 * 60 * 1000));
  const agentWorkspaceMaxEntries = Math.max(1, Number(deps.agentWorkspaceMaxEntries || 1000));

  function agentOperationKey(subjectId, clientOperationId) {
    return JSON.stringify([String(subjectId || ""), String(clientOperationId || "")]);
  }

  function agentWorkspaceKey(subjectId, canonicalRoot) {
    return `${subjectId}\u0000${canonicalRoot}`;
  }

  function agentSessionKey(backendId, nativeSessionId) {
    return JSON.stringify([String(backendId || "").trim(), String(nativeSessionId || "").trim()]);
  }

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
      version: 5,
      updatedAt: new Date().toISOString(),
      sessions,
      latestByDirectory,
      agentOperations: Array.from(agentOperations.values())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((entry) => ({ ...entry })),
      agentSessionBindings: Array.from(agentSessionBindings.values())
        .sort((a, b) => agentSessionKey(a.backendId, a.nativeSessionId)
          .localeCompare(agentSessionKey(b.backendId, b.nativeSessionId)))
        .map((entry) => ({ ...entry })),
      agentSessionModes: Array.from(agentSessionModes.values())
        .sort((a, b) => agentSessionKey(a.backendId, a.nativeSessionId)
          .localeCompare(agentSessionKey(b.backendId, b.nativeSessionId)))
        .map((entry) => ({ ...entry, ...(entry.lease ? { lease: { ...entry.lease } } : {}) })),
      agentWorkspaces: Array.from(agentWorkspaces.values())
        .sort((a, b) => agentWorkspaceKey(a.subjectId, a.canonicalRoot).localeCompare(agentWorkspaceKey(b.subjectId, b.canonicalRoot)))
        .map((entry) => ({ ...entry })),
      agentModelInfo: Array.from(agentModelInfo.values())
        .sort((a, b) => agentSessionKey(a.backendId, a.modelId).localeCompare(agentSessionKey(b.backendId, b.modelId)))
        .map((entry) => ({ ...entry })),
    };
  }

  async function loadAcpSessionStore() {
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
    agentOperations.clear();
    agentOperationsClaimedHere.clear();
    agentSessionBindings.clear();
    agentSessionModes.clear();
    agentWorkspaces.clear();
    agentModelInfo.clear();
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
    for (const value of Array.isArray(parsed?.agentOperations) ? parsed.agentOperations : []) {
      const subjectId = String(value?.subjectId || "").trim();
      const clientOperationId = String(value?.clientOperationId || "").trim();
      const requestHash = String(value?.requestHash || "").trim();
      const runId = String(value?.runId || "").trim();
      const status = ["pending", "completed"].includes(value?.status) ? value.status : "";
      const createdAt = normalizeSessionUpdatedAt(value?.createdAt);
      const updatedAt = normalizeSessionUpdatedAt(value?.updatedAt);
      if (!subjectId || !clientOperationId || !requestHash || !runId || !status || !createdAt || !updatedAt) continue;
      agentOperations.set(agentOperationKey(subjectId, clientOperationId), {
        subjectId,
        clientOperationId,
        requestHash,
        runId,
        status,
        createdAt,
        updatedAt,
        ...(status === "completed" && value?.result && typeof value.result === "object"
          ? { result: value.result }
          : {}),
      });
    }
    for (const value of Array.isArray(parsed?.agentSessionBindings) ? parsed.agentSessionBindings : []) {
      const backendId = String(value?.backendId || "").trim();
      const nativeSessionId = String(value?.nativeSessionId || "").trim();
      const canonicalCwd = String(value?.canonicalCwd || "").trim();
      const updatedAt = normalizeSessionUpdatedAt(value?.updatedAt);
      if (!backendId || !nativeSessionId || !path.isAbsolute(canonicalCwd) || !updatedAt) continue;
      const lastReadAt = normalizeSessionUpdatedAt(value?.lastReadAt) || updatedAt;
      const modelId = String(value?.modelId || "").trim();
      const reasoningEffort = String(value?.reasoningEffort || "").trim();
      agentSessionBindings.set(agentSessionKey(backendId, nativeSessionId), {
        backendId,
        nativeSessionId,
        canonicalCwd: path.resolve(canonicalCwd),
        updatedAt,
        lastReadAt,
        ...(modelId ? { modelId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
    }
    for (const value of Array.isArray(parsed?.agentSessionModes) ? parsed.agentSessionModes : []) {
      const backendId = String(value?.backendId || "").trim();
      const nativeSessionId = String(value?.nativeSessionId || "").trim();
      const mode = value?.mode === "neutral" ? "neutral" : value?.mode === "raw" ? "raw" : "";
      const updatedAt = normalizeSessionUpdatedAt(value?.updatedAt);
      if (!backendId || !nativeSessionId || !mode || !updatedAt) continue;
      let lease = null;
      if (value?.lease && typeof value.lease === "object") {
        const owner = String(value.lease.owner || "").trim();
        const runId = String(value.lease.runId || "").trim();
        const processEpoch = String(value.lease.processEpoch || "").trim();
        const generation = Number(value.lease.generation);
        const acquiredAt = normalizeSessionUpdatedAt(value.lease.acquiredAt);
        if (owner && runId && processEpoch && Number.isInteger(generation) && generation > 0 && acquiredAt) {
          lease = {
            owner,
            runId,
            processEpoch,
            generation,
            acquiredAt,
            state: processEpoch === agentProcessEpoch && value.lease.state === "active" ? "active" : "recovering",
            ...(String(value.lease.nativeProcessIdentity || "").trim()
              ? { nativeProcessIdentity: String(value.lease.nativeProcessIdentity).trim() }
              : {}),
          };
        }
      }
      agentSessionModes.set(agentSessionKey(backendId, nativeSessionId), {
        backendId,
        nativeSessionId,
        mode,
        generation: Math.max(0, Number.isInteger(Number(value?.generation)) ? Number(value.generation) : 0),
        lease,
        updatedAt,
      });
    }
    for (const value of Array.isArray(parsed?.agentWorkspaces) ? parsed.agentWorkspaces : []) {
      const canonicalRoot = String(value?.canonicalRoot || "").trim();
      const subjectId = String(value?.subjectId || "").trim();
      const identity = String(value?.identity || "").trim();
      const approvedAt = normalizeSessionUpdatedAt(value?.approvedAt);
      const revokedAt = normalizeSessionUpdatedAt(value?.revokedAt);
      if (!path.isAbsolute(canonicalRoot) || !subjectId || !identity || !approvedAt || revokedAt) continue;
      const resolvedRoot = path.resolve(canonicalRoot);
      agentWorkspaces.set(agentWorkspaceKey(subjectId, resolvedRoot), {
        canonicalRoot: resolvedRoot,
        subjectId,
        identity,
        approvedAt,
        revokedAt: "",
      });
    }
    for (const value of Array.isArray(parsed?.agentModelInfo) ? parsed.agentModelInfo : []) {
      const backendId = String(value?.backendId || "").trim();
      const modelId = String(value?.modelId || "").trim();
      const contextWindowTokens = Math.floor(Number(value?.contextWindowTokens));
      const updatedAt = normalizeSessionUpdatedAt(value?.updatedAt);
      if (!backendId || !modelId || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0 || !updatedAt) continue;
      agentModelInfo.set(agentSessionKey(backendId, modelId), { backendId, modelId, contextWindowTokens, updatedAt });
    }
  }

  async function ensureAgentMetadataStoreLoaded() {
    if (!acpSessionStoreLoadPromise) {
      acpSessionStoreLoadPromise = loadAcpSessionStore().catch((err) => {
        acpSessionStoreLoadPromise = null;
        throw err;
      });
    }
    await acpSessionStoreLoadPromise;
  }

  async function ensureAcpSessionStoreLoaded() {
    if (!sessionRootBindingEnabled) return;
    await ensureAgentMetadataStoreLoaded();
  }

  async function persistAcpSessionStore(lastReadAtBySessionId = acpSessionLastReadAtBySessionId) {
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
    const rootsBySessionId = sessionRootBindingEnabled ? new Map(acpSessionRootBySessionId) : new Map();
    const updatedAtBySessionId = sessionRootBindingEnabled ? new Map(acpSessionUpdatedAtBySessionId) : new Map();
    const lastReadAtBySessionId = sessionRootBindingEnabled ? new Map(acpSessionLastReadAtBySessionId) : new Map();
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
    if (!sessionRootBindingEnabled) return { migratedSessions: 0 };
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
    if (!sessionRootBindingEnabled) return results.map((result) => ({ ...result, elapsedMs: 0 }));
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
    if (!sessionRootBindingEnabled) return { selectedSessionIds: [], updatedSessionIds: [], elapsedMs: 0 };
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
      directories: sessionRootBindingEnabled ? acpLatestSessionByRootRelativePath.size : 0,
      sessions: sessionRootBindingEnabled ? acpSessionRootBySessionId.size : 0,
      agentOperations: agentOperations.size,
    };
  }

  async function getAgentModelInfo(backendIdRaw, modelIdRaw) {
    await ensureAgentMetadataStoreLoaded();
    const entry = agentModelInfo.get(agentSessionKey(String(backendIdRaw || "").trim(), String(modelIdRaw || "").trim()));
    return entry ? { ...entry } : null;
  }

  async function setAgentModelInfo(backendIdRaw, modelIdRaw, infoRaw) {
    const backendId = String(backendIdRaw || "").trim();
    const modelId = String(modelIdRaw || "").trim();
    const contextWindowTokens = Math.floor(Number(infoRaw?.contextWindowTokens));
    if (!backendId || !modelId || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return null;
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const key = agentSessionKey(backendId, modelId);
      const existing = agentModelInfo.get(key);
      if (existing && existing.contextWindowTokens === contextWindowTokens) return { ...existing };
      const entry = { backendId, modelId, contextWindowTokens, updatedAt: new Date().toISOString() };
      agentModelInfo.set(key, entry);
      try {
        await persistAcpSessionStore();
      } catch (error) {
        if (existing) agentModelInfo.set(key, existing);
        else agentModelInfo.delete(key);
        throw error;
      }
      return { ...entry };
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  function pruneAgentOperations(nowMs) {
    const terminal = Array.from(agentOperations.entries())
      // 別プロセスでclaimされたままcompleteされなかったpending(クラッシュ孤児)は、
      // runがプロセスと共に消えていて完了し得ない。completedと同じTTL/容量規則で
      // 回収し、当該clientOperationIdの恒久毒化と容量枯渇を防ぐ。
      .filter(([key, entry]) => entry.status === "completed"
        || (entry.status === "pending" && !agentOperationsClaimedHere.has(key)))
      .sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt));
    for (const [key, entry] of terminal) {
      if (Date.parse(entry.updatedAt) + agentOperationTtlMs > nowMs && agentOperations.size < agentOperationMaxEntries) {
        continue;
      }
      agentOperations.delete(key);
    }
  }

  function describeAgentOperation(entry, key, requestHash) {
    if (entry.requestHash !== requestHash) return { status: "conflict" };
    if (entry.status === "pending" && !agentOperationsClaimedHere.has(key)) {
      return { status: "unknown", runId: entry.runId };
    }
    return { status: "existing", runId: entry.runId, result: entry.result };
  }

  async function inspectAgentOperation(subjectIdRaw, clientOperationIdRaw, requestHashRaw) {
    const subjectId = String(subjectIdRaw || "").trim();
    const clientOperationId = String(clientOperationIdRaw || "").trim();
    const requestHash = String(requestHashRaw || "").trim();
    if (!subjectId || !clientOperationId || !requestHash) throw new TypeError("invalid agent operation");
    await ensureAgentMetadataStoreLoaded();
    await acpSessionStoreWriteQueue;
    const key = agentOperationKey(subjectId, clientOperationId);
    const existing = agentOperations.get(key);
    const replayable = existing && !(
      Date.parse(existing.updatedAt) + agentOperationTtlMs <= Date.now()
      && (existing.status === "completed" || !agentOperationsClaimedHere.has(key))
    );
    return replayable ? describeAgentOperation(existing, key, requestHash) : { status: "missing" };
  }

  async function claimAgentOperation(subjectIdRaw, clientOperationIdRaw, requestHashRaw, runIdRaw) {
    const subjectId = String(subjectIdRaw || "").trim();
    const clientOperationId = String(clientOperationIdRaw || "").trim();
    const requestHash = String(requestHashRaw || "").trim();
    const runId = String(runIdRaw || "").trim();
    if (!subjectId || !clientOperationId || !requestHash || !runId) throw new TypeError("invalid agent operation");
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const key = agentOperationKey(subjectId, clientOperationId);
      const nowMs = Date.now();
      // 先にpruneする: TTLを過ぎたクラッシュ孤児pendingが残っていても、ここで
      // 回収されて同じclientOperationIdを新規claimし直せる。
      pruneAgentOperations(nowMs);
      const existing = agentOperations.get(key);
      if (existing) return describeAgentOperation(existing, key, requestHash);
      if (agentOperations.size >= agentOperationMaxEntries) {
        throw new Error("agent operation store capacity reached");
      }
      const nowIso = new Date(nowMs).toISOString();
      agentOperations.set(key, {
        subjectId,
        clientOperationId,
        requestHash,
        runId,
        status: "pending",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      agentOperationsClaimedHere.add(key);
      try {
        await persistAcpSessionStore();
      } catch (error) {
        agentOperations.delete(key);
        agentOperationsClaimedHere.delete(key);
        throw error;
      }
      return { status: "claimed", runId };
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  async function completeAgentOperation(subjectIdRaw, clientOperationIdRaw, result) {
    const subjectId = String(subjectIdRaw || "").trim();
    const clientOperationId = String(clientOperationIdRaw || "").trim();
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const entry = agentOperations.get(agentOperationKey(subjectId, clientOperationId));
      if (!entry || entry.status !== "pending") return false;
      const previous = { ...entry };
      entry.status = "completed";
      entry.updatedAt = new Date().toISOString();
      entry.result = result;
      try {
        await persistAcpSessionStore();
      } catch (error) {
        Object.assign(entry, previous);
        delete entry.result;
        throw error;
      }
      return true;
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  async function getAgentSessionBinding(sessionRef) {
    await ensureAgentMetadataStoreLoaded();
    const key = agentSessionKey(sessionRef?.backendId, sessionRef?.nativeSessionId);
    const binding = agentSessionBindings.get(key);
    return binding ? { ...binding } : null;
  }

  async function listAgentSessionsForDirectories(requestedDirectories) {
    await ensureAgentMetadataStoreLoaded();
    const requestedRoots = await Promise.all(
      (Array.isArray(requestedDirectories) ? requestedDirectories : [])
        .map((directory) => resolveDirectoryIdentity(directory)),
    );
    const bindings = Array.from(agentSessionBindings.values());
    return requestedRoots.map((directory) => ({
      directory,
      sessions: bindings
        .filter((binding) => binding.canonicalCwd === directory)
        .map((binding) => ({
          backendId: binding.backendId,
          sessionId: binding.nativeSessionId,
          directory,
          updatedAt: binding.updatedAt,
          lastReadAt: binding.lastReadAt,
          source: "agent",
          ...(binding.modelId ? { modelRef: binding.modelId } : {}),
          ...(binding.reasoningEffort ? { reasoningEffort: binding.reasoningEffort } : {}),
        }))
        .sort(compareSessionHistoryEntries),
    }));
  }

  async function recordAgentSessionActivity(sessionRef, canonicalCwdRaw, updatedAtRaw) {
    const backendId = String(sessionRef?.backendId || "").trim();
    const nativeSessionId = String(sessionRef?.nativeSessionId || "").trim();
    const rawCwd = String(canonicalCwdRaw || "").trim();
    const canonicalCwd = rawCwd ? path.resolve(rawCwd) : "";
    const updatedAt = normalizeSessionUpdatedAt(updatedAtRaw) || new Date().toISOString();
    if (!backendId || !nativeSessionId || !path.isAbsolute(canonicalCwd)) {
      throw new TypeError("invalid agent session activity");
    }
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const key = agentSessionKey(backendId, nativeSessionId);
      const binding = agentSessionBindings.get(key);
      if (!binding || binding.canonicalCwd !== canonicalCwd) return { status: "missing" };
      const previous = { ...binding };
      binding.updatedAt = updatedAt;
      try {
        await persistAcpSessionStore();
      } catch (error) {
        agentSessionBindings.set(key, previous);
        throw error;
      }
      return { status: "updated" };
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  async function setAgentSessionSettings(sessionRef, settings = {}) {
    const backendId = String(sessionRef?.backendId || "").trim();
    const nativeSessionId = String(sessionRef?.nativeSessionId || "").trim();
    const modelId = String(settings?.modelId || "").trim();
    const reasoningEffort = String(settings?.reasoningEffort || "").trim();
    if (!backendId || !nativeSessionId || modelId.length > 256 || reasoningEffort.length > 64) {
      throw new TypeError("invalid agent session settings");
    }
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const key = agentSessionKey(backendId, nativeSessionId);
      const binding = agentSessionBindings.get(key);
      if (!binding) return { status: "missing" };
      if (String(binding.modelId || "") === modelId && String(binding.reasoningEffort || "") === reasoningEffort) {
        return { status: "unchanged" };
      }
      const previous = { ...binding };
      if (modelId) binding.modelId = modelId;
      else delete binding.modelId;
      if (reasoningEffort) binding.reasoningEffort = reasoningEffort;
      else delete binding.reasoningEffort;
      try {
        await persistAcpSessionStore();
      } catch (error) {
        agentSessionBindings.set(key, previous);
        throw error;
      }
      return { status: "updated" };
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  async function markAgentSessionsRead(sessionIds, { backendId: backendIdRaw, lastReadAt }) {
    const backendId = String(backendIdRaw || "codex").trim() || "codex";
    const ids = Array.isArray(sessionIds) ? sessionIds.map((value) => String(value || "").trim()) : [];
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const results = ids.map((sessionId) => ({ sessionId, updated: false, entryFound: false }));
      const previousBindings = new Map();
      for (const result of results) {
        for (const [key, binding] of agentSessionBindings) {
          if (binding.nativeSessionId !== result.sessionId || binding.backendId !== backendId) continue;
          result.entryFound = true;
          if (binding.lastReadAt === lastReadAt) continue;
          if (!previousBindings.has(key)) previousBindings.set(key, { ...binding });
          binding.lastReadAt = lastReadAt;
          result.updated = true;
        }
      }
      if (previousBindings.size === 0) return results;
      try {
        await persistAcpSessionStore();
      } catch (error) {
        for (const [key, binding] of previousBindings) agentSessionBindings.set(key, binding);
        throw error;
      }
      return results;
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  async function markAgentDirectoryRead(directoryRaw, lastReadAt) {
    const directory = await resolveDirectoryIdentity(directoryRaw);
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const selectedSessionIds = [];
      const updatedSessionIds = [];
      const previousBindings = new Map();
      for (const [key, binding] of agentSessionBindings) {
        if (binding.canonicalCwd !== directory) continue;
        selectedSessionIds.push(agentSessionKey(binding.backendId, binding.nativeSessionId));
        if (binding.lastReadAt === lastReadAt) continue;
        previousBindings.set(key, { ...binding });
        binding.lastReadAt = lastReadAt;
        updatedSessionIds.push(key);
      }
      if (previousBindings.size > 0) {
        try {
          await persistAcpSessionStore();
        } catch (error) {
          for (const [key, binding] of previousBindings) agentSessionBindings.set(key, binding);
          throw error;
        }
      }
      return { selectedSessionIds, updatedSessionIds };
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  async function bindAgentSession(sessionRef, canonicalCwdRaw, modeRaw, options = {}) {
    const backendId = String(sessionRef?.backendId || "").trim();
    const nativeSessionId = String(sessionRef?.nativeSessionId || "").trim();
    const rawCwd = String(canonicalCwdRaw || "").trim();
    const canonicalCwd = rawCwd ? path.resolve(rawCwd) : "";
    const mode = modeRaw === "raw" ? "raw" : modeRaw === "neutral" ? "neutral" : "";
    if (!backendId || !nativeSessionId || !path.isAbsolute(canonicalCwd) || !mode) {
      throw new TypeError("invalid agent session binding");
    }
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const key = agentSessionKey(backendId, nativeSessionId);
      const existingBinding = agentSessionBindings.get(key);
      if (existingBinding && existingBinding.canonicalCwd !== canonicalCwd) {
        const existingMode = agentSessionModes.get(key);
        // reconcileはmode据え置き(要求modeが既存modeと一致)かつidle(lease無し)のみ許す。
        // native cwdへの収束は認めるが、mode遷移や実行中セッションの付け替えは認めない。
        if (
          options.reconcileCwd === true &&
          existingMode?.mode === mode &&
          !existingMode.lease
        ) {
          const previousBinding = { ...existingBinding };
          const binding = { ...existingBinding, canonicalCwd };
          agentSessionBindings.set(key, binding);
          try {
            await persistAcpSessionStore();
          } catch (error) {
            agentSessionBindings.set(key, previousBinding);
            throw error;
          }
          return { status: "bound", binding: { ...binding }, mode };
        }
        return { status: "cwd_conflict", binding: { ...existingBinding } };
      }
      const existingMode = agentSessionModes.get(key);
      if (existingMode && existingMode.mode !== mode) {
        return { status: "mode_conflict", mode: existingMode.mode, lease: existingMode.lease };
      }
      if (existingBinding && existingMode) {
        return { status: "bound", binding: { ...existingBinding }, mode };
      }
      const nowIso = new Date().toISOString();
      const previousBinding = existingBinding ? { ...existingBinding } : null;
      const previousMode = existingMode
        ? { ...existingMode, ...(existingMode.lease ? { lease: { ...existingMode.lease } } : {}) }
        : null;
      const binding = { backendId, nativeSessionId, canonicalCwd, updatedAt: nowIso, lastReadAt: nowIso };
      const modeEntry = existingMode || { backendId, nativeSessionId, mode, lease: null, updatedAt: nowIso };
      modeEntry.updatedAt = nowIso;
      agentSessionBindings.set(key, binding);
      agentSessionModes.set(key, modeEntry);
      try {
        await persistAcpSessionStore();
      } catch (error) {
        if (previousBinding) agentSessionBindings.set(key, previousBinding);
        else agentSessionBindings.delete(key);
        if (previousMode) agentSessionModes.set(key, previousMode);
        else agentSessionModes.delete(key);
        throw error;
      }
      return { status: "bound", binding: { ...binding }, mode };
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  async function getAgentSessionMode(sessionRef) {
    await ensureAgentMetadataStoreLoaded();
    const entry = agentSessionModes.get(agentSessionKey(sessionRef?.backendId, sessionRef?.nativeSessionId));
    return entry ? { ...entry, ...(entry.lease ? { lease: { ...entry.lease } } : {}) } : null;
  }

  async function handoffAgentSessionMode(sessionRef, targetModeRaw, options = {}) {
    const backendId = String(sessionRef?.backendId || "").trim();
    const nativeSessionId = String(sessionRef?.nativeSessionId || "").trim();
    const targetMode = targetModeRaw === "raw" ? "raw" : targetModeRaw === "neutral" ? "neutral" : "";
    if (!backendId || !nativeSessionId || !targetMode) throw new TypeError("invalid agent session mode");
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const key = agentSessionKey(backendId, nativeSessionId);
      const existing = agentSessionModes.get(key);
      const binding = agentSessionBindings.get(key);
      const clearSettings = options.clearSettings === true && Boolean(binding?.modelId || binding?.reasoningEffort);
      // 同一モードへのhandoffはモード遷移を伴わないno-op。lease保持中(turn/compact
      // 実行中)でも成功にする。leaseガードは「実行中のモード反転」を防ぐためのもの。
      if (existing?.mode === targetMode && !clearSettings) return { status: "unchanged", mode: targetMode };
      if (existing?.mode !== targetMode && existing?.lease) {
        return { status: "busy", mode: existing.mode, lease: { ...existing.lease } };
      }
      const previous = existing ? { ...existing } : null;
      const previousBinding = binding ? { ...binding } : null;
      if (existing?.mode !== targetMode) {
        agentSessionModes.set(key, {
          backendId,
          nativeSessionId,
          mode: targetMode,
          lease: null,
          updatedAt: new Date().toISOString(),
        });
      }
      if (clearSettings) {
        delete binding.modelId;
        delete binding.reasoningEffort;
      }
      try {
        await persistAcpSessionStore();
      } catch (error) {
        if (previous) agentSessionModes.set(key, previous);
        else agentSessionModes.delete(key);
        if (previousBinding) agentSessionBindings.set(key, previousBinding);
        throw error;
      }
      return { status: existing?.mode === targetMode ? "unchanged" : "changed", mode: targetMode };
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  async function acquireAgentSessionLease({ sessionRef, mode: modeRaw, owner, runId, nativeProcessIdentity = "" }) {
    const backendId = String(sessionRef?.backendId || "").trim();
    const nativeSessionId = String(sessionRef?.nativeSessionId || "").trim();
    const mode = modeRaw === "raw" ? "raw" : modeRaw === "neutral" ? "neutral" : "";
    const normalizedOwner = String(owner || "").trim();
    const normalizedRunId = String(runId || "").trim();
    if (!backendId || !nativeSessionId || !mode || !normalizedOwner || !normalizedRunId) {
      throw new TypeError("invalid agent session lease");
    }
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const key = agentSessionKey(backendId, nativeSessionId);
      const existing = agentSessionModes.get(key);
      if (existing && existing.mode !== mode) return { status: "mode_conflict", mode: existing.mode };
      if (existing?.lease) {
        const lease = existing.lease;
        if (
          lease.state === "active" && lease.processEpoch === agentProcessEpoch &&
          lease.owner === normalizedOwner && lease.runId === normalizedRunId
        ) return { status: "existing", lease: { ...lease } };
        return { status: lease.state === "recovering" ? "recovering" : "busy", lease: { ...lease } };
      }
      const previous = existing ? { ...existing } : null;
      const generation = Math.max(0, Number(existing?.generation || 0)) + 1;
      const nowIso = new Date().toISOString();
      const lease = {
        owner: normalizedOwner,
        runId: normalizedRunId,
        processEpoch: agentProcessEpoch,
        acquiredAt: nowIso,
        generation,
        state: "active",
        ...(String(nativeProcessIdentity || "").trim()
          ? { nativeProcessIdentity: String(nativeProcessIdentity).trim() }
          : {}),
      };
      agentSessionModes.set(key, {
        backendId,
        nativeSessionId,
        mode,
        generation,
        lease,
        updatedAt: nowIso,
      });
      try {
        await persistAcpSessionStore();
      } catch (error) {
        if (previous) agentSessionModes.set(key, previous);
        else agentSessionModes.delete(key);
        throw error;
      }
      return { status: "acquired", lease: { ...lease } };
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  async function settleAgentSessionLease(sessionRef, generationRaw, nextState) {
    const generation = Number(generationRaw);
    if (!Number.isInteger(generation) || generation <= 0 || !["released", "recovering"].includes(nextState)) {
      throw new TypeError("invalid agent session lease settlement");
    }
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const key = agentSessionKey(sessionRef?.backendId, sessionRef?.nativeSessionId);
      const existing = agentSessionModes.get(key);
      if (!existing?.lease || existing.lease.generation !== generation) return { status: "stale" };
      const previous = { ...existing, lease: { ...existing.lease } };
      const nowIso = new Date().toISOString();
      existing.updatedAt = nowIso;
      if (nextState === "released") existing.lease = null;
      else existing.lease = { ...existing.lease, state: "recovering" };
      try {
        await persistAcpSessionStore();
      } catch (error) {
        agentSessionModes.set(key, previous);
        throw error;
      }
      return { status: nextState };
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  async function updateAgentSessionLeaseIdentity(sessionRef, generationRaw, nativeProcessIdentityRaw) {
    const generation = Number(generationRaw);
    const nativeProcessIdentity = String(nativeProcessIdentityRaw || "").trim();
    if (!Number.isInteger(generation) || generation <= 0 || !nativeProcessIdentity || nativeProcessIdentity.length > 4096) {
      throw new TypeError("invalid native process identity");
    }
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const key = agentSessionKey(sessionRef?.backendId, sessionRef?.nativeSessionId);
      const existing = agentSessionModes.get(key);
      if (!existing?.lease || existing.lease.generation !== generation || existing.lease.state !== "active") {
        return { status: "stale" };
      }
      const previous = { ...existing, lease: { ...existing.lease } };
      existing.lease = { ...existing.lease, nativeProcessIdentity };
      existing.updatedAt = new Date().toISOString();
      try {
        await persistAcpSessionStore();
      } catch (error) {
        agentSessionModes.set(key, previous);
        throw error;
      }
      return { status: "updated" };
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  async function listAgentWorkspaces(subjectIdRaw) {
    const subjectId = String(subjectIdRaw || "").trim();
    await ensureAgentMetadataStoreLoaded();
    return Array.from(agentWorkspaces.values())
      .filter((entry) => entry.subjectId === subjectId && !entry.revokedAt)
      .sort((a, b) => a.canonicalRoot.localeCompare(b.canonicalRoot))
      .map((entry) => ({ ...entry }));
  }

  async function approveAgentWorkspace(subjectIdRaw, canonicalRootRaw, identityRaw) {
    const subjectId = String(subjectIdRaw || "").trim();
    const rawRoot = String(canonicalRootRaw || "").trim();
    const canonicalRoot = rawRoot ? path.resolve(rawRoot) : "";
    const identity = String(identityRaw || "").trim();
    if (!subjectId || !path.isAbsolute(canonicalRoot) || !identity || identity.length > 256) {
      throw new TypeError("invalid agent workspace");
    }
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const key = agentWorkspaceKey(subjectId, canonicalRoot);
      const previous = agentWorkspaces.get(key);
      if (!previous && agentWorkspaces.size >= agentWorkspaceMaxEntries) {
        throw new Error("agent workspace store capacity reached");
      }
      const next = {
        canonicalRoot,
        subjectId,
        identity,
        approvedAt: new Date().toISOString(),
        revokedAt: "",
      };
      agentWorkspaces.set(key, next);
      try {
        await persistAcpSessionStore();
      } catch (error) {
        if (previous) agentWorkspaces.set(key, previous);
        else agentWorkspaces.delete(key);
        throw error;
      }
      return { ...next };
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  async function revokeAgentWorkspace(subjectIdRaw, canonicalRootRaw) {
    const subjectId = String(subjectIdRaw || "").trim();
    const rawRoot = String(canonicalRootRaw || "").trim();
    const canonicalRoot = rawRoot ? path.resolve(rawRoot) : "";
    if (!subjectId || !canonicalRoot) throw new TypeError("invalid agent workspace");
    await ensureAgentMetadataStoreLoaded();
    const op = acpSessionStoreWriteQueue.then(async () => {
      const key = agentWorkspaceKey(subjectId, canonicalRoot);
      const existing = agentWorkspaces.get(key);
      if (!existing || existing.subjectId !== subjectId || existing.revokedAt) return null;
      const previous = { ...existing };
      const revoked = { ...existing, revokedAt: new Date().toISOString() };
      agentWorkspaces.delete(key);
      try {
        await persistAcpSessionStore();
      } catch (error) {
        agentWorkspaces.set(key, previous);
        throw error;
      }
      return revoked;
    });
    acpSessionStoreWriteQueue = op.catch(() => {});
    return await op;
  }

  return {
    agentSessionActivityStore: {
      listForDirectories: listAgentSessionsForDirectories,
      markDirectoryRead: markAgentDirectoryRead,
      markSessionsRead: markAgentSessionsRead,
      recordActivity: recordAgentSessionActivity,
    },
    bindSessionToRootDir,
    bindAgentSession,
    claimAgentOperation,
    completeAgentOperation,
    inspectAgentOperation,
    getAgentModelInfo,
    setAgentModelInfo,
    acquireAgentSessionLease,
    getAcpSessionStoreStats,
    getAgentSessionBinding,
    getAgentSessionMode,
    handoffAgentSessionMode,
    setAgentSessionSettings,
    listAgentWorkspaces,
    listAcpSessionsForDirectories,
    listAcpSessionsForDirectory,
    markAcpDirectoryRead,
    markAcpSessionsRead,
    migrateAcpSessionDirectoryIdentity,
    approveAgentWorkspace,
    revokeAgentWorkspace,
    resolveSessionIdForRootDir,
    settleAgentSessionLease,
    updateAgentSessionLeaseIdentity,
  };
}
