import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVoiceContextService } from "../src/voice-context-service.mjs";
import { createVoiceOrchestratorService } from "../src/voice-orchestrator-service.mjs";
import { createVoiceConsultationService } from "../src/voice-consultation-service.mjs";
import { openVoiceMemoryStore } from "../src/voice-memory-store.mjs";

// No real App Server/client is imported. Only RPC responses and native events are
// simulated; context lifecycle, filesystem, memory and learning observation are real.
function fakeAppServer({ holdResponses = false, holdSummaries = false, holdOverviews = false, loseResponse = false, replyFor, ephemeralReply, taskCalls = [] } = {}) {
  const calls = [], clientOptions = [], releases = [], summaryReleases = [], overviewReleases = [], threads = new Map();
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
              item: { type: "agentMessage", text } });
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
  return { createClient, calls, clientOptions, releases, summaryReleases, overviewReleases, threads };
}

async function fixture(t, options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-consultation-boundaries-"));
  const rpc = fakeAppServer(options);
  const contexts = [];
  t.after(async () => {
    for (const release of [...rpc.releases.splice(0), ...rpc.summaryReleases.splice(0), ...rpc.overviewReleases.splice(0)]) await release();
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
    orchestrators: values.service, requestApproval: () => { throw new Error("No approval requested by fake"); },
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
  assert.deepEqual(inputs[1].messages.map((message) => message.text), ["Synthetic team question", "A opinion"]);
  assert.ok(inputs[2].messages.some((message) => message.text === "B adopts A"));
  assert.deepEqual(inputs[3].messages.map((message) => message.text), ["B adopts A", "C adopts B"]);
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
  await ownerTurn(service, "main", "old scoped parent before invite capability", room.id);
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
  assert.ok(inputs[2].messages.some((message) => message.source === "membership"));
  const scopeActive = await json(path.join(rootDir, "scopes", room.id, "active.json"));
  assert.equal(scopeActive.nativeConversationToolsVersion, "consultation-invite-v1");
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
