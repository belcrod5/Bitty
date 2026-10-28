import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-summary-payload-"));
const directory = path.join(fixtureRoot, "project");
const otherDirectory = path.join(fixtureRoot, "other-project");
const sessionsDir = path.join(fixtureRoot, "sessions");
const rolloutPath = path.join(sessionsDir, "rollout-summary-cli.jsonl");
await Promise.all([directory, otherDirectory, sessionsDir].map((folder) => fs.mkdir(folder, { recursive: true })));
const longPrompt = "初回同期で不要な長いプロンプト。".repeat(4000);
const records = [
  { type: "session_meta", payload: { id: "summary-cli", cwd: directory, parent_thread_id: "parent" }, timestamp: "2026-10-01T00:00:00.000Z" },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: longPrompt }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } }, timestamp: "2026-10-01T00:00:01.000Z" },
  { type: "turn_context", payload: { model: "gpt-before", effort: "high" }, timestamp: "2026-10-01T00:00:02.000Z" },
  { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, model_context_window: 1000 } }, timestamp: "2026-10-01T00:00:03.000Z" },
];
await fs.writeFile(rolloutPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
for (const version of ["old", "new"]) {
  await fs.writeFile(path.join(sessionsDir, `rollout-duplicate-${version}.jsonl`), `${[
    { type: "session_meta", payload: { id: "duplicate", cwd: directory }, timestamp: `2026-10-0${version === "new" ? 5 : 4}T00:00:00.000Z` },
    { type: "turn_context", payload: { model: `fixture-${version}`, effort: "high" }, timestamp: "2026-10-05T00:00:01.000Z" },
  ].map((record) => JSON.stringify(record)).join("\n")}\n`);
}
await fs.writeFile(path.join(sessionsDir, "rollout-foreign.jsonl"), `${JSON.stringify({
  type: "session_meta", payload: { id: "foreign", cwd: otherDirectory }, timestamp: "2026-10-01T00:00:00.000Z",
})}\n`);
const acpStorePath = path.join(fixtureRoot, "acp.json");
await fs.writeFile(acpStorePath, JSON.stringify({
  version: 3,
  sessions: {
    "summary-acp": { directory, rootRelativePath: directory, updatedAt: "2026-10-01T00:00:00.000Z", lastReadAt: "" },
    "summary-cli": { directory, rootRelativePath: directory, updatedAt: "2026-10-01T00:00:00.000Z", lastReadAt: "2026-10-01T00:00:04.000Z" },
  },
  latestByDirectory: { [directory]: "summary-acp" },
}));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
process.env.RUNNER_MOCK = "1";
process.env.CODEX_CLI_SESSIONS_DIR = sessionsDir;
process.env.CLI_SESSION_INDEX_PATH = path.join(fixtureRoot, "cli-index.json");
process.env.ACP_SESSION_STORE_PATH = acpStorePath;
process.env.CLIENT_STATE_STORE_PATH = path.join(fixtureRoot, "client-state.json");
process.env.SESSION_ROOT_BINDING_ENABLED = "1";
process.env.CLI_SESSION_INDEX_REFRESH_MIN_INTERVAL_MS = "0";

const { __TESTING__ } = await import("../src/server-runtime.mjs?session-summaries-endpoint");
const { server } = __TESTING__;
test.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));

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

function post(baseUrl, body, authorization = "Bearer test-runner-token") {
  return fetch(`${baseUrl}/session-summaries`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body,
  });
}

test("removed GET /sessions listing returns 404", async () => {
  await withServer(async (baseUrl) => {
    const url = new URL(`${baseUrl}/sessions`);
    url.searchParams.set("directory", directory);
    url.searchParams.set("source", "all");
    url.searchParams.set("limit", "5");
    const response = await fetch(url, { headers: { authorization: "Bearer test-runner-token" } });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  });
});

test("POST /session-summaries requires runner authentication", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, JSON.stringify({
      directory: "/workspace",
      sessionIds: [],
    }), "");
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "unauthorized");
  });
});

test("POST /session-summaries rejects malformed JSON with a controlled 400", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, "{");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_json");
  });
});

test("POST /session-summaries enforces its 32 KiB body limit", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, `"${"x".repeat(33 * 1024)}"`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "request_body_too_large");
  });
});

test("POST /session-summaries returns service validation errors as 400", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, JSON.stringify({ sessionIds: [] }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_directory");
  });
});

