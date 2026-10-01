import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexScheduleService } from "../src/codex-schedule-service.mjs";
import { createVoiceContextService } from "../src/voice-context-service.mjs";
import { createVoiceOrchestratorService } from "../src/voice-orchestrator-service.mjs";

function fakeCodex({ hold = false, failSummary = false, failTurn = false, approval = false } = {}) {
  const calls = [];
  const releases = [];
  const createClient = () => {
    let listener = () => {};
    let resolveCompletion = () => {};
    let summary = false;
    let serverHandler = () => {};
    return {
      openPromise: Promise.resolve(), notify() {}, close() { resolveCompletion(); },
      addNotificationListener(next) { listener = next; return () => { listener = () => {}; }; },
      addServerRequestHandler(handler) { serverHandler = handler; return () => {}; },
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
          if (!summary && failTurn) throw Object.assign(new Error("native turn unavailable"), { code: "backend_unavailable" });
          const turnId = randomUUID();
          const finish = () => {
            listener("item/completed", { threadId: params.threadId, turnId,
              item: { type: "agentMessage", text: `reply:${params.input[0].text}` } });
            listener("turn/completed", { threadId: params.threadId, turnId, turn: { status: "completed" } });
            resolveCompletion();
          };
          if (approval && !summary) {
            setImmediate(() => void serverHandler({ method: "item/commandExecution/requestApproval",
              params: { threadId: params.threadId, turnId, command: "echo test" } }).then((result) => {
                calls.push({ method: "approval.result", result });
                finish();
              }));
          } else if (hold) releases.push(finish);
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
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { rootDir, codex, service: createVoiceOrchestratorService({ rootDir,
    createClient: codex.createClient, getAgentService: options?.getAgentService,
    subjectId: "voice-owner" }) };
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
    if (await check()) return;
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

test("an orchestrator with an outstanding delegated run cannot be deleted", async (t) => {
  let state = "running";
  const agent = { inspectRun: async () => ({ state, actions: [],
    ...(state === "completed" ? { result: { outcome: "completed" } } : {}) }) };
  const { rootDir, codex, service } = await fixture(t, { getAgentService: () => agent });
  await service.open("main");
  const child = await service.create("委任中");
  await fs.writeFile(path.join(rootDir, "subagents.json"), JSON.stringify([{
    orchestratorId: child.id, backendId: "codex", sessionId: "child-session", runId: "run-1",
    clientOperationId: "operation-1", requestHash: "hash-1", request: "do work",
    status: "running", result: "", at: new Date().toISOString(),
  }]));
  const recovered = createVoiceOrchestratorService({ rootDir, createClient: codex.createClient,
    getAgentService: () => agent, subjectId: "voice-owner" });
  await recovered.clearMessages(child.id);
  await assert.rejects(recovered.remove(child.id), { code: "session_busy" });
  state = "unknown";
  await assert.rejects(recovered.remove(child.id), { code: "session_busy" });
  state = "completed";
  await recovered.remove(child.id);
  assert.equal((await recovered.list()).orchestrators.some((item) => item.id === child.id), false);
});

test("an interrupted subagent cleanup resumes from the saved registry", async (t) => {
  const agent = { inspectRun: async () => ({ state: "completed", actions: [],
    result: { outcome: "completed" } }) };
  const { rootDir, codex, service } = await fixture(t, { getAgentService: () => agent });
  await service.open("main");
  const child = await service.create("完了済み");
  const recordFile = path.join(rootDir, "subagents.json");
  const record = { orchestratorId: child.id, backendId: "codex", sessionId: "child-session",
    runId: "run-1", clientOperationId: "operation-1", requestHash: "hash-1",
    request: "do work", status: "completed", result: "done", at: new Date().toISOString() };
  await fs.writeFile(recordFile, JSON.stringify([record]));
  const recovered = createVoiceOrchestratorService({ rootDir, createClient: codex.createClient,
    getAgentService: () => agent, subjectId: "voice-owner" });
  await recovered.list();
  await fs.rm(recordFile);
  await fs.mkdir(recordFile);
  await assert.rejects(recovered.remove(child.id));
  await fs.rmdir(recordFile);
  assert.equal((await recovered.list()).orchestrators.some((item) => item.id === child.id), false);
  assert.deepEqual(JSON.parse(await fs.readFile(recordFile, "utf8")), []);
});


async function scheduledFixture(t, voice, orchestratorId, rrule = null, onVoiceApproval = async () => "decline") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-schedules-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let current = new Date("2026-09-01T00:00:00.000Z");
  const options = {
    definitionsPath: path.join(directory, "definitions.json"), runtimePath: path.join(directory, "runtime.json"),
    voiceContextService: voice,
    onVoiceApproval,
    validateCwd: async () => { throw new Error("voice must not validate cwd"); },
    parseCodexOptions: () => { throw new Error("voice uses its own model settings"); },
    now: () => new Date(current), scheduleTimer: () => ({ unref() {} }), clearTimer() {},
  };
  const scheduler = createCodexScheduleService(options);
  await scheduler.replaceSchedules({ baseRevision: 0, schedules: [{
    id: "11111111-1111-4111-8111-111111111111", name: "定期調査", enabled: true,
    startLocal: "2026-09-02T09:00:00", timeZone: "Asia/Tokyo", rrule,
    action: { kind: "voice", orchestratorId, prompt: "scheduled request" },
  }] });
  current = new Date("2026-09-02T00:00:00.000Z");
  return { scheduler, options };
}

test("voice schedules use the named orchestrator history and settings after rename, and persist dispatch results", async (t) => {
  const { service, codex } = await fixture(t);
  const item = await service.create("調査担当", "", "another-model", "high", "Research instruction");
  const opened = await service.open(item.id);
  const previous = await turn(service, item.id, opened.logicalConversationId, "previous request");
  await previous.finished;
  const { scheduler, options } = await scheduledFixture(t, service, item.id);
  await service.update(item.id, { name: "改名後", icon: "" });
  await scheduler.evaluate();
  const dispatch = (await scheduler.snapshot()).schedules[0].lastDispatch;
  assert.equal(dispatch.status, "fired");
  assert.equal(dispatch.result.orchestratorId, item.id);
  assert.equal(dispatch.result.logicalConversationId, opened.logicalConversationId);
  await waitFor(() => codex.calls.some((call) => call.method === "turn/start" && call.params.input[0].text === "scheduled request"));
  const call = codex.calls.find((call) => call.method === "turn/start" && call.params.input[0].text === "scheduled request");
  assert.equal(call.params.model, "another-model");
  assert.equal(call.params.effort, "high");
  const threadStart = codex.calls.find((entry) => entry.method === "thread/start" && entry.params.model === "another-model");
  assert.equal(threadStart.params.approvalPolicy, "on-request");
  assert.equal(codex.calls.some((entry) => entry.method === "thread/inject_items"
    && JSON.stringify(entry.params.items).includes("previous request")), true);
  await waitFor(async () => (await service.history(item.id)).messages.some((message) => message.text === "reply:scheduled request"));
  assert.equal((await service.history("main")).messages.length, 0);
  const reloaded = createCodexScheduleService(options);
  assert.deepEqual((await reloaded.snapshot()).schedules[0].lastDispatch, dispatch);
});

test("busy voice schedule occurrences fail without interrupting or retrying and advance recurrence", async (t) => {
  const { service, codex } = await fixture(t, { hold: true });
  const opened = await service.open("main");
  const active = await turn(service, "main", opened.logicalConversationId, "ongoing request");
  await waitFor(() => codex.releases.length > 0);
  const { scheduler } = await scheduledFixture(t, service, "main", "FREQ=DAILY");
  await scheduler.evaluate();
  const schedule = (await scheduler.snapshot()).schedules[0];
  assert.equal(schedule.lastDispatch.status, "failed");
  assert.equal(schedule.lastDispatch.errorCode, "session_busy");
  assert.equal(schedule.nextOccurrenceAt, "2026-09-03T00:00:00.000Z");
  codex.releases.splice(0).forEach((release) => release());
  await active.finished;
  await scheduler.evaluate();
  assert.equal(codex.calls.some((call) => call.method === "turn/start" && call.params.input[0].text === "scheduled request"), false);
});

test("deleted voice schedule targets fail without falling back to main", async (t) => {
  const { service } = await fixture(t);
  const item = await service.create("削除対象");
  const { scheduler } = await scheduledFixture(t, service, item.id);
  await service.remove(item.id);
  const saved = await scheduler.snapshot();
  const definitions = saved.schedules.map(({ nextOccurrenceAt: _next, lastDispatch: _last, ...definition }) => definition);
  // A stale target must not block editing other definitions in the replace-all API.
  await scheduler.replaceSchedules({ baseRevision: saved.revision,
    schedules: definitions.map((definition) => ({ ...definition, name: "改名した予定" })) });
  await scheduler.evaluate();
  const dispatch = (await scheduler.snapshot()).schedules[0].lastDispatch;
  assert.equal(dispatch.status, "failed");
  assert.equal(dispatch.errorCode, "not_found");
  assert.equal((await service.history("main")).messages.length, 0);
  const failed = await scheduler.snapshot();
  await scheduler.replaceSchedules({ baseRevision: failed.revision,
    schedules: definitions.map((definition) => ({ ...definition, enabled: false })) });
  assert.equal((await scheduler.snapshot()).schedules[0].enabled, false);
});

test("voice schedules fail when native startup fails instead of marking accepted work fired", async (t) => {
  const { service } = await fixture(t, { failTurn: true });
  const { scheduler } = await scheduledFixture(t, service, "main");
  await scheduler.evaluate();
  const dispatch = (await scheduler.snapshot()).schedules[0].lastDispatch;
  assert.equal(dispatch.status, "failed");
  assert.equal(dispatch.errorCode, "backend_unavailable");
  assert.equal(dispatch.result, null);
});


test("scheduled voice turns send approvals through the injected existing approval channel", async (t) => {
  const { service, codex } = await fixture(t, { approval: true });
  const requests = [];
  const { scheduler } = await scheduledFixture(t, service, "main", null,
    async (operationId, orchestratorId, request) => {
      requests.push({ operationId, orchestratorId, request });
      return "accept";
    });
  await scheduler.evaluate();
  await waitFor(() => requests.length === 1 && codex.calls.some((call) => call.method === "approval.result"));
  const dispatch = (await scheduler.snapshot()).schedules[0].lastDispatch;
  assert.equal(requests[0].operationId, dispatch.result.clientOperationId);
  assert.equal(requests[0].orchestratorId, "main");
  assert.equal(requests[0].request.method, "item/commandExecution/requestApproval");
  assert.deepEqual(codex.calls.find((call) => call.method === "approval.result").result, { decision: "accept" });
  await waitFor(async () => (await service.history("main")).messages.some((message) => message.text === "reply:scheduled request"));
});
