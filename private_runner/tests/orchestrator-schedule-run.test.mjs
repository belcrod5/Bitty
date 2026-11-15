import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import { createCodexScheduleService } from "../src/codex-schedule-service.mjs";
import { createCodexScheduleHttpHandler } from "../src/codex-schedule-http.mjs";
import { createRunnerLoginHttp } from "../src/runner-login-http.mjs";

const SCHEDULE = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const SECOND = "33333333-3333-4333-8333-333333333333";
const LOGICAL = "44444444-4444-4444-8444-444444444444";
const date = "2026-11-15T00:00:00.000Z";

async function fixture(t, { enabled = true, configured = true, foreground = false, blocked = "", owner = true } = {}) {
  const root = await fs.mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "schedule-run-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const definition = { id: SCHEDULE, name: "Morning check", enabled, startLocal: "2026-11-16T09:00:00",
    timeZone: "Asia/Tokyo", rrule: "FREQ=DAILY", action: { kind: "voice", orchestratorId: "main",
      prompt: "Saved verification prompt", systemInstruction: "Saved scheduled instructions" } };
  const definitionsPath = path.join(root, "schedules.json");
  await fs.writeFile(definitionsPath, JSON.stringify({ version: 2, revision: 0, updatedAt: date, schedules: configured ? [definition] : [] }));
  const states = new Map();
  const calls = [];
  let settled;
  const voice = {
    list: async () => ({ orchestrators: owner ? [{ id: "main" }] : [] }),
    open: async () => ({ logicalConversationId: LOGICAL }),
    status: async (_id, _logical, requestId) => {
      if (!states.has(requestId)) throw Object.assign(new Error("Unknown operation"), { code: "not_found" });
      return { logicalConversationId: LOGICAL, clientOperationId: requestId, ...states.get(requestId) };
    },
    afterCurrentTurn: async (_id, callback) => {
      if (!foreground) return false;
      settled = callback;
      return true;
    },
    start: async (message, notify, approve, hooks) => {
      if (blocked) throw Object.assign(new Error("Orchestrator is busy"), { code: blocked });
      const id = message.payload.clientOperationId;
      const previous = states.get(id);
      if (previous) return previous;
      calls.push({ message, hooks, approve });
      states.set(id, { status: "accepted", source: hooks.source });
      hooks.onAccepted?.();
      calls.at(-1).complete = (status = "completed") => {
        const next = { status, source: hooks.source, text: "Scheduled verification result" };
        states.set(id, next); notify(next); hooks.onSettled?.();
      };
      return states.get(id);
    },
  };
  const options = { definitionsPath, runtimePath: path.join(root, "runtime.json"), voiceContextService: voice,
    onVoiceApproval: (...args) => ({ approved: args[0] }), parseCodexOptions: () => { throw new Error("Voice uses its owner settings"); },
    now: () => new Date(date), scheduleTimer: () => ({ unref() {} }), clearTimer() {} };
  const service = createCodexScheduleService(options);
  await service.snapshot();
  t.after(() => service.stop());
  return { root, service, voice, options, states, calls, definition, definitionsPath,
    wake: async () => { foreground = false; await settled?.(); }, setBlocked: (value) => { blocked = value; } };
}

for (const enabled of [true, false]) test(`run saved configuration once without changing ${enabled ? "enabled" : "disabled"} calendar settings`, async (t) => {
  const f = await fixture(t, { enabled });
  const before = await f.service.snapshot();
  const bytes = await fs.readFile(f.definitionsPath, "utf8");
  const runtime = await fs.readFile(f.options.runtimePath, "utf8");
  const result = await f.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: REQUEST });
  assert.equal(result.status, "accepted");
  assert.equal(result.clientOperationId, REQUEST);
  assert.equal(result.logicalConversationId, LOGICAL);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].hooks.source, "scheduled");
  assert.deepEqual(f.calls[0].message.payload.input, { blocks: [{ type: "text", text: f.definition.action.prompt }] });
  assert.equal(f.calls[0].message.payload.additionalInstructions, f.definition.action.systemInstruction);
  assert.equal(f.calls[0].approve({ method: "approval" }).approved, REQUEST);
  assert.deepEqual(await f.service.snapshot(), before);
  assert.equal(await fs.readFile(f.definitionsPath, "utf8"), bytes);
  assert.equal(await fs.readFile(f.options.runtimePath, "utf8"), runtime);
  f.calls[0].hooks.onStarted();
  assert.equal((await f.service.getOrchestratorScheduleRun("main", REQUEST)).status, "started");
  f.calls[0].complete();
  const completed = await f.service.getOrchestratorScheduleRun("main", REQUEST);
  assert.equal(completed.status, "completed");
  assert.equal(completed.text, "Scheduled verification result");
  assert.equal((await f.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: REQUEST })).status, "completed");
  assert.equal(f.calls.length, 1);
});

