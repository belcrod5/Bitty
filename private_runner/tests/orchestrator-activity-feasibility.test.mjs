import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createAgentHttpHandler } from "../src/agent/agent-transport.mjs";
import { createVoiceOrchestratorService } from "../src/voice-orchestrator-service.mjs";
import { createVoiceContextService } from "../src/voice-context-service.mjs";
import { parseLlmSessionRelationship } from "../src/llm-session-metadata.mjs";

const NATIVE_TOOL_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall",
  "dynamicToolCall", "collabAgentToolCall", "webSearch", "imageView"]);

function nativeToolEvent(method, params) {
  if (!["item/started", "item/completed"].includes(method)
    || !NATIVE_TOOL_TYPES.has(params?.item?.type)
    || !params?.threadId || !params?.turnId || !params?.item?.id) return null;
  const exitCode = params.item.exitCode ?? params.item.exit_code;
  return { phase: method === "item/started" ? "started" : "completed",
    key: `${params.threadId}:${params.turnId}:${params.item.id}`,
    type: params.item.type,
    status: params.item.status === "failed" || params.item.status === "declined"
      || (typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0)
      ? "failed" : params.item.status || "unknown" };
}

async function registeredRootOf(caller, roots, cache, read) {
  const visited = new Set();
  let current = caller;
  while (true) {
    if (roots.has(current)) {
      for (const id of visited) cache.set(id, current);
      return current;
    }
    if (!current || visited.has(current)) return null;
    visited.add(current);
    if (cache.has(current)) {
      current = cache.get(current);
      continue;
    }
    if (visited.size > 10) return null;
    const thread = await read(current);
    if (thread?.id !== current || !thread.parentThreadId) return null;
    current = thread.parentThreadId;
  }
}

test("candidate native parent cache compresses 1/3/10 depths and rejects invalid ancestry", async () => {
  for (const depth of [1, 3, 10]) {
    const parents = new Map();
    const ids = Array.from({ length: depth }, (_, index) => `child-${depth}-${index}`);
    ids.forEach((id, index) => parents.set(id, ids[index + 1] || "root"));
    const roots = new Map([["root", { icon: "registered" }]]);
    const cache = new Map();
    let reads = 0;
    const read = async (id) => { reads++; return { id, parentThreadId: parents.get(id) }; };
    assert.equal(await registeredRootOf(ids[0], roots, cache, read), "root");
    assert.equal(reads, depth);
    assert.equal(await registeredRootOf(ids[0], roots, cache, read), "root");
    assert.equal(reads, depth);
    assert.equal(cache.size, depth);
    roots.clear();
    assert.equal(await registeredRootOf(ids[0], roots, cache, read), null);
  }
  const longParents = new Map(Array.from({ length: 11 }, (_, index) =>
    [`long-${index}`, index === 10 ? "root" : `long-${index + 1}`]));
  let longReads = 0;
  const longCache = new Map();
  assert.equal(await registeredRootOf("long-0", new Map([["root", {}]]), longCache, async (id) => {
    longReads++;
    return { id, parentThreadId: longParents.get(id) };
  }), null);
  assert.equal(longReads, 10);
  assert.equal(longCache.size, 0);
  for (const parents of [new Map(), new Map([["child", "cycle"], ["cycle", "child"]]),
    new Map([["child", "root"]])]) {
    const roots = new Map([["root", { icon: "registered" }]]);
    const cache = new Map();
    const read = async (id) => ({
      id: parents.get(id) === "root" && parents.size === 1 ? "wrong-id" : id,
      parentThreadId: parents.get(id),
    });
    assert.equal(await registeredRootOf("child", roots, cache, read), null);
    assert.equal(cache.size, 0);
  }
  console.log(JSON.stringify({ gate: "candidate_native_parent_cache", status: "synthetic",
    depths: [1, 3, 10], warmRpc: 0, invalidChainsUnknown: 4,
    registrationRemovalUnknown: true }));
});

test("native item event candidate preserves all existing tool kinds and triple identity", () => {
  for (const type of NATIVE_TOOL_TYPES) {
    const params = { threadId: "child", turnId: "turn", item: { id: `tool-${type}`, type,
      status: "completed", exitCode: 0 } };
    const started = nativeToolEvent("item/started", params);
    const ended = nativeToolEvent("item/completed", params);
    assert.equal(started?.type, type);
    assert.equal(started?.key, ended?.key);
    assert.equal(ended?.status, "completed");
    assert.notEqual(started.key, nativeToolEvent("item/started",
      { ...params, threadId: "other-child" }).key);
  }
  for (const type of ["reasoning", "agentMessage", "userMessage", "subAgentActivity"]) {
    assert.equal(nativeToolEvent("item/started", { threadId: "child", turnId: "turn",
      item: { id: "x", type } }), null);
  }
  assert.equal(nativeToolEvent("item/completed", { threadId: "child", turnId: "turn",
    item: { id: "failed", type: "commandExecution", status: "failed", exitCode: 1 } }).status, "failed");
  console.log(JSON.stringify({ gate: "candidate_native_tool_normalization", status: "synthetic",
    mappedToolKinds: NATIVE_TOOL_TYPES.size, nonToolKindsRejected: 4 }));
});

