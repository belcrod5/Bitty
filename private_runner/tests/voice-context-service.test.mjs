import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVoiceContextService } from "../src/voice-context-service.mjs";

function fakeCodex({ reply = "answer", failSummary = false, failSummaryCount = 0, holdTurns = false, holdSummaries = false, ignoreAbort = false, toolItem = false, approvalMethod = "", userItem = false, ephemeral = true, mcpPage, configuredMcpServers = {}, missingTurnId = false, failMethod } = {}) {
  const calls = [];
  const releases = [];
  const summaryReleases = [];
  let summaryFailuresRemaining = failSummaryCount;
  const createClient = ({ signal } = {}) => {
    let listener = () => {};
    let serverHandler = () => undefined;
    let resolveCompletion = () => {};
    let isSummaryThread = false;
    if (!ignoreAbort) signal?.addEventListener("abort", () => resolveCompletion(), { once: true });
    return {
      openPromise: Promise.resolve(),
      notify() {},
      close() {},
      addNotificationListener(next) { listener = next; return () => { listener = () => {}; }; },
      addServerRequestHandler(handler) { serverHandler = handler; return () => { serverHandler = () => undefined; }; },
      waitForTurnCompletion() {
        return { expect() {}, promise: new Promise((resolve) => { resolveCompletion = resolve; }) };
      },
      async request(method, params) {
        if (signal?.aborted && !ignoreAbort) throw new Error("mock aborted");
        calls.push({ method, params });
        if (method === failMethod) {
          const error = new Error("private request text and credential");
          error.code = "app_server_failed";
          error.voiceReason = "private request text and credential";
          error.voiceStage = "private request text and credential";
          throw error;
        }
        if (method === "config/read") return { config: { mcp_servers: configuredMcpServers } };
        if (method === "thread/start") {
          isSummaryThread = params.approvalPolicy === "never";
          return { thread: { id: randomUUID(), ephemeral } };
        }
        if (method === "mcpServerStatus/list") return mcpPage ?? { data: [], nextCursor: null };
        if (method === "turn/start") {
          const isSummary = isSummaryThread;
          if (isSummary && (failSummary || summaryFailuresRemaining > 0)) {
            summaryFailuresRemaining--;
            throw new Error("private summary text and credential");
          }
          const turnId = randomUUID();
          const finish = async () => {
            if (userItem) listener("item/completed", { threadId: params.threadId, turnId, item: { type: "userMessage" } });
            if (toolItem) listener("item/started", { threadId: params.threadId, turnId, item: { type: "commandExecution" } });
            if (approvalMethod && !isSummary) {
              const result = await serverHandler({ method: approvalMethod, params: {
                threadId: params.threadId, turnId, command: "echo", args: ["hello"], reason: "test",
              } });
              calls.push({ method: "approval/result", params: result });
            }
            listener("item/completed", { threadId: params.threadId, turnId, item: { type: "agentMessage", text: reply } });
            listener("turn/completed", { threadId: params.threadId, turnId, turn: { status: "completed" } });
            resolveCompletion();
          };
          if (isSummary && holdSummaries) summaryReleases.push(finish);
          else if (holdTurns) releases.push(finish);
          else queueMicrotask(() => void finish());
          return { turn: { id: missingTurnId ? "" : turnId } };
        }
        return {};
      },
    };
  };
  return { createClient, calls, releases, summaryReleases };
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not become true");
}

