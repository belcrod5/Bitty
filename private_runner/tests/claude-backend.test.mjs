import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeBackend, isClaudeVersionSupported } from "../src/claude-backend.mjs";
import { CONVERSATION_HISTORY_TOOL_INSTRUCTIONS } from "../src/agent/agent-runtime.mjs";

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
  // 実CLI(--input-format stream-json)はstdinのpromptを受信すると出力を流し始める。
  // stdinのcloseは待たずに応答・exitする(closeを待つとresult無しで終わるケース
  // =認証エラー等のテストがハングするため。成功ケースでのbackendのstdinクローズは
  // 専用テストが'finish'イベントで直接検証する)。
  child.stdin.once("data", () => {
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
    ...(options.backendOverrides || {}),
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
  assert.deepEqual(status.capabilities.action.decisions, ["allow", "allow_for_session", "deny"]);
  assert.deepEqual(status.capabilities.action.policyProfiles[0].decisions, ["allow", "allow_for_session", "deny"]);
  assert.equal("changeWithinSession" in status.capabilities.model, false);
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
    { type: "assistant", message: { content: [{ type: "text", text: "hello" }], usage: { input_tokens: 2, output_tokens: 1 } } },
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
  assert.deepEqual(calls[0].args.slice(0, 8), [
    "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages", "--session-id",
  ]);
  // --safe-modeはprofile固有の断片(末尾)へ移った(§4.2)。同値性は順序不問の
  // フラグ集合一致で確認する(--safe-modeの位置が動いても回帰ではない)。
  assert.deepEqual(new Set(calls[0].args), new Set([
    "-p", "--output-format", "stream-json", "--input-format", "--verbose", "--include-partial-messages",
    "--session-id", SESSION_ID, "--model", "haiku", "--safe-mode", "--permission-mode", "dontAsk",
  ]));
  assert.equal(calls[0].args.includes("say hello"), false);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf("--model"), calls[0].args.indexOf("--model") + 2), [
    "--model", "haiku",
  ]);
  assert.deepEqual(events.map((entry) => entry.type), [
    "turn.started", "item.started", "content.delta", "content.delta", "item.completed", "usage.updated",
  ]);
});

test("Claude Backend reports the latest main assistant context usage instead of cumulative result usage", async () => {
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    {
      type: "assistant",
      uuid: "assistant-tool",
      message: {
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }],
        usage: { input_tokens: 2, cache_read_input_tokens: 40000, cache_creation_input_tokens: 8, output_tokens: 10 },
      },
    },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "contents" }] } },
    {
      type: "assistant",
      uuid: "assistant-final",
      message: {
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 7, output_tokens: 10 },
      },
    },
    {
      type: "assistant",
      uuid: "assistant-subagent",
      parent_tool_use_id: "tool-1",
      message: {
        model: "claude-opus-4-1-20250805",
        content: [{ type: "text", text: "subagent result" }],
        usage: { input_tokens: 50000, output_tokens: 50000 },
      },
    },
    {
      type: "result",
      subtype: "success",
      result: "done",
      session_id: SESSION_ID,
      usage: { input_tokens: 50002, cache_read_input_tokens: 40100, cache_creation_input_tokens: 15, output_tokens: 50020 },
      modelUsage: {
        "claude-opus-4-1-20250805": { inputTokens: 50000, contextWindow: 500000 },
        "claude-haiku-4-5-20251001": { inputTokens: 2, contextWindow: 200000 },
      },
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
  // 最新メインassistantの3+100+7+10だけを使い、過去のtool turn、subagent、
  // resultのターン累計をcontext占有量へ混ぜない。
  assert.equal(usage.total_tokens, 120);
  assert.equal(usage.context_window, 200000);
  assert.equal(usage.input_tokens, 3);
  assert.equal(usage.cache_read_input_tokens, 100);
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

test("Claude Backend resumes with the selected model without combining --session-id", async () => {
  const { backend, calls } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
  ]);
  await assert.rejects(backend.startTurn({
    runId: "run-2",
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "continue" }] },
    model: "opus",
    resolveSession: async () => assert.fail("existing sessions are resolved by AgentService"),
    emit: () => {},
  }), (error) => error.code === "protocol_error" && error.nativeActivity === "stopped");
  assert.equal(calls[0].args.includes("--resume"), true);
  assert.equal(calls[0].args.includes("--session-id"), false);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf("--model"), calls[0].args.indexOf("--model") + 2), [
    "--model", "opus",
  ]);
});

test("Claude Backend treats a repeated system/init with the same session ID as idempotent", async () => {
  const events = [];
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    // OAuth失効中のCLIは内部再試行としてsystem/initを同一turn内で再送することがある
    // (実測: CLI 2.1.238)。session idが変わっていなければ無視して継続する。
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "result", subtype: "success", result: "done", session_id: SESSION_ID },
  ]);
  const result = await backend.startTurn({
    runId: "run-init-repeat",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
  });
  assert.deepEqual(result, { outcome: "completed", nativeTerminal: true });
  assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
  assert.equal(events.filter((event) => event.type === "provider.event" && event.payload.nativeType === "system/init_repeated").length, 1);
});

test("Claude Backend fails closed when a repeated system/init reports a different session ID", async () => {
  const otherSessionId = "22222222-2222-4222-8222-222222222222";
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "system", subtype: "init", session_id: otherSessionId },
    { type: "result", subtype: "success", result: "done", session_id: SESSION_ID },
  ]);
  await assert.rejects(backend.startTurn({
    runId: "run-init-mismatch",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: () => {},
  }), (error) => error.code === "protocol_error" && /changed the session ID/i.test(error.message));
});

test("Claude Backend reports an auth failure after a repeated system/init when the CLI then exits unsuccessfully", async () => {
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "system", subtype: "init", session_id: SESSION_ID },
  ], { code: 1, stderr: "Authentication required: not logged in" });
  await assert.rejects(backend.startTurn({
    runId: "run-init-repeat-then-auth-fail",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: () => {},
  }), (error) => error.code === "turn_failed" && /not logged in/i.test(error.message));
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

test("Claude Backend announces a tool exactly once when the complete assistant message arrives before content_block_stop", async () => {
  // interactive(claude-on-request)モードでは承認評価のタイミングにより、complete
  // assistantメッセージ(tool_use入り)がstream_eventのcontent_block_stopより先に
  // 届くことがある(実測: CLI 2.1.238)。両経路が同じtoolCallIdを取り合っても
  // tool.startedは一度しかemitされてはならない(重複はemitFromBackendの
  // startedTools検査でprotocol_errorとして落ちる)。
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "assistant", uuid: "assistant-tool", message: { content: [{ type: "tool_use", id: "tool-1", name: "Write", input: { file_path: "a.txt" } }] } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "Write" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"file_path\":\"a.txt\"}" } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "written" }] } },
    { type: "assistant", uuid: "assistant-final", message: { content: [{ type: "text", text: "done" }] } },
    { type: "result", subtype: "success", result: "done", session_id: SESSION_ID },
  ]);
  const events = [];
  const result = await backend.startTurn({
    runId: "run-tool-race-assistant-first",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "write it" }] },
    resolveSession: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
  });
  assert.equal(result.outcome, "completed");
  const toolStarted = events.filter((event) => event.type === "tool.started");
  assert.equal(toolStarted.length, 1);
  assert.equal(toolStarted[0].payload.toolCallId, "tool-1");
  assert.deepEqual(events.filter((event) => event.type.startsWith("tool.")).map((event) => event.type), [
    "tool.started", "tool.completed",
  ]);
});

