import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { createAgentService } from "../src/agent/agent-service.mjs";
import { createAgentHttpHandler, createAgentWsConnection } from "../src/agent/agent-transport.mjs";
import { createAgentWorkspaceAdmission } from "../src/agent/agent-workspace-admission.mjs";
import { operationStore, sessionStore, status } from "./agent-service-fixtures.mjs";

// A display-only candidate. The shared bearer and Agent Service subject remain the
// authorization boundary; this map cannot establish that a header is a native caller.
function activityCandidate() {
  const roots = new Map();
  const parents = new Map();
  const active = new Map();
  const finished = [];
  const key = (ref) => `${ref?.backendId || ""}\0${ref?.nativeSessionId || ""}`;

  function iconFor(ref) {
    let current = ref;
    const visited = new Set();
    for (let depth = 0; depth <= 10 && current; depth++) {
      const id = key(current);
      if (visited.has(id)) return null;
      visited.add(id);
      if (roots.has(id)) return roots.get(id).icon;
      const next = parents.get(id);
      if (!next || next.kind !== "native" || next.parent.backendId !== current.backendId) return null;
      current = next.parent;
    }
    return null;
  }

  function begin(id, caller, target) {
    if (active.has(id)) return active.get(id);
    const activity = { id, icon: iconFor(caller), target, startedAt: performance.now(), tools: new Map() };
    active.set(id, activity);
    return activity;
  }

  function settle(id, outcome) {
    const activity = active.get(id);
    if (!activity) return;
    activity.outcome = outcome;
    activity.endedAt = performance.now();
    for (const tool of activity.tools.values()) {
      if (!tool.endedAt) { tool.outcome = outcome; tool.endedAt = activity.endedAt; }
    }
    active.delete(id);
    finished.push(activity);
  }

  function event(value) {
    const activity = active.get(value.runId);
    if (!activity) return;
    const toolCallId = value.payload?.toolCallId;
    if (value.type === "tool.started" && toolCallId) {
      if (!activity.tools.has(toolCallId)) activity.tools.set(toolCallId, { startedAt: performance.now() });
    } else if (value.type === "tool.completed" && toolCallId) {
      const tool = activity.tools.get(toolCallId) || { startedAt: null };
      if (!tool.endedAt) {
        tool.endedAt = performance.now();
        tool.outcome = value.payload?.status || "unknown";
      }
      activity.tools.set(toolCallId, tool);
    } else if (["turn.completed", "turn.failed", "turn.interrupted"].includes(value.type)) {
      settle(value.runId, value.type.slice(5));
    }
  }

  return { roots, parents, active, finished, key, iconFor, begin, settle, event };
}

function targetFromHttp(url) {
  if (!["/agent/session-history", "/agent/session-conversation"].includes(url.pathname)) return { kind: "global" };
  const backendId = url.searchParams.get("backendId");
  const nativeSessionId = url.searchParams.get("sessionId");
  return backendId && nativeSessionId
    ? { kind: "card", sessionRef: { backendId, nativeSessionId } }
    : { kind: "global" };
}

function targetFromWs(payload) {
  const ref = payload?.sessionRef;
  return ref?.backendId && ref?.nativeSessionId
    ? { kind: "card", sessionRef: { backendId: ref.backendId, nativeSessionId: ref.nativeSessionId } }
    : { kind: "global" };
}

