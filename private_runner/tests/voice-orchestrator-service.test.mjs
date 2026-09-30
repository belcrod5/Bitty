import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVoiceContextService } from "../src/voice-context-service.mjs";
import { createVoiceOrchestratorService } from "../src/voice-orchestrator-service.mjs";

function fakeCodex({ hold = false, failSummary = false } = {}) {
  const calls = [];
  const releases = [];
  const createClient = () => {
    let listener = () => {};
    let resolveCompletion = () => {};
    let summary = false;
    return {
      openPromise: Promise.resolve(), notify() {}, close() { resolveCompletion(); },
      addNotificationListener(next) { listener = next; return () => { listener = () => {}; }; },
      addServerRequestHandler() { return () => {}; },
      waitForTurnCompletion() { return { expect() {}, promise: new Promise((resolve) => { resolveCompletion = resolve; }) }; },
      async request(method, params) {
        calls.push({ method, params });
        if (method === "model/list") return { data: [
          { model: "gpt-6-luna", displayName: "Luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
          { model: "another-model", displayName: "Another", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
        ], nextCursor: null };
        if (method === "config/read") return { config: { mcp_servers: {} } };
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null };
        if (method === "thread/start") {
          summary = params.approvalPolicy === "never";
          return { thread: { id: randomUUID(), ephemeral: true } };
        }
        if (method === "turn/start") {
          if (summary && failSummary) throw new Error("summary unavailable");
          const turnId = randomUUID();
          const finish = () => {
            listener("item/completed", { threadId: params.threadId, turnId,
              item: { type: "agentMessage", text: `reply:${params.input[0].text}` } });
            listener("turn/completed", { threadId: params.threadId, turnId, turn: { status: "completed" } });
            resolveCompletion();
          };
          if (hold) releases.push(finish);
          else queueMicrotask(finish);
          return { turn: { id: turnId } };
        }
        return {};
      },
    };
  };
  return { createClient, calls, releases };
}

async function fixture(t, options) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "voice-orchestrators-test-"));
  const rootDir = path.join(temp, "voice_context", "v1");
  const codex = fakeCodex(options);
  t.after(async () => {
    for (const release of codex.releases.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.rm(temp, { recursive: true, force: true });
  });
  return { rootDir, codex, service: createVoiceOrchestratorService({ rootDir, createClient: codex.createClient }) };
}

async function turn(service, orchestratorId, conversationId, text, operationId = randomUUID()) {
  let resolve;
  const finished = new Promise((done) => { resolve = done; });
  const accepted = await service.start({ operationId, payload: { ...(orchestratorId ? { orchestratorId } : {}),
    backendId: "codex", logicalConversationId: conversationId, clientOperationId: operationId,
    input: { blocks: [{ type: "text", text }] } },
  }, resolve, async () => "decline");
  return { accepted, finished, operationId };
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not become true");
}

test("main migration keeps data; each orchestrator injects only its own pairs in one workspace", async (t) => {
  const { rootDir, codex, service } = await fixture(t);
  const legacy = createVoiceContextService({ rootDir, createClient: codex.createClient });
  const main = await legacy.open();
  const old = await turn(legacy, undefined, main.logicalConversationId, "old main");
  assert.equal((await old.finished).status, "completed");
  assert.deepEqual((await service.list()).orchestrators.map(({ id }) => id), ["main"]);
  assert.equal((await service.history("main")).messages[0].text, "old main");
  const created = await service.create("調査");
  await service.update(created.id, { name: "調査改", icon: "", model: "another-model", effort: "high",
    systemInstruction: "Research carefully." });
  assert.equal((await service.getSettings(created.id)).systemInstruction, "Research carefully.");
  assert.equal((await service.getSettings("main")).model, "gpt-6-luna");
  const other = await service.open(created.id);
  assert.notEqual(other.logicalConversationId, main.logicalConversationId);
  const a = await turn(service, created.id, other.logicalConversationId, "other only");
  assert.equal((await a.finished).status, "completed");
  const b = await turn(service, "main", main.logicalConversationId, "main again");
  assert.equal((await b.finished).status, "completed");

  const injections = codex.calls.filter(({ method }) => method === "thread/inject_items");
  assert.equal(injections.length, 1);
  assert.deepEqual(injections[0].params.items.map(({ content }) => content[0].text), ["old main", "reply:old main"]);
  const workspaces = codex.calls.filter(({ method, params }) => method === "thread/start"
    && params.approvalPolicy === "on-request").map(({ params }) => params.cwd);
  assert.equal(new Set(workspaces).size, 1);
  assert.ok(codex.calls.some(({ method, params }) => method === "thread/start"
    && params.approvalPolicy === "on-request" && params.model === "another-model"
    && params.developerInstructions.includes("Research carefully.")));
  const recent = JSON.parse(await fs.readFile(path.join(workspaces[0], "voice-memory", "recent.json"), "utf8"));
  assert.deepEqual(recent.map(({ user }) => user), ["old main", "other only", "main again"]);
  assert.deepEqual((await service.history(created.id)).messages.map(({ text }) => text), ["other only", "reply:other only"]);

  const reloaded = createVoiceOrchestratorService({ rootDir, createClient: codex.createClient });
  assert.equal((await reloaded.open(created.id)).logicalConversationId, other.logicalConversationId);
  assert.equal((await reloaded.history("main")).messages.length, 4);
  await assert.rejects(reloaded.remove("main"), { code: "turn_rejected" });
});

