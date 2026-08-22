import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeBackend, isClaudeVersionSupported } from "../src/claude-backend.mjs";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function fakeChild(lines, { code = 0, exitOnSignal = true, exitAfterInput = true, stderr = "" } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    if (exitOnSignal) queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  child.stdin.on("finish", () => {
    if (!exitAfterInput) return;
    queueMicrotask(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
      child.stdout.end();
      if (stderr) child.stderr.write(stderr);
      child.stderr.end();
      child.emit("exit", code, null);
    });
  });
  return child;
}

function backendWith(lines, options = {}) {
  const calls = [];
  const child = fakeChild(lines, options);
  const backend = createClaudeBackend({
    binary: "/test/claude",
    runFile: async (file, args) => ({
      stdout: file === "ps"
        ? `${options.startedAt || ""}\n`
        : args[0] === "--version" ? "2.1.214 (Claude Code)" : "",
    }),
    fileSystem: {
      ...fs,
      realpath: async (value) => value,
    },
    spawnProcess(binary, args, spawnOptions) {
      calls.push({ binary, args, options: spawnOptions });
      return child;
    },
    sessionStore: { getBinding: async () => null },
    interruptGraceMs: 10,
    generateSessionId: () => SESSION_ID,
  });
  return { backend, child, calls };
}

test("Claude version gate is numeric and fail closed", () => {
  assert.equal(isClaudeVersionSupported("2.1.214 (Claude Code)"), true);
  assert.equal(isClaudeVersionSupported("2.1.213"), false);
  assert.equal(isClaudeVersionSupported("invalid"), false);
});

test("Claude Backend defers CLI detection until a turn is sent", async () => {
  let runFileCalls = 0;
  const backend = createClaudeBackend({
    runFile: async () => {
      runFileCalls += 1;
      throw new Error("missing");
    },
    sessionStore: { getBinding: async () => null },
  });
  const status = await backend.getStatus();
  assert.equal(status.readiness.ready, true);
  assert.equal(status.capabilities.model.select, true);
  assert.equal(status.capabilities.model.effort, true);
  assert.deepEqual(status.capabilities.model.effortOptions, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(status.capabilities.model.changeWithinSession, false);
  assert.deepEqual(status.capabilities.model.catalog.map((model) => model.modelId), ["haiku", "sonnet", "opus", "fable"]);
  assert.equal(runFileCalls, 0);
  await assert.rejects(backend.startTurn({
    runId: "run-missing",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: () => {},
  }), (error) => error.code === "backend_unavailable" && /not installed/i.test(error.message));
  assert.equal(runFileCalls, 1);
});

test("Claude Backend reports an unsupported CLI version when a turn is sent", async () => {
  const backend = createClaudeBackend({
    binary: "/test/claude",
    runFile: async () => ({ stdout: "2.1.213 (Claude Code)" }),
    fileSystem: { ...fs, realpath: async (value) => value },
    sessionStore: { getBinding: async () => null },
  });
  await assert.rejects(backend.startTurn({
    runId: "run-old-version",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: () => {},
  }), (error) => error.code === "backend_version_unsupported" && /2\.1\.214 or newer/.test(error.message));
});

test("Claude Backend reports a login error from the CLI response", async () => {
  const { backend } = backendWith([], { code: 1, stderr: "Authentication required: not logged in" });
  await assert.rejects(backend.startTurn({
    runId: "run-logged-out",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: () => {},
  }), (error) => error.code === "turn_failed" && /not logged in/i.test(error.message));
});

test("Claude Backend reports login errors carried by an error result", async () => {
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "result", subtype: "error_during_execution", is_error: true, result: "OAuth authentication required", session_id: SESSION_ID },
  ]);
  await assert.rejects(backend.startTurn({
    runId: "run-auth-result",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: () => {},
  }), (error) => error.code === "turn_failed" && /not logged in/i.test(error.message));
});

