import assert from "node:assert/strict";
import test from "node:test";

import {
  __TESTING__,
  createLlmSessionService,
} from "../src/llm-session-service.mjs";

function createService(overrides = {}) {
  const agentSessionActivityStore = {
    listForDirectories: async (directories) => (
      directories.map((directory) => ({ directory, sessions: [] }))
    ),
    markDirectoryRead: async () => ({ selectedSessionIds: [], updatedSessionIds: [] }),
    markSessionsRead: async () => [],
    ...overrides.agentSessionActivityStore,
  };
  return createLlmSessionService({
    compareSessionHistoryEntries: (a, b) => (
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    ),
    findCliSessionIndexEntriesBySessionIds: async () => [],
    listAcpSessionsForDirectories: async (directories) => (
      directories.map((directory) => ({ directory, sessions: [] }))
    ),
    listAcpSessionsForDirectory: async () => [],
    agentSessionActivityStore,
    listCliSessionsForDirectories: async (directories) => (
      directories.map((directory) => ({ directory, sessions: [] }))
    ),
    listCliSessionsForDirectory: async () => [],
    makeApiError: (apiStatus, error, message, details = {}) => Object.assign(
      new Error(message || error),
      { apiStatus, apiPayload: { error, message, ...details } },
    ),
    markAcpDirectoryRead: async () => ({ selectedSessionIds: [], updatedSessionIds: [] }),
    markAcpSessionsRead: async () => [],
    markCliDirectoryRead: async () => ({ selectedSessionIds: [], updatedSessionIds: [] }),
    markCliSessionsRead: async () => [],
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionListLimit: (value) => Math.max(1, Math.min(100, Number(value) || 20)),
    normalizeSessionSource: (value, fallback) => (
      ["acp", "cli", "all"].includes(value) ? value : fallback
    ),
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    readCliSessionSummaryFromRolloutFile: async () => ({}),
    resolveCanonicalDirectoryIdentity: async (value) => `/canonical${value}`,
    ...overrides,
    agentSessionActivityStore,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

test("batch read updates each store once and singular read keeps the existing response shape", async () => {
  const acpCalls = [];
  const cliCalls = [];
  const service = createService({
    markAcpSessionsRead: async (sessionIds, lastReadAt) => {
      acpCalls.push({ sessionIds, lastReadAt });
      return sessionIds.map((sessionId) => ({
        sessionId,
        updated: sessionId === "acp-only",
        entryFound: sessionId === "acp-only",
        elapsedMs: 3,
      }));
    },
    markCliSessionsRead: async (sessionIds, options) => {
      cliCalls.push({ sessionIds, options });
      return sessionIds.map((sessionId) => ({
        sessionId,
        updated: sessionId === "cli-only",
        entryFound: sessionId === "cli-only",
        lookupMs: 4,
        rewriteMs: 0,
        persistMs: 5,
      }));
    },
  });

  const batch = await service.markLlmSessionsRead(
    ["acp-only", "missing", "cli-only", "acp-only"],
    { directory: "/repo", source: "all", lastReadAt: "2026-08-10T01:00:00.000Z" },
  );
  assert.deepEqual(batch.results.map((result) => ({
    sessionId: result.sessionId,
    updated: result.updated,
    acpFound: result.diagnostics.acpEntryFound,
    cliFound: result.diagnostics.cliEntryFound,
  })), [
    { sessionId: "acp-only", updated: true, acpFound: true, cliFound: false },
    { sessionId: "missing", updated: false, acpFound: false, cliFound: false },
    { sessionId: "cli-only", updated: true, acpFound: false, cliFound: true },
  ]);
  assert.equal(acpCalls.length, 1);
  assert.equal(cliCalls.length, 1);
  assert.deepEqual(acpCalls[0].sessionIds, ["acp-only", "missing", "cli-only"]);
  assert.deepEqual(cliCalls[0].options, {
    directory: "/canonical/repo",
    lastReadAt: "2026-08-10T01:00:00.000Z",
  });

  const singular = await service.markLlmSessionRead("cli-only", {
    directory: "/repo",
    source: "cli",
    lastReadAt: "2026-08-10T02:00:00.000Z",
  });
  assert.equal(singular.sessionId, "cli-only");
  assert.equal(singular.source, "cli");
  assert.equal(singular.updated, true);
  assert.equal(singular.diagnostics.cliEntryFound, true);
});

test("directory read returns bounded unique counts and canonical full success", async () => {
  const calls = [];
  const service = createService({
    markAcpDirectoryRead: async (directory, lastReadAt) => {
      calls.push({ store: "acp", directory, lastReadAt });
      return {
        selectedSessionIds: ["shared", "acp-only"],
        updatedSessionIds: ["shared"],
        elapsedMs: 2,
      };
    },
    markCliDirectoryRead: async (directory, { lastReadAt }) => {
      calls.push({ store: "cli", directory, lastReadAt });
      return {
        selectedSessionIds: ["shared", ...Array.from({ length: 101 }, (_, index) => `cli-${index}`)],
        updatedSessionIds: ["shared", "cli-0"],
        elapsedMs: 3,
      };
    },
  });
  const result = await service.markLlmDirectoryRead("/alias", {
    lastReadAt: "2026-08-10T03:00:00.000Z",
  });
  assert.equal(result.status, "full");
  assert.equal(result.directory, "/canonical/alias");
  assert.equal(result.selectedCount, 103);
  assert.equal(result.updatedCount, 2);
  assert.equal("sessionIds" in result, false);
  assert.deepEqual(calls.map(({ store, directory }) => ({ store, directory })), [
    { store: "acp", directory: "/canonical/alias" },
    { store: "cli", directory: "/canonical/alias" },
  ]);
});

test("directory read deduplicates legacy Codex and Agent identities without merging providers", async () => {
  const codexIdentity = JSON.stringify(["codex", "shared"]);
  const claudeIdentity = JSON.stringify(["claude", "shared"]);
  const service = createService({
    markAcpDirectoryRead: async () => ({ selectedSessionIds: ["shared"], updatedSessionIds: ["shared"] }),
    markCliDirectoryRead: async () => ({ selectedSessionIds: ["shared"], updatedSessionIds: ["shared"] }),
    agentSessionActivityStore: {
      markDirectoryRead: async () => ({
        selectedSessionIds: [codexIdentity, claudeIdentity],
        updatedSessionIds: [codexIdentity, claudeIdentity],
      }),
    },
  });

  const result = await service.markLlmDirectoryRead("/repo", { source: "all" });

  assert.equal(result.selectedCount, 2);
  assert.equal(result.updatedCount, 2);
  assert.equal(result.stores.agent.selectedCount, 2);
});

test("directory read isolates one store failure as partial", async () => {
  const service = createService({
    markAcpDirectoryRead: async () => {
      const error = new Error("secret path must not escape");
      error.code = "EACCES";
      throw error;
    },
    markCliDirectoryRead: async () => ({
      selectedSessionIds: ["cli-only"],
      updatedSessionIds: ["cli-only"],
      elapsedMs: 1,
    }),
  });
  const result = await service.markLlmDirectoryRead("/repo");
  assert.equal(result.status, "partial");
  assert.deepEqual(result.stores.acp, {
    status: "failed",
    selectedCount: 0,
    foundCount: 0,
    updatedCount: 0,
    reason: "eacces",
  });
  assert.equal(JSON.stringify(result).includes("secret path"), false);
});

test("a later mark-unread waits for the earlier directory mutation", async () => {
  const directoryGate = deferred();
  const directoryStarted = deferred();
  const calls = [];
  const service = createService({
    markAcpDirectoryRead: async () => {
      calls.push("directory-start");
      directoryStarted.resolve();
      await directoryGate.promise;
      calls.push("directory-end");
      return { selectedSessionIds: ["target"], updatedSessionIds: ["target"] };
    },
    markCliDirectoryRead: async () => ({ selectedSessionIds: [], updatedSessionIds: [] }),
    markAcpSessionsRead: async (sessionIds) => {
      calls.push("unread");
      return sessionIds.map((sessionId) => ({ sessionId, updated: true, entryFound: true }));
    },
  });
  const directoryRead = service.markLlmDirectoryRead("/repo");
  const laterUnread = service.markLlmSessionRead("target", {
    directory: "/repo",
    source: "acp",
    lastReadAt: new Date(0).toISOString(),
  });
  await directoryStarted.promise;
  assert.deepEqual(calls, ["directory-start"]);
  directoryGate.resolve();
  await Promise.all([directoryRead, laterUnread]);
  assert.deepEqual(calls, ["directory-start", "directory-end", "unread"]);
});

test("summary lookup reads and returns only requested sessions in request order", async () => {
  const indexRequests = [];
  const summaryReads = [];
  const service = createService({
    listAcpSessionsForDirectory: async () => [{
      sessionId: "cli-1",
      source: "acp",
      updatedAt: "2026-07-29T01:30:00.000Z",
      lastReadAt: "2026-07-29T03:00:00.000Z",
    }, {
      sessionId: "acp-1",
      source: "acp",
      updatedAt: "2026-07-29T02:00:00.000Z",
      lastReadAt: "",
    }, {
      sessionId: "not-requested",
      source: "acp",
      updatedAt: "2026-07-29T04:00:00.000Z",
      lastReadAt: "",
    }],
    findCliSessionIndexEntriesBySessionIds: async (sessionIds, options) => {
      indexRequests.push({ sessionIds, options });
      return [{
        sessionId: "cli-1",
        filePath: "/rollouts/cli-1.jsonl",
        updatedAt: "2026-07-29T01:00:00.000Z",
        lastReadAt: "2026-07-29T02:00:00.000Z",
      }];
    },
    readCliSessionSummaryFromRolloutFile: async (filePath) => {
      summaryReads.push(filePath);
      return {
        firstUserMessage: "CLI title",
        contextUsage: { usedTokens: 20 },
        modelRef: "gpt-test",
        reasoningEffort: "high",
      };
    },
  });

  const result = await service.getLlmSessionSummaries({
    directory: "/workspace",
    sessionIds: ["acp-1", "missing", "cli-1", "acp-1"],
  });

  assert.deepEqual(indexRequests, [{
    sessionIds: ["acp-1", "missing", "cli-1"],
    options: { directory: "/canonical/workspace" },
  }]);
  assert.deepEqual(summaryReads, ["/rollouts/cli-1.jsonl"]);
  assert.deepEqual(result.sessions.map((session) => session.sessionId), ["acp-1", "cli-1"]);
  assert.deepEqual(result.missingSessionIds, ["missing"]);
  assert.equal(result.sessions[1].source, "cli");
  assert.equal(result.sessions[1].updatedAt, "2026-07-29T01:30:00.000Z");
  assert.equal(result.sessions[1].lastReadAt, "2026-07-29T03:00:00.000Z");
  assert.equal(result.sessions[1].firstUserMessage, "CLI title");
  assert.equal("filePath" in result.sessions[1], false);
});

test("summary read failure isolates the indexed CLI session as missing", async () => {
  const service = createService({
    listAcpSessionsForDirectory: async () => [{
      sessionId: "cli-1",
      source: "acp",
      updatedAt: "2026-07-29T02:00:00.000Z",
      lastReadAt: "2026-07-29T03:00:00.000Z",
    }],
    findCliSessionIndexEntriesBySessionIds: async () => [{
      sessionId: "cli-1",
      filePath: "/missing.jsonl",
      updatedAt: "2026-07-29T01:00:00.000Z",
      lastReadAt: "",
    }],
    readCliSessionSummaryFromRolloutFile: async () => {
      throw new Error("unreadable");
    },
  });

  const result = await service.getLlmSessionSummaries({
    directory: "/workspace",
    sessionIds: ["cli-1"],
  });

  assert.deepEqual(result.missingSessionIds, ["cli-1"]);
  assert.deepEqual(result.sessions, []);
});

test("session list reads CLI summaries only after applying its limit", async () => {
  const summaryReads = [];
  const service = createService({
    listCliSessionsForDirectory: async () => [
      { sessionId: "new", source: "cli", filePath: "/new", updatedAt: "2026-07-29T02:00:00.000Z" },
      { sessionId: "old", source: "cli", filePath: "/old", updatedAt: "2026-07-29T01:00:00.000Z" },
    ],
    readCliSessionSummaryFromRolloutFile: async (filePath) => {
      summaryReads.push(filePath);
      return {};
    },
  });

  const result = await service.listLlmSessions("/workspace", { source: "cli", limit: 1 });

  assert.deepEqual(result.sessions.map((session) => session.sessionId), ["new"]);
  assert.deepEqual(summaryReads, ["/new"]);
});

test("session list overlays rollout mtime so resumed sessions sort by real activity", async () => {
  const calls = [];
  const service = createService({
    listCliSessionsForDirectory: async (directory, opts) => {
      calls.push({ directory, opts });
      return [];
    },
  });

  await service.listLlmSessions("/workspace", { source: "cli" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts?.useRolloutMtime, true);
  assert.equal("includeSubagents" in calls[0].opts, false);
});

test("session list excludes subagents before paging when includeSubagents is false", async () => {
  const calls = [];
  const service = createService({
    listCliSessionsForDirectory: async (directory, opts) => {
      calls.push({ directory, opts });
      return [];
    },
  });

  await service.listLlmSessions("/workspace", { source: "cli", includeSubagents: false });

  assert.equal(calls[0].opts?.includeSubagents, false);
});

test("session list pages with a keyset cursor and rejects an invalid cursor", async () => {
  const service = createService({
    listCliSessionsForDirectory: async () => [
      { sessionId: "s3", source: "cli", filePath: "/3", updatedAt: "2026-08-21T03:00:00.000Z" },
      { sessionId: "s2", source: "cli", filePath: "/2", updatedAt: "2026-08-21T02:00:00.000Z" },
      { sessionId: "s1", source: "cli", filePath: "/1", updatedAt: "2026-08-21T01:00:00.000Z" },
    ],
  });

  const page1 = await service.listLlmSessions("/workspace", { source: "cli", limit: 2 });
  assert.deepEqual(page1.sessions.map((session) => session.sessionId), ["s3", "s2"]);
  assert.ok(page1.cursor);

  const page2 = await service.listLlmSessions("/workspace", { source: "cli", limit: 2, cursor: page1.cursor });
  assert.deepEqual(page2.sessions.map((session) => session.sessionId), ["s1"]);
  assert.equal("cursor" in page2, false);

  await assert.rejects(
    service.listLlmSessions("/workspace", { source: "cli", limit: 2, cursor: "not-a-cursor" }),
    (error) => error.apiPayload?.error === "invalid_session_list_cursor",
  );
});

test("summary lookup rejects non-array and oversized session id requests", async () => {
  const service = createService();

  await assert.rejects(
    service.getLlmSessionSummaries({ directory: "/workspace", sessionIds: "one" }),
    (error) => error.apiPayload?.error === "invalid_session_ids",
  );
  await assert.rejects(
    service.getLlmSessionSummaries({
      directory: "/workspace",
      sessionIds: Array.from(
        { length: __TESTING__.SESSION_SUMMARY_MAX_IDS + 1 },
        (_, index) => `session-${index}`,
      ),
    }),
    (error) => error.apiPayload?.error === "too_many_session_ids",
  );
});

test("counts exact unread sessions across canonical directories without ACP/CLI double counting", async () => {
  const cliListCalls = [];
  const service = createService({
    listAcpSessionsForDirectories: async (directories) => directories.map((directory) => ({
      directory,
      sessions: directory.endsWith("/one") ? [
        { sessionId: "shared", updatedAt: "2026-08-10T02:00:00.000Z", lastReadAt: "" },
        { sessionId: "read", updatedAt: "2026-08-10T01:00:00.000Z", lastReadAt: "2026-08-10T03:00:00.000Z" },
      ] : [],
    })),
    listCliSessionsForDirectories: async (directories, options) => {
      cliListCalls.push({ directories, options });
      return directories.map((directory) => ({
        directory,
        sessions: directory.endsWith("/one") ? [
          { sessionId: "shared", updatedAt: "2026-08-10T01:00:00.000Z", lastReadAt: "2026-08-10T03:00:00.000Z" },
          { sessionId: "cli-unread", updatedAt: "2026-08-10T04:00:00.000Z", lastReadAt: "2026-08-10T02:00:00.000Z" },
        ] : [
          { sessionId: "other-directory", updatedAt: "2026-08-10T04:00:00.000Z", lastReadAt: "" },
        ],
      }));
    },
  });

  const result = await service.countUnreadSessions(["/one", "/one", "/two"]);
  assert.deepEqual(result.directories, ["/canonical/one", "/canonical/two"]);
  assert.deepEqual(result.directoryCounts, [
    { directory: "/canonical/one", unreadCount: 1 },
    { directory: "/canonical/two", unreadCount: 1 },
  ]);
  assert.equal(result.unreadCount, 2);
  assert.deepEqual(cliListCalls, [{
    directories: ["/canonical/one", "/canonical/two"],
    options: { forceRefresh: true, useRolloutMtime: true, includeSubagents: false },
  }]);
});

test("counts only top-level chats and suppresses subagent push targets", async () => {
  let parentLastReadAt = "";
  const service = createService({
    listCliSessionsForDirectories: async (directories, options) => {
      assert.equal(options.includeSubagents, false);
      return directories.map((directory) => ({
        directory,
        sessions: [{
          sessionId: "parent",
          updatedAt: "2026-08-11T01:00:00.000Z",
          lastReadAt: parentLastReadAt,
        }],
      }));
    },
  });

  assert.equal((await service.countUnreadSessions(["/repo"])).unreadCount, 1);
  const childTarget = await service.getPushUnreadSnapshot({
    directorySets: [["/repo"]],
    targetSessionId: "child-subagent",
    targetDirectory: "/repo",
  });
  assert.equal(childTarget.targetFound, false);
  assert.equal(childTarget.targetUnread, false);
  assert.deepEqual(childTarget.unreadCounts, [1]);

  parentLastReadAt = "2026-08-11T02:00:00.000Z";
  assert.equal((await service.countUnreadSessions(["/repo"])).unreadCount, 0);
});

test("returns one canonical directory count for aliases from the same snapshot", async () => {
  const cliCalls = [];
  const service = createService({
    resolveCanonicalDirectoryIdentity: async () => "/canonical/repo",
    listCliSessionsForDirectories: async (directories, options) => {
      cliCalls.push({ directories, options });
      return directories.map((directory) => ({
        directory,
        sessions: [{
          sessionId: "unread",
          updatedAt: "2026-08-10T04:00:00.000Z",
          lastReadAt: "",
        }],
      }));
    },
  });

  assert.deepEqual(await service.countUnreadSessions(["/repo", "/repo-alias"]), {
    directories: ["/canonical/repo"],
    directoryCounts: [{ directory: "/canonical/repo", unreadCount: 1 }],
    unreadCount: 1,
  });
  assert.deepEqual(cliCalls, [{
    directories: ["/canonical/repo"],
    options: { forceRefresh: true, useRolloutMtime: true, includeSubagents: false },
  }]);
});

test("checks one target session from merged ACP/CLI truth", async () => {
  const service = createService({
    listAcpSessionsForDirectories: async (directories) => directories.map((directory) => ({
      directory,
      sessions: [{
        sessionId: "target",
        updatedAt: "2026-08-10T02:00:00.000Z",
        lastReadAt: "2026-08-10T01:00:00.000Z",
      }],
    })),
    listCliSessionsForDirectories: async (directories, options) => {
      assert.deepEqual(options, { forceRefresh: true, useRolloutMtime: true, includeSubagents: false });
      return directories.map((directory) => ({
        directory,
        sessions: [{
          sessionId: "target",
          updatedAt: "2026-08-10T03:00:00.000Z",
          lastReadAt: "2026-08-10T04:00:00.000Z",
        }],
      }));
    },
  });
  assert.deepEqual(await service.getSessionUnreadState("target", "/repo"), {
    directory: "/canonical/repo",
    backendId: "codex",
    sessionId: "target",
    found: true,
    unread: false,
    updatedAt: "2026-08-10T03:00:00.000Z",
    lastReadAt: "2026-08-10T04:00:00.000Z",
  });
  assert.equal((await service.getSessionUnreadState("missing", "/repo")).found, false);
});

test("keeps Agent unread identity provider-aware when native session ids collide", async () => {
  const service = createService({
    agentSessionActivityStore: {
      listForDirectories: async (directories) => directories.map((directory) => ({
        directory,
        sessions: [{
          backendId: "codex",
          sessionId: "shared",
          updatedAt: "2026-08-10T03:00:00.000Z",
          lastReadAt: "2026-08-10T04:00:00.000Z",
        }, {
          backendId: "claude",
          sessionId: "shared",
          updatedAt: "2026-08-10T05:00:00.000Z",
          lastReadAt: "2026-08-10T02:00:00.000Z",
        }],
      })),
    },
  });

  const codex = await service.getPushUnreadSnapshot({
    directorySets: [["/repo"]],
    targetBackendId: "codex",
    targetSessionId: "shared",
    targetDirectory: "/repo",
  });
  const claude = await service.getPushUnreadSnapshot({
    directorySets: [["/repo"]],
    targetBackendId: "claude",
    targetSessionId: "shared",
    targetDirectory: "/repo",
  });

  assert.equal(codex.targetUnread, false);
  assert.equal(claude.targetUnread, true);
  assert.deepEqual(claude.unreadCounts, [1]);
});

test("marks a Claude CLI-listed session only in provider-aware Agent state", async () => {
  const agentCalls = [];
  const legacyCalls = [];
  const service = createService({
    markAcpSessionsRead: async (...args) => {
      legacyCalls.push({ store: "acp", args });
      return [];
    },
    markCliSessionsRead: async (...args) => {
      legacyCalls.push({ store: "cli", args });
      return [];
    },
    agentSessionActivityStore: {
      markSessionsRead: async (sessionIds, options) => {
        agentCalls.push({ sessionIds, options });
        return sessionIds.map((sessionId) => ({ sessionId, updated: true, entryFound: true }));
      },
    },
  });

  const result = await service.markLlmSessionRead("shared", {
    backendId: "claude",
    directory: "/repo",
    source: "cli",
    lastReadAt: "2026-08-10T06:00:00.000Z",
  });

  assert.deepEqual(agentCalls, [{
    sessionIds: ["shared"],
    options: { backendId: "claude", lastReadAt: "2026-08-10T06:00:00.000Z" },
  }]);
  assert.deepEqual(legacyCalls, []);
  assert.equal(result.agentUpdated, true);
  assert.equal(result.acpUpdated, false);
  assert.equal(result.cliUpdated, false);
  assert.equal(result.diagnostics.agentEntryFound, true);
});

test("derives push target state and deduplicated device counts from one forced snapshot", async () => {
  const cliCalls = [];
  const acpCalls = [];
  let signalAcpSnapshot;
  let releaseAcpSnapshot;
  const acpSnapshotStarted = new Promise((resolve) => { signalAcpSnapshot = resolve; });
  const acpSnapshotGate = new Promise((resolve) => { releaseAcpSnapshot = resolve; });
  let boundaryLastReadAt = "";
  const service = createService({
    listCliSessionsForDirectories: async (directories, options) => {
      cliCalls.push({ directories, options });
      return directories.map((directory) => ({
        directory,
        sessions: directory.endsWith("/device") ? [{
          sessionId: "read-at-boundary",
          updatedAt: "2026-08-10T03:00:00.000Z",
          lastReadAt: "",
        }, {
          sessionId: "device-unread",
          updatedAt: "2026-08-10T04:00:00.000Z",
          lastReadAt: "",
        }] : [{
          sessionId: "target",
          updatedAt: "2026-08-10T05:00:00.000Z",
          lastReadAt: "2026-08-10T01:00:00.000Z",
        }],
      }));
    },
    listAcpSessionsForDirectories: async (directories) => {
      acpCalls.push(directories);
      signalAcpSnapshot();
      await acpSnapshotGate;
      return directories.map((directory) => ({
        directory,
        sessions: directory.endsWith("/device") ? [{
          sessionId: "read-at-boundary",
          updatedAt: "2026-08-10T03:00:00.000Z",
          lastReadAt: boundaryLastReadAt,
        }] : [],
      }));
    },
  });

  const snapshotPending = service.getPushUnreadSnapshot({
    directorySets: [["/device"], ["/device", "/device"]],
    targetSessionId: "target",
    targetDirectory: "/target-outside-device-set",
  });
  await acpSnapshotStarted;
  boundaryLastReadAt = "2026-08-10T06:00:00.000Z";
  releaseAcpSnapshot();
  const result = await snapshotPending;

  assert.deepEqual(cliCalls, [{
    directories: ["/canonical/device", "/canonical/target-outside-device-set"],
    options: { forceRefresh: true, useRolloutMtime: true, includeSubagents: false },
  }]);
  assert.deepEqual(acpCalls, [["/canonical/device", "/canonical/target-outside-device-set"]]);
  assert.equal(result.targetUnread, true);
  assert.deepEqual(result.directorySets, [["/canonical/device"], ["/canonical/device"]]);
  assert.deepEqual(result.unreadCounts, [1, 1]);
});

test("resolves a missing push directory from the registered-directory snapshot", async () => {
  const cliCalls = [];
  const service = createService({
    listCliSessionsForDirectories: async (directories, options) => {
      cliCalls.push({ directories, options });
      return directories.map((directory) => ({
        directory,
        sessions: directory.endsWith("/two") ? [{
          sessionId: "target",
          updatedAt: "2026-08-10T05:00:00.000Z",
          lastReadAt: "",
        }] : [],
      }));
    },
  });

  const result = await service.getPushUnreadSnapshot({
    directorySets: [["/one", "/two"]],
    targetSessionId: "target",
    targetDirectory: "",
  });

  assert.deepEqual(cliCalls, [{
    directories: ["/canonical/one", "/canonical/two"],
    options: { forceRefresh: true, useRolloutMtime: true, includeSubagents: false },
  }]);
  assert.equal(result.directory, "/canonical/two");
  assert.equal(result.targetFound, true);
  assert.equal(result.targetUnread, true);
  assert.deepEqual(result.unreadCounts, [1]);
});

test("suppresses a directory-less push target that is missing or ambiguous", async () => {
  const service = createService({
    listCliSessionsForDirectories: async (directories) => directories.map((directory) => ({
      directory,
      sessions: [{
        sessionId: "ambiguous",
        updatedAt: "2026-08-10T05:00:00.000Z",
        lastReadAt: "",
      }],
    })),
  });

  const ambiguous = await service.getPushUnreadSnapshot({
    directorySets: [["/one", "/two"]],
    targetSessionId: "ambiguous",
    targetDirectory: "",
  });
  assert.equal(ambiguous.directory, "");
  assert.equal(ambiguous.targetFound, false);
  assert.equal(ambiguous.targetUnread, false);

  const missing = await service.getPushUnreadSnapshot({
    directorySets: [["/one", "/two"]],
    targetSessionId: "missing",
    targetDirectory: "",
  });
  assert.equal(missing.directory, "");
  assert.equal(missing.targetFound, false);
  assert.equal(missing.targetUnread, false);
});

test("rejects malformed and oversized unread-count directory requests", async () => {
  const service = createService();
  await assert.rejects(
    service.countUnreadSessions("/workspace"),
    (error) => error.apiPayload?.error === "invalid_directories",
  );
  await assert.rejects(
    service.countUnreadSessions(Array.from(
      { length: __TESTING__.UNREAD_COUNT_MAX_DIRECTORIES + 1 },
      (_, index) => `/workspace-${index}`,
    )),
    (error) => error.apiPayload?.error === "too_many_directories",
  );
});

test("returns zero for an empty directory count without loading either session store", async () => {
  let acpLoads = 0;
  let cliLoads = 0;
  const service = createService({
    listAcpSessionsForDirectories: async () => {
      acpLoads += 1;
      return [];
    },
    listCliSessionsForDirectories: async () => {
      cliLoads += 1;
      return [];
    },
  });

  assert.deepEqual(await service.countUnreadSessions([]), {
    directories: [],
    directoryCounts: [],
    unreadCount: 0,
  });
  assert.equal(acpLoads, 0);
  assert.equal(cliLoads, 0);
});