async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "voice-context-test-"));
  const rootDir = path.join(temp, "voice-data");
  const codex = fakeCodex(options);
  t.after(async () => {
    for (const finish of codex.releases.splice(0)) finish();
    for (const finish of codex.summaryReleases.splice(0)) finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  const conversation = await service.open();
  return { rootDir, codex, service, conversation };
}

async function complete(service, conversation, text, id = randomUUID(), onApproval = async () => "decline") {
  let resolve;
  const terminal = new Promise((done) => { resolve = done; });
  const message = { operationId: id, payload: {
    backendId: "codex", logicalConversationId: conversation.logicalConversationId,
    clientOperationId: id, input: { blocks: [{ type: "text", text }] },
  } };
  const accepted = await service.start(message, resolve, onApproval);
  return { accepted, result: await terminal, message };
}

async function seedPairs(rootDir, logicalConversationId, count) {
  const events = [];
  const at = new Date().toISOString();
  for (let pairSeq = 1; pairSeq <= count; pairSeq++) {
    const clientOperationId = randomUUID();
    const add = (type, extra = {}) => events.push({ seq: events.length + 1, at, clientOperationId, type, ...extra });
    add("accepted", { text: `user-${pairSeq}` });
    add("dispatching");
    add("native_started", { threadId: randomUUID(), turnId: randomUUID() });
    add("completed", { pairSeq, text: `assistant-${pairSeq}` });
  }
  await fs.writeFile(path.join(rootDir, logicalConversationId, "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
}

test("voice turns persist before acknowledgement and replay without generation", async (t) => {
  const { rootDir, codex, service, conversation } = await fixture(t);
  const { accepted, result, message } = await complete(service, conversation, "hello");
  assert.equal(accepted.status, "accepted");
  assert.equal(typeof accepted.estimatedContextUsagePercent, "number");
  assert.equal(accepted.unsummarizedMessageCount, 0);
  assert.equal(accepted.memoryCharacterCount, 0);
  assert.equal(result.status, "completed");
  assert.equal(result.text, "answer");
  assert.equal(result.unsummarizedMessageCount, 2);
  assert.equal((await service.open()).unsummarizedMessageCount, 2);
  const eventFile = path.join(rootDir, conversation.logicalConversationId, "events.jsonl");
  const events = (await fs.readFile(eventFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.type), ["accepted", "dispatching", "native_started", "completed"]);
  assert.equal(events.at(-1).pairSeq, 1);
  assert.equal(codex.calls.filter(({ method }) => method === "turn/start").length, 1);
  assert.equal((await service.start(message, () => {})).status, "completed");
  assert.equal(codex.calls.filter(({ method }) => method === "turn/start").length, 1);
  await assert.rejects(service.start({ ...message, payload: { ...message.payload, input: { blocks: [{ type: "text", text: "different" }] } } }, () => {}),
    { code: "operation_conflict" });
  const reopened = createVoiceContextService({ rootDir, createClient: codex.createClient });
  assert.equal((await reopened.status(conversation.logicalConversationId, message.operationId)).text, "answer");
});

test("response files survive turns and restart in a conversation-owned workspace", async (t) => {
  const { rootDir, codex, service, conversation } = await fixture(t, { holdTurns: true });
  const first = complete(service, conversation, "create a file");
  await waitFor(() => codex.releases.length === 1);
  const firstStart = codex.calls.find(({ method }) => method === "thread/start").params;
  const workspace = path.join(path.dirname(rootDir), "workspaces", conversation.logicalConversationId);
  assert.equal(firstStart.cwd, await fs.realpath(workspace));
  assert.equal(firstStart.cwd.startsWith(rootDir + path.sep), false);
  assert.equal(firstStart.cwd.includes("ephemeral-tmp"), false);
  assert.equal((await fs.stat(workspace)).mode & 0o777, 0o700);
  await fs.writeFile(path.join(workspace, "saved.txt"), "persistent conversation file");
  codex.releases.shift()();
  assert.equal((await first).result.status, "completed");
  assert.equal(await fs.readFile(path.join(workspace, "saved.txt"), "utf8"), "persistent conversation file");

  const restarted = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await restarted.open();
  const second = complete(restarted, conversation, "read the file");
  await waitFor(() => codex.releases.length === 1);
  assert.equal(codex.calls.filter(({ method }) => method === "thread/start").at(-1).params.cwd, firstStart.cwd);
  assert.equal(await fs.readFile(path.join(workspace, "saved.txt"), "utf8"), "persistent conversation file");
  codex.releases.shift()();
  assert.equal((await second).result.status, "completed");
  assert.equal(await fs.readFile(path.join(workspace, "saved.txt"), "utf8"), "persistent conversation file");
});

test("summary uses a disposable read-only directory outside the conversation workspace", async (t) => {
  const { rootDir, codex, conversation } = await fixture(t, { holdSummaries: true });
  await seedPairs(rootDir, conversation.logicalConversationId, 11);
  const workspace = path.join(path.dirname(rootDir), "workspaces", conversation.logicalConversationId);
  await fs.writeFile(path.join(workspace, "saved.txt"), "keep");
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await service.open();
  await waitFor(() => codex.summaryReleases.length === 1);
  const summary = codex.calls.find(({ method, params }) => method === "thread/start" && params.approvalPolicy === "never").params;
  assert.equal(summary.sandbox, "read-only");
  assert.match(summary.cwd, /\/ephemeral-tmp\/summary-[A-Za-z0-9]{6}$/);
  assert.equal(await fs.stat(summary.cwd).then(() => true, () => false), true);
  codex.summaryReleases.shift()();
  await waitFor(async () => !(await fs.stat(summary.cwd).then(() => true, () => false)));
  assert.equal(await fs.readFile(path.join(workspace, "saved.txt"), "utf8"), "keep");
});

for (const target of ["root", "conversation"]) {
  test(`symlinked ${target} workspace is rejected without following it`, async (t) => {
    const { rootDir, codex, conversation } = await fixture(t);
    const workspaceRoot = path.join(path.dirname(rootDir), "workspaces");
    const targetPath = target === "root" ? workspaceRoot : path.join(workspaceRoot, conversation.logicalConversationId);
    const protectedDirectory = path.join(path.dirname(rootDir), "protected");
    await fs.mkdir(protectedDirectory);
    await fs.writeFile(path.join(protectedDirectory, "keep"), "untouched");
    await fs.rm(targetPath, { recursive: true });
    await fs.symlink(protectedDirectory, targetPath);
    const reopened = createVoiceContextService({ rootDir, createClient: codex.createClient });
    await assert.rejects(reopened.open(), { code: "voice_store_corrupt" });
    assert.equal(await fs.readFile(path.join(protectedDirectory, "keep"), "utf8"), "untouched");
    assert.equal(codex.calls.length, 0);
  });
}

test("legacy active store gets a durable workspace marker and later missing workspace fails closed", async (t) => {
  const { rootDir, codex, conversation } = await fixture(t);
  const activeFile = path.join(rootDir, "active.json");
  const workspaceRoot = path.join(path.dirname(rootDir), "workspaces");
  await fs.writeFile(activeFile, JSON.stringify({
    logicalConversationId: conversation.logicalConversationId, contextMode: "self_context_array",
  }));
  await fs.rm(workspaceRoot, { recursive: true });
  const migrated = createVoiceContextService({ rootDir, createClient: codex.createClient });
  assert.equal((await migrated.open()).logicalConversationId, conversation.logicalConversationId);
  assert.equal(JSON.parse(await fs.readFile(activeFile, "utf8")).workspaceInitialized, true);
  const workspace = path.join(workspaceRoot, conversation.logicalConversationId);
  await fs.writeFile(path.join(workspace, "keep"), "saved");
  const restarted = createVoiceContextService({ rootDir, createClient: codex.createClient });
  assert.equal((await restarted.open()).logicalConversationId, conversation.logicalConversationId);
  assert.equal(await fs.readFile(path.join(workspace, "keep"), "utf8"), "saved");
  await fs.rm(workspace, { recursive: true });
  const lost = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await assert.rejects(lost.open(), { code: "voice_store_corrupt" });
  assert.equal(await fs.stat(workspace).then(() => true, () => false), false);
  assert.equal(codex.calls.length, 0);
});

test("workspace owned by another user is rejected before dispatch", async (t) => {
  if (typeof process.getuid !== "function") return t.skip("UID checks are unavailable");
  const { rootDir, codex, conversation } = await fixture(t);
  const workspace = path.join(path.dirname(rootDir), "workspaces", conversation.logicalConversationId);
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, "lstat", async (file, ...args) => {
    const stat = await lstat(file, ...args);
    return String(file) === workspace ? Object.assign(Object.create(stat), { uid: stat.uid + 1 }) : stat;
  });
  const reopened = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await assert.rejects(reopened.open(), { code: "voice_store_corrupt" });
  assert.equal(codex.calls.length, 0);
});

test("reply inherits configured MCP and can complete a tool approval", async (t) => {
  const method = "item/commandExecution/requestApproval";
  const { service, conversation, codex } = await fixture(t, {
    mcpPage: { data: [{ name: "configured" }], nextCursor: null }, toolItem: true, approvalMethod: method,
  });
  const requests = [];
  const { result } = await complete(service, conversation, "use the tool", randomUUID(), async (request) => {
    requests.push(request);
    return "accept";
  });
  assert.equal(result.status, "completed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, method);
  assert.deepEqual(codex.calls.find(({ method: name }) => name === "approval/result")?.params, { decision: "accept" });
  assert.equal(codex.calls.some(({ method: name }) => name === "mcpServerStatus/list"), false);
  assert.equal(codex.calls.some(({ method: name }) => name === "turn/interrupt"), false);
});

test("declined tool approval still lets the assistant answer", async (t) => {
  const { service, conversation, codex } = await fixture(t, {
    approvalMethod: "item/fileChange/requestApproval",
  });
  const { result } = await complete(service, conversation, "edit a file");
  assert.equal(result.status, "completed");
  assert.deepEqual(codex.calls.find(({ method }) => method === "approval/result")?.params, { decision: "decline" });
});

test("lost approval channel interrupts the voice turn", async (t) => {
  const { service, conversation, codex } = await fixture(t, {
    approvalMethod: "item/commandExecution/requestApproval",
  });
  const { result } = await complete(service, conversation, "run", randomUUID(), async () => {
    throw new Error("socket disconnected");
  });
  assert.equal(result.status, "interrupted");
  assert.equal(result.code, "turn_interrupted");
  assert.equal(codex.calls.some(({ method }) => method === "turn/interrupt"), true);
});

test("response uses all unsummarized pairs while overflow summary is pending", async (t) => {
  const { rootDir, codex, service, conversation } = await fixture(t, { holdSummaries: true });
  for (let number = 1; number <= 12; number++) {
    assert.equal((await complete(service, conversation, `user-${number}`)).result.status, "completed");
  }
  await waitFor(() => codex.summaryReleases.length > 0);
  const memory = await fs.readFile(path.join(rootDir, conversation.logicalConversationId, "MEMORY.md"), "utf8");
  assert.match(memory, /summarizedThroughPair=0/);
  const requests = codex.calls.filter(({ method }) => method === "thread/inject_items");
  const last = requests.at(-1).params.items;
  assert.equal(last.length, 22);
  assert.deepEqual(last.filter((item) => item.role === "user").map((item) => item.content[0].text),
    Array.from({ length: 11 }, (_, index) => `user-${index + 1}`));
  const pending = JSON.parse(await fs.readFile(path.join(rootDir, conversation.logicalConversationId, "memory-pending.json"), "utf8"));
  assert.deepEqual([pending.fromPairSeq, pending.throughPairSeq], [1, 2]);
  const threadStarts = codex.calls.filter(({ method }) => method === "thread/start");
  assert.ok(threadStarts.every(({ params }) => params.ephemeral === true && params.model === "gpt-6-luna"));
  assert.ok(threadStarts.some(({ params }) => params.sandbox === "workspace-write" && params.approvalPolicy === "on-request" && !Object.hasOwn(params, "config")));
  assert.ok(threadStarts.some(({ params }) => params.sandbox === "read-only" && params.approvalPolicy === "never" && Object.hasOwn(params.config, "mcp_servers")));
  assert.ok(threadStarts.some(({ params }) => params.sandbox === "read-only"
    && params.config.web_search === "disabled" && params.config.apps._default.enabled === false
    && params.config.features.apps === false && params.config.features.plugins === false
    && Object.keys(params.config.mcp_servers).length === 0));
  assert.ok(threadStarts.every(({ params }) => params.developerInstructions.includes("何かを実行するときは、必ずユーザに確認してから実行してください")));
  const turnStarts = codex.calls.filter(({ method }) => method === "turn/start");
  assert.ok(turnStarts.every(({ params }) => params.model === "gpt-6-luna" && params.effort === "low"));
  assert.ok(turnStarts.some(({ params }) => params.approvalPolicy === "on-request" && !Object.hasOwn(params, "sandboxPolicy")));
  assert.ok(turnStarts.some(({ params }) => params.approvalPolicy === "never" && params.sandboxPolicy.type === "readOnly"));
  await waitFor(async () => {
    const value = JSON.parse(await fs.readFile(path.join(rootDir, conversation.logicalConversationId, "memory-pending.json"), "utf8"));
    return value.throughPairSeq === 2 && codex.summaryReleases.length > 0;
  });
  for (const finish of codex.summaryReleases.splice(0)) finish();
  await waitFor(async () => (await fs.readFile(path.join(rootDir, conversation.logicalConversationId, "MEMORY.md"), "utf8"))
    .includes("summarizedThroughPair=2"));
});

test("summary disables configured MCP and accepts only disabled inventory", async (t) => {
  const disabled = { runtimeStatus: "disabled", tools: {}, resources: [], resourceTemplates: [] };
  const { rootDir, conversation, codex } = await fixture(t, {
    configuredMcpServers: { example: { command: "/bin/false" } },
    mcpPage: { data: [disabled], nextCursor: null },
    reply: "summary",
  });
  await seedPairs(rootDir, conversation.logicalConversationId, 11);
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await service.open();
  await waitFor(async () => (await fs.readFile(path.join(rootDir, conversation.logicalConversationId, "MEMORY.md"), "utf8"))
    .includes("summarizedThroughPair=1"));
  const calls = codex.calls;
  const configRead = calls.findIndex(({ method }) => method === "config/read");
  const threadStart = calls.findIndex(({ method }) => method === "thread/start");
  assert.ok(configRead >= 0 && configRead < threadStart);
  assert.deepEqual(calls[threadStart].params.config.mcp_servers, { example: { enabled: false } });
  assert.deepEqual(calls[threadStart].params.config.features, { apps: false, plugins: false });
});

test("repeated summaries append new pairs without changing existing memory bytes", async (t) => {
  const { rootDir, conversation, codex } = await fixture(t, { reply: "NEW_SUMMARY" });
  await seedPairs(rootDir, conversation.logicalConversationId, 12);
  const memoryFile = path.join(rootDir, conversation.logicalConversationId, "MEMORY.md");
  const historical = "Old fact: 写真は好き。\nKeep this exact trailing space:  \n";
  await fs.writeFile(memoryFile, `<!-- voice-context:v1 summarizedThroughPair=1 -->\n${historical}`);
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await service.open();
  await waitFor(async () => (await fs.readFile(memoryFile, "utf8")).includes("summarizedThroughPair=2"));
  const firstBody = (await fs.readFile(memoryFile, "utf8")).split("\n").slice(1).join("\n");
  assert.equal(firstBody, `${historical}\n\nNEW_SUMMARY`);
  const firstSummary = codex.calls.find(({ method, params }) => method === "turn/start" && params.approvalPolicy === "never");
  assert.deepEqual(JSON.parse(firstSummary.params.input[0].text), {
    fromPairSeq: 2, throughPairSeq: 2, pairs: [{ pairSeq: 2, user: "user-2", assistant: "assistant-2" }],
  });
  assert.equal(firstSummary.params.input[0].text.includes("Old fact"), false);

  assert.equal((await complete(service, conversation, "next")).result.status, "completed");
  await waitFor(async () => (await fs.readFile(memoryFile, "utf8")).includes("summarizedThroughPair=3"));
  const secondBody = (await fs.readFile(memoryFile, "utf8")).split("\n").slice(1).join("\n");
  assert.equal(secondBody, `${firstBody}\n\nNEW_SUMMARY`);
  const summaries = codex.calls.filter(({ method, params }) => method === "turn/start" && params.approvalPolicy === "never");
  assert.equal(summaries.length, 2);
  assert.deepEqual(JSON.parse(summaries[1].params.input[0].text), {
    fromPairSeq: 3, throughPairSeq: 3, pairs: [{ pairSeq: 3, user: "user-3", assistant: "assistant-3" }],
  });
  assert.equal(summaries[1].params.input[0].text.includes("Old fact"), false);
  assert.equal((await service.open()).memoryCharacterCount, Array.from(secondBody).length);
});

test("oversize appended summary leaves cursor and old memory intact", async (t) => {
  const warnings = t.mock.method(console, "warn");
  const { rootDir, conversation, codex } = await fixture(t, { reply: "S".repeat(800000) });
  await seedPairs(rootDir, conversation.logicalConversationId, 11);
  const memoryFile = path.join(rootDir, conversation.logicalConversationId, "MEMORY.md");
  const before = "<!-- voice-context:v1 summarizedThroughPair=0 -->\nHistorical fact stays exactly.\n";
  await fs.writeFile(memoryFile, before);
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await service.open();
  await waitFor(() => warnings.mock.calls.some(({ arguments: args }) => args[0] === "[voice-context] summary failed"));
  assert.equal(await fs.readFile(memoryFile, "utf8"), before);
  assert.equal((await service.open()).unsummarizedMessageCount, 22);
  assert.equal(warnings.mock.calls[0].arguments[1].code, "voice_context_too_large");
});

test("summary rejects a connected MCP server before turn/start", async (t) => {
  const warnings = t.mock.method(console, "warn");
  const { rootDir, conversation, codex } = await fixture(t, {
    configuredMcpServers: { example: { command: "/bin/false" } },
    mcpPage: { data: [{ runtimeStatus: "connected", tools: {}, resources: [], resourceTemplates: [] }], nextCursor: null },
  });
  await seedPairs(rootDir, conversation.logicalConversationId, 11);
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await service.open();
  await waitFor(() => warnings.mock.calls.some(({ arguments: args }) => args[0] === "[voice-context] summary failed"));
  assert.equal(warnings.mock.calls[0].arguments[1].stage, "mcp_list");
  assert.equal(warnings.mock.calls[0].arguments[1].code, "capability_unsupported");
  assert.equal(codex.calls.some(({ method }) => method === "turn/start"), false);
  assert.match(await fs.readFile(path.join(rootDir, conversation.logicalConversationId, "MEMORY.md"), "utf8"), /summarizedThroughPair=0/);
});

test("summary rejects an advertised tool even when MCP status says disabled", async (t) => {
  const warnings = t.mock.method(console, "warn");
  const { rootDir, conversation, codex } = await fixture(t, {
    mcpPage: { data: [{ runtimeStatus: "disabled", tools: { unsafe: {} }, resources: [], resourceTemplates: [] }], nextCursor: null },
  });
  await seedPairs(rootDir, conversation.logicalConversationId, 11);
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await service.open();
  await waitFor(() => warnings.mock.calls.some(({ arguments: args }) => args[0] === "[voice-context] summary failed"));
  assert.equal(codex.calls.some(({ method }) => method === "turn/start"), false);
});

test("summary requires readable MCP configuration before starting a thread", async (t) => {
  const warnings = t.mock.method(console, "warn");
  const { rootDir, conversation, codex } = await fixture(t, { configuredMcpServers: null });
  await seedPairs(rootDir, conversation.logicalConversationId, 11);
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await service.open();
  await waitFor(() => warnings.mock.calls.some(({ arguments: args }) => args[0] === "[voice-context] summary failed"));
  assert.equal(warnings.mock.calls[0].arguments[1].stage, "config_read");
  assert.equal(codex.calls.some(({ method }) => method === "thread/start"), false);
});

test("summary failure leaves backlog visible and does not block responses", async (t) => {
  const { rootDir, service, conversation, codex } = await fixture(t, { failSummary: true });
  for (let number = 1; number <= 11; number++) await complete(service, conversation, `user-${number}`);
  await waitFor(() => codex.calls.some(({ method, params }) => method === "turn/start" && params.approvalPolicy === "never"));
  const before = codex.calls.filter(({ method }) => method === "turn/start").length;
  const next = await complete(service, conversation, "user-12");
  assert.equal(next.result.status, "completed");
  assert.ok(codex.calls.filter(({ method }) => method === "turn/start").length >= before + 1);
  const pending = JSON.parse(await fs.readFile(path.join(rootDir, conversation.logicalConversationId, "memory-pending.json"), "utf8"));
  assert.deepEqual([pending.fromPairSeq, pending.throughPairSeq], [1, 1]);
  assert.equal((await service.status(conversation.logicalConversationId, next.message.operationId)).status, "completed");
  const injections = codex.calls.filter(({ method }) => method === "thread/inject_items");
  assert.equal(injections.at(-1).params.items[0].content[0].text, "user-1");
});

test("failed summary retries while idle, records safe metadata, and commits only after success", async (t) => {
  const warnings = t.mock.method(console, "warn");
  const { rootDir, service, conversation, codex } = await fixture(t, { failSummaryCount: 1, reply: "要約" });
  await seedPairs(rootDir, conversation.logicalConversationId, 11);
  const resumed = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await resumed.open();
  const memoryFile = path.join(rootDir, conversation.logicalConversationId, "MEMORY.md");
  await waitFor(() => warnings.mock.calls.some(({ arguments: args }) => args[0] === "[voice-context] summary failed"));
  assert.match(await fs.readFile(memoryFile, "utf8"), /summarizedThroughPair=0/);
  const failure = warnings.mock.calls.find(({ arguments: args }) => args[0] === "[voice-context] summary failed").arguments[1];
  assert.deepEqual(failure, {
    stage: "turn_start", code: "app_server_error", attempt: 1, fromPairSeq: 1, throughPairSeq: 1,
  });
  assert.equal(JSON.stringify(warnings.mock.calls).includes("private"), false);
  await waitFor(async () => (await fs.readFile(memoryFile, "utf8")).includes("summarizedThroughPair=1"));
  assert.equal((await resumed.open()).unsummarizedMessageCount, 20);
  assert.equal(codex.calls.filter(({ method, params }) => method === "turn/start" && params.approvalPolicy === "never").length, 2);
});

test("new utterance cancels summary retry timer and replans once", async (t) => {
  const warnings = t.mock.method(console, "warn");
  const { rootDir, service, conversation, codex } = await fixture(t, { failSummaryCount: 1 });
  await seedPairs(rootDir, conversation.logicalConversationId, 11);
  const resumed = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await resumed.open();
  await waitFor(() => warnings.mock.calls.some(({ arguments: args }) => args[0] === "[voice-context] summary failed"));
  assert.equal((await complete(resumed, conversation, "new utterance")).result.status, "completed");
  const memoryFile = path.join(rootDir, conversation.logicalConversationId, "MEMORY.md");
  await waitFor(async () => (await fs.readFile(memoryFile, "utf8")).includes("summarizedThroughPair=2"));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(codex.calls.filter(({ method, params }) => method === "turn/start" && params.approvalPolicy === "never").length, 2);
});

for (const stage of ["pending_read", "memory_write"]) test(`summary ${stage} permission failure stops retry and closes the store`, async (t) => {
  const warnings = t.mock.method(console, "warn");
  const { rootDir, conversation, codex } = await fixture(t, { reply: "summary" });
  await seedPairs(rootDir, conversation.logicalConversationId, 11);
  const directory = path.join(rootDir, conversation.logicalConversationId);
  const failure = Object.assign(new Error("private path and credential"), { code: stage === "pending_read" ? "EACCES" : "EPERM" });
  if (stage === "pending_read") {
    const readFile = fs.readFile.bind(fs);
    t.mock.method(fs, "readFile", (file, ...args) => String(file) === path.join(directory, "memory-pending.json")
      ? Promise.reject(failure) : readFile(file, ...args));
  } else {
    const rename = fs.rename.bind(fs);
    t.mock.method(fs, "rename", (from, to) => String(to) === path.join(directory, "MEMORY.md")
      ? Promise.reject(failure) : rename(from, to));
  }
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await service.open();
  await waitFor(() => warnings.mock.calls.some(({ arguments: args }) => args[0] === "[voice-context] summary failed"));
  const logged = warnings.mock.calls.find(({ arguments: args }) => args[0] === "[voice-context] summary failed").arguments[1];
  assert.deepEqual(logged, {
    stage: "commit", code: "voice_store_unavailable", attempt: 1, fromPairSeq: 1, throughPairSeq: 1,
  });
  assert.equal(JSON.stringify(warnings.mock.calls).includes("private"), false);
  await assert.rejects(service.open(), { code: "voice_store_unavailable" });
  assert.match(await fs.readFile(path.join(directory, "MEMORY.md"), "utf8"), /summarizedThroughPair=0/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(codex.calls.filter(({ method, params }) => method === "turn/start" && params.approvalPolicy === "never").length, 1);
});

test("restart classifies accepted before dispatch and dispatching as unknown", async (t) => {
  const { rootDir, service, conversation, codex } = await fixture(t);
  const first = randomUUID();
  const second = randomUUID();
  const eventFile = path.join(rootDir, conversation.logicalConversationId, "events.jsonl");
  const at = new Date().toISOString();
  await fs.appendFile(eventFile, [
    { seq: 1, at, clientOperationId: first, type: "accepted", text: "first" },
    { seq: 2, at, clientOperationId: second, type: "accepted", text: "second" },
    { seq: 3, at, clientOperationId: second, type: "dispatching" },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  const restarted = createVoiceContextService({ rootDir, createClient: codex.createClient });
  assert.equal((await restarted.status(conversation.logicalConversationId, first)).status, "preflight_failed");
  assert.equal((await restarted.status(conversation.logicalConversationId, second)).status, "unknown");
  assert.equal((await complete(restarted, conversation, "third")).result.status, "completed");
  assert.equal((await service.open()).contextMode, "self_context_array");
});

test("invalid requests and corrupt committed storage fail closed", async (t) => {
  const { rootDir, service, conversation, codex } = await fixture(t);
  await assert.rejects(service.status(conversation.logicalConversationId, randomUUID()), { code: "not_found" });
  const id = randomUUID();
  await assert.rejects(service.start({ operationId: id, payload: {
    backendId: "codex", logicalConversationId: conversation.logicalConversationId,
    clientOperationId: id, cwd: "/tmp", input: { blocks: [{ type: "text", text: "hi" }] },
  } }, () => {}), { code: "turn_rejected" });
  await assert.rejects(service.start({ operationId: id, payload: {
    backendId: "codex", logicalConversationId: conversation.logicalConversationId,
    clientOperationId: id, input: { blocks: [{ type: "text", text: "😀".repeat(210000) }] },
  } }, () => {}), { code: "turn_rejected" });
  const eventFile = path.join(rootDir, conversation.logicalConversationId, "events.jsonl");
  await fs.appendFile(eventFile, "not-json\n");
  const reopened = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await assert.rejects(reopened.open(), { code: "voice_store_corrupt" });
});

test("a running turn blocks a different ID but replays the same ID", async (t) => {
  const { service, conversation, codex } = await fixture(t, { holdTurns: true });
  const id = randomUUID();
  const message = { operationId: id, payload: {
    backendId: "codex", logicalConversationId: conversation.logicalConversationId,
    clientOperationId: id, input: { blocks: [{ type: "text", text: "hello" }] },
  } };
  let done;
  const terminal = new Promise((resolve) => { done = resolve; });
  assert.equal((await service.start(message, done, async () => "decline")).status, "accepted");
  assert.ok(["accepted", "running"].includes((await service.start(message, () => {})).status));
  const otherId = randomUUID();
  await assert.rejects(service.start({ ...message, operationId: otherId, payload: {
    ...message.payload, clientOperationId: otherId,
  } }, () => {}), { code: "session_busy" });
  while (!codex.releases.length) await new Promise((resolve) => setTimeout(resolve, 1));
  codex.releases.shift()();
  assert.equal((await terminal).status, "completed");
  assert.equal(codex.calls.filter(({ method }) => method === "turn/start").length, 1);
});

test("unfinished trailing event line is preserved and excluded on restart", async (t) => {
  const { rootDir, conversation, codex } = await fixture(t);
  const directory = path.join(rootDir, conversation.logicalConversationId);
  const trailing = Buffer.from([123, 34, 115, 101, 113, 34, 58, 49, 44, 255]);
  await fs.appendFile(path.join(directory, "events.jsonl"), trailing);
  const restarted = createVoiceContextService({ rootDir, createClient: codex.createClient });
  assert.equal((await restarted.open()).logicalConversationId, conversation.logicalConversationId);
  const backup = (await fs.readdir(directory)).find((name) => name.startsWith("events-trailing-"));
  assert.ok(backup);
  assert.deepEqual(await fs.readFile(path.join(directory, backup)), trailing);
  assert.equal((await complete(restarted, conversation, "after recovery")).result.status, "completed");
});

test("large unsummarized context fails explicitly without truncating a completed pair", async (t) => {
  const { rootDir, service, conversation, codex } = await fixture(t, { reply: "R".repeat(800000) });
  assert.equal((await complete(service, conversation, "first")).result.status, "completed");
  const before = codex.calls.filter(({ method }) => method === "turn/start").length;
  const second = await complete(service, conversation, "second");
  assert.equal(second.result.status, "preflight_failed");
  assert.equal(codex.calls.filter(({ method }) => method === "turn/start").length, before);
  const events = (await fs.readFile(path.join(rootDir, conversation.logicalConversationId, "events.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(events.find((event) => event.type === "completed").text.length, 800000);
  assert.equal(events.at(-1).code, "voice_context_too_large");
});

test("tool events do not interrupt a spoken reply", async (t) => {
  const { rootDir, service, conversation, codex } = await fixture(t, { toolItem: true });
  const result = await complete(service, conversation, "hello");
  assert.equal(result.result.status, "completed");
  assert.equal(codex.calls.some(({ method }) => method === "turn/interrupt"), false);
  const events = (await fs.readFile(path.join(rootDir, conversation.logicalConversationId, "events.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(events.some((event) => event.type === "completed"), true);
});

test("ordinary userMessage notifications do not trigger the tool guard", async (t) => {
  const { service, conversation } = await fixture(t, { userItem: true });
  assert.equal((await complete(service, conversation, "hello")).result.status, "completed");
});

test("missing ephemeral capability fails without starting a native turn", async (t) => {
  const { service, conversation, codex } = await fixture(t, { ephemeral: false });
  const result = await complete(service, conversation, "hello");
  assert.equal(result.result.status, "failed");
  assert.equal(result.result.code, "capability_unsupported");
  assert.equal(codex.calls.some(({ method }) => method === "turn/start"), false);
});

test("failed events identify the guarded voice stage without recording private details", async (t) => {
  const cases = [
    [{ ephemeral: false }, "thread_start", "ephemeral_unavailable"],
    [{ missingTurnId: true }, "turn_start", "turn_id_unavailable"],
  ];
  for (const [options, stage, reason] of cases) {
    await t.test(`${stage}: ${reason}`, async (child) => {
      const { rootDir, service, conversation, codex } = await fixture(child, options);
      const { result, message } = await complete(service, conversation, "private conversation text");
      assert.equal(result.status, "failed");
      assert.equal(result.code, "capability_unsupported");
      const eventFile = path.join(rootDir, conversation.logicalConversationId, "events.jsonl");
      const raw = await fs.readFile(eventFile, "utf8");
      const failureLine = raw.trim().split("\n").at(-1);
      const failure = JSON.parse(failureLine);
      assert.deepEqual({ stage: failure.stage, reason: failure.reason }, { stage, reason });
      assert.equal(failureLine.includes("private"), false);
      const reopened = createVoiceContextService({ rootDir, createClient: codex.createClient });
      assert.equal((await reopened.status(conversation.logicalConversationId, message.operationId)).code, result.code);
    });
  }
});

for (const missing of ["directory", "events.jsonl", "MEMORY.md"]) {
  test(`existing active conversation rejects missing ${missing} without regenerating`, async (t) => {
    const { rootDir, service, conversation, codex } = await fixture(t);
    const completed = await complete(service, conversation, "preserved operation");
    const generated = codex.calls.filter(({ method }) => method === "turn/start").length;
    const directory = path.join(rootDir, conversation.logicalConversationId);
    const target = missing === "directory" ? directory : path.join(directory, missing);
    await fs.rm(target, { recursive: missing === "directory" });
    const reopened = createVoiceContextService({ rootDir, createClient: codex.createClient });
    await assert.rejects(reopened.open(), { code: "voice_store_corrupt" });
    await assert.rejects(reopened.start(completed.message, () => {}), { code: "voice_store_corrupt" });
    assert.equal(codex.calls.filter(({ method }) => method === "turn/start").length, generated);
    assert.equal(await fs.stat(target).then(() => true, () => false), false);
  });
}

test("initialization interrupted before active publication stays fail closed", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-context-interrupted-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const orphan = path.join(rootDir, randomUUID());
  await fs.mkdir(orphan, { mode: 0o700 });
  await fs.writeFile(path.join(orphan, "events.jsonl"), "", { mode: 0o600 });
  const codex = fakeCodex();
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await assert.rejects(service.open(), { code: "voice_store_corrupt" });
  assert.equal(await fs.stat(path.join(rootDir, "active.json")).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(orphan, "events.jsonl")).then(() => true, () => false), true);
  assert.equal(codex.calls.length, 0);
});

test("existing empty v1 root without active also stays fail closed", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-context-empty-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const codex = fakeCodex();
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await assert.rejects(service.open(), { code: "voice_store_corrupt" });
  assert.deepEqual(await fs.readdir(rootDir), []);
});

test("50+ messages stay ordered until durable summary; canceled stale result cannot commit", async (t) => {
  const { rootDir, conversation, codex } = await fixture(t, { holdSummaries: true, ignoreAbort: true, reply: "要約😀" });
  await seedPairs(rootDir, conversation.logicalConversationId, 25);
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await service.open();
  await waitFor(() => codex.summaryReleases.length === 1);
  const firstSummary = codex.summaryReleases.shift();
  const staleSummaryCwd = codex.calls.find(({ method, params }) => method === "thread/start" && params.approvalPolicy === "never").params.cwd;
  const completed = await complete(service, conversation, "user-26");
  assert.equal(completed.result.status, "completed");
  assert.equal(completed.result.unsummarizedMessageCount, 52);
  const injection = codex.calls.filter(({ method }) => method === "thread/inject_items").at(-1).params.items;
  assert.equal(injection.length, 50);
  assert.deepEqual(injection.map((item) => item.content[0].text),
    Array.from({ length: 25 }, (_, index) => [`user-${index + 1}`, `assistant-${index + 1}`]).flat());
  await waitFor(() => codex.summaryReleases.length === 1);
  const memoryFile = path.join(rootDir, conversation.logicalConversationId, "MEMORY.md");
  assert.match(await fs.readFile(memoryFile, "utf8"), /summarizedThroughPair=0/);
  codex.summaryReleases.shift()();
  await waitFor(async () => (await fs.readFile(memoryFile, "utf8")).includes("summarizedThroughPair=16"));
  firstSummary();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await waitFor(async () => !(await fs.stat(staleSummaryCwd).then(() => true, () => false)));
  assert.match(await fs.readFile(memoryFile, "utf8"), /summarizedThroughPair=16/);
  const next = await complete(service, conversation, "user-27");
  assert.equal(next.result.status, "completed");
  assert.equal(next.result.memoryCharacterCount, Array.from("要約😀").length);
  assert.equal(next.result.unsummarizedMessageCount, 22);
  assert.equal((await service.status(conversation.logicalConversationId, next.message.operationId)).memoryCharacterCount, 3);
  const after = codex.calls.filter(({ method }) => method === "thread/inject_items").at(-1).params.items;
  assert.equal(after[0].content[0].text, "Previous conversation summary:\n要約😀");
  assert.deepEqual(after.slice(1).map((item) => item.content[0].text),
    Array.from({ length: 10 }, (_, index) => [`user-${index + 17}`, index === 9 ? "要約😀" : `assistant-${index + 17}`]).flat());
  const events = (await fs.readFile(path.join(rootDir, conversation.logicalConversationId, "events.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(events.filter((event) => event.type === "completed").length, 27);
  await waitFor(() => codex.summaryReleases.length === 1);
  codex.summaryReleases.shift()();
  await waitFor(async () => (await fs.readFile(memoryFile, "utf8")).includes("summarizedThroughPair=17"));
});

test("a 20-to-50-plus message burst never waits for a held summary or omits backlog", async (t) => {
  const { rootDir, conversation, service, codex } = await fixture(t, { holdSummaries: true });
  for (let number = 1; number <= 26; number++) {
    assert.equal((await complete(service, conversation, `burst-${number}`)).result.status, "completed");
  }
  assert.equal((await service.open()).unsummarizedMessageCount, 52);
  const injected = codex.calls.filter(({ method }) => method === "thread/inject_items").at(-1).params.items;
  assert.equal(injected.length, 50);
  assert.deepEqual(injected.filter((item) => item.role === "user").map((item) => item.content[0].text),
    Array.from({ length: 25 }, (_, index) => `burst-${index + 1}`));
  assert.match(await fs.readFile(path.join(rootDir, conversation.logicalConversationId, "MEMORY.md"), "utf8"),
    /summarizedThroughPair=0/);
  await waitFor(() => codex.summaryReleases.length > 0);
  for (const finish of codex.summaryReleases.splice(0)) finish();
  await waitFor(async () => (await fs.readFile(path.join(rootDir, conversation.logicalConversationId, "MEMORY.md"), "utf8"))
    .includes("summarizedThroughPair=16"));
});

test("restart retains backlog and reclaims only summary temporary directories", async (t) => {
  const { rootDir, conversation, codex } = await fixture(t, { holdSummaries: true });
  await seedPairs(rootDir, conversation.logicalConversationId, 25);
  const tempRoot = path.join(path.dirname(rootDir), "ephemeral-tmp");
  const orphan = path.join(tempRoot, "summary-abcdef");
  await fs.mkdir(orphan);
  await fs.writeFile(path.join(orphan, "scratch"), "temporary");
  await fs.writeFile(path.join(tempRoot, "keep.txt"), "not a turn");
  const protectedDirectory = path.join(tempRoot, "protected");
  await fs.mkdir(protectedDirectory);
  await fs.writeFile(path.join(protectedDirectory, "keep"), "protected");
  await fs.symlink(protectedDirectory, path.join(tempRoot, "summary-zzzzzz"));
  const legacyTurn = path.join(tempRoot, "turn-abcdef");
  await fs.mkdir(legacyTurn);
  await fs.writeFile(path.join(legacyTurn, "keep"), "possibly user data");
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  const opened = await service.open();
  assert.equal(opened.unsummarizedMessageCount, 50);
  assert.equal(opened.memoryCharacterCount, 0);
  assert.equal(await fs.stat(orphan).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(tempRoot, "keep.txt"), "utf8"), "not a turn");
  assert.equal(await fs.readFile(path.join(protectedDirectory, "keep"), "utf8"), "protected");
  assert.equal((await fs.lstat(path.join(tempRoot, "summary-zzzzzz"))).isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(legacyTurn, "keep"), "utf8"), "possibly user data");
  await waitFor(() => codex.summaryReleases.length > 0);
  const result = await complete(service, conversation, "after-restart");
  assert.equal(result.result.status, "completed");
  const items = codex.calls.filter(({ method }) => method === "thread/inject_items").at(-1).params.items;
  assert.equal(items.length, 50);
  assert.equal(items[0].content[0].text, "user-1");
  assert.equal(items.at(-1).content[0].text, "assistant-25");
  await waitFor(() => codex.summaryReleases.length >= 2);
  for (const finish of codex.summaryReleases.splice(0)) finish();
  await waitFor(async () => (await fs.readFile(path.join(rootDir, conversation.logicalConversationId, "MEMORY.md"), "utf8"))
    .includes("summarizedThroughPair=16"));
});

test("Unicode byte guard rejects near model input limit without pruning", async (t) => {
  const { service, conversation, codex } = await fixture(t);
  const first = await complete(service, conversation, "first");
  assert.equal(first.result.status, "completed");
  const clientOperationId = randomUUID();
  await assert.rejects(service.start({ operationId: clientOperationId, payload: {
    backendId: "codex", logicalConversationId: conversation.logicalConversationId, clientOperationId,
    input: { blocks: [{ type: "text", text: "界".repeat(266600) }] },
  } }, () => {}), { code: "turn_rejected" });
  assert.equal(codex.calls.filter(({ method }) => method === "turn/start").length, 1);
  const status = await service.status(conversation.logicalConversationId, first.message.operationId);
  assert.equal(status.unsummarizedMessageCount, 2);
  assert.equal(status.estimatedContextUsagePercent, 1);
});

test("pending summary write failure makes the store fail closed", async (t) => {
  const { rootDir, conversation, codex } = await fixture(t);
  await seedPairs(rootDir, conversation.logicalConversationId, 11);
  await fs.mkdir(path.join(rootDir, conversation.logicalConversationId, "memory-pending.json"));
  const service = createVoiceContextService({ rootDir, createClient: codex.createClient });
  await service.open();
  await waitFor(async () => {
    try { await service.open(); return false; }
    catch (error) { return error.code === "voice_store_unavailable"; }
  });
  assert.equal(codex.calls.filter(({ method }) => method === "turn/start").length, 0);
  const id = randomUUID();
  await assert.rejects(service.start({ operationId: id, payload: {
    backendId: "codex", logicalConversationId: conversation.logicalConversationId, clientOperationId: id,
    input: { blocks: [{ type: "text", text: "no dispatch" }] },
  } }, () => {}), { code: "voice_store_unavailable" });
});