test("foreground queue captures saved inputs, is replayable, rejects a second pending request and dispatches after settlement", async (t) => {
  const f = await fixture(t, { foreground: true });
  const queued = await f.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: REQUEST });
  assert.equal(queued.status, "queued"); assert.equal(f.calls.length, 0);
  assert.equal(queued.queueReason, "current_turn"); assert.equal(queued.nextOccurrenceAt, undefined);
  assert.deepEqual(await f.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: REQUEST }), queued);
  await assert.rejects(f.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: SECOND }), { code: "orchestrator_run_pending" });
  await assert.rejects(f.service.runOrchestratorSchedule("main", { baseRevision: 1, requestId: REQUEST }), { code: "operation_conflict" });
  const current = await f.service.getOrchestratorSchedule("main");
  await f.service.saveOrchestratorSchedule("main", { baseRevision: current.revision,
    settings: { ...current.settings, prompt: "Changed after request", systemInstruction: "New instructions" } });
  await f.wake();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].message.payload.input.blocks[0].text, f.definition.action.prompt);
  assert.equal(f.calls[0].message.payload.additionalInstructions, f.definition.action.systemInstruction);
  assert.equal((await f.service.getOrchestratorScheduleRun("main", REQUEST)).configurationRevision, 0);
});

test("stopped queued callbacks never execute after stop/start and are not recovered as automatic retries", async (t) => {
  const f = await fixture(t, { foreground: true });
  await f.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: REQUEST });
  f.service.stop(); await f.service.start(); await f.wake();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.getOrchestratorScheduleRun("main", REQUEST)).status, "unknown");
  const restarted = createCodexScheduleService(f.options); t.after(() => restarted.stop());
  await assert.rejects(restarted.getOrchestratorScheduleRun("main", REQUEST), { code: "orchestrator_run_not_found" });
});

test("stop/start during asynchronous preparation cannot resurrect the queued request", async (t) => {
  const f = await fixture(t);
  let opened = 0, release, reached;
  const preparing = new Promise((resolve) => { reached = resolve; });
  f.voice.open = async () => {
    if (++opened === 2) { reached(); await new Promise((resolve) => { release = resolve; }); }
    return { logicalConversationId: LOGICAL };
  };
  const pending = f.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: REQUEST });
  await preparing; f.service.stop(); await f.service.start(); release();
  assert.equal((await pending).status, "unknown"); assert.equal(f.calls.length, 0);
});

test("owner deletion while a foreground run is queued prevents execution without changing saved definitions", async (t) => {
  const f = await fixture(t, { foreground: true });
  const before = await f.service.snapshot();
  await f.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: REQUEST });
  f.voice.list = async () => ({ orchestrators: [] });
  await f.wake(); assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.service.snapshot(), before);
  await assert.rejects(f.service.getOrchestratorScheduleRun("main", REQUEST), { code: "orchestrator_not_found" });
});

for (const code of ["session_busy", "voice_context_reset_required"]) test(`non-foreground ${code} is skipped without waiting for a nonexistent completion event`, async (t) => {
  const f = await fixture(t, { blocked: code });
  const result = await f.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: REQUEST });
  assert.equal(result.status, "skipped"); assert.equal(result.errorCode, code);
  assert.equal(f.calls.length, 0);
});

test("failed dispatch reports failure without altering the timer", async (t) => {
  const f = await fixture(t, { blocked: "backend_unavailable" }); const before = await f.service.snapshot();
  const result = await f.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: REQUEST });
  assert.equal(result.status, "failed"); assert.equal(result.errorCode, "backend_unavailable");
  assert.deepEqual(await f.service.snapshot(), before);
});

test("request IDs cannot reuse user turns, and accepted scheduled runs recover without executing current changed inputs", async (t) => {
  const f = await fixture(t);
  f.states.set(REQUEST, { status: "completed", source: "user" });
  await assert.rejects(f.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: REQUEST }), { code: "operation_conflict" });
  await assert.rejects(f.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: REQUEST }), { code: "operation_conflict" });
  f.states.set(SECOND, { status: "running", source: "scheduled" });
  const recovered = await f.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: SECOND });
  assert.equal(recovered.status, "running"); assert.equal(recovered.recovered, true);
  assert.equal(recovered.configurationRevision, undefined);
  assert.equal(f.calls.length, 0);
  const restarted = createCodexScheduleService(f.options); t.after(() => restarted.stop());
  assert.equal((await restarted.getOrchestratorScheduleRun("main", SECOND)).status, "running");
});

