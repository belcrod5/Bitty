import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLlmCliSessionIndex } from "../src/llm-cli-session-index.mjs";
import { createLlmCliRolloutWriter } from "../src/llm-cli-rollout-writer.mjs";

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
    toWorkspaceRelativeFromAbsolutePath: (value) => (
      path.resolve(String(value || "")) === worktreeRoot ? "." : ""
    ),
  });

  const worktreeReal = await fs.realpath(worktreeRoot);
  const sessions = await index.listCliSessionsForDirectory(worktreeReal);
  assert.deepEqual(sessions.map((session) => session.sessionId), ["shared-session"]);
  assert.equal(sessions[0].directory, worktreeReal);

  await index.markCliSessionRead("shared-session", {
    directory: worktreeReal,
    lastReadAt: "2026-02-01T00:00:00.000Z",
  });
  const mainMeta = JSON.parse((await fs.readFile(mainFile, "utf8")).trim()).payload;
  const worktreeMeta = JSON.parse((await fs.readFile(worktreeFile, "utf8")).trim()).payload;
  assert.equal(mainMeta.last_read_at, undefined);
  assert.equal(worktreeMeta.last_read_at, "2026-02-01T00:00:00.000Z");
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
