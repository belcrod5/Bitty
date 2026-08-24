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
  assert.equal(migrated.version, 5);
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

test("persists agent operation idempotency even when legacy ACP binding is disabled", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-agent-operations-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const storePath = path.join(tempRoot, "agent_metadata.json");
  await fs.writeFile(storePath, JSON.stringify({
    version: 3,
    sessions: {
      legacy: {
        directory: tempRoot,
        rootRelativePath: tempRoot,
        updatedAt: "2026-08-21T00:00:00.000Z",
        lastReadAt: "",
      },
    },
    latestByDirectory: { [tempRoot]: "legacy" },
  }));
  const createStore = () => createLlmAcpSessionStore({
    acpSessionStorePath: storePath,
    compareSessionHistoryEntries: () => 0,
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: false,
    workspaceRoot: tempRoot,
  });
  const store = createStore();
  assert.deepEqual(await store.listAcpSessionsForDirectory(tempRoot), []);

  assert.deepEqual(
    await store.claimAgentOperation("user-1", "operation-1", "hash-1", "run-1"),
    { status: "claimed", runId: "run-1" },
  );
  assert.deepEqual(
    await store.inspectAgentOperation("user-1", "operation-1", "hash-1"),
    { status: "existing", runId: "run-1", result: undefined },
  );
  assert.deepEqual(
    await store.inspectAgentOperation("user-1", "operation-1", "different"),
    { status: "conflict" },
  );
  assert.deepEqual(
    await store.claimAgentOperation("user-1", "operation-1", "hash-1", "run-2"),
    { status: "existing", runId: "run-1", result: undefined },
  );
  assert.deepEqual(
    await store.claimAgentOperation("user-1", "operation-1", "different", "run-2"),
    { status: "conflict" },
  );
  await store.completeAgentOperation("user-1", "operation-1", { runId: "run-1", outcome: "completed" });

  const restarted = createStore();
  assert.deepEqual(
    await restarted.claimAgentOperation("user-1", "operation-1", "hash-1", "run-3"),
    {
      status: "existing",
      runId: "run-1",
      result: { runId: "run-1", outcome: "completed" },
    },
  );
  const persisted = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.equal(persisted.agentOperations.length, 1);
  assert.equal(persisted.sessions.legacy.directory, await fs.realpath(tempRoot));
  assert.equal(Object.hasOwn(persisted.agentOperations[0], "input"), false);
});

test("keeps disabled legacy ACP reads isolated from corrupt agent metadata", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-agent-disabled-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const storePath = path.join(tempRoot, "agent_metadata.json");
  await fs.writeFile(storePath, "{broken");
  const store = createLlmAcpSessionStore({
    acpSessionStorePath: storePath,
    compareSessionHistoryEntries: () => 0,
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: false,
    workspaceRoot: tempRoot,
  });

  assert.deepEqual(await store.listAcpSessionsForDirectory(tempRoot), []);
  await assert.rejects(
    store.claimAgentOperation("user-1", "operation-1", "hash-1", "run-1"),
    SyntaxError,
  );
});

test("does not restart an operation whose native outcome was pending at process restart", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-agent-pending-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const storePath = path.join(tempRoot, "agent_metadata.json");
  const options = {
    acpSessionStorePath: storePath,
    compareSessionHistoryEntries: () => 0,
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: false,
    workspaceRoot: tempRoot,
  };
  const first = createLlmAcpSessionStore(options);
  await first.claimAgentOperation("user-1", "operation-1", "hash-1", "run-1");

  const restarted = createLlmAcpSessionStore(options);
  assert.deepEqual(
    await restarted.claimAgentOperation("user-1", "operation-1", "hash-1", "run-2"),
    { status: "unknown", runId: "run-1" },
  );
});

test("persists learned agent model info across restarts", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-agent-model-info-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const storePath = path.join(tempRoot, "agent_metadata.json");
  const options = {
    acpSessionStorePath: storePath,
    compareSessionHistoryEntries: () => 0,
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: false,
    workspaceRoot: tempRoot,
  };
  const store = createLlmAcpSessionStore(options);
  assert.equal(await store.getAgentModelInfo("claude", "fable"), null);
  await store.setAgentModelInfo("claude", "fable", { contextWindowTokens: 500000 });
  // 不正値は保存しない
  assert.equal(await store.setAgentModelInfo("claude", "fable", { contextWindowTokens: 0 }), null);

  const restarted = createLlmAcpSessionStore(options);
  const info = await restarted.getAgentModelInfo("claude", "fable");
  assert.equal(info.contextWindowTokens, 500000);
  assert.equal(await restarted.getAgentModelInfo("claude", "sonnet"), null);
});