test("Claude Backend retries CLI detection after a missing binary", async () => {
  let whichCalls = 0;
  const child = fakeChild([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "result", subtype: "success", result: "ok", session_id: SESSION_ID },
  ]);
  const backend = createClaudeBackend({
    binary: "claude",
    runFile: async (file, args) => {
      if (file === "which") {
        whichCalls += 1;
        if (whichCalls === 1) throw new Error("missing");
        return { stdout: "/test/claude\n" };
      }
      if (file === "ps") return { stdout: "Thu Aug 21 12:34:56 2026\n" };
      if (args[0] === "--version") return { stdout: "2.1.214 (Claude Code)" };
      return { stdout: "" };
    },
    fileSystem: { ...fs, realpath: async (value) => value },
    spawnProcess: () => child,
    sessionStore: { getBinding: async () => null },
    generateSessionId: () => SESSION_ID,
  });
  const request = {
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: () => {},
  };
  await assert.rejects(backend.startTurn({ ...request, runId: "run-retry-1" }), /not installed/i);
  assert.deepEqual(await backend.startTurn({ ...request, runId: "run-retry-2" }), { outcome: "completed", nativeTerminal: true });
  assert.equal(whichCalls, 2);
});

test("Claude Backend uses one-shot stream-json, resolves native session, and normalizes deltas", async () => {
  const startedAt = "Thu Aug 21 12:34:56 2026";
  const { backend, calls } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-test" },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } },
    { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
    { type: "result", subtype: "success", result: "hello", session_id: SESSION_ID, usage: { input_tokens: 2, output_tokens: 1 } },
  ], { startedAt });
  const events = [];
  const sessions = [];
  const processIdentities = [];
  const result = await backend.startTurn({
    runId: "run-1",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "say hello" }] },
    model: "haiku",
    policyProfileId: "claude-dont-ask",
    resolveSession: async (ref) => sessions.push(ref),
    setNativeProcessIdentity: async (identity) => processIdentities.push(identity),
    emit: (type, payload) => events.push({ type, payload }),
  });

  assert.equal(result.outcome, "completed");
  assert.deepEqual(sessions, [{ backendId: "claude", nativeSessionId: SESSION_ID }]);
  assert.deepEqual(processIdentities, [JSON.stringify({ pid: 12345, startedAt })]);
  assert.equal(calls[0].binary, "/test/claude");
  assert.deepEqual(calls[0].args.slice(0, 7), [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--safe-mode", "--session-id",
  ]);
  assert.equal(calls[0].args.includes("say hello"), false);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf("--model"), calls[0].args.indexOf("--model") + 2), [
    "--model", "haiku",
  ]);
  assert.deepEqual(events.map((entry) => entry.type), [
    "turn.started", "item.started", "content.delta", "content.delta", "item.completed", "usage.updated",
  ]);
});

test("Claude Backend enriches usage with total tokens and the model context window", async () => {
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    {
      type: "result",
      subtype: "success",
      result: "done",
      session_id: SESSION_ID,
      usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 8, output_tokens: 10 },
      modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 2, contextWindow: 200000 } },
    },
  ]);
  const events = [];
  await backend.startTurn({
    runId: "run-usage",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
  });

  const usage = events.find((event) => event.type === "usage.updated")?.payload.usage;
  // cache read/creationを含む消費合計とcontext windowが載り、クライアントが%を計算できる
  assert.equal(usage.total_tokens, 120);
  assert.equal(usage.context_window, 200000);
  assert.equal(usage.input_tokens, 2);
});

test("Claude Backend passes a supported effort to the CLI exactly once", async () => {
  const { backend, calls } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "result", subtype: "success", result: "ok", session_id: SESSION_ID },
  ]);
  await backend.startTurn({
    runId: "run-effort",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    model: "sonnet",
    effort: "xhigh",
    resolveSession: async () => {},
    emit: () => {},
  });
  const effortIndexes = calls[0].args
    .map((arg, index) => (arg === "--effort" ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(effortIndexes.length, 1);
  assert.equal(calls[0].args[effortIndexes[0] + 1], "xhigh");
});

test("Claude Backend passes effort on resume and rejects an unsupported effort before spawn", async () => {
  const { backend, calls } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "result", subtype: "success", result: "ok", session_id: SESSION_ID },
  ]);
  await backend.startTurn({
    runId: "run-effort-resume",
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "continue" }] },
    effort: "low",
    resolveSession: async () => assert.fail("existing sessions are resolved by AgentService"),
    emit: () => {},
  });
  assert.equal(calls[0].args.includes("--resume"), true);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf("--effort"), calls[0].args.indexOf("--effort") + 2), [
    "--effort", "low",
  ]);

  const rejected = backendWith([]);
  await assert.rejects(rejected.backend.startTurn({
    runId: "run-effort-invalid",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    effort: "ultra",
    resolveSession: async () => {},
    emit: () => {},
  }), (error) => error.code === "turn_rejected" && /effort must be one of/i.test(error.message));
  assert.equal(rejected.calls.length, 0);
});

