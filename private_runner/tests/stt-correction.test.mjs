import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSttCorrectionService, createSttCorrectionHttpHandler } from "../src/stt-correction.mjs";

function fakeClient(answer = { changed: true, text: "補正した文章" }, { tool = false, hold = false } = {}) {
  const calls = [];
  let listener = () => {};
  let closeCount = 0;
  let resolveCompletion = () => {};
  return {
    calls,
    get closeCount() { return closeCount; },
    openPromise: Promise.resolve(),
    notify() {},
    close() { closeCount += 1; resolveCompletion(); },
    addNotificationListener(next) { listener = next; return () => { listener = () => {}; }; },
    addServerRequestHandler() { return () => {}; },
    waitForTurnCompletion() { return { promise: hold ? new Promise((resolve) => { resolveCompletion = resolve; })
      : Promise.resolve(), expect() {} }; },
    async request(method, params) {
      calls.push({ method, params });
      if (method === "config/read") return { config: { mcp_servers: { connected: { enabled: true } } } };
      if (method === "thread/start") return { thread: { id: "scratch-thread", ephemeral: true } };
      if (method === "mcpServerStatus/list") return { data: [{ runtimeStatus: "disabled",
        tools: {}, resources: [], resourceTemplates: [] }], nextCursor: null };
      if (method === "turn/start") {
        if (hold) return { turn: { id: "scratch-turn" } };
        listener("item/completed", { threadId: "other-thread", turnId: "other-turn",
          item: { type: "agentMessage", text: "unrelated" } });
        listener("item/completed", { threadId: "scratch-thread",
          item: { type: "agentMessage", phase: "commentary", text: "working" } });
        listener("item/completed", { threadId: "scratch-thread", item: { type: "reasoning" } });
        if (tool) listener("item/started", { threadId: "scratch-thread", item: { type: "commandExecution" } });
        listener("item/completed", { threadId: "scratch-thread",
          item: { type: "agentMessage", phase: "final_answer", text: JSON.stringify(answer) } });
        listener("turn/completed", { threadId: "scratch-thread", status: "completed" });
        return { turn: { id: "scratch-turn" } };
      }
      if (method === "model/list") return { data: [{ model: "gpt-6-luna", displayName: "Luna",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: null };
      return {};
    },
  };
}

test("corrects with isolated ephemeral turn, structured output, and bounded untrusted context", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-stt-correction-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = fakeClient();
  const service = createSttCorrectionService({ createClient: () => client,
    settings: { getCorrection: async () => ({ model: "gpt-6-luna", effort: "low" }) },
    workspaceDirectory: path.join(root, "scratch") });
  assert.deepEqual(await service.correct({ text: "元の文章", context: [{ role: "assistant", text: "会話の文脈" }] }),
    { changed: true, text: "補正した文章" });
  const thread = client.calls.find((call) => call.method === "thread/start").params;
  const turn = client.calls.find((call) => call.method === "turn/start").params;
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.sandbox, "read-only");
  assert.equal(thread.config.mcp_servers.connected.enabled, false);
  assert.equal(thread.config.features.shell_tool, false);
  assert.equal(thread.config.features.hooks, false);
  assert.equal(thread.config.project_doc_max_bytes, 0);
  assert.equal(turn.model, "gpt-6-luna");
  assert.equal(turn.effort, "low");
  assert.equal(turn.approvalPolicy, "never");
  assert.deepEqual(turn.outputSchema.required, ["changed", "text"]);
  assert.deepEqual(JSON.parse(turn.input[0].text), { transcript: "元の文章",
    recentConversation: [{ role: "assistant", text: "会話の文脈" }] });
  assert.ok(client.closeCount);
});

test("returns the exact original when no correction is needed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-stt-correction-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = fakeClient({ changed: false, text: "そのまま" });
  const service = createSttCorrectionService({ createClient: () => client,
    settings: { getCorrection: async () => ({ model: "gpt-6-luna", effort: "low" }) },
    workspaceDirectory: path.join(root, "scratch") });
  assert.deepEqual(await service.correct({ text: "そのまま", context: [] }),
    { changed: false, text: "そのまま" });
});

test("abort interrupts the ephemeral turn and discards a late answer", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-stt-correction-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = fakeClient(undefined, { hold: true });
  const service = createSttCorrectionService({ createClient: () => client,
    settings: { getCorrection: async () => ({ model: "gpt-6-luna", effort: "low" }) },
    workspaceDirectory: path.join(root, "scratch") });
  const controller = new AbortController();
  const result = service.correct({ text: "元", context: [] }, controller.signal);
  while (!client.calls.some((call) => call.method === "turn/start")) await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(result, /correction_turn_failed/);
  assert.deepEqual(client.calls.find((call) => call.method === "turn/interrupt")?.params,
    { threadId: "scratch-thread", turnId: "scratch-turn" });
  assert.ok(client.closeCount);
});

test("abort while turn/start is pending waits for its ID and then interrupts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-stt-correction-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = fakeClient(undefined, { hold: true });
  let resolveStart;
  const request = client.request.bind(client);
  client.request = (method, params) => {
    if (method !== "turn/start") return request(method, params);
    client.calls.push({ method, params });
    return new Promise((resolve) => { resolveStart = resolve; });
  };
  const service = createSttCorrectionService({ createClient: () => client,
    settings: { getCorrection: async () => ({ model: "gpt-6-luna", effort: "low" }) },
    workspaceDirectory: path.join(root, "scratch") });
  const controller = new AbortController();
  const result = service.correct({ text: "元", context: [] }, controller.signal);
  while (!resolveStart) await new Promise(setImmediate);
  controller.abort();
  assert.equal(client.closeCount, 0);
  resolveStart({ turn: { id: "scratch-turn" } });
  await assert.rejects(result, /correction_cancelled/);
  assert.deepEqual(client.calls.find((call) => call.method === "turn/interrupt")?.params,
    { threadId: "scratch-thread", turnId: "scratch-turn" });
  assert.ok(client.closeCount);
});

test("rejects malformed output and tool activity instead of sending guessed text", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-stt-correction-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [answer, options] of [
    [{ changed: false, text: "different" }, {}],
    [{ changed: true, text: "補正" }, { tool: true }],
  ]) {
    const client = fakeClient(answer, options);
    const service = createSttCorrectionService({ createClient: () => client,
      settings: { getCorrection: async () => ({ model: "gpt-6-luna", effort: "low" }) },
      workspaceDirectory: path.join(root, "scratch") });
    await assert.rejects(service.correct({ text: "元", context: [] }));
  }
});

test("correction endpoint authenticates and validates requests", async () => {
  const replies = [];
  const handler = createSttCorrectionHttpHandler({
    service: { correct: async ({ text }) => ({ changed: false, text }), listModels: async () => [] },
    runnerToken: "token", parseAuthToken: (req) => req.token,
    readJsonBody: async (req) => req.body,
    json: (_res, status, body) => replies.push({ status, body }),
  });
  await handler({ method: "POST", token: "wrong" }, {}, "/stt/correct");
  assert.deepEqual(replies.pop(), { status: 401, body: { error: "unauthorized" } });
  await handler({ method: "POST", token: "token", body: { text: "元", context: [] } }, {}, "/stt/correct");
  assert.deepEqual(replies.pop(), { status: 200, body: { changed: false, text: "元" } });
});
