import assert from "node:assert/strict";
import test from "node:test";
import { createCodexSessionChildrenObserver } from "../src/codex-session-children.mjs";

const spawn = (parent = "parent", child = "child") => ({ threadId: parent, item: {
  type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: parent,
  receiverThreadIds: [child], agentsStates: { [child]: { status: "pendingInit" } },
} });

test("ordinary commands, reasoning and assistant completions never invalidate child lists", async () => {
  const notifications = [];
  let lookups = 0;
  const observe = createCodexSessionChildrenObserver({
    resolveSession: async () => { lookups++; return null; }, onChanged: (parent) => notifications.push(parent),
  });
  for (let i = 0; i < 100; i++) await observe("item/completed", {
    threadId: "parent", item: { id: `item-${i}`, type: ["commandExecution", "reasoning", "agentMessage"][i % 3] },
  });
  assert.deepEqual(notifications, []);
  assert.equal(lookups, 0);
});

test("spawn and child activity invalidate their parent, with repeated states ignored", async () => {
  const notifications = [];
  const observe = createCodexSessionChildrenObserver({ resolveSession: async () => null, onChanged: (parent) => notifications.push(parent) });
  await observe("item/completed", spawn());
  await observe("item/completed", spawn());
  await observe("thread/status/changed", { threadId: "child", status: { type: "active" } });
  await observe("thread/status/changed", { threadId: "child", status: "active" });
  await observe("turn/completed", { threadId: "child" });
  await observe("thread/status/changed", { threadId: "child", status: "idle" });
  assert.deepEqual(notifications, Array.from({ length: 4 }, () => ({ backendId: "codex", nativeSessionId: "parent" })));
});

test("wait and sendInput receivers keep their real parent instead of the caller", async () => {
  const notifications = [];
  const observe = createCodexSessionChildrenObserver({
    resolveSession: async () => ({ parentSessionRef: { backendId: "codex", nativeSessionId: "real-parent" } }),
    onChanged: (parent) => notifications.push(parent),
  });
  for (const tool of ["wait", "sendInput", "closeAgent", "resumeAgent"]) {
    await observe("item/completed", { threadId: "caller", item: { ...spawn().item, tool, senderThreadId: "caller" } });
  }
  assert.deepEqual(notifications, [{ backendId: "codex", nativeSessionId: "real-parent" }]);
});

test("newer child state wins delayed relationship lookup and lookup failures are recoverable", async () => {
  const notifications = [];
  let resolveOld;
  let lookups = 0;
  const observe = createCodexSessionChildrenObserver({
    resolveSession: async () => {
      lookups++;
      if (lookups === 1) return new Promise((resolve) => { resolveOld = resolve; });
      if (lookups === 3) throw new Error("temporarily unavailable");
      return { parentSessionRef: { backendId: "codex", nativeSessionId: "parent" } };
    },
    onChanged: (parent) => notifications.push(parent),
  });
  const old = observe("thread/status/changed", { threadId: "child", status: "active" });
  await observe("thread/status/changed", { threadId: "child", status: "idle" });
  resolveOld({ parentSessionRef: { backendId: "codex", nativeSessionId: "old-parent" } });
  await old;
  assert.deepEqual(notifications, [{ backendId: "codex", nativeSessionId: "parent" }]);
  await assert.rejects(observe("thread/status/changed", { threadId: "another-child", status: "active" }), /temporarily/);
  await observe("thread/status/changed", { threadId: "another-child", status: "active" });
  assert.equal(notifications.length, 2);
});

test("a native child thread relationship is observed independently of its parent's run", async () => {
  const notifications = [];
  const observe = createCodexSessionChildrenObserver({ resolveSession: async () => null, onChanged: (parent) => notifications.push(parent) });
  await observe("thread/started", { thread: { id: "child", parent_thread_id: "parent" } });
  await observe("thread/started", { thread: { id: "ordinary", source: "cli" } });
  assert.deepEqual(notifications, [{ backendId: "codex", nativeSessionId: "parent" }]);
});