test("deletion and clear preserve shared memory and the main workspace", async (t) => {
  const { rootDir, codex, service } = await fixture(t);
  const main = await service.open("main");
  const other = await service.create("一時");
  const opened = await service.open(other.id);
  const completed = await turn(service, other.id, opened.logicalConversationId, "shared evidence");
  await completed.finished;
  await service.clearMessages(other.id);
  assert.deepEqual((await service.history(other.id)).messages, []);
  await service.remove(other.id);
  const workspace = codex.calls.find(({ method, params }) => method === "thread/start"
    && params.approvalPolicy === "on-request").params.cwd;
  assert.equal((await fs.stat(path.join(workspace, "voice-memory", "recent.json"))).isFile(), true);
  assert.equal((await service.open("main")).logicalConversationId, main.logicalConversationId);
  assert.deepEqual((await service.list()).orchestrators.map(({ id }) => id), ["main"]);
  const recovered = createVoiceOrchestratorService({ rootDir, createClient: codex.createClient });
  assert.deepEqual((await recovered.list()).orchestrators.map(({ id }) => id), ["main"]);
});

test("busy deletion is rejected and operation IDs cannot cross orchestrators", async (t) => {
  const { service, codex } = await fixture(t, { hold: true });
  await service.open("main");
  const other = await service.create("作業中");
  const opened = await service.open(other.id);
  const pending = await turn(service, other.id, opened.logicalConversationId, "working");
  await assert.rejects(service.remove(other.id), { code: "session_busy" });
  await assert.rejects(turn(service, "main", (await service.open("main")).logicalConversationId,
    "reuse", pending.operationId), { code: "operation_conflict" });
  await waitFor(() => codex.releases.length > 0);
  for (const release of codex.releases.splice(0)) release();
  assert.equal((await pending.finished).status, "completed");
  await service.remove(other.id);
});

test("registry recovery after main clear uses the persisted memory stream identity", async (t) => {
  const { rootDir, codex, service } = await fixture(t);
  const main = await service.open("main");
  const completed = await turn(service, "main", main.logicalConversationId, "keep memory");
  await completed.finished;
  await service.clearMessages("main");
  await fs.rm(path.join(rootDir, "orchestrators.json"));
  const recovered = createVoiceOrchestratorService({ rootDir, createClient: codex.createClient });
  assert.deepEqual((await recovered.list()).orchestrators.map(({ id }) => id), ["main"]);
  assert.deepEqual((await recovered.history("main")).messages, []);
});

test("a pending completion reserves the final raw memory slot across contexts", async (t) => {
  const { rootDir, codex, service } = await fixture(t, { hold: true, failSummary: true });
  const legacy = createVoiceContextService({ rootDir, createClient: codex.createClient });
  const main = await legacy.open();
  const events = [];
  for (let pairSeq = 1; pairSeq <= 39; pairSeq++) {
    const clientOperationId = randomUUID();
    const add = (type, extra = {}) => events.push({ seq: events.length + 1, at: new Date().toISOString(),
      clientOperationId, type, ...extra });
    add("accepted", { text: `seed-${pairSeq}` });
    add("dispatching");
    add("native_started", { threadId: randomUUID(), turnId: randomUUID() });
    add("completed", { pairSeq, text: `answer-${pairSeq}` });
  }
  await fs.writeFile(path.join(rootDir, main.logicalConversationId, "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await fs.rm(path.join(path.dirname(rootDir), "workspaces", main.logicalConversationId, "voice-memory"),
    { recursive: true });
  await service.list();
  const other = await service.create("二人目");
  const opened = await service.open(other.id);
  const pending = await turn(service, other.id, opened.logicalConversationId, "last slot");
  await assert.rejects(turn(service, "main", main.logicalConversationId, "too many"), { code: "voice_memory_full" });
  await waitFor(() => codex.releases.length > 0);
  for (const release of codex.releases.splice(0)) release();
  assert.equal((await pending.finished).status, "completed");
  const history = await service.history(other.id);
  assert.deepEqual(history.messages.map(({ text }) => text), ["last slot", "reply:last slot"]);
});

test("a child log's incomplete final line is recovered on restart", async (t) => {
  const { rootDir, codex, service } = await fixture(t);
  await service.open("main");
  const other = await service.create("再開");
  const opened = await service.open(other.id);
  const completed = await turn(service, other.id, opened.logicalConversationId, "before crash");
  await completed.finished;
  const eventFile = path.join(rootDir, "orchestrators", other.id, opened.logicalConversationId, "events.jsonl");
  await fs.appendFile(eventFile, '{"seq":');
  const recovered = createVoiceOrchestratorService({ rootDir, createClient: codex.createClient });
  assert.deepEqual((await recovered.history(other.id)).messages.map(({ text }) => text),
    ["before crash", "reply:before crash"]);
});

test("missing registry with child conversations fails closed", async (t) => {
  const { rootDir, codex, service } = await fixture(t);
  await service.open("main");
  await service.create("保存中");
  await fs.rm(path.join(rootDir, "orchestrators.json"));
  const recovered = createVoiceOrchestratorService({ rootDir, createClient: codex.createClient });
  await assert.rejects(recovered.list(), { code: "voice_store_corrupt" });
});
