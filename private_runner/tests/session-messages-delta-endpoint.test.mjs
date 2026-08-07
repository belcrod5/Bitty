import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sessionStoreRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-session-messages-endpoint-"));
const sessionsDir = path.join(sessionStoreRoot, "sessions", "2026", "08", "07");
const rolloutPath = path.join(sessionsDir, "rollout-2026-08-07T00-00-00-thread-delta.jsonl");

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
process.env.CODEX_CLI_SESSIONS_DIR = path.join(sessionStoreRoot, "sessions");
process.env.CLI_SESSION_INDEX_PATH = path.join(sessionStoreRoot, "cli_sessions_index.json");

function messageRecord(index, role = "assistant") {
  return {
    timestamp: `2026-08-07T00:00:${String(index).padStart(2, "0")}.000Z`,
    type: "response_item",
    payload: {
      type: "message",
      id: `msg-${index}`,
      role,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text: `message-${index}` }],
    },
  };
}

const initialRecords = [
  {
    timestamp: "2026-08-07T00:00:00.000Z",
    type: "session_meta",
    payload: { id: "thread-delta", cwd: sessionStoreRoot, model_provider: "openai" },
  },
  {
    timestamp: "2026-08-07T00:00:00.100Z",
    type: "turn_context",
    payload: { model: "gpt-5-codex", effort: "medium" },
  },
  messageRecord(1),
  messageRecord(2),
  {
    timestamp: "2026-08-07T00:00:03.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        model_context_window: 1000,
      },
    },
  },
];

await fs.mkdir(sessionsDir, { recursive: true });
await fs.writeFile(rolloutPath, `${initialRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);

const { __TESTING__ } = await import("../src/server-runtime.mjs?session-messages-delta-endpoint");
const { server } = __TESTING__;

test.after(async () => {
  await fs.rm(sessionStoreRoot, { recursive: true, force: true });
});

async function withServer(fn) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function getSessionMessages(baseUrl, params = {}) {
  const url = new URL(`${baseUrl}/session-messages`);
  url.searchParams.set("sessionId", "thread-delta");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return fetch(url, { headers: { authorization: "Bearer test-runner-token" } });
}

test("GET /session-messages keeps the legacy response shape and adds latestCursor", async () => {
  await withServer(async (baseUrl) => {
    const response = await getSessionMessages(baseUrl);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.found, true);
    assert.deepEqual(body.messages.map((item) => item.content), ["message-1", "message-2"]);
    assert.equal(typeof body.latestCursor, "string");
    assert.equal("moreAfter" in body, false);
    assert.equal(body.olderCursor, null);
    assert.equal(body.contextUsage?.totalTokens, 120);
    assert.ok(body.modelRef);
    assert.equal(body.reasoningEffort, "medium");
    assert.ok(body.updatedAt);
  });
});

test("GET /session-messages rejects cursor together with sinceCursor", async () => {
  await withServer(async (baseUrl) => {
    const response = await getSessionMessages(baseUrl, { cursor: "abc", sinceCursor: "def" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "conflicting_history_cursor");
  });
});

test("GET /session-messages sinceCursor returns the delta with fresh meta even when empty", async () => {
  await withServer(async (baseUrl) => {
    const snapshot = await (await getSessionMessages(baseUrl)).json();

    const empty = await (await getSessionMessages(baseUrl, { sinceCursor: snapshot.latestCursor })).json();
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.moreAfter, false);
    assert.equal(typeof empty.latestCursor, "string");
    assert.equal(empty.contextUsage?.totalTokens, 120);
    assert.ok(empty.modelRef);
    assert.ok(empty.updatedAt);

    await fs.appendFile(rolloutPath, `${JSON.stringify(messageRecord(4))}\n`);
    const delta = await (await getSessionMessages(baseUrl, { sinceCursor: empty.latestCursor })).json();
    assert.deepEqual(delta.messages.map((item) => item.content), ["message-4"]);
    assert.equal(delta.moreAfter, false);
    assert.equal(delta.olderCursor, null);
    assert.equal(delta.contextUsage?.totalTokens, 120);

    const drained = await (await getSessionMessages(baseUrl, { sinceCursor: delta.latestCursor })).json();
    assert.deepEqual(drained.messages, []);
  });
});

test("GET /session-messages cursor paging still skips contextUsage and meta", async () => {
  await withServer(async (baseUrl) => {
    const newest = await (await getSessionMessages(baseUrl, { limit: 1 })).json();
    assert.ok(newest.olderCursor);
    const older = await (await getSessionMessages(baseUrl, { limit: 1, cursor: newest.olderCursor })).json();
    assert.equal(older.contextUsage, null);
    assert.equal(older.modelRef, "");
    assert.equal("moreAfter" in older, false);
    assert.equal(typeof older.latestCursor, "string");
  });
});

test("GET /session-messages sinceCursor responds 409 when the rollout was replaced", async () => {
  await withServer(async (baseUrl) => {
    const snapshot = await (await getSessionMessages(baseUrl)).json();
    const original = await fs.readFile(rolloutPath);
    const replacement = `${rolloutPath}.tmp`;
    await fs.writeFile(replacement, original);
    await fs.rename(replacement, rolloutPath);

    const response = await getSessionMessages(baseUrl, { sinceCursor: snapshot.latestCursor });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "stale_history_cursor");
  });
});

test("GET /session-messages found:false reports a null latestCursor", async () => {
  await withServer(async (baseUrl) => {
    const response = await getSessionMessages(baseUrl, { sessionId: "thread-missing", sinceCursor: "abc" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.found, false);
    assert.equal(body.latestCursor, null);
    assert.equal(body.moreAfter, false);
  });
});