test("summary opt-out removes only the wire body while preserving order, scope, missing IDs, and default compatibility", async (t) => {
  await withServer(async (baseUrl) => {
    const request = { directory, sessionIds: ["summary-acp", "foreign", "summary-cli", "missing", "summary-acp"] };
    const read = async (includeFirstUserMessage) => {
      const response = await post(baseUrl, JSON.stringify({ ...request, ...(includeFirstUserMessage !== undefined ? { includeFirstUserMessage } : {}) }));
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(text));
      return { body: JSON.parse(text), bytes: Buffer.byteLength(text) };
    };
    const full = await read();
    assert.deepEqual(full.body.sessions.map((entry) => entry.sessionId), ["summary-acp", "summary-cli"]);
    assert.deepEqual(full.body.missingSessionIds, ["foreign", "missing"]);
    assert.ok(full.body.sessions[1].firstUserMessage === longPrompt);
    for (const flag of [true, "false", 0, null]) assert.deepEqual((await read(flag)).body, full.body);
    const compact = await read(false);
    const expected = structuredClone(full.body);
    for (const entry of expected.sessions) delete entry.firstUserMessage;
    assert.deepEqual(compact.body, expected);
    assert.ok(compact.body.sessions.every((entry) => !Object.hasOwn(entry, "firstUserMessage")));
    assert.ok(compact.bytes < full.bytes / 10);
    assert.equal(compact.body.sessions[1].modelRef, "openai-codex/gpt-before");
    assert.equal(compact.body.sessions[1].reasoningEffort, "high");
    assert.equal(compact.body.sessions[1].contextUsage.totalTokens, 120);
    assert.equal(compact.body.sessions[1].parentSessionId, "parent");
    t.diagnostic(`Synthetic summary response: ${full.bytes} → ${compact.bytes} bytes`);
    for (const flag of [undefined, false]) {
      const empty = await post(baseUrl, JSON.stringify({ directory, sessionIds: [], includeFirstUserMessage: flag }));
      assert.deepEqual(await empty.json(), { directory: await fs.realpath(directory), sessions: [], missingSessionIds: [] });
    }
  });
});

test("compact summaries return fresh metadata and read state after isolated fixture updates", async () => {
  await withServer(async (baseUrl) => {
    const request = { directory, sessionIds: ["summary-cli"], includeFirstUserMessage: false };
    const before = await (await post(baseUrl, JSON.stringify(request))).json();
    assert.equal(before.sessions[0].contextUsage.totalTokens, 120);
    await fs.appendFile(rolloutPath, `${[
      { type: "turn_context", payload: { model: "gpt-after", effort: "medium" }, timestamp: "2026-10-02T00:00:00.000Z" },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 200, output_tokens: 30, total_tokens: 230 }, model_context_window: 1000 } }, timestamp: "2026-10-02T00:00:01.000Z" },
    ].map((record) => JSON.stringify(record)).join("\n")}\n`);
    const readAt = "2026-10-03T00:00:00.000Z";
    const marked = await fetch(`${baseUrl}/sessions/read`, {
      method: "POST", headers: { authorization: "Bearer test-runner-token", "content-type": "application/json" },
      body: JSON.stringify({ directory, source: "cli", sessionId: "summary-cli", lastReadAt: readAt }),
    });
    assert.equal(marked.status, 200);
    assert.equal((await marked.json()).updated, true);
    const fresh = await (await post(baseUrl, JSON.stringify(request))).json();
    assert.equal(fresh.sessions[0].modelRef, "openai-codex/gpt-after");
    assert.equal(fresh.sessions[0].reasoningEffort, "medium");
    assert.equal(fresh.sessions[0].contextUsage.totalTokens, 230);
    assert.equal(fresh.sessions[0].lastReadAt, readAt);
    const full = await (await post(baseUrl, JSON.stringify({ ...request, includeFirstUserMessage: true }))).json();
    assert.ok(full.sessions[0].firstUserMessage === longPrompt);
    delete full.sessions[0].firstUserMessage;
    assert.deepEqual(fresh, full);
  });
});

test("summary opt-out retains the API's 100-ID bound", async () => {
  await withServer(async (baseUrl) => {
    const ids = Array.from({ length: 101 }, (_, index) => `missing-${index}`);
    const accepted = await post(baseUrl, JSON.stringify({ directory, sessionIds: ids.slice(0, 100), includeFirstUserMessage: false }));
    assert.equal(accepted.status, 200);
    assert.deepEqual((await accepted.json()).missingSessionIds, ids.slice(0, 100));
    const rejected = await post(baseUrl, JSON.stringify({ directory, sessionIds: ids, includeFirstUserMessage: false }));
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, "too_many_session_ids");
  });
});

test("agent session listing carries the same native summary as HTTP and leaves duplicate rollout IDs for fallback", async () => {
  await withServer(async (baseUrl) => {
    const url = new URL(`${baseUrl}/agent/sessions`);
    url.searchParams.set("backendId", "codex");
    url.searchParams.set("cwd", directory);
    const response = await fetch(url, { headers: { authorization: "Bearer test-runner-token" } });
    assert.equal(response.status, 200);
    const listed = await response.json();
    const cli = listed.sessions.find((entry) => entry.sessionRef.nativeSessionId === "summary-cli" && entry.summary);
    assert.ok(cli);
    const http = (await (await post(baseUrl, JSON.stringify({ directory, sessionIds: ["summary-cli"], includeFirstUserMessage: false }))).json()).sessions[0];
    assert.deepEqual(cli.summary, {
      contextUsage: http.contextUsage, modelRef: http.modelRef,
      reasoningEffort: http.reasoningEffort, lastReadAt: http.lastReadAt,
    });
    assert.equal(Object.hasOwn(cli.summary, "firstUserMessage"), false);
    const duplicates = listed.sessions.filter((entry) => entry.sessionRef.nativeSessionId === "duplicate");
    assert.equal(duplicates.length, 2);
    assert.ok(duplicates.every((entry) => !Object.hasOwn(entry, "summary")));
    const selected = (await (await post(baseUrl, JSON.stringify({ directory, sessionIds: ["duplicate"] }))).json()).sessions[0];
    assert.equal(selected.modelRef, "openai-codex/fixture-new");
  });
});
