import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseLlmSessionRelationship } from "./llm-session-metadata.mjs";

const CLI_SESSION_INDEX_VERSION = 3;

export function createLlmCliSessionIndex(deps = {}) {
  const {
    cliSessionIndexPath,
    cliSessionIndexRefreshMinIntervalMs,
    cliSessionScanMaxFiles,
    codeCliSessionsDir,
    compareSessionHistoryEntries,
    normalizeLlmExecutionSessionId,
    normalizeReasoningEffort,
    normalizeSessionRootRelativePath,
    normalizeSessionUpdatedAt,
    toUnixPath,
    toWorkspaceRelativeFromAbsolutePath,
  } = deps;
  const fileSystem = deps.fileSystem || fs;

  let cliSessionIndexLoadPromise = null;
  let cliSessionIndexWriteQueue = Promise.resolve();
  let cliSessionReadMutationQueue = Promise.resolve();
  const cliSessionIndexByFilePath = new Map();
  let cliSessionIndexLastRefreshAtMs = 0;
  let cliSessionIndexRefreshGeneration = 0;
  let cliSessionIndexActiveRefreshWave = null;
  let cliSessionIndexQueuedForceWave = null;
  let cliSessionIndexRequiresMetadataMigration = false;
  const cliSessionCwdIdentityByCwd = new Map();

  function normalizeCliSessionIndexEntry(rawEntry) {
    const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
    const filePath = path.resolve(String(entry.filePath || "").trim());
    if (!filePath) return null;
    const mtimeMs = Number(entry.mtimeMs || 0);
    const size = Number(entry.size || 0);
    if (!Number.isFinite(mtimeMs) || mtimeMs < 0) return null;
    if (!Number.isFinite(size) || size < 0) return null;
    let sessionId = "";
    try {
      sessionId = normalizeLlmExecutionSessionId(entry.sessionId);
    } catch {
      return null;
    }
    if (!sessionId) return null;
    const cwd = String(entry.cwd || "").trim();
    const directoryCandidate = String(entry.directory || toWorkspaceRelativeFromAbsolutePath(cwd)).trim();
    const directory = directoryCandidate ? normalizeSessionRootRelativePath(directoryCandidate) : "";
    const updatedAt = normalizeSessionUpdatedAt(entry.updatedAt) || new Date(Math.floor(mtimeMs)).toISOString();
    const lastReadAt = normalizeSessionUpdatedAt(entry.lastReadAt);
    return {
      filePath,
      mtimeMs: Math.floor(mtimeMs),
      size: Math.floor(size),
      sessionId,
      cwd,
      directory,
      updatedAt,
      lastReadAt: lastReadAt || "",
      isSubagent: entry.isSubagent === true,
      parentSessionId: String(entry.parentSessionId || "").trim(),
    };
  }

  function pickNewerTimestamp(first, second) {
    const a = normalizeSessionUpdatedAt(first);
    const b = normalizeSessionUpdatedAt(second);
    if (!a) return b || "";
    if (!b) return a;
    const aMs = Date.parse(a);
    const bMs = Date.parse(b);
    if (!Number.isFinite(aMs)) return b;
    if (!Number.isFinite(bMs)) return a;
    return bMs > aMs ? b : a;
  }

  function buildCliSessionIndexPayload(
    entriesByFilePath = cliSessionIndexByFilePath,
    metadataComplete = !cliSessionIndexRequiresMetadataMigration,
  ) {
    const entries = Array.from(entriesByFilePath.values())
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
    return {
      version: metadataComplete ? CLI_SESSION_INDEX_VERSION : CLI_SESSION_INDEX_VERSION - 1,
      updatedAt: new Date().toISOString(),
      sessionsDir: codeCliSessionsDir,
      entries,
    };
  }

  async function loadCliSessionIndex() {
    let parsed = {};
    try {
      const raw = await fileSystem.readFile(cliSessionIndexPath, "utf8");
      parsed = raw ? JSON.parse(raw) : {};
    } catch (err) {
      if (!err || typeof err !== "object" || err.code !== "ENOENT") {
        throw err;
      }
    }
    cliSessionIndexByFilePath.clear();
    cliSessionIndexRequiresMetadataMigration = Number(parsed?.version || 0) < CLI_SESSION_INDEX_VERSION;
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const rawEntry of entries) {
      const entry = normalizeCliSessionIndexEntry(rawEntry);
      if (!entry) continue;
      cliSessionIndexByFilePath.set(entry.filePath, entry);
    }
  }

  async function ensureCliSessionIndexLoaded() {
    if (!cliSessionIndexLoadPromise) {
      cliSessionIndexLoadPromise = loadCliSessionIndex().catch((err) => {
        cliSessionIndexLoadPromise = null;
        throw err;
      });
    }
    await cliSessionIndexLoadPromise;
  }

  async function persistCliSessionIndex(
    entriesByFilePath = cliSessionIndexByFilePath,
    opts = {},
  ) {
    const parentDir = path.dirname(cliSessionIndexPath);
    await fileSystem.mkdir(parentDir, { recursive: true });
    const payload = buildCliSessionIndexPayload(entriesByFilePath, opts.metadataComplete);
    const tmpPath = `${cliSessionIndexPath}.${randomUUID()}.tmp`;
    await fileSystem.writeFile(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    await fileSystem.rename(tmpPath, cliSessionIndexPath);
  }

  async function listCliSessionRolloutFiles(rootDir) {
    const files = [];
    const queue = [path.resolve(rootDir)];
    while (queue.length > 0) {
      const currentDir = queue.pop();
      let entries = [];
      try {
        entries = await fileSystem.readdir(currentDir, { withFileTypes: true });
      } catch (err) {
        const code = String(err?.code || "").toUpperCase();
        if (code === "ENOENT" || code === "ENOTDIR") {
          continue;
        }
        throw err;
      }
      for (const entry of entries) {
        const absPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          queue.push(absPath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
        files.push(absPath);
      }
    }
    files.sort((a, b) => b.localeCompare(a));
    return files.slice(0, cliSessionScanMaxFiles);
  }

  async function readCliSessionMetaFromRolloutFile(filePath, fallbackUpdatedAt) {
    let handle = null;
    try {
      handle = await fileSystem.open(filePath, "r");
    } catch {
      return null;
    }
    const maxBytes = 512 * 1024;
    const chunkBytes = 64 * 1024;
    let bytesOffset = 0;
    let carry = "";
    try {
      while (bytesOffset < maxBytes) {
        const length = Math.min(chunkBytes, maxBytes - bytesOffset);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, bytesOffset);
        if (!bytesRead) break;
        bytesOffset += bytesRead;
        carry += chunk.toString("utf8", 0, bytesRead);
        let newlineIndex = carry.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = carry.slice(0, newlineIndex).trim();
          carry = carry.slice(newlineIndex + 1);
          if (!line.includes("\"session_meta\"")) {
            newlineIndex = carry.indexOf("\n");
            continue;
          }
          let parsed = null;
          try {
            parsed = JSON.parse(line);
          } catch {
            newlineIndex = carry.indexOf("\n");
            continue;
          }
          if (String(parsed?.type || "") !== "session_meta") {
            newlineIndex = carry.indexOf("\n");
            continue;
          }
          const payload = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : {};
          const cwd = String(payload?.cwd || "").trim();
          let sessionId = "";
          try {
            sessionId = normalizeLlmExecutionSessionId(payload?.id);
          } catch {
            sessionId = "";
          }
          if (!sessionId) return null;
          const updatedAt = normalizeSessionUpdatedAt(payload?.timestamp || parsed?.timestamp) || fallbackUpdatedAt;
          const lastReadAt = normalizeSessionUpdatedAt(payload?.last_read_at);
          const directoryCandidate = toWorkspaceRelativeFromAbsolutePath(cwd);
          const modelRef = String(payload?.model_ref || "").trim();
          const reasoningEffort = normalizeReasoningEffort(payload?.reasoning_effort, { warnInvalid: false });
          const relationship = parseLlmSessionRelationship(payload);
          return {
            sessionId,
            cwd,
            directory: directoryCandidate ? normalizeSessionRootRelativePath(directoryCandidate) : "",
            updatedAt,
            lastReadAt: lastReadAt || "",
            modelRef,
            reasoningEffort: reasoningEffort || "",
            ...relationship,
          };
        }
      }
      return null;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function scanCliSessionIndex() {
    await ensureCliSessionIndexLoaded();
    const snapshotByFilePath = new Map(cliSessionIndexByFilePath);
    const remainingSnapshotEntries = new Map(snapshotByFilePath);
    const files = await listCliSessionRolloutFiles(codeCliSessionsDir);
    const nextByFilePath = new Map();
    let changed = cliSessionIndexRequiresMetadataMigration;

    for (const filePath of files) {
      let stat = null;
      try {
        stat = await fileSystem.stat(filePath);
      } catch {
        changed = true;
        continue;
      }
      const mtimeMs = Math.floor(Number(stat.mtimeMs || 0));
      const size = Number(stat.size || 0);
      const cached = snapshotByFilePath.get(filePath);
      remainingSnapshotEntries.delete(filePath);
      if (
        cached &&
        Number(cached.mtimeMs || 0) === mtimeMs &&
        Number(cached.size || 0) === size &&
        !cliSessionIndexRequiresMetadataMigration
      ) {
        nextByFilePath.set(filePath, cached);
        continue;
      }
      changed = true;
      const fallbackUpdatedAt = new Date(Math.floor(mtimeMs || Date.now())).toISOString();
      const meta = await readCliSessionMetaFromRolloutFile(filePath, fallbackUpdatedAt);
      if (!meta) continue;
      const normalized = normalizeCliSessionIndexEntry({
        filePath,
        mtimeMs,
        size,
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        directory: meta.directory,
        updatedAt: meta.updatedAt,
        // The index is the source of truth for read state; the file-side
        // last_read_at only remains as legacy data in already-annotated files.
        lastReadAt: cached ? cached.lastReadAt : meta.lastReadAt,
        isSubagent: meta.isSubagent,
        parentSessionId: meta.parentSessionId,
      });
      if (!normalized) continue;
      nextByFilePath.set(filePath, normalized);
    }

    if (remainingSnapshotEntries.size > 0) {
      changed = true;
    }
    return { changed, nextByFilePath, snapshotByFilePath };
  }

  function mergeCliSessionIndexScan({ nextByFilePath, snapshotByFilePath }) {
    const mergedByFilePath = new Map();
    for (const [filePath, scannedEntry] of nextByFilePath.entries()) {
      const snapshotEntry = snapshotByFilePath.get(filePath);
      const currentEntry = cliSessionIndexByFilePath.get(filePath);
      const currentChangedAfterSnapshot = currentEntry && currentEntry !== snapshotEntry;
      const currentIsAtLeastAsNew = currentChangedAfterSnapshot && (
        Number(currentEntry.mtimeMs || 0) > Number(scannedEntry.mtimeMs || 0) ||
        (
          Number(currentEntry.mtimeMs || 0) === Number(scannedEntry.mtimeMs || 0) &&
          Number(currentEntry.size || 0) >= Number(scannedEntry.size || 0)
        )
      );
      const baseEntry = currentIsAtLeastAsNew ? currentEntry : scannedEntry;
      const merged = normalizeCliSessionIndexEntry({
        ...baseEntry,
        updatedAt: currentChangedAfterSnapshot
          ? pickNewerTimestamp(currentEntry.updatedAt, scannedEntry.updatedAt)
          : scannedEntry.updatedAt,
        lastReadAt: currentChangedAfterSnapshot
          ? currentEntry.lastReadAt
          : scannedEntry.lastReadAt,
        isSubagent: scannedEntry.isSubagent,
        parentSessionId: scannedEntry.parentSessionId,
      });
      if (merged) mergedByFilePath.set(filePath, merged);
    }
    for (const [filePath, currentEntry] of cliSessionIndexByFilePath.entries()) {
      if (mergedByFilePath.has(filePath)) continue;
      if (currentEntry !== snapshotByFilePath.get(filePath)) {
        mergedByFilePath.set(filePath, currentEntry);
      }
    }
    return mergedByFilePath;
  }

  function replaceCliSessionIndex(nextByFilePath) {
    cliSessionIndexByFilePath.clear();
    for (const [filePath, entry] of nextByFilePath.entries()) {
      if (entry) cliSessionIndexByFilePath.set(filePath, entry);
    }
  }

  async function runCliSessionIndexRefresh() {
    const scan = await scanCliSessionIndex();
    if (!scan.changed) return;
    const op = cliSessionIndexWriteQueue.then(async () => {
      const mergedByFilePath = mergeCliSessionIndexScan(scan);
      await persistCliSessionIndex(mergedByFilePath, { metadataComplete: true });
      replaceCliSessionIndex(mergedByFilePath);
      cliSessionIndexRequiresMetadataMigration = false;
    });
    cliSessionIndexWriteQueue = op.catch(() => {});
    await op;
  }

  function createCliSessionIndexRefreshWave() {
    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    return {
      generation: ++cliSessionIndexRefreshGeneration,
      promise,
      resolve,
      reject,
    };
  }

  function startCliSessionIndexRefreshWave(
    wave,
    run = runCliSessionIndexRefresh,
    updateRefreshTime = true,
  ) {
    cliSessionIndexActiveRefreshWave = wave;
    void (async () => {
      let failure = null;
      try {
        const result = await run();
        if (updateRefreshTime) cliSessionIndexLastRefreshAtMs = Date.now();
        wave.resolve(result);
      } catch (error) {
        failure = error;
        wave.reject(error);
      } finally {
        if (cliSessionIndexActiveRefreshWave?.generation !== wave.generation) return;
        cliSessionIndexActiveRefreshWave = null;
        const queuedWave = cliSessionIndexQueuedForceWave;
        cliSessionIndexQueuedForceWave = null;
        if (failure) {
          queuedWave?.reject(failure);
        } else if (queuedWave) {
          startCliSessionIndexRefreshWave(queuedWave);
        }
      }
    })();
  }

  async function refreshCliSessionIndex(opts = {}) {
    const force = opts?.force === true;
    if (cliSessionIndexActiveRefreshWave) {
      if (!force) {
        await cliSessionIndexActiveRefreshWave.promise;
        return;
      }
      if (!cliSessionIndexQueuedForceWave) {
        cliSessionIndexQueuedForceWave = createCliSessionIndexRefreshWave();
      }
      await cliSessionIndexQueuedForceWave.promise;
      return;
    }
    const now = Date.now();
    if (
      !force &&
      cliSessionIndexLastRefreshAtMs > 0 &&
      (now - cliSessionIndexLastRefreshAtMs) < cliSessionIndexRefreshMinIntervalMs
    ) {
      return;
    }
    const wave = createCliSessionIndexRefreshWave();
    startCliSessionIndexRefreshWave(wave);
    await wave.promise;
  }

  function buildDirectoryLookup(rawDirectory) {
    const rawValue = String(rawDirectory || "").trim();
    if (!rawValue) {
      return {
        relative: "",
        absolute: "",
      };
    }
    if (path.isAbsolute(rawValue)) {
      const absolute = path.resolve(rawValue);
      const workspaceRelative = toWorkspaceRelativeFromAbsolutePath(absolute);
      return {
        relative: workspaceRelative ? normalizeSessionRootRelativePath(workspaceRelative) : "",
        absolute,
      };
    }
    return {
      relative: normalizeSessionRootRelativePath(rawValue),
      absolute: "",
    };
  }

  function cliSessionEntryMatchesDirectory(entry, lookup) {
    if (!lookup || (!lookup.relative && !lookup.absolute)) return true;
    const entryDirectory = resolveCliSessionEntryDirectory(entry);
    if (lookup.absolute) {
      const entryCwd = String(entry?.cwd || "").trim();
      if (entryCwd && path.resolve(entryCwd) === lookup.absolute) {
        return true;
      }
      if (path.isAbsolute(entryDirectory) && path.resolve(entryDirectory) === lookup.absolute) {
        return true;
      }
      return false;
    }
    if (lookup.relative && entryDirectory === lookup.relative) {
      return true;
    }
    return false;
  }

  async function cliSessionEntryMatchesDirectoryIdentity(entry, lookup) {
    if (cliSessionEntryMatchesDirectory(entry, lookup)) return true;
    if (!lookup?.absolute) return false;
    const cwd = String(entry?.cwd || "").trim();
    if (!cwd) return false;
    let identityPromise = cliSessionCwdIdentityByCwd.get(cwd);
    if (!identityPromise) {
      identityPromise = fileSystem.realpath(cwd).catch(() => path.resolve(cwd));
      cliSessionCwdIdentityByCwd.set(cwd, identityPromise);
    }
    return await identityPromise === lookup.absolute;
  }

  async function listCliSessionsForDirectories(requestedDirectories, opts = {}) {
    await refreshCliSessionIndex({ force: opts?.forceRefresh === true });
    const lookups = (Array.isArray(requestedDirectories) ? requestedDirectories : [])
      .map((directory) => buildDirectoryLookup(directory));
    const entries = [...cliSessionIndexByFilePath.values()];
    return await Promise.all(lookups.map(async (lookup) => {
      const sessions = [];
      for (const entry of entries) {
        if (opts?.includeSubagents === false && entry.isSubagent === true) continue;
        if (!await cliSessionEntryMatchesDirectoryIdentity(entry, lookup)) continue;
        const rolloutUpdatedAt = opts?.useRolloutMtime === true && Number(entry.mtimeMs) > 0
          ? new Date(Math.floor(Number(entry.mtimeMs))).toISOString()
          : "";
        sessions.push({
          sessionId: entry.sessionId,
          directory: lookup.absolute || resolveCliSessionEntryDirectory(entry),
          cwd: entry.cwd,
          updatedAt: pickNewerTimestamp(entry.updatedAt, rolloutUpdatedAt),
          lastReadAt: String(entry.lastReadAt || "").trim(),
          source: "cli",
          filePath: entry.filePath,
          isSubagent: entry.isSubagent === true,
          parentSessionId: String(entry.parentSessionId || "").trim(),
        });
      }
      sessions.sort(compareSessionHistoryEntries);
      return { directory: lookup.absolute || lookup.relative, sessions };
    }));
  }

  async function listCliSessionsForDirectory(requestedDirectory, opts = {}) {
    const [result] = await listCliSessionsForDirectories([requestedDirectory], opts);
    return result?.sessions || [];
  }

  function compareCliSessionIndexEntries(a, b) {
    const aUpdatedAt = normalizeSessionUpdatedAt(a?.updatedAt) || new Date(0).toISOString();
    const bUpdatedAt = normalizeSessionUpdatedAt(b?.updatedAt) || new Date(0).toISOString();
    if (aUpdatedAt !== bUpdatedAt) return bUpdatedAt.localeCompare(aUpdatedAt);
    return String(b?.filePath || "").localeCompare(String(a?.filePath || ""));
  }

  function resolveCliSessionEntryDirectory(entry) {
    const direct = String(entry?.directory || "").trim();
    if (direct) return normalizeSessionRootRelativePath(direct);
    const fromCwd = toWorkspaceRelativeFromAbsolutePath(entry?.cwd);
    return fromCwd ? normalizeSessionRootRelativePath(fromCwd) : "";
  }

  function selectCliSessionIndexEntryBySessionId(sessionId, opts = {}) {
    const normalizedSessionId = normalizeLlmExecutionSessionId(sessionId);
    if (!normalizedSessionId) return null;
    const lookup = buildDirectoryLookup(opts?.directory);
    const candidates = [];
    for (const entry of cliSessionIndexByFilePath.values()) {
      if (String(entry?.sessionId || "") !== normalizedSessionId) continue;
      if (!cliSessionEntryMatchesDirectory(entry, lookup)) continue;
      candidates.push(entry);
    }
    if (candidates.length <= 0) return null;
    candidates.sort(compareCliSessionIndexEntries);
    return candidates[0];
  }

  async function findCliSessionIndexEntryBySessionId(sessionId, opts = {}) {
    await refreshCliSessionIndex();
    const normalizedSessionId = normalizeLlmExecutionSessionId(sessionId);
    if (!normalizedSessionId) return null;
    const lookup = buildDirectoryLookup(opts?.directory);
    const candidates = [];
    for (const entry of cliSessionIndexByFilePath.values()) {
      if (String(entry?.sessionId || "") !== normalizedSessionId) continue;
      if (!await cliSessionEntryMatchesDirectoryIdentity(entry, lookup)) continue;
      candidates.push(entry);
    }
    if (candidates.length <= 0) return null;
    candidates.sort(compareCliSessionIndexEntries);
    return candidates[0];
  }

  async function findCliSessionIndexEntriesBySessionIds(sessionIds, opts = {}) {
    await refreshCliSessionIndex();
    const normalizedIds = [];
    const requestedIds = new Set();
    for (const sessionId of Array.isArray(sessionIds) ? sessionIds : []) {
      const normalized = normalizeLlmExecutionSessionId(sessionId);
      if (!normalized || requestedIds.has(normalized)) continue;
      requestedIds.add(normalized);
      normalizedIds.push(normalized);
    }
    if (normalizedIds.length <= 0) return [];
    const lookup = buildDirectoryLookup(opts?.directory);
    const selectedBySessionId = new Map();
    for (const entry of cliSessionIndexByFilePath.values()) {
      const sessionId = String(entry?.sessionId || "");
      if (!requestedIds.has(sessionId)) continue;
      if (!await cliSessionEntryMatchesDirectoryIdentity(entry, lookup)) continue;
      const current = selectedBySessionId.get(sessionId);
      if (!current || compareCliSessionIndexEntries(entry, current) < 0) {
        selectedBySessionId.set(sessionId, entry);
      }
    }
    return normalizedIds
      .map((sessionId) => selectedBySessionId.get(sessionId))
      .filter(Boolean);
  }

  async function markCliSessionsRead(sessionIds, opts = {}) {
    const normalizedSessionIds = [];
    const seenSessionIds = new Set();
    for (const rawSessionId of Array.isArray(sessionIds) ? sessionIds : []) {
      const sessionId = normalizeLlmExecutionSessionId(rawSessionId);
      if (!sessionId || seenSessionIds.has(sessionId)) continue;
      seenSessionIds.add(sessionId);
      normalizedSessionIds.push(sessionId);
    }
    let lookupMs = 0;
    let persistMs = 0;
    const results = normalizedSessionIds.map((sessionId) => ({
      sessionId,
      updated: false,
      entryFound: false,
    }));
    const lastReadAt = normalizeSessionUpdatedAt(opts?.lastReadAt) || new Date().toISOString();
    const lookup = buildDirectoryLookup(opts?.directory);
    const run = async () => {
      const refreshStartedAtMs = Date.now();
      await refreshCliSessionIndex();
      lookupMs = Math.max(0, Date.now() - refreshStartedAtMs);
      const op = cliSessionIndexWriteQueue.then(async () => {
        const mutationStartedAtMs = Date.now();
        const nextByFilePath = new Map(cliSessionIndexByFilePath);
        let changed = false;
        for (const result of results) {
          const candidates = [];
          for (const entry of nextByFilePath.values()) {
            if (String(entry?.sessionId || "") !== result.sessionId) continue;
            if (!await cliSessionEntryMatchesDirectoryIdentity(entry, lookup)) continue;
            candidates.push(entry);
          }
          candidates.sort(compareCliSessionIndexEntries);
          const entry = candidates[0];
          if (!entry?.filePath) continue;
          result.entryFound = true;
          if (normalizeSessionUpdatedAt(entry.lastReadAt) === lastReadAt) continue;
          const normalized = normalizeCliSessionIndexEntry({ ...entry, lastReadAt });
          if (normalized) {
            nextByFilePath.set(entry.filePath, normalized);
            result.updated = true;
            changed = true;
          }
        }
        lookupMs += Math.max(0, Date.now() - mutationStartedAtMs);
        if (!changed) return;
        const persistStartedAtMs = Date.now();
        await persistCliSessionIndex(nextByFilePath);
        replaceCliSessionIndex(nextByFilePath);
        persistMs = Math.max(0, Date.now() - persistStartedAtMs);
      });
      cliSessionIndexWriteQueue = op.catch(() => {});
      await op;
    };
    const mutation = cliSessionReadMutationQueue.then(run, run);
    cliSessionReadMutationQueue = mutation.catch(() => {});
    await mutation;
    return results.map((result) => ({
      ...result,
      lookupMs,
      rewriteMs: 0,
      persistMs,
    }));
  }

  async function markCliDirectoryRead(directory, opts = {}) {
    const startedAtMs = Date.now();
    const lastReadAt = normalizeSessionUpdatedAt(opts?.lastReadAt) || new Date().toISOString();
    const lookup = buildDirectoryLookup(directory);
    const applyDirectoryRead = async (shouldRefresh) => {
      const scan = shouldRefresh ? await scanCliSessionIndex() : null;
      const op = cliSessionIndexWriteQueue.then(async () => {
        const nextByFilePath = scan?.changed
          ? mergeCliSessionIndexScan(scan)
          : new Map(cliSessionIndexByFilePath);
        const selectedBySessionId = new Map();
        for (const entry of nextByFilePath.values()) {
          if (!await cliSessionEntryMatchesDirectoryIdentity(entry, lookup)) continue;
          const current = selectedBySessionId.get(entry.sessionId);
          if (!current || compareCliSessionIndexEntries(entry, current) < 0) {
            selectedBySessionId.set(entry.sessionId, entry);
          }
        }
        const updatedSessionIds = [];
        for (const [sessionId, entry] of selectedBySessionId.entries()) {
          if (normalizeSessionUpdatedAt(entry.lastReadAt) === lastReadAt) continue;
          const normalized = normalizeCliSessionIndexEntry({ ...entry, lastReadAt });
          if (!normalized) continue;
          nextByFilePath.set(entry.filePath, normalized);
          updatedSessionIds.push(sessionId);
        }
        if (scan?.changed || updatedSessionIds.length > 0) {
          await persistCliSessionIndex(nextByFilePath, {
            metadataComplete: scan?.changed ? true : undefined,
          });
          replaceCliSessionIndex(nextByFilePath);
          if (scan?.changed) cliSessionIndexRequiresMetadataMigration = false;
        }
        return {
          selectedSessionIds: [...selectedBySessionId.keys()],
          updatedSessionIds,
          elapsedMs: Math.max(0, Date.now() - startedAtMs),
        };
      });
      cliSessionIndexWriteQueue = op.catch(() => {});
      return await op;
    };
    const run = async () => {
      while (cliSessionIndexActiveRefreshWave) {
        await cliSessionIndexActiveRefreshWave.promise;
      }
      await ensureCliSessionIndexLoaded();
      while (cliSessionIndexActiveRefreshWave) {
        await cliSessionIndexActiveRefreshWave.promise;
      }
      const shouldRefresh = cliSessionIndexLastRefreshAtMs <= 0
        || (Date.now() - cliSessionIndexLastRefreshAtMs) >= cliSessionIndexRefreshMinIntervalMs;
      const wave = createCliSessionIndexRefreshWave();
      startCliSessionIndexRefreshWave(
        wave,
        () => applyDirectoryRead(shouldRefresh),
        shouldRefresh,
      );
      return await wave.promise;
    };
    const mutation = cliSessionReadMutationQueue.then(run, run);
    cliSessionReadMutationQueue = mutation.catch(() => {});
    return await mutation;
  }

  async function upsertCliSessionIndexEntryFromRolloutFile(filePath, meta = {}) {
    await ensureCliSessionIndexLoaded();
    let stat = null;
    try {
      stat = await fileSystem.stat(filePath);
    } catch {
      return;
    }
    const op = cliSessionIndexWriteQueue.then(async () => {
      const resolvedFilePath = path.resolve(filePath);
      const cached = cliSessionIndexByFilePath.get(resolvedFilePath);
      const fallbackUpdatedAt = normalizeSessionUpdatedAt(meta.updatedAt) || new Date(Math.floor(Number(stat.mtimeMs || Date.now()))).toISOString();
      const normalized = normalizeCliSessionIndexEntry({
        filePath: resolvedFilePath,
        mtimeMs: Number(stat.mtimeMs || 0),
        size: Number(stat.size || 0),
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        directory: meta.directory,
        updatedAt: fallbackUpdatedAt,
        lastReadAt: cached ? cached.lastReadAt : meta.lastReadAt,
        isSubagent: meta.isSubagent ?? cached?.isSubagent,
        parentSessionId: meta.parentSessionId ?? cached?.parentSessionId,
      });
      if (!normalized) return;
      cliSessionIndexByFilePath.set(resolvedFilePath, normalized);
      await persistCliSessionIndex();
    });
    cliSessionIndexWriteQueue = op.catch(() => {});
    await op;
  }

  async function getCliSessionIndexStats() {
    await ensureCliSessionIndexLoaded();
    return {
      entries: cliSessionIndexByFilePath.size,
    };
  }

  return {
    ensureCliSessionIndexLoaded,
    findCliSessionIndexEntriesBySessionIds,
    findCliSessionIndexEntryBySessionId,
    getCliSessionIndexStats,
    listCliSessionsForDirectories,
    listCliSessionsForDirectory,
    markCliDirectoryRead,
    markCliSessionsRead,
    resolveCliSessionEntryDirectory,
    selectCliSessionIndexEntryBySessionId,
    upsertCliSessionIndexEntryFromRolloutFile,
  };
}
