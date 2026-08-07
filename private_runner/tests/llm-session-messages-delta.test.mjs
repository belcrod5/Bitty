import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLlmSessionRolloutReaders } from "../src/llm-session-rollout-readers.mjs";

function createReaders() {
  return createLlmSessionRolloutReaders({
    makeApiError: (status, code, message) => Object.assign(new Error(String(message || code)), {
      apiStatus: Number(status),
      apiCode: String(code || ""),
    }),
    normalizeReasoningEffort: (value) => String(value || "").trim(),
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    normalizeTokenCount: (value) => Number(value || 0),
    parseOpenAICodexModelRef: (value) => ({ modelRef: String(value || "") }),
    sessionMessagesPageSize: 20,
    sessionRolloutMaxReadBytes: 1024 * 1024,
    sessionSummaryHeadMaxReadBytes: 128 * 1024,
    sessionSummaryTailMaxReadBytes: 128 * 1024,
  });
}

function messageRecord(index, role = "assistant") {
  return {
    timestamp: `2026-07-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    type: "response_item",
    payload: {
      type: "message",
      id: `msg-${index}`,
      role,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text: `message-${index}` }],
    },
  };
}

async function makeRollout(t, records) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-delta-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return { tempDir, filePath };
}

async function appendRecords(filePath, records) {
  await fs.appendFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

const sessionMeta = { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } };

test("sinceCursor with no appended rows returns an empty delta and a reusable latestCursor", async (t) => {
  const { filePath } = await makeRollout(t, [
    sessionMeta,
    ...Array.from({ length: 5 }, (_, i) => messageRecord(i + 1)),
  ]);
  const readers = createReaders();
  const snapshot = await readers.readSessionMessagesFromRolloutFile(filePath, { sessionId: "thread-1", limit: 20 });
  assert.equal(typeof snapshot.latestCursor, "string");

  const delta = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor: snapshot.latestCursor,
  });
  assert.deepEqual(delta.messages, []);
  assert.equal(delta.moreAfter, false);
  assert.equal(delta.olderCursor, null);
  assert.equal(typeof delta.latestCursor, "string");

  const again = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor: delta.latestCursor,
  });
  assert.deepEqual(again.messages, []);
  assert.equal(again.moreAfter, false);
});

test("sinceCursor returns only appended rows in ascending order and chains through appends", async (t) => {
  const { filePath } = await makeRollout(t, [
    sessionMeta,
    messageRecord(1),
    messageRecord(2),
    messageRecord(3),
  ]);
  const readers = createReaders();
  const snapshot = await readers.readSessionMessagesFromRolloutFile(filePath, { sessionId: "thread-1", limit: 20 });

  await appendRecords(filePath, [messageRecord(4), messageRecord(5)]);
  const first = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor: snapshot.latestCursor,
  });
  assert.deepEqual(first.messages.map((item) => item.content), ["message-4", "message-5"]);
  assert.equal(first.moreAfter, false);

  await appendRecords(filePath, [messageRecord(6)]);
  const second = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor: first.latestCursor,
  });
  assert.deepEqual(second.messages.map((item) => item.content), ["message-6"]);
  assert.equal(second.moreAfter, false);
});

test("sinceCursor pages a large delta oldest-first with moreAfter", async (t) => {
  const { filePath } = await makeRollout(t, [sessionMeta, messageRecord(1), messageRecord(2)]);
  const readers = createReaders();
  const snapshot = await readers.readSessionMessagesFromRolloutFile(filePath, { sessionId: "thread-1", limit: 20 });

  await appendRecords(filePath, Array.from({ length: 30 }, (_, i) => messageRecord(i + 3)));

  const first = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor: snapshot.latestCursor,
  });
  assert.deepEqual(
    first.messages.map((item) => item.content),
    Array.from({ length: 20 }, (_, i) => `message-${i + 3}`)
  );
  assert.equal(first.moreAfter, true);

  const second = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor: first.latestCursor,
  });
  assert.deepEqual(
    second.messages.map((item) => item.content),
    Array.from({ length: 10 }, (_, i) => `message-${i + 23}`)
  );
  assert.equal(second.moreAfter, false);

  const third = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor: second.latestCursor,
  });
  assert.deepEqual(third.messages, []);
  assert.equal(third.moreAfter, false);
});

test("sinceCursor with limit=1 still drains the delta without skipping rows", async (t) => {
  const { filePath } = await makeRollout(t, [sessionMeta, messageRecord(1)]);
  const readers = createReaders();
  const snapshot = await readers.readSessionMessagesFromRolloutFile(filePath, { sessionId: "thread-1", limit: 1 });
  assert.equal(snapshot.messages.length, 1);

  await appendRecords(filePath, [messageRecord(2), messageRecord(3)]);
  const collected = [];
  let cursor = snapshot.latestCursor;
  for (let round = 0; round < 5; round += 1) {
    const delta = await readers.readSessionMessagesFromRolloutFile(filePath, {
      sessionId: "thread-1",
      limit: 1,
      sinceCursor: cursor,
    });
    collected.push(...delta.messages.map((item) => item.content));
    cursor = delta.latestCursor;
    if (!delta.moreAfter && delta.messages.length === 0) break;
  }
  assert.deepEqual(collected, ["message-2", "message-3"]);
});

test("delta re-resolves a user response/event pair across the boundary with a stable itemId", async (t) => {
  const { filePath } = await makeRollout(t, [
    sessionMeta,
    messageRecord(1),
    {
      timestamp: "2026-07-01T00:00:02.000Z",
      type: "response_item",
      payload: { type: "message", id: "user-resp", role: "user", content: [{ type: "input_text", text: "prompt" }] },
    },
  ]);
  const readers = createReaders();
  const snapshot = await readers.readSessionMessagesFromRolloutFile(filePath, { sessionId: "thread-1", limit: 20 });
  // Unpaired user response is shown as unclassified context before its event arrives.
  assert.deepEqual(snapshot.messages.map((item) => ({ itemId: item.itemId, role: item.role, kind: item.kind })), [
    { itemId: "msg-1", role: "assistant", kind: undefined },
    { itemId: "user-resp", role: "assistant", kind: "unclassified_context" },
  ]);

  await appendRecords(filePath, [
    { timestamp: "2026-07-01T00:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "prompt" } },
  ]);
  const delta = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor: snapshot.latestCursor,
  });
  assert.deepEqual(delta.messages.map((item) => ({
    itemId: item.itemId,
    role: item.role,
    kind: item.kind,
    replacesItemId: item.replacesItemId,
  })), [
    { itemId: "user-resp", role: "user", kind: undefined, replacesItemId: undefined },
  ]);
  assert.equal(delta.moreAfter, false);
});

test("delta re-resolves an agent event/response pair across the boundary and names the superseded row", async (t) => {
  const { filePath } = await makeRollout(t, [
    sessionMeta,
    {
      timestamp: "2026-07-01T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "answer" },
    },
  ]);
  const readers = createReaders();
  const snapshot = await readers.readSessionMessagesFromRolloutFile(filePath, { sessionId: "thread-1", limit: 20 });
  assert.equal(snapshot.messages.length, 1);
  const eventRowId = snapshot.messages[0].itemId;
  assert.ok(eventRowId);

  await appendRecords(filePath, [
    {
      timestamp: "2026-07-01T00:00:01.500Z",
      type: "response_item",
      payload: { type: "message", id: "resp-1", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    },
  ]);
  const delta = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor: snapshot.latestCursor,
  });
  assert.deepEqual(delta.messages.map((item) => ({
    itemId: item.itemId,
    content: item.content,
    replacesItemId: item.replacesItemId,
  })), [
    { itemId: "resp-1", content: "answer", replacesItemId: eventRowId },
  ]);
});

test("delta re-sends a command row when its outcome lands after the boundary", async (t) => {
  const { filePath } = await makeRollout(t, [
    sessionMeta,
    {
      timestamp: "2026-07-01T00:00:01.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: { cmd: "npm test" } },
    },
  ]);
  const readers = createReaders();
  const snapshot = await readers.readSessionMessagesFromRolloutFile(filePath, { sessionId: "thread-1", limit: 20 });
  assert.equal(snapshot.messages[0]?.commandExecution?.status, "running");

  await appendRecords(filePath, [
    {
      timestamp: "2026-07-01T00:00:02.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: "ok", exit_code: 0 },
    },
  ]);
  const delta = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor: snapshot.latestCursor,
  });
  assert.deepEqual(delta.messages.map((item) => ({
    itemId: item.itemId,
    commandExecution: item.commandExecution,
  })), [
    { itemId: "call-1", commandExecution: { command: "npm test", status: "completed", exitCode: 0 } },
  ]);
});

test("sinceCursor rejects truncated, replaced, rewritten, and removed rollouts with 409", async (t) => {
  const records = [sessionMeta, ...Array.from({ length: 4 }, (_, i) => messageRecord(i + 1))];
  const { tempDir, filePath } = await makeRollout(t, records);
  const readers = createReaders();
  const snapshot = await readers.readSessionMessagesFromRolloutFile(filePath, { sessionId: "thread-1", limit: 20 });
  const sinceCursor = snapshot.latestCursor;
  const expectStale = (promise) => assert.rejects(promise, (error) => {
    assert.equal(error.apiStatus, 409);
    assert.equal(error.apiCode, "stale_history_cursor");
    return true;
  });

  const original = await fs.readFile(filePath);

  // Truncated file: cursor now points beyond EOF.
  await fs.writeFile(filePath, original.subarray(0, Math.floor(original.length / 2)));
  await expectStale(readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor,
  }));

  // Rewritten boundary bytes with the same size: boundary hash mismatch.
  const mutated = Buffer.from(original);
  mutated.write("X".repeat(8), mutated.length - 10);
  await fs.writeFile(filePath, mutated);
  await expectStale(readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor,
  }));

  // Replaced file (new inode) with identical bytes.
  const replacement = path.join(tempDir, "replacement.jsonl");
  await fs.writeFile(replacement, original);
  await fs.rename(replacement, filePath);
  await expectStale(readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor,
  }));

  // Removed file.
  await fs.rm(filePath);
  await expectStale(readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor,
  }));
});

test("sinceCursor for another session is rejected as an invalid cursor", async (t) => {
  const { filePath } = await makeRollout(t, [sessionMeta, messageRecord(1)]);
  const readers = createReaders();
  const snapshot = await readers.readSessionMessagesFromRolloutFile(filePath, { sessionId: "thread-1", limit: 20 });
  await assert.rejects(
    readers.readSessionMessagesFromRolloutFile(filePath, {
      sessionId: "thread-2",
      limit: 20,
      sinceCursor: snapshot.latestCursor,
    }),
    (error) => {
      assert.equal(error.apiStatus, 400);
      assert.equal(error.apiCode, "invalid_history_cursor");
      return true;
    }
  );
});

test("latestCursor issued by an older page keeps olderCursor paging intact", async (t) => {
  const { filePath } = await makeRollout(t, [
    sessionMeta,
    ...Array.from({ length: 45 }, (_, i) => messageRecord(i + 1)),
  ]);
  const readers = createReaders();

  const newest = await readers.readSessionMessagesFromRolloutFile(filePath, { sessionId: "thread-1", limit: 20 });
  const middle = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    cursor: newest.olderCursor,
  });
  assert.deepEqual(newest.messages.map((item) => item.content), Array.from({ length: 20 }, (_, i) => `message-${i + 26}`));
  assert.deepEqual(middle.messages.map((item) => item.content), Array.from({ length: 20 }, (_, i) => `message-${i + 6}`));
  assert.equal(typeof newest.latestCursor, "string");
  assert.equal(typeof middle.latestCursor, "string");

  // A delta taken from the newest snapshot ignores older paging entirely.
  await appendRecords(filePath, [messageRecord(50)]);
  const delta = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    sinceCursor: newest.latestCursor,
  });
  assert.deepEqual(delta.messages.map((item) => item.content), ["message-50"]);
});
