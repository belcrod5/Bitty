import assert from "node:assert/strict";
import test from "node:test";

import { createAgentService } from "../src/agent/agent-service.mjs";

function createConversationService({ sessions, readHistory, allowedCwds = ["/workspace"] }) {
  const backend = {
    backendId: "test",
    getStatus: async () => ({
      backendId: "test",
      readiness: { ready: true },
      capabilities: { session: { list: true, history: { read: true } } },
    }),
    resolveSessionCwd: async (sessionRef) => sessions
      .find((session) => session.sessionRef.nativeSessionId === sessionRef.nativeSessionId)?.canonicalCwd
      || "/workspace",
    async listSessionsForDirectories({ cwds }) {
      return {
        groups: cwds.map((cwd) => ({
          cwd,
          sessions: sessions.filter((session) => session.canonicalCwd === cwd),
        })),
      };
    },
    readHistory,
  };
  const admitted = [];
  const service = createAgentService({
    backends: [backend],
    operationStore: { claim: async () => ({}), complete: async () => ({}) },
    sessionStore: {
      bind: async () => ({ status: "bound" }),
      getBinding: async () => null,
      getMode: async () => null,
      acquire: async () => ({ status: "acquired", lease: {} }),
      settle: async () => ({ status: "released" }),
      updateIdentity: async () => ({}),
      handoff: async () => ({}),
      setSettings: async () => ({}),
      recordActivity: async () => ({}),
      getReadState: async () => null,
    },
    workspaceAdmission: {
      async assertAllowed(subjectId, cwd) {
        assert.equal(subjectId, "owner");
        assert.ok(allowedCwds.includes(cwd));
        admitted.push(cwd);
        return cwd;
      },
    },
    resolveCanonicalCwd: async (cwd) => cwd,
  });
  return { service, admitted };
}

test("conversation search returns only bounded user and assistant text and resumes with its cursor", async () => {
  const sessionRef = { backendId: "test", nativeSessionId: "session-1" };
  const calls = [];
  const pages = new Map([
    ["", {
      items: [
        { id: "user-1", role: "user", content: [{ type: "text", text: `before needle ${"x".repeat(500)}` }] },
        { id: "tool-1", role: "assistant", itemType: "status_log", content: [{ type: "text", text: "needle status" }] },
        { id: "thinking-1", role: "assistant", itemType: "thinking", content: [{ type: "text", text: "needle thought" }] },
        { id: "sidechain-1", role: "assistant", itemType: "sidechain", content: [{ type: "text", text: "needle sidechain" }] },
        { id: "internal-1", role: "user", itemType: "internal_context", content: [{ type: "text", text: "needle reminder" }] },
        { id: "system-1", role: "system", content: [{ type: "text", text: "needle system" }] },
        { id: "tool-block", role: "assistant", content: [{ type: "tool", resultSummary: "needle output" }] },
      ],
      olderCursor: "older-1",
    }],
    ["older-1", {
      items: [{ id: "assistant-1", role: "assistant", content: [{ type: "text", text: "another needle answer" }] }],
      olderCursor: null,
    }],
  ]);
  const { service, admitted } = createConversationService({
    sessions: [{ sessionRef, canonicalCwd: "/workspace", updatedAt: "2026-08-29T01:00:00.000Z" }],
    async readHistory(options) {
      calls.push(options);
      return pages.get(options.cursor || "");
    },
  });

  const first = await service.searchConversationHistory({
    query: "needle", cwds: ["/workspace"], backendId: "all", limit: 10,
  }, { subjectId: "owner" });
  assert.equal(first.results.length, 1);
  assert.deepEqual(first.results[0].sessionRef, sessionRef);
  assert.equal(first.results[0].role, "user");
  assert.ok(first.results[0].snippet.length <= 320);
  assert.equal(Object.hasOwn(first.results[0], "text"), false);
  assert.ok(first.results[0].conversationCursor);
  assert.ok(first.cursor);

  const selectedContext = await service.readConversationHistory({
    sessionRef, cursor: first.results[0].conversationCursor, limit: 3,
  }, { subjectId: "owner" });
  assert.deepEqual(selectedContext.items, [{
    id: "user-1", role: "user", text: `before needle ${"x".repeat(500)}`,
    sectionStart: 0, sectionEnd: 514, focusStart: 7, focusEnd: 13,
  }]);
  assert.equal(selectedContext.focused, true);

  const second = await service.searchConversationHistory({
    query: "needle", cwds: ["/workspace"], backendId: "all", limit: 10, cursor: first.cursor,
  }, { subjectId: "owner" });
  assert.deepEqual(second.results.map((result) => result.messageId), ["assistant-1"]);
  assert.equal(second.cursor, undefined);
  assert.deepEqual(calls.map((call) => call.cursor || ""), ["", "", "older-1"]);
  assert.deepEqual(admitted, ["/workspace", "/workspace", "/workspace"]);
});

