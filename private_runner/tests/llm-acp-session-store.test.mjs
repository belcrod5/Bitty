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
