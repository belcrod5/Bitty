import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVoiceContextService } from "../src/voice-context-service.mjs";
import { createVoiceOrchestratorService } from "../src/voice-orchestrator-service.mjs";
import { createVoiceConsultationService } from "../src/voice-consultation-service.mjs";
import { createStreamTtsSegments } from "../src/stream-tts-segments.mjs";
import { openVoiceMemoryStore } from "../src/voice-memory-store.mjs";

// No real App Server/client is imported. Only RPC responses and native events are
// simulated; context lifecycle, filesystem, memory and learning observation are real.
function fakeAppServer({ holdResponses = false, holdSummaries = false, holdOverviews = false, loseResponse = false, replyFor, ephemeralReply, responseEvents, taskCalls = [] } = {}) {
  const calls = [], clientOptions = [], releases = [], eventReleases = [], summaryReleases = [], overviewReleases = [], threads = new Map();
  const createClient = (options) => {
    clientOptions.push(options);
    let listener = () => {}, handler = () => {}, finishWait = () => {};
    const replyThread = (thread, params) => {
      thread.overview = params.developerInstructions?.startsWith("Summarize the entire supplied task checklist");
      thread.readOnly = params.permissions
        ? params.config.permissions[params.permissions].filesystem[":workspace_roots"] === "read"
        : params.sandbox === "read-only";
      return { thread, ...(params.permissions ? {
      activePermissionProfile: { id: params.permissions }, instructionSources: [],
      runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
      sandbox: params.config.permissions[params.permissions].filesystem[":workspace_roots"] === "read"
        ? { type: "readOnly", networkAccess: false }
        : { type: "workspaceWrite", networkAccess: false, writableRoots: [],
          excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      } : {}) };
    };
    return {
      openPromise: Promise.resolve(), notify() {}, close() { finishWait(); },
      addNotificationListener(next) { listener = next; return () => { listener = () => {}; }; },
      addServerRequestHandler(next) { handler = next; return () => { handler = () => {}; }; },
      waitForTurnCompletion() {
        return { expect() {}, promise: new Promise((resolve) => { finishWait = resolve; }) };
      },
      async request(method, params) {
        calls.push({ method, params });
        if (method === "initialize" || method === "thread/inject_items") return {};
        if (method === "model/list") return { data: [{ model: "gpt-6-luna", displayName: "Fake Luna",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: null };
        if (method === "config/read") return { config: { mcp_servers: {} } };
        if (method === "skills/list") return { data: [{ cwd: params.cwds[0], skills: [], errors: [] }] };
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null };
        if (method === "thread/start") {
          const thread = { id: randomUUID(), ephemeral: params.ephemeral, turns: [], status: { type: "idle" } };
          threads.set(thread.id, thread);
          return replyThread(thread, params);
        }
        if (method === "thread/resume") {
          assert.ok(threads.has(params.threadId), "resume must name an existing fake native thread");
          return replyThread(threads.get(params.threadId), params);
        }
        if (method === "thread/read") return { thread: threads.get(params.threadId) };
        if (method === "turn/interrupt") {
          const thread = threads.get(params.threadId);
          const turn = thread?.turns.find((turn) => turn.id === params.turnId);
          if (turn) turn.status = "interrupted";
          if (thread) thread.status = { type: "idle" };
          listener("turn/interrupted", { ...params, turn: { status: "interrupted" } });
          finishWait();
          return {};
        }
        if (method === "turn/start") {
          const thread = threads.get(params.threadId);
          assert.ok(thread);
          const turn = { id: randomUUID(), status: "active",
            items: [{ type: "userMessage", text: params.input[0].text }] };
          thread.turns.push(turn);
          thread.status = { type: "active" };
          if (loseResponse && !thread.ephemeral && !thread.readOnly) {
            loseResponse = false;
            throw new Error("fake turn/start response was lost");
          }
          const finish = async () => {
            if (thread.readOnly && !thread.ephemeral) {
              const id = randomUUID();
              listener("item/started", { threadId: thread.id, turnId: turn.id,
                item: { id, type: "dynamicToolCall", status: "inProgress" } });
              const result = await handler({ method: "item/tool/call", params: {
                threadId: thread.id, turnId: turn.id, callId: id,
                namespace: "task_checklist", tool: "read_task_checklist", arguments: {},
              } });
              assert.equal(result.success, true);
              listener("item/completed", { threadId: thread.id, turnId: turn.id,
                item: { id, type: "dynamicToolCall", status: "completed" } });
            }
            if (!thread.ephemeral && !thread.readOnly && taskCalls.length) for (const action of taskCalls.shift()) {
              const value = await handler({ method: "item/tool/call", params: {
                threadId: thread.id, turnId: turn.id, callId: randomUUID(), namespace: action.namespace || "task_checklist",
                tool: action.tool, arguments: action.arguments || {},
              } });
              calls.push({ method: "fake/taskResult", tool: action.tool, value });
            }
            if (!thread.ephemeral && !thread.readOnly && responseEvents) {
              const events = responseEvents({ params, threadId: thread.id, turnId: turn.id });
              for (const event of events) listener(event.method, { threadId: thread.id, turnId: turn.id, ...event.params });
              if (events.length) await new Promise((resolve) => eventReleases.push(resolve));
            }
            let recent, summary;
            try { const input = JSON.parse(params.input[0].text); recent = input.recent; summary = input.pairs && input.existingMemory; } catch {}
            const text = thread.ephemeral
              ? thread.overview ? "- [ ] Owner shared overview" : recent ? JSON.stringify({ decision: "continue", reason: "fake same topic" })
                : summary ? JSON.stringify({ index: "# Topics\n", topics: [] }) : ephemeralReply || "{}"
              : thread.readOnly ? "checklist read" : replyFor ? replyFor({ params, ownerId: options?.orchestratorId }) : `fake reply:${params.input[0].text}`;
            turn.items.push({ type: "agentMessage", text });
            turn.status = "completed";
            thread.status = { type: "idle" };
            listener("item/completed", { threadId: thread.id, turnId: turn.id,
              item: { id: "answer", type: "agentMessage", phase: "final_answer", text } });
            listener("turn/completed", { threadId: thread.id, turnId: turn.id, turn: { status: "completed" } });
            finishWait();
          };
          if (holdOverviews && thread.overview) overviewReleases.push(finish);
          else if (holdSummaries && thread.ephemeral && params.input[0].text.includes("existingMemory")) summaryReleases.push(finish);
          else if (holdResponses && !thread.ephemeral && !thread.readOnly) releases.push(finish);
          else queueMicrotask(() => void finish());
          return { turn: { id: turn.id } };
        }
        throw new Error(`Unexpected fake RPC: ${method}`);
      },
    };
  };
  return { createClient, calls, clientOptions, releases, eventReleases, summaryReleases, overviewReleases, threads };
}

async function fixture(t, options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-consultation-boundaries-"));
  const rpc = fakeAppServer(options);
  const contexts = [];
  t.after(async () => {
    for (const release of [...rpc.eventReleases.splice(0), ...rpc.releases.splice(0), ...rpc.summaryReleases.splice(0), ...rpc.overviewReleases.splice(0)]) await release();
    for (const context of contexts) await context.close();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const context = (name, extra = {}, factory = createVoiceContextService) => {
    const service = factory({ rootDir: path.join(directory, name), orchestratorId: "main",
      createClient: rpc.createClient, ...extra });
    contexts.push(service);
    return service;
  };
  return { directory, rpc, context, track: (service) => contexts.push(service) };
}

const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const activeAt = (directory, name) => path.join(directory, name, "active.json");
const regularParents = (calls) => calls.filter(({ method, params }) =>
  ["thread/start", "thread/resume"].includes(method) && params.approvalPolicy === "on-request");
async function waitFor(check) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fake turn did not reach the expected boundary");
}
function message(conversation, text, extra = {}, operationId = randomUUID()) {
  return { operationId, payload: { backendId: "codex", logicalConversationId: conversation.logicalConversationId,
    clientOperationId: operationId, input: { blocks: [{ type: "text", text }] }, ...extra } };
}
async function begin(service, conversation, text, extra = {}) {
  let resolve;
  const terminal = new Promise((done) => { resolve = done; });
  let finish;
  const settled = new Promise((done) => { finish = done; });
  const request = message(conversation, text, extra);
  const accepted = await service.start(request, resolve, async () => "decline", { onSettled: finish });
  return { accepted, terminal, settled, request };
}
async function complete(service, conversation, text, extra = {}) {
  const started = await begin(service, conversation, text, extra);
  assert.equal(started.accepted.status, "accepted");
  const result = await started.terminal;
  assert.equal(result.status, "completed", JSON.stringify(result));
  return started;
}

test("existing owner API selects an explicit owner, rejects invalid optional input, and reaches real learning storage", { timeout: 20000 }, async (t) => {
  const { directory, rpc } = await fixture(t);
  const service = createVoiceOrchestratorService({ rootDir: path.join(directory, "owners"), createClient: rpc.createClient });
  const child = await service.create("Synthetic owner B");
  const conversation = await service.open(child.id);
  assert.equal((await service.list()).selectedId, "main");
  for (const extra of [{ conversationKey: "room:test" }, { additionalInstructions: 42 }]) {
    await assert.rejects(service.start(message(conversation, "not sent", { orchestratorId: child.id, ...extra }),
      () => {}, async () => "decline"), { code: "turn_rejected" });
  }
  const before = rpc.calls.length;
  const started = await complete(service, conversation, "ordinary text with labelled peer evidence", { orchestratorId: child.id });
  assert.equal((await service.list()).selectedId, "main");
  const learned = await service.learningStatus(child.id);
  assert.equal(learned.observedThrough, 1);
  assert.equal(learned.pendingCount, 1);
  assert.equal(learned.processedThrough, 0, "no analyzer/model is configured or called");
  const root = path.join(directory, "owners", "orchestrators", child.id);
  const active = await json(path.join(root, "active.json"));
  const events = (await fs.readFile(path.join(root, active.logicalConversationId, "events.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.ok(events.some((event) => event.type === "completed" && event.clientOperationId === started.request.operationId));
  const recent = await json(path.join(root, "workspace", "voice-memory", "recent.json"));
  assert.equal(recent[0].user, "ordinary text with labelled peer evidence");
  const learning = await json(path.join(root, "workspace", "orchestrator-learning", "state.json"));
  assert.equal(learning.pending[0].user, recent[0].user, "text source labels do not change the stored user role");
  const workspace = await fs.realpath(path.join(root, "workspace"));
  assert.ok(regularParents(rpc.calls.slice(before)).every(({ params }) => params.cwd === workspace));
});

test("separate roots separate state, native threads, workspace, settings and real memory together", { timeout: 20000 }, async (t) => {
  const { directory, rpc, context } = await fixture(t);
  const ordinary = context("ordinary"), room = context("room");
  const a = await ordinary.open(), b = await room.open();
  await ordinary.configure("gpt-6-luna", "low", "OWNER_INSTRUCTION");
  await complete(ordinary, a, "normal");
  await complete(room, b, "room");
  const ordinaryState = await json(activeAt(directory, "ordinary"));
  const roomState = await json(activeAt(directory, "room"));
  assert.notEqual(a.logicalConversationId, b.logicalConversationId);
  assert.notEqual(ordinaryState.nativeThreadId, roomState.nativeThreadId);
  assert.notEqual(ordinaryState.memoryConversationId, roomState.memoryConversationId);
  assert.notEqual(await ordinary.getWorkspaceDirectory(), await room.getWorkspaceDirectory());
  assert.notEqual((await ordinary.getSettings()).systemInstruction, (await room.getSettings()).systemInstruction);
  assert.deepEqual((await ordinary.getMemoryStore()).rawPairs.map((pair) => pair.user), ["normal"]);
  assert.deepEqual((await room.getMemoryStore()).rawPairs.map((pair) => pair.user), ["room"]);
  assert.ok(rpc.clientOptions.some((value) => value?.workspaceDirectory === path.join(directory, "room", "workspace")));
});

test("two factories on one root have local busy/settings state, not a shared owner authority", { timeout: 20000 }, async (t) => {
  const { directory, rpc, context } = await fixture(t, { holdResponses: true });
  const first = context("same"), second = context("same");
  const a = await first.open(), b = await second.open();
  assert.equal(a.logicalConversationId, b.logicalConversationId);
  await first.configure("gpt-6-luna", "low", "NEW_OWNER_SETTINGS");
  assert.notEqual((await second.getSettings()).systemInstruction, "NEW_OWNER_SETTINGS", "second closure is stale");
  await second.configure("gpt-6-luna", "low", "STALE_SECOND_WRITER");
  assert.equal((await json(activeAt(directory, "same"))).systemInstruction, "STALE_SECOND_WRITER");
  assert.equal((await first.getSettings()).systemInstruction, "NEW_OWNER_SETTINGS");
  const one = await begin(first, a, "first held request");
  await waitFor(() => rpc.releases.length === 1);
  await assert.rejects(first.start(message(a, "same instance busy"), () => {}, async () => "decline"), { code: "session_busy" });
  const two = await begin(second, b, "second held request");
  await waitFor(() => rpc.releases.length === 2);
  assert.equal(one.accepted.status, "accepted");
  assert.equal(two.accepted.status, "accepted", "duplicating a context bypasses the first instance's inFlight guard");
  // Drain the intentionally unsafe duplicate writers; no success claim is made for their resulting log.
  for (const release of rpc.releases.splice(0)) await release();
  await Promise.all([one.settled, two.settled]);
});

test("independent memory instances on the same files have stale sequence caches and can overwrite each other", { timeout: 20000 }, async (t) => {
  const { context } = await fixture(t);
  const service = context("memory-owner");
  await service.open();
  const first = await service.getMemoryStore();
  const workspace = await service.getWorkspaceDirectory();
  const options = { workspace, conversationId: first.conversationId, eventPairs: [],
    atomicWrite: async (file, content) => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
      const parent = await fs.open(path.dirname(file), "r");
      try { await parent.sync(); } finally { await parent.close(); }
    },
    syncDirectory: async (dir) => {
      const handle = await fs.open(dir, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    },
    ownedDirectory: async (dir) => {
      await fs.mkdir(dir, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
      assert.ok((await fs.lstat(dir)).isDirectory());
      return dir;
    },
  };
  const second = await openVoiceMemoryStore(options);
  const pair = (user) => ({ pairSeq: 1, user, assistant: "answer" });
  await first.appendPair(pair("first writer"));
  assert.equal(second.lastPairSeq, 0, "each instance caches its own highwater");
  await second.appendPair(pair("second writer"));
  assert.equal(first.rawPairs[0].user, "first writer");
  assert.equal((await openVoiceMemoryStore(options)).rawPairs[0].user, "second writer", "real disk was replaced by the stale writer");
  await assert.rejects(first.appendPair({ pairSeq: 3, user: "gap", assistant: "answer" }), /pair gap/);
});

async function ownerFixture(t, options = {}) {
  const fixtureValue = await fixture(t, options);
  const rootDir = path.join(fixtureValue.directory, "owner-service");
  const service = createVoiceOrchestratorService({ rootDir, createClient: fixtureValue.rpc.createClient,
    onCompleted: options.onCompleted });
  fixtureValue.track(service);
  return { ...fixtureValue, rootDir, service };
}

async function ownerTurn(service, id, text, conversationKey, extra = {}) {
  const opened = await service.open(id, conversationKey);
  return complete(service, opened, text, { orchestratorId: id, ...(conversationKey ? { conversationKey } : {}), ...extra });
}

test("production scopes reuse owner resources, isolate normal history, persist per-run instructions and refresh owner settings", { timeout: 20000 }, async (t) => {
  const notifications = [];
  const { rootDir, rpc, service } = await ownerFixture(t, { onCompleted: (value) => notifications.push(value) });
  const key = randomUUID();
  const ordinary = await service.open("main");
  const room = await service.open("main", key);
  await service.configure("main", "gpt-6-luna", "low", "OWNER_POLICY");
  await ownerTurn(service, "main", "normal-1");
  const first = await ownerTurn(service, "main", "room-1", key, { additionalInstructions: "CONSULTATION_FIRST" });
  assert.equal((await first.terminal).conversationKey, key);
  await ownerTurn(service, "main", "room-2", key, { additionalInstructions: "CONSULTATION_SECOND" });
  const parents = regularParents(rpc.calls);
  const firstInstruction = parents.find(({ params }) => params.developerInstructions.includes("CONSULTATION_FIRST"));
  const secondInstruction = parents.find(({ params }) => params.developerInstructions.includes("CONSULTATION_SECOND"));
  assert.ok(firstInstruction); assert.ok(secondInstruction);
  assert.equal(firstInstruction.method, "thread/resume", "existing checklist preflight owns the initial parent");
  assert.doesNotMatch(secondInstruction.params.developerInstructions, /CONSULTATION_FIRST/);
  assert.ok(parents.filter(({ params }) => params.developerInstructions.includes("新しい親セッションでは"))
    .every(({ params }) => !params.developerInstructions.includes("CONSULTATION_")));
  const workspace = await fs.realpath(path.join(rootDir, "workspace"));
  assert.ok(parents.every(({ params }) => params.cwd === workspace));
  const normalState = await json(path.join(rootDir, "active.json"));
  const scopeFile = path.join(rootDir, "scopes", key, "active.json");
  const scopeState = await json(scopeFile);
  assert.equal(normalState.logicalConversationId, ordinary.logicalConversationId);
  assert.notEqual(normalState.nativeThreadId, scopeState.nativeThreadId);
  assert.equal(normalState.memoryConversationId, scopeState.memoryConversationId);
  assert.equal(scopeState.systemInstruction, undefined);
  assert.equal((await service.history("main")).messages.length, 2);
  assert.equal(notifications.length, 1, "scope completion does not generate ordinary chat push notifications");
  assert.equal((await service.list()).selectedId, "main");
  assert.equal((await service.learningStatus("main")).observedThrough, 3);
  assert.equal((await json(path.join(rootDir, "workspace", "voice-memory", "recent.json"))).length, 3);
  await assert.rejects(service.start({ ...first.request, payload: { ...first.request.payload, additionalInstructions: "CHANGED" } },
    () => {}, async () => "decline"), { code: "operation_conflict" });
  await service.configure("main", "gpt-6-luna", "low", "UPDATED_OWNER_POLICY");
  await ownerTurn(service, "main", "room-3", key);
  assert.match(regularParents(rpc.calls).at(-1).params.developerInstructions, /UPDATED_OWNER_POLICY/);
  assert.doesNotMatch(regularParents(rpc.calls).at(-1).params.developerInstructions, /CONSULTATION_/);
  assert.notEqual((await json(scopeFile)).nativeThreadId, scopeState.nativeThreadId);
  const afterSettings = (await json(scopeFile)).nativeThreadId;
  await service.clearMemory("main");
  await ownerTurn(service, "main", "room-after-clear", key);
  assert.notEqual((await json(scopeFile)).nativeThreadId, afterSettings);
  assert.equal((await json(scopeFile)).memoryConversationId, normalState.memoryConversationId);
  const accepted = (await fs.readFile(path.join(rootDir, "scopes", key, room.logicalConversationId, "events.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse).find((event) => event.clientOperationId === first.request.operationId && event.type === "accepted");
  assert.equal(accepted.additionalInstructions, "CONSULTATION_FIRST");
});

test("one owner busy guard covers normal and all scopes, while another owner remains independent", { timeout: 20000 }, async (t) => {
  const { service, rpc } = await ownerFixture(t, { holdResponses: true });
  const child = await service.create("independent owner");
  const key = randomUUID();
  const room = await service.open("main", key);
  const held = await begin(service, room, "held scope", { orchestratorId: "main", conversationKey: key });
  await waitFor(() => rpc.releases.length === 1);
  const normal = await service.open("main");
  await assert.rejects(begin(service, normal, "normal blocked", { orchestratorId: "main" }), { code: "session_busy" });
  const anotherKey = randomUUID(), anotherScope = await service.open("main", anotherKey);
  await assert.rejects(begin(service, anotherScope, "scope blocked", { orchestratorId: "main", conversationKey: anotherKey }), { code: "session_busy" });
  await assert.rejects(service.configure("main", "gpt-6-luna", "low", "changed"), { code: "session_busy" });
  await assert.rejects(service.clearMemory("main"), { code: "session_busy" });
  const sibling = await begin(service, await service.open(child.id), "independent", { orchestratorId: child.id });
  await waitFor(() => rpc.releases.length === 2);
  for (const release of rpc.releases.splice(0)) await release();
  await Promise.all([held.terminal, sibling.terminal]);
});

test("restart recovers scope completed evidence before advancing shared memory and learning highwater", { timeout: 20000 }, async (t) => {
  const { service, rootDir, rpc } = await ownerFixture(t);
  const key = randomUUID();
  await ownerTurn(service, "main", "normal-before");
  const scope = await ownerTurn(service, "main", "scope evidence", key);
  await service.close();
  // Simulate a crash after durable completed/appendPair but before learning.observe.
  const learningFile = path.join(rootDir, "workspace", "orchestrator-learning", "state.json");
  const state = await json(learningFile);
  state.observedThrough = 1; state.pending = state.pending.filter((pair) => pair.pairSeq === 1);
  await fs.writeFile(learningFile, JSON.stringify(state));
  const restarted = createVoiceOrchestratorService({ rootDir, createClient: rpc.createClient });
  t.after(() => restarted.close());
  const learning = await restarted.learningStatus("main");
  assert.equal(learning.observedThrough, 2);
  assert.equal(learning.pendingCount, 2);
  assert.equal(learning.gaps.length, 0);
  assert.equal((await json(learningFile)).pending[1].logicalConversationId,
    scope.request.payload.logicalConversationId);
  await ownerTurn(restarted, "main", "normal-after");
  assert.deepEqual((await json(path.join(rootDir, "workspace", "voice-memory", "recent.json"))).map((pair) => pair.pairSeq), [1, 2, 3]);
  const replay = await restarted.start(scope.request, () => { throw new Error("duplicate completion"); }, async () => "decline");
  assert.equal(replay.status, "completed");
});

test("shared summary runs only under the owner and opening another scope cannot clean its live temp directory", { timeout: 20000 }, async (t) => {
  const { service, rootDir, rpc } = await ownerFixture(t, { holdSummaries: true });
  const key = randomUUID();
  for (let index = 0; index < 11; index++) await ownerTurn(service, "main", `pair-${index}`, index % 2 ? key : undefined);
  await waitFor(() => rpc.summaryReleases.length === 1);
  const liveDirectory = path.join(rootDir, "workspace", "ephemeral-tmp", "summary-abcdef");
  await fs.mkdir(liveDirectory, { recursive: true });
  await fs.writeFile(path.join(liveDirectory, "live"), "owner summary still running");
  await service.open("main", randomUUID());
  assert.equal(await fs.readFile(path.join(liveDirectory, "live"), "utf8"), "owner summary still running");
  assert.equal(rpc.summaryReleases.length, 1);
  await rpc.summaryReleases.shift()();
  await waitFor(async () => {
    const pointer = await fs.readFile(path.join(rootDir, "workspace", "voice-memory", "index.md"), "utf8");
    const id = pointer.match(/generation=([0-9a-f-]{36})/)[1];
    return (await json(path.join(rootDir, "workspace", "voice-memory", "generations", id, "state.json"))).processedThroughPairSeq === 1;
  });
});


test("settings and memory invalidation repair a scope missed by a crash, and archives share the owner's stable workspace identity", { timeout: 20000 }, async (t) => {
  const { service, rootDir, rpc, track } = await ownerFixture(t, { taskCalls: [[], [], [{ tool: "read_completed_checklists" }]] });
  const key = randomUUID();
  await ownerTurn(service, "main", "scope-initial", key);
  const file = path.join(rootDir, "scopes", key, "active.json");
  const stale = await json(file);
  await service.configure("main", "gpt-6-luna", "low", "NEW_POLICY");
  await service.clearMemory("main");
  await service.close();
  // Restore the scope file as if the process died after the owner commit but before scope invalidation.
  await fs.writeFile(file, JSON.stringify(stale));
  const restarted = createVoiceOrchestratorService({ rootDir, createClient: rpc.createClient }); track(restarted);
  await restarted.open("main", key);
  assert.equal((await json(file)).sharedOwnerRevision, (await json(path.join(rootDir, "active.json"))).ownerContextRevision);
  assert.ok((await json(file)).pendingSwitch);
  await ownerTurn(restarted, "main", "after-owner-commit", key);
  assert.notEqual((await json(file)).nativeThreadId, stale.nativeThreadId);
  assert.match(regularParents(rpc.calls).at(-1).params.developerInstructions, /NEW_POLICY/);
  const checklist = path.join(rootDir, "workspace", "task-checklists", "main.md");
  await fs.writeFile(checklist, "- [x] Completed real task fixture\n");
  const source = (await restarted.history("main", key)).taskChecklistCompletion;
  await restarted.respondToChecklistCompletion("main", source.sourceHash, source.version, "clear", key);
  const archivesDir = path.join(rootDir, "workspace", "task-checklists", "completed");
  const archive = await json(path.join(archivesDir, (await fs.readdir(archivesDir))[0]));
  assert.equal(archive.workspaceId, (await json(path.join(rootDir, "active.json"))).logicalConversationId);
  // The scope created this archive; a normal response must be able to read it.
  await ownerTurn(restarted, "main", "read scope archive");
  const read = rpc.calls.filter((call) => call.method === "fake/taskResult" && call.tool === "read_completed_checklists").at(-1);
  assert.equal(read.value.success, true);
});

test("unknown native results keep the owner blocked after onSettled until status reconciliation", { timeout: 20000 }, async (t) => {
  const { service, rpc } = await ownerFixture(t, { loseResponse: true });
  const key = randomUUID();
  const started = await begin(service, await service.open("main", key), "lost response", { orchestratorId: "main", conversationKey: key });
  assert.equal((await started.terminal).status, "unknown");
  await started.settled;
  await assert.rejects(begin(service, await service.open("main"), "blocked", { orchestratorId: "main" }), { code: "session_busy" });
  const scopeState = await service.open("main", key);
  const native = [...rpc.threads.values()].find((thread) => thread.status.type === "active");
  native.status = { type: "idle" }; native.turns.at(-1).status = "completed";
  native.turns.at(-1).items.push({ type: "agentMessage", text: "late native completion" });
  const reconciled = await service.status("main", scopeState.logicalConversationId, started.request.operationId, key);
  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.code, "checklist_read_required", "existing safety does not recover an unverified first-parent reply as completed");
  await ownerTurn(service, "main", "allowed after reconciliation");
});

test("a completed scope journal recovers when memory append failed before learning observation", { timeout: 20000 }, async (t) => {
  const { service, rootDir, rpc, track } = await ownerFixture(t);
  await ownerTurn(service, "main", "before-failure");
  const key = randomUUID(), opened = await service.open("main", key);
  const rename = fs.rename;
  const mock = t.mock.method(fs, "rename", (from, to) => String(to).endsWith("00000001-00000010.jsonl")
    ? Promise.reject(Object.assign(new Error("simulated crash at raw append"), { code: "EIO" })) : rename(from, to));
  const crashed = await begin(service, opened, "durable event before memory", { orchestratorId: "main", conversationKey: key });
  await crashed.settled;
  mock.mock.restore(); await service.close();
  const restarted = createVoiceOrchestratorService({ rootDir, createClient: rpc.createClient }); track(restarted);
  assert.equal((await restarted.learningStatus("main")).pendingCount, 2);
  const pairs = await json(path.join(rootDir, "workspace", "voice-memory", "recent.json"));
  assert.deepEqual(pairs.map((pair) => pair.pairSeq), [1, 2]);
  assert.equal(pairs[1].user, "durable event before memory");
});

async function consultationFixture(t, options) {
  const values = await ownerFixture(t, options);
  const second = await values.service.create("B"), third = await values.service.create("C");
  const controller = createVoiceConsultationService({ rootDir: path.join(values.directory, "rooms"),
    orchestrators: values.service, onSpeech: options?.onSpeech, requestApproval: () => { throw new Error("No approval requested by fake"); },
    requestUserInput: () => { throw new Error("No question requested by fake"); } });
  values.track(controller);
  const room = await controller.create({ participants: ["main", second.id, third.id] });
  return { ...values, controller, room };
}

test("controller drives the real scopes A-B-C-A, delivers differences, and pauses only after same-version passes", { timeout: 20000 }, async (t) => {
  const replies = ["A opinion", "B adopts A", "C adopts B", "A rethinks B+C", "[[PASS]]", "[[PASS]]", "[[PASS]]"];
  const { controller, room, rpc, service } = await consultationFixture(t, { replyFor: () => replies.shift() || "[[PASS]]" });
  await controller.supplement(room.id, { text: "Synthetic team question", messageId: randomUUID() });
  await waitFor(async () => (await controller.get(room.id)).reason === "all_pass");
  const final = await controller.get(room.id);
  assert.equal(final.turns, 7);
  assert.deepEqual(final.steps.map((step) => step.orchestratorId), [...room.participants, ...room.participants, "main"]);
  const inputs = rpc.calls.filter(({ method, params }) => method === "turn/start" && params.input[0].text.startsWith('{"kind":"consultation"'))
    .map(({ params }) => JSON.parse(params.input[0].text));
  assert.deepEqual([...inputs[1].newUserMessages, ...inputs[1].peerMessages].sort((a,b)=>a.seq-b.seq).map((message) => message.text), ["Synthetic team question", "A opinion"]);
  assert.ok(inputs[2].peerMessages.some((message) => message.text === "B adopts A"));
  assert.deepEqual(inputs[0].currentParticipant, { id: "main", name: room.profiles.main.name });
  assert.deepEqual(inputs[0].latestUserResponders, []);
  assert.deepEqual(inputs[1].currentParticipant, { id: room.participants[1], name: "B" });
  assert.deepEqual(inputs[1].latestUserResponders, ["main"]);
  assert.deepEqual(inputs[3].latestUserResponders, room.participants);
  assert.deepEqual(inputs[3].peerMessages.map((message) => message.text), ["B adopts A", "C adopts B"]);
  assert.equal((await service.history("main")).messages.length, 0);
  assert.equal((await service.list()).selectedId, "main");
});

test("supplement during a held response is delivered on later turns without losing cursor or premature all-pass", { timeout: 20000 }, async (t) => {
  const { controller, room, rpc } = await consultationFixture(t, { holdResponses: true, replyFor: () => "[[PASS]]" });
  await controller.supplement(room.id, { text: "Synthetic team question", messageId: randomUUID() });
  await waitFor(() => rpc.releases.length === 1);
  const supplement = "Changed condition while A was thinking";
  await controller.supplement(room.id, { text: supplement, messageId: randomUUID() });
  await rpc.releases.shift()();
  for (let index = 0; index < 3; index++) {
    await waitFor(() => rpc.releases.length === 1);
    await rpc.releases.shift()();
  }
  await waitFor(async () => (await controller.get(room.id)).reason === "all_pass");
  const final = await controller.get(room.id);
  assert.equal(final.turns, 3);
  assert.ok(final.participants.every((id) => final.cursors[id] >= 2));
});

test("stop during owner open suppresses dispatch, and stop between dispatch intent and acceptance interrupts the same operation", { timeout: 20000 }, async (t) => {
  for (const phase of ["open", "start"]) {
    const { service, directory, rpc, track } = await ownerFixture(t, { holdResponses: true });
    const child = await service.create("B");
    let release, entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const interrupts = [];
    const interrupt = service.interrupt.bind(service);
    service.interrupt = (...args) => { interrupts.push(args); return interrupt(...args); };
    const original = service[phase].bind(service);
    let once = true;
    service[phase] = async (...args) => {
      if (once) { once = false; entered(); await gate; }
      return original(...args);
    };
    const controller = createVoiceConsultationService({ rootDir: path.join(directory, `stop-${phase}`), orchestrators: service }); track(controller);
    const room = await controller.create({ question: "Stop race", participants: ["main", child.id] });
    await controller.supplement(room.id, { text: "Stop race", messageId: randomUUID() }); await reached;
    const stopped = await controller.stop(room.id);
    const runId = stopped.run.id;
    release();
    await waitFor(async () => (await controller.get(room.id)).run === null);
    const final = await controller.get(room.id);
    assert.equal(final.state, "stopped");
    assert.equal(final.messages.length, 1);
    const calls = rpc.calls.filter(({ method }) => method === "turn/interrupt");
    if (phase === "open") assert.equal(rpc.calls.filter(({ method }) => method === "turn/start").length, 0);
    else {
      assert.ok(interrupts.filter((args) => args[2] === runId).length >= 2, "stop before acceptance is followed by same-operation cancellation after acceptance");
      assert.ok(["interrupted", "preflight_failed"].includes((await service.status("main", stopped.run.logicalConversationId, runId, room.id)).status));
    }
  }
});

test("known busy retry keeps the exact run and input; a closed controller cannot publish into its replacement", { timeout: 20000 }, async (t) => {
  const { service, directory, rpc, track } = await ownerFixture(t, { holdResponses: true, replyFor: () => "[[PASS]]" });
  const child = await service.create("B");
  const held = await begin(service, await service.open("main"), "ordinary held", { orchestratorId: "main" });
  await waitFor(() => rpc.releases.length === 1);
  const rootDir = path.join(directory, "retry-room");
  const controller = createVoiceConsultationService({ rootDir, orchestrators: service }); track(controller);
  const room = await controller.create({ question: "Retry known busy", participants: ["main", child.id], maxTurns: 1 });
  await controller.supplement(room.id, { text: "Retry known busy", messageId: randomUUID() });
  await waitFor(async () => (await controller.get(room.id)).reason === "session_busy");
  const pending = (await controller.get(room.id)).run;
  assert.equal(pending.dispatched, false);
  await rpc.releases.shift()(); await held.terminal;
  await controller.resume(room.id);
  await waitFor(() => rpc.releases.length === 1);
  assert.equal((await controller.get(room.id)).run.id, pending.id);
  assert.equal((await controller.get(room.id)).run.inputText, pending.inputText);
  await controller.close();
  const replacement = createVoiceConsultationService({ rootDir, orchestrators: service }); track(replacement);
  const before = await replacement.get(room.id);
  await rpc.releases.shift()();
  await waitFor(async () => (await service.status("main", before.run.logicalConversationId, pending.id, room.id)).status === "completed");
  assert.equal((await replacement.get(room.id)).turns, 0, "the old closed controller did not publish late output");
  await assert.rejects(replacement.resume(room.id), /limit reached/);
  assert.equal((await replacement.get(room.id)).turns, 1, "the replacement reconciles the existing operation before checking the limit");
  assert.equal((await replacement.get(room.id)).steps[0].runId, pending.id);
});

test("a reset-confirmed operation resumes the original durable instruction snapshot after controller restart", { timeout: 20000 }, async (t) => {
  const { service, rootDir, directory, rpc, track } = await ownerFixture(t, { replyFor: () => "[[PASS]]" });
  const child = await service.create("B");
  const roomsRoot = path.join(directory, "reset-room");
  const firstController = createVoiceConsultationService({ rootDir: roomsRoot, orchestrators: service }); track(firstController);
  const room = await firstController.create({ question: "Reset snapshot", participants: ["main", child.id], maxTurns: 1,
    template: "ORIGINAL_CONSULTATION_TEMPLATE" });
  await ownerTurn(service, "main", "prior scope turn", room.id);
  await firstController.close(); await service.close();
  const file = path.join(rootDir, "scopes", room.id, "active.json");
  const state = await json(file); state.nextResetPromptAt = 1; await fs.writeFile(file, JSON.stringify(state));
  const restartedOwner = createVoiceOrchestratorService({ rootDir, createClient: rpc.createClient }); track(restartedOwner);
  const controller = createVoiceConsultationService({ rootDir: roomsRoot, orchestrators: restartedOwner }); track(controller);
  await controller.supplement(room.id, { text: "Reset snapshot", messageId: randomUUID() });
  await waitFor(async () => (await controller.get(room.id)).reason === "confirmation_required");
  const pending = (await controller.get(room.id)).run;
  await controller.confirmReset(room.id, "continue");
  await waitFor(async () => (await controller.get(room.id)).turns === 1);
  assert.equal((await controller.get(room.id)).steps[0].runId, pending.id);
  assert.match(regularParents(rpc.calls).at(-1).params.developerInstructions, /ORIGINAL_CONSULTATION_TEMPLATE/);
});

test("recovery fails closed for a corrupted finite limit and introductions persist outside room snapshots", { timeout: 20000 }, async (t) => {
  const { controller, room, directory, service, track } = await consultationFixture(t);
  await controller.configure(room.id, { template: "NEW_TEMPLATE" });
  await service.update("main", { name: "Main", icon: "", publicIntroduction: "Product owner" });
  const other = await controller.create({ question: "Another consultation", participants: room.participants });
  assert.equal(other.profiles.main.introduction, "Product owner");
  await controller.close();
  const file = path.join(directory, "rooms", `${room.id}.json`), broken = await json(file);
  delete broken.maxTurns; await fs.writeFile(file, JSON.stringify(broken));
  const restarted = createVoiceConsultationService({ rootDir: path.join(directory, "rooms"), orchestrators: service }); track(restarted);
  await assert.rejects(restarted.list(), /Invalid consultation state/);
});

test("persistent room save failures latch closed instead of spinning or starting model turns", { timeout: 20000 }, async (t) => {
  const { service, directory, rpc, track } = await ownerFixture(t);
  const child = await service.create("B");
  let failWrites = false, failures = 0;
  const roomsRoot = path.join(directory, "fault-rooms");
  const controller = createVoiceConsultationService({ rootDir: roomsRoot, orchestrators: service,
    onChanged: (room) => { if (room.state === "running" && room.run === null) failWrites = true; } }); track(controller);
  const room = await controller.create({ question: "Disk fault", participants: ["main", child.id] });
  const open = fs.open;
  const mocked = t.mock.method(fs, "open", (file, ...args) => {
    if (failWrites && String(file).startsWith(path.join(roomsRoot, `${room.id}.json.`))) {
      failures += 1; return Promise.reject(Object.assign(new Error("persistent EIO"), { code: "EIO" }));
    }
    return open(file, ...args);
  });
  await controller.supplement(room.id, { text: "Disk fault", messageId: randomUUID() });
  await waitFor(async () => (await controller.get(room.id)).reason === "storage_unavailable");
  for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures, 1);
  assert.equal(rpc.calls.filter(({ method }) => method === "turn/start").length, 0);
  await assert.rejects(controller.resume(room.id), { code: "consultation_storage_unavailable" });
  mocked.mock.restore();
});

test("normal clear retains its existing confirmation-cancellation behavior, while shared task approval cannot cross an active scope", { timeout: 20000 }, async (t) => {
  const { service, rootDir, rpc, track } = await ownerFixture(t, { holdResponses: true });
  await service.open("main"); await service.close();
  const activeFile = path.join(rootDir, "active.json");
  const state = await json(activeFile);
  state.turnSeq = 1;
  state.pendingConfirmation = { clientOperationId: randomUUID(), text: "pending reset", turnSeq: 1, parentGeneration: 0 };
  await fs.writeFile(activeFile, JSON.stringify(state));
  const restarted = createVoiceOrchestratorService({ rootDir, createClient: rpc.createClient }); track(restarted);
  await restarted.clearMemory("main");
  assert.equal((await json(activeFile)).pendingConfirmation, undefined);
  const key = randomUUID();
  const held = await begin(restarted, await restarted.open("main", key), "scope active", { orchestratorId: "main", conversationKey: key });
  await waitFor(() => rpc.releases.length === 1);
  await fs.writeFile(path.join(rootDir, "workspace", "task-checklists", "main.md"), "- [x] Shared completion\n");
  const completion = (await restarted.history("main")).taskChecklistCompletion;
  await assert.rejects(restarted.respondToChecklistCompletion("main", completion.sourceHash, completion.version, "clear"), { code: "session_busy" });
  assert.equal(await fs.readFile(path.join(rootDir, "workspace", "task-checklists", "main.md"), "utf8"), "- [x] Shared completion\n");
  await rpc.releases.shift()(); await held.terminal;
});


test("stop wins over a resume whose operation-status lookup was already in flight", { timeout: 20000 }, async (t) => {
  const { controller, room, service, rpc } = await consultationFixture(t, { holdResponses: true });
  await controller.supplement(room.id, { text: "Resume race", messageId: randomUUID() });
  await waitFor(() => rpc.releases.length === 1);
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { entered = resolve; });
  const status = service.status.bind(service);
  service.status = async (...args) => { entered(); await gate; return status(...args); };
  const resuming = controller.resume(room.id);
  const rejected = assert.rejects(resuming, /Stale resume/);
  await reached;
  await controller.stop(room.id);
  await waitFor(async () => (await controller.get(room.id)).run === null);
  release(); await rejected;
  await waitFor(async () => (await controller.get(room.id)).run === null);
  assert.equal((await controller.get(room.id)).state, "stopped");
  assert.equal((await controller.get(room.id)).turns, 0);
});


test("new scopes reuse the owner's completed and in-flight task overview instead of generating their own", { timeout: 20000 }, async (t) => {
  const taskCalls = [];
  const { service, rootDir, rpc, track } = await ownerFixture(t, { holdOverviews: true, taskCalls });
  await service.open("main");
  await fs.writeFile(path.join(rootDir, "workspace", "task-checklists", "main.md"), "- [ ] Shared task\n");
  await service.close();
  const current = createVoiceOrchestratorService({ rootDir, createClient: rpc.createClient }); track(current);
  await current.open("main");
  await waitFor(() => rpc.overviewReleases.length === 1);
  await rpc.overviewReleases.shift()();
  const cacheFile = path.join(rootDir, "task-checklist-overview.json");
  await waitFor(async () => await fs.stat(cacheFile).then(() => true, () => false));
  const oldHash = (await json(cacheFile)).sourceHash;
  const key = randomUUID();
  await current.open("main", key);
  assert.equal((await current.history("main", key)).taskChecklistOverview.status, "present");
  await new Promise((resolve) => setTimeout(resolve, 350));
  const overviewStarts = () => rpc.calls.filter(({ method, params }) => method === "thread/start"
    && params.developerInstructions?.startsWith("Summarize the entire supplied task checklist")).length;
  assert.equal(overviewStarts(), 1, "same-hash scope open consumes no additional model call");
  taskCalls.push([{ tool: "read_task_checklist" }, { tool: "write_task_checklist", arguments: { markdown: "- [ ] Updated shared task\n" } }]);
  await ownerTurn(current, "main", "update shared task", key);
  await waitFor(() => rpc.overviewReleases.length === 1);
  const secondKey = randomUUID();
  await current.open("main", secondKey);
  assert.equal((await current.history("main", secondKey)).taskChecklistOverview.status, "pending");
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(overviewStarts(), 2, "all scopes share the one in-flight update");
  await rpc.overviewReleases.shift()();
  await waitFor(async () => (await json(cacheFile)).sourceHash !== oldHash);
  await assert.rejects(fs.stat(path.join(rootDir, "scopes", key, "task-checklist-overview.json")), { code: "ENOENT" });
});

test("creation is an empty persisted gathering; only a genuine first send starts the existing owners", { timeout: 20000 }, async (t) => {
  const { controller, room, service, directory, rpc, track } = await consultationFixture(t, { replyFor: () => "[[PASS]]" });
  assert.equal(room.question, ""); assert.deepEqual(room.messages, []); assert.equal(room.deadlineAt, null);
  assert.equal(rpc.calls.filter(({ method }) => method === "turn/start").length, 0);
  await assert.rejects(controller.resume(room.id), /first message/);
  await controller.close();
  const restored = createVoiceConsultationService({ rootDir: path.join(directory, "rooms"), orchestrators: service }); track(restored);
  assert.deepEqual((await restored.get(room.id)).messages, []);
  await service.update("main", { name: "Main", icon: "", publicIntroduction: "公開の新しい担当" });
  await restored.supplement(room.id, { text: "普通の最初のメッセージ", messageId: randomUUID() });
  await waitFor(async () => (await restored.get(room.id)).reason === "all_pass");
  const first = rpc.calls.find(({ method, params }) => method === "turn/start" && params.input[0].text.startsWith('{"kind":"consultation"'));
  assert.equal(JSON.parse(first.params.input[0].text).participants[0].introduction, "公開の新しい担当");
  assert.equal((await restored.get(room.id)).messages[0].text, "普通の最初のメッセージ");
  assert.equal((await service.history("main")).messages.length, 0);
});

test("each new user message resets the finite round once; an older in-flight answer cannot consume its new budget", { timeout: 20000 }, async (t) => {
  const { controller, room, rpc } = await consultationFixture(t, { holdResponses: true, replyFor: () => "意見" });
  await controller.configure(room.id, { template: room.template, maxTurns: 1 });
  await controller.supplement(room.id, { text: "初回", messageId: randomUUID() });
  await waitFor(() => rpc.releases.length === 1);
  const id = randomUUID();
  const newRound = await controller.supplement(room.id, { text: "条件を訂正", messageId: id });
  const replay = await controller.supplement(room.id, { text: "条件を訂正", messageId: id });
  assert.equal(replay.deadlineAt, newRound.deadlineAt); assert.equal(replay.version, newRound.version);
  await rpc.releases.shift()();
  await waitFor(() => rpc.releases.length === 1);
  const next = await controller.get(room.id);
  assert.equal(next.turns, 0); assert.equal(next.run.inputUserSeq, 2);
  assert.equal(next.deadlineAt, newRound.deadlineAt);
  await rpc.releases.shift()();
  await waitFor(async () => (await controller.get(room.id)).reason === "limit");
  assert.equal((await controller.get(room.id)).turns, 1);
  assert.equal((await controller.get(room.id)).deadlineAt, newRound.deadlineAt, "participant speech never resets the deadline");
  await controller.configure(room.id, { template: "新しい会話の依頼", maxTurns: 2 });
  assert.equal((await controller.get(room.id)).turns, 1, "editing settings does not reset the round");
  await controller.supplement(room.id, { text: "もう一つ相談", messageId: randomUUID() });
  await waitFor(() => rpc.releases.length === 1);
  assert.equal((await controller.get(room.id)).turns, 0);
  await controller.stop(room.id);
});

test("scope-only native invitation validates registered IDs, deduplicates and joins after the native turn without a classifier", { timeout: 20000 }, async (t) => {
  const taskCalls = [];
  const { service, directory, rootDir, rpc, track } = await ownerFixture(t, { taskCalls, replyFor: () => "[[PASS]]" });
  const second = await service.create("B"), invited = await service.create("C");
  const controller = createVoiceConsultationService({ rootDir: path.join(directory, "invite"), orchestrators: service }); track(controller);
  const room = await controller.create({ participants: ["main", second.id] });
  const start = service.start.bind(service);
  service.start = (message, done, approval, hooks) => start(message, done, approval, { ...hooks,
    conversationTools: { version: "consultation-controls-v3", definitions: [], call() { throw new Error("No old controls expected"); } } });
  await ownerTurn(service, "main", "old scoped parent before invite capability", room.id);
  service.start = start;
  assert.equal((await json(path.join(rootDir, "scopes", room.id, "active.json"))).nativeConversationToolsVersion, "consultation-controls-v3");
  const oldParent = (await json(path.join(rootDir, "scopes", room.id, "active.json"))).nativeThreadId;
  taskCalls.push([
    { namespace: "consultation", tool: "invite", arguments: { orchestratorId: randomUUID() } },
    { namespace: "consultation", tool: "invite", arguments: { orchestratorId: invited.id } },
    { namespace: "consultation", tool: "invite", arguments: { orchestratorId: invited.id } },
  ]);
  await controller.supplement(room.id, { text: "Cもこの相談内の履歴を共有して呼んでいいよ", messageId: randomUUID() });
  await waitFor(async () => (await controller.get(room.id)).reason === "all_pass");
  const final = await controller.get(room.id);
  assert.deepEqual(final.participants, ["main", second.id, invited.id]);
  assert.equal(final.messages.filter((message) => message.source === "membership").length, 1);
  const toolResults = rpc.calls.filter(({ method }) => method === "fake/taskResult").map(({ value }) => value);
  assert.equal(toolResults[0].success, false);
  assert.equal(JSON.parse(toolResults[1].contentItems[0].text).status, "joining_after_turn");
  assert.equal(JSON.parse(toolResults[2].contentItems[0].text).status, "already_joined_or_pending");
  const scopedParents = regularParents(rpc.calls);
  assert.ok(scopedParents.some(({ params }) => params.dynamicTools?.some((item) => item.name === "consultation"
    && item.tools[0].type === "function")), "capability is actually registered when native parent starts, including preflight");
  assert.ok(scopedParents.every(({ params }) => !params.developerInstructions.includes("proposalId")));
  const inputs = rpc.calls.filter(({ method, params }) => method === "turn/start" && params.input[0].text.startsWith('{"kind":"consultation"'))
    .map(({ params }) => JSON.parse(params.input[0].text));
  assert.equal(inputs[0].inviteCandidates[0].orchestratorId, invited.id);
  assert.ok(inputs[1].participants.some((item) => item.orchestratorId === invited.id));
  assert.ok(inputs[2].peerMessages.some((message) => message.source === "membership"));
  const scopeActive = await json(path.join(rootDir, "scopes", room.id, "active.json"));
  assert.equal(scopeActive.nativeConversationToolsVersion, "consultation-controls-v4");
  assert.notEqual(scopeActive.nativeThreadId, oldParent, "an old scoped parent is safely replaced to register the capability");
  await ownerTurn(service, "main", "ordinary response");
  const ordinaryParent = regularParents(rpc.calls).at(-1);
  assert.equal(ordinaryParent.params.dynamicTools?.some((item) => item.name === "consultation") ?? false, false);
});

test("introduction draft uses only bounded recent history and adopted learning through the existing ephemeral tool-free execution", { timeout: 20000 }, async (t) => {
  let { service, rpc, rootDir, track } = await ownerFixture(t, { ephemeralReply: "直近の相談に基づく公開紹介です。" });
  for (let index = 0; index < 8; index++) await ownerTurn(service, "main", `bounded-history-${index}`);
  const learningFile = path.join(rootDir, "workspace", "orchestrator-learning", "state.json");
  const savedLearning = await json(learningFile);
  const activeId = randomUUID(), candidateId = randomUUID();
  for (const [id, status, content] of [[activeId, "active", "採用済みの得意分野"], [candidateId, "candidate", "未採用の情報"]]) {
    savedLearning.candidates.push({ id, version: 1, status, kind: "preference", content, conditions: "本人の応答",
      reason: "Synthetic learning evidence", scope: { orchestratorId: "main" },
      evidence: [{ ...savedLearning.pending[0], user: undefined, assistant: undefined }], createdAt: new Date().toISOString() });
  }
  await service.close();
  await fs.writeFile(learningFile, JSON.stringify(savedLearning));
  service = createVoiceOrchestratorService({ rootDir, createClient: rpc.createClient }); track(service);
  const before = await service.getSettings("main"), history = await service.history("main");
  await service.update("main", { name: before.name, icon: before.icon, publicIntroduction: "保存済み紹介" });
  const draft = await service.draftIntroduction("main", { model: "gpt-6-luna", effort: "low" });
  assert.equal(draft.introduction, "直近の相談に基づく公開紹介です。");
  assert.equal(draft.historyMessages, 12); assert.equal(draft.memoryIncluded, false); assert.equal(draft.adoptedLearningItems, 1);
  const parent = rpc.calls.findLast(({ method, params }) => method === "thread/start" && params.ephemeral
    && params.developerInstructions.includes("公開紹介の下書き"));
  assert.ok(parent); assert.equal(parent.params.approvalPolicy, "never"); assert.equal(parent.params.dynamicTools, undefined);
  const turn = rpc.calls.findLast(({ method }) => method === "turn/start");
  const evidence = JSON.parse(turn.params.input[0].text);
  assert.equal(evidence.recentConversation.length, 12);
  assert.deepEqual(evidence.adoptedLearning, [{ content: "採用済みの得意分野", conditions: "本人の応答" }]);
  assert.ok(evidence.recentConversation.every((item) => !item.text.includes("bounded-history-0")));
  assert.deepEqual(Object.keys(evidence).sort(), ["adoptedLearning", "name", "recentConversation"]);
  assert.equal((await service.getSettings("main")).publicIntroduction, "保存済み紹介", "generation never saves the draft");
  assert.equal((await service.getSettings("main")).systemInstruction, before.systemInstruction);
  assert.deepEqual((await service.history("main")).messages, history.messages, "draft never becomes a normal chat pair");
  assert.equal((await json(path.join(rootDir, "orchestrators.json"))).orchestrators[0].publicIntroduction, "保存済み紹介");
});


test("lowering a round maximum persists safely, and a stopped unknown turn stays reconcilable after a new user message", { timeout: 20000 }, async (t) => {
  const { controller, room, service, directory, track } = await consultationFixture(t, { replyFor: () => "[[PASS]]" });
  await controller.supplement(room.id, { text: "First round", messageId: randomUUID() });
  await waitFor(async () => (await controller.get(room.id)).reason === "all_pass");
  await controller.configure(room.id, { template: room.template, maxTurns: 1 });
  await controller.close();
  const restored = createVoiceConsultationService({ rootDir: path.join(directory, "rooms"), orchestrators: service }); track(restored);
  assert.equal((await restored.get(room.id)).turns, 3);
  assert.equal((await restored.get(room.id)).maxTurns, 1);
  await restored.close();
  // A previously dispatched unknown operation survived stop. New text must not
  // make the UI permanently running while the driver cannot redispatch it.
  const file = path.join(directory, "rooms", `${room.id}.json`), saved = await json(file);
  saved.state = "stopped"; saved.generation += 1;
  saved.run = { id: randomUUID(), orchestratorId: "main", generation: saved.generation - 1,
    inputVersion: saved.version, inputThroughSeq: 1, inputUserSeq: 1, inputText: "snapshot",
    additionalInstructions: saved.template, dispatched: true, logicalConversationId: randomUUID() };
  await fs.writeFile(file, JSON.stringify(saved));
  const unknown = createVoiceConsultationService({ rootDir: path.join(directory, "rooms"), orchestrators: service }); track(unknown);
  const updated = await unknown.supplement(room.id, { text: "New condition", messageId: randomUUID() });
  assert.equal(updated.state, "paused"); assert.equal(updated.reason, "unknown");
  assert.equal(updated.turns, 0); assert.equal(updated.run.id, saved.run.id);
  assert.equal(updated.messages.at(-1).text, "New condition");
});


test("consultation streams real native evidence for the human, persists it once, and never forwards it to peers", { timeout: 20000 }, async (t) => {
  let once = true;
  const secret = "SYNTHETIC_OWNER_ONLY_TOOL_EVIDENCE";
  const { controller, room, service, directory, rpc, track } = await consultationFixture(t, {
    replyFor: ({params}) => JSON.parse(params.input[0].text).currentParticipantId === "main" && once === false ? "Public conclusion" : "[[PASS]]",
    responseEvents: () => { if (!once) return []; once = false; return [
      { method: "item/started", params: { item: { id: "comment", type: "agentMessage", phase: "commentary" } } },
      { method: "item/agentMessage/delta", params: { itemId: "comment", delta: "Checking a private fixture" } },
      { method: "item/completed", params: { item: { id: "comment", type: "agentMessage", text: "Checking a private fixture" } } },
      { method: "item/started", params: { item: { id: "tool", type: "commandExecution", command: "cat fixture.md" } } },
      { method: "item/commandExecution/outputDelta", params: { itemId: "tool", delta: secret } },
      { method: "item/completed", params: { item: { id: "tool", type: "commandExecution", status: "completed", aggregatedOutput: secret, exitCode: 0 } } },
      { method: "item/completed", params: { item: { id: "search", type: "webSearch", status: "completed", action: { type: "search", query: "synthetic fixture" } } } },
      { method: "item/completed", params: { item: { id: "file", type: "fileChange", status: "completed", changes: [{ path: "fixture.md", diff: secret }] } } },
      { method: "item/completed", params: { item: { id: "agent", type: "collabAgentToolCall", status: "completed", prompt: "Synthetic delegation", agentsStates: { fixture: { status: "completed", message: secret } } } } },
      { method: "item/started", params: { item: { id: "answer", type: "agentMessage", phase: "final_answer" } } },
      { method: "item/agentMessage/delta", params: { itemId: "answer", delta: "Public conclusion" } },
    ]; },
  });
  await controller.configure(room.id, { template: room.template, maxTurns: 4 });
  await controller.supplement(room.id, { text: "Synthetic team request", messageId: randomUUID() });
  await waitFor(() => rpc.eventReleases.length === 1);
  await waitFor(async () => (await controller.get(room.id)).run?.progress?.tools.some((tool) => tool.output === secret));
  const live = await controller.get(room.id);
  assert.equal(live.messages.length, 1, "draft commentary and final deltas are not public before native completion");
  assert.ok(live.run.progress.messages.some((item) => item.phase === "commentary"));
  assert.ok(live.run.progress.messages.some((item) => item.phase === "final_answer"));
  assert.equal((await controller.list()).rooms[0].run.progress.seq, live.run.progress.seq, "reconnect reads the accumulated live snapshot");
  rpc.eventReleases.shift()();
  await waitFor(async () => (await controller.get(room.id)).reason === "limit");
  const completed = await controller.get(room.id);
  assert.equal(completed.messages[1].text, "Public conclusion");
  assert.ok(JSON.stringify(completed.steps[0].trace).includes(secret), "human evidence survives completion");
  assert.ok(completed.steps[0].trace.tools.some((tool) => tool.type === "webSearch" && tool.input.includes("synthetic fixture")));
  assert.ok(completed.steps[0].trace.tools.some((tool) => tool.type === "fileChange" && tool.output.includes(secret)));
  assert.ok(completed.steps[0].trace.tools.some((tool) => tool.type === "collabAgentToolCall" && tool.input === "Synthetic delegation" && tool.output.includes(secret)));
  assert.ok(!JSON.stringify(completed.messages).includes(secret));
  const inputs = rpc.calls.filter(({method,params}) => method === "turn/start" && params.input[0].text.startsWith('{"kind":"consultation"')).map(({params}) => params.input[0].text);
  assert.ok(inputs.every((text) => !text.includes(secret) && !text.includes("Checking a private fixture")));
  const again = JSON.parse(inputs[3]);
  assert.equal(again.turnType, "peer_update"); assert.deepEqual(again.newUserMessages, []);
  assert.equal(again.topic.referenceOnly, true); assert.ok(again.yourPreviousContribution);
  await controller.close();
  const restored = createVoiceConsultationService({ rootDir: path.join(directory,"rooms"), orchestrators: service }); track(restored);
  assert.ok(JSON.stringify((await restored.get(room.id)).steps[0].trace).includes(secret));
  await restored.supplement(room.id, { text: "New genuine instruction", messageId: randomUUID() });
  await waitFor(async () => (await restored.get(room.id)).reason === "limit");
  const allInputs = rpc.calls.filter(({method,params}) => method === "turn/start" && params.input[0].text.startsWith('{"kind":"consultation"')).map(({params}) => params.input[0].text);
  assert.ok(allInputs.every((text) => !text.includes(secret)), "restart uses the same public-only projection");
});

test("a stopped run cannot leak its live evidence into the next run", { timeout: 20000 }, async (t) => {
  let count = 0;
  const { controller, room, service, rpc } = await consultationFixture(t, { responseEvents: () => {
    count += 1;
    return [{ method: "item/started", params: { item: { id: "work", type: "agentMessage", phase: "commentary" } } },
      { method: "item/agentMessage/delta", params: { itemId: "work", delta: `Synthetic work ${count}` } }];
  }, replyFor: () => "[[PASS]]" });
  const hooks = [], start = service.start.bind(service);
  service.start = (...args) => { hooks.push(args[3]); return start(...args); };
  await controller.supplement(room.id, { text: "First request", messageId: randomUUID() });
  await waitFor(async () => (await controller.get(room.id)).run?.progress?.messages.some((item) => item.text === "Synthetic work 1"));
  await controller.stop(room.id);
  await waitFor(async () => (await controller.get(room.id)).run === null);
  await controller.supplement(room.id, { text: "Next request", messageId: randomUUID() });
  await waitFor(async () => (await controller.get(room.id)).run?.progress?.messages.some((item) => item.text === "Synthetic work 2"));
  const current = await controller.get(room.id);
  hooks[0].onText("STALE_OWNER_TRACE", { itemId: "old", phase: "commentary" });
  hooks[0].onToolEvent({ event: "completed", threadId: "old", turnId: "old", item: { id: "old", type: "commandExecution", aggregatedOutput: "STALE_OWNER_TRACE" } });
  const after = await controller.get(room.id);
  assert.equal(after.run.progress.runId, current.run.id);
  assert.ok(!JSON.stringify(after.run.progress).includes("STALE_OWNER_TRACE"));
  assert.ok(!JSON.stringify(after.run.progress).includes("Synthetic work 1"));
  await controller.stop(room.id);
});

test("effective consultation instructions are bounded before dispatch, including legacy editable templates", { timeout: 20000 }, async (t) => {
  const { controller, room, service, directory, rpc, track } = await consultationFixture(t);
  await assert.rejects(controller.create({ participants: room.participants, template: "x".repeat(16000) }), /Invalid consultation/);
  await assert.rejects(controller.configure(room.id, { template: "x".repeat(16000) }), /Invalid consultation/);
  await controller.close();
  const file = path.join(directory, "rooms", `${room.id}.json`), saved = await json(file);
  saved.template = "x".repeat(16000); await fs.writeFile(file, JSON.stringify(saved));
  const restored = createVoiceConsultationService({ rootDir: path.join(directory, "rooms"), orchestrators: service }); track(restored);
  await restored.supplement(room.id, { text: "Synthetic new instruction", messageId: randomUUID() });
  await waitFor(async () => (await restored.get(room.id)).reason === "instructions_too_long");
  assert.equal(rpc.calls.filter(({method}) => method === "turn/start").length, 0);
  assert.equal((await restored.get(room.id)).run, null);
});

test("a native finish request closes only after successful completion and stays ended across reload until a new user message", { timeout: 20000 }, async (t) => {
  const userMessageId = randomUUID(), taskCalls = [[{ namespace: "consultation", tool: "finish", arguments: { userMessageId } }]];
  const { controller, room, rpc, service, directory, track } = await consultationFixture(t, { taskCalls, replyFor: () => "終了します。" });
  await controller.supplement(room.id, { text: "これで相談を終了します", messageId: userMessageId });
  await waitFor(async () => (await controller.get(room.id)).reason === "ended");
  const ended = await controller.get(room.id);
  assert.equal(ended.turns, 1); assert.equal(ended.messages.at(-1).text, "終了します。"); assert.equal(ended.run, null);
  assert.equal(rpc.calls.filter(({method,params}) => method === "turn/start" && params.input[0].text.startsWith('{"kind":"consultation"')).length, 1);
  assert.equal((await controller.stop(room.id)).reason, "ended", "a late stop cannot erase a completed finish");
  await assert.rejects(controller.resume(room.id), /Send a new message/);
  await controller.close();
  const restored = createVoiceConsultationService({ rootDir: path.join(directory,"rooms"), orchestrators: service }); track(restored);
  await assert.rejects(restored.resume(room.id), /Send a new message/);
  await restored.configure(room.id, { template: ended.template, maxTurns: 1 });
  await restored.supplement(room.id, { text: "新しい相談です", messageId: randomUUID() });
  await waitFor(async () => (await restored.get(room.id)).reason === "limit");
});

test("a finish reservation cannot swallow a new user instruction arriving during its native turn", { timeout: 20000 }, async (t) => {
  const userMessageId = randomUUID();
  const { controller, room, rpc } = await consultationFixture(t, {
    taskCalls: [[{ namespace: "consultation", tool: "finish", arguments: { userMessageId } }]], replyFor: () => "承知しました",
    responseEvents: () => [{ method: "item/started", params: { item: { id: "comment", type: "agentMessage", phase: "commentary" } } }],
  });
  await controller.supplement(room.id, { text: "ここで終わります", messageId: userMessageId });
  await waitFor(() => rpc.eventReleases.length === 1);
  const reserved = await controller.get(room.id);
  assert.equal(reserved.run.finishUserMessageId, userMessageId);
  assert.equal(reserved.state, "running");
  const nextId = randomUUID(); await controller.supplement(room.id, { text: "待って、もう一つ確認", messageId: nextId });
  rpc.eventReleases.shift()();
  await waitFor(() => rpc.eventReleases.length === 1);
  const current = await controller.get(room.id);
  assert.equal(current.state, "running"); assert.notEqual(current.reason, "ended");
  assert.equal(JSON.parse(current.run.inputText).newUserMessages.at(-1).id, nextId);
  await controller.stop(room.id);
});

test("finish rejects a peer message and a genuine user message not read by the current run", { timeout: 20000 }, async (t) => {
  const taskCalls = [], { controller, room, rpc } = await consultationFixture(t, { taskCalls, holdResponses: true, replyFor: () => "意見" });
  const first = randomUUID(); await controller.supplement(room.id, { text: "相談を続けます", messageId: first });
  await waitFor(() => rpc.releases.length === 1); await rpc.releases.shift()();
  await waitFor(() => rpc.releases.length === 1);
  const current = await controller.get(room.id), next = randomUUID();
  taskCalls.push([{ namespace: "consultation", tool: "finish", arguments: { userMessageId: current.messages.at(-1).id } },
    { namespace: "consultation", tool: "finish", arguments: { userMessageId: next } }]);
  await controller.supplement(room.id, { text: "新しい指示", messageId: next });
  await rpc.releases.shift()(); await waitFor(() => rpc.releases.length === 1);
  const results = rpc.calls.filter(({method}) => method === "fake/taskResult");
  assert.equal(results.length, 2); assert.ok(results.every(({value}) => value.success === false));
  assert.notEqual((await controller.get(room.id)).reason, "ended"); await controller.stop(room.id);
});

test("a durable finish reservation is recovered by the existing status path, while failed or interrupted turns cannot end a room", { timeout: 20000 }, async (t) => {
  for (const status of ["completed", "failed", "interrupted"]) {
    const userMessageId = randomUUID();
    const { controller, room, rpc, service, directory, track } = await consultationFixture(t, {
      taskCalls: [[{ namespace: "consultation", tool: "finish", arguments: { userMessageId } }]], replyFor: () => "終了します。",
    });
    const original = service.start.bind(service); let terminalResult;
    service.start = (message, _done, ...args) => original(message, (result) => { terminalResult = result; }, ...args);
    await controller.supplement(room.id, { text: "これで終了します", messageId: userMessageId });
    await waitFor(() => terminalResult);
    const pending = await controller.get(room.id);
    assert.equal(pending.run.finishUserMessageId, userMessageId);
    await controller.close();
    const statusOriginal = service.status.bind(service);
    service.status = async (...args) => ({ ...await statusOriginal(...args), status });
    const changes = [];
    const restored = createVoiceConsultationService({ rootDir: path.join(directory,"rooms"), orchestrators: service,
      onChanged: (value) => changes.push(value) }); track(restored);
    if (status === "completed") {
      await assert.rejects(restored.resume(room.id), /Send a new message/);
      assert.equal((await restored.get(room.id)).reason, "ended");
    } else {
      await restored.resume(room.id);
      assert.ok(changes.some((value) => value.state === "paused" && value.reason === status), "failed native status passes through failure settle before retry");
      assert.ok(changes.every((value) => value.reason !== "ended"));
      await restored.stop(room.id);
    }
    if (status === "completed") assert.equal(rpc.calls.filter(({method,params}) => method === "turn/start" && params.input[0].text.startsWith('{"kind":"consultation"')).length, 1);
  }
});

test("latest-user snapshot survives peer updates and replaces an old ending after the room reopens", { timeout: 20000 }, async (t) => {
  const first = randomUUID(), next = randomUUID(), taskCalls = [[{ namespace: "consultation", tool: "finish", arguments: { userMessageId: first } }]];
  const replies = ["Goodbye", "A new opinion", "[[PASS]]", "[[PASS]]", "[[PASS]]"];
  const { controller, room, rpc } = await consultationFixture(t, { taskCalls, replyFor: () => replies.shift() || "[[PASS]]" });
  await controller.supplement(room.id, { text: "Finish this discussion", messageId: first });
  await waitFor(async () => (await controller.get(room.id)).reason === "ended");
  taskCalls.push([{ namespace: "consultation", tool: "finish", arguments: { userMessageId: first } }]);
  await controller.supplement(room.id, { text: "What do the others think?", messageId: next });
  await waitFor(async () => (await controller.get(room.id)).reason === "all_pass");
  const inputs = rpc.calls.filter(({method,params}) => method === "turn/start" && params.input[0].text.startsWith('{"kind":"consultation"'))
    .map(({params}) => JSON.parse(params.input[0].text));
  assert.ok(inputs.slice(1).every((input) => input.latestUserMessage.id === next && input.latestUserMessage.referenceOnly === true));
  assert.equal(inputs.at(-1).turnType, "peer_update"); assert.deepEqual(inputs.at(-1).newUserMessages, []);
  assert.equal(inputs.at(-1).latestUserMessage.text, "What do the others think?");
  assert.equal(inputs.at(-1).topic.text, "Finish this discussion");
  assert.deepEqual(rpc.calls.filter(({method}) => method === "fake/taskResult").map(({value}) => value.success), [true, false]);
  assert.equal((await controller.get(room.id)).turns, 4, "old ending cannot close the new discussion");
});

test("handoff prioritizes the addressed unread participant, stays silent, then resumes ordinary rotation without contaminating ordinary owner tools", { timeout: 20000 }, async (t) => {
  const userMessageId = randomUUID(), taskCalls = [], replies = ["[[PASS]]", "Requested story", "[[PASS]]", "[[PASS]]", "[[PASS]]"];
  const { controller, room, rpc, service } = await consultationFixture(t, { taskCalls, replyFor: ({params}) => params.input[0].text.startsWith('{"kind":"consultation"') ? replies.shift() || "[[PASS]]" : "Ordinary reply" });
  await ownerTurn(service, "main", "Ordinary before");
  const before = regularParents(rpc.calls).length;
  taskCalls.push([{ namespace: "consultation", tool: "handoff", arguments: { orchestratorId: room.participants[2], userMessageId } }]);
  await controller.supplement(room.id, { text: "C, write a story. Everyone else stay quiet.", messageId: userMessageId });
  await waitFor(async () => (await controller.get(room.id)).reason === "all_pass");
  const completed = await controller.get(room.id);
  assert.deepEqual(completed.steps.map((step) => step.orchestratorId), ["main", room.participants[2], "main", room.participants[1], room.participants[2]]);
  assert.deepEqual(completed.messages.filter((item) => item.source === "participant").map((item) => [item.speakerId, item.text]), [[room.participants[2], "Requested story"]]);
  const inputs = rpc.calls.filter(({method,params}) => method === "turn/start" && params.input[0].text.startsWith('{"kind":"consultation"')).map(({params}) => JSON.parse(params.input[0].text));
  assert.ok(inputs[0].handoffCandidates.includes(room.participants[2]));
  assert.ok(!inputs[2].handoffCandidates.includes(room.participants[2]), "already consumed request cannot be handed back");
  assert.equal(inputs[2].latestUserMessage.id, userMessageId); assert.deepEqual(inputs[2].newUserMessages, []);
  const through = regularParents(rpc.calls).length;
  await ownerTurn(service, "main", "Ordinary after");
  const parents = regularParents(rpc.calls), normal = [...parents.slice(0, before), ...parents.slice(through)];
  assert.ok(normal.length >= 2);
  assert.ok(normal.every(({params}) => !params.dynamicTools?.some((tool) => tool.name === "consultation")));
  assert.ok(normal.every(({params}) => !params.developerInstructions.includes("latestUserMessage") && !params.developerInstructions.includes("consultation.handoff")));
  const runtimeParents = rpc.calls.filter(({method,params}) => ["thread/start", "thread/resume"].includes(method) && params.permissions);
  const interactive = runtimeParents.filter(({params}) => params.config.permissions[params.permissions].filesystem[":workspace_roots"] === "write");
  const helpers = runtimeParents.filter(({params}) => params.config.permissions[params.permissions].filesystem[":workspace_roots"] === "read");
  assert.ok(interactive.some(({params}) => params.developerInstructions.includes("consultation.handoff")));
  assert.ok(interactive.some(({params}) => !params.developerInstructions.includes("consultation.handoff")));
  assert.ok(interactive.every(({params}) => params.config.web_search === "live"), "ordinary and consultation use the same public Web capability");
  assert.ok(helpers.length > 0 && helpers.every(({params}) => params.config.web_search === "disabled"));
  assert.ok(runtimeParents.every(({params}) => params.config.permissions[params.permissions].network.enabled === false
    && params.config.features.browser_use === false && params.config.features.computer_use === false
    && params.config.apps._default.enabled === false), "public Web does not enable private browser or shell network");
  assert.ok(parents.slice(before, through).some(({params}) => params.dynamicTools?.some((tool) => tool.name === "consultation" && tool.tools.some((item) => item.name === "handoff"))));
});

test("handoff validates membership, latest read user, target cursor, idempotency and an exclusive control reservation", { timeout: 20000 }, async (t) => {
  const userMessageId = randomUUID(), taskCalls = [];
  const { controller, room, rpc } = await consultationFixture(t, { taskCalls, holdResponses: true, replyFor: () => "[[PASS]]" });
  const action = (tool, args) => ({ namespace: "consultation", tool, arguments: args });
  taskCalls.push([
    action("handoff", { orchestratorId: randomUUID(), userMessageId }),
    action("handoff", { orchestratorId: "main", userMessageId }),
    action("handoff", { orchestratorId: room.participants[2], userMessageId: randomUUID() }),
    action("handoff", { orchestratorId: room.participants[2], userMessageId, unexpected: true }),
    action("handoff", { orchestratorId: room.participants[2], userMessageId }),
    action("handoff", { orchestratorId: room.participants[2], userMessageId }),
    action("handoff", { orchestratorId: room.participants[1], userMessageId }),
    action("finish", { userMessageId }),
  ]);
  await controller.supplement(room.id, { text: "C please respond", messageId: userMessageId });
  await waitFor(() => rpc.releases.length === 1); await rpc.releases.shift()();
  await waitFor(() => rpc.releases.length === 1);
  assert.equal((await controller.get(room.id)).run.orchestratorId, room.participants[2]);
  taskCalls.push([action("handoff", { orchestratorId: "main", userMessageId })]);
  await rpc.releases.shift()(); await waitFor(() => rpc.releases.length === 1);
  const results = rpc.calls.filter(({method}) => method === "fake/taskResult").map(({value}) => value.success);
  assert.deepEqual(results, [false, false, false, false, true, true, false, false, false]);
  await controller.stop(room.id);
});

test("a finish reservation stays exclusive and commits with the normal final reply", { timeout: 20000 }, async (t) => {
  const userMessageId = randomUUID(), taskCalls = [];
  const { controller, room, rpc } = await consultationFixture(t, { taskCalls, replyFor: () => "Final answer" });
  taskCalls.push([{ namespace: "consultation", tool: "finish", arguments: { userMessageId } },
    { namespace: "consultation", tool: "handoff", arguments: { orchestratorId: room.participants[2], userMessageId } }]);
  await controller.supplement(room.id, { text: "Give your final answer then finish", messageId: userMessageId });
  await waitFor(async () => (await controller.get(room.id)).reason === "ended");
  assert.deepEqual(rpc.calls.filter(({method}) => method === "fake/taskResult").map(({value}) => value.success), [true, false]);
  assert.equal((await controller.get(room.id)).messages.at(-1).text, "Final answer");
});

test("a newer user arriving before or after handoff reservation invalidates old routing", { timeout: 20000 }, async (t) => {
  for (const afterReservation of [false, true]) {
    const userMessageId = randomUUID(), nextId = randomUUID(), taskCalls = [];
    const { controller, room, rpc } = await consultationFixture(t, { taskCalls, holdResponses: !afterReservation,
      responseEvents: afterReservation ? () => [{ method: "item/started", params: { item: { id: "comment", type: "agentMessage", phase: "commentary" } } }] : undefined,
      replyFor: () => "[[PASS]]" });
    taskCalls.push([{ namespace: "consultation", tool: "handoff", arguments: { orchestratorId: room.participants[2], userMessageId } }]);
    await controller.supplement(room.id, { text: "C please respond", messageId: userMessageId });
    await waitFor(() => (afterReservation ? rpc.eventReleases : rpc.releases).length === 1);
    assert.equal(Boolean((await controller.get(room.id)).run.handoff), afterReservation);
    await controller.supplement(room.id, { text: "Changed request for everyone", messageId: nextId });
    const release = (afterReservation ? rpc.eventReleases : rpc.releases).shift();
    await release();
    await waitFor(() => (afterReservation ? rpc.eventReleases : rpc.releases).length === 1);
    const current = await controller.get(room.id);
    assert.equal(current.run.orchestratorId, room.participants[1], "new request resumes normal order instead of the old target");
    assert.equal(current.turns, 0);
    assert.equal(JSON.parse(current.run.inputText).latestUserMessage.id, nextId);
    await controller.stop(room.id);
  }
});

test("durable handoff recovers only completed turns and never bypasses the turn limit", { timeout: 20000 }, async (t) => {
  for (const status of ["completed", "failed", "interrupted", "limit"]) {
    const userMessageId = randomUUID(), taskCalls = [];
    const { controller, room, rpc, service, directory, track } = await consultationFixture(t, { taskCalls, replyFor: () => "[[PASS]]" });
    if (status === "limit") await controller.configure(room.id, { template: room.template, maxTurns: 1 });
    taskCalls.push([{ namespace: "consultation", tool: "handoff", arguments: { orchestratorId: room.participants[2], userMessageId } }]);
    const original = service.start.bind(service); let terminalResult;
    service.start = (message, _done, ...args) => original(message, (result) => { terminalResult = result; }, ...args);
    await controller.supplement(room.id, { text: "C please respond", messageId: userMessageId });
    await waitFor(() => terminalResult);
    assert.equal((await controller.get(room.id)).run.handoff.orchestratorId, room.participants[2]);
    await controller.close(); service.start = original;
    const statusOriginal = service.status.bind(service);
    service.status = async (...args) => ({ ...await statusOriginal(...args), status: status === "limit" ? "completed" : status });
    const restored = createVoiceConsultationService({ rootDir: path.join(directory,"rooms"), orchestrators: service }); track(restored);
    if (status === "limit") {
      await assert.rejects(restored.resume(room.id), /limit reached/);
      assert.equal((await restored.get(room.id)).reason, "limit");
      assert.equal(rpc.calls.filter(({method,params}) => method === "turn/start" && params.input[0].text.startsWith('{"kind":"consultation"')).length, 1);
    } else {
      await restored.resume(room.id);
      await waitFor(async () => (await restored.get(room.id)).reason === "all_pass");
      const final = await restored.get(room.id);
      const successful = final.steps.filter((step) => step.action === "pass");
      assert.equal(successful[1].orchestratorId, status === "completed" ? room.participants[2] : room.participants[1]);
    }
  }
});

test("handoff lets the addressed final reply finish before any other participant runs", { timeout: 20000 }, async (t) => {
  const userMessageId = randomUUID(), taskCalls = [];
  const { controller, room, rpc } = await consultationFixture(t, { taskCalls,
    replyFor: ({ownerId}) => ownerId === "main" ? "[[PASS]]" : "Final requested story" });
  taskCalls.push([{ namespace: "consultation", tool: "handoff", arguments: { orchestratorId: room.participants[2], userMessageId } }],
    [{ namespace: "consultation", tool: "finish", arguments: { userMessageId } }]);
  await controller.supplement(room.id, { text: "One last story from C, then finish. Others stay quiet.", messageId: userMessageId });
  await waitFor(async () => (await controller.get(room.id)).reason === "ended");
  const final = await controller.get(room.id);
  assert.deepEqual(final.steps.map((step) => step.orchestratorId), ["main", room.participants[2]]);
  assert.deepEqual(final.messages.filter((item) => item.source === "participant").map((item) => item.text), ["Final requested story"]);
  assert.deepEqual(rpc.calls.filter(({method}) => method === "fake/taskResult").map(({value}) => value.success), [true, true]);
});

test("persisted malformed handoff reservations fail closed on reload", { timeout: 20000 }, async (t) => {
  const userMessageId = randomUUID(), taskCalls = [];
  const { controller, room, rpc, service, directory, track } = await consultationFixture(t, { taskCalls, replyFor: () => "[[PASS]]" });
  taskCalls.push([{ namespace: "consultation", tool: "handoff", arguments: { orchestratorId: room.participants[2], userMessageId } }]);
  const original = service.start.bind(service); let done;
  service.start = (message, _done, ...args) => original(message, (result) => { done = result; }, ...args);
  await controller.supplement(room.id, { text: "C please respond", messageId: userMessageId });
  await waitFor(() => done); await controller.close();
  const file = path.join(directory, "rooms", `${room.id}.json`), saved = await json(file);
  for (const handoff of [null, { orchestratorId: randomUUID(), userMessageId }, { orchestratorId: "main", userMessageId },
    { orchestratorId: room.participants[2], userMessageId: randomUUID() }]) {
    const invalid = structuredClone(saved); invalid.run.handoff = handoff;
    await fs.writeFile(file, JSON.stringify(invalid));
    const restored = createVoiceConsultationService({ rootDir: path.join(directory,"rooms"), orchestrators: service }); track(restored);
    await assert.rejects(restored.get(room.id), /Invalid consultation state/);
  }
  const conflicting = structuredClone(saved); conflicting.run.finishUserMessageId = userMessageId;
  await fs.writeFile(file, JSON.stringify(conflicting));
  const restored = createVoiceConsultationService({ rootDir: path.join(directory,"rooms"), orchestrators: service }); track(restored);
  await assert.rejects(restored.get(room.id), /Invalid consultation state/);
});

test("current speaker and latest-request responders do not confuse an older in-flight answer with a new addressed request", { timeout: 20000 }, async (t) => {
  const replies = ["Answer to the old request", "Answer to the new request", "[[PASS]]"];
  const { controller, room, rpc } = await consultationFixture(t, { holdResponses: true, replyFor: () => replies.shift() || "[[PASS]]" });
  const first = randomUUID(), latest = randomUUID();
  await controller.supplement(room.id, { text: "Everyone give an opinion", messageId: first });
  await waitFor(() => rpc.releases.length === 1);
  await controller.supplement(room.id, { text: "Only B, try again", messageId: latest });
  await rpc.releases.shift()(); await waitFor(() => rpc.releases.length === 1);
  let current = JSON.parse((await controller.get(room.id)).run.inputText);
  assert.deepEqual(current.currentParticipant, { id: room.participants[1], name: "B" });
  assert.equal(current.latestUserMessage.id, latest);
  assert.deepEqual(current.latestUserResponders, [], "late old answer did not read the newer user instruction");
  assert.deepEqual(current.newUserMessages.map((message) => message.id), [first, latest], "unread historical requests remain ordered rather than silently discarded");
  await rpc.releases.shift()(); await waitFor(() => rpc.releases.length === 1);
  current = JSON.parse((await controller.get(room.id)).run.inputText);
  assert.deepEqual(current.currentParticipant, { id: room.participants[2], name: "C" });
  assert.deepEqual(current.latestUserResponders, [room.participants[1]]);
  assert.ok(!current.handoffCandidates.includes(room.participants[1]), "the real addressee already read it; other candidates are not substitute addressees");
  await controller.stop(room.id);
});

// Real segment queue with an in-memory audio provider; no synthesis/network.
function audioFixture() {
  const jobs = [], spoken = [], events = [];
  const create = (runId, voice) => {
    const job = { jobId: randomUUID(), runId, voice, cancelled: false, completed: false, finished: null };
    const abort = new AbortController();
    const segments = createStreamTtsSegments({ signal: abort.signal, speedScale: 1, sanitizeText: (text) => text.trim(),
      estimateDurationMs: () => 1, emit: (event) => events.push({ runId, ...event }),
      synthesizeSegment: async (text) => { spoken.push({ runId, text }); return { audioUrl: "synthetic-audio", speedScale: 1 }; } });
    jobs.push(job);
    return { job, append: segments.append, complete: () => { job.completed = true; job.finished = segments.finish(); },
      cancel: () => { job.cancelled = true; abort.abort(); segments.cancel(); } };
  };
  return { jobs, spoken, events, create };
}

test("subscribed native final deltas synthesize a full stop before turn completion, independent of the human preview cap", { timeout: 20000 }, async (t) => {
  const audio = audioFixture(), speechEvents = [], tail = "合成用の長い末尾".repeat(5000), text = `先に話せる文。${tail}`;
  const { controller, room, rpc } = await consultationFixture(t, { onSpeech: (event) => speechEvents.push(event), replyFor: () => text,
    responseEvents: () => [
      { method: "item/started", params: { item: { id: "comment", type: "agentMessage", phase: "commentary" } } },
      { method: "item/agentMessage/delta", params: { itemId: "comment", delta: "非公開の途中確認。" } },
      { method: "item/started", params: { item: { id: "answer", type: "agentMessage", phase: "final_answer" } } },
      { method: "item/agentMessage/delta", params: { itemId: "answer", delta: text } },
    ] });
  await controller.configure(room.id, { template: room.template, maxTurns: 1 });
  const subscriptionId = randomUUID(); await controller.subscribeSpeech(room.id, subscriptionId, audio.create);
  await controller.supplement(room.id, { text: "架空の相談", messageId: randomUUID() });
  await waitFor(() => audio.spoken.length === 1);
  const active = await controller.get(room.id);
  assert.ok(active.run, "native turn is still held"); assert.equal(audio.jobs[0].completed, false);
  assert.equal(audio.spoken[0].text, "先に話せる文。");
  assert.equal(active.run.progress.messages.find((item) => item.id === "answer").truncated, true);
  assert.equal(speechEvents.filter((event) => event.status === "ready").length, 1);
  await rpc.eventReleases.shift()(); await waitFor(async () => (await controller.get(room.id)).reason === "limit");
  await audio.jobs[0].finished;
  assert.deepEqual(audio.spoken.map(({text}) => text), ["先に話せる文。", tail]);
  assert.equal(audio.jobs[0].cancelled, false, "natural end retains the final audio job");
});

test("phase-unknown text waits for final metadata; PASS and commentary never reach the audio provider", { timeout: 20000 }, async (t) => {
  for (const text of ["確定後に話す。末尾", "[[PASS]]"]) {
    const audio = audioFixture();
    const { controller, room, rpc, service } = await consultationFixture(t, { replyFor: () => text,
      responseEvents: () => [
        { method: "item/started", params: { item: { id: "comment", type: "agentMessage", phase: "commentary" } } },
        { method: "item/agentMessage/delta", params: { itemId: "comment", delta: "これは読み上げない。" } },
        { method: "item/agentMessage/delta", params: { itemId: "answer", delta: text.slice(0, 3) } },
        { method: "item/agentMessage/delta", params: { itemId: "answer", delta: text.slice(3) } },
      ] });
    // Hold the real native identity publication while the native completion arrives.
    // New live notifications must not overtake the earlier buffered deltas.
    const rename = fs.rename; let held = false, releaseStore;
    const storeGate = new Promise((resolve) => { releaseStore = resolve; });
    const mocked = t.mock.method(fs, "rename", async (from, to) => {
      if (!held && String(to).includes(path.join("scopes", room.id)) && path.basename(String(to)) === "active.json") {
        const state = await json(from);
        if (state.pendingDispatch?.turnId) { held = true; await storeGate; }
      }
      return rename(from, to);
    });
    const deltas = [], originalStart = service.start.bind(service);
    service.start = (message, done, approval, hooks) => originalStart(message, done, approval,
      { ...hooks, onText: (delta, metadata) => { deltas.push({ delta, metadata }); hooks.onText(delta, metadata); } });
    await controller.configure(room.id, { template: room.template, maxTurns: 1 });
    await controller.subscribeSpeech(room.id, randomUUID(), audio.create);
    await controller.supplement(room.id, { text: "架空の依頼", messageId: randomUUID() });
    try {
      await waitFor(() => held && rpc.eventReleases.length === 1); assert.deepEqual(audio.spoken, []);
      await rpc.eventReleases.shift()(); await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(audio.spoken, [], "completion must wait for durable native identity before any buffered text is released");
      releaseStore();
      await waitFor(async () => (await controller.get(room.id)).reason === "limit");
      await audio.jobs[0].finished;
      const answerDeltas = deltas.filter(({metadata}) => metadata?.itemId === "answer");
      assert.equal(answerDeltas[0].metadata.phase, null);
      assert.equal(answerDeltas.at(-1).metadata.phase, "final_answer");
      assert.deepEqual(audio.spoken.map(({text}) => text), text === "[[PASS]]" ? [] : ["確定後に話す。", "末尾"], JSON.stringify(deltas));
    } finally { releaseStore(); mocked.mock.restore(); }
  }
});

test("audio demand is opt-in from the next accepted run, idempotent retries preserve it, and new user/unsubscribe cancel old work", { timeout: 20000 }, async (t) => {
  const audio = audioFixture(), text = "途中の文。末尾";
  const { controller, room, rpc, service } = await consultationFixture(t, { replyFor: () => text,
    responseEvents: () => [
      { method: "item/started", params: { item: { id: "answer", type: "agentMessage", phase: "final_answer" } } },
      { method: "item/agentMessage/delta", params: { itemId: "answer", delta: "途中の文。" } },
    ] });
  await controller.configure(room.id, { template: room.template, maxTurns: 1 });
  await controller.supplement(room.id, { text: "購読前の依頼", messageId: randomUUID() });
  await waitFor(() => rpc.eventReleases.length === 1);
  const subscriptionId = randomUUID(); await controller.subscribeSpeech(room.id, subscriptionId, audio.create);
  assert.equal(audio.jobs.length, 0, "opening midway never regenerates a past prefix");
  await rpc.eventReleases.shift()(); await waitFor(async () => (await controller.get(room.id)).reason === "limit");
  assert.equal(audio.jobs.length, 0, "completion isn't a full-text fallback after a late subscription");
  const messageId = randomUUID(); await controller.supplement(room.id, { text: "購読後の依頼", messageId });
  await waitFor(() => audio.spoken.length === 1);
  await controller.subscribeSpeech(room.id, subscriptionId, audio.create);
  await controller.supplement(room.id, { text: "購読後の依頼", messageId });
  assert.equal(audio.jobs.length, 1); assert.equal(audio.jobs[0].cancelled, false);
  await controller.supplement(room.id, { text: "新しい補足", messageId: randomUUID() });
  assert.equal(audio.jobs[0].cancelled, true);
  await rpc.eventReleases.shift()(); await waitFor(() => audio.jobs.length === 2 && rpc.eventReleases.length === 1);
  assert.equal((await controller.unsubscribeSpeech(room.id, randomUUID())).removed, false);
  assert.equal(audio.jobs[1].cancelled, false);
  await controller.unsubscribeSpeech(room.id, subscriptionId); assert.equal(audio.jobs[1].cancelled, true);
  await controller.stop(room.id);
});

test("stream divergence and durable room failure cancel subscribed audio instead of replaying or leaving a running job", { timeout: 20000 }, async (t) => {
  for (const storageFailure of [false, true]) {
    const audio = audioFixture();
    const { controller, room, rpc, directory } = await consultationFixture(t, { replyFor: () => "異なる確定本文。",
      responseEvents: () => [
        { method: "item/started", params: { item: { id: "answer", type: "agentMessage", phase: "final_answer" } } },
        { method: "item/agentMessage/delta", params: { itemId: "answer", delta: "先に生成した文。" } },
      ] });
    await controller.configure(room.id, { template: room.template, maxTurns: 1 });
    await controller.subscribeSpeech(room.id, randomUUID(), audio.create);
    await controller.supplement(room.id, { text: "架空の確認", messageId: randomUUID() });
    await waitFor(() => audio.spoken.length === 1);
    if (storageFailure) {
      const open = fs.open;
      const mocked = t.mock.method(fs, "open", (file, ...args) => String(file).startsWith(path.join(directory, "rooms", `${room.id}.json.`))
        ? Promise.reject(Object.assign(new Error("synthetic EIO"), { code: "EIO" })) : open(file, ...args));
      try { await assert.rejects(controller.configure(room.id, { template: "保存不能" }), { code: "EIO" }); }
      finally { mocked.mock.restore(); }
      assert.equal((await controller.get(room.id)).reason, "storage_unavailable");
    }
    await rpc.eventReleases.shift()();
    await waitFor(() => audio.jobs[0].cancelled);
    if (!storageFailure) await waitFor(async () => (await controller.get(room.id)).reason === "limit");
    assert.deepEqual(audio.spoken.map(({text}) => text), ["先に生成した文。"], "already emitted audio cannot be undone, but neither replacement nor tail is synthesized");
    assert.equal(audio.jobs[0].completed, false);
  }
});

test("native background work keeps lifecycle protected while ordinary and consultation conversations continue", { timeout: 20000 }, async (t) => {
  const { service, rpc, rootDir } = await ownerFixture(t);
  const owner = await service.create("background owner"), key = randomUUID();
  await ownerTurn(service, owner.id, "Start a native task", key);
  const directory = path.join(rootDir, "orchestrators", owner.id, "scopes", key);
  const scope = await json(path.join(directory, "active.json"));
  const root = rpc.threads.get(scope.nativeThreadId), childId = randomUUID();
  root.turns.at(-1).items.push({ type: "collabAgentToolCall", status: "completed", receiverThreadIds: [childId],
    agentsStates: { [childId]: { status: "running" } } });
  rpc.threads.set(childId, { id: childId, status: { type: "active" }, turns: [] });
  assert.equal(await service.isBusy(owner.id), true);
  await ownerTurn(service, owner.id, "待ちません");
  await ownerTurn(service, owner.id, "Continue discussing the task", key);
  await assert.rejects(service.configure(owner.id, "gpt-6-luna", "low", "changed"), { code: "session_busy" });
  await assert.rejects(service.clearMemory(owner.id), { code: "session_busy" });
  await assert.rejects(service.clearMessages(owner.id), { code: "session_busy" });
  await assert.rejects(service.remove(owner.id), { code: "session_busy" });
  await assert.rejects(service.draftIntroduction(owner.id, { model: "gpt-6-luna", effort: "low" }), { code: "session_busy" });
  rpc.threads.get(childId).status = { type: "idle" };
  root.turns.at(-2).items.at(-1).agentsStates[childId].status = "completed";
  await service.clearMessages(owner.id);
});
