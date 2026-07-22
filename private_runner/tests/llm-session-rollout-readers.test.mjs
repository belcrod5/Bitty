import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLlmSessionRolloutReaders } from "../src/llm-session-rollout-readers.mjs";

function createReaders() {
  return createLlmSessionRolloutReaders({
    makeApiError: (_status, _code, message) => new Error(message),
    normalizeReasoningEffort: (value) => String(value || "").trim(),
    normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
    normalizeTokenCount: (value) => Number(value || 0),
    parseOpenAICodexModelRef: (value) => ({ modelRef: String(value || "") }),
    sessionMessagesPageSize: 10,
    sessionRolloutMaxReadBytes: 1024 * 1024,
    sessionSummaryHeadMaxReadBytes: 128 * 1024,
    sessionSummaryTailMaxReadBytes: 128 * 1024,
  });
}

test("forked subagent rollout marks its inherited parent range", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-subagent-rollout-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const worktree = path.join(tempDir, "child-worktree");
  const nestedWorkdir = path.join(worktree, "private_runner");
  await fs.mkdir(path.join(worktree, ".git"), { recursive: true });
  await fs.mkdir(nestedWorkdir, { recursive: true });
  const records = [
    {
      timestamp: "2026-06-22T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "child",
        parent_thread_id: "parent",
        cwd: "/workspace/parent",
        thread_source: "subagent",
      },
    },
    { timestamp: "2026-06-22T00:00:00.001Z", type: "event_msg", payload: { type: "task_started" } },
    {
      timestamp: "2026-06-22T00:00:00.002Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "parent prompt" }] },
    },
    {
      timestamp: "2026-06-22T00:00:00.003Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "parent answer" }] },
    },
    { timestamp: "2026-06-22T00:00:01.000Z", type: "event_msg", payload: { type: "task_started" } },
    {
      timestamp: "2026-06-22T00:00:01.001Z",
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "subagent bootstrap" }] },
    },
    {
      timestamp: "2026-06-22T00:00:01.002Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: `const r = await tools.exec_command({cmd:"pwd",workdir:"${tempDir}"});`,
      },
    },
    {
      timestamp: "2026-06-22T00:00:01.003Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: `const r = await tools.exec_command({cmd:"pwd",workdir:"${nestedWorkdir}"});`,
      },
    },
    {
      timestamp: "2026-06-22T00:00:01.004Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: `const r = await tools.exec_command({"cmd":"pwd","workdir":"${worktree}"});`,
      },
    },
    {
      timestamp: "2026-06-22T00:00:01.005Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: `const r = await tools.exec_command({cmd:"pwd",workdir:"${tempDir}"});`,
      },
    },
    {
      timestamp: "2026-06-22T00:00:01.006Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: `const r = await tools.exec_command({cmd:"pwd",workdir:"${tempDir}"});`,
      },
    },
    {
      timestamp: "2026-06-22T00:00:02.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "child answer" }] },
    },
  ];
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  const result = await createReaders().readSessionMessagesFromRolloutFile(filePath, { limit: null });

  assert.equal(result.isSubagent, true);
  assert.equal(result.parentSessionId, "parent");
  assert.equal(result.workingDirectory, worktree);
  assert.deepEqual(result.messages.map((message) => ({
    content: message.content,
    inheritedFromParent: message.inheritedFromParent === true,
  })), [
    { content: "parent prompt", inheritedFromParent: true },
    { content: "parent answer", inheritedFromParent: true },
    { content: "", inheritedFromParent: false },
    { content: "", inheritedFromParent: false },
    { content: "", inheritedFromParent: false },
    { content: "", inheritedFromParent: false },
    { content: "", inheritedFromParent: false },
    { content: "child answer", inheritedFromParent: false },
  ]);
});