test("Claude Backend announces a tool exactly once in the traditional order (content_block_stop before the complete assistant message)", async () => {
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "Write" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"file_path\":\"a.txt\"}" } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "assistant", uuid: "assistant-tool", message: { content: [{ type: "tool_use", id: "tool-1", name: "Write", input: { file_path: "a.txt" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "written" }] } },
    { type: "assistant", uuid: "assistant-final", message: { content: [{ type: "text", text: "done" }] } },
    { type: "result", subtype: "success", result: "done", session_id: SESSION_ID },
  ]);
  const events = [];
  const result = await backend.startTurn({
    runId: "run-tool-race-stream-first",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "write it" }] },
    resolveSession: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
  });
  assert.equal(result.outcome, "completed");
  const toolStarted = events.filter((event) => event.type === "tool.started");
  assert.equal(toolStarted.length, 1);
  assert.equal(toolStarted[0].payload.toolCallId, "tool-1");
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

test("Claude history cursors allow appends and reject destructive changes", async (t) => {
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
  await fs.appendFile(transcript, `\n${JSON.stringify({
    type: "assistant", uuid: "a2", cwd, timestamp: "2026-08-21T00:00:02.000Z",
    message: { content: [{ type: "text", text: "new reply" }] },
  })}`);
  const older = await backend.readHistory({
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
    cursor: first.olderCursor,
    limit: 1,
  });
  assert.deepEqual(older.items.map((item) => item.id), ["u1"]);

  await fs.writeFile(transcript, [
    JSON.stringify({ type: "user", uuid: "u1", cwd, message: { content: "changed" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", cwd, message: { content: "world" } }),
  ].join("\n"));
  await assert.rejects(backend.readHistory({
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
    cursor: first.olderCursor,
    limit: 1,
  }), (error) => error.code === "history_cursor_invalid");
});

test("Claude Backend persists learned model context windows for later restores", async () => {
  const stored = [];
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    {
      type: "result",
      subtype: "success",
      result: "done",
      session_id: SESSION_ID,
      usage: { input_tokens: 2, output_tokens: 1 },
      modelUsage: { "claude-fable-5": { contextWindow: 500000 } },
    },
  ], {
    backendOverrides: {
      modelInfoStore: { set: async (backendId, modelId, info) => stored.push({ backendId, modelId, info }) },
    },
  });
  await backend.startTurn({
    runId: "run-learn",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: () => {},
  });
  assert.deepEqual(stored, [{ backendId: "claude", modelId: "fable", info: { contextWindowTokens: 500000 } }]);
});

test("Claude compactSession runs /compact headless in the session cwd", async () => {
  const runFileCalls = [];
  const backend = createClaudeBackend({
    binary: "/test/claude",
    runFile: async (file, args, options) => {
      runFileCalls.push({ file, args, options });
      if (args?.[0] === "--version") return { stdout: "2.1.238" };
      if (args?.includes("/compact")) {
        return { stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "" })}\n` };
      }
      return { stdout: "" };
    },
    fileSystem: { ...fs, realpath: async (value) => value, readdir: async () => [] },
    sessionStore: { getBinding: async () => ({ canonicalCwd: "/work/project" }) },
  });

  const result = await backend.compactSession({
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
  });
  assert.deepEqual(result, {
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
    method: "cli/compact",
    accepted: true,
  });
  const compactCall = runFileCalls.find((call) => call.args?.includes("/compact"));
  assert.deepEqual(compactCall.args, [
    "-p", "--output-format", "json", "--safe-mode", "--resume", SESSION_ID, "/compact",
  ]);
  assert.equal(compactCall.options.cwd, "/work/project");
});

test("Claude compactSession fails closed on a non-success result", async () => {
  const backend = createClaudeBackend({
    binary: "/test/claude",
    runFile: async (file, args) => {
      if (args?.[0] === "--version") return { stdout: "2.1.238" };
      return { stdout: `${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true })}\n` };
    },
    fileSystem: { ...fs, realpath: async (value) => value, readdir: async () => [] },
    sessionStore: { getBinding: async () => ({ canonicalCwd: "/work/project" }) },
  });
  await assert.rejects(backend.compactSession({
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
  }), (error) => error.code === "turn_failed" && error.nativeActivity === "stopped");
});

test("Claude history restores context usage from the learned window and from compact boundary postTokens", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-claude-context-restore-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const project = path.join(tempRoot, "project");
  const cwd = path.join(tempRoot, "workspace");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(cwd);
  const transcript = path.join(project, `${SESSION_ID}.jsonl`);
  const records = [
    JSON.stringify({ type: "user", uuid: "u1", cwd, message: { content: "hello" } }),
    JSON.stringify({
      type: "assistant", uuid: "a1", cwd,
      message: {
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "reply" }],
        usage: { input_tokens: 2, cache_read_input_tokens: 99990, cache_creation_input_tokens: 8, output_tokens: 0 },
      },
    }),
  ];
  await fs.writeFile(transcript, records.join("\n"));
  const backend = createClaudeBackend({
    binary: "/test/claude",
    projectsRoot: tempRoot,
    runFile: async () => ({ stdout: "2.1.238" }),
    fileSystem: fs,
    sessionStore: { getBinding: async () => null },
    modelInfoStore: { get: async (backendId, modelId) => (modelId === "sonnet" ? { contextWindowTokens: 200000 } : null) },
  });

  const history = await backend.readHistory({
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
    limit: 10,
  });
  // (2+99990+8+0) / 200000 = 50%
  assert.deepEqual(history.contextUsage, { usedPct: 50, totalTokens: 100000, contextWindowTokens: 200000 });

  // /compact境界の後に新しいusageが無い間は、圧縮前の値ではなく境界レコードの
  // compactMetadata.postTokens(圧縮後トークン数)から復元する
  await fs.appendFile(transcript, `\n${JSON.stringify({
    type: "system", subtype: "compact_boundary", cwd,
    compactMetadata: { trigger: "manual", preTokens: 100000, postTokens: 1000 },
  })}`);
  const afterCompact = await backend.readHistory({
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
    limit: 10,
  });
  assert.deepEqual(afterCompact.contextUsage, { usedPct: 1, totalTokens: 1000, contextWindowTokens: 200000 });

  // postTokensが無い旧形式の境界では復元しない(次turnの実測まで非表示)
  await fs.appendFile(transcript, `\n${JSON.stringify({ type: "system", subtype: "compact_boundary", cwd })}`);
  const afterLegacyCompact = await backend.readHistory({
    sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID },
    limit: 10,
  });
  assert.equal(afterLegacyCompact.contextUsage, undefined);
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

test("Claude Backend completes a turn with multiple results and treats the last result as final", async () => {
  // バックグラウンドタスク(Task/Workflowのbackground実行)を含むターンでは、CLIは
  // 中間resultの後にtask-notificationをuserメッセージとして注入し同一プロセス内で
  // 自動継続、最終resultを再度出す(実測: assistant→result#1→user(task-notification)
  // →assistant→result#2→exit)。2つ目のresultでprotocol_errorにせず、最後のresultを
  // 正としてturn完了へ到達しなければならない(push通知欠落の根本原因)。
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "assistant", uuid: "assistant-launch", message: { content: [{ type: "text", text: "起動しました" }], usage: { input_tokens: 2, output_tokens: 1 } } },
    { type: "result", subtype: "success", result: "起動しました", session_id: SESSION_ID, usage: { input_tokens: 2, output_tokens: 1 } },
    { type: "user", message: { content: "<task-notification>\n<task-id>abc</task-id>\n</task-notification>" } },
    { type: "assistant", uuid: "assistant-final", message: { content: [{ type: "text", text: "最終報告" }], usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: "result", subtype: "success", result: "最終報告", session_id: SESSION_ID, usage: { input_tokens: 10, output_tokens: 5 } },
  ]);
  const events = [];
  const result = await backend.startTurn({
    runId: "run-multi-result",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "run background task" }] },
    resolveSession: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
  });
  assert.deepEqual(result, { outcome: "completed", nativeTerminal: true });
  // 最後のassistant item(=完了通知previewの元)が最終報告のテキストになる
  const completions = events.filter((event) => event.type === "item.completed" && event.payload.itemType === "assistant");
  assert.equal(completions.length, 2);
  assert.equal(completions.at(-1).payload.content?.[0]?.text, "最終報告");
  // usageはresultごとに最新assistant usage(#103のcontext表示仕様)でemitされ、
  // 最後の値が最終値になる(累積しない)
  const usageEvents = events.filter((event) => event.type === "usage.updated");
  assert.equal(usageEvents.length, 2);
  assert.equal(usageEvents.at(-1).payload.usage.input_tokens, 10);
});

test("Claude Backend fails the turn when the final result is an error even after an intermediate success", async () => {
  // 「最後のresultが正」: 中間resultがsuccessでも最終resultがerrorならturn失敗
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "result", subtype: "success", result: "途中経過", session_id: SESSION_ID },
    { type: "result", subtype: "error_during_execution", is_error: true, result: "failed", session_id: SESSION_ID },
  ]);
  await assert.rejects(backend.startTurn({
    runId: "run-multi-result-error",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: () => {},
  }), (error) => error.code === "turn_failed" && /failed result/i.test(error.message));
});

test("Claude Backend rejects a later result that changes the session ID", async () => {
  const otherSessionId = "22222222-2222-4222-8222-222222222222";
  const { backend } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "result", subtype: "success", result: "one", session_id: SESSION_ID },
    { type: "result", subtype: "success", result: "two", session_id: otherSessionId },
  ]);
  await assert.rejects(backend.startTurn({
    runId: "run-multi-result-session",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: () => {},
  }), (error) => error.code === "protocol_error" && /changed the session ID/i.test(error.message));
});

test("Claude no-output watchdog stays disarmed after the first result while a background task finishes", async () => {
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
    runId: "run-background-wait",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "run background task" }] },
    resolveSession: async () => {},
    emit: () => {},
  });
  writeLine({ type: "system", subtype: "init", session_id: SESSION_ID });
  writeLine({ type: "assistant", uuid: "a-launch", message: { content: [{ type: "text", text: "起動しました" }] } });
  writeLine({ type: "result", subtype: "success", result: "起動しました", session_id: SESSION_ID });
  // 中間result後、CLIはバックグラウンドタスク完了を静かに待つ。noOutputTimeoutMsの
  // 3倍以上の無音でもタイムアウトしてはならない(turnTimerだけがbackstop)。
  await new Promise((resolve) => setTimeout(resolve, 350));
  writeLine({ type: "user", message: { content: "<task-notification>\n<task-id>abc</task-id>\n</task-notification>" } });
  writeLine({ type: "assistant", uuid: "a-final", message: { content: [{ type: "text", text: "最終報告" }] } });
  writeLine({ type: "result", subtype: "success", result: "最終報告", session_id: SESSION_ID });
  child.stdout.end();
  child.emit("exit", 0, null);
  const result = await turn;
  assert.equal(result.outcome, "completed");
});

// バックグラウンド待ちテスト共通のbackend+手動stdout駆動セットアップ
function manualBackgroundRun(runId) {
  const child = fakeChild([], { exitAfterInput: false });
  const backend = createClaudeBackend({
    binary: "/test/claude",
    runFile: async (file, args) => ({ stdout: file === "ps" ? "started\n" : args?.[0] === "--version" ? "2.1.214" : "" }),
    fileSystem: { ...fs, realpath: async (value) => value },
    spawnProcess: () => child,
    sessionStore: { getBinding: async () => null },
    interruptGraceMs: 10,
    generateSessionId: () => SESSION_ID,
  });
  let stdinFinished = false;
  let stdinData = "";
  child.stdin.on("data", (chunk) => { stdinData += chunk.toString("utf8"); });
  child.stdin.on("finish", () => { stdinFinished = true; });
  const events = [];
  const turn = backend.startTurn({
    runId,
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "run background task" }] },
    resolveSession: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
  });
  const writeLine = (line) => child.stdout.write(`${JSON.stringify(line)}\n`);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
  return { backend, child, turn, writeLine, settle, events, stdin: { get finished() { return stdinFinished; }, get data() { return stdinData; } } };
}

test("Claude Backend holds stdin open while a background task is pending and closes it after the final result", async () => {
  // 根本原因の回帰テスト: バックグラウンドタスク実行中にresultが来ても、CLIを
  // exitさせない(=stdinを閉じない)。テキスト入力時代はここでプロセスが死に、
  // タスクが道連れkillされて「終わったらお知らせします」のまま無反応になっていた。
  // イベント列は実測(CLI 2.1.238)のstdoutシーケンスに合わせる:
  // background_tasks_changed→tool_result→result#1→(無音)→background_tasks_changed[]
  // →task_notification→assistant→result#2→exit。
  const run = manualBackgroundRun("run-hold-stdin");
  run.writeLine({ type: "system", subtype: "init", session_id: SESSION_ID });
  run.writeLine({ type: "assistant", uuid: "a-tool", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { run_in_background: true } }] } });
  run.writeLine({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task_1", task_type: "local_bash", description: "build" }], session_id: SESSION_ID });
  run.writeLine({ type: "system", subtype: "task_started", task_id: "task_1", tool_use_id: "tool-1", is_backgrounded: true, task_type: "local_bash", session_id: SESSION_ID });
  run.writeLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Command running in background with ID: task_1. Output is being written to: /tmp/task_1.output" }] } });
  run.writeLine({ type: "assistant", uuid: "a-launch", message: { content: [{ type: "text", text: "ビルド完了後にお知らせします" }] } });
  run.writeLine({ type: "result", subtype: "success", result: "ビルド完了後にお知らせします", session_id: SESSION_ID });
  await run.settle();
  // promptはstream-jsonの1行userメッセージとして書かれている
  const promptRecord = JSON.parse(run.stdin.data.split("\n")[0]);
  assert.equal(promptRecord.type, "user");
  assert.equal(promptRecord.message.content[0].text, "run background task");
  // 未完了タスクが残っている間はstdinを閉じない
  assert.equal(run.stdin.finished, false);
  run.writeLine({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: SESSION_ID });
  run.writeLine({ type: "system", subtype: "task_notification", task_id: "task_1", tool_use_id: "tool-1", status: "completed", summary: "Background command completed (exit code 0)", session_id: SESSION_ID });
  run.writeLine({ type: "assistant", uuid: "a-final", message: { content: [{ type: "text", text: "ビルドが完了しました" }] } });
  run.writeLine({ type: "result", subtype: "success", result: "ビルドが完了しました", session_id: SESSION_ID });
  await run.settle();
  // 全タスク完了後の最終resultでstdinを閉じ、CLIの自然exitを促す
  assert.equal(run.stdin.finished, true);
  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  const result = await run.turn;
  assert.equal(result.outcome, "completed");
  const completions = run.events.filter((event) => event.type === "item.completed" && event.payload.itemType === "assistant");
  assert.equal(completions.at(-1).payload.content?.[0]?.text, "ビルドが完了しました");
});

test("Claude Backend does not close stdin on task completion events alone before the next result", async () => {
  // background_tasks_changed([])やtask_notificationの時点で閉じると、自動継続の
  // assistant/result#2が出る前にCLIがexitし得る。クローズ判定はresult受信時のみ。
  const run = manualBackgroundRun("run-close-only-on-result");
  run.writeLine({ type: "system", subtype: "init", session_id: SESSION_ID });
  run.writeLine({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task_9" }], session_id: SESSION_ID });
  run.writeLine({ type: "result", subtype: "success", result: "待機します", session_id: SESSION_ID });
  await run.settle();
  assert.equal(run.stdin.finished, false);
  run.writeLine({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: SESSION_ID });
  run.writeLine({ type: "system", subtype: "task_notification", task_id: "task_9", status: "completed", session_id: SESSION_ID });
  await run.settle();
  // 通知だけではまだ閉じない(自動継続の途中でexitさせない)
  assert.equal(run.stdin.finished, false);
  run.writeLine({ type: "result", subtype: "success", result: "完了", session_id: SESSION_ID });
  await run.settle();
  assert.equal(run.stdin.finished, true);
  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  assert.equal((await run.turn).outcome, "completed");
});

test("Claude Backend closes stdin at the first result when no background task is pending", async () => {
  const run = manualBackgroundRun("run-close-stdin");
  run.writeLine({ type: "system", subtype: "init", session_id: SESSION_ID });
  run.writeLine({ type: "assistant", uuid: "a-final", message: { content: [{ type: "text", text: "done" }] } });
  run.writeLine({ type: "result", subtype: "success", result: "done", session_id: SESSION_ID });
  await run.settle();
  assert.equal(run.stdin.finished, true);
  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  const result = await run.turn;
  assert.equal(result.outcome, "completed");
});

test("Claude Backend can interrupt a turn that is waiting for a pending background task", async () => {
  const run = manualBackgroundRun("run-interrupt-pending");
  run.writeLine({ type: "system", subtype: "init", session_id: SESSION_ID });
  run.writeLine({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task_2" }], session_id: SESSION_ID });
  run.writeLine({ type: "result", subtype: "success", result: "待機します", session_id: SESSION_ID });
  await run.settle();
  assert.equal(run.stdin.finished, false);
  await run.backend.interrupt({ runId: "run-interrupt-pending" });
  assert.deepEqual(await run.turn, { outcome: "interrupted", nativeTerminal: true });
  assert.equal(run.child.signals.includes("SIGINT"), true);
});

test("Claude Backend ignores background-start text quoted in tool results", async () => {
  // pendingはsystemイベント(タスクレジストリ)だけを真実源とし、tool_result本文の
  // 文言(catやReadでログを読んだ出力)からは作らない。幻のpendingでターンが
  // 滞留しないことの回帰テスト。
  const run = manualBackgroundRun("run-foreground-noise");
  run.writeLine({ type: "system", subtype: "init", session_id: SESSION_ID });
  run.writeLine({ type: "assistant", uuid: "a-read", message: { content: [{ type: "tool_use", id: "tool-fg", name: "Read", input: { file_path: "/tmp/old.log" } }] } });
  run.writeLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-fg", content: "log: Command running in background with ID: ghost_1. done" }] } });
  run.writeLine({ type: "result", subtype: "success", result: "done", session_id: SESSION_ID });
  await run.settle();
  assert.equal(run.stdin.finished, true);
  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  assert.equal((await run.turn).outcome, "completed");
});

test("Claude Backend closes stdin on an error result even while a background task is pending", async () => {
  const run = manualBackgroundRun("run-error-with-pending");
  run.writeLine({ type: "system", subtype: "init", session_id: SESSION_ID });
  run.writeLine({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task_err" }], session_id: SESSION_ID });
  run.writeLine({ type: "result", subtype: "error_during_execution", is_error: true, result: "failed", session_id: SESSION_ID });
  await run.settle();
  // エラーresultでは自動継続を期待できないため、pending残でも即クローズする
  assert.equal(run.stdin.finished, true);
  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  await assert.rejects(run.turn, (error) => error.code === "turn_failed");
});

test("Claude Backend clears pending tasks when the registry reports them stopped", async () => {
  // KillShell等の手動停止でも background_tasks_changed が新しい全量一覧で発火する
  // ため、通知が無くても待機が解除される。
  const run = manualBackgroundRun("run-killshell");
  run.writeLine({ type: "system", subtype: "init", session_id: SESSION_ID });
  run.writeLine({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task_3" }], session_id: SESSION_ID });
  run.writeLine({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: SESSION_ID });
  run.writeLine({ type: "result", subtype: "success", result: "停止しました", session_id: SESSION_ID });
  await run.settle();
  assert.equal(run.stdin.finished, true);
  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  assert.equal((await run.turn).outcome, "completed");
});

test("Claude Backend clears a pending task from a user-message task-notification as a fallback", async () => {
  // stdoutの正式経路はsystem/task_notificationだが、userメッセージ経由で届く
  // 変種(textブロック配列)でも解除できるbeltを検証する。
  const run = manualBackgroundRun("run-user-notification");
  run.writeLine({ type: "system", subtype: "init", session_id: SESSION_ID });
  run.writeLine({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "agent_x1" }], session_id: SESSION_ID });
  run.writeLine({ type: "result", subtype: "success", result: "待機します", session_id: SESSION_ID });
  await run.settle();
  assert.equal(run.stdin.finished, false);
  run.writeLine({ type: "user", message: { content: [{ type: "text", text: "<task-notification>\n<task-id>agent_x1</task-id>\n<status>completed</status>\n</task-notification>" }] } });
  run.writeLine({ type: "result", subtype: "success", result: "完了", session_id: SESSION_ID });
  await run.settle();
  assert.equal(run.stdin.finished, true);
  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  assert.equal((await run.turn).outcome, "completed");
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

test("Claude batch session snapshot scans the transcript catalog once and groups by cwd", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-claude-batch-list-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const projectsRoot = path.join(tempRoot, "projects");
  const project = path.join(projectsRoot, "catalog");
  const cwdOne = path.join(tempRoot, "workspace-one");
  const cwdTwo = path.join(tempRoot, "workspace-two");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(cwdOne);
  await fs.mkdir(cwdTwo);
  const sessionOne = "11111111-1111-4111-8111-111111111111";
  const sessionTwo = "22222222-2222-4222-8222-222222222222";
  await fs.writeFile(path.join(project, `${sessionOne}.jsonl`), JSON.stringify({
    type: "user", uuid: "u1", cwd: cwdOne, message: { content: "one" },
  }));
  await fs.writeFile(path.join(project, `${sessionTwo}.jsonl`), JSON.stringify({
    type: "user", uuid: "u2", cwd: cwdTwo, message: { content: "two" },
  }));
  let readdirCalls = 0;
  const backend = createClaudeBackend({
    binary: "/test/claude",
    projectsRoot,
    runFile: async () => ({ stdout: "2.1.214" }),
    fileSystem: { ...fs, async readdir(...args) {
      readdirCalls += 1;
      return await fs.readdir(...args);
    } },
    sessionStore: { getBinding: async () => null },
  });

  const snapshot = await backend.listSessionsForDirectories({ cwds: [cwdOne, cwdTwo] });

  assert.equal(readdirCalls, 2);
  assert.deepEqual(snapshot.groups.map((group) => ({
    cwd: group.cwd,
    sessionIds: group.sessions.map((session) => session.sessionRef.nativeSessionId),
  })), [
    { cwd: await fs.realpath(cwdOne), sessionIds: [sessionOne] },
    { cwd: await fs.realpath(cwdTwo), sessionIds: [sessionTwo] },
  ]);
});

test("Claude session listing enumerates subagent transcripts under the parent session directory", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-claude-subagents-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const projectsRoot = path.join(tempRoot, "projects");
  const project = path.join(projectsRoot, "catalog");
  const cwd = path.join(tempRoot, "workspace");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(cwd);
  const parentId = SESSION_ID;
  const taskAgentId = "agent-a1b2c3d4e5f60718a";
  const workflowAgentId = "agent-b2c3d4e5f6071829b";
  await fs.writeFile(path.join(project, `${parentId}.jsonl`), JSON.stringify({
    type: "user", uuid: "u1", cwd, timestamp: "2026-08-28T00:00:00.000Z", message: { content: "parent task" },
  }));
  // Taskサブエージェント: <parent>/subagents/agent-<id>.jsonl
  const subagentsDir = path.join(project, parentId, "subagents");
  await fs.mkdir(subagentsDir, { recursive: true });
  await fs.writeFile(path.join(subagentsDir, `${taskAgentId}.jsonl`), [
    JSON.stringify({ type: "user", uuid: "su1", cwd, isSidechain: true, agentId: taskAgentId.slice(6), timestamp: "2026-08-28T00:01:00.000Z", message: { content: "subagent prompt" } }),
    JSON.stringify({ type: "assistant", uuid: "sa1", cwd, isSidechain: true, agentId: taskAgentId.slice(6), timestamp: "2026-08-28T00:01:05.000Z", message: { content: [{ type: "text", text: "subagent reply" }] } }),
  ].join("\n"));
  await fs.writeFile(path.join(subagentsDir, `${taskAgentId}.meta.json`), JSON.stringify({
    agentType: "general-purpose", description: "検証タスク", spawnDepth: 1,
  }));
  // ワークフローのサブエージェント: <parent>/subagents/workflows/<wfId>/agent-<id>.jsonl
  const workflowDir = path.join(subagentsDir, "workflows", "wf_755bbf2f-29e");
  await fs.mkdir(workflowDir, { recursive: true });
  await fs.writeFile(path.join(workflowDir, `${workflowAgentId}.jsonl`), JSON.stringify({
    type: "user", uuid: "wu1", cwd, isSidechain: true, timestamp: "2026-08-28T00:02:00.000Z", message: { content: "workflow subagent prompt" },
  }));
  // agent-*.jsonl以外(journal等)はセッションとして列挙しない
  await fs.writeFile(path.join(workflowDir, "journal.jsonl"), JSON.stringify({ type: "journal" }));
  const backend = createClaudeBackend({
    binary: "/test/claude",
    projectsRoot,
    runFile: async () => ({ stdout: "2.1.214" }),
    fileSystem: fs,
    sessionStore: { getBinding: async () => null },
  });

  const listed = await backend.listSessions({ cwd, limit: 10 });
  const byId = new Map(listed.sessions.map((session) => [session.sessionRef.nativeSessionId, session]));
  assert.deepEqual([...byId.keys()].sort(), [parentId, taskAgentId, workflowAgentId].sort());
  assert.equal(byId.get(parentId).isSubagent, false);
  assert.equal(byId.get(parentId).createdAt, "2026-08-28T00:00:00.000Z");
  assert.equal(byId.get(parentId).parentSessionRef, undefined);
  for (const agentId of [taskAgentId, workflowAgentId]) {
    assert.equal(byId.get(agentId).isSubagent, true);
    assert.match(byId.get(agentId).createdAt, /^2026-08-28T00:0[12]:00\.000Z$/);
    assert.deepEqual(byId.get(agentId).parentSessionRef, { backendId: "claude", nativeSessionId: parentId });
  }
  // タイトルはtranscript先頭のユーザーメッセージ(全recordがisSidechainでも拾える)
  assert.equal(byId.get(taskAgentId).title, "subagent prompt");

  // includeSubagents=false(未読カウント・Skiaボードingest)はメインセッションのみ
  const filtered = await backend.listSessions({ cwd, limit: 10, includeSubagents: false });
  assert.deepEqual(filtered.sessions.map((session) => session.sessionRef.nativeSessionId), [parentId]);
  const snapshot = await backend.listSessionsForDirectories({ cwds: [cwd], includeSubagents: false });
  assert.deepEqual(snapshot.groups[0].sessions.map((session) => session.sessionRef.nativeSessionId), [parentId]);

  // 履歴読み出しはサブエージェントnativeSessionIdでも解決でき、本人の会話は
  // sidechain(折りたたみ)扱いにならない
  const history = await backend.readHistory({
    sessionRef: { backendId: "claude", nativeSessionId: taskAgentId },
    limit: 10,
  });
  assert.deepEqual(history.items.map((item) => ({ role: item.role, itemType: item.itemType })), [
    { role: "user", itemType: undefined },
    { role: "assistant", itemType: undefined },
  ]);
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
    JSON.stringify({ type: "user", uuid: "compact-1", cwd, isCompactSummary: true, message: { content: "compact summary body" } }),
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
    { id: "compact-1", itemType: "internal_context" },
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

// --- interactive permission (claude-on-request) ---

test("Claude Backend defaults to the dontAsk flag set when no policy profile is given", async () => {
  const { backend, calls } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "result", subtype: "success", result: "ok", session_id: SESSION_ID },
  ]);
  await backend.startTurn({
    runId: "run-default-profile",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: () => {},
  });
  assert.equal(calls[0].args.includes("--safe-mode"), true);
  const modeIndex = calls[0].args.indexOf("--permission-mode");
  assert.deepEqual(calls[0].args.slice(modeIndex, modeIndex + 2), ["--permission-mode", "dontAsk"]);
  assert.equal(calls[0].args.includes("--setting-sources"), false);
  assert.equal(calls[0].args.includes("--permission-prompt-tool"), false);
});

test("Claude Backend claude-on-request builds interactive argv with an inline MCP config and no --safe-mode", async () => {
  const { backend, calls } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "result", subtype: "success", result: "ok", session_id: SESSION_ID },
  ]);
  const result = await backend.startTurn({
    runId: "run-interactive-argv",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    policyProfileId: "claude-on-request",
    resolveSession: async () => {},
    emit: () => {},
  });
  assert.equal(result.outcome, "completed");
  const args = calls[0].args;
  assert.equal(args.includes("--safe-mode"), false);
  assert.equal(args.includes("--permission-mode"), false);
  const settingSourcesIndex = args.indexOf("--setting-sources");
  assert.ok(settingSourcesIndex >= 0);
  assert.equal(args[settingSourcesIndex + 1], "");
  assert.equal(args.includes("--strict-mcp-config"), true);
  const promptToolIndex = args.indexOf("--permission-prompt-tool");
  assert.equal(args[promptToolIndex + 1], "mcp__bitty_permission__approval_prompt");
  const mcpConfig = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  const server = mcpConfig.mcpServers.bitty_permission;
  assert.equal(server.command, process.execPath);
  assert.equal(server.args.length, 1);
  assert.ok(server.args[0].endsWith(path.join("tools", "claude-permission-prompt-mcp.mjs")));
  assert.ok(server.env.BITTY_PERMISSION_SOCKET);
  assert.ok(server.env.BITTY_PERMISSION_TOKEN);
});

test("Claude Backend applies the same conversation-history instruction as a system prompt", async () => {
  const { backend, calls } = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "result", subtype: "success", result: "ok", session_id: SESSION_ID },
  ], { backendOverrides: { developerInstructions: CONVERSATION_HISTORY_TOOL_INSTRUCTIONS } });
  await backend.startTurn({
    runId: "run-history-instructions",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "find a conversation" }] },
    resolveSession: async () => {},
    emit: () => {},
  });
  const promptIndex = calls[0].args.indexOf("--append-system-prompt");
  assert.ok(promptIndex >= 0);
  assert.equal(calls[0].args[promptIndex + 1], CONVERSATION_HISTORY_TOOL_INSTRUCTIONS);
});

test("Claude Backend sets MCP timeout env vars only for the interactive profile", async () => {
  const interactiveRun = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "result", subtype: "success", result: "ok", session_id: SESSION_ID },
  ], { backendOverrides: { environment: {
    PATH: "/test/bin",
    BITTY_RUNNER_URL: "http://127.0.0.1:8788",
    BITTY_RUNNER_TOKEN_FILE: "/test/bitty-token",
    RUNNER_TOKEN_FILE: "/test/runner-token",
    UNSAFE_SECRET: "not-forwarded",
  } } });
  await interactiveRun.backend.startTurn({
    runId: "run-mcp-timeout",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    policyProfileId: "claude-on-request",
    resolveSession: async () => {},
    emit: () => {},
  });
  assert.equal(interactiveRun.calls[0].options.env.MCP_TOOL_TIMEOUT, "86400000");
  assert.equal(interactiveRun.calls[0].options.env.MCP_TIMEOUT, "86400000");
  assert.equal(interactiveRun.calls[0].options.env.BITTY_RUNNER_TOKEN_FILE, "/test/bitty-token");
  assert.equal(interactiveRun.calls[0].options.env.RUNNER_TOKEN_FILE, "/test/runner-token");
  assert.equal("UNSAFE_SECRET" in interactiveRun.calls[0].options.env, false);

  const dontAskRun = backendWith([
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "result", subtype: "success", result: "ok", session_id: SESSION_ID },
  ]);
  await dontAskRun.backend.startTurn({
    runId: "run-no-mcp-timeout",
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "hello" }] },
    resolveSession: async () => {},
    emit: () => {},
  });
  assert.equal("MCP_TOOL_TIMEOUT" in dontAskRun.calls[0].options.env, false);
  assert.equal("MCP_TIMEOUT" in dontAskRun.calls[0].options.env, false);
});

// interactive経路のテストは、CLIが子processとしてspawnするMCP shimの代わりに、
// テストが直接permission bridgeのUnix socketへ話しかける(設計書§5)。
function startInteractivePermissionRun(runId, overrides = {}) {
  const runtime = overrides.runtime || { calls: [], children: [] };
  const calls = runtime.calls;
  const child = fakeChild([], { exitAfterInput: false });
  runtime.children.push(child);
  const spawnIndex = calls.length;
  if (!runtime.backend) {
    runtime.backend = createClaudeBackend({
      binary: "/test/claude",
      runFile: async (file, args) => ({
        stdout: file === "ps" ? "Thu Aug 21 12:34:56 2026\n" : args?.[0] === "--version" ? "2.1.214" : "",
      }),
      fileSystem: { ...fs, realpath: async (value) => value },
      spawnProcess: (binary, args, options) => {
        calls.push({ binary, args, options });
        return runtime.children.shift();
      },
      sessionStore: { getBinding: async () => null },
      interruptGraceMs: 10,
      generateSessionId: () => SESSION_ID,
      ...overrides.backendOptions,
    });
  }
  const backend = runtime.backend;
  const events = [];
  const waiters = [];
  function emit(type, payload) {
    const event = { type, payload };
    events.push(event);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].predicate(event)) {
        waiters[index].resolve(event);
        waiters.splice(index, 1);
      }
    }
  }
  function waitFor(predicate) {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => waiters.push({ predicate, resolve }));
  }
  const turn = backend.startTurn({
    runId,
    cwd: "/work/project",
    input: { blocks: [{ type: "text", text: "write it" }] },
    policyProfileId: "claude-on-request",
    resolveSession: async () => {},
    setNativeProcessIdentity: async () => {},
    emit,
    ...overrides.startOptions,
  });
  const nativeSessionId = overrides.startOptions?.sessionRef?.nativeSessionId || SESSION_ID;
  return { backend, child, calls, events, waitFor, turn, runId, spawnIndex, nativeSessionId };
}

async function waitForSpawn(calls, index = 0) {
  while (!calls[index]) await new Promise((resolve) => setImmediate(resolve));
  return calls[index];
}

function permissionBridgeEnv(args) {
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  return config.mcpServers.bitty_permission.env;
}

// shimの代わりにテストがbridgeへ直接話しかけるためのnewline-JSON往復ヘルパー。
function sendPermissionRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.on("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); });
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        resolve(JSON.parse(buffer.split("\n")[0] || ""));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function initializeInteractivePermissionRun(run) {
  const spawned = await waitForSpawn(run.calls, run.spawnIndex);
  const bridgeEnv = permissionBridgeEnv(spawned.args);
  run.child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: run.nativeSessionId })}\n`);
  await run.waitFor((event) => event.type === "turn.started");
  return bridgeEnv;
}

async function finishInteractivePermissionRun(run) {
  run.child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: run.nativeSessionId })}\n`);
  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  assert.deepEqual(await run.turn, { outcome: "completed", nativeTerminal: true });
}

test("Claude Backend session permission is scoped by backend instance, native session, and tool", async () => {
  const runtime = { calls: [], children: [] };
  const first = startInteractivePermissionRun("run-session-first", { runtime });
  const firstBridge = await initializeInteractivePermissionRun(first);

  const firstReply = sendPermissionRequest(firstBridge.BITTY_PERMISSION_SOCKET, {
    token: firstBridge.BITTY_PERMISSION_TOKEN, toolName: "Write", input: { file: "a" }, toolUseId: "write-a",
  });
  const firstRequest = await first.waitFor((event) => event.type === "action.requested" && event.payload.toolCallId === "write-a");
  const parallelReply = sendPermissionRequest(firstBridge.BITTY_PERMISSION_SOCKET, {
    token: firstBridge.BITTY_PERMISSION_TOKEN, toolName: "Write", input: { file: "b" }, toolUseId: "write-b",
  });
  const parallelRequest = await first.waitFor((event) => event.type === "action.requested" && event.payload.toolCallId === "write-b");

  await first.backend.respondToAction({
    runId: first.runId, requestId: firstRequest.payload.requestId, decision: "allow_for_session",
  });
  assert.deepEqual(await firstReply, { decision: "allow" });
  let parallelSettled = false;
  parallelReply.then(() => { parallelSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(parallelSettled, false);
  await first.backend.respondToAction({
    runId: first.runId, requestId: parallelRequest.payload.requestId, decision: "deny",
  });
  assert.deepEqual(await parallelReply, { decision: "deny" });

  const requestedCount = first.events.filter((event) => event.type === "action.requested").length;
  const immediateReply = await sendPermissionRequest(firstBridge.BITTY_PERMISSION_SOCKET, {
    token: firstBridge.BITTY_PERMISSION_TOKEN, toolName: "Write", input: { file: "c" }, toolUseId: "write-c",
  });
  assert.deepEqual(immediateReply, { decision: "allow" });
  assert.equal(first.events.filter((event) => event.type === "action.requested").length, requestedCount);

  const otherToolReply = sendPermissionRequest(firstBridge.BITTY_PERMISSION_SOCKET, {
    token: firstBridge.BITTY_PERMISSION_TOKEN, toolName: "Bash", input: { command: "pwd" }, toolUseId: "bash-a",
  });
  const otherToolRequest = await first.waitFor((event) => event.type === "action.requested" && event.payload.toolCallId === "bash-a");
  await first.backend.respondToAction({ runId: first.runId, requestId: otherToolRequest.payload.requestId, decision: "deny" });
  assert.deepEqual(await otherToolReply, { decision: "deny" });
  await finishInteractivePermissionRun(first);

  const resumed = startInteractivePermissionRun("run-session-resumed", {
    runtime,
    startOptions: { sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID } },
  });
  const resumedBridge = await initializeInteractivePermissionRun(resumed);
  assert.deepEqual(await sendPermissionRequest(resumedBridge.BITTY_PERMISSION_SOCKET, {
    token: resumedBridge.BITTY_PERMISSION_TOKEN, toolName: "Write", input: {}, toolUseId: "write-resumed",
  }), { decision: "allow" });
  assert.equal(resumed.events.some((event) => event.type === "action.requested"), false);
  await finishInteractivePermissionRun(resumed);

  const otherSessionId = "22222222-2222-4222-8222-222222222222";
  const otherSession = startInteractivePermissionRun("run-other-session", {
    runtime,
    startOptions: { sessionRef: { backendId: "claude", nativeSessionId: otherSessionId } },
  });
  const otherSessionBridge = await initializeInteractivePermissionRun(otherSession);
  const otherSessionReply = sendPermissionRequest(otherSessionBridge.BITTY_PERMISSION_SOCKET, {
    token: otherSessionBridge.BITTY_PERMISSION_TOKEN, toolName: "Write", input: {}, toolUseId: "write-other-session",
  });
  const otherSessionRequest = await otherSession.waitFor((event) => event.type === "action.requested");
  await otherSession.backend.respondToAction({ runId: otherSession.runId, requestId: otherSessionRequest.payload.requestId, decision: "deny" });
  assert.deepEqual(await otherSessionReply, { decision: "deny" });
  await finishInteractivePermissionRun(otherSession);

  const restartedRun = startInteractivePermissionRun("run-restarted");
  const restartedBridge = await initializeInteractivePermissionRun(restartedRun);
  const restartedReply = sendPermissionRequest(restartedBridge.BITTY_PERMISSION_SOCKET, {
    token: restartedBridge.BITTY_PERMISSION_TOKEN, toolName: "Write", input: {}, toolUseId: "write-restarted",
  });
  const restartedRequest = await restartedRun.waitFor((event) => event.type === "action.requested");
  await restartedRun.backend.respondToAction({ runId: restartedRun.runId, requestId: restartedRequest.payload.requestId, decision: "deny" });
  assert.deepEqual(await restartedReply, { decision: "deny" });
  await finishInteractivePermissionRun(restartedRun);
});

test("Claude Backend does not grant session permission on interrupt or turn failure", async () => {
  const runtime = { calls: [], children: [] };
  const interrupted = startInteractivePermissionRun("run-session-interrupted", { runtime });
  const interruptedBridge = await initializeInteractivePermissionRun(interrupted);
  const interruptedReply = sendPermissionRequest(interruptedBridge.BITTY_PERMISSION_SOCKET, {
    token: interruptedBridge.BITTY_PERMISSION_TOKEN, toolName: "Read", input: {}, toolUseId: "read-interrupted",
  });
  await interrupted.waitFor((event) => event.type === "action.requested");
  await interrupted.backend.interrupt({ runId: interrupted.runId });
  assert.equal((await interrupted.turn).outcome, "interrupted");
  assert.equal((await interruptedReply).decision, "deny");

  const failed = startInteractivePermissionRun("run-session-failed", {
    runtime,
    startOptions: { sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID } },
  });
  const failedBridge = await initializeInteractivePermissionRun(failed);
  const readAfterInterruptReply = sendPermissionRequest(failedBridge.BITTY_PERMISSION_SOCKET, {
    token: failedBridge.BITTY_PERMISSION_TOKEN, toolName: "Read", input: {}, toolUseId: "read-after-interrupt",
  });
  const readAfterInterrupt = await failed.waitFor((event) => event.type === "action.requested" && event.payload.toolCallId === "read-after-interrupt");
  await failed.backend.respondToAction({ runId: failed.runId, requestId: readAfterInterrupt.payload.requestId, decision: "deny" });
  assert.deepEqual(await readAfterInterruptReply, { decision: "deny" });

  const failedReply = sendPermissionRequest(failedBridge.BITTY_PERMISSION_SOCKET, {
    token: failedBridge.BITTY_PERMISSION_TOKEN, toolName: "Edit", input: {}, toolUseId: "edit-failed",
  });
  await failed.waitFor((event) => event.type === "action.requested" && event.payload.toolCallId === "edit-failed");
  failed.child.stdout.write(`${JSON.stringify({
    type: "result", subtype: "error_during_execution", is_error: true, result: "failed", session_id: SESSION_ID,
  })}\n`);
  failed.child.stdout.end();
  failed.child.emit("exit", 1, null);
  await assert.rejects(failed.turn, (error) => error.code === "turn_failed");
  assert.equal((await failedReply).decision, "deny");

  const afterFailure = startInteractivePermissionRun("run-session-after-failure", {
    runtime,
    startOptions: { sessionRef: { backendId: "claude", nativeSessionId: SESSION_ID } },
  });
  const afterFailureBridge = await initializeInteractivePermissionRun(afterFailure);
  const afterFailureReply = sendPermissionRequest(afterFailureBridge.BITTY_PERMISSION_SOCKET, {
    token: afterFailureBridge.BITTY_PERMISSION_TOKEN, toolName: "Edit", input: {}, toolUseId: "edit-after-failure",
  });
  const afterFailureRequest = await afterFailure.waitFor((event) => event.type === "action.requested");
  await afterFailure.backend.respondToAction({ runId: afterFailure.runId, requestId: afterFailureRequest.payload.requestId, decision: "deny" });
  assert.deepEqual(await afterFailureReply, { decision: "deny" });
  await finishInteractivePermissionRun(afterFailure);
});

test("Claude Backend interactive permission: a bridge request before system/init is denied and not registered", async () => {
  const run = startInteractivePermissionRun("run-pre-init");
  const spawned = await waitForSpawn(run.calls);
  const bridgeEnv = permissionBridgeEnv(spawned.args);
  const result = await sendPermissionRequest(bridgeEnv.BITTY_PERMISSION_SOCKET, {
    token: bridgeEnv.BITTY_PERMISSION_TOKEN, toolName: "Write", input: {}, toolUseId: "pre-init",
  });
  assert.equal(result.decision, "deny");
  assert.equal(run.events.some((event) => event.type === "action.requested"), false);

  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  await assert.rejects(run.turn);
});

test("Claude Backend interactive permission: allow unblocks the tool and emits action.resolved(answered)", async () => {
  const run = startInteractivePermissionRun("run-allow");
  const spawned = await waitForSpawn(run.calls);
  const bridgeEnv = permissionBridgeEnv(spawned.args);

  run.child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: SESSION_ID })}\n`);
  await run.waitFor((event) => event.type === "turn.started");

  // stdout無しでpermission requestだけが先行するケース(tool.startedは送っていない)
  const socketReply = sendPermissionRequest(bridgeEnv.BITTY_PERMISSION_SOCKET, {
    token: bridgeEnv.BITTY_PERMISSION_TOKEN, toolName: "Write", input: { file_path: "a.txt" }, toolUseId: "tool-1",
  });
  const requested = await run.waitFor((event) => event.type === "action.requested");
  assert.equal(requested.payload.kind, "permission");
  assert.ok(requested.payload.title.startsWith("Write:"));
  assert.ok(requested.payload.title.includes("a.txt"));
  assert.equal(requested.payload.toolCallId, "tool-1");
  assert.deepEqual(requested.payload.decisions, ["allow", "allow_for_session", "deny"]);

  await run.backend.respondToAction({ runId: run.runId, requestId: requested.payload.requestId, decision: "allow" });
  assert.deepEqual(await socketReply, { decision: "allow" });

  const resolved = await run.waitFor((event) => event.type === "action.resolved");
  assert.deepEqual(resolved.payload, { requestId: requested.payload.requestId, outcome: "answered", decision: "allow" });

  const nextReply = sendPermissionRequest(bridgeEnv.BITTY_PERMISSION_SOCKET, {
    token: bridgeEnv.BITTY_PERMISSION_TOKEN, toolName: "Write", input: { file_path: "b.txt" }, toolUseId: "tool-2",
  });
  const nextRequested = await run.waitFor((event) => event.type === "action.requested" && event.payload.toolCallId === "tool-2");
  await run.backend.respondToAction({ runId: run.runId, requestId: nextRequested.payload.requestId, decision: "deny" });
  assert.deepEqual(await nextReply, { decision: "deny" });

  await assert.rejects(
    run.backend.respondToAction({ runId: run.runId, requestId: requested.payload.requestId, decision: "allow" }),
    (error) => error.code === "action_expired",
  );

  run.child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: SESSION_ID })}\n`);
  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  assert.deepEqual(await run.turn, { outcome: "completed", nativeTerminal: true });

  // run終了時にbridgeがcloseされ、socketが消えている
  await assert.rejects(fs.access(bridgeEnv.BITTY_PERMISSION_SOCKET));
});

test("Claude Backend interactive permission: deny keeps the turn running and reports the decision", async () => {
  const run = startInteractivePermissionRun("run-deny");
  const spawned = await waitForSpawn(run.calls);
  const bridgeEnv = permissionBridgeEnv(spawned.args);
  run.child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: SESSION_ID })}\n`);
  await run.waitFor((event) => event.type === "turn.started");

  const socketReply = sendPermissionRequest(bridgeEnv.BITTY_PERMISSION_SOCKET, {
    token: bridgeEnv.BITTY_PERMISSION_TOKEN, toolName: "Bash", input: { cmd: "rm -rf" }, toolUseId: "tool-2",
  });
  const requested = await run.waitFor((event) => event.type === "action.requested");
  await run.backend.respondToAction({ runId: run.runId, requestId: requested.payload.requestId, decision: "deny" });
  assert.deepEqual(await socketReply, { decision: "deny" });
  const resolved = await run.waitFor((event) => event.type === "action.resolved");
  assert.equal(resolved.payload.decision, "deny");

  run.child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: SESSION_ID })}\n`);
  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  assert.deepEqual(await run.turn, { outcome: "completed", nativeTerminal: true });
});

test("Claude Backend interactive permission: responding to an unknown requestId fails with action_expired", async () => {
  const run = startInteractivePermissionRun("run-unknown-request");
  await waitForSpawn(run.calls);
  await assert.rejects(
    run.backend.respondToAction({ runId: run.runId, requestId: "does-not-exist", decision: "allow" }),
    (error) => error.code === "action_expired",
  );
  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  await assert.rejects(run.turn);
});

test("Claude Backend interactive permission: multiple pending requests resolve independently even out of order", async () => {
  const run = startInteractivePermissionRun("run-multi-pending");
  const spawned = await waitForSpawn(run.calls);
  const bridgeEnv = permissionBridgeEnv(spawned.args);
  run.child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: SESSION_ID })}\n`);
  await run.waitFor((event) => event.type === "turn.started");

  const replyA = sendPermissionRequest(bridgeEnv.BITTY_PERMISSION_SOCKET, {
    token: bridgeEnv.BITTY_PERMISSION_TOKEN, toolName: "Write", input: { file: "a" }, toolUseId: "tool-a",
  });
  const requestedA = await run.waitFor((event) => event.type === "action.requested" && event.payload.toolCallId === "tool-a");
  const replyB = sendPermissionRequest(bridgeEnv.BITTY_PERMISSION_SOCKET, {
    token: bridgeEnv.BITTY_PERMISSION_TOKEN, toolName: "Bash", input: { cmd: "ls" }, toolUseId: "tool-b",
  });
  const requestedB = await run.waitFor((event) => event.type === "action.requested" && event.payload.toolCallId === "tool-b");
  assert.notEqual(requestedA.payload.requestId, requestedB.payload.requestId);

  // 立てた順(A→B)と逆順(B→A)で回答しても、それぞれの接続へ正しく対応付く
  await run.backend.respondToAction({ runId: run.runId, requestId: requestedB.payload.requestId, decision: "allow" });
  assert.deepEqual(await replyB, { decision: "allow" });
  await run.backend.respondToAction({ runId: run.runId, requestId: requestedA.payload.requestId, decision: "deny" });
  assert.deepEqual(await replyA, { decision: "deny" });

  run.child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: SESSION_ID })}\n`);
  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  assert.deepEqual(await run.turn, { outcome: "completed", nativeTerminal: true });
});

test("Claude Backend interactive permission: no-output timeout is suppressed while pending and resumes after the answer", async () => {
  const run = startInteractivePermissionRun("run-no-output-pending", {
    backendOptions: { noOutputTimeoutMs: 100 },
  });
  const spawned = await waitForSpawn(run.calls);
  const bridgeEnv = permissionBridgeEnv(spawned.args);
  run.child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: SESSION_ID })}\n`);
  await run.waitFor((event) => event.type === "turn.started");

  let settled = false;
  run.turn.then(() => { settled = true; }, () => { settled = true; });

  // stdout無しでpermission requestだけが先行するケース
  const socketReply = sendPermissionRequest(bridgeEnv.BITTY_PERMISSION_SOCKET, {
    token: bridgeEnv.BITTY_PERMISSION_TOKEN, toolName: "Write", input: {}, toolUseId: "tool-1",
  });
  const requested = await run.waitFor((event) => event.type === "action.requested");
  // no-output timeoutの2倍以上、無出力のまま待っても承認待ち中は落ちない
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(settled, false);

  await run.backend.respondToAction({ runId: run.runId, requestId: requested.payload.requestId, decision: "allow" });
  await socketReply;

  // 回答後は無出力監視が再開される: そのまま無出力だとtimeoutで落ちる
  await assert.rejects(run.turn, (error) => error.code === "timeout");
});