test("missing configuration, missing owner, stale revision and malformed requests never dispatch", async (t) => {
  const missing = await fixture(t, { configured: false });
  await assert.rejects(missing.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: REQUEST }), { code: "orchestrator_schedule_not_configured" });
  const gone = await fixture(t, { owner: false });
  await assert.rejects(gone.service.runOrchestratorSchedule("main", { baseRevision: 0, requestId: REQUEST }), { code: "orchestrator_not_found" });
  const f = await fixture(t);
  for (const payload of [{ baseRevision: 1, requestId: REQUEST }, { baseRevision: 0, requestId: [REQUEST] },
    { baseRevision: 0, requestId: 1 }, { baseRevision: 0, requestId: REQUEST, prompt: "Unstored prompt" }]) {
    await assert.rejects(f.service.runOrchestratorSchedule("main", payload));
  }
  assert.equal(f.calls.length, 0);
});

async function readBody(req, maxBytes) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > maxBytes) throw new Error("Body too large"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
async function listen(t, handler, address) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}
function authenticatedHandler(f) {
  const api = createCodexScheduleHttpHandler({ service: f.service, readJsonBody: readBody,
    json: (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); } });
  const login = createRunnerLoginHttp({ service: { authenticate: async (token, { local }) => {
    if (token !== (local ? "fixture-local-token" : "fixture-device-session")) throw Object.assign(new Error("authentication_required"), { status: 401 });
    return { sessionId: local ? "fixture-local" : "fixture-device", ownerSubjectId: "fixture-owner", local };
  } } });
  return { login, handler: async (req, res) => {
    if (!await api(req, res, new URL(req.url, "http://runner.local").pathname)) { res.writeHead(404); res.end(JSON.stringify({ error: "not_found" })); }
  } };
}

