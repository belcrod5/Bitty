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
    sessionMessagesDefaultLimit: 100,
    sessionMessagesMaxLimit: 1000,
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
    { content: "tool : exec", inheritedFromParent: false },
    { content: "tool : exec", inheritedFromParent: false },
    { content: "tool : exec", inheritedFromParent: false },
    { content: "tool : exec", inheritedFromParent: false },
    { content: "tool : exec", inheritedFromParent: false },
    { content: "child answer", inheritedFromParent: false },
  ]);
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
