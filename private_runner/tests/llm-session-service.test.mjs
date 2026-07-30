import assert from "node:assert/strict";
import test from "node:test";

import {
  __TESTING__,
  createLlmSessionService,
} from "../src/llm-session-service.mjs";

function createService(overrides = {}) {
  return createLlmSessionService({
    compareSessionHistoryEntries: (a, b) => (
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    ),
    findCliSessionIndexEntriesBySessionIds: async () => [],
    listAcpSessionsForDirectory: async () => [],
    listCliSessionsForDirectory: async () => [],
    makeApiError: (apiStatus, error, message, details = {}) => Object.assign(
      new Error(message || error),
      { apiStatus, apiPayload: { error, message, ...details } },
    ),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionListLimit: (value) => Math.max(1, Math.min(100, Number(value) || 20)),
    normalizeSessionSource: (value, fallback) => (
      ["acp", "cli", "all"].includes(value) ? value : fallback
    ),
    readCliSessionSummaryFromRolloutFile: async () => ({}),
    resolveCanonicalDirectoryIdentity: async (value) => `/canonical${value}`,
    ...overrides,
  });
}

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