function percentile(values, fraction) {
  const sorted = values.toSorted((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(3));
}

function parseBearer(req) {
  const [kind, token] = (req.headers?.authorization || "").split(" ");
  return kind === "Bearer" && token ? token : "";
}

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "activity-candidate-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const allowed = path.join(temp, "allowed");
  const denied = path.join(temp, "denied");
  await fs.mkdir(allowed);
  await fs.mkdir(denied);
  const entries = new Map();
  const workspaceAdmission = createAgentWorkspaceAdmission({ store: {
    async list(subject) { return [...entries.values()].filter((item) => item.subjectId === subject); },
    async approve(subjectId, canonicalRoot, identity) {
      const entry = { subjectId, canonicalRoot, identity };
      entries.set(`${subjectId}:${canonicalRoot}`, entry);
      return entry;
    },
    async revoke(subjectId, canonicalRoot) { return entries.delete(`${subjectId}:${canonicalRoot}`); },
  } });
  const confirmation = await workspaceAdmission.prepare("owner", allowed);
  await workspaceAdmission.confirm("owner", confirmation.requestId);
  const started = [];
  const controls = new Map();
  let firstControlReady;
  let twoControlsReady;
  const firstControl = new Promise((resolve) => { firstControlReady = resolve; });
  const twoControls = new Promise((resolve) => { twoControlsReady = resolve; });
  const backend = {
    backendId: "codex",
    getStatus: async () => ({ ...status(), backendId: "codex",
      capabilities: { ...status().capabilities, workspace: { admission: true },
        session: { list: true, history: { read: true } } } }),
    resolveSessionCwd: async () => allowed,
    listSessions: async () => ({ sessions: [] }),
    readHistory: async () => ({ items: [] }),
    async startTurn({ runId, emit, resolveSession, input, sessionRef }) {
      const nativeSessionId = input.blocks[0].text;
      started.push(runId);
      if (sessionRef) assert.equal(sessionRef.nativeSessionId, nativeSessionId);
      else await resolveSession({ backendId: "codex", nativeSessionId });
      emit("turn.started", {});
      await new Promise((resolve) => {
        controls.set(runId, { emit, resolve });
        if (controls.size === 1) firstControlReady();
        if (controls.size === 2) twoControlsReady();
      });
      if (controls.get(runId).error) throw controls.get(runId).error;
      return controls.get(runId).result || { outcome: "completed" };
    },
    async interrupt({ runId }) {
      const control = controls.get(runId);
      if (control) { control.result = { outcome: "interrupted" }; control.resolve(); }
    },
  };
  const service = createAgentService({ backends: [backend], operationStore: operationStore(),
    sessionStore: sessionStore(), workspaceAdmission, resolveCanonicalCwd: (cwd) => fs.realpath(cwd) });
  return { allowed, denied, service, workspaceAdmission, started, controls, firstControl, twoControls };
}

test("candidate parent lookup uses native backend keys, current registration and no guessed forks", () => {
  const a = activityCandidate();
  const ref = (backendId, nativeSessionId) => ({ backendId, nativeSessionId });
  const pA = ref("codex", "parent-a");
  const pB = ref("codex", "parent-b");
  a.roots.set(a.key(pA), { icon: "icon-a" });
  a.roots.set(a.key(pB), { icon: "icon-b" });
  a.parents.set(a.key(ref("codex", "child-a")), { kind: "native", parent: pA });
  a.parents.set(a.key(ref("codex", "child-b")), { kind: "native", parent: pB });
  assert.equal(a.iconFor(ref("codex", "child-a")), "icon-a");
  assert.equal(a.iconFor(ref("codex", "child-b")), "icon-b");
  assert.equal(a.iconFor(ref("claude", "child-a")), null);
  a.parents.set(a.key(ref("codex", "fork")), { kind: "fork", parent: pA });
  a.parents.set(a.key(ref("codex", "cycle-a")), { kind: "native", parent: ref("codex", "cycle-b") });
  a.parents.set(a.key(ref("codex", "cycle-b")), { kind: "native", parent: ref("codex", "cycle-a") });
  assert.equal(a.iconFor(ref("codex", "fork")), null);
  assert.equal(a.iconFor(ref("codex", "cycle-a")), null);
  assert.equal(a.iconFor(ref("codex", "missing")), null);
  a.roots.delete(a.key(pA));
  assert.equal(a.iconFor(ref("codex", "child-a")), null);
  a.roots.set(a.key(ref("codex", "rotated-parent")), { icon: "new-icon" });
  assert.equal(a.iconFor(ref("codex", "child-a")), null);
});

