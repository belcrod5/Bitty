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
    sessionMessagesPageSize: 20,
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
      timestamp: "2026-06-22T00:00:00.001Z",
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "parent bootstrap" }] },
    },
    {
      timestamp: "2026-06-22T00:00:00.002Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "parent prompt" }] },
    },
    {
      timestamp: "2026-06-22T00:00:00.002Z",
      type: "event_msg",
      payload: { type: "user_message", message: "parent prompt" },
    },
    {
      timestamp: "2026-06-22T00:00:00.003Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "parent answer" }] },
    },
    {
      timestamp: "2026-06-22T00:00:00.004Z",
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", call_id: "parent-call", arguments: { cmd: "pwd" } },
    },
    { timestamp: "2026-06-22T00:00:01.000Z", type: "event_msg", payload: { type: "task_started" } },
    {
      timestamp: "2026-06-22T00:00:01.001Z",
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "subagent bootstrap" }] },
    },
    { timestamp: "2026-06-22T00:00:01.001Z", type: "inter_agent_communication", payload: {} },
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
    { content: "parent bootstrap", inheritedFromParent: true },
    { content: "parent prompt", inheritedFromParent: true },
    { content: "parent answer", inheritedFromParent: true },
    { content: "", inheritedFromParent: true },
    { content: "subagent bootstrap", inheritedFromParent: false },
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

function messageSequence(count, start = 1) {
  return Array.from({ length: count }, (_, offset) => messageRecord(start + offset)).flatMap((record) => {
    if (record.payload.role !== "user") return [record];
    return [
      record,
      {
        timestamp: record.timestamp,
        type: "event_msg",
        payload: { type: "user_message", message: record.payload.content[0].text },
      },
    ];
  });
}

test("reads twenty visible rows at a time with an opaque backward cursor", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-page-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    ...messageSequence(45),
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);
  const readers = createReaders();

  const newest = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
  });
  const middle = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    cursor: newest.olderCursor,
  });
  const oldest = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    cursor: middle.olderCursor,
  });

  assert.deepEqual(newest.messages.map((item) => item.content), Array.from({ length: 20 }, (_, i) => `message-${i + 26}`));
  assert.deepEqual(middle.messages.map((item) => item.content), Array.from({ length: 20 }, (_, i) => `message-${i + 6}`));
  assert.deepEqual(oldest.messages.map((item) => item.content), Array.from({ length: 5 }, (_, i) => `message-${i + 1}`));
  assert.equal(oldest.olderCursor, null);
  assert.deepEqual(newest.messages.map((item) => item.itemId), Array.from({ length: 20 }, (_, i) => `msg-${i + 26}`));
});

test("returns unpaired Codex messages without modifying their bodies or misclassifying user text", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-internal-context-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    {
      timestamp: "2026-07-01T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "goal-1",
        content: [{ type: "input_text", text: '<codex_internal_context source="goal">goal body</codex_internal_context>' }],
      },
    },
    { timestamp: "2026-07-01T00:00:01.250Z", type: "world_state", payload: {} },
    {
      timestamp: "2026-07-01T00:00:01.500Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "user-1",
        content: [{ type: "input_text", text: "<foo>user supplied</foo>" }],
      },
    },
    {
      timestamp: "2026-07-01T00:00:01.500Z",
      type: "event_msg",
      payload: { type: "user_message", message: "<foo>user supplied</foo>" },
    },
    {
      timestamp: "2026-07-01T00:00:01.750Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "environment-1",
        content: [{ type: "input_text", text: "<environment_context>environment body</environment_context>" }],
      },
    },
    { timestamp: "2026-07-01T00:00:01.800Z", type: "world_state", payload: {} },
    {
      timestamp: "2026-07-01T00:00:01.875Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "bootstrap-1",
        content: [
          { type: "input_text", text: "<recommended_plugins>plugins body</recommended_plugins>" },
          { type: "input_text", text: "# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>" },
          { type: "input_text", text: "<environment_context>environment body</environment_context>" },
        ],
      },
    },
    { timestamp: "2026-07-01T00:00:01.900Z", type: "world_state", payload: {} },
    messageRecord(2, "assistant"),
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);

  const page = await createReaders().readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 10,
  });

  assert.deepEqual(page.messages.map((item) => ({
    role: item.role,
    content: item.content,
    kind: item.kind,
    itemId: item.itemId,
  })), [
    {
      role: "assistant",
      content: '<codex_internal_context source="goal">goal body</codex_internal_context>',
      kind: "unclassified_context",
      itemId: "goal-1",
    },
    {
      role: "user",
      content: "<foo>user supplied</foo>",
      kind: undefined,
      itemId: "user-1",
    },
    {
      role: "assistant",
      content: "<environment_context>environment body</environment_context>",
      kind: "unclassified_context",
      itemId: "environment-1",
    },
    {
      role: "assistant",
      content: "<recommended_plugins>plugins body</recommended_plugins>\n\n# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>\n\n<environment_context>environment body</environment_context>",
      kind: "unclassified_context",
      itemId: "bootstrap-1",
    },
    { role: "assistant", content: "message-2", kind: undefined, itemId: "msg-2" },
  ]);
});

