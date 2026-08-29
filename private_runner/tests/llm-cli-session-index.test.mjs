import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLlmCliSessionIndex } from "../src/llm-cli-session-index.mjs";
import { createLlmCliRolloutWriter } from "../src/llm-cli-rollout-writer.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

test("migrates unchanged session metadata and excludes subagents only from user unread projection", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-cli-subagent-migration-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const rootDir = path.join(tempRoot, "repo");
  const sessionsDir = path.join(tempRoot, "sessions");
  const indexPath = path.join(tempRoot, "cli_sessions_index.json");
  await Promise.all([fs.mkdir(rootDir), fs.mkdir(sessionsDir)]);
  const parentFile = path.join(sessionsDir, "rollout-parent.jsonl");
  const childFile = path.join(sessionsDir, "rollout-child.jsonl");
  await fs.writeFile(parentFile, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "parent", cwd: rootDir, timestamp: "2026-08-11T00:00:00.000Z" },
  })}\n`);
  await fs.writeFile(childFile, `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: "child",
      cwd: rootDir,
      timestamp: "2026-08-11T00:01:00.000Z",
      thread_source: "subagent",
      parent_thread_id: "parent",
      source: { subagent: true },
    },
  })}\n`);
  const [parentStat, childStat] = await Promise.all([fs.stat(parentFile), fs.stat(childFile)]);
  await fs.writeFile(indexPath, JSON.stringify({
    version: 2,
    entries: [
      {
        filePath: parentFile,
        mtimeMs: parentStat.mtimeMs,
        size: parentStat.size,
        sessionId: "parent",
        cwd: rootDir,
        updatedAt: "2026-08-11T00:00:00.000Z",
        lastReadAt: "2026-08-11T00:02:00.000Z",
      },
      {
        filePath: childFile,
        mtimeMs: childStat.mtimeMs,
        size: childStat.size,
        sessionId: "child",
        cwd: rootDir,
        updatedAt: "2026-08-11T00:01:00.000Z",
        lastReadAt: new Date(0).toISOString(),
      },
    ],
  }));
  const index = createLlmCliSessionIndex({
    cliSessionIndexPath: indexPath,
    cliSessionIndexRefreshMinIntervalMs: 60_000,
    cliSessionScanMaxFiles: 10,
    codeCliSessionsDir: sessionsDir,
    compareSessionHistoryEntries: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeReasoningEffort: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: (value) => String(value || "").trim(),
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    toUnixPath: (value) => String(value || "").replaceAll("\\", "/"),
    toWorkspaceRelativeFromAbsolutePath: () => "",
  });

  const visible = await index.listCliSessionsForDirectories([rootDir], {
    forceRefresh: true,
    includeSubagents: false,
  });
  assert.deepEqual(visible[0].sessions.map((entry) => entry.sessionId), ["parent"]);
  const all = await index.listCliSessionsForDirectory(rootDir);
  assert.deepEqual(all.map((entry) => [entry.sessionId, entry.isSubagent, entry.parentSessionId]), [
    ["child", true, "parent"],
    ["parent", false, ""],
  ]);
  const persisted = JSON.parse(await fs.readFile(indexPath, "utf8"));
  assert.equal(persisted.version, 4);
  assert.equal(persisted.entries.find((entry) => entry.sessionId === "child").lastReadAt, new Date(0).toISOString());

  const directoryRead = await index.markCliDirectoryRead(rootDir, {
    lastReadAt: "2026-08-11T00:03:00.000Z",
  });
  assert.deepEqual(directoryRead.selectedSessionIds.sort(), ["child", "parent"]);
  assert.equal(
    (await index.listCliSessionsForDirectory(rootDir)).find((entry) => entry.sessionId === "child").lastReadAt,
    "2026-08-11T00:03:00.000Z",
  );
});

test("absolute CLI lookup does not match a copied relative worktree identity", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-cli-index-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const mainRoot = path.join(tempRoot, "main");
  const worktreeRoot = path.join(tempRoot, "worktree");
  const worktreeLink = path.join(tempRoot, "worktree-link");
  const sessionsDir = path.join(tempRoot, "sessions");
  const indexPath = path.join(tempRoot, "cli_sessions_index.json");
  await Promise.all([
    fs.mkdir(mainRoot, { recursive: true }),
    fs.mkdir(worktreeRoot, { recursive: true }),
    fs.mkdir(sessionsDir, { recursive: true }),
  ]);
  await fs.symlink(worktreeRoot, worktreeLink);
  const mainFile = path.join(sessionsDir, "rollout-main.jsonl");
  const worktreeFile = path.join(sessionsDir, "rollout-worktree.jsonl");
  await Promise.all([
    fs.writeFile(mainFile, `${JSON.stringify({
      type: "session_meta",
      payload: { id: "shared-session", cwd: mainRoot, timestamp: "2026-01-01T00:00:00.000Z" },
    })}\n`),
    fs.writeFile(worktreeFile, `${JSON.stringify({
      type: "session_meta",
      payload: { id: "shared-session", cwd: worktreeLink, timestamp: "2026-01-02T00:00:00.000Z" },
    })}\n`),
  ]);
  const [mainStat, worktreeStat] = await Promise.all([fs.stat(mainFile), fs.stat(worktreeFile)]);
  await fs.writeFile(indexPath, JSON.stringify({
    version: 2,
    entries: [
      {
        filePath: mainFile,
        mtimeMs: mainStat.mtimeMs,
        size: mainStat.size,
        sessionId: "shared-session",
        cwd: mainRoot,
        directory: ".",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        filePath: worktreeFile,
        mtimeMs: worktreeStat.mtimeMs,
        size: worktreeStat.size,
        sessionId: "shared-session",
        cwd: worktreeLink,
        directory: ".",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
  }));

  let persistCount = 0;
  let blockNextPersist = false;
  const persistEntered = deferred();
  const releasePersist = deferred();
  const index = createLlmCliSessionIndex({
    cliSessionIndexPath: indexPath,
    cliSessionIndexRefreshMinIntervalMs: 60_000,
    cliSessionScanMaxFiles: 10,
    codeCliSessionsDir: sessionsDir,
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
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeReasoningEffort: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: (value) => String(value || "").trim() || ".",
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    toUnixPath: (value) => String(value || "").replaceAll("\\", "/"),
    toWorkspaceRelativeFromAbsolutePath: (value) => (
      path.resolve(String(value || "")) === worktreeRoot ? "." : ""
    ),
  });

  const worktreeReal = await fs.realpath(worktreeRoot);
  const sessions = await index.listCliSessionsForDirectory(worktreeReal);
  assert.deepEqual(sessions.map((session) => session.sessionId), ["shared-session"]);
  assert.equal(sessions[0].directory, worktreeReal);
  const batchEntries = await index.findCliSessionIndexEntriesBySessionIds(
    ["missing-session", "shared-session", "shared-session"],
    { directory: worktreeReal },
  );
  assert.deepEqual(batchEntries.map((entry) => entry.filePath), [worktreeFile]);

  const [mainRawBefore, worktreeRawBefore] = await Promise.all([
    fs.readFile(mainFile, "utf8"),
    fs.readFile(worktreeFile, "utf8"),
  ]);
  const [markResult] = await index.markCliSessionsRead(["shared-session"], {
    directory: worktreeReal,
    lastReadAt: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(markResult.updated, true);
  // Rollout files must stay untouched: rewriting them clobbers the mtime that
  // codex thread/list reports as the session updatedAt.
  assert.equal(await fs.readFile(mainFile, "utf8"), mainRawBefore);
  assert.equal(await fs.readFile(worktreeFile, "utf8"), worktreeRawBefore);
  const readSessions = await index.listCliSessionsForDirectory(worktreeReal);
  assert.equal(readSessions[0].lastReadAt, "2026-02-01T00:00:00.000Z");
  const persisted = JSON.parse(await fs.readFile(indexPath, "utf8"));
  const persistedWorktree = persisted.entries.find((entry) => entry.filePath === worktreeFile);
  assert.equal(persistedWorktree.lastReadAt, "2026-02-01T00:00:00.000Z");

  const batch = await index.markCliSessionsRead(["missing-session", "shared-session"], {
    directory: worktreeReal,
    lastReadAt: "2026-03-01T00:00:00.000Z",
  });
  assert.deepEqual(batch.map(({ sessionId, updated, entryFound }) => ({ sessionId, updated, entryFound })), [
    { sessionId: "missing-session", updated: false, entryFound: false },
    { sessionId: "shared-session", updated: true, entryFound: true },
  ]);
  const persistedAfterBatch = JSON.parse(await fs.readFile(indexPath, "utf8"));
  assert.equal(
    persistedAfterBatch.entries.find((entry) => entry.filePath === worktreeFile).lastReadAt,
    "2026-03-01T00:00:00.000Z",
  );
  persistCount = 0;
  blockNextPersist = true;
  const directoryRead = index.markCliDirectoryRead(worktreeReal, {
    lastReadAt: "2026-04-01T00:00:00.000Z",
  });
  await persistEntered.promise;
  const laterUnread = index.markCliSessionsRead(["shared-session"], {
    directory: worktreeReal,
    lastReadAt: new Date(0).toISOString(),
  });
  assert.equal(persistCount, 1);
  releasePersist.resolve();
  const directoryResult = await directoryRead;
  await laterUnread;
  assert.deepEqual(directoryResult.selectedSessionIds, ["shared-session"]);
  assert.deepEqual(directoryResult.updatedSessionIds, ["shared-session"]);
  assert.equal((await index.listCliSessionsForDirectory(worktreeReal))[0].lastReadAt, new Date(0).toISOString());
});

test("first CLI directory read folds stale scan and mutation into one persist", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-cli-directory-first-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const rootDir = path.join(tempRoot, "root");
  const sessionsDir = path.join(tempRoot, "sessions");
  const indexPath = path.join(tempRoot, "cli_sessions_index.json");
  await Promise.all([fs.mkdir(rootDir), fs.mkdir(sessionsDir)]);
  await fs.writeFile(path.join(sessionsDir, "rollout-session.jsonl"), `${JSON.stringify({
    type: "session_meta",
    payload: { id: "session-1", cwd: rootDir, timestamp: "2026-08-10T01:00:00.000Z" },
  })}\n`);
  let persistCount = 0;
  const index = createLlmCliSessionIndex({
    cliSessionIndexPath: indexPath,
    cliSessionIndexRefreshMinIntervalMs: 60_000,
    cliSessionScanMaxFiles: 10,
    codeCliSessionsDir: sessionsDir,
    compareSessionHistoryEntries: () => 0,
    fileSystem: {
      ...fs,
      async rename(...args) {
        persistCount += 1;
        return await fs.rename(...args);
      },
    },
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeReasoningEffort: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: (value) => String(value || "").trim() || ".",
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    toUnixPath: (value) => String(value || "").replaceAll("\\", "/"),
    toWorkspaceRelativeFromAbsolutePath: () => "",
  });

  const result = await index.markCliDirectoryRead(await fs.realpath(rootDir), {
    lastReadAt: "2026-08-10T02:00:00.000Z",
  });
  assert.equal(persistCount, 1);
  assert.deepEqual(result.selectedSessionIds, ["session-1"]);
  assert.deepEqual(result.updatedSessionIds, ["session-1"]);
  const persisted = JSON.parse(await fs.readFile(indexPath, "utf8"));
  assert.equal(persisted.entries[0].lastReadAt, "2026-08-10T02:00:00.000Z");
});

test("CLI directory read keeps live state unread after write or rename failure and can retry", async (t) => {
  for (const failedOperation of ["writeFile", "rename"]) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `bitty-cli-${failedOperation}-`));
    t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
    const rootDir = path.join(tempRoot, "root");
    const sessionsDir = path.join(tempRoot, "sessions");
    const indexPath = path.join(tempRoot, "cli_sessions_index.json");
    await Promise.all([fs.mkdir(rootDir), fs.mkdir(sessionsDir)]);
    const rolloutFile = path.join(sessionsDir, "rollout-session.jsonl");
    await fs.writeFile(rolloutFile, `${JSON.stringify({
      type: "session_meta",
      payload: { id: "session-1", cwd: rootDir, timestamp: "2026-08-10T01:00:00.000Z" },
    })}\n`);
    const stat = await fs.stat(rolloutFile);
    await fs.writeFile(indexPath, JSON.stringify({
      version: 2,
      entries: [{
        filePath: rolloutFile,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sessionId: "session-1",
        cwd: rootDir,
        directory: "",
        updatedAt: "2026-08-10T01:00:00.000Z",
        lastReadAt: "",
      }],
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
    const index = createLlmCliSessionIndex({
      cliSessionIndexPath: indexPath,
      cliSessionIndexRefreshMinIntervalMs: 60_000,
      cliSessionScanMaxFiles: 10,
      codeCliSessionsDir: sessionsDir,
      compareSessionHistoryEntries: () => 0,
      fileSystem,
      normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
      normalizeReasoningEffort: (value) => String(value || "").trim(),
      normalizeSessionRootRelativePath: (value) => String(value || "").trim() || ".",
      normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
      toUnixPath: (value) => String(value || "").replaceAll("\\", "/"),
      toWorkspaceRelativeFromAbsolutePath: () => "",
    });
    const canonical = await fs.realpath(rootDir);

    await assert.rejects(
      index.markCliDirectoryRead(canonical, { lastReadAt: "2026-08-10T02:00:00.000Z" }),
      /failed/,
    );
    assert.equal((await index.listCliSessionsForDirectory(canonical))[0].lastReadAt, "");
    const retry = await index.markCliDirectoryRead(canonical, {
      lastReadAt: "2026-08-10T02:00:00.000Z",
    });
    assert.deepEqual(retry.updatedSessionIds, ["session-1"]);
    assert.equal(
      (await index.listCliSessionsForDirectory(canonical))[0].lastReadAt,
      "2026-08-10T02:00:00.000Z",
    );
  }
});

test("index lastReadAt survives a rescan after the rollout file changes", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-cli-index-rescan-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const rootDir = path.join(tempRoot, "root");
  const sessionsDir = path.join(tempRoot, "sessions");
  const indexPath = path.join(tempRoot, "cli_sessions_index.json");
  await Promise.all([
    fs.mkdir(rootDir, { recursive: true }),
    fs.mkdir(sessionsDir, { recursive: true }),
  ]);
  const rolloutFile = path.join(sessionsDir, "rollout-session.jsonl");
  await fs.writeFile(rolloutFile, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "session-1", cwd: rootDir, timestamp: "2026-01-01T00:00:00.000Z" },
  })}\n`);

  const index = createLlmCliSessionIndex({
    cliSessionIndexPath: indexPath,
    cliSessionIndexRefreshMinIntervalMs: 60_000,
    cliSessionScanMaxFiles: 10,
    codeCliSessionsDir: sessionsDir,
    compareSessionHistoryEntries: () => 0,
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeReasoningEffort: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: (value) => String(value || "").trim() || ".",
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    toUnixPath: (value) => String(value || "").replaceAll("\\", "/"),
    toWorkspaceRelativeFromAbsolutePath: () => "",
  });

  const rootReal = await fs.realpath(rootDir);
  await index.listCliSessionsForDirectory(rootReal);
  await index.markCliSessionsRead(["session-1"], {
    directory: rootReal,
    lastReadAt: "2026-02-01T00:00:00.000Z",
  });

  // Session continues: the rollout file grows, forcing a meta re-read on rescan.
  await fs.appendFile(rolloutFile, `${JSON.stringify({
    timestamp: "2026-02-02T00:00:00.000Z",
    type: "event_msg",
    payload: { type: "task_complete" },
  })}\n`);
  const rolloutUpdatedAt = new Date("2026-02-02T00:00:00.000Z");
  await fs.utimes(rolloutFile, rolloutUpdatedAt, rolloutUpdatedAt);
  const sessions = await index.listCliSessionsForDirectory(rootReal, {
    forceRefresh: true,
    useRolloutMtime: true,
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].lastReadAt, "2026-02-01T00:00:00.000Z");
  assert.equal(sessions[0].createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(sessions[0].updatedAt, "2026-02-02T00:00:00.000Z");

  await index.upsertCliSessionIndexEntryFromRolloutFile(rolloutFile, {
    sessionId: "session-1",
    cwd: rootReal,
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  const continued = await index.listCliSessionsForDirectory(rootReal);
  assert.equal(continued[0].createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(continued[0].updatedAt, "2026-03-01T00:00:00.000Z");
});

test("cached epoch unread wins over legacy rollout last_read_at during scan and upsert", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-cli-index-legacy-read-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const rootDir = path.join(tempRoot, "root");
  const sessionsDir = path.join(tempRoot, "sessions");
  const indexPath = path.join(tempRoot, "cli_sessions_index.json");
  await Promise.all([fs.mkdir(rootDir), fs.mkdir(sessionsDir)]);
  const rolloutFile = path.join(sessionsDir, "rollout-session.jsonl");
  const legacyLastReadAt = "2026-08-10T03:00:00.000Z";
  await fs.writeFile(rolloutFile, `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: "session-1",
      cwd: rootDir,
      timestamp: "2026-08-10T01:00:00.000Z",
      last_read_at: legacyLastReadAt,
    },
  })}\n`);
  const index = createLlmCliSessionIndex({
    cliSessionIndexPath: indexPath,
    cliSessionIndexRefreshMinIntervalMs: 60_000,
    cliSessionScanMaxFiles: 10,
    codeCliSessionsDir: sessionsDir,
    compareSessionHistoryEntries: () => 0,
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeReasoningEffort: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: (value) => String(value || "").trim() || ".",
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    toUnixPath: (value) => String(value || "").replaceAll("\\", "/"),
    toWorkspaceRelativeFromAbsolutePath: () => "",
  });
  const canonical = await fs.realpath(rootDir);

  assert.equal((await index.listCliSessionsForDirectory(canonical))[0].lastReadAt, legacyLastReadAt);
  await index.markCliSessionsRead(["session-1"], {
    directory: canonical,
    lastReadAt: new Date(0).toISOString(),
  });
  await fs.appendFile(rolloutFile, `${JSON.stringify({ type: "event_msg", payload: {} })}\n`);
  assert.equal(
    (await index.listCliSessionsForDirectory(canonical, { forceRefresh: true }))[0].lastReadAt,
    new Date(0).toISOString(),
  );

  await index.upsertCliSessionIndexEntryFromRolloutFile(rolloutFile, {
    sessionId: "session-1",
    cwd: rootDir,
    lastReadAt: "2026-08-10T04:00:00.000Z",
    updatedAt: "2026-08-10T05:00:00.000Z",
  });
  assert.equal(
    (await index.listCliSessionsForDirectory(canonical))[0].lastReadAt,
    new Date(0).toISOString(),
  );
  const persisted = JSON.parse(await fs.readFile(indexPath, "utf8"));
  assert.equal(persisted.entries[0].lastReadAt, new Date(0).toISOString());
});

test("concurrent forced refresh shares one trailing scan and preserves upsert and mark-read", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-cli-index-race-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const rootDir = path.join(tempRoot, "root");
  const sessionsDir = path.join(tempRoot, "sessions");
  const indexPath = path.join(tempRoot, "cli_sessions_index.json");
  await Promise.all([fs.mkdir(rootDir), fs.mkdir(sessionsDir)]);
  const rolloutFile = path.join(sessionsDir, "rollout-session.jsonl");
  await fs.writeFile(rolloutFile, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "session-1", cwd: rootDir, timestamp: "2026-01-01T00:00:00.000Z" },
  })}\n`);

  let readdirCount = 0;
  let blockNextRolloutStat = false;
  const statEntered = deferred();
  const releaseStat = deferred();
  const fileSystem = {
    ...fs,
    async readdir(...args) {
      readdirCount += 1;
      return await fs.readdir(...args);
    },
    async stat(filePath, ...args) {
      if (blockNextRolloutStat && path.resolve(filePath) === path.resolve(rolloutFile)) {
        blockNextRolloutStat = false;
        statEntered.resolve();
        await releaseStat.promise;
      }
      return await fs.stat(filePath, ...args);
    },
  };
  const index = createLlmCliSessionIndex({
    cliSessionIndexPath: indexPath,
    cliSessionIndexRefreshMinIntervalMs: 60_000,
    cliSessionScanMaxFiles: 10,
    codeCliSessionsDir: sessionsDir,
    compareSessionHistoryEntries: () => 0,
    fileSystem,
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeReasoningEffort: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: (value) => String(value || "").trim() || ".",
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    toUnixPath: (value) => String(value || "").replaceAll("\\", "/"),
    toWorkspaceRelativeFromAbsolutePath: () => "",
  });
  const rootReal = await fs.realpath(rootDir);
  await index.listCliSessionsForDirectory(rootReal);
  await fs.appendFile(rolloutFile, `${JSON.stringify({ type: "event_msg", payload: {} })}\n`);

  readdirCount = 0;
  blockNextRolloutStat = true;
  const firstRefresh = index.listCliSessionsForDirectory(rootReal, { forceRefresh: true });
  await statEntered.promise;
  const secondRefresh = index.listCliSessionsForDirectory(rootReal, { forceRefresh: true });
  await index.upsertCliSessionIndexEntryFromRolloutFile(rolloutFile, {
    sessionId: "session-1",
    cwd: rootDir,
    updatedAt: "2026-04-01T00:00:00.000Z",
  });
  assert.equal(
    JSON.parse(await fs.readFile(indexPath, "utf8")).entries[0].updatedAt,
    "2026-04-01T00:00:00.000Z",
  );
  const markRead = index.markCliSessionsRead(["session-1"], {
    directory: rootReal,
    lastReadAt: "2026-05-01T00:00:00.000Z",
  });
  releaseStat.resolve();
  await Promise.all([firstRefresh, secondRefresh, markRead]);

  assert.equal(readdirCount, 2);
  const [session] = await index.listCliSessionsForDirectory(rootReal);
  assert.equal(session.updatedAt, "2026-04-01T00:00:00.000Z");
  assert.equal(session.lastReadAt, "2026-05-01T00:00:00.000Z");
  const persisted = JSON.parse(await fs.readFile(indexPath, "utf8"));
  assert.equal(persisted.entries[0].updatedAt, "2026-04-01T00:00:00.000Z");
  assert.equal(persisted.entries[0].lastReadAt, "2026-05-01T00:00:00.000Z");
});

test("force callers share the next generation without losing a force during that scan", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-cli-index-trailing-force-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const rootDir = path.join(tempRoot, "root");
  const sessionsDir = path.join(tempRoot, "sessions");
  const indexPath = path.join(tempRoot, "cli_sessions_index.json");
  await Promise.all([fs.mkdir(rootDir), fs.mkdir(sessionsDir)]);
  const alreadyScannedFile = path.join(sessionsDir, "rollout-z-a.jsonl");
  const blockedFile = path.join(sessionsDir, "rollout-a-b.jsonl");
  const metaLine = (id) => `${JSON.stringify({
    type: "session_meta",
    payload: { id, cwd: rootDir, timestamp: "2026-01-01T00:00:00.000Z" },
  })}\n`;
  await Promise.all([
    fs.writeFile(alreadyScannedFile, metaLine("session-a")),
    fs.writeFile(blockedFile, metaLine("session-b")),
  ]);

  let readdirCount = 0;
  const bStatGates = [];
  const fileSystem = {
    ...fs,
    async readdir(...args) {
      readdirCount += 1;
      return await fs.readdir(...args);
    },
    async stat(filePath, ...args) {
      if (bStatGates.length > 0 && path.resolve(filePath) === path.resolve(blockedFile)) {
        const gate = bStatGates.shift();
        gate.entered.resolve();
        await gate.release.promise;
      }
      return await fs.stat(filePath, ...args);
    },
  };
  const index = createLlmCliSessionIndex({
    cliSessionIndexPath: indexPath,
    cliSessionIndexRefreshMinIntervalMs: 60_000,
    cliSessionScanMaxFiles: 10,
    codeCliSessionsDir: sessionsDir,
    compareSessionHistoryEntries: () => 0,
    fileSystem,
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeReasoningEffort: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: (value) => String(value || "").trim() || ".",
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    toUnixPath: (value) => String(value || "").replaceAll("\\", "/"),
    toWorkspaceRelativeFromAbsolutePath: () => "",
  });
  const rootReal = await fs.realpath(rootDir);
  await index.listCliSessionsForDirectory(rootReal);

  readdirCount = 0;
  const firstGate = { entered: deferred(), release: deferred() };
  const secondGate = { entered: deferred(), release: deferred() };
  const thirdGate = { entered: deferred(), release: deferred() };
  bStatGates.push(firstGate, secondGate, thirdGate);
  const activeRefresh = index.listCliSessionsForDirectory(rootReal, { forceRefresh: true });
  await firstGate.entered.promise;
  await fs.appendFile(alreadyScannedFile, `${JSON.stringify({ type: "event_msg", payload: {} })}\n`);
  const firstGrowthStat = await fs.stat(alreadyScannedFile);
  const forceDuringRefresh = index.listCliSessionsForDirectory(rootReal, { forceRefresh: true });
  const anotherForceDuringRefresh = index.listCliSessionsForDirectory(rootReal, { forceRefresh: true });
  firstGate.release.resolve();

  await secondGate.entered.promise;
  await activeRefresh;
  await fs.appendFile(alreadyScannedFile, `${JSON.stringify({ type: "event_msg", payload: {} })}\n`);
  const forceDuringSecondGeneration = index.listCliSessionsForDirectory(rootReal, { forceRefresh: true });
  secondGate.release.resolve();

  await thirdGate.entered.promise;
  await Promise.all([forceDuringRefresh, anotherForceDuringRefresh]);
  const secondGenerationPersisted = JSON.parse(await fs.readFile(indexPath, "utf8"));
  assert.equal(
    secondGenerationPersisted.entries.find((entry) => entry.filePath === alreadyScannedFile).size,
    firstGrowthStat.size,
  );
  thirdGate.release.resolve();
  await forceDuringSecondGeneration;

  assert.equal(readdirCount, 3);
  const grownStat = await fs.stat(alreadyScannedFile);
  const persisted = JSON.parse(await fs.readFile(indexPath, "utf8"));
  assert.equal(
    persisted.entries.find((entry) => entry.filePath === alreadyScannedFile).size,
    grownStat.size,
  );
});

test("refresh failure rejects queued callers and the next force starts a clean generation", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-cli-index-refresh-recovery-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const rootDir = path.join(tempRoot, "root");
  const sessionsDir = path.join(tempRoot, "sessions");
  await Promise.all([fs.mkdir(rootDir), fs.mkdir(sessionsDir)]);
  const failedScanEntered = deferred();
  const releaseFailedScan = deferred();
  let failNextScan = true;
  let readdirCount = 0;
  const fileSystem = {
    ...fs,
    async readdir(...args) {
      readdirCount += 1;
      if (failNextScan) {
        failNextScan = false;
        failedScanEntered.resolve();
        await releaseFailedScan.promise;
        throw new Error("scan failed");
      }
      return await fs.readdir(...args);
    },
  };
  const index = createLlmCliSessionIndex({
    cliSessionIndexPath: path.join(tempRoot, "cli_sessions_index.json"),
    cliSessionIndexRefreshMinIntervalMs: 60_000,
    cliSessionScanMaxFiles: 10,
    codeCliSessionsDir: sessionsDir,
    compareSessionHistoryEntries: () => 0,
    fileSystem,
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeReasoningEffort: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: (value) => String(value || "").trim() || ".",
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    toUnixPath: (value) => String(value || "").replaceAll("\\", "/"),
    toWorkspaceRelativeFromAbsolutePath: () => "",
  });
  const rootReal = await fs.realpath(rootDir);
  const failingRefresh = index.listCliSessionsForDirectory(rootReal, { forceRefresh: true });
  await failedScanEntered.promise;
  const queuedRefresh = index.listCliSessionsForDirectory(rootReal, { forceRefresh: true });
  const failingAssertion = assert.rejects(failingRefresh, /scan failed/);
  const queuedAssertion = assert.rejects(queuedRefresh, /scan failed/);
  releaseFailedScan.resolve();
  await Promise.all([failingAssertion, queuedAssertion]);

  assert.deepEqual(
    await index.listCliSessionsForDirectory(rootReal, { forceRefresh: true }),
    [],
  );
  assert.equal(readdirCount, 2);
});

test("refresh apply preserves a concurrent mark-unread mutation even though its timestamp is older", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-cli-index-mark-race-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const rootDir = path.join(tempRoot, "root");
  const rootLink = path.join(tempRoot, "root-link");
  const sessionsDir = path.join(tempRoot, "sessions");
  const indexPath = path.join(tempRoot, "cli_sessions_index.json");
  await Promise.all([fs.mkdir(rootDir), fs.mkdir(sessionsDir)]);
  await fs.symlink(rootDir, rootLink);
  const rolloutFile = path.join(sessionsDir, "rollout-session.jsonl");
  await fs.writeFile(rolloutFile, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "session-1", cwd: rootLink, timestamp: "2026-01-01T00:00:00.000Z" },
  })}\n`);
  const stat = await fs.stat(rolloutFile);
  await fs.writeFile(indexPath, JSON.stringify({
    version: 2,
    entries: [{
      filePath: rolloutFile,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sessionId: "session-1",
      cwd: rootLink,
      directory: ".",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastReadAt: "2026-06-01T00:00:00.000Z",
    }],
  }));
  const realpathEntered = deferred();
  const releaseRealpath = deferred();
  let blockIdentity = true;
  const fileSystem = {
    ...fs,
    async realpath(value, ...args) {
      if (blockIdentity && path.resolve(value) === path.resolve(rootLink)) {
        blockIdentity = false;
        realpathEntered.resolve();
        await releaseRealpath.promise;
      }
      return await fs.realpath(value, ...args);
    },
  };
  const index = createLlmCliSessionIndex({
    cliSessionIndexPath: indexPath,
    cliSessionIndexRefreshMinIntervalMs: 60_000,
    cliSessionScanMaxFiles: 10,
    codeCliSessionsDir: sessionsDir,
    compareSessionHistoryEntries: () => 0,
    fileSystem,
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeReasoningEffort: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: (value) => String(value || "").trim() || ".",
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    toUnixPath: (value) => String(value || "").replaceAll("\\", "/"),
    toWorkspaceRelativeFromAbsolutePath: (value) => (
      path.resolve(String(value || "")) === path.resolve(rootLink) ? "." : ""
    ),
  });
  const rootReal = await fs.realpath(rootDir);
  const markUnread = index.markCliSessionsRead(["session-1"], {
    directory: rootReal,
    lastReadAt: new Date(0).toISOString(),
  });
  await realpathEntered.promise;
  const refresh = index.listCliSessionsForDirectory(rootReal, { forceRefresh: true });
  releaseRealpath.resolve();
  await Promise.all([markUnread, refresh]);

  const [session] = await index.listCliSessionsForDirectory(rootReal);
  assert.equal(session.lastReadAt, new Date(0).toISOString());
  const persisted = JSON.parse(await fs.readFile(indexPath, "utf8"));
  assert.equal(persisted.entries[0].lastReadAt, new Date(0).toISOString());
});