test("HTTP bearer precedes display activity, while route target and real request lifetime drive it", async (t) => {
  const { allowed, service, workspaceAdmission } = await fixture(t);
  const a = activityCandidate();
  a.roots.set(a.key({ backendId: "codex", nativeSessionId: "parent" }), { icon: "parent-icon" });
  a.parents.set(a.key({ backendId: "codex", nativeSessionId: "child" }),
    { kind: "native", parent: { backendId: "codex", nativeSessionId: "parent" } });
  let releaseList;
  const listGate = new Promise((resolve) => { releaseList = resolve; });
  let enteredList;
  const listEntered = new Promise((resolve) => { enteredList = resolve; });
  const url = new URL(`http://runner.test/agent/sessions?backendId=codex&cwd=${encodeURIComponent(allowed)}&callerSessionId=parent`);
  const req = { method: "GET", headers: { authorization: "Bearer bearer", "x-bitty-display-caller": "child" } };
  const handler = createAgentHttpHandler({
    service: { ...service, async listSessions(options, context) {
      assert.deepEqual(context, { subjectId: "owner" });
      const activity = a.begin("http-list", { backendId: "codex", nativeSessionId: req.headers["x-bitty-display-caller"] },
        targetFromHttp(url));
      assert.equal(activity.icon, "parent-icon");
      enteredList();
      try {
        await listGate;
        const result = await service.listSessions(options, context);
        a.settle("http-list", "completed");
        return result;
      } catch (error) {
        a.settle("http-list", "failed");
        throw error;
      }
    } },
    runnerToken: "bearer", parseAuthToken: parseBearer,
    json: (res, code, payload) => { res.statusCode = code; res.payload = payload; },
    normalizeSessionListLimit: () => 20, normalizeSessionMessagesLimit: () => 20,
    workspaceAdmission, subjectId: "owner",
  });
  const rejected = {};
  await handler({ ...req, headers: { ...req.headers, authorization: "Bearer wrong" } }, rejected, url, url.pathname);
  assert.equal(rejected.statusCode, 401);
  assert.equal(a.active.size, 0);
  const response = {};
  const pending = handler(req, response, url, url.pathname);
  await listEntered;
  assert.equal(a.active.get("http-list").target.kind, "global");
  releaseList();
  await pending;
  assert.equal(response.statusCode, 200);
  assert.equal(a.active.size, 0);
  assert.equal(a.finished.length, 1);

  assert.deepEqual(targetFromHttp(new URL("http://runner.test/agent/session-history?backendId=codex&sessionId=target&callerSessionId=other")),
    { kind: "card", sessionRef: { backendId: "codex", nativeSessionId: "target" } });
  assert.deepEqual(targetFromHttp(new URL("http://runner.test/agent/session-history/search?sessionId=target")), { kind: "global" });
  assert.deepEqual(targetFromHttp(new URL("http://runner.test/agent/workspaces?sessionId=target")), { kind: "global" });
});

test("two authenticated HTTP reads on one card retain both icons and clear on success or abort", async (t) => {
  const { service, workspaceAdmission } = await fixture(t);
  const a = activityCandidate();
  for (const [parent, child, icon] of [["p1", "c1", "icon-1"], ["p2", "c2", "icon-2"]]) {
    a.roots.set(a.key({ backendId: "codex", nativeSessionId: parent }), { icon });
    a.parents.set(a.key({ backendId: "codex", nativeSessionId: child }),
      { kind: "native", parent: { backendId: "codex", nativeSessionId: parent } });
  }
  const url = new URL("http://runner.test/agent/session-history?backendId=codex&sessionId=target");
  const releases = [];
  let entered;
  const bothEntered = new Promise((resolve) => { entered = resolve; });
  const aborted = new AbortController();
  const run = (id, caller, signal) => {
    const req = { method: "GET", signal,
      headers: { authorization: "Bearer bearer", "x-bitty-display-caller": caller } };
    const handler = createAgentHttpHandler({
      service: { ...service, async readHistory(options, context) {
        assert.deepEqual(context, { subjectId: "owner" });
        a.begin(id, { backendId: "codex", nativeSessionId: req.headers["x-bitty-display-caller"] },
          targetFromHttp(url));
        const pending = new Promise((resolve) => releases.push(resolve));
        if (releases.length === 2) entered();
        try {
          await Promise.race([pending, ...(signal ? [new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          })] : [])]);
          const result = await service.readHistory(options, context);
          a.settle(id, "completed");
          return result;
        } catch (error) {
          a.settle(id, "failed");
          throw error;
        }
      } },
      runnerToken: "bearer", parseAuthToken: parseBearer,
      json: (res, code, payload) => { res.statusCode = code; res.payload = payload; },
      normalizeSessionListLimit: () => 20, normalizeSessionMessagesLimit: () => 20,
      workspaceAdmission, subjectId: "owner",
    });
    const response = {};
    return handler(req, response, url, url.pathname).then(() => response);
  };
  const first = run("http-1", "c1");
  const second = run("http-2", "c2", aborted.signal);
  await bothEntered;
  assert.deepEqual([...a.active.values()].map((activity) => [activity.icon, activity.target]), [
    ["icon-1", { kind: "card", sessionRef: { backendId: "codex", nativeSessionId: "target" } }],
    ["icon-2", { kind: "card", sessionRef: { backendId: "codex", nativeSessionId: "target" } }],
  ]);
  aborted.abort();
  releases[0]();
  assert.deepEqual([(await first).statusCode, (await second).statusCode], [200, 400]);
  assert.equal(a.finished.find((activity) => activity.id === "http-1").outcome, "completed");
  assert.equal(a.finished.find((activity) => activity.id === "http-2").outcome, "failed");
  assert.equal(a.active.size, 0);
});