// Drive the public voice service through its native server-request handler. IDs and
// parent replies below are synthetic; this does not prove caller identity in Runner.
async function nativeFixture(t, requests, parents, childToolThreadId) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "activity-voice-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  let root = randomUUID();
  let responseThreadStarts = 0;
  const reads = [];
  const results = [];
  const notifications = [];
  const createClient = () => {
    let listener = () => {};
    let handler = () => undefined;
    let finish;
    return {
      openPromise: Promise.resolve(),
      notify() {},
      close() { finish?.(); },
      addNotificationListener(next) { listener = next; return () => { listener = () => {}; }; },
      addServerRequestHandler(next) { handler = next; return () => { handler = () => undefined; }; },
      waitForTurnCompletion() { return { expect() {}, promise: new Promise((resolve) => { finish = resolve; }) }; },
      async request(method, params) {
        if (method === "config/read") return { config: { mcp_servers: {} } };
        if (method === "modelProvider/capabilities/read") return { namespaceTools: true };
        if (method === "model/list") return { data: [{ model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] };
        if (method === "thread/start") {
          if (params.approvalPolicy !== "never" && responseThreadStarts++ > 0) root = randomUUID();
          return { thread: { id: root, ephemeral: true } };
        }
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null };
        if (method === "thread/read") {
          reads.push(params.threadId);
          return { thread: { id: parents[params.threadId]?.id ?? params.threadId,
            parentThreadId: parents[params.threadId]?.parent } };
        }
        if (method === "turn/start") {
          const turnId = randomUUID();
          queueMicrotask(async () => {
            for (const threadId of requests) {
              const result = await handler({ id: randomUUID(), method: "item/commandExecution/requestApproval",
                params: { threadId, turnId: randomUUID(), command: "true" } });
              results.push(result);
            }
            if (childToolThreadId) for (const method of ["item/started", "item/completed"]) {
              listener(method, { threadId: childToolThreadId, turnId: randomUUID(),
                item: { id: "child-tool", type: "commandExecution" } });
            }
            if (childToolThreadId) listener("item/completed", { threadId: childToolThreadId,
              turnId: randomUUID(), item: { type: "agentMessage", text: "child-only" } });
            listener("item/completed", { threadId: root, turnId, item: { type: "agentMessage", text: "done" } });
            listener("turn/completed", { threadId: root, turnId, turn: { status: "completed" } });
            finish();
          });
          return { turn: { id: turnId } };
        }
        return {};
      },
    };
  };
  const service = createVoiceContextService({ rootDir: path.join(temp, "voice"), createClient });
  const conversation = await service.open();
  return { get root() { return root; }, temp, createClient, reads, results, notifications, async run(hooks = {}) {
    const id = randomUUID();
    let done;
    const terminal = new Promise((resolve) => { done = resolve; });
    await service.start({ operationId: id, payload: { backendId: "codex",
      logicalConversationId: conversation.logicalConversationId, clientOperationId: id,
      input: { blocks: [{ type: "text", text: "check" }] } } }, (result) => {
      notifications.push(result);
      done(result);
    }, async () => "accept", hooks);
    return terminal;
  } };
}

test("actual voice ownsRequest verifies native parentage, caches owned children, and rejects bad chains", async (t) => {
  for (const depth of [1, 3, 10]) {
    await t.test(`depth ${depth}`, async (s) => {
      const ids = Array.from({ length: depth }, () => randomUUID());
      const parents = Object.fromEntries(ids.map((id, i) => [id, { parent: ids[i + 1] || "ROOT" }]));
      const sibling = depth === 1 ? randomUUID() : null;
      if (sibling) parents[sibling] = { parent: "ROOT" };
      const requests = sibling ? [ids[0], sibling, ids[0], sibling] : [ids[0], ids[0]];
      const fixture = await nativeFixture(s, requests, parents);
      parents[ids.at(-1)].parent = fixture.root;
      if (sibling) parents[sibling].parent = fixture.root;
      assert.equal((await fixture.run()).status, "completed");
      assert.deepEqual(fixture.results, requests.map(() => ({ decision: "accept" })));
      assert.deepEqual(fixture.reads, sibling ? [ids[0], sibling] : ids);
      console.log(JSON.stringify({ gate: "voice_owns_request", depth, independentChildren: sibling ? 2 : 1,
        coldThreadReadRpcPerChild: depth, coldThreadReadRpcTotal: fixture.reads.length,
        warmThreadReadRpcPerChild: 0 }));
    });
  }
  const missing = randomUUID();
  const cycleA = randomUUID();
  const cycleB = randomUUID();
  const mismatch = randomUUID();
  const fixture = await nativeFixture(t, [missing, cycleA, mismatch], {
    [cycleA]: { parent: cycleB }, [cycleB]: { parent: cycleA },
    [mismatch]: { id: randomUUID(), parent: "ROOT" },
  });
  assert.equal((await fixture.run()).status, "completed");
  assert.deepEqual(fixture.results, [{ decision: "decline" }, { decision: "decline" }, { decision: "decline" }]);
  assert.deepEqual(fixture.reads, [missing, cycleA, cycleB, mismatch]);
});

test("metadata parser exposes parent and fork fields without establishing trusted parentage", () => {
  assert.deepEqual(parseLlmSessionRelationship({ parent_thread_id: "native-parent", forked_from_id: "fork" }),
    { isSubagent: true, parentSessionId: "native-parent" });
  assert.deepEqual(parseLlmSessionRelationship({ forked_from_id: "fork" }),
    { isSubagent: true, parentSessionId: "fork" });
});

test("HTTP shared bearer authenticates, while self-reported caller IDs do not become context", async () => {
  const received = [];
  const handler = createAgentHttpHandler({
    service: { async listSessions(options, context) { received.push({ options, context }); return { sessions: [] }; } },
    runnerToken: "synthetic-token", parseAuthToken: (req) => req.token || "",
    json: (res, statusCode, payload) => { res.statusCode = statusCode; res.payload = payload; },
    normalizeSessionListLimit: () => 20,
    subjectId: "synthetic-owner",
  });
  const url = new URL("http://runner.test/agent/sessions?backendId=codex&callerSessionId=forged-child");
  const invalid = {};
  await handler({ method: "GET", token: "wrong", body: { callerSessionId: "forged-child" } },
    invalid, url, url.pathname);
  assert.equal(invalid.statusCode, 401);
  assert.equal(received.length, 0);
  const valid = {};
  await handler({ method: "GET", token: "synthetic-token", body: { callerSessionId: "forged-child" } },
    valid, url, url.pathname);
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(received, [{ options: { backendId: "codex", cwd: "", cursor: "", limit: 20 },
    context: { subjectId: "synthetic-owner" } }]);
  console.log(JSON.stringify({ gate: "http_shared_bearer_baseline", status: "pass",
    callerAttachment: "absent", selfReportedCallerAccepted: false }));
});

