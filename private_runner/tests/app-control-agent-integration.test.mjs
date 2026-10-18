import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAppControlService } from "../src/app-control-service.mjs";
import { createAgentService } from "../src/agent/agent-service.mjs";
import { createAgentWsConnection } from "../src/agent/agent-transport.mjs";
import { operationStore, sessionStore, status } from "./agent-service-fixtures.mjs";

const target = { kind: "session", sessionRef: { backendId: "codex", nativeSessionId: "session-A" }, cwd: "/approved" };

test("actual agent WS admission injects only caller invocation; CLI-like stop survives completed source turn", async (t) => {
  const sent = []; const ws = {}; let nativeRequest; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sendEnvelope = (socket, message) => sent.push({ socket, ...message });
  const control = createAppControlService({ sendEnvelope, validateTarget: async () => {} }); t.after(() => control.close());
  control.handleMessage(ws, { channel: "control", op: "app.control.register", payload: { version: 1, clientInstanceId: "phone" } });
  const { epoch, connectionGeneration } = sent.at(-1).payload;
  const snapshot = { connectionGeneration, foreground: true, surfaces: [{ surfaceId: "source", generation: 8, target, desired: "listening", observed: "waiting" }] };
  control.handleMessage(ws, { channel: "control", op: "app.control.update", payload: snapshot });
  const backend = { backendId: "codex", getStatus: async () => status({ backendId: "codex" }), resolveSessionCwd: async () => "/approved",
    async startTurn(request) { nativeRequest = request; request.emit("turn.started", {}); await gate; return { outcome: "completed" }; } };
  const service = createAgentService({ backends: [backend], operationStore: operationStore(), sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd, workspaceAdmission: { assertAllowed: async (_subject, cwd) => cwd } });
  const connection = createAgentWsConnection({ service, ws, sendEnvelope, subjectId: "owner", appControl: control });
  t.after(() => connection.detach());
  const input = { blocks: [{ type: "text", text: "音声入力を止めて" }] };
  const start = { channel: "agent", op: "turn.start", operationId: "caller-turn", payload: { backendId: "codex", sessionRef: target.sessionRef,
    cwd: target.cwd, input, appControlOrigin: { clientInstanceId: "phone", connectionGeneration, surfaceId: "source", ownerGeneration: 8, target } } };
  assert.equal(connection.handleMessage(start), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(nativeRequest.trustedInstructions.includes("bitty-session-orchestrator"));
  const context = nativeRequest.trustedInstructions.match(/ctx_[0-9a-f-]+/)[0];
  assert.deepEqual(nativeRequest.input, input);
  assert.equal(JSON.stringify(nativeRequest.input).includes(context), false);
  const operation = { operationId: `${epoch}.${randomUUID()}`, context, action: "stop", expectedGeneration: 8 };
  assert.equal((await control.submit("owner", operation)).status, "pending");
  release(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(control.getContext("owner", context).status, "context_expired");
  control.handleMessage(ws, { channel: "control", op: "app.control.result", operationId: operation.operationId,
    payload: { connectionGeneration, status: "applied", desired: "stopped", observed: "stopped", generation: 9, target } });
  assert.equal(control.getResult("owner", operation.operationId).status, "applied");
  assert.equal((await control.submit("owner", operation)).status, "applied");
  assert.equal(sent.filter((message) => message.op === "app.control.execute").length, 1);
  assert.equal(JSON.stringify(sent.filter((message) => message.channel === "agent")).includes(context), false);
  // Identical original operation replays without re-injecting or changing request identity.
  connection.handleMessage({ ...start, payload: { ...start.payload, appControlOrigin: undefined } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.at(-1).op, "turn.result");
  const background = await service.startTurn({ backendId: "codex", sessionRef: target.sessionRef, cwd: target.cwd,
    input, clientOperationId: "scheduled" }, { subjectId: "owner" });
  await background.completion;
  assert.equal(nativeRequest.trustedInstructions, "");
});

test("handoff target authorization uses existing session identity and approved canonical workspace", async () => {
  let allowed = true;
  const backend = { backendId: "codex", getStatus: async () => status({ backendId: "codex" }),
    resolveSessionCwd: async (ref) => { if (ref.nativeSessionId !== "session-A") throw Object.assign(new Error("missing"), { code: "session_not_found" }); return "/approved"; },
    startTurn: async () => {}, listActiveSessions: () => [] };
  const service = createAgentService({ backends: [backend], operationStore: operationStore(), sessionStore: sessionStore(),
    resolveCanonicalCwd: async (cwd) => cwd, workspaceAdmission: { assertAllowed: async (_subject, cwd) => {
      if (!allowed) throw Object.assign(new Error("not approved"), { code: "turn_rejected" }); return cwd;
    } } });
  assert.deepEqual(await service.validateAppControlTarget(target, { subjectId: "owner" }), target);
  await assert.rejects(service.validateAppControlTarget({ ...target, cwd: "/other" }, { subjectId: "owner" }), { code: "session_cwd_mismatch" });
  await assert.rejects(service.validateAppControlTarget({ ...target, sessionRef: { backendId: "codex", nativeSessionId: "invented" } }, { subjectId: "owner" }), { code: "session_not_found" });
  allowed = false;
  await assert.rejects(service.validateAppControlTarget(target, { subjectId: "owner" }), { code: "turn_rejected" });
});