test("reclaims a crash-orphaned pending operation after its TTL", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-agent-orphan-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const storePath = path.join(tempRoot, "agent_metadata.json");
  // 別プロセスがclaimしたままクラッシュしたpending(TTL超過)を仕込む
  await fs.writeFile(storePath, JSON.stringify({
    version: 3,
    sessions: {},
    latestByDirectory: {},
    agentOperations: [{
      subjectId: "user-1",
      clientOperationId: "operation-1",
      requestHash: "hash-1",
      runId: "run-dead",
      status: "pending",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }],
  }));
  const store = createLlmAcpSessionStore({
    acpSessionStorePath: storePath,
    compareSessionHistoryEntries: () => 0,
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: false,
    workspaceRoot: tempRoot,
  });

  // TTL超過の孤児pendingは回収され、同じclientOperationIdを新規claimできる
  // (回収しないと恒久的にstatus:"unknown"で毒化し、蓄積すると容量到達で全claimが失敗する)
  assert.deepEqual(
    await store.claimAgentOperation("user-1", "operation-1", "hash-1", "run-2"),
    { status: "claimed", runId: "run-2" },
  );
});

test("persists one session mode and generation-checked lease across restarts", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-agent-lease-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const storePath = path.join(tempRoot, "agent_metadata.json");
  const options = (agentProcessEpoch) => ({
    acpSessionStorePath: storePath,
    agentProcessEpoch,
    compareSessionHistoryEntries: () => 0,
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: false,
    workspaceRoot: tempRoot,
  });
  const ref = { backendId: "codex", nativeSessionId: "thread-1" };
  const first = createLlmAcpSessionStore(options("epoch-1"));
  assert.equal((await first.bindAgentSession(ref, tempRoot, "neutral")).status, "bound");
  const acquired = await first.acquireAgentSessionLease({
    sessionRef: ref,
    mode: "neutral",
    owner: "agent-service",
    runId: "run-1",
  });
  assert.equal(acquired.status, "acquired");
  // 同一モードへのhandoffはno-op: lease保持中(compact/turn実行中)でも成功する
  assert.equal((await first.handoffAgentSessionMode(ref, "neutral")).status, "unchanged");
  // モード反転はlease保持中は従来どおりbusy
  assert.equal((await first.handoffAgentSessionMode(ref, "raw")).status, "busy");
  assert.equal((await first.updateAgentSessionLeaseIdentity(
    ref,
    acquired.lease.generation,
    JSON.stringify({ pid: 42, startedAt: "now" }),
  )).status, "updated");
  assert.equal((await first.acquireAgentSessionLease({
    sessionRef: ref,
    mode: "raw",
    owner: "raw",
    runId: "run-2",
  })).status, "mode_conflict");

  const restarted = createLlmAcpSessionStore(options("epoch-2"));
  const recovering = await restarted.getAgentSessionMode(ref);
  assert.equal(recovering.lease.state, "recovering");
  assert.equal(recovering.lease.nativeProcessIdentity, JSON.stringify({ pid: 42, startedAt: "now" }));
  assert.equal((await restarted.acquireAgentSessionLease({
    sessionRef: ref,
    mode: "neutral",
    owner: "agent-service",
    runId: "run-2",
  })).status, "recovering");
  assert.equal((await restarted.settleAgentSessionLease(ref, acquired.lease.generation + 1, "released")).status, "stale");
  assert.equal((await restarted.settleAgentSessionLease(ref, acquired.lease.generation, "released")).status, "released");
  await restarted.setAgentSessionSettings(ref, { modelId: "gpt-5.6-sol", reasoningEffort: "high" });
  assert.equal((await restarted.handoffAgentSessionMode(ref, "raw", { clearSettings: true })).status, "changed");
  assert.equal((await restarted.getAgentSessionBinding(ref)).modelId, undefined);
  assert.equal((await restarted.getAgentSessionBinding(ref)).reasoningEffort, undefined);
});