test("registered orchestrator hooks expose fresh synthetic native roots while public status omits them", async (t) => {
  const fixture = await nativeFixture(t, [], {});
  const service = createVoiceOrchestratorService({ rootDir: path.join(fixture.temp, "orchestrators"),
    createClient: fixture.createClient });
  const pngHeader = Buffer.from("89504e470d0a1a0a", "hex");
  const iconA = `data:image/png;base64,${Buffer.concat([pngHeader, Buffer.from([1])]).toString("base64")}`;
  const iconB = `data:image/png;base64,${Buffer.concat([pngHeader, Buffer.from([2])]).toString("base64")}`;
  const a = await service.create("A", iconA);
  const b = await service.create("B", iconB);
  const started = [];
  for (const item of [a, b, a]) {
    const conversation = await service.open(item.id);
    const operationId = randomUUID();
    let done;
    const terminal = new Promise((resolve) => { done = resolve; });
    await service.start({ operationId, payload: { orchestratorId: item.id, backendId: "codex",
      logicalConversationId: conversation.logicalConversationId, clientOperationId: operationId,
      input: { blocks: [{ type: "text", text: "check" }] } } }, done, async () => "decline",
    { onStarted: ({ threadId, turnId }) => started.push({ orchestratorId: item.id, threadId, turnId }) });
    assert.equal((await terminal).status, "completed");
    const status = await service.status(item.id, conversation.logicalConversationId, operationId);
    assert.equal("threadId" in status, false);
    assert.equal("turnId" in status, false);
    const events = (await fs.readFile(path.join(fixture.temp, "orchestrators", "orchestrators",
      item.id, conversation.logicalConversationId, "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.filter((event) => event.clientOperationId === operationId
      && event.type === "native_started").map(({ threadId, turnId }) => ({ threadId, turnId })),
    [{ threadId: started.at(-1).threadId, turnId: started.at(-1).turnId }]);
  }
  assert.equal(new Set(started.map(({ threadId }) => threadId)).size, 3);
  assert.deepEqual(started.map(({ orchestratorId }) => orchestratorId), [a.id, b.id, a.id]);
  const listed = (await service.list()).orchestrators;
  assert.equal(listed.find(({ id }) => id === a.id).icon, iconA);
  assert.equal(listed.find(({ id }) => id === b.id).icon, iconB);
  console.log(JSON.stringify({ gate: "synthetic_registered_native_started", status: "pass",
    orchestrators: 2, started: 3, rootRotationObserved: true, publicStatusHasNativeId: false }));
});

test("voice result filters synthetic child item notifications even when approval ancestry succeeds", async (t) => {
  const child = randomUUID();
  const parents = { [child]: { parent: "ROOT" } };
  const fixture = await nativeFixture(t, [child], parents, child);
  parents[child].parent = fixture.root;
  const text = [];
  const result = await fixture.run({ onText: (part) => text.push(part) });
  assert.equal(result.status, "completed");
  assert.equal(result.text, "done");
  assert.equal(text.includes("child-only"), false);
  assert.deepEqual(fixture.results, [{ decision: "accept" }]);
  assert.equal(fixture.notifications.length, 1);
  assert.equal(fixture.notifications[0].status, "completed");
  console.log(JSON.stringify({ gate: "voice_root_observer_child_text_filter", status: "observed",
    syntheticChildItemEvents: 2, childTextIncluded: false, publicNotifications: 1, childApprovalOwned: true,
    nativeChildToolStreamGate: "unverified" }));
});

test("opt-in read-only App Server native ancestry probe", {
  skip: process.env.BITTY_ACTIVITY_LIVE_PROBE === "1" ? false : "set BITTY_ACTIVITY_LIVE_PROBE=1",
}, async () => {
  const nativeId = process.env.CODEX_THREAD_ID;
  assert.ok(nativeId, "native thread environment ID unavailable");
  const fingerprint = (value) => value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : null;
  const socket = new WebSocket("ws://127.0.0.1:4500");
  const pending = new Map();
  let notifications = 0;
  let unclassifiedItemNotifications = 0;
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error("read-only App Server RPC rejected"));
      else request.resolve(message.result);
    } else {
      notifications++;
      if (message.method === "item/started" || message.method === "item/completed") {
        unclassifiedItemNotifications++;
      }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    assert.ok(method === "initialize" || method === "thread/read", "non-read RPC blocked");
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("read-only probe timed out")), 5000);
  });
  try {
    await Promise.race([(async () => {
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("read-only App Server connection failed")), { once: true });
      });
      await rpc("initialize", { clientInfo: { name: "bitty-activity-probe", title: "Bitty Activity Probe", version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] } });
      socket.send(JSON.stringify({ method: "initialized", params: {} }));
      const samples = [];
      let first;
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        const result = await rpc("thread/read", { threadId: nativeId, includeTurns: false });
        samples.push(performance.now() - start);
        assert.ok(result?.thread?.id === nativeId, "native thread read ID mismatch");
        if (!first) first = result;
        else assert.ok(result.thread.parentThreadId === first.thread.parentThreadId,
          "native parent changed during probe");
      }
      let parent = first.thread.parentThreadId;
      const firstParent = parent;
      const visited = new Set([nativeId]);
      let pathRpc = 1;
      while (parent && !visited.has(parent) && pathRpc < 10) {
        visited.add(parent);
        const result = await rpc("thread/read", { threadId: parent, includeTurns: false });
        pathRpc++;
        assert.ok(result?.thread?.id === parent, "ancestor thread read ID mismatch");
        parent = result.thread.parentThreadId;
      }
      const fresh = [];
      let freshRpc = 0;
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        const cache = new Map();
        let current = nativeId;
        while (current && !cache.has(current) && cache.size < 10) {
          const result = await rpc("thread/read", { threadId: current, includeTurns: false });
          freshRpc++;
          assert.ok(result?.thread?.id === current, "fresh ancestor read ID mismatch");
          cache.set(current, result.thread.parentThreadId || null);
          current = result.thread.parentThreadId;
        }
        assert.ok(!current, "fresh ancestor lookup did not reach a root");
        fresh.push(performance.now() - start);
      }
      const sorted = samples.toSorted((a, b) => a - b);
      const sortedFresh = fresh.toSorted((a, b) => a - b);
      console.log(JSON.stringify({ gate: "live_native_read_component", status: "observed",
        environmentThreadFingerprint: fingerprint(nativeId), parentRefFingerprint: fingerprint(firstParent),
        inheritedSessionFingerprint: fingerprint(process.env.CODEX_SESSION_ID),
        parentEqualsInheritedSession: Boolean(firstParent && firstParent === process.env.CODEX_SESSION_ID),
        threadReadResponseIdMatches: samples.length, stableParent: true,
        sampledNativeReadRpc: samples.length, pathLookupRpc: pathRpc,
        freshLookupRuns: fresh.length, freshLookupThreadReadRpc: freshRpc,
        totalThreadReadRpc: samples.length + pathRpc - 1 + freshRpc,
        pathTerminal: !parent ? "root" : visited.has(parent) ? "cycle" : "depth_limit",
        readRpcP50Ms: Number(sorted[9].toFixed(3)), readRpcP95Ms: Number(sorted[18].toFixed(3)),
        readRpcMaxMs: Number(sorted[19].toFixed(3)),
        freshLookupP50Ms: Number(sortedFresh[9].toFixed(3)),
        freshLookupP95Ms: Number(sortedFresh[18].toFixed(3)),
        freshLookupMaxMs: Number(sortedFresh[19].toFixed(3)), notifications, unclassifiedItemNotifications,
        autoCallerGate: "unverified", childToolEventsGate: "unverified" }));
    })(), timeout]);
  } finally {
    clearTimeout(timer);
    socket.close();
  }
});

