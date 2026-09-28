import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "client-state-endpoint-"));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
process.env.CLIENT_STATE_STORE_PATH = path.join(tempDir, "client-state.json");

const { __TESTING__ } = await import("../src/server-runtime.mjs");
const { createClientStateStore } = await import("../src/client-state-store.mjs");
const { server } = __TESTING__;
test.after(async () => fs.rm(tempDir, { recursive: true, force: true }));

test("client state is authenticated, durable, provider-aware, and merges field operations", async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/client-state`;
  const headers = { authorization: "Bearer test-runner-token", "content-type": "application/json" };
  const get = async () => fetch(base, { headers });
  const post = async (operation) => fetch(base, { method: "POST", headers, body: JSON.stringify({ operation }) });
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await get()).status, 200);
    const directory = { id: "dir-1", path: "/work", displayName: "Work", markerColor: "green" };
    const codexKey = JSON.stringify(["codex", "same-session"]);
    const claudeKey = JSON.stringify(["claude", "same-session"]);
    assert.equal((await post({ type: "migrate", directories: [directory] })).status, 400);
    assert.equal((await post({ type: "directory.upsert", directory })).status, 200);
    assert.equal((await post({ type: "session.set", backendId: "codex", sessionId: "same-session", title: "Original", markerColor: "red" })).status, 200);
    assert.equal((await post({ type: "composer.append", text: "first" })).status, 200);
    assert.equal((await post({ type: "draft.set", backendId: "codex", sessionId: "same-session", text: "unsent" })).status, 200);
    const responses = await Promise.all([
      post({ type: "session.set", backendId: "codex", sessionId: "same-session", title: "Renamed" }),
      post({ type: "session.set", backendId: "claude", sessionId: "same-session", markerColor: "yellow" }),
      post({ type: "composer.append", text: "second" }),
      post({ type: "draft.set", backendId: "claude", sessionId: "same-session", text: "other unsent" }),
    ]);
    for (const response of responses) assert.equal(response.status, 200);
    const snapshot = (await (await get()).json()).snapshot;
    assert.deepEqual(snapshot.directories, [directory]);
    assert.equal(snapshot.sessions[codexKey].title, "Renamed");
    assert.equal(snapshot.sessions[claudeKey].markerColor, "yellow");
    assert.deepEqual(snapshot.composerHistory, ["second", "first"]);
    assert.equal(snapshot.drafts[codexKey].text, "unsent");
    assert.equal(snapshot.drafts[claudeKey].text, "other unsent");
    assert.equal(JSON.parse(await fs.readFile(process.env.CLIENT_STATE_STORE_PATH, "utf8")).revision, snapshot.revision);
    const restarted = await createClientStateStore(process.env.CLIENT_STATE_STORE_PATH).snapshot();
    assert.equal(restarted.sessions[codexKey].title, "Renamed");
    assert.equal(restarted.revision, snapshot.revision);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