test("shows an unmatched user response at EOF as unclassified without modifying its body", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-writing-user-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    {
      timestamp: "2026-07-01T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "user-writing",
        content: [{ type: "input_text", text: "<foo>still writing</foo>" }],
      },
    },
  ];
  await fs.writeFile(filePath, records.map(JSON.stringify).join("\n"));

  const page = await createReaders().readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
  });

  assert.deepEqual(page.messages.map((item) => ({
    role: item.role,
    content: item.content,
    kind: item.kind,
  })), [
    { role: "assistant", content: "<foo>still writing</foo>", kind: "unclassified_context" },
  ]);
});

test("pairs user response and event in either order across non-message records", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-pair-order-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    {
      timestamp: "2026-07-01T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "event first" },
    },
    { timestamp: "2026-07-01T00:00:01.100Z", type: "world_state", payload: {} },
    {
      timestamp: "2026-07-01T00:00:01.200Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "event-first-response",
        content: [{ type: "input_text", text: "event first" }],
      },
    },
    {
      timestamp: "2026-07-01T00:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "response-first-response",
        content: [{ type: "input_text", text: "response first" }],
      },
    },
    { timestamp: "2026-07-01T00:00:02.100Z", type: "world_state", payload: {} },
    {
      timestamp: "2026-07-01T00:00:02.200Z",
      type: "event_msg",
      payload: { type: "user_message", message: "response first" },
    },
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);

  const page = await createReaders().readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
  });

  assert.deepEqual(page.messages.map((item) => ({
    role: item.role,
    content: item.content,
    kind: item.kind,
    itemId: item.itemId,
  })), [
    { role: "user", content: "event first", kind: undefined, itemId: "event-first-response" },
    { role: "user", content: "response first", kind: undefined, itemId: "response-first-response" },
  ]);
});

test("keeps both records visible when another visible message makes a pair ambiguous", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-ambiguous-pair-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    {
      timestamp: "2026-07-01T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "ambiguous-response",
        content: [{ type: "input_text", text: "same body" }],
      },
    },
    messageRecord(2, "assistant"),
    {
      timestamp: "2026-07-01T00:00:03.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "same body" },
    },
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);

  const page = await createReaders().readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
  });

  assert.deepEqual(page.messages.map((item) => ({
    role: item.role,
    content: item.content,
    kind: item.kind,
  })), [
    { role: "assistant", content: "same body", kind: "unclassified_context" },
    { role: "assistant", content: "message-2", kind: undefined },
    { role: "user", content: "same body", kind: undefined },
  ]);
});

test("does not lose an event-only user message across a page boundary", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-event-only-page-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    ...Array.from({ length: 10 }, (_, index) => messageRecord(index + 1, "assistant")),
    {
      timestamp: "2026-07-01T00:00:11.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "event only" },
    },
    ...Array.from({ length: 20 }, (_, index) => messageRecord(index + 12, "assistant")),
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);
  const readers = createReaders();

  const newest = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
  });
  const older = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    cursor: newest.olderCursor,
  });
  const combined = [...older.messages, ...newest.messages];

  assert.equal(combined.filter((item) => item.content === "event only").length, 1);
  assert.equal(combined.find((item) => item.content === "event only")?.role, "user");
});