test("opt-in installed CLI display-caller annotation candidate keeps Runner ownership fixed", {
  skip: process.env.BITTY_ACTIVITY_CLI_PROBE === "1" ? false : "set BITTY_ACTIVITY_CLI_PROBE=1",
}, async () => {
  assert.ok(process.env.CODEX_THREAD_ID, "native thread environment ID unavailable");
  const sourcePath = path.join(os.homedir(), ".codex/skills/bitty-session-orchestrator/scripts/bitty-session.mjs");
  let source = await fs.readFile(sourcePath, "utf8");
  const edits = [
    ['headers: { authorization: `Bearer ${token}`,',
      'headers: { authorization: `Bearer ${token}`, ...(process.env.CODEX_THREAD_ID ? { "x-bitty-display-caller": process.env.CODEX_THREAD_ID } : {}),'],
    ['new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });',
      'new WebSocket(url, { headers: { authorization: `Bearer ${token}`, ...(process.env.CODEX_THREAD_ID ? { "x-bitty-display-caller": process.env.CODEX_THREAD_ID } : {}) } });'],
    ['console.log(JSON.stringify(result));',
      'console.log(JSON.stringify({ workspaceCount: Array.isArray(result.workspaces) ? result.workspaces.length : null }));'],
    ['console.error(String(error.message || error));', 'console.error("installed CLI probe failed");'],
    ['main().catch((error) => {', 'await main().catch((error) => {'],
  ];
  for (const [before, after] of edits) {
    assert.equal(source.split(before).length, 2, "installed CLI source anchor changed");
    source = source.replace(before, after);
  }
  const bootstrap = String.raw`
    import { pathToFileURL } from "node:url";
    import path from "node:path";
    const fail = () => { throw new Error("candidate probe failed"); };
    try {
      let encoded = "";
      for await (const chunk of process.stdin) encoded += chunk;
      const originalFetch = globalThis.fetch;
      let headers;
      let status;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.origin !== "http://127.0.0.1:8788" || url.pathname !== "/agent/workspaces"
          || url.search || (init.method || "GET") !== "GET" || init.body !== undefined || headers) fail();
        headers = { ...init.headers };
        const response = await originalFetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(5000) });
        status = response.status;
        return response;
      };
      let output;
      console.log = (value) => { output = JSON.parse(value); };
      console.error = fail;
      process.argv = [process.execPath, "bitty-session.mjs", "workspaces"];
      await import("data:text/javascript;base64," + encoded);
      if (!Number.isSafeInteger(output?.workspaceCount) || status !== 200
        || headers?.["x-bitty-display-caller"] !== process.env.CODEX_THREAD_ID) fail();
      const token = String(headers.authorization || "").replace(/^Bearer /, "");
      if (!token || token === headers.authorization) fail();
      const { createAgentHttpHandler } = await import(pathToFileURL(path.join(process.cwd(),
        "private_runner/src/agent/agent-transport.mjs")));
      const owners = [];
      const handler = createAgentHttpHandler({ service: {}, runnerToken: token,
        parseAuthToken: (req) => String(req.headers?.authorization || "").replace(/^Bearer /, ""),
        json: (res, code) => { res.statusCode = code; },
        workspaceAdmission: { async list(subjectId) { owners.push(subjectId); return []; } },
        subjectId: "fixed-owner" });
      const url = new URL("http://runner.test/agent/workspaces?callerSessionId=forged");
      for (const candidate of [headers, { ...headers, "x-bitty-display-caller": "forged" },
        { authorization: headers.authorization }]) {
        const response = {};
        await handler({ method: "GET", headers: candidate, body: { callerSessionId: "forged" } },
          response, url, url.pathname);
        if (response.statusCode !== 200) fail();
      }
      const invalid = {};
      await handler({ method: "GET", headers: { authorization: "Bearer invalid" } },
        invalid, url, url.pathname);
      if (invalid.statusCode !== 401 || owners.length !== 3 || owners.some((owner) => owner !== "fixed-owner")) fail();
      process.stdout.write(JSON.stringify({ runnerHttpStatus: status, workspaceCount: output.workspaceCount,
        annotationMatchesEnvironment: true, ownerStable: true, invalidBearerRejected: true }));
    } catch { process.stderr.write("candidate probe failed\n"); process.exitCode = 1; }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", bootstrap], {
    cwd: process.cwd(), stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.end(Buffer.from(source).toString("base64"));
  const result = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("candidate CLI probe timed out")); }, 7000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 1024) { child.kill(); reject(new Error("candidate CLI output exceeded limit")); }
    });
    child.on("error", () => { clearTimeout(timer); reject(new Error("candidate CLI process failed")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("candidate CLI process failed"));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("candidate CLI output shape changed")); }
    });
  });
  assert.equal(result.runnerHttpStatus, 200);
  assert.ok(result.annotationMatchesEnvironment && result.ownerStable && result.invalidBearerRejected);
  console.log(JSON.stringify({ gate: "candidate_cli_display_annotation", status: "observed",
    runnerHttpStatus: result.runnerHttpStatus, annotationMatchesEnvironment: true,
    ownerStable: true, invalidBearerRejected: true, productAutoCallerGate: "unverified" }));
});

test("opt-in ephemeral registered root and two native child CLI tools", {
  skip: process.env.BITTY_ACTIVITY_EPHEMERAL_PROBE === "1" ? false : "set BITTY_ACTIVITY_EPHEMERAL_PROBE=1",
}, async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "activity-native-")));
  const installedRunner = process.env.BITTY_REPO_ROOT || "/Volumes/SSD-500GB-SanDisk/work/bitty-public";
  const clientModule = "private_runner/src/codex-app-server-client.mjs";
  assert.ok((await fs.readFile(path.join(installedRunner, clientModule), "utf8"))
    === (await fs.readFile(new URL("../src/codex-app-server-client.mjs", import.meta.url), "utf8")),
  "installed and worktree App Server clients differ");
  const { createCodexAppServerClient } = await import(pathToFileURL(path.join(installedRunner, clientModule)));
  const sourcePath = path.join(os.homedir(), ".codex/skills/bitty-session-orchestrator/scripts/bitty-session.mjs");
  const script = path.join(temp, "probe-cli.mjs");
  const fingerprint = (id) => createHash("sha256").update(id).digest("hex").slice(0, 12);
  const starts = [];
  const items = [];
  const nativeTools = [];
  const turns = [];
  const methods = new Map();
  const requests = new Map();
  const approvals = new Map();
  const clients = [];
  let responseClient;
  let root;
  let turn;
  let service;
  let orchestrator;
  let conversation;
  let operationId;
  let terminal;
  let timer;
  let earlyFailure = "";
  let completed = false;
  try {
    let source = await fs.readFile(sourcePath, "utf8");
    const edits = [
      ['import { randomUUID } from "node:crypto";', 'import { createHash, randomUUID } from "node:crypto";'],
      ['headers: { authorization: `Bearer ${token}`,',
        'headers: { authorization: `Bearer ${token}`, "x-bitty-display-caller": process.env.CODEX_THREAD_ID,'],
      ['console.log(JSON.stringify(result));', `if (!process.env.CODEX_THREAD_ID || probeStatus !== 200
        || !Array.isArray(result.workspaces)) throw new Error("invalid probe result");
        await fs.writeFile(path.join(${JSON.stringify(temp)}, "probe-" + createHash("sha256")
          .update(process.env.CODEX_THREAD_ID).digest("hex").slice(0, 12) + ".json"),
          JSON.stringify({ workspaceCount: result.workspaces.length, httpStatus: probeStatus,
            annotationMatchesEnvironment: probeAnnotation === process.env.CODEX_THREAD_ID }), { flag: "wx", mode: 0o600 });`],
      ['console.error(String(error.message || error));', 'console.error("native probe CLI failed");'],
      ['async function main() {', 'async function main() { if (process.argv.length !== 3 || process.argv[2] !== "workspaces") throw new Error("probe command blocked");'],
      ['main().catch((error) => {', 'await main().catch((error) => {'],
    ];
    for (const [before, after] of edits) {
      assert.equal(source.split(before).length, 2, "installed CLI source anchor changed");
      source = source.replace(before, after);
    }
    source = source.replace('await main().catch((error) => {', `let probeStatus;
      let probeAnnotation;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.origin !== "http://127.0.0.1:8788" || url.pathname !== "/agent/workspaces"
          || url.search || (init.method || "GET") !== "GET" || init.body !== undefined
          || probeStatus !== undefined || init.headers?.["x-bitty-display-caller"] !== process.env.CODEX_THREAD_ID)
          throw new Error("probe request blocked");
        probeAnnotation = init.headers["x-bitty-display-caller"];
        const response = await originalFetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(5000) });
        probeStatus = response.status;
        return response;
      };
      await main().catch((error) => {`);
    await fs.writeFile(script, source, { mode: 0o600 });
    assert.equal(spawnSync(process.execPath, ["--check", script], { stdio: "ignore" }).status, 0,
      "temporary CLI syntax invalid");
    const command = `${process.execPath} ${script} workspaces`;
    assert.ok(!command.includes("'"), "temporary CLI command is not shell-quote safe");
    const shellCommand = `/bin/zsh -lc '${command}'`;
    const createClient = (options) => {
      const client = createCodexAppServerClient({ ...options, upstreamUrl: "ws://127.0.0.1:4500",
        turnCompletionTimeoutMs: 120_000 });
      clients.push(client);
      const close = client.close;
      let ownedClient = false;
      client.close = () => { if (!ownedClient) close(); };
      client.addNotificationListener((method, params) => {
        if (!ownedClient) return;
        methods.set(method, (methods.get(method) || 0) + 1);
        const nativeTool = nativeToolEvent(method, params);
        if (nativeTool && nativeTools.length < 100) nativeTools.push(nativeTool);
        if (method === "thread/started") {
          const thread = params?.thread;
          if (typeof thread?.id === "string") {
            if (starts.length < 20) starts.push({ id: thread.id, parent: thread.parentThreadId,
              ephemeral: thread.ephemeral, path: thread.path });
            if (root && thread.parentThreadId === root
              && (thread.ephemeral !== true || thread.path != null
                || starts.filter((entry) => entry.parent === root).length > 2 || starts.length >= 20)) {
              earlyFailure = "native child metadata or count invalid";
              if (service && orchestrator && conversation && operationId) {
                void service.interrupt(orchestrator.id, conversation.logicalConversationId, operationId).catch(() => {});
              }
            }
          }
        }
        if (["turn/started", "turn/completed", "turn/interrupted"].includes(method) && turns.length < 50
          && typeof params?.threadId === "string" && typeof params?.turn?.id === "string") {
          turns.push({ method, threadId: params.threadId, turnId: params.turn.id });
        }
        if ((method === "item/started" || method === "item/completed") && items.length < 200
          && typeof params?.threadId === "string" && typeof params?.turnId === "string"
          && typeof params?.item?.id === "string") {
          const rawCommand = params.item.command;
          const observedCommand = Array.isArray(rawCommand)
            ? rawCommand.map((part) => String(part || "").trim()).filter(Boolean).join(" ")
            : String(rawCommand || "").trim();
          const commandMatchesExpected = observedCommand === command || observedCommand === shellCommand;
          const commandShape = observedCommand.includes(script)
            ? observedCommand.replaceAll(script, "[probe]").replaceAll(process.execPath, "[node]")
              .replaceAll(temp, "[tmp]").slice(0, 160) : "";
          items.push({ method, threadId: params.threadId, turnId: params.turnId,
            itemId: params.item.id, type: params.item.type,
            status: params.item.status, exitCode: params.item.exitCode ?? params.item.exit_code,
            commandMatchesExpected, commandMentionsProbeScript: observedCommand.includes(script),
            commandShape: /authorization|bearer|token|[0-9a-f]{8}-[0-9a-f]{4}/i.test(commandShape)
              ? "[redacted]" : commandShape,
            collabReceivers: Array.isArray(params.item.receiverThreadIds)
              ? params.item.receiverThreadIds.length : null,
            collabFailureCategory: /agent limit|max agents|too many agents|capacity/i.test(JSON.stringify(params.item))
              ? "capacity" : /unavailable|disabled|not supported/i.test(JSON.stringify(params.item))
                ? "unavailable" : /failed|error/i.test(JSON.stringify(params.item)) ? "other_failure" : "none" });
          if (method === "item/started" && params.item.type === "commandExecution"
            && !commandMatchesExpected && (params.threadId === root
              || starts.some((entry) => entry.id === params.threadId && entry.parent === root))) {
            earlyFailure = "unexpected native command";
            if (service && orchestrator && conversation && operationId) {
              void service.interrupt(orchestrator.id, conversation.logicalConversationId, operationId).catch(() => {});
            }
          }
        }
      });
      const addServerRequestHandler = client.addServerRequestHandler;
      client.addServerRequestHandler = (handler) => addServerRequestHandler((request) => {
        if (ownedClient) requests.set(request.method, (requests.get(request.method) || 0) + 1);
        return handler(request);
      });
      const request = client.request;
      client.request = async (method, params, timeout) => {
        if (method === "thread/start") {
          assert.ok(!responseClient, "multiple response App Server clients");
          responseClient = client;
          ownedClient = true;
        }
        const result = await request(method, params, timeout);
        if (method === "thread/start") {
          const id = result?.thread?.id;
          assert.ok(typeof id === "string" && result.thread.ephemeral === true,
            "ephemeral root start unavailable");
          const read = await request("thread/read", { threadId: id, includeTurns: false }, 5000);
          assert.ok(read?.thread?.id === id && read.thread.ephemeral === true
            && read.thread.path == null && !read.thread.parentThreadId, "ephemeral root metadata mismatch");
          root = id;
        }
        return result;
      };
      client.release = close;
      return client;
    };
    service = createVoiceOrchestratorService({ rootDir: path.join(temp, "voice"), createClient });
    const icon = `data:image/png;base64,${Buffer.from("89504e470d0a1a0a01", "hex").toString("base64")}`;
    const instruction = "This is an isolated user-authorized test. Follow only the explicit one-command "
      + "task given for this test. Do not inspect other sessions, edit files, or use other network tools. "
      + "The user's test instruction already supplies permission for this bounded command.";
    orchestrator = await service.create("Native probe", icon, "gpt-6-sol", "high", instruction);
    const settings = await service.getSettings(orchestrator.id);
    assert.ok(settings.model === "gpt-6-sol" && settings.effort === "high"
      && settings.systemInstruction === instruction,
      "native probe voice settings mismatch");
    conversation = await service.open(orchestrator.id);
    operationId = randomUUID();
    const prompt = `This is one authorized temporary test. Call spawn_agent with task_name probe_a and fork_turns "none", omitting agent_type. Tell probe_a to run only this exact command once: ${command}. Wait for probe_a to finish. Then call spawn_agent with task_name probe_b and fork_turns "none", omitting agent_type, and give exactly the same one-command task. Wait for probe_b to finish. Do not run commands yourself, edit files, use other network tools, or access other sessions. The command only performs GET /agent/workspaces and writes sanitized results in a temporary test directory.`;
    terminal = new Promise((resolve) => {
      void service.start({ operationId, payload: { orchestratorId: orchestrator.id, backendId: "codex",
        logicalConversationId: conversation.logicalConversationId, clientOperationId: operationId,
        input: { blocks: [{ type: "text", text: prompt }] } } }, resolve,
      async ({ method, params }) => {
        const value = params?.command;
        const actual = Array.isArray(value) ? value.join(" ") : String(value || "");
        const cwd = String(params?.cwd || "");
        const decision = method === "item/commandExecution/requestApproval"
          && (actual === command || actual === shellCommand)
          && (!cwd || cwd.startsWith(path.join(temp, "workspaces") + path.sep)) ? "accept" : "decline";
        approvals.set(`${method}:${decision}`, (approvals.get(`${method}:${decision}`) || 0) + 1);
        return decision;
      }, { onStarted: ({ threadId, turnId }) => {
        assert.ok(threadId === root && typeof turnId === "string", "registered native root mismatch");
        turn = turnId;
      } }).catch(() => resolve({ status: "failed" }));
    });
    const result = await Promise.race([terminal, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("ephemeral native probe timed out")), 120_000);
    })]);
    assert.equal(earlyFailure, "", "native child safety guard failed");
    assert.equal(result.status, "completed", "ephemeral voice turn failed");
    completed = true;
    assert.ok(root && turn, "registered native start missing");
    const eventFile = path.join(temp, "voice", "orchestrators", orchestrator.id,
      conversation.logicalConversationId, "events.jsonl");
    const events = (await fs.readFile(eventFile, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.filter((event) => event.type === "native_started"
      && event.clientOperationId === operationId && event.threadId === root && event.turnId === turn).length, 1);
    const registered = (await service.list()).orchestrators.find((entry) => entry.id === orchestrator.id);
    assert.equal(registered?.icon, icon, "temporary registration icon mismatch");
    const binding = new Map([[root, { orchestratorId: orchestrator.id, icon: registered.icon }]]);
    const candidateIds = new Set([...starts.map((entry) => entry.id), ...turns.map((entry) => entry.threadId),
      ...items.map((entry) => entry.threadId)]);
    candidateIds.delete(root);
    const childStarts = [];
    for (const id of [...candidateIds].slice(0, 20)) {
      const read = await responseClient.request("thread/read", { threadId: id, includeTurns: false }, 5000)
        .catch(() => null);
      if (read?.thread?.id === id && read.thread.parentThreadId === root) childStarts.push({ id,
        parent: root, ephemeral: read.thread.ephemeral, path: read.thread.path });
    }
    const replyExcerpt = String(result.text || "").replaceAll(script, "[probe]")
      .replaceAll(process.execPath, "[node]").replaceAll(temp, "[tmp]")
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[id]").slice(0, 160);
    console.log(JSON.stringify({ stage: "ephemeral_native_diagnostic", rootCompleted: completed,
      threadStartedNotifications: starts.length,
      notificationParentMatchedRoot: starts.filter((entry) => entry.parent === root).length,
      candidateThreadIds: candidateIds.size, linkedChildren: childStarts.length,
      itemTypes: Object.fromEntries([...new Set(items.map((item) => item.type))]
        .map((type) => [type, items.filter((item) => item.type === type).length])),
      methods: Object.fromEntries([...methods].filter(([method]) => /^(thread|turn|item)\//.test(method))),
      serverRequests: Object.fromEntries(requests), approvals: Object.fromEntries(approvals),
      matchingCommandItems: items.filter((item) => item.commandMatchesExpected).length,
      commandMentionsProbeScript: items.filter((item) => item.commandMentionsProbeScript).length,
      probeCommandShapes: [...new Set(items.filter((item) => item.commandMentionsProbeScript)
        .map((item) => item.commandShape))],
      completedZeroExitCommands: items.filter((item) => item.type === "commandExecution"
        && item.method === "item/completed" && item.status === "completed" && item.exitCode === 0).length,
      failedCommandEnds: items.filter((item) => item.type === "commandExecution"
        && item.method === "item/completed" && (item.status === "failed" || item.exitCode !== 0)).length,
      rootCommandItems: items.filter((item) => item.type === "commandExecution" && item.threadId === root).length,
      childCommandItems: items.filter((item) => item.type === "commandExecution"
        && childStarts.some((entry) => entry.id === item.threadId)).length,
      mappedNativeToolEvents: nativeTools.length,
      sidecars: (await fs.readdir(temp)).filter((name) => /^probe-[0-9a-f]{12}\.json$/.test(name)).length,
      collabResults: items.filter((item) => item.type === "collabAgentToolCall" && item.method === "item/completed")
        .map((item) => ({ status: item.status, receiverCount: item.collabReceivers,
          failureCategory: item.collabFailureCategory })),
      replyLength: String(result.text || "").length,
      replyRefusalLike: /cannot|can't|unable|not available|できません|利用でき|申し訳/i.test(String(result.text || "")),
      replyApprovalLike: /approval|permission|confirm|承認|確認/i.test(String(result.text || "")),
      replyAgentLike: /subagent|spawn_agent|agent|エージェント/i.test(String(result.text || "")),
      replyExecutionLike: /execut|実行|起動|走らせ/i.test(String(result.text || "")),
      replyFailureLike: /fail|error|could not|did not|失敗|できな/i.test(String(result.text || "")),
      replyFailureCategory: /agent limit|max agents|too many agents|capacity|上限/i.test(String(result.text || ""))
        ? "capacity" : /unavailable|disabled|not supported|利用でき/i.test(String(result.text || ""))
          ? "unavailable" : /permission|sandbox|approval|拒否|承認/i.test(String(result.text || ""))
            ? "approval_or_sandbox" : /fail|error|could not|did not|失敗|できな/i.test(String(result.text || ""))
              ? "other_failure" : "none",
      ownSyntheticReplyExcerpt: /authorization|bearer|token/i.test(replyExcerpt)
        ? "[redacted]" : replyExcerpt }));
    assert.equal(childStarts.length, 2, "two native children not observed");
    assert.ok(!items.some((item) => item.type === "commandExecution" && !item.commandMatchesExpected
      && (item.threadId === root || childStarts.some((child) => child.id === item.threadId))),
    "unexpected native command observed");
    for (const child of childStarts) {
      assert.ok(child.ephemeral === true && child.path == null, "child start was persistent");
      const read = await responseClient.request("thread/read", { threadId: child.id, includeTurns: false }, 5000);
      assert.ok(read?.thread?.id === child.id && read.thread.parentThreadId === root
        && read.thread.ephemeral === true && read.thread.path == null, "ephemeral child metadata mismatch");
    }
    const sidecars = (await fs.readdir(temp)).filter((name) => /^probe-[0-9a-f]{12}\.json$/.test(name));
    assert.equal(sidecars.length, 2, "two child CLI results missing");
    const refs = new Set(childStarts.map(({ id }) => fingerprint(id)));
    for (const name of sidecars) {
      const child = childStarts.find(({ id }) => fingerprint(id) === name.slice(6, 18));
      assert.ok(child && refs.has(name.slice(6, 18)), "child environment/native event mismatch");
      const nativeParent = (await responseClient.request("thread/read",
        { threadId: child.id, includeTurns: false }, 5000))?.thread?.parentThreadId;
      assert.ok(binding.get(nativeParent)?.orchestratorId === orchestrator.id
        && binding.get(nativeParent)?.icon === registered.icon, "child registered icon resolution failed");
      const item = JSON.parse(await fs.readFile(path.join(temp, name), "utf8"));
      assert.ok(item.httpStatus === 200 && item.annotationMatchesEnvironment === true
        && Number.isSafeInteger(item.workspaceCount), "child CLI GET result mismatch");
    }
    const paired = childStarts.map(({ id }) => {
      const began = items.filter((item) => item.threadId === id && item.type === "commandExecution"
        && item.method === "item/started");
      return began.some((start) => items.some((end) => end.threadId === id && end.turnId === start.turnId
        && end.itemId === start.itemId && end.type === start.type && end.method === "item/completed"
        && start.commandMatchesExpected && end.commandMatchesExpected
        && !["failed", "declined", "cancelled", "canceled"].includes(String(end.status || "").toLowerCase())
        && end.status === "completed" && end.exitCode === 0));
    });
    assert.deepEqual(paired, [true, true], "native child tool start/end pairs missing");
    assert.ok(childStarts.every(({ id }) => nativeTools.some((start) => start.phase === "started"
      && start.key.startsWith(`${id}:`) && nativeTools.some((end) => end.phase === "completed"
        && end.key === start.key && end.type === start.type && end.status === "completed"))),
    "candidate native tool mapping omitted child tool pair");
    let activeRequest;
    let cache;
    let lookupRpc = 0;
    let activityEvents = 0;
    const handler = createAgentHttpHandler({ service: {}, runnerToken: "isolated-test-bearer",
      parseAuthToken: (req) => String(req.headers?.authorization || "").replace(/^Bearer /, ""),
      json: (res, statusCode) => { res.statusCode = statusCode; }, subjectId: "isolated-owner",
      workspaceAdmission: { async list(subjectId) {
        assert.equal(subjectId, "isolated-owner");
        const caller = activeRequest?.headers?.["x-bitty-display-caller"];
        assert.ok(childStarts.some((child) => child.id === caller), "caller was not an observed native child");
        activityEvents++;
        const registeredRoot = await registeredRootOf(caller, binding, cache, async (id) => {
          lookupRpc++;
          const result = await responseClient.request("thread/read", { threadId: id, includeTurns: false }, 5000);
          return result?.thread;
        });
        assert.ok(binding.get(registeredRoot)?.icon === registered.icon,
          "candidate lookup registered icon mismatch");
        activityEvents++;
        return [];
      } },
    });
    const endpoint = new URL("http://runner.test/agent/workspaces");
    const runLookup = async (child, memo) => {
      cache = memo;
      activeRequest = { method: "GET", headers: { authorization: "Bearer isolated-test-bearer",
        "x-bitty-display-caller": child.id } };
      const response = {};
      const start = performance.now();
      await handler(activeRequest, response, endpoint, endpoint.pathname);
      assert.equal(response.statusCode, 200);
      return performance.now() - start;
    };
    const fresh = [];
    for (let i = 0; i < 20; i++) fresh.push(await runLookup(childStarts[i % 2], new Map()));
    assert.equal(lookupRpc, 20, "fresh candidate lookup RPC count mismatch");
    const warmCache = new Map();
    for (let i = 0; i < 100; i++) await runLookup(childStarts[i % 2], warmCache);
    const warmRpc = lookupRpc;
    const warm = [];
    for (let i = 0; i < 1000; i++) warm.push(await runLookup(childStarts[i % 2], warmCache));
    assert.equal(lookupRpc, warmRpc, "warm candidate lookup used native RPC");
    assert.equal(activityEvents, 2240, "candidate activity start/end count mismatch");
    const sortedFresh = fresh.toSorted((a, b) => a - b);
    const sortedWarm = warm.toSorted((a, b) => a - b);
    assert.ok(sortedFresh[18] <= 1000 && sortedWarm[949] <= 100,
      "candidate in-process lookup latency threshold exceeded");
    console.log(JSON.stringify({ gate: "candidate_authenticated_native_lookup_latency", status: "observed",
      freshLocalCacheRuns: 20, freshThreadReadRpc: 20, warmupRuns: 100, warmRuns: 1000,
      warmThreadReadRpc: 0, activityStartEndEvents: activityEvents,
      freshP50Ms: Number(sortedFresh[9].toFixed(3)), freshP95Ms: Number(sortedFresh[18].toFixed(3)),
      freshMaxMs: Number(sortedFresh[19].toFixed(3)), warmP50Ms: Number(sortedWarm[499].toFixed(3)),
      warmP95Ms: Number(sortedWarm[949].toFixed(3)), warmMaxMs: Number(sortedWarm[999].toFixed(3)),
      scope: "in-process handler, candidate display lookup, actual thread/read; no HTTP delivery or UI" }));
    console.log(JSON.stringify({ gate: "ephemeral_candidate_native_path", status: "observed",
      registeredRoot: true, nativeChildren: 2, childEnvironmentMatchedNativeEvents: 2,
      childCliHttp200: 2, childCommandStartEndPairs: 2, ephemeralAndPathless: true,
      candidateRegisteredIconResolvedForChildren: 2,
      productWiring: "unverified" }));
  } finally {
    clearTimeout(timer);
    if (service && orchestrator && conversation && operationId) {
      await service.interrupt(orchestrator.id, conversation.logicalConversationId, operationId).catch(() => {});
    }
    if (!completed && terminal) {
      let drainTimer;
      try {
        await Promise.race([terminal, new Promise((resolve) => { drainTimer = setTimeout(resolve, 2000); })]);
      } finally { clearTimeout(drainTimer); }
    }
    const client = responseClient;
    const possibleChildren = new Set([...starts.map((entry) => entry.id), ...turns.map((entry) => entry.threadId),
      ...items.map((entry) => entry.threadId)]);
    possibleChildren.delete(root);
    if (client && root) for (const id of [...possibleChildren].slice(0, 10)) {
      const read = await client.request("thread/read", { threadId: id, includeTurns: false }, 2000).catch(() => null);
      if (read?.thread?.id !== id || read.thread.parentThreadId !== root
        || read.thread.ephemeral !== true || read.thread.path != null) continue;
      const turnId = turns.find((entry) => entry.method === "turn/started" && entry.threadId === id)?.turnId
        || items.find((entry) => entry.threadId === id)?.turnId;
      if (!turnId || turns.some((entry) => entry.threadId === id && entry.turnId === turnId
        && entry.method !== "turn/started")) continue;
      await client.request("turn/interrupt", { threadId: id, turnId }, 2000).catch(() => {});
    }
    if (client && root) await new Promise((resolve) => {
      const active = () => [...possibleChildren].some((id) => {
        const started = turns.find((item) => item.threadId === id && item.method === "turn/started");
        return started && !turns.some((item) => item.threadId === id && item.turnId === started.turnId
          && item.method !== "turn/started");
      });
      if (!active()) return resolve();
      const timeout = setTimeout(() => { remove(); resolve(); }, 2000);
      const remove = client.addNotificationListener(() => {
        if (!active()) { clearTimeout(timeout); remove(); resolve(); }
      });
    });
    for (const client of clients) client.release();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