test("Claude Backend interactive permission: a bridge request after run teardown is denied and the socket is gone", async () => {
  const run = startInteractivePermissionRun("run-post-teardown");
  const spawned = await waitForSpawn(run.calls);
  const bridgeEnv = permissionBridgeEnv(spawned.args);
  run.child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: SESSION_ID })}\n`);
  await run.waitFor((event) => event.type === "turn.started");
  run.child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: SESSION_ID })}\n`);
  run.child.stdout.end();
  run.child.emit("exit", 0, null);
  await run.turn;

  await assert.rejects(sendPermissionRequest(bridgeEnv.BITTY_PERMISSION_SOCKET, {
    token: bridgeEnv.BITTY_PERMISSION_TOKEN, toolName: "Write", input: {}, toolUseId: "late",
  }));
  assert.equal(run.events.some((event) => event.type === "action.requested" && event.payload.toolCallId === "late"), false);
});

test("Claude Backend interactive permission: interrupting the run denies pending requests and closes the bridge", async () => {
  const run = startInteractivePermissionRun("run-interrupt-pending");
  const spawned = await waitForSpawn(run.calls);
  const bridgeEnv = permissionBridgeEnv(spawned.args);
  run.child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: SESSION_ID })}\n`);
  await run.waitFor((event) => event.type === "turn.started");

  const socketReply = sendPermissionRequest(bridgeEnv.BITTY_PERMISSION_SOCKET, {
    token: bridgeEnv.BITTY_PERMISSION_TOKEN, toolName: "Write", input: {}, toolUseId: "tool-1",
  });
  await run.waitFor((event) => event.type === "action.requested");

  await run.backend.interrupt({ runId: run.runId });
  const result = await run.turn;
  assert.equal(result.outcome, "interrupted");
  assert.equal((await socketReply).decision, "deny");
  await assert.rejects(fs.access(bridgeEnv.BITTY_PERMISSION_SOCKET));
});