test("conversation search stops at the scan budget and continues without an index", async () => {
  const sessionRef = { backendId: "test", nativeSessionId: "large-session" };
  let calls = 0;
  const { service } = createConversationService({
    sessions: [{ sessionRef, canonicalCwd: "/workspace", updatedAt: "2026-08-29T01:00:00.000Z" }],
    async readHistory({ cursor }) {
      calls += 1;
      const page = cursor ? Number(cursor.slice(1)) : 0;
      return {
        items: Array.from({ length: 20 }, (_, index) => ({
          id: `${page}-${index}`,
          role: "assistant",
          content: [{ type: "text", text: page === 20 && index === 0 ? "target" : "ordinary" }],
        })),
        olderCursor: page < 20 ? `p${page + 1}` : null,
      };
    },
  });

  const first = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], backendId: "test", limit: 20,
  }, { subjectId: "owner" });
  assert.deepEqual(first.results, []);
  assert.deepEqual(first.scanned, { sessions: 1, items: 360, pages: 18 });
  assert.ok(first.cursor);
  assert.equal(calls, 18);

  const second = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], backendId: "test", limit: 20, cursor: first.cursor,
  }, { subjectId: "owner" });
  assert.deepEqual(second.results.map((result) => result.messageId), ["20-0"]);
  assert.deepEqual(second.scanned, { sessions: 1, items: 60, pages: 3 });
  assert.equal(calls, 21);
});

test("conversation search keeps excess matches on the same backend page behind its opaque cursor", async () => {
  const sessionRef = { backendId: "test", nativeSessionId: "matching-session" };
  let calls = 0;
  const { service } = createConversationService({
    sessions: [{ sessionRef, canonicalCwd: "/workspace" }],
    async readHistory() {
      calls += 1;
      return {
        items: Array.from({ length: 25 }, (_, index) => ({
          id: String(index), role: "assistant", content: [{ type: "text", text: `target ${index}` }],
        })),
        olderCursor: null,
      };
    },
  });

  const first = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], limit: 20,
  }, { subjectId: "owner" });
  assert.equal(first.results.length, 20);
  assert.ok(first.cursor);
  const second = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], limit: 20, cursor: first.cursor,
  }, { subjectId: "owner" });
  assert.equal(second.results.length, 5);
  assert.equal(second.cursor, undefined);
  assert.equal(new Set([...first.results, ...second.results].map((result) => result.messageId)).size, 25);
  assert.equal(calls, 2);
});

test("search and focused read use the same fixed backend page shape", async () => {
  const sessionRef = { backendId: "test", nativeSessionId: "limit-session" };
  const requestedLimits = [];
  const allItems = Array.from({ length: 80 }, (_, index) => ({
    id: String(index),
    role: "assistant",
    content: [{ type: "text", text: index === 79 ? `target ${"x".repeat(5_000)}` : "ordinary" }],
  }));
  const { service } = createConversationService({
    sessions: [{ sessionRef, canonicalCwd: "/workspace" }],
    async readHistory({ cursor, limit }) {
      requestedLimits.push(limit);
      const end = cursor ? Number(cursor) : allItems.length;
      const start = Math.max(0, end - limit);
      return { items: allItems.slice(start, end), olderCursor: start > 0 ? String(start) : null };
    },
  });

  const search = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], limit: 1,
  }, { subjectId: "owner" });
  const section = await service.readConversationHistory({
    sessionRef, cursor: search.results[0].conversationCursor, limit: 5,
  }, { subjectId: "owner" });

  assert.deepEqual(requestedLimits, [50, 50]);
  assert.equal(section.focused, true);
  assert.ok(section.items[0].text.includes("target"));
  assert.ok(section.totalChars <= 2_400);
});