function messageRecord(index, role = index % 2 ? "assistant" : "user") {
  return {
    timestamp: `2026-07-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    type: "response_item",
    payload: {
      type: "message",
      id: `msg-${index}`,
      role,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text: `message-${index}` }],
    },
  };
}

test("reads ten visible rows at a time with an opaque backward cursor", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-page-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    ...Array.from({ length: 25 }, (_, index) => messageRecord(index + 1)),
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);
  const readers = createReaders();

  const newest = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 10,
  });
  const middle = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 10,
    cursor: newest.olderCursor,
  });
  const oldest = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 10,
    cursor: middle.olderCursor,
  });

  assert.deepEqual(newest.messages.map((item) => item.content), Array.from({ length: 10 }, (_, i) => `message-${i + 16}`));
  assert.deepEqual(middle.messages.map((item) => item.content), Array.from({ length: 10 }, (_, i) => `message-${i + 6}`));
  assert.deepEqual(oldest.messages.map((item) => item.content), Array.from({ length: 5 }, (_, i) => `message-${i + 1}`));
  assert.equal(oldest.olderCursor, null);
  assert.deepEqual(newest.messages.map((item) => item.itemId), Array.from({ length: 10 }, (_, i) => `msg-${i + 16}`));
});

test("keeps an issued older cursor valid after the rollout is appended", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-append-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    ...Array.from({ length: 12 }, (_, index) => messageRecord(index + 1)),
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);
  const readers = createReaders();
  const newest = await readers.readSessionMessagesFromRolloutFile(filePath, { sessionId: "thread-1", limit: 10 });
  await fs.appendFile(filePath, `${JSON.stringify(messageRecord(30))}\n`);

  const older = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 10,
    cursor: newest.olderCursor,
  });
  assert.deepEqual(older.messages.map((item) => item.content), ["message-1", "message-2"]);
});

test("does not advertise an older page when exactly ten visible rows exist", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-exact-page-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    ...Array.from({ length: 10 }, (_, index) => messageRecord(index + 1)),
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);

  const page = await createReaders().readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 10,
  });

  assert.equal(page.messages.length, 10);
  assert.equal(page.olderCursor, null);
});

test("returns command rows without returning command output bodies", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-command-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const hugeOutput = "x".repeat(400 * 1024);
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    messageRecord(1, "user"),
    {
      timestamp: "2026-07-01T00:00:02.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: { cmd: "npm test" } },
    },
    {
      timestamp: "2026-07-01T00:00:03.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: hugeOutput },
    },
    messageRecord(4, "assistant"),
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);
  const originalParse = JSON.parse;
  JSON.parse = (value, ...args) => {
    assert.ok(String(value).length < 300 * 1024, "oversized output must not be passed to JSON.parse");
    return originalParse(value, ...args);
  };
  t.after(() => { JSON.parse = originalParse; });

  const page = await createReaders().readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 10,
  });
  const command = page.messages.find((item) => item.commandExecution);
  assert.deepEqual(command?.commandExecution, {
    command: "npm test",
    status: "completed",
    exitCode: null,
  });
  assert.equal(JSON.stringify(page).includes(hugeOutput.slice(0, 100)), false);
  assert.equal(page.diagnostics.oversizedLineCount, 1);
});

test("rejects a cursor for another session or a replaced rollout", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-stale-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    ...Array.from({ length: 12 }, (_, index) => messageRecord(index + 1)),
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);
  const readers = createReaders();
  const page = await readers.readSessionMessagesFromRolloutFile(filePath, { sessionId: "thread-1", limit: 10 });
  await assert.rejects(
    readers.readSessionMessagesFromRolloutFile(filePath, {
      sessionId: "thread-2",
      limit: 10,
      cursor: page.olderCursor,
    }),
    /履歴カーソルが無効/
  );
  const replacement = path.join(tempDir, "replacement.jsonl");
  await fs.writeFile(replacement, `${records.map(JSON.stringify).join("\n")}\n`);
  await fs.rename(replacement, filePath);
  await assert.rejects(
    readers.readSessionMessagesFromRolloutFile(filePath, {
      sessionId: "thread-1",
      limit: 10,
      cursor: page.olderCursor,
    }),
    /履歴が更新された/
  );
});

test("fresh subagent rollout does not mark child messages as inherited", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-fresh-subagent-rollout-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    {
      timestamp: "2026-06-22T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "child", parent_thread_id: "parent", thread_source: "subagent" },
    },
    { timestamp: "2026-06-22T00:00:00.001Z", type: "event_msg", payload: { type: "task_started" } },
    {
      timestamp: "2026-06-22T00:00:00.002Z",
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "bootstrap" }] },
    },
    { timestamp: "2026-06-22T00:00:00.003Z", type: "inter_agent_communication", payload: {} },
    {
      timestamp: "2026-06-22T00:00:00.004Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "child task" }] },
    },
    {
      timestamp: "2026-06-22T00:00:00.005Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "child answer" }] },
    },
  ];
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  const result = await createReaders().readSessionMessagesFromRolloutFile(filePath, { limit: null });

  assert.deepEqual(result.messages.map((message) => ({
    content: message.content,
    inheritedFromParent: message.inheritedFromParent === true,
  })), [
    { content: "child task", inheritedFromParent: false },
    { content: "child answer", inheritedFromParent: false },
  ]);
});

test("finds a subagent child boundary beyond the old bounded head window", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-deep-subagent-boundary-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    {
      timestamp: "2026-06-22T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "child", parent_thread_id: "parent", thread_source: "subagent" },
    },
    { timestamp: "2026-06-22T00:00:00.001Z", type: "event_msg", payload: { type: "task_started" } },
    {
      timestamp: "2026-06-22T00:00:00.002Z",
      type: "response_item",
      payload: { type: "message", id: "parent", role: "user", content: [{ type: "input_text", text: "parent" }] },
    },
    ...Array.from({ length: 70 }, (_, index) => ({
      timestamp: `2026-06-22T00:00:00.${String(index + 10).padStart(3, "0")}Z`,
      type: "event_msg",
      payload: { type: "reasoning", text: "x".repeat(20 * 1024) },
    })),
    { timestamp: "2026-06-22T00:00:01.000Z", type: "event_msg", payload: { type: "task_started" } },
    {
      timestamp: "2026-06-22T00:00:01.001Z",
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "bootstrap" }] },
    },
    {
      timestamp: "2026-06-22T00:00:01.002Z",
      type: "response_item",
      payload: { type: "message", id: "child-message", role: "assistant", content: [{ type: "output_text", text: "child" }] },
    },
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);

  const page = await createReaders().readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "child",
    limit: 10,
  });

  assert.deepEqual(page.messages.map((item) => ({ content: item.content, inherited: item.inheritedFromParent === true })), [
    { content: "parent", inherited: true },
    { content: "child", inherited: false },
  ]);
});