test("workspace and operation controls stay with the authenticated subject despite caller hints", async (t) => {
  const { allowed, denied, service, started, controls, firstControl } = await fixture(t);
  const a = activityCandidate();
  a.roots.set(a.key({ backendId: "codex", nativeSessionId: "parent" }), { icon: "parent-icon" });
  const request = (cwd, clientOperationId) => ({ backendId: "codex", cwd, clientOperationId,
    input: { blocks: [{ type: "text", text: clientOperationId }] },
    callerSessionId: "parent" });
  await assert.rejects(service.startTurn(request(denied, "denied"), { subjectId: "owner" }),
    (error) => error.code === "turn_rejected");
  await assert.rejects(service.startTurn(request(allowed, "wrong-owner"), { subjectId: "other" }),
    (error) => error.code === "turn_rejected");
  assert.equal(started.length, 0);
  assert.equal(a.active.size, 0);

  const first = await service.startTurn(request(allowed, "one"), { subjectId: "owner" });
  const replay = await service.startTurn(request(allowed, "one"), { subjectId: "owner" });
  assert.equal(replay.runId, first.runId);
  await firstControl;
  assert.equal(started.length, 1);
  controls.get(first.runId).resolve();
  await first.completion;
  await replay.completion;
  assert.equal(a.active.size, 0);
});

test("WS events keep concurrent tools separate and only terminal events close activities", async (t) => {
  const { allowed, service, controls, twoControls } = await fixture(t);
  const a = activityCandidate();
  for (const [parent, child, icon] of [["p1", "c1", "icon-1"], ["p2", "c2", "icon-2"]]) {
    a.roots.set(a.key({ backendId: "codex", nativeSessionId: parent }), { icon });
    a.parents.set(a.key({ backendId: "codex", nativeSessionId: child }),
      { kind: "native", parent: { backendId: "codex", nativeSessionId: parent } });
  }
  const sent = [];
  let acceptedReady;
  const acceptedPromise = new Promise((resolve) => { acceptedReady = resolve; });
  let firstTerminalReady;
  const firstTerminalPromise = new Promise((resolve) => { firstTerminalReady = resolve; });
  let terminalReady;
  const terminalPromise = new Promise((resolve) => { terminalReady = resolve; });
  let firstRunId = "";
  const connect = () => createAgentWsConnection({ service, ws: {}, subjectId: "owner",
    workspaceAdmission: {}, sendEnvelope: (_ws, envelope) => {
      sent.push(envelope);
      if (sent.filter((item) => item.op === "turn.accepted").length === 2) acceptedReady();
      if (envelope.op === "event") a.event(envelope.payload);
      if (envelope.op === "event" && envelope.payload.runId === firstRunId
        && envelope.payload.type === "turn.completed") firstTerminalReady();
      if (a.finished.length === 2) terminalReady();
    } });
  const firstConnection = connect();
  for (const [id, child] of [["one", "c1"], ["two", "c2"]]) {
    firstConnection.handleMessage({ channel: "agent", op: "turn.start", operationId: id,
      payload: { backendId: "codex", cwd: allowed, clientOperationId: id,
        input: { blocks: [{ type: "text", text: child }] } } });
  }
  await acceptedPromise;
  const accepted = sent.filter((envelope) => envelope.op === "turn.accepted");
  assert.equal(accepted.length, 2, JSON.stringify(sent));
  for (const [index, child] of ["c1", "c2"].entries()) {
    a.begin(accepted[index].payload.runId, { backendId: "codex", nativeSessionId: child },
      { kind: "global" });
  }
  const [run1, run2] = accepted.map((envelope) => envelope.payload.runId);
  firstRunId = run1;
  await twoControls;
  assert.deepEqual([...a.active.values()].map((entry) => entry.icon), ["icon-1", "icon-2"]);
  assert.deepEqual([...a.active.values()].map((entry) => entry.target.kind), ["global", "global"]);
  for (const [runId, toolCallId] of [[run1, "a"], [run1, "b"], [run2, "a"]]) {
    controls.get(runId).emit("tool.started", { toolCallId, name: "exec_command" });
  }
  controls.get(run1).emit("tool.completed", { toolCallId: "b", status: "failed", exitCode: 1 });
  controls.get(run2).emit("tool.completed", { toolCallId: "a", status: "completed", exitCode: 0 });
  // Agent Service correctly rejects a missing start. This tests the display
  // consumer's repair when a native stream was attached after that start.
  a.event({ runId: run2, type: "tool.completed", payload: { toolCallId: "late-start", status: "failed" } });
  assert.equal(a.active.get(run1).tools.get("a").endedAt, undefined);
  assert.equal(a.active.get(run1).tools.get("b").outcome, "failed");
  assert.equal(a.active.get(run2).tools.get("a").outcome, "completed");
  assert.equal(a.active.get(run2).tools.get("late-start").startedAt, null);
  const failedToolEvent = sent.find((envelope) => envelope.op === "event"
    && envelope.payload.runId === run1 && envelope.payload.type === "tool.completed");
  assert.deepEqual({ status: failedToolEvent.payload.payload.status,
    exitCode: failedToolEvent.payload.payload.exitCode }, { status: "failed", exitCode: 1 });

  firstConnection.detach();
  assert.equal(a.active.size, 2);
  const resumed = connect();
  resumed.handleMessage({ channel: "agent", op: "events.resume", payload: { runId: run1, afterSequence: 0 } });
  resumed.handleMessage({ channel: "agent", op: "events.resume", payload: { runId: run2, afterSequence: 0 } });
  assert.equal(sent.at(-1).op, "events.resumed");
  assert.equal(a.active.size, 2);
  assert.equal(a.active.get(run1).tools.get("b").outcome, "failed");
  assert.ok(a.active.get(run1).tools.get("b").endedAt);
  controls.get(run1).emit("tool.completed", { toolCallId: "a", status: "completed", exitCode: 0 });
  controls.get(run1).resolve();
  await firstTerminalPromise;
  assert.equal(a.active.has(run1), false);
  assert.equal(a.finished.find((entry) => entry.id === run1).tools.get("a").outcome, "completed");
  controls.get(run2).error = new Error("backend failed");
  controls.get(run2).resolve();
  await terminalPromise;
  assert.equal(a.active.size, 0);
  assert.equal(a.finished.find((entry) => entry.id === run2).outcome, "failed");
});