test("search continuation keeps the fixed page after scanning an earlier page", async () => {
  const sessionRef = { backendId: "test", nativeSessionId: "continued-session" };
  const requested = [];
  const pages = {
    "": Array.from({ length: 50 }, (_, index) => ({
      id: `new-${index}`, role: "assistant", content: [{ type: "text", text: "ordinary" }],
    })),
    older: Array.from({ length: 50 }, (_, index) => ({
      id: `old-${index}`, role: "assistant", content: [{ type: "text", text: `target ${index}` }],
    })),
  };
  const { service } = createConversationService({
    sessions: [{ sessionRef, canonicalCwd: "/workspace" }],
    async readHistory({ cursor, limit }) {
      requested.push({ cursor: cursor || "", limit });
      return { items: pages[cursor || ""].slice(-limit), olderCursor: cursor ? null : "older" };
    },
  });

  const first = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], limit: 20,
  }, { subjectId: "owner" });
  assert.equal(first.results.length, 20);
  assert.deepEqual(first.scanned, { sessions: 1, items: 100, pages: 2 });

  const second = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], limit: 20, cursor: first.cursor,
  }, { subjectId: "owner" });
  assert.equal(second.results.length, 20);
  assert.deepEqual(requested, [
    { cursor: "", limit: 50 },
    { cursor: "older", limit: 50 },
    { cursor: "older", limit: 50 },
  ]);
});

test("conversation search bounds scans and survives session timestamp changes", async () => {
  const sessions = Array.from({ length: 41 }, (_, index) => ({
    sessionRef: { backendId: "test", nativeSessionId: `session-${String(index).padStart(2, "0")}` },
    canonicalCwd: "/workspace",
    updatedAt: new Date(Date.UTC(2026, 7, 29, 1, 0, 41 - index)).toISOString(),
  }));
  const { service } = createConversationService({
    sessions,
    async readHistory({ sessionRef }) {
      return {
        items: sessionRef.nativeSessionId === "session-40"
          ? [{ id: "match", role: "user", content: [{ type: "text", text: "target" }] }]
          : [],
        olderCursor: null,
      };
    },
  });

  await assert.rejects(
    service.searchConversationHistory({ query: "target", cwds: ["/workspace"], limit: 21 }, { subjectId: "owner" }),
    (error) => error.code === "turn_rejected",
  );
  const first = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], limit: 2,
  }, { subjectId: "owner" });
  assert.deepEqual(first.results, []);
  assert.deepEqual(first.scanned, { sessions: 40, items: 0, pages: 40 });
  assert.ok(first.cursor);
  sessions[40].updatedAt = "2026-08-30T00:00:00.000Z";

  const second = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], limit: 2, cursor: first.cursor,
  }, { subjectId: "owner" });
  assert.deepEqual(second.results.map((result) => result.messageId), ["match"]);
  assert.deepEqual(second.scanned, { sessions: 1, items: 1, pages: 1 });
});

test("conversation search orders by immutable session creation time and filters before history reads", async () => {
  const sessions = [
    { id: "old", createdAt: "2026-08-20T00:00:00.000Z" },
    { id: "same-a", createdAt: "2026-08-28T00:00:00.000Z" },
    { id: "same-b", createdAt: "2026-08-28T00:00:00.000Z" },
    { id: "new", createdAt: "2026-08-29T00:00:00.000Z" },
    { id: "unknown", createdAt: "" },
  ].map(({ id, createdAt }) => ({
    sessionRef: { backendId: "test", nativeSessionId: id },
    canonicalCwd: "/workspace",
    createdAt,
    updatedAt: "2099-01-01T00:00:00.000Z",
  }));
  const reads = [];
  const { service } = createConversationService({
    sessions,
    async readHistory({ sessionRef }) {
      reads.push(sessionRef.nativeSessionId);
      return {
        items: [{
          id: `message-${sessionRef.nativeSessionId}`,
          role: "assistant",
          content: [{ type: "text", text: "target" }],
        }],
        olderCursor: null,
      };
    },
  });

  const request = {
    query: "target",
    cwds: ["/workspace"],
    limit: 1,
    order: "newest",
    since: "2026-08-28T00:00:00Z",
  };
  const first = await service.searchConversationHistory(request, { subjectId: "owner" });
  const second = await service.searchConversationHistory({
    ...request, cursor: first.cursor,
  }, { subjectId: "owner" });
  const third = await service.searchConversationHistory({
    ...request, cursor: second.cursor,
  }, { subjectId: "owner" });

  assert.deepEqual(reads, ["new", "same-b", "same-a"]);
  assert.deepEqual([
    first.results[0].sessionCreatedAt,
    second.results[0].sessionCreatedAt,
    third.results[0].sessionCreatedAt,
  ], [
    "2026-08-29T00:00:00.000Z",
    "2026-08-28T00:00:00.000Z",
    "2026-08-28T00:00:00.000Z",
  ]);
  assert.equal(third.cursor, undefined);

  reads.length = 0;
  const oldest = await service.searchConversationHistory({
    ...request, order: "oldest",
  }, { subjectId: "owner" });
  assert.equal(oldest.results[0].sessionRef.nativeSessionId, "same-a");
  assert.deepEqual(reads, ["same-a"]);

  await assert.rejects(service.searchConversationHistory({
    ...request, cursor: first.cursor, order: "oldest",
  }, { subjectId: "owner" }), (error) => error.code === "history_cursor_invalid");
});

