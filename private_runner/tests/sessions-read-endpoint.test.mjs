import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-sessions-read-endpoint-"));
const projectRoot = path.join(tempRoot, "project");
const projectAlias = path.join(tempRoot, "project-alias");
const emptyRoot = path.join(tempRoot, "empty");
const acpStorePath = path.join(tempRoot, "acp-sessions.json");
await Promise.all([
  fs.mkdir(projectRoot, { recursive: true }),
  fs.mkdir(emptyRoot, { recursive: true }),
]);
await fs.symlink(projectRoot, projectAlias);
await fs.mkdir(path.join(tempRoot, "cli-sessions"), { recursive: true });
await fs.writeFile(acpStorePath, JSON.stringify({
  version: 3,
  sessions: Object.fromEntries([
    "first",
    "second",
    "singular",
    ...Array.from({ length: 101 }, (_, index) => `large-${index}`),
  ].map((sessionId) => [sessionId, {
    directory: projectRoot,
    rootRelativePath: projectRoot,
    updatedAt: "2026-08-10T01:00:00.000Z",
    lastReadAt: "",
  }])),
  latestByDirectory: { [projectRoot]: "singular" },
}));

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
process.env.SESSION_ROOT_BINDING_ENABLED = "1";
process.env.ACP_SESSION_STORE_PATH = acpStorePath;
process.env.CODEX_CLI_SESSIONS_DIR = path.join(tempRoot, "cli-sessions");
process.env.CLI_SESSION_INDEX_PATH = path.join(tempRoot, "cli-index.json");

const { __TESTING__ } = await import("../src/server-runtime.mjs?sessions-read-endpoint");
const { server } = __TESTING__;

test.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

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
  return fetch(`${baseUrl}/sessions/read`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body,
  });
}

function postUnreadCount(baseUrl, directories) {
  return fetch(`${baseUrl}/sessions/unread-count`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-runner-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ directories }),
  });
}

test("POST /sessions/read requires runner authentication", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, JSON.stringify({
      sessionId: "singular",
      directory: projectRoot,
    }), "");
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "unauthorized");
  });
});

test("POST /sessions/unread-count returns canonical per-directory counts and their exact sum", async () => {
  await withServer(async (baseUrl) => {
    const response = await postUnreadCount(baseUrl, [projectAlias, projectRoot]);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.directories, [await fs.realpath(projectRoot)]);
    assert.deepEqual(result.directoryCounts, [{
      directory: await fs.realpath(projectRoot),
      unreadCount: 104,
    }]);
    assert.equal(result.unreadCount, 104);
    assert.equal(
      result.unreadCount,
      result.directoryCounts.reduce((sum, item) => sum + item.unreadCount, 0),
    );
  });
});

test("POST /sessions/read marks a real batch and preserves singular compatibility", async () => {
  await withServer(async (baseUrl) => {
    const lastReadAt = "2026-08-10T02:00:00.000Z";
    const batchResponse = await post(baseUrl, JSON.stringify({
      sessionIds: ["first", "missing", "second"],
      directory: projectRoot,
      source: "all",
      lastReadAt,
    }));
    assert.equal(batchResponse.status, 200);
    const batch = await batchResponse.json();
    assert.equal(batch.ok, true);
    assert.deepEqual(batch.results.map(({ sessionId, updated }) => ({ sessionId, updated })), [
      { sessionId: "first", updated: true },
      { sessionId: "missing", updated: false },
      { sessionId: "second", updated: true },
    ]);

    const persisted = JSON.parse(await fs.readFile(acpStorePath, "utf8"));
    assert.equal(persisted.sessions.first.lastReadAt, lastReadAt);
    assert.equal(persisted.sessions.second.lastReadAt, lastReadAt);

    const singularResponse = await post(baseUrl, JSON.stringify({
      sessionId: "singular",
      directory: projectRoot,
      source: "acp",
      lastReadAt,
    }));
    assert.equal(singularResponse.status, 200);
    const singular = await singularResponse.json();
    assert.equal(singular.ok, true);
    assert.equal(singular.sessionId, "singular");
    assert.equal(singular.updated, true);
    assert.equal("results" in singular, false);
  });
});

test("POST /sessions/read marks 101+ sessions by canonical directory without returning ids", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, JSON.stringify({
      scope: "directory",
      directory: projectAlias,
      lastReadAt: "2026-08-10T04:00:00.000Z",
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "full");
    assert.equal(result.directory, await fs.realpath(projectRoot));
    assert.equal(result.selectedCount, 104);
    assert.equal(result.stores.acp.selectedCount, 104);
    assert.equal("results" in result, false);
    assert.equal("sessionIds" in result, false);
  });
});

test("POST /sessions/read accepts an empty directory and rejects mixed targets", async () => {
  await withServer(async (baseUrl) => {
    const emptyResponse = await post(baseUrl, JSON.stringify({
      scope: "directory",
      directory: emptyRoot,
    }));
    assert.equal(emptyResponse.status, 200);
    const empty = await emptyResponse.json();
    assert.equal(empty.status, "full");
    assert.equal(empty.selectedCount, 0);

    for (const body of [
      { scope: "directory", directory: projectRoot, sessionId: "first" },
      { scope: "directory", directory: projectRoot, sessionIds: ["first"] },
    ]) {
      const response = await post(baseUrl, JSON.stringify(body));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "conflicting_read_targets");
    }
    const invalidScope = await post(baseUrl, JSON.stringify({
      scope: "all",
      directory: projectRoot,
    }));
    assert.equal(invalidScope.status, 400);
    assert.equal((await invalidScope.json()).error, "invalid_read_scope");
  });
});

test("POST /sessions/read enforces batch and body bounds", async () => {
  await withServer(async (baseUrl) => {
    const tooManyResponse = await post(baseUrl, JSON.stringify({
      sessionIds: Array.from({ length: 101 }, (_, index) => `session-${index}`),
      directory: projectRoot,
    }));
    assert.equal(tooManyResponse.status, 400);
    assert.equal((await tooManyResponse.json()).error, "too_many_session_ids");

    const oversizedResponse = await post(baseUrl, `"${"x".repeat(33 * 1024)}"`);
    assert.equal(oversizedResponse.status, 400);
    assert.equal((await oversizedResponse.json()).error, "request_body_too_large");
  });
});