test("repairs only an idle same-mode binding from an authoritative native cwd", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-agent-cwd-reconcile-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const storePath = path.join(tempRoot, "agent_metadata.json");
  const options = (agentProcessEpoch) => ({
    acpSessionStorePath: storePath,
    agentProcessEpoch,
    compareSessionHistoryEntries: () => 0,
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: false,
    workspaceRoot: tempRoot,
  });
  const store = createLlmAcpSessionStore(options("epoch-1"));
  const rawRef = { backendId: "codex", nativeSessionId: "raw-thread" };
  const activeRawRef = { backendId: "codex", nativeSessionId: "active-raw-thread" };
  const neutralRef = { backendId: "codex", nativeSessionId: "neutral-thread" };
  const oldCwd = path.join(tempRoot, "old");
  const nativeCwd = path.join(tempRoot, "native");
  await store.bindAgentSession(rawRef, oldCwd, "raw");
  await store.bindAgentSession(activeRawRef, oldCwd, "raw");
  await store.bindAgentSession(neutralRef, oldCwd, "neutral");
  await store.acquireAgentSessionLease({
    sessionRef: activeRawRef,
    mode: "raw",
    owner: "codex-relay",
    runId: "active-run",
  });

  assert.equal((await store.bindAgentSession(rawRef, nativeCwd, "raw")).status, "cwd_conflict");
  // mode遷移を伴うreconcileは拒否(neutralセッションへrawで要求)。
  assert.equal((await store.bindAgentSession(
    neutralRef, nativeCwd, "raw", { reconcileCwd: true },
  )).status, "cwd_conflict");
  // idleならmode据え置きでneutralもnative cwdへ収束できる。
  assert.equal((await store.bindAgentSession(
    neutralRef, nativeCwd, "neutral", { reconcileCwd: true },
  )).status, "bound");
  assert.equal((await store.getAgentSessionBinding(neutralRef)).canonicalCwd, nativeCwd);
  assert.equal((await store.getAgentSessionMode(neutralRef)).mode, "neutral");
  assert.equal((await store.bindAgentSession(
    activeRawRef, nativeCwd, "raw", { reconcileCwd: true },
  )).status, "cwd_conflict");
  const restarted = createLlmAcpSessionStore(options("epoch-2"));
  assert.equal((await restarted.getAgentSessionMode(activeRawRef)).lease.state, "recovering");
  assert.equal((await restarted.bindAgentSession(
    activeRawRef, nativeCwd, "raw", { reconcileCwd: true },
  )).status, "cwd_conflict");
  assert.equal((await store.bindAgentSession(
    rawRef, nativeCwd, "raw", { reconcileCwd: true },
  )).status, "bound");
  assert.equal((await store.getAgentSessionBinding(rawRef)).canonicalCwd, nativeCwd);
});

test("stores workspace approvals without conversation or credential data", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-agent-workspace-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const storePath = path.join(tempRoot, "agent_metadata.json");
  const store = createLlmAcpSessionStore({
    acpSessionStorePath: storePath,
    compareSessionHistoryEntries: () => 0,
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: false,
    workspaceRoot: tempRoot,
  });
  await store.approveAgentWorkspace("user-1", tempRoot, "1:2");
  assert.equal((await store.listAgentWorkspaces("user-1"))[0].identity, "1:2");
  await store.revokeAgentWorkspace("user-1", tempRoot);
  assert.equal((await store.listAgentWorkspaces("user-1")).length, 0);
  const persisted = await fs.readFile(storePath, "utf8");
  assert.equal(persisted.includes("conversation"), false);
  assert.equal(persisted.includes("credential"), false);
});