test("rollout writes remain scoped by directory when a session id is reused", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-cli-writer-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const mainRoot = path.join(tempRoot, "main");
  const worktreeRoot = path.join(tempRoot, "worktree");
  const mainFile = path.join(tempRoot, "rollout-main.jsonl");
  const worktreeFile = path.join(tempRoot, "rollout-worktree.jsonl");
  await Promise.all([
    fs.mkdir(mainRoot),
    fs.mkdir(worktreeRoot),
    fs.writeFile(mainFile, ""),
    fs.writeFile(worktreeFile, ""),
  ]);

  const writer = createLlmCliRolloutWriter({
    buildTokenCountPayloadFromContextUsage: () => null,
    cliSessionMetaOriginator: "test",
    cliSessionMetaSource: "test",
    cliSessionMetaVersion: "test",
    codeCliSessionsDir: tempRoot,
    ensureCliSessionIndexLoaded: async () => {},
    findCliSessionIndexEntryBySessionId: async (_sessionId, { directory }) => ({
      filePath: directory === mainRoot ? mainFile : worktreeFile,
    }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeReasoningEffort: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: (value) => String(value || "").trim(),
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    toWorkspaceRelativeFromAbsolutePath: () => "",
    upsertCliSessionIndexEntryFromRolloutFile: async () => {},
    workspaceRoot: mainRoot,
  });

  await writer.appendAppConversationToCliRollout({
    sessionId: "shared-session",
    cwd: mainRoot,
    directory: mainRoot,
    userText: "main turn",
  });
  await writer.appendAppConversationToCliRollout({
    sessionId: "shared-session",
    cwd: worktreeRoot,
    directory: worktreeRoot,
    userText: "worktree turn",
  });

  const mainRaw = await fs.readFile(mainFile, "utf8");
  const worktreeRaw = await fs.readFile(worktreeFile, "utf8");
  assert.match(mainRaw, /main turn/);
  assert.doesNotMatch(mainRaw, /worktree turn/);
  assert.match(worktreeRaw, /worktree turn/);
  assert.doesNotMatch(worktreeRaw, /main turn/);
});

test("new rollouts cannot collide across directories in the same second", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-cli-new-rollout-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const createdFiles = [];
  const writer = createLlmCliRolloutWriter({
    buildTokenCountPayloadFromContextUsage: () => null,
    cliSessionMetaOriginator: "test",
    cliSessionMetaSource: "test",
    cliSessionMetaVersion: "test",
    codeCliSessionsDir: tempRoot,
    ensureCliSessionIndexLoaded: async () => {},
    findCliSessionIndexEntryBySessionId: async () => null,
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeReasoningEffort: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: (value) => String(value || "").trim(),
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    toWorkspaceRelativeFromAbsolutePath: () => "",
    upsertCliSessionIndexEntryFromRolloutFile: async (filePath) => createdFiles.push(filePath),
    workspaceRoot: tempRoot,
  });

  for (const directory of [path.join(tempRoot, "main"), path.join(tempRoot, "worktree")]) {
    await writer.appendAppConversationToCliRollout({
      sessionId: "shared-session",
      cwd: directory,
      directory,
      userText: directory,
    });
  }

  assert.equal(createdFiles.length, 2);
  assert.notEqual(createdFiles[0], createdFiles[1]);
});
