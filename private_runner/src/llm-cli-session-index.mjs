import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

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

  let cliSessionIndexLoadPromise = null;
  let cliSessionIndexWriteQueue = Promise.resolve();
  const cliSessionIndexByFilePath = new Map();
  let cliSessionIndexLastRefreshAtMs = 0;
  let cliSessionIndexRefreshPromise = null;
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
    };
  }

  function buildCliSessionIndexPayload() {
    const entries = Array.from(cliSessionIndexByFilePath.values())
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
    return {
      version: 2,
      updatedAt: new Date().toISOString(),
      sessionsDir: codeCliSessionsDir,
      entries,
    };
  }

  async function loadCliSessionIndex() {
    let parsed = {};
    try {
      const raw = await fs.readFile(cliSessionIndexPath, "utf8");
      parsed = raw ? JSON.parse(raw) : {};
    } catch (err) {
      if (!err || typeof err !== "object" || err.code !== "ENOENT") {
        throw err;
      }
    }
    cliSessionIndexByFilePath.clear();
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

  async function persistCliSessionIndex() {
    const parentDir = path.dirname(cliSessionIndexPath);
    await fs.mkdir(parentDir, { recursive: true });
    const payload = buildCliSessionIndexPayload();
    const tmpPath = `${cliSessionIndexPath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    await fs.rename(tmpPath, cliSessionIndexPath);
  }

  async function listCliSessionRolloutFiles(rootDir) {
    const files = [];
    const queue = [path.resolve(rootDir)];
    while (queue.length > 0) {
      const currentDir = queue.pop();
      let entries = [];
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
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
      handle = await fs.open(filePath, "r");
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
          return {
            sessionId,
            cwd,
            directory: directoryCandidate ? normalizeSessionRootRelativePath(directoryCandidate) : "",
            updatedAt,
            lastReadAt: lastReadAt || "",
            modelRef,
            reasoningEffort: reasoningEffort || "",
          };
        }
      }
      return null;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function refreshCliSessionIndex() {
    if (cliSessionIndexRefreshPromise) {
      await cliSessionIndexRefreshPromise;
      return;
    }
    const now = Date.now();
    if (
      cliSessionIndexLastRefreshAtMs > 0 &&
      (now - cliSessionIndexLastRefreshAtMs) < cliSessionIndexRefreshMinIntervalMs
    ) {
      return;
    }
    const refreshOp = (async () => {
      await ensureCliSessionIndexLoaded();
      const files = await listCliSessionRolloutFiles(codeCliSessionsDir);
      const previousByFilePath = new Map(cliSessionIndexByFilePath);
      const nextByFilePath = new Map();
      let changed = false;

      for (const filePath of files) {
        let stat = null;
        try {
          stat = await fs.stat(filePath);
        } catch {
          changed = true;
          continue;
        }
        const mtimeMs = Number(stat.mtimeMs || 0);
        const size = Number(stat.size || 0);
        const cached = previousByFilePath.get(filePath);
        previousByFilePath.delete(filePath);
        if (
          cached &&
          Number(cached.mtimeMs || 0) === mtimeMs &&
          Number(cached.size || 0) === size
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
          lastReadAt: meta.lastReadAt,
        });
        if (!normalized) continue;
        nextByFilePath.set(filePath, normalized);
      }

      if (previousByFilePath.size > 0) {
        changed = true;
      }
      if (!changed) return;

      cliSessionIndexByFilePath.clear();
      for (const [filePath, entry] of nextByFilePath.entries()) {
        cliSessionIndexByFilePath.set(filePath, entry);
      }
      const op = cliSessionIndexWriteQueue.then(async () => {
        await persistCliSessionIndex();
      });
      cliSessionIndexWriteQueue = op.catch(() => {});
      await op;
    })();
    cliSessionIndexRefreshPromise = refreshOp;
    try {
      await refreshOp;
      cliSessionIndexLastRefreshAtMs = Date.now();
    } finally {
      cliSessionIndexRefreshPromise = null;
    }
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
      identityPromise = fs.realpath(cwd).catch(() => path.resolve(cwd));
      cliSessionCwdIdentityByCwd.set(cwd, identityPromise);
    }
    return await identityPromise === lookup.absolute;
  }

  async function listCliSessionsForDirectory(requestedDirectory) {
    await refreshCliSessionIndex();
    const lookup = buildDirectoryLookup(requestedDirectory);
    const sessions = [];
    for (const entry of cliSessionIndexByFilePath.values()) {
      if (!await cliSessionEntryMatchesDirectoryIdentity(entry, lookup)) continue;
      sessions.push({
        sessionId: entry.sessionId,
        directory: lookup.absolute || resolveCliSessionEntryDirectory(entry),
        cwd: entry.cwd,
        updatedAt: entry.updatedAt,
        lastReadAt: String(entry.lastReadAt || "").trim(),
        source: "cli",
        filePath: entry.filePath,
      });
    }
    sessions.sort(compareSessionHistoryEntries);
    return sessions;
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

  async function rewriteCliSessionMetaLastReadAt(filePath, lastReadAtRaw) {
    const lastReadAt = normalizeSessionUpdatedAt(lastReadAtRaw) || new Date().toISOString();
    let raw = "";
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      return { updated: false, sessionId: "" };
    }
    if (!raw) return { updated: false, sessionId: "" };
    const lineEndIndex = raw.indexOf("\n");
    const firstLine = (lineEndIndex >= 0 ? raw.slice(0, lineEndIndex) : raw).trim();
    if (!firstLine) return { updated: false, sessionId: "" };
    let parsedFirstLine = null;
    try {
      parsedFirstLine = JSON.parse(firstLine);
    } catch {
      return { updated: false, sessionId: "" };
    }
    if (String(parsedFirstLine?.type || "") !== "session_meta") return { updated: false, sessionId: "" };
    const existingPayload = parsedFirstLine?.payload && typeof parsedFirstLine.payload === "object"
      ? parsedFirstLine.payload
      : null;
    if (!existingPayload) return { updated: false, sessionId: "" };
    let sessionId = "";
    try {
      sessionId = normalizeLlmExecutionSessionId(existingPayload?.id);
    } catch {
      sessionId = "";
    }
    if (!sessionId) return { updated: false, sessionId: "" };
    const currentLastReadAt = normalizeSessionUpdatedAt(existingPayload?.last_read_at);
    if (currentLastReadAt === lastReadAt) {
      return { updated: false, sessionId };
    }
    const replacementEntry = {
      ...parsedFirstLine,
      payload: {
        ...existingPayload,
        last_read_at: lastReadAt,
      },
    };
    const replacementLine = JSON.stringify(replacementEntry);
    const remainder = lineEndIndex >= 0 ? raw.slice(lineEndIndex + 1) : "";
    const nextRaw = `${replacementLine}\n${remainder}`;
    if (nextRaw === raw) return { updated: false, sessionId };
    await fs.writeFile(filePath, nextRaw, "utf8");
    return { updated: true, sessionId };
  }

  async function markCliSessionRead(sessionId, opts = {}) {
    let updated = false;
    let lookupMs = 0;
    let rewriteMs = 0;
    let persistMs = 0;
    let entryFound = false;

    const lookupStartedAtMs = Date.now();
    const entry = await findCliSessionIndexEntryBySessionId(sessionId, {
      directory: opts?.directory,
    });
    lookupMs = Math.max(0, Date.now() - lookupStartedAtMs);
    entryFound = Boolean(entry && entry.filePath);
    if (entry && entry.filePath) {
      const rewriteStartedAtMs = Date.now();
      const writeResult = await rewriteCliSessionMetaLastReadAt(entry.filePath, opts?.lastReadAt);
      rewriteMs = Math.max(0, Date.now() - rewriteStartedAtMs);
      if (writeResult.updated) {
        const normalized = normalizeCliSessionIndexEntry({
          ...entry,
          lastReadAt: opts?.lastReadAt,
        });
        if (normalized) {
          cliSessionIndexByFilePath.set(entry.filePath, normalized);
          const persistStartedAtMs = Date.now();
          const op = cliSessionIndexWriteQueue.then(async () => {
            await persistCliSessionIndex();
          });
          cliSessionIndexWriteQueue = op.catch(() => {});
          await op;
          persistMs = Math.max(0, Date.now() - persistStartedAtMs);
        }
        updated = true;
      }
    }

    return {
      updated,
      lookupMs,
      rewriteMs,
      persistMs,
      entryFound,
    };
  }

  async function upsertCliSessionIndexEntryFromRolloutFile(filePath, meta = {}) {
    let stat = null;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }
    const fallbackUpdatedAt = normalizeSessionUpdatedAt(meta.updatedAt) || new Date(Math.floor(Number(stat.mtimeMs || Date.now()))).toISOString();
    const normalized = normalizeCliSessionIndexEntry({
      filePath,
      mtimeMs: Number(stat.mtimeMs || 0),
      size: Number(stat.size || 0),
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      directory: meta.directory,
      updatedAt: fallbackUpdatedAt,
      lastReadAt: meta.lastReadAt,
    });
    if (!normalized) return;
    cliSessionIndexByFilePath.set(filePath, normalized);
    const op = cliSessionIndexWriteQueue.then(async () => {
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
    findCliSessionIndexEntryBySessionId,
    getCliSessionIndexStats,
    listCliSessionsForDirectory,
    markCliSessionRead,
    resolveCliSessionEntryDirectory,
    selectCliSessionIndexEntryBySessionId,
    upsertCliSessionIndexEntryFromRolloutFile,
  };
}