test("Claude Backend resumes without combining --session-id and rejects a missing result", async () => {
  const { backend, calls } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
  ]);
  await assert.rejects(backend.startTurn({
    runId: "run-2",
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "continue" }] },
    resolveSession: async () => assert.fail("existing sessions are resolved by AgentService"),
    emit: () => {},
  }), (error) => error.code === "protocol_error" && error.nativeActivity === "stopped");
  assert.equal(calls[0].args.includes("--resume"), true);
  assert.equal(calls[0].args.includes("--session-id"), false);
  assert.equal(calls[0].args.includes("--model"), false);
});

test("Claude Backend interrupts a one-shot process and reports the turn as interrupted", async () => {
  const { backend, child } = backendWith([], {
    startedAt: "Thu Aug 21 12:34:56 2026",
    exitOnSignal: true,
    exitAfterInput: false,
  });
  const turn = backend.startTurn({
    runId: "run-interrupt",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "wait" }] },
    resolveSession: async () => {},
    setNativeProcessIdentity: async () => {},
    emit: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  await backend.interrupt({ runId: "run-interrupt" });

  assert.deepEqual(await turn, { outcome: "interrupted", nativeTerminal: true });
  assert.deepEqual(child.signals, ["SIGINT"]);
});

test("Claude Backend keeps assistant items valid across a tool round trip", async () => {
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "assistant", uuid: "assistant-tool", message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "contents" }] } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } } },
    { type: "assistant", uuid: "assistant-final", message: { content: [{ type: "text", text: "done" }] } },
    { type: "result", subtype: "success", result: "done", session_id: SESSION_ID },
  ]);
  const events = [];
  await backend.startTurn({
    runId: "run-tools",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "read it" }] },
    resolveSession: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
  });

  const itemStarts = events.filter((event) => event.type === "item.started");
  const itemCompletions = events.filter((event) => event.type === "item.completed");
  assert.equal(itemStarts.length, 2);
  assert.equal(itemCompletions.length, 2);
  assert.notEqual(itemStarts[0].payload.itemId, itemStarts[1].payload.itemId);
  assert.deepEqual(events.filter((event) => event.type.startsWith("tool.")).map((event) => event.type), [
    "tool.started", "tool.completed",
  ]);
});

test("Claude Backend skips thinking-only assistant snapshots", async () => {
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "assistant", uuid: "assistant-thinking", message: { content: [{ type: "thinking", thinking: "work" }] } },
    { type: "assistant", uuid: "assistant-final", message: { content: [{ type: "text", text: "done" }] } },
    { type: "result", subtype: "success", result: "done", session_id: SESSION_ID },
  ]);
  const events = [];
  await backend.startTurn({
    runId: "run-thinking",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "think" }] },
    resolveSession: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
  });
  assert.equal(events.filter((event) => event.type === "item.started").length, 1);
  assert.equal(events.find((event) => event.type === "item.completed")?.payload.content?.[0]?.text, "done");
});