test("actual TCP HTTP with device-session authentication supports saved settings → run → status and rejects bad routes/requests", async (t) => {
  const f = await fixture(t, { foreground: true }); const { login, handler } = authenticatedHandler(f);
  const server = await listen(t, login.wrap(handler), { host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (route, { method = "GET", body, auth = true } = {}) => fetch(origin + route, { method,
    headers: { ...(auth ? { authorization: "Bearer fixture-device-session" } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const base = "/orchestrators/main/schedule";
  assert.equal((await call(base + "/run", { method: "POST", body: {}, auth: false })).status, 401);
  assert.equal((await call(base + "/run")).status, 405);
  assert.equal((await call(base + "/run/extra/path")).status, 404);
  const settings = await (await call(base)).json();
  assert.equal(settings.settings.trigger.startLocal, f.definition.startLocal);
  const run = await call(base + "/run", { method: "POST", body: { baseRevision: settings.revision, requestId: REQUEST } });
  assert.equal(run.status, 202); assert.equal((await run.json()).status, "queued");
  assert.equal((await call(base + `/run/${REQUEST}`)).status, 202);
  assert.equal(f.calls.length, 0); await f.wake(); assert.equal(f.calls.length, 1);
  assert.equal((await (await call(base + `/run/${REQUEST}`)).json()).status, "accepted");
  f.calls[0].complete();
  const completed = await call(base + `/run/${REQUEST}`);
  assert.equal(completed.status, 200); assert.equal((await completed.json()).status, "completed");
  assert.deepEqual(await (await call(base)).json(), settings);
  assert.equal((await call(base + "/run", { method: "POST", body: { baseRevision: 1, requestId: SECOND } })).status, 409);
  assert.equal((await call(base + "/run", { method: "POST", body: { baseRevision: 0, requestId: [SECOND] } })).status, 400);
  assert.equal((await call("/orchestrators/bad/schedule/run", { method: "POST", body: { baseRevision: 0, requestId: SECOND } })).status, 400);
  assert.equal((await call(`/orchestrators/${SECOND}/schedule/run`, { method: "POST", body: { baseRevision: 0, requestId: SECOND } })).status, 404);
  assert.equal((await call(base + `/run/${SECOND}`)).status, 404);
  assert.equal((await call(base + `/run/${REQUEST}`, { method: "POST", body: {} })).status, 405);
});

test("TCP HTTP reports a missing saved configuration as 404 rather than running the default prompt", async (t) => {
  const f = await fixture(t, { configured: false }); const { login, handler } = authenticatedHandler(f);
  const server = await listen(t, login.wrap(handler), { host: "127.0.0.1", port: 0 });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/orchestrators/main/schedule/run`, {
    method: "POST", headers: { authorization: "Bearer fixture-device-session", "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 0, requestId: REQUEST }) });
  assert.equal(response.status, 404); assert.equal((await response.json()).error, "orchestrator_schedule_not_configured");
  assert.equal(f.calls.length, 0);
});

function runCli(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("agent CLI performs real authenticated UDS run and status requests, generating a reusable request ID", async (t) => {
  const f = await fixture(t); const { login, handler } = authenticatedHandler(f);
  const socket = path.join(await fs.realpath(f.root), "runner.sock");
  await listen(t, login.wrap(handler, { local: true }), socket);
  await fs.mkdir(path.join(f.root, "private_runner/tools"), { recursive: true });
  await fs.mkdir(path.join(f.root, "skills/bitty-session-orchestrator/scripts"), { recursive: true });
  await fs.copyFile("private_runner/tools/codex-schedules.mjs", path.join(f.root, "private_runner/tools/codex-schedules.mjs"));
  await fs.copyFile("skills/bitty-session-orchestrator/scripts/runner-control.mjs", path.join(f.root, "skills/bitty-session-orchestrator/scripts/runner-control.mjs"));
  await fs.writeFile(path.join(f.root, "private_runner/.env"), `RUNNER_TOKEN_FILE=token\nRUNNER_CONTROL_SOCKET=${socket}\n`);
  await fs.writeFile(path.join(f.root, "token"), "fixture-local-token", { mode: 0o600 });
  const file = path.join(f.root, "request.json"); await fs.writeFile(file, JSON.stringify({ baseRevision: 0 }), { mode: 0o600 });
  const cli = path.join(f.root, "private_runner/tools/codex-schedules.mjs");
  const result = await runCli(cli, ["orchestrator-run", "main", "--file", file]);
  assert.equal(result.code, 0, result.stderr);
  const run = JSON.parse(result.stdout); assert.equal(run.status, "accepted"); assert.match(run.requestId, /^[0-9a-f-]{36}$/);
  f.calls[0].complete();
  const status = await runCli(cli, ["orchestrator-run-status", "main", run.requestId]);
  assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).status, "completed");
  await fs.writeFile(file, JSON.stringify({ baseRevision: 0, requestId: run.requestId }), { mode: 0o600 });
  assert.equal((await runCli(cli, ["orchestrator-run", "main", "--file", file])).code, 0);
  assert.equal(f.calls.length, 1);
  const unknown = await runCli(cli, ["orchestrator-run-status", "main", REQUEST]);
  assert.equal(JSON.parse(unknown.stderr).error, "orchestrator_run_not_found");
  assert.match((await runCli(cli, ["--help"])).stdout, /not retried after Runner restart/);
  assert.match((await runCli(cli, ["--help"])).stdout, /Do not wait or poll for completion within that same orchestrator turn/);
});

test("updated CLI identifies an older Runner's missing API instead of reporting an unknown response", async (t) => {
  const f = await fixture(t);
  const socket = path.join(await fs.realpath(f.root), "old-runner.sock");
  await listen(t, (_req, res) => { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not_found" })); }, socket);
  await fs.mkdir(path.join(f.root, "private_runner/tools"), { recursive: true });
  await fs.mkdir(path.join(f.root, "skills/bitty-session-orchestrator/scripts"), { recursive: true });
  await fs.copyFile("private_runner/tools/codex-schedules.mjs", path.join(f.root, "private_runner/tools/codex-schedules.mjs"));
  await fs.copyFile("skills/bitty-session-orchestrator/scripts/runner-control.mjs", path.join(f.root, "skills/bitty-session-orchestrator/scripts/runner-control.mjs"));
  await fs.writeFile(path.join(f.root, "private_runner/.env"), `RUNNER_TOKEN_FILE=token\nRUNNER_CONTROL_SOCKET=${socket}\n`);
  await fs.writeFile(path.join(f.root, "token"), "fixture-local-token", { mode: 0o600 });
  const file = path.join(f.root, "request.json"); await fs.writeFile(file, JSON.stringify({ baseRevision: 0 }), { mode: 0o600 });
  const result = await runCli(path.join(f.root, "private_runner/tools/codex-schedules.mjs"), ["orchestrator-run", "main", "--file", file]);
  const error = JSON.parse(result.stderr);
  assert.equal(error.error, "not_found"); assert.match(error.message, /checkout\/version/);
  assert.match(error.requestId, /^[0-9a-f-]{36}$/); assert.notEqual(result.code, 0);
});
