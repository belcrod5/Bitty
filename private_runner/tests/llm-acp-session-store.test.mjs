import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLlmAcpSessionStore } from "../src/llm-acp-session-store.mjs";

const normalizeDirectory = (value) => String(value || "").trim() || ".";
const normalizeTimestamp = (value) => {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
};

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

test("migrates a legacy ACP root only after explicit confirmation", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-acp-store-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const storePath = path.join(workspaceRoot, "private_runner", "logs", "acp_sessions.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({
    version: 2,
    sessions: {
      legacy: {
        directory: ".",
        rootRelativePath: ".",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    latestByDirectory: { ".": "legacy" },
  }));

  const store = createLlmAcpSessionStore({
    acpSessionStorePath: storePath,
    compareSessionHistoryEntries: () => 0,
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: true,
    workspaceRoot,
  });

  const workspaceReal = await fs.realpath(workspaceRoot);
  const sessions = await store.listAcpSessionsForDirectory(".");
  assert.equal(sessions.length, 0);
  assert.equal(await store.resolveSessionIdForRootDir("", workspaceReal), "generated");

  const untouched = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.equal(untouched.version, 2);
  assert.equal(untouched.sessions.legacy.directory, ".");

  await store.migrateAcpSessionDirectoryIdentity(".", workspaceReal);
  const migrated = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.equal(migrated.version, 3);
  assert.equal(migrated.sessions.legacy.directory, workspaceReal);
  assert.equal(migrated.sessions.legacy.rootRelativePath, workspaceReal);
  assert.equal(migrated.latestByDirectory[workspaceReal], "legacy");
  assert.equal((await store.listAcpSessionsForDirectory(workspaceReal)).length, 1);
});

test("stores new ACP roots as absolute real paths", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-acp-store-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const targetRoot = path.join(workspaceRoot, "project");
  const linkedRoot = path.join(workspaceRoot, "project-link");
  const storePath = path.join(workspaceRoot, "acp_sessions.json");
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.symlink(targetRoot, linkedRoot);

  const store = createLlmAcpSessionStore({
    acpSessionStorePath: storePath,
    compareSessionHistoryEntries: () => 0,
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: true,
    workspaceRoot,
  });

  await store.bindSessionToRootDir("new-session", linkedRoot);
  const targetReal = await fs.realpath(targetRoot);
  const persisted = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.equal(persisted.sessions["new-session"].directory, targetReal);
  assert.equal(await store.resolveSessionIdForRootDir("", targetRoot), "new-session");
});

test("reports whether an ACP read target exists even when its timestamp is unchanged", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-acp-store-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const store = createLlmAcpSessionStore({
    acpSessionStorePath: path.join(workspaceRoot, "acp_sessions.json"),
    compareSessionHistoryEntries: () => 0,
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: true,
    workspaceRoot,
  });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await store.bindSessionToRootDir("existing", workspaceRoot);
  const lastReadAt = "2026-07-29T02:00:00.000Z";

  const [first] = await store.markAcpSessionsRead(["existing"], lastReadAt);
  assert.equal(first.updated, true);
  assert.equal(first.entryFound, true);
  const [unchanged] = await store.markAcpSessionsRead(["existing"], lastReadAt);
  assert.equal(unchanged.updated, false);
  assert.equal(unchanged.entryFound, true);
  const [missing] = await store.markAcpSessionsRead(["missing"], lastReadAt);
  assert.equal(missing.updated, false);
  assert.equal(missing.entryFound, false);
});

test("marks an ACP batch with one persist result and reports missing ids", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-acp-store-batch-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const storePath = path.join(tempRoot, "acp_sessions.json");
  const store = createLlmAcpSessionStore({
    acpSessionStorePath: storePath,
    compareSessionHistoryEntries: () => 0,
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: true,
    workspaceRoot: tempRoot,
  });
  await store.bindSessionToRootDir("one", tempRoot);
  await store.bindSessionToRootDir("two", tempRoot);

  const results = await store.markAcpSessionsRead(
    ["one", "missing", "two"],
    "2026-08-10T00:00:00.000Z",
  );
  assert.deepEqual(results.map(({ sessionId, updated, entryFound }) => ({ sessionId, updated, entryFound })), [
    { sessionId: "one", updated: true, entryFound: true },
    { sessionId: "missing", updated: false, entryFound: false },
    { sessionId: "two", updated: true, entryFound: true },
  ]);
  const persisted = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.equal(persisted.sessions.one.lastReadAt, "2026-08-10T00:00:00.000Z");
  assert.equal(persisted.sessions.two.lastReadAt, "2026-08-10T00:00:00.000Z");
});

