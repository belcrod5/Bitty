import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    assert.equal((await post({ type: "session.set", backendId: "codex", sessionId: "same-session", note: "Private reminder", expectedNote: "" })).status, 200);
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
    assert.equal(snapshot.sessions[codexKey].note, "Private reminder");
    assert.equal((await post({ type: "session.set", backendId: "codex", sessionId: "same-session", note: "Stale", expectedNote: "" })).status, 400);
    assert.equal(snapshot.sessions[claudeKey].markerColor, "yellow");
    assert.deepEqual(snapshot.composerHistory, ["second", "first"]);
    assert.equal(snapshot.drafts[codexKey].text, "unsent");
    assert.equal(snapshot.drafts[claudeKey].text, "other unsent");
    assert.equal(JSON.parse(await fs.readFile(process.env.CLIENT_STATE_STORE_PATH, "utf8")).revision, snapshot.revision);
    const restarted = await createClientStateStore(process.env.CLIENT_STATE_STORE_PATH).snapshot();
    assert.equal(restarted.sessions[codexKey].title, "Renamed");
    assert.equal(restarted.sessions[codexKey].note, "Private reminder");
    assert.equal(restarted.revision, snapshot.revision);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("conditional client-state GET validates current state without suppressing other clients' updates", async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/client-state`;
  const headers = { authorization: "Bearer test-runner-token", "accept-encoding": "identity" };
  try {
    const first = await fetch(url, { headers });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "private, no-cache");
    assert.equal(first.headers.get("vary"), "Authorization, Accept-Encoding");
    const body = await first.text();
    const etag = first.headers.get("etag");
    assert.equal(etag, `W/"${createHash("sha256").update(body).digest("hex")}"`);
    assert.equal(Number(first.headers.get("content-length")), Buffer.byteLength(body));
    for (const validator of [etag, `"unrelated", ${etag.slice(2)}`, "*"]) {
      const unchanged = await fetch(url, { headers: { ...headers, "if-none-match": validator } });
      assert.equal(unchanged.status, 304);
      assert.equal(unchanged.headers.get("etag"), etag);
      assert.equal(unchanged.headers.get("cache-control"), "private, no-cache");
      assert.equal(unchanged.headers.get("vary"), "Authorization, Accept-Encoding");
      assert.equal(unchanged.headers.get("content-encoding"), null);
      assert.equal(unchanged.headers.get("content-length"), null);
      assert.equal(await unchanged.text(), "");
    }
    for (const authorization of ["", "Bearer wrong-token"]) {
      const unauthorized = await fetch(url, { headers: { authorization, "if-none-match": etag } });
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.headers.get("etag"), null);
      assert.equal(unauthorized.headers.get("cache-control"), "no-store");
    }
    const operation = { type: "session.set", backendId: "codex", sessionId: "other-device", title: "Updated on another device" };
    const changed = await fetch(url, {
      method: "POST", headers: { ...headers, "content-type": "application/json", "if-none-match": etag },
      body: JSON.stringify({ operation }),
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.headers.get("cache-control"), "no-store");
    const postedEtag = changed.headers.get("etag");
    assert.ok(postedEtag);
    assert.notEqual(postedEtag, etag);
    const posted = await changed.json();
    const updated = await fetch(url, { headers: { ...headers, "if-none-match": etag } });
    assert.equal(updated.status, 200);
    const newEtag = updated.headers.get("etag");
    assert.notEqual(newEtag, etag);
    assert.equal(newEtag, postedEtag);
    assert.deepEqual((await updated.json()).snapshot, posted.snapshot);
    assert.equal(posted.snapshot.sessions[JSON.stringify(["codex", "other-device"])].title, operation.title);
    const unchanged = await fetch(url, { headers: { ...headers, "if-none-match": newEtag } });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");
    const invalid = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get("etag"), null);
    assert.equal(invalid.headers.get("cache-control"), "no-store");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("client-state gzip GET and POST share a weak validator with identity and bodyless 304", async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/client-state`;
  const headers = { authorization: "Bearer test-runner-token", "accept-encoding": "gzip" };
  try {
    const post = await fetch(url, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operation: {
        type: "session.set", backendId: "codex", sessionId: "compression-fixture",
        note: "synthetic note for transfer verification. ".repeat(1000), expectedNote: "",
      } }),
    });
    assert.equal(post.status, 200);
    assert.equal(post.headers.get("content-encoding"), "gzip");
    const payload = await post.text();
    assert.ok(Number(post.headers.get("content-length")) < Buffer.byteLength(payload) / 4);
    const etag = post.headers.get("etag");
    assert.ok(etag.startsWith('W/"'));
    for (const encoding of ["gzip", "identity"]) {
      const get = await fetch(url, { headers: { ...headers, "accept-encoding": encoding } });
      assert.equal(get.headers.get("etag"), etag);
      assert.equal(await get.text(), payload);
      const unchanged = await fetch(url, { headers: {
        ...headers, "accept-encoding": encoding, "if-none-match": etag,
      } });
      assert.equal(unchanged.status, 304);
      assert.equal(unchanged.headers.get("etag"), etag);
      assert.equal(unchanged.headers.get("content-encoding"), null);
      assert.equal(unchanged.headers.get("content-length"), null);
      assert.equal(await unchanged.text(), "");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("client-state validators survive restart and detect restored content even at the same revision", async () => {
  const headers = { authorization: "Bearer test-runner-token" };
  async function read(runtimeServer, etag) {
    await new Promise((resolve) => runtimeServer.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${runtimeServer.address().port}/client-state`, {
        headers: { ...headers, ...(etag ? { "if-none-match": etag } : {}) },
      });
      return { status: response.status, etag: response.headers.get("etag"), body: await response.text() };
    } finally {
      await new Promise((resolve, reject) => runtimeServer.close((error) => error ? reject(error) : resolve()));
    }
  }
  const initial = await read(server);
  const restarted = await import("../src/server-runtime.mjs?client-state-restart");
  const unchanged = await read(restarted.__TESTING__.server, initial.etag);
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.etag, initial.etag);
  const restored = JSON.parse(await fs.readFile(process.env.CLIENT_STATE_STORE_PATH, "utf8"));
  const originalRevision = restored.revision;
  restored.composerHistory = ["Restored backup with the same revision"];
  await fs.writeFile(process.env.CLIENT_STATE_STORE_PATH, JSON.stringify(restored));
  const restoredRuntime = await import("../src/server-runtime.mjs?client-state-restored");
  const updated = await read(restoredRuntime.__TESTING__.server, initial.etag);
  assert.equal(updated.status, 200);
  assert.notEqual(updated.etag, initial.etag);
  const snapshot = JSON.parse(updated.body).snapshot;
  assert.equal(snapshot.revision, originalRevision);
  assert.deepEqual(snapshot.composerHistory, restored.composerHistory);
});

test("an unavailable authoritative store returns an error instead of a cache hit", async () => {
  const originalStorePath = process.env.CLIENT_STATE_STORE_PATH;
  const unavailableStorePath = path.join(tempDir, "corrupt-client-state.json");
  await fs.writeFile(unavailableStorePath, "{}");
  let unavailable;
  try {
    process.env.CLIENT_STATE_STORE_PATH = unavailableStorePath;
    unavailable = await import("../src/server-runtime.mjs?client-state-unavailable");
  } finally {
    process.env.CLIENT_STATE_STORE_PATH = originalStorePath;
  }
  const runtimeServer = unavailable.__TESTING__.server;
  await new Promise((resolve) => runtimeServer.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${runtimeServer.address().port}/client-state`, {
      headers: { authorization: "Bearer test-runner-token", "if-none-match": "*" },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("etag"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).error, "client_state_unavailable");
  } finally {
    await new Promise((resolve, reject) => runtimeServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("client-state patches cover canonical operations and fall back when another writer changed the base", async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/client-state`;
  const headers = { authorization: "Bearer test-runner-token", "content-type": "application/json", "accept-encoding": "identity" };
  const post = (operation, baseEtag) => fetch(url, { method: "POST", headers, body: JSON.stringify({ operation, baseEtag }) });
  try {
    const operations = [
      { type: "directory.upsert", directory: { id: "patch-dir", path: "/patch", displayName: "Patch", markerColor: "green" } },
      { type: "directory.remove", id: "patch-dir" },
      { type: "title-settings.set", modelId: "fixture-model", reasoningEffort: "high" },
      { type: "session.set", backendId: "codex", sessionId: "patch-session", title: "  normalized\n title " },
      { type: "session.set", backendId: "codex", sessionId: "patch-session", note: "canonical note", expectedNote: "" },
      { type: "composer.append", text: "patch composer" },
      ...Array.from({ length: 11 }, (_, index) => ({ type: "draft.set", backendId: "codex", sessionId: `patch-${index}`, text: `draft ${index}` })),
      { type: "draft.set", backendId: "codex", sessionId: "patch-10", text: "" },
    ];
    for (const operation of operations) {
      const get = await fetch(url, { headers });
      const before = (await get.json()).snapshot;
      const baseEtag = get.headers.get("etag");
      const result = await post(operation, baseEtag);
      assert.equal(result.status, 200);
      const payload = await result.json();
      assert.equal(payload.snapshot, undefined);
      assert.equal(payload.patch.baseEtag, baseEtag);
      const changes = payload.patch.changes;
      assert.equal(changes.revision, before.revision + 1);
      const applied = { ...before, ...changes, sessions: changes.sessions ? { ...before.sessions, ...changes.sessions } : before.sessions };
      const after = await fetch(url, { headers });
      assert.deepEqual(applied, (await after.json()).snapshot);
      assert.equal(result.headers.get("etag"), after.headers.get("etag"));
    }
    const base = await fetch(url, { headers }), baseEtag = base.headers.get("etag");
    const first = await post({ type: "session.set", backendId: "claude", sessionId: "other-writer", title: "Other device" });
    assert.equal(first.status, 200);
    const stale = await post({ type: "draft.set", backendId: "codex", sessionId: "stale-base", text: "retained" }, baseEtag);
    const full = await stale.json();
    assert.equal(full.patch, undefined);
    assert.equal(full.snapshot.sessions[JSON.stringify(["claude", "other-writer"])].title, "Other device");
    const concurrentBase = stale.headers.get("etag");
    const concurrent = await Promise.all([post({ type: "composer.append", text: "one" }, concurrentBase), post({ type: "composer.append", text: "two" }, concurrentBase)]);
    const bodies = await Promise.all(concurrent.map((result) => result.json()));
    assert.equal(bodies.filter((body) => body.patch).length, 1);
    assert.equal(bodies.filter((body) => body.snapshot).length, 1);
    const conflict = await post({ type: "session.set", backendId: "codex", sessionId: "patch-session", note: "stale note", expectedNote: "" }, concurrentBase);
    assert.equal(conflict.status, 400);
    assert.equal((await conflict.json()).patch, undefined);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("same-revision restored content cannot receive a patch for a different snapshot", async () => {
  const state = await createClientStateStore(process.env.CLIENT_STATE_STORE_PATH).snapshot();
  const oldEtag = `W/"${createHash("sha256").update(JSON.stringify({ ok: true, snapshot: state })).digest("hex")}"`;
  const restored = { ...state, composerHistory: ["Restored same-revision fixture"] };
  const file = path.join(tempDir, "same-revision-patch.json");
  await fs.writeFile(file, JSON.stringify(restored));
  const originalPath = process.env.CLIENT_STATE_STORE_PATH;
  let runtime;
  try { process.env.CLIENT_STATE_STORE_PATH = file; runtime = await import("../src/server-runtime.mjs?client-state-patch-restored"); }
  finally { process.env.CLIENT_STATE_STORE_PATH = originalPath; }
  const runtimeServer = runtime.__TESTING__.server;
  await new Promise((resolve) => runtimeServer.listen(0, "127.0.0.1", resolve));
  try {
    const result = await fetch(`http://127.0.0.1:${runtimeServer.address().port}/client-state`, { method: "POST",
      headers: { authorization: "Bearer test-runner-token", "content-type": "application/json" },
      body: JSON.stringify({ baseEtag: oldEtag, operation: { type: "draft.set", backendId: "codex", sessionId: "restored", text: "draft" } }),
    });
    const payload = await result.json();
    assert.equal(payload.patch, undefined);
    assert.deepEqual(payload.snapshot.composerHistory, restored.composerHistory);
  } finally { await new Promise((resolve) => runtimeServer.close(resolve)); }
});

test("synthetic large client-state draft saves return only their canonical changes", async () => {
  const file = path.join(tempDir, "large-patch.json");
  const state = { version: 1, revision: 0, titleModelId: "fixture", titleReasoningEffort: "low", directories: [],
    composerHistory: [], drafts: {}, sessions: Object.fromEntries(Array.from({ length: 4928 }, (_, index) => [JSON.stringify(["codex", `synthetic-${index}`]), {
      title: `Synthetic title ${index} ${((index * 2654435761) >>> 0).toString(36)}`, markerColor: "none", note: `Synthetic note ${index}`,
    }])) };
  await fs.writeFile(file, JSON.stringify(state));
  const originalPath = process.env.CLIENT_STATE_STORE_PATH;
  let runtime;
  try { process.env.CLIENT_STATE_STORE_PATH = file; runtime = await import("../src/server-runtime.mjs?client-state-large-patch"); }
  finally { process.env.CLIENT_STATE_STORE_PATH = originalPath; }
  const runtimeServer = runtime.__TESTING__.server;
  await new Promise((resolve) => runtimeServer.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${runtimeServer.address().port}/client-state`;
    const headers = { authorization: "Bearer test-runner-token", "content-type": "application/json", "accept-encoding": "gzip" };
    const operation = { type: "draft.set", backendId: "codex", sessionId: "synthetic-draft", text: "Synthetic draft text. ".repeat(30) };
    const legacy = await fetch(url, { method: "POST", headers, body: JSON.stringify({ operation }) });
    const legacyBody = await legacy.text(), baseEtag = legacy.headers.get("etag");
    const patch = await fetch(url, { method: "POST", headers, body: JSON.stringify({ operation, baseEtag }) });
    const patchBody = await patch.text();
    const body = JSON.parse(patchBody);
    assert.deepEqual(body.patch.changes.drafts[JSON.stringify(["codex", "synthetic-draft"])].text, operation.text);
    assert.equal(body.patch.changes.sessions, undefined);
    assert.ok(patchBody.length < legacyBody.length / 100);
    assert.ok(Number(patch.headers.get("content-length")) < Number(legacy.headers.get("content-length")) / 10);
    console.info(`[client-state fixture] legacyDecoded=${Buffer.byteLength(legacyBody)} patchDecoded=${Buffer.byteLength(patchBody)} legacyGzipBody=${legacy.headers.get("content-length")} patchGzipBody=${patch.headers.get("content-length")}; HTTP response bodies only`);
  } finally { await new Promise((resolve) => runtimeServer.close(resolve)); }
});