test("conversation search rejects invalid order and since values", async () => {
  const { service } = createConversationService({ sessions: [], async readHistory() {} });
  await assert.rejects(service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], order: "recent",
  }, { subjectId: "owner" }), (error) => error.code === "turn_rejected");
  await assert.rejects(service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], since: "not-a-date",
  }, { subjectId: "owner" }), (error) => error.code === "turn_rejected");
});

test("conversation range read excludes non-conversation items and paginates within a backend page", async () => {
  const sessionRef = { backendId: "test", nativeSessionId: "session-1" };
  const backendCursors = [];
  const page = {
    items: [
      { id: "user-old", role: "user", content: [{ type: "text", text: "old question" }] },
      { id: "status", role: "assistant", itemType: "status_log", content: [{ type: "text", text: "running" }] },
      { id: "assistant-middle", role: "assistant", content: [{ type: "text", text: "middle answer" }, { type: "tool", resultSummary: "secret output" }] },
      { id: "internal", role: "user", itemType: "internal_context", content: [{ type: "text", text: "system reminder" }] },
      { id: "assistant-new", role: "assistant", content: [{ type: "text", text: "new answer" }] },
    ],
    olderCursor: null,
  };
  const { service } = createConversationService({
    sessions: [{ sessionRef, canonicalCwd: "/workspace" }],
    async readHistory({ cursor }) {
      backendCursors.push(cursor || "");
      return page;
    },
  });

  const first = await service.readConversationHistory({ sessionRef, limit: 2 }, { subjectId: "owner" });
  assert.deepEqual(first.items, [
    { id: "assistant-middle", role: "assistant", text: "middle answer" },
    { id: "assistant-new", role: "assistant", text: "new answer" },
  ]);
  assert.ok(first.cursor);
  assert.equal(first.totalChars, 23);
  page.items.push({
    id: "assistant-appended", role: "assistant", content: [{ type: "text", text: "later reply" }],
  });

  const second = await service.readConversationHistory({
    sessionRef, limit: 2, cursor: first.cursor,
  }, { subjectId: "owner" });
  assert.deepEqual(second.items, [{ id: "user-old", role: "user", text: "old question" }]);
  assert.equal(second.cursor, undefined);
  assert.deepEqual(backendCursors, ["", ""]);
});

test("search-focused read returns a small section containing a match near the end of a long message", async () => {
  const sessionRef = { backendId: "test", nativeSessionId: "long-session" };
  const match = "late target";
  const text = `${"a".repeat(25_000)}\n${match}\n${"b".repeat(8_000)}`;
  const items = [{ id: "long", role: "assistant", content: [{ type: "text", text }] }];
  const { service } = createConversationService({
    sessions: [{ sessionRef, canonicalCwd: "/workspace" }],
    async readHistory() {
      return {
        items,
        olderCursor: null,
      };
    },
  });

  const search = await service.searchConversationHistory({
    query: "late   target", cwds: ["/workspace"], limit: 1,
  }, { subjectId: "owner" });
  assert.equal(search.results.length, 1);
  items.push({ id: "later", role: "assistant", content: [{ type: "text", text: "new reply" }] });
  const section = await service.readConversationHistory({
    sessionRef, cursor: search.results[0].conversationCursor, limit: 5,
  }, { subjectId: "owner" });

  assert.equal(section.focused, true);
  assert.equal(section.items.length, 1);
  assert.ok(section.items[0].text.includes(match));
  assert.ok(section.items[0].text.length <= 2_400);
  assert.equal(section.totalChars, section.items[0].text.length);
  assert.equal(section.items[0].truncatedStart, true);
  assert.equal(section.items[0].truncatedEnd, true);
  assert.equal(
    section.items[0].text.slice(section.items[0].focusStart, section.items[0].focusEnd),
    match,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(section)) < 4_000);
});

