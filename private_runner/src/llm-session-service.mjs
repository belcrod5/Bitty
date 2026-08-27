const SESSION_SUMMARY_MAX_IDS = 100;
const SESSION_SUMMARY_READ_WORKERS = 6;
const UNREAD_COUNT_MAX_DIRECTORIES = 100;

function newerTimestamp(first, second) {
  const firstMs = Date.parse(String(first || ""));
  const secondMs = Date.parse(String(second || ""));
  if (!Number.isFinite(firstMs)) return Number.isFinite(secondMs) ? second : "";
  if (!Number.isFinite(secondMs)) return first;
  return secondMs > firstMs ? second : first;
}

async function mapWithWorkers(items, workerCount, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(workerCount, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function createLlmSessionService(deps = {}) {
  const {
    compareSessionHistoryEntries,
    findCliSessionIndexEntriesBySessionIds,
    listAcpSessionsForDirectories,
    listAcpSessionsForDirectory,
    agentSessionActivityStore,
    listAgentSessionSnapshot,
    listCliSessionsForDirectories,
    listCliSessionsForDirectory,
    makeApiError,
    markAcpDirectoryRead,
    markAcpSessionsRead,
    markCliDirectoryRead,
    markCliSessionsRead,
    normalizeLlmExecutionSessionId,
    normalizeSessionListLimit,
    normalizeSessionSource,
    normalizeSessionUpdatedAt,
    readCliSessionSummaryFromRolloutFile,
    resolveCanonicalDirectoryIdentity,
  } = deps;
  let readMutationQueue = Promise.resolve();

  function enqueueReadMutation(run) {
    const mutation = readMutationQueue.then(run, run);
    readMutationQueue = mutation.catch(() => {});
    return mutation;
  }

  async function readCliSummary(entry) {
    const filePath = String(entry?.filePath || "").trim();
    if (!filePath) return null;
    try {
      const summary = await readCliSessionSummaryFromRolloutFile(filePath);
      return {
        firstUserMessage: String(summary?.firstUserMessage || "").trim(),
        contextUsage: summary?.contextUsage || null,
        modelRef: String(summary?.modelRef || "").trim(),
        reasoningEffort: String(summary?.reasoningEffort || "").trim(),
      };
    } catch {
      return null;
    }
  }

  function serializeSession(item, summary) {
    const serialized = {
      ...item,
      firstUserMessage: String(summary?.firstUserMessage || "").trim(),
      contextUsage: summary?.contextUsage || null,
      modelRef: String(summary?.modelRef || "").trim(),
      reasoningEffort: String(summary?.reasoningEffort || "").trim(),
    };
    delete serialized.filePath;
    return serialized;
  }

  // 一覧のページ継続はoffsetでなくkeyset(並び順キー={updatedAt, source, sessionId})。
  // ページ間で新規セッションが増えても、既返却分の重複や取りこぼしが起きない。
  function encodeSessionListPageCursor(entry) {
    return Buffer.from(JSON.stringify({
      updatedAt: String(entry?.updatedAt || ""),
      source: String(entry?.source || ""),
      sessionId: String(entry?.sessionId || ""),
    }), "utf8").toString("base64url");
  }

  function decodeSessionListPageCursor(raw) {
    try {
      const value = JSON.parse(Buffer.from(String(raw || ""), "base64url").toString("utf8"));
      const sessionId = String(value?.sessionId || "").trim();
      if (!sessionId) return null;
      return {
        updatedAt: String(value?.updatedAt || ""),
        source: String(value?.source || ""),
        sessionId,
      };
    } catch {
      return null;
    }
  }

  async function listLlmSessions(rawDirectory, opts = {}) {
    const directory = await resolveCanonicalDirectoryIdentity(rawDirectory);
    const source = normalizeSessionSource(opts?.source, "acp");
    const limit = normalizeSessionListLimit(opts?.limit);
    const cursorRaw = String(opts?.cursor || "").trim();
    const cursorKey = cursorRaw ? decodeSessionListPageCursor(cursorRaw) : null;
    if (cursorRaw && !cursorKey) {
      throw makeApiError(400, "invalid_session_list_cursor", "session list cursor is invalid");
    }
    const sessions = [];
    if (source === "acp" || source === "all") {
      sessions.push(...await listAcpSessionsForDirectory(directory));
    }
    if (source === "cli" || source === "all") {
      // index側updatedAtはrollout先頭session_metaのtimestamp(=セッション開始時刻)で、
      // resumeしても進まない。一覧はrollout実ファイルのmtimeとの新しい方で並べ、
      // 最近使ったセッションが開始時刻順で下位に沈む(=欠落に見える)のを防ぐ。
      // includeSubagents=falseはページング前に除外する(後段フィルタだとページサイズが崩れる)。
      sessions.push(...await listCliSessionsForDirectory(directory, {
        useRolloutMtime: true,
        ...(opts?.includeSubagents === false ? { includeSubagents: false } : {}),
      }));
    }
    sessions.sort(compareSessionHistoryEntries);
    const positioned = cursorKey
      ? sessions.filter((item) => compareSessionHistoryEntries(item, cursorKey) > 0)
      : sessions;
    const limited = positioned.slice(0, limit);
    const nextCursor = positioned.length > limited.length && limited.length > 0
      ? encodeSessionListPageCursor(limited[limited.length - 1])
      : "";
    const summaries = await mapWithWorkers(
      limited,
      SESSION_SUMMARY_READ_WORKERS,
      async (item) => String(item?.source || "").toLowerCase() === "cli"
        ? await readCliSummary(item)
        : null,
    );
    return {
      directory,
      source,
      limit,
      latestSessionId: String(limited[0]?.sessionId || "").trim(),
      // 各項目のcursorは「この項目の位置」。all-backends合成層がページを
      // 全体limitで切った時、Backendごとに実際に返した位置まで進めるために使う。
      sessions: limited.map((item, index) => ({
        ...serializeSession(item, summaries[index]),
        cursor: encodeSessionListPageCursor(item),
      })),
      ...(nextCursor ? { cursor: nextCursor } : {}),
    };
  }

  async function listLlmSessionsForDirectories(rawDirectories, opts = {}) {
    const directories = await Promise.all(
      (Array.isArray(rawDirectories) ? rawDirectories : [])
        .map((directory) => resolveCanonicalDirectoryIdentity(directory)),
    );
    const [acpGroups, cliGroups] = await Promise.all([
      listAcpSessionsForDirectories(directories),
      listCliSessionsForDirectories(directories, {
        forceRefresh: true,
        useRolloutMtime: true,
        ...(opts?.includeSubagents === false ? { includeSubagents: false } : {}),
      }),
    ]);
    return directories.map((directory, index) => {
      const sessionsById = new Map();
      for (const session of [
        ...(acpGroups[index]?.sessions || []),
        ...(cliGroups[index]?.sessions || []),
      ]) {
        const sessionId = String(session?.sessionId || "").trim();
        if (!sessionId) continue;
        const previous = sessionsById.get(sessionId);
        sessionsById.set(sessionId, {
          ...session,
          sessionId,
          directory,
          updatedAt: newerTimestamp(previous?.updatedAt, session?.updatedAt),
          lastReadAt: newerTimestamp(previous?.lastReadAt, session?.lastReadAt),
        });
      }
      return { directory, sessions: Array.from(sessionsById.values()) };
    });
  }

  function normalizeRequestedSessionIds(rawSessionIds) {
    if (!Array.isArray(rawSessionIds)) {
      throw makeApiError(400, "invalid_session_ids", "sessionIds must be an array");
    }
    if (rawSessionIds.length > SESSION_SUMMARY_MAX_IDS) {
      throw makeApiError(400, "too_many_session_ids", "", {
        max: SESSION_SUMMARY_MAX_IDS,
      });
    }
    const ids = [];
    const seen = new Set();
    for (let index = 0; index < rawSessionIds.length; index += 1) {
      const rawSessionId = rawSessionIds[index];
      if (typeof rawSessionId !== "string") {
        throw makeApiError(400, "invalid_session_id", "sessionId must be a string", { index });
      }
      const sessionId = normalizeLlmExecutionSessionId(rawSessionId);
      if (!sessionId) {
        throw makeApiError(400, "invalid_session_id", "sessionId is required", { index });
      }
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      ids.push(sessionId);
    }
    return ids;
  }

  async function performLlmSessionsRead(rawSessionIds, opts = {}) {
    const startedAtMs = Date.now();
    const sessionIds = normalizeRequestedSessionIds(rawSessionIds);
    const directory = await resolveCanonicalDirectoryIdentity(opts?.directory);
    const source = normalizeSessionSource(opts?.source, "all");
    const lastReadAt = normalizeSessionUpdatedAt(opts?.lastReadAt) || new Date().toISOString();
    const backendId = String(opts?.backendId || "codex").trim() || "codex";
    let acpResults = [];
    let agentResults = [];
    let cliResults = [];
    let foundSessionIds = [];

    if (sessionIds.length > 0) {
      const [group] = await listAgentSessionsForDirectories(
        [directory],
        { backendId, includeSubagents: true },
      );
      foundSessionIds = sessionIds.filter((sessionId) => (
        group?.sessionsById.has(JSON.stringify([backendId, sessionId]))
      ));
    }
    if (backendId === "codex" && foundSessionIds.length > 0 && (source === "acp" || source === "all")) {
      acpResults = await markAcpSessionsRead(foundSessionIds, lastReadAt);
    }
    if (backendId === "codex" && foundSessionIds.length > 0 && (source === "cli" || source === "all")) {
      cliResults = await markCliSessionsRead(foundSessionIds, { directory, lastReadAt });
    }
    if (foundSessionIds.length > 0) {
      agentResults = await agentSessionActivityStore.markSessionsRead(foundSessionIds, {
        backendId,
        directory,
        lastReadAt,
      });
    }

    const acpById = new Map(acpResults.map((result) => [result.sessionId, result]));
    const agentById = new Map(agentResults.map((result) => [result.sessionId, result]));
    const cliById = new Map(cliResults.map((result) => [result.sessionId, result]));
    const diagnostics = {
      totalMs: Math.max(0, Date.now() - startedAtMs),
      acpPhaseMs: Math.max(0, Number(acpResults[0]?.elapsedMs || 0)),
      cliLookupMs: Math.max(0, Number(cliResults[0]?.lookupMs || 0)),
      cliRewriteMs: Math.max(0, Number(cliResults[0]?.rewriteMs || 0)),
      cliPersistMs: Math.max(0, Number(cliResults[0]?.persistMs || 0)),
    };
    return {
      backendId,
      directory,
      source,
      lastReadAt,
      results: sessionIds.map((sessionId) => {
        const acpResult = acpById.get(sessionId);
        const agentResult = agentById.get(sessionId);
        const cliResult = cliById.get(sessionId);
        const acpUpdated = Boolean(acpResult?.updated);
        const agentUpdated = Boolean(agentResult?.updated);
        const cliUpdated = Boolean(cliResult?.updated);
        return {
          backendId,
          sessionId,
          directory,
          source,
          lastReadAt,
          updated: acpUpdated || agentUpdated || cliUpdated,
          acpUpdated,
          agentUpdated,
          cliUpdated,
          diagnostics: {
            ...diagnostics,
            acpEntryFound: Boolean(acpResult?.entryFound),
            agentEntryFound: Boolean(agentResult?.entryFound),
            cliEntryFound: Boolean(cliResult?.entryFound),
          },
        };
      }),
      diagnostics,
    };
  }

  async function markLlmSessionsRead(rawSessionIds, opts = {}) {
    return await enqueueReadMutation(() => performLlmSessionsRead(rawSessionIds, opts));
  }

  async function markLlmSessionRead(rawSessionId, opts = {}) {
    const sessionId = normalizeLlmExecutionSessionId(rawSessionId);
    if (!sessionId) throw makeApiError(400, "invalid_session_id", "sessionId is required");
    const batch = await markLlmSessionsRead([sessionId], opts);
    return batch.results[0];
  }

  function storeFailureReason(error) {
    const code = String(error?.code || "").trim().toLowerCase();
    if (/^[a-z0-9_]{1,64}$/.test(code)) return code;
    const name = String(error?.name || "").trim().toLowerCase();
    return /^[a-z0-9_]{1,64}$/.test(name) ? name : "store_error";
  }

  async function performLlmDirectoryRead(rawDirectory, opts = {}) {
    const startedAtMs = Date.now();
    if (typeof rawDirectory !== "string" || !rawDirectory.trim()) {
      throw makeApiError(400, "invalid_directory", "directory is required");
    }
    const directory = await resolveCanonicalDirectoryIdentity(rawDirectory);
    const source = normalizeSessionSource(opts?.source, "all");
    const lastReadAt = normalizeSessionUpdatedAt(opts?.lastReadAt) || new Date().toISOString();
    const [snapshotGroup] = await listAgentSessionsForDirectories(
      [directory],
      { backendId: source === "all" ? "all" : "codex", includeSubagents: true },
    );
    const agentSessionIds = Array.from(snapshotGroup?.sessionsById.keys() || []);
    const stores = [
      {
        name: "acp",
        enabled: source === "acp" || source === "all",
        run: () => markAcpDirectoryRead(directory, lastReadAt),
      },
      {
        name: "agent",
        enabled: source === "all",
        run: async () => {
          await agentSessionActivityStore.markDirectoryRead(directory, lastReadAt);
          return { selectedSessionIds: agentSessionIds, updatedSessionIds: agentSessionIds };
        },
      },
      {
        name: "cli",
        enabled: source === "cli" || source === "all",
        run: () => markCliDirectoryRead(directory, { lastReadAt }),
      },
    ];
    const settled = await Promise.all(stores.map(async (store) => {
      if (!store.enabled) {
        return {
          name: store.name,
          status: "skipped",
          selectedSessionIds: [],
          updatedSessionIds: [],
          elapsedMs: 0,
        };
      }
      if (agentSessionIds.length === 0) {
        return {
          name: store.name,
          status: "success",
          selectedSessionIds: [],
          updatedSessionIds: [],
          elapsedMs: 0,
        };
      }
      try {
        return { name: store.name, status: "success", ...await store.run() };
      } catch (error) {
        return {
          name: store.name,
          status: "failed",
          reason: storeFailureReason(error),
          selectedSessionIds: [],
          updatedSessionIds: [],
          elapsedMs: Math.max(0, Date.now() - startedAtMs),
        };
      }
    }));
    const requested = settled.filter((store) => store.status !== "skipped");
    const succeeded = requested.filter((store) => store.status === "success");
    const providerAwareIds = (store, ids) => ids.map((sessionId) => (
      store.name === "agent" ? sessionId : JSON.stringify(["codex", sessionId])
    ));
    const selectedSessionIds = new Set(succeeded.flatMap((store) => providerAwareIds(store, store.selectedSessionIds)));
    const updatedSessionIds = new Set(succeeded.flatMap((store) => providerAwareIds(store, store.updatedSessionIds)));
    const status = succeeded.length === requested.length
      ? "full"
      : succeeded.length > 0 ? "partial" : "failed";
    return {
      scope: "directory",
      status,
      directory,
      source,
      lastReadAt,
      selectedCount: selectedSessionIds.size,
      foundCount: selectedSessionIds.size,
      updatedCount: updatedSessionIds.size,
      stores: Object.fromEntries(settled.map((store) => [store.name, {
        status: store.status,
        selectedCount: store.selectedSessionIds.length,
        foundCount: store.selectedSessionIds.length,
        updatedCount: store.updatedSessionIds.length,
        ...(store.reason ? { reason: store.reason } : {}),
      }])),
      diagnostics: {
        totalMs: Math.max(0, Date.now() - startedAtMs),
        acpMs: Math.max(0, Number(settled.find((store) => store.name === "acp")?.elapsedMs || 0)),
        cliMs: Math.max(0, Number(settled.find((store) => store.name === "cli")?.elapsedMs || 0)),
      },
    };
  }

  async function markLlmDirectoryRead(rawDirectory, opts = {}) {
    return await enqueueReadMutation(() => performLlmDirectoryRead(rawDirectory, opts));
  }

  async function markLlmSessionReadRequest(rawBody) {
    const body = rawBody && typeof rawBody === "object" ? rawBody : {};
    const directoryScope = body.scope === "directory";
    if (body.scope !== undefined && !directoryScope) {
      throw makeApiError(400, "invalid_read_scope", "scope must be directory");
    }
    if (directoryScope && (body.sessionId !== undefined || body.sessionIds !== undefined)) {
      throw makeApiError(
        400,
        "conflicting_read_targets",
        "directory scope cannot include sessionId or sessionIds",
      );
    }
    const options = {
      directory: body.directory,
      source: body.source,
      backendId: body.backendId,
      lastReadAt: body.lastReadAt,
    };
    if (directoryScope) return await markLlmDirectoryRead(body.directory, options);
    if (body.sessionIds !== undefined) return await markLlmSessionsRead(body.sessionIds, options);
    return await markLlmSessionRead(body.sessionId, options);
  }

  async function getLlmSessionSummaries(rawBody) {
    const body = rawBody && typeof rawBody === "object" ? rawBody : {};
    const rawDirectory = String(body.directory || "").trim();
    if (!rawDirectory) {
      throw makeApiError(400, "invalid_directory", "directory is required");
    }
    const sessionIds = normalizeRequestedSessionIds(body.sessionIds);
    const directory = await resolveCanonicalDirectoryIdentity(rawDirectory);
    if (sessionIds.length <= 0) {
      return { directory, sessions: [], missingSessionIds: [] };
    }

    const acpSessions = await listAcpSessionsForDirectory(directory);
    const acpBySessionId = new Map(
      acpSessions
        .filter((item) => sessionIds.includes(String(item?.sessionId || "")))
        .map((item) => [String(item.sessionId), item]),
    );
    const cliEntries = await findCliSessionIndexEntriesBySessionIds(sessionIds, { directory });
    const cliBySessionId = new Map(
      cliEntries.map((item) => [String(item?.sessionId || ""), item]),
    );
    const cliSummaries = await mapWithWorkers(
      cliEntries,
      SESSION_SUMMARY_READ_WORKERS,
      readCliSummary,
    );
    const summaryBySessionId = new Map(
      cliEntries.map((entry, index) => [String(entry?.sessionId || ""), cliSummaries[index]]),
    );
    const sessions = [];
    const missingSessionIds = [];

    for (const sessionId of sessionIds) {
      const acp = acpBySessionId.get(sessionId);
      const cli = cliBySessionId.get(sessionId);
      const summary = summaryBySessionId.get(sessionId);
      if (cli) {
        if (!summary) {
          missingSessionIds.push(sessionId);
          continue;
        }
        sessions.push(serializeSession({
          ...cli,
          directory,
          source: "cli",
          updatedAt: newerTimestamp(cli.updatedAt, acp?.updatedAt),
          lastReadAt: newerTimestamp(cli.lastReadAt, acp?.lastReadAt),
        }, summary));
        continue;
      }
      if (acp) {
        sessions.push(serializeSession({
          ...acp,
          directory,
          source: "acp",
        }, null));
        continue;
      }
      missingSessionIds.push(sessionId);
    }

    return { directory, sessions, missingSessionIds };
  }

  function isMergedSessionUnread(session) {
    const updatedAtMs = Date.parse(String(session?.updatedAt || ""));
    const lastReadAtMs = Date.parse(String(session?.lastReadAt || ""));
    return Number.isFinite(updatedAtMs) && (
      !Number.isFinite(lastReadAtMs) || updatedAtMs > lastReadAtMs
    );
  }

  async function normalizeUnreadDirectories(rawDirectories) {
    if (!Array.isArray(rawDirectories)) {
      throw makeApiError(400, "invalid_directories", "directories must be an array");
    }
    if (rawDirectories.length > UNREAD_COUNT_MAX_DIRECTORIES) {
      throw makeApiError(400, "too_many_directories", "", {
        max: UNREAD_COUNT_MAX_DIRECTORIES,
      });
    }
    const directories = [];
    const seenDirectories = new Set();
    for (let index = 0; index < rawDirectories.length; index += 1) {
      if (typeof rawDirectories[index] !== "string" || !rawDirectories[index].trim()) {
        throw makeApiError(400, "invalid_directory", "directory must be a non-empty string", { index });
      }
      const directory = await resolveCanonicalDirectoryIdentity(rawDirectories[index]);
      if (seenDirectories.has(directory)) continue;
      seenDirectories.add(directory);
      directories.push(directory);
    }
    return directories;
  }

  async function listAgentSessionsForDirectories(
    directories,
    { backendId = "all", includeSubagents = false } = {},
  ) {
    const snapshot = await listAgentSessionSnapshot({ backendId, cwds: directories, includeSubagents });
    return (Array.isArray(snapshot?.groups) ? snapshot.groups : []).map((group) => {
      const directory = String(group?.cwd || "").trim();
      const sessions = [];
      for (const session of Array.isArray(group?.sessions) ? group.sessions : []) {
        const backendId = String(session?.sessionRef?.backendId || "").trim();
        const sessionId = String(session?.sessionRef?.nativeSessionId || "").trim();
        if (!backendId || !sessionId) continue;
        sessions.push({
          backendId,
          sessionId,
          directory,
          updatedAt: String(session?.updatedAt || ""),
          lastReadAt: String(session?.lastReadAt || ""),
        });
      }
      return {
        directory,
        sessionsById: new Map(sessions.map((session) => [
          JSON.stringify([session.backendId, session.sessionId]),
          session,
        ])),
      };
    });
  }

  async function loadUnreadSessionSnapshot(directories) {
    return await listAgentSessionsForDirectories(directories, { backendId: "all" });
  }

  async function getPushUnreadSnapshot({ directorySets, targetBackendId = "codex", targetSessionId, targetDirectory }) {
    if (!Array.isArray(directorySets)) {
      throw makeApiError(400, "invalid_directory_sets", "directorySets must be an array");
    }
    const sessionId = normalizeLlmExecutionSessionId(targetSessionId);
    if (!sessionId) throw makeApiError(400, "invalid_session_id", "sessionId is required");
    const backendId = String(targetBackendId || "").trim();
    if (!backendId) throw makeApiError(400, "invalid_backend_id", "backendId is required");
    const targetIdentity = JSON.stringify([backendId, sessionId]);
    const canonicalDirectorySets = await Promise.all(
      directorySets.map((directories) => normalizeUnreadDirectories(directories)),
    );
    const [requestedDirectory] = String(targetDirectory || "").trim()
      ? await normalizeUnreadDirectories([targetDirectory])
      : [];
    const allDirectories = [];
    const seenDirectories = new Set();
    for (const candidate of [...canonicalDirectorySets.flat(), requestedDirectory].filter(Boolean)) {
      if (seenDirectories.has(candidate)) continue;
      seenDirectories.add(candidate);
      allDirectories.push(candidate);
    }
    const mergedGroups = allDirectories.length > 0
      ? await loadUnreadSessionSnapshot(allDirectories)
      : [];
    const sessionsByDirectory = new Map(
      mergedGroups.map((group) => [group.directory, group.sessionsById]),
    );
    let directory = requestedDirectory || "";
    let target = directory ? sessionsByDirectory.get(directory)?.get(targetIdentity) : undefined;
    if (!directory) {
      const matches = mergedGroups.filter((group) => group.sessionsById.has(targetIdentity));
      if (matches.length === 1) {
        directory = matches[0].directory;
        target = matches[0].sessionsById.get(targetIdentity);
      }
    }
    const unreadCountByDirectorySet = new Map();
    const unreadCounts = canonicalDirectorySets.map((directories) => {
      const key = [...directories].sort().join("\u0000");
      if (unreadCountByDirectorySet.has(key)) return unreadCountByDirectorySet.get(key);
      let unreadCount = 0;
      for (const selectedDirectory of directories) {
        for (const session of sessionsByDirectory.get(selectedDirectory)?.values() || []) {
          if (isMergedSessionUnread(session)) unreadCount += 1;
        }
      }
      unreadCountByDirectorySet.set(key, unreadCount);
      return unreadCount;
    });
    return {
      directory,
      backendId,
      sessionId,
      targetFound: Boolean(target),
      targetUnread: isMergedSessionUnread(target),
      directorySets: canonicalDirectorySets,
      unreadCounts,
    };
  }

  async function getSessionUnreadState(rawSessionId, rawDirectory, rawBackendId = "codex") {
    const sessionId = normalizeLlmExecutionSessionId(rawSessionId);
    if (!sessionId) throw makeApiError(400, "invalid_session_id", "sessionId is required");
    const backendId = String(rawBackendId || "").trim();
    if (!backendId) throw makeApiError(400, "invalid_backend_id", "backendId is required");
    const directory = await resolveCanonicalDirectoryIdentity(rawDirectory);
    const [group] = await loadUnreadSessionSnapshot([directory]);
    const session = group?.sessionsById.get(JSON.stringify([backendId, sessionId]));
    return {
      directory,
      backendId,
      sessionId,
      found: Boolean(session),
      unread: isMergedSessionUnread(session),
      updatedAt: String(session?.updatedAt || ""),
      lastReadAt: String(session?.lastReadAt || ""),
    };
  }

  async function countUnreadSessions(rawDirectories) {
    const directories = await normalizeUnreadDirectories(rawDirectories);
    if (directories.length === 0) {
      return { directories: [], directoryCounts: [], unreadCount: 0 };
    }
    const groups = await loadUnreadSessionSnapshot(directories);
    const directoryCounts = groups.map((group) => {
      let unreadCount = 0;
      for (const session of group.sessionsById.values()) {
        if (isMergedSessionUnread(session)) unreadCount += 1;
      }
      return { directory: group.directory, unreadCount };
    });
    return {
      directories,
      directoryCounts,
      unreadCount: directoryCounts.reduce((sum, item) => sum + item.unreadCount, 0),
    };
  }

  return {
    countUnreadSessions,
    getLlmSessionSummaries,
    getPushUnreadSnapshot,
    getSessionUnreadState,
    listLlmSessions,
    listLlmSessionsForDirectories,
    listAgentSessionsForDirectories,
    markLlmDirectoryRead,
    markLlmSessionRead,
    markLlmSessionReadRequest,
    markLlmSessionsRead,
    normalizeRequestedSessionIds,
  };
}

export const __TESTING__ = {
  SESSION_SUMMARY_MAX_IDS,
  SESSION_SUMMARY_READ_WORKERS,
  UNREAD_COUNT_MAX_DIRECTORIES,
};