test("interrupted WS turn closes its display activity", async (t) => {
  const { allowed, service, firstControl } = await fixture(t);
  const a = activityCandidate();
  let accepted;
  let terminal;
  const acceptedPromise = new Promise((resolve) => { accepted = resolve; });
  const terminalPromise = new Promise((resolve) => { terminal = resolve; });
  const connection = createAgentWsConnection({ service, ws: {}, subjectId: "owner",
    workspaceAdmission: {}, sendEnvelope: (_ws, envelope) => {
      if (envelope.op === "turn.accepted") accepted(envelope.payload.runId);
      if (envelope.op === "event") {
        a.event(envelope.payload);
        if (envelope.payload.type === "turn.interrupted") terminal();
      }
    } });
  connection.handleMessage({ channel: "agent", op: "turn.start", operationId: "interrupt",
    payload: { backendId: "codex", cwd: allowed, clientOperationId: "interrupt",
      input: { blocks: [{ type: "text", text: "child" }] } } });
  const runId = await acceptedPromise;
  a.begin(runId, { backendId: "codex", nativeSessionId: "unknown" }, { kind: "global" });
  assert.equal(a.active.get(runId).icon, null);
  await firstControl;
  await service.interrupt(runId, { subjectId: "owner" });
  await terminalPromise;
  assert.equal(a.active.size, 0);
  assert.equal(a.finished[0].outcome, "interrupted");
});

