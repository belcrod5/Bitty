const SESSION_SUMMARY_MAX_IDS = 100;
const SESSION_SUMMARY_READ_WORKERS = 6;

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
    listAcpSessionsForDirectory,
    listCliSessionsForDirectory,
    makeApiError,
    normalizeLlmExecutionSessionId,
    normalizeSessionListLimit,
    normalizeSessionSource,
    readCliSessionSummaryFromRolloutFile,
    resolveCanonicalDirectoryIdentity,
  } = deps;

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

  async function listLlmSessions(rawDirectory, opts = {}) {
    const directory = await resolveCanonicalDirectoryIdentity(rawDirectory);
    const source = normalizeSessionSource(opts?.source, "acp");
    const limit = normalizeSessionListLimit(opts?.limit);
    const sessions = [];
    if (source === "acp" || source === "all") {
      sessions.push(...await listAcpSessionsForDirectory(directory));
    }
    if (source === "cli" || source === "all") {
      sessions.push(...await listCliSessionsForDirectory(directory));
    }
    sessions.sort(compareSessionHistoryEntries);
    const limited = sessions.slice(0, limit);
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
      sessions: limited.map((item, index) => serializeSession(item, summaries[index])),
    };
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

  return {
    getLlmSessionSummaries,
    listLlmSessions,
  };
}

export const __TESTING__ = {
  SESSION_SUMMARY_MAX_IDS,
  SESSION_SUMMARY_READ_WORKERS,
};