test("keeps a reversed non-adjacent pair intact at a page boundary", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-pair-page-boundary-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    ...Array.from({ length: 5 }, (_, index) => messageRecord(index + 1, "assistant")),
    {
      timestamp: "2026-07-01T00:00:06.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "boundary pair" },
    },
    { timestamp: "2026-07-01T00:00:06.100Z", type: "world_state", payload: {} },
    {
      timestamp: "2026-07-01T00:00:06.200Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "boundary-response",
        content: [{ type: "input_text", text: "boundary pair" }],
      },
    },
    ...Array.from({ length: 20 }, (_, index) => messageRecord(index + 7, "assistant")),
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);
  const readers = createReaders();

  const newest = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
  });
  const older = await readers.readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
    cursor: newest.olderCursor,
  });
  const combined = [...older.messages, ...newest.messages];

  assert.deepEqual(combined.filter((item) => item.content === "boundary pair").map((item) => ({
    role: item.role,
    kind: item.kind,
    itemId: item.itemId,
  })), [
    { role: "user", kind: undefined, itemId: "boundary-response" },
  ]);
});

test("uses user_message events instead of injected response items for the session summary", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-summary-user-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    {
      timestamp: "2026-07-01T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>internal</environment_context>" }],
      },
    },
    { timestamp: "2026-07-01T00:00:01.250Z", type: "world_state", payload: {} },
    {
      timestamp: "2026-07-01T00:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "actual prompt" }],
      },
    },
    {
      timestamp: "2026-07-01T00:00:02.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "actual prompt" },
    },
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);

  const summary = await createReaders().readCliSessionSummaryFromRolloutFile(filePath);

  assert.equal(summary.firstUserMessage, "actual prompt");
});

test("keeps an issued older cursor valid after the rollout is appended", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-append-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    ...messageSequence(12),
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

test("does not advertise an older page when exactly twenty visible rows exist", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-exact-page-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    ...messageSequence(20),
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);

  const page = await createReaders().readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 20,
  });

  assert.equal(page.messages.length, 20);
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
      timestamp: "2026-07-01T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "message-1" },
    },
    {
      timestamp: "2026-07-01T00:00:02.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: { cmd: "npm test" } },
    },
    {
      timestamp: "2026-07-01T00:00:03.000Z",
      type: "response_item",
      payload: { output: hugeOutput, call_id: "call-1", type: "function_call_output" },
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

test("shows a placeholder instead of silently dropping an oversized message", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-oversized-message-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const hugeMessage = "x".repeat(300 * 1024);
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    {
      timestamp: "2026-07-01T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "huge-message",
        role: "user",
        content: [{ type: "input_text", text: hugeMessage }],
      },
    },
    {
      timestamp: "2026-07-01T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: hugeMessage },
    },
  ];
  await fs.writeFile(filePath, `${records.map(JSON.stringify).join("\n")}\n`);

  const page = await createReaders().readSessionMessagesFromRolloutFile(filePath, {
    sessionId: "thread-1",
    limit: 10,
  });

  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].role, "assistant");
  assert.equal(page.messages[0].kind, "unclassified_context");
  assert.match(page.messages[0].content, /大きな履歴メッセージ/);
  assert.equal(page.messages[0].content.includes("x".repeat(100)), false);
  assert.equal(page.diagnostics.oversizedMessageCount, 2);
});

test("rejects a cursor for another session or a replaced rollout", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-stale-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "rollout.jsonl");
  const records = [
    { timestamp: "2026-07-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1" } },
    ...messageSequence(12),
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
      timestamp: "2026-06-22T00:00:00.004Z",
      type: "event_msg",
      payload: { type: "user_message", message: "child task" },
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
    { content: "bootstrap", inheritedFromParent: false },
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
    { timestamp: "2026-06-22T00:00:01.001Z", type: "inter_agent_communication", payload: {} },
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
    { content: "bootstrap", inherited: false },
    { content: "child", inherited: false },
  ]);
});