test("authenticated WS turn targets its requested session card", async (t) => {
  const { allowed, service, controls, firstControl } = await fixture(t);
  const a = activityCandidate();
  const parent = { backendId: "codex", nativeSessionId: "parent" };
  const child = { backendId: "codex", nativeSessionId: "child" };
  a.roots.set(a.key(parent), { icon: "parent-icon" });
  a.parents.set(a.key(child), { kind: "native", parent });
  const payload = { backendId: "codex", sessionRef: { backendId: "codex", nativeSessionId: "target" },
    cwd: allowed, clientOperationId: "card-operation",
    input: { blocks: [{ type: "text", text: "target" }] } };
  let accepted;
  let terminal;
  const acceptedPromise = new Promise((resolve) => { accepted = resolve; });
  const terminalPromise = new Promise((resolve) => { terminal = resolve; });
  const connection = createAgentWsConnection({ service, ws: {}, subjectId: "owner",
    workspaceAdmission: {}, sendEnvelope: (_ws, envelope) => {
      if (envelope.op === "turn.accepted") {
        a.begin(envelope.payload.runId, child, targetFromWs(payload));
        accepted(envelope.payload.runId);
      }
      if (envelope.op === "event") {
        a.event(envelope.payload);
        if (["turn.completed", "turn.failed", "turn.interrupted"].includes(envelope.payload.type)) {
          terminal(envelope.payload.type);
        }
      }
    } });
  connection.handleMessage({ channel: "agent", op: "turn.start", operationId: "card-operation", payload });
  const runId = await acceptedPromise;
  await firstControl;
  assert.equal(a.active.get(runId).icon, "parent-icon");
  assert.deepEqual(a.active.get(runId).target,
    { kind: "card", sessionRef: { backendId: "codex", nativeSessionId: "target" } });
  assert.deepEqual(targetFromWs({ backendId: "codex" }), { kind: "global" });
  controls.get(runId).resolve();
  assert.equal(await terminalPromise, "turn.completed");
  assert.equal(a.active.size, 0);
  assert.equal(a.finished[0].outcome, "completed");
  connection.detach();
});

test("in-process HTTP authentication, candidate lookup, real service and activity notification have separate measured cost", async (t) => {
  const { service, workspaceAdmission } = await fixture(t);
  const parent = { backendId: "codex", nativeSessionId: "parent" };
  const child = { backendId: "codex", nativeSessionId: "child" };
  const url = new URL("http://runner.test/agent/backends/status");
  const run = async (instance, id) => {
    const response = {};
    const start = performance.now();
    await instance.handle({ method: "GET",
      headers: { authorization: "Bearer bearer", "x-bitty-display-caller": "child" } }, response);
    const elapsed = performance.now() - start;
    assert.equal(response.statusCode, 200);
    assert.equal(instance.collector.active.size, 0);
    assert.equal(instance.collector.finished.at(-1).id, id);
    assert.deepEqual(instance.notifications.slice(-2).map((item) => item.state), ["started", "completed"]);
    return elapsed;
  };
  const make = (id) => {
    const collector = activityCandidate();
    const notifications = [];
    let incomingCaller = "";
    collector.roots.set(collector.key(parent), { icon: "icon" });
    collector.parents.set(collector.key(child), { kind: "native", parent });
    const handler = createAgentHttpHandler({
      service: { ...service, async getStatuses() {
        const activity = collector.begin(id,
          { backendId: "codex", nativeSessionId: incomingCaller }, targetFromHttp(url));
        notifications.push({ id, state: "started", icon: activity.icon });
        try {
          const result = await service.getStatuses();
          collector.settle(id, "completed");
          notifications.push({ id, state: "completed" });
          return result;
        } catch (error) {
          collector.settle(id, "failed");
          notifications.push({ id, state: "failed" });
          throw error;
        }
      } },
      runnerToken: "bearer", parseAuthToken: parseBearer,
      json: (res, code, payload) => { res.statusCode = code; res.payload = payload; },
      normalizeSessionListLimit: () => 20, normalizeSessionMessagesLimit: () => 20,
      workspaceAdmission, subjectId: "owner",
    });
    return { collector, notifications, handle(req, res) {
      incomingCaller = req.headers["x-bitty-display-caller"];
      return handler(req, res, url, url.pathname);
    } };
  };
  const shared = make("warm");
  for (let i = 0; i < 100; i++) await run(shared, "warm");
  const warm = [];
  for (let i = 0; i < 1000; i++) warm.push(await run(shared, "warm"));
  const fresh = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const instance = make(`fresh-${i}`);
    await run(instance, `fresh-${i}`);
    fresh.push(performance.now() - start);
  }
  console.log(JSON.stringify({ gate: "candidate_in_process_http", warmRuns: warm.length,
    warmP95Ms: percentile(warm, 0.95), freshRuns: fresh.length,
    freshP95Ms: percentile(fresh, 0.95), included: "HTTP bearer, Agent Service status, parent map lookup, activity begin/end notifications",
    actualNativeRpc: "unverified", notificationDelivery: "in-process only" }));
});
