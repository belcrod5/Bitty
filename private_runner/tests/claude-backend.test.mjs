import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeBackend, isClaudeVersionSupported } from "../src/claude-backend.mjs";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function fakeChild(lines, { code = 0, exitOnSignal = true, exitAfterInput = true } = {}) {
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
    enabled: true,
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
  assert.deepEqual(events.map((entry) => entry.type), [
    "turn.started", "item.started", "content.delta", "content.delta", "item.completed", "usage.updated",
  ]);
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
    enabled: true,
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