test("marks every canonical-directory ACP session with one persist", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-acp-store-directory-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const directory = path.join(tempRoot, "project");
  const alias = path.join(tempRoot, "project-link");
  const storePath = path.join(tempRoot, "acp_sessions.json");
  await fs.mkdir(directory);
  await fs.symlink(directory, alias);
  await fs.writeFile(storePath, JSON.stringify({
    sessions: Object.fromEntries(Array.from({ length: 105 }, (_, index) => [`session-${index}`, {
      directory,
      updatedAt: "2026-08-10T00:00:00.000Z",
      lastReadAt: "",
    }])),
  }));
  let persistCount = 0;
  let blockNextPersist = false;
  const persistEntered = deferred();
  const releasePersist = deferred();
  const store = createLlmAcpSessionStore({
    acpSessionStorePath: storePath,
    compareSessionHistoryEntries: () => 0,
    fileSystem: {
      ...fs,
      async rename(...args) {
        persistCount += 1;
        if (blockNextPersist) {
          blockNextPersist = false;
          persistEntered.resolve();
          await releasePersist.promise;
        }
        return await fs.rename(...args);
      },
    },
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: true,
    workspaceRoot: tempRoot,
  });
  const canonical = await fs.realpath(alias);
  blockNextPersist = true;
  const directoryRead = store.markAcpDirectoryRead(canonical, "2026-08-10T01:00:00.000Z");
  await persistEntered.promise;
  const laterUnread = store.markAcpSessionsRead(["session-0"], new Date(0).toISOString());
  assert.equal(persistCount, 1);
  releasePersist.resolve();
  const result = await directoryRead;
  await laterUnread;
  assert.equal(result.selectedSessionIds.length, 105);
  assert.equal(result.updatedSessionIds.length, 105);
  assert.equal((await store.listAcpSessionsForDirectory(canonical))[0].lastReadAt, new Date(0).toISOString());
});

test("ACP directory read keeps live state unread after write or rename failure and can retry", async (t) => {
  for (const failedOperation of ["writeFile", "rename"]) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `bitty-acp-${failedOperation}-`));
    t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
    const storePath = path.join(tempRoot, "acp_sessions.json");
    await fs.writeFile(storePath, JSON.stringify({
      sessions: {
        target: {
          directory: tempRoot,
          updatedAt: "2026-08-10T02:00:00.000Z",
          lastReadAt: "",
        },
      },
    }));
    let failNext = true;
    const fileSystem = {
      ...fs,
      async [failedOperation](...args) {
        if (failNext) {
          failNext = false;
          throw Object.assign(new Error(`${failedOperation} failed`), { code: "EIO" });
        }
        return await fs[failedOperation](...args);
      },
    };
    const store = createLlmAcpSessionStore({
      acpSessionStorePath: storePath,
      compareSessionHistoryEntries: () => 0,
      fileSystem,
      generateLlmExecutionSessionId: () => "generated",
      makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
      normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
      normalizeSessionRootRelativePath: normalizeDirectory,
      normalizeSessionUpdatedAt: normalizeTimestamp,
      sessionRootBindingEnabled: true,
      workspaceRoot: tempRoot,
    });
    const canonical = await fs.realpath(tempRoot);

    await assert.rejects(
      store.markAcpDirectoryRead(canonical, "2026-08-10T03:00:00.000Z"),
      /failed/,
    );
    assert.equal((await store.listAcpSessionsForDirectory(canonical))[0].lastReadAt, "");
    const retry = await store.markAcpDirectoryRead(canonical, "2026-08-10T03:00:00.000Z");
    assert.deepEqual(retry.updatedSessionIds, ["target"]);
    assert.equal(
      (await store.listAcpSessionsForDirectory(canonical))[0].lastReadAt,
      "2026-08-10T03:00:00.000Z",
    );
  }
});