test("Claude history stays inside projects root and invalidates changed cursors", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-claude-history-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const project = path.join(tempRoot, "project");
  const cwd = path.join(tempRoot, "workspace");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(cwd);
  const transcript = path.join(project, `${SESSION_ID}.jsonl`);
  await fs.writeFile(transcript, [
    JSON.stringify({ type: "user", uuid: "u1", cwd, timestamp: "2026-08-21T00:00:00.000Z", message: { content: "hello" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", cwd, timestamp: "2026-08-21T00:00:01.000Z", message: { content: [{ type: "text", text: "world" }] } }),
  ].join("\n"));
  const backend = createClaudeBackend({
    binary: "/test/claude",
    projectsRoot: tempRoot,
    runFile: async () => ({ stdout: "2.1.214" }),
    fileSystem: fs,
    sessionStore: { getBinding: async () => null },
  });
  const listed = await backend.listSessions({ cwd, limit: 10 });
  assert.equal(listed.sessions[0].sessionRef.nativeSessionId, SESSION_ID);
  const first = await backend.readHistory({
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
    limit: 1,
  });
  assert.equal(first.items[0].role, "assistant");
  assert.ok(first.olderCursor);
  await fs.appendFile(transcript, "\n");
  await assert.rejects(backend.readHistory({
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
    cursor: first.olderCursor,
    limit: 1,
  }), (error) => error.code === "history_cursor_invalid");
});

test("Claude no-output watchdog pauses while a tool is running", async () => {
  const child = fakeChild([], { exitAfterInput: false });
  const backend = createClaudeBackend({
    binary: "/test/claude",
    runFile: async (file, args) => ({ stdout: file === "ps" ? "started\n" : args?.[0] === "--version" ? "2.1.214" : "" }),
    fileSystem: { ...fs, realpath: async (value) => value },
    spawnProcess: () => child,
    sessionStore: { getBinding: async () => null },
    noOutputTimeoutMs: 100,
    interruptGraceMs: 10,
    generateSessionId: () => SESSION_ID,
  });
  const writeLine = (line) => child.stdout.write(`${JSON.stringify(line)}\n`);
  const turn = backend.startTurn({
    runId: "run-slow-tool",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "build it" }] },
    resolveSession: async () => {},
    emit: () => {},
  });
  writeLine({ type: "system", subtype: "init", session_id: SESSION_ID });
  writeLine({ type: "assistant", uuid: "a-tool", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }] } });
  // tool実行中の無出力(noOutputTimeoutMsの2倍以上)ではタイムアウトしない
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } });
  writeLine({ type: "assistant", uuid: "a-final", message: { content: [{ type: "text", text: "done" }] } });
  writeLine({ type: "result", subtype: "success", result: "done", session_id: SESSION_ID });
  child.stdout.end();
  child.emit("exit", 0, null);
  const result = await turn;
  assert.equal(result.outcome, "completed");
});

test("Claude transcript metadata is cached until the file changes", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-claude-meta-cache-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const project = path.join(tempRoot, "project");
  const cwd = path.join(tempRoot, "workspace");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(cwd);
  const transcript = path.join(project, `${SESSION_ID}.jsonl`);
  await fs.writeFile(transcript, [
    JSON.stringify({ type: "user", uuid: "u1", cwd, timestamp: "2026-08-21T00:00:00.000Z", message: { content: "hello" } }),
  ].join("\n"));
  let readFileCalls = 0;
  const backend = createClaudeBackend({
    binary: "/test/claude",
    projectsRoot: tempRoot,
    runFile: async () => ({ stdout: "2.1.214" }),
    fileSystem: {
      ...fs,
      readFile: async (...args) => {
        readFileCalls += 1;
        return await fs.readFile(...args);
      },
    },
    sessionStore: { getBinding: async () => null },
  });

  const first = await backend.listSessions({ cwd, limit: 10 });
  assert.equal(first.sessions[0].title, "hello");
  assert.equal(first.sessions[0].sourceKind, "cli");
  const readsAfterFirst = readFileCalls;
  assert.ok(readsAfterFirst >= 1);

  // 変更がなければ全文読み込みは再発しない
  const second = await backend.listSessions({ cwd, limit: 10 });
  assert.equal(second.sessions[0].title, "hello");
  assert.equal(readFileCalls, readsAfterFirst);

  // resume時のモデル整合チェックもキャッシュで賄われる
  await backend.resolveSessionCwd({ backendId: "claude", nativeSessionId: SESSION_ID });
  assert.equal(readFileCalls, readsAfterFirst);

  // ファイル更新(size/mtime変化)で読み直す
  await fs.appendFile(transcript, `\n${JSON.stringify({ type: "assistant", uuid: "a1", cwd, message: { content: [{ type: "text", text: "world" }] } })}`);
  await backend.listSessions({ cwd, limit: 10 });
  assert.ok(readFileCalls > readsAfterFirst);
});