test("search cursor ignores appended messages but rejects a changed boundary item", async () => {
  const sessionRef = { backendId: "test", nativeSessionId: "active-session" };
  const items = Array.from({ length: 25 }, (_, index) => ({
    id: String(index), role: "assistant", content: [{ type: "text", text: `target ${index}` }],
  }));
  const { service } = createConversationService({
    sessions: [{ sessionRef, canonicalCwd: "/workspace" }],
    async readHistory() {
      return { items: items.slice(-50), olderCursor: null };
    },
  });
  const first = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], limit: 20,
  }, { subjectId: "owner" });
  items.push({ id: "25", role: "assistant", content: [{ type: "text", text: "new reply" }] });
  const second = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], limit: 20, cursor: first.cursor,
  }, { subjectId: "owner" });
  assert.deepEqual(second.results.map((result) => result.messageId), ["4", "3", "2", "1", "0"]);

  const replay = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], limit: 20,
  }, { subjectId: "owner" });
  items[4].content[0].text = "changed";
  await assert.rejects(service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], limit: 20, cursor: replay.cursor,
  }, { subjectId: "owner" }), (error) => error.code === "history_cursor_invalid");
});

test("search cursor finds its boundary after appends shift it to an older page", async () => {
  const sessionRef = { backendId: "test", nativeSessionId: "busy-session" };
  const items = Array.from({ length: 50 }, (_, index) => ({
    id: String(index), role: "assistant", content: [{ type: "text", text: `target ${index}` }],
  }));
  const { service } = createConversationService({
    sessions: [{ sessionRef, canonicalCwd: "/workspace" }],
    async readHistory({ cursor, limit }) {
      const end = cursor ? Number(cursor) : items.length;
      const start = Math.max(0, end - limit);
      return { items: items.slice(start, end), olderCursor: start > 0 ? String(start) : null };
    },
  });
  const first = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], limit: 20,
  }, { subjectId: "owner" });
  items.push(...Array.from({ length: 30 }, (_, index) => ({
    id: String(50 + index), role: "assistant", content: [{ type: "text", text: "new reply" }],
  })));
  const second = await service.searchConversationHistory({
    query: "target", cwds: ["/workspace"], limit: 20, cursor: first.cursor,
  }, { subjectId: "owner" });
  assert.deepEqual(second.results.map((result) => result.messageId),
    Array.from({ length: 20 }, (_, index) => String(29 - index)));
  assert.equal(second.scanned.pages, 2);
});

test("conversation range read caps total text and rejects cursors for another session", async () => {
  const sessionRef = { backendId: "test", nativeSessionId: "session-1" };
  const { service } = createConversationService({
    sessions: [{ sessionRef, canonicalCwd: "/workspace" }],
    async readHistory() {
      return {
        items: [{ id: "huge", role: "assistant", content: [{ type: "text", text: "x".repeat(20_000) }] }],
        olderCursor: null,
      };
    },
  });

  const page = await service.readConversationHistory({ sessionRef }, { subjectId: "owner" });
  assert.equal(page.items[0].text.length, 12_000);
  assert.equal(page.items[0].truncated, true);
  assert.equal(page.totalChars, 12_000);
  await assert.rejects(
    service.readConversationHistory({
      sessionRef: { backendId: "test", nativeSessionId: "session-2" },
      cursor: Buffer.from(JSON.stringify({ v: 1, kind: "read", signature: "wrong" })).toString("base64url"),
    }, { subjectId: "owner" }),
    (error) => error.code === "history_cursor_invalid",
  );
});