test("persists provider-aware Agent activity and read state", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-agent-unread-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const storePath = path.join(tempRoot, "acp_sessions.json");
  const createStore = () => createLlmAcpSessionStore({
    acpSessionStorePath: storePath,
    compareSessionHistoryEntries: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: true,
    workspaceRoot: tempRoot,
  });
  const requestedCwd = path.join(tempRoot, "project");
  await fs.mkdir(requestedCwd);
  const cwd = await fs.realpath(requestedCwd);
  const codex = { backendId: "codex", nativeSessionId: "shared" };
  const claude = { backendId: "claude", nativeSessionId: "shared" };
  const store = createStore();
  await store.bindAgentSession(codex, cwd, "neutral");
  await store.bindAgentSession(claude, cwd, "neutral");
  await store.setAgentSessionSettings(codex, {
    modelId: "gpt-5.6-sol",
    reasoningEffort: "medium",
  });
  await store.setAgentSessionSettings(claude, {
    modelId: "sonnet",
    reasoningEffort: "high",
  });
  await store.agentSessionActivityStore.recordActivity(codex, cwd, "2099-08-24T01:00:00.000Z");
  await store.agentSessionActivityStore.recordActivity(claude, cwd, "2099-08-24T02:00:00.000Z");
  await store.agentSessionActivityStore.markSessionsRead(["shared"], {
    lastReadAt: "2100-08-24T03:00:00.000Z",
  });

  const [group] = await createStore().agentSessionActivityStore.listForDirectories([cwd]);
  const sessions = new Map(group.sessions.map((session) => [session.backendId, session]));
  assert.equal(sessions.get("codex").updatedAt, "2099-08-24T01:00:00.000Z");
  assert.equal(sessions.get("codex").lastReadAt, "2100-08-24T03:00:00.000Z");
  assert.equal(sessions.get("claude").updatedAt, "2099-08-24T02:00:00.000Z");
  assert.notEqual(sessions.get("claude").lastReadAt, "2100-08-24T03:00:00.000Z");
  assert.equal(sessions.get("claude").modelRef, "sonnet");
  assert.equal(sessions.get("claude").reasoningEffort, "high");
  assert.equal((await createStore().getAgentSessionBinding(claude)).reasoningEffort, "high");

  const directoryResult = await store.agentSessionActivityStore.markDirectoryRead(
    cwd,
    "2101-08-24T04:00:00.000Z",
  );
  assert.equal(directoryResult.selectedSessionIds.length, 2);
  assert.equal(directoryResult.updatedSessionIds.length, 2);
  const [updatedGroup] = await store.agentSessionActivityStore.listForDirectories([cwd]);
  assert.deepEqual(
    updatedGroup.sessions.map((session) => session.lastReadAt),
    ["2101-08-24T04:00:00.000Z", "2101-08-24T04:00:00.000Z"],
  );
});

test("session settings persistence rolls back on failure and succeeds on retry", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-agent-settings-failure-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const storePath = path.join(tempRoot, "agent_metadata.json");
  let failNextRename = false;
  const options = {
    acpSessionStorePath: storePath,
    compareSessionHistoryEntries: () => 0,
    fileSystem: {
      ...fs,
      async rename(...args) {
        if (failNextRename) {
          failNextRename = false;
          throw Object.assign(new Error("settings rename failed"), { code: "EIO" });
        }
        return await fs.rename(...args);
      },
    },
    generateLlmExecutionSessionId: () => "generated",
    makeApiError: (_status, code, message) => Object.assign(new Error(message), { code }),
    normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
    normalizeSessionRootRelativePath: normalizeDirectory,
    normalizeSessionUpdatedAt: normalizeTimestamp,
    sessionRootBindingEnabled: false,
    workspaceRoot: tempRoot,
  };
  const ref = { backendId: "claude", nativeSessionId: "session-1" };
  const store = createLlmAcpSessionStore(options);
  await store.bindAgentSession(ref, tempRoot, "neutral");

  failNextRename = true;
  await assert.rejects(
    store.setAgentSessionSettings(ref, { modelId: "sonnet", reasoningEffort: "high" }),
    /settings rename failed/,
  );
  assert.equal((await store.getAgentSessionBinding(ref)).reasoningEffort, undefined);

  await store.setAgentSessionSettings(ref, { modelId: "sonnet", reasoningEffort: "high" });
  const restarted = createLlmAcpSessionStore({ ...options, fileSystem: fs });
  assert.equal((await restarted.getAgentSessionBinding(ref)).reasoningEffort, "high");
});

test("migrates Agent bindings without read state as already read", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-agent-unread-migration-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const cwd = await fs.realpath(tempRoot);
  const storePath = path.join(tempRoot, "acp_sessions.json");
  await fs.writeFile(storePath, JSON.stringify({
    version: 5,
    agentSessionBindings: [{
      backendId: "claude",
      nativeSessionId: "legacy",
      canonicalCwd: cwd,
      updatedAt: "2026-08-24T01:00:00.000Z",
    }],
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
    workspaceRoot: tempRoot,
  });

  const [group] = await store.agentSessionActivityStore.listForDirectories([cwd]);
  assert.equal(group.sessions[0].updatedAt, "2026-08-24T01:00:00.000Z");
  assert.equal(group.sessions[0].lastReadAt, "2026-08-24T01:00:00.000Z");
});