test("Claude session cwd prefers the transcript over a stale binding and matches symlinked workspaces", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-claude-cwd-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const project = path.join(tempRoot, "project");
  const realCwd = path.join(tempRoot, "workspace");
  const linkCwd = path.join(tempRoot, "workspace-link");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(realCwd);
  await fs.symlink(realCwd, linkCwd);
  const transcript = path.join(project, `${SESSION_ID}.jsonl`);
  // transcriptはsymlink経由のcwdを記録している
  await fs.writeFile(transcript, JSON.stringify({ type: "user", uuid: "u1", cwd: linkCwd, message: { content: "hello" } }));
  const backend = createClaudeBackend({
    binary: "/test/claude",
    projectsRoot: tempRoot,
    runFile: async () => ({ stdout: "2.1.214" }),
    fileSystem: fs,
    sessionStore: { getBinding: async () => ({ canonicalCwd: "/stale/binding" }) },
  });

  const expectedRealCwd = await fs.realpath(realCwd);
  // nativeデータ源(transcript)のcwdが真実。staleなbindingを返さない。
  assert.equal(await backend.resolveSessionCwd({ backendId: "claude", nativeSessionId: SESSION_ID }), expectedRealCwd);
  // realCwd指定でもsymlink経由のtranscriptが一致する
  const listed = await backend.listSessions({ cwd: realCwd, limit: 10 });
  assert.equal(listed.sessions[0]?.sessionRef.nativeSessionId, SESSION_ID);
});

test("Claude history classifies injected system messages as internal context", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-claude-internal-context-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const project = path.join(tempRoot, "project");
  const cwd = path.join(tempRoot, "workspace");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(cwd);
  const transcript = path.join(project, `${SESSION_ID}.jsonl`);
  await fs.writeFile(transcript, [
    JSON.stringify({ type: "user", uuid: "meta-1", cwd, isMeta: true, message: { content: "Caveat: injected caveat body" } }),
    JSON.stringify({ type: "user", uuid: "cmd-1", cwd, message: { content: "<command-name>/clear</command-name>" } }),
    JSON.stringify({ type: "user", uuid: "task-1", cwd, message: { content: "<task-notification>\n<task-id>abc</task-id>\n</task-notification>" } }),
    JSON.stringify({ type: "user", uuid: "user-1", cwd, message: { content: "<foo>user supplied</foo>" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", cwd, message: { content: [{ type: "text", text: "reply" }] } }),
  ].join("\n"));
  const backend = createClaudeBackend({
    binary: "/test/claude",
    projectsRoot: tempRoot,
    runFile: async () => ({ stdout: "2.1.214" }),
    fileSystem: fs,
    sessionStore: { getBinding: async () => null },
  });

  const history = await backend.readHistory({
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
    limit: 10,
  });
  assert.deepEqual(history.items.map((item) => ({ id: item.id, itemType: item.itemType })), [
    { id: "meta-1", itemType: "internal_context" },
    { id: "cmd-1", itemType: "internal_context" },
    { id: "task-1", itemType: "internal_context" },
    { id: "user-1", itemType: undefined },
    { id: "a1", itemType: undefined },
  ]);

  // 一覧タイトルも注入メッセージではなく最初の実ユーザー発話から取る。
  const listed = await backend.listSessions({ cwd, limit: 10 });
  assert.equal(listed.sessions[0].title, "<foo>user supplied</foo>");
});

test("Claude session list pages with a keyset cursor and rejects an invalid cursor", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-claude-list-page-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const project = path.join(tempRoot, "project");
  const cwd = path.join(tempRoot, "workspace");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(cwd);
  const sessionIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  for (const [index, sessionId] of sessionIds.entries()) {
    const file = path.join(project, `${sessionId}.jsonl`);
    await fs.writeFile(file, JSON.stringify({
      type: "user", uuid: `u-${index}`, cwd, message: { content: `hello ${index}` },
    }));
    // mtimeが一覧の並び順キー: session 3 が最新、session 1 が最古
    const mtime = new Date(Date.UTC(2026, 7, 20, index));
    await fs.utimes(file, mtime, mtime);
  }
  const backend = createClaudeBackend({
    binary: "/test/claude",
    projectsRoot: tempRoot,
    runFile: async () => ({ stdout: "2.1.214" }),
    fileSystem: fs,
    sessionStore: { getBinding: async () => null },
  });

  const page1 = await backend.listSessions({ cwd, limit: 2 });
  assert.deepEqual(
    page1.sessions.map((session) => session.sessionRef.nativeSessionId),
    [sessionIds[2], sessionIds[1]],
  );
  assert.ok(page1.cursor);

  const page2 = await backend.listSessions({ cwd, limit: 2, cursor: page1.cursor });
  assert.deepEqual(
    page2.sessions.map((session) => session.sessionRef.nativeSessionId),
    [sessionIds[0]],
  );
  assert.equal("cursor" in page2, false);

  await assert.rejects(
    backend.listSessions({ cwd, limit: 2, cursor: "not-a-cursor" }),
    (error) => error.code === "turn_rejected",
  );
});
