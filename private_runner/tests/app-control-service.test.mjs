import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAppControlService, createAppControlHttpHandler } from "../src/app-control-service.mjs";

const source = { kind: "session", sessionRef: { backendId: "codex", nativeSessionId: "source" }, cwd: "/approved" };
const target = { kind: "orchestrator", orchestratorId: "main" };
function fixture(validateTarget = async () => {}, now = Date.now) {
  const sent = [];
  const service = createAppControlService({ sendEnvelope: (ws, message) => sent.push({ ws, ...message }), validateTarget, now });
  const ws = {};
  const envelope = (op, payload, operationId) => service.handleMessage(ws, { channel: "control", op: `app.control.${op}`, payload, operationId });
  envelope("register", { version: 1, clientInstanceId: "phone" });
  const { connectionGeneration, epoch } = sent.at(-1).payload;
  const snapshot = (generation = 4, currentTarget = source, foreground = true) => envelope("update", {
    connectionGeneration, foreground,
    surfaces: [{ surfaceId: "panel", generation, target: currentTarget, desired: "listening", observed: "waiting" }],
  });
  snapshot();
  function accept(operationId = "turn-1", originTarget = source) {
    return service.acceptTurn(ws, { clientInstanceId: "phone", connectionGeneration, surfaceId: "panel", ownerGeneration: 4, target: originTarget },
      { subjectId: "owner", callerOperationId: operationId, target: originTarget });
  }
  const contextId = (control) => control.instruction.match(/ctx_[a-f0-9-]+/)[0];
  const body = (control, action = "stop") => ({ operationId: `${epoch}.${randomUUID()}`, context: contextId(control), action,
    expectedGeneration: 4, ...(action === "handoff" ? { target } : {}) });
  return { service, ws, envelope, sent, connectionGeneration, epoch, snapshot, accept, contextId, body };
}

test("accepted stop routes only to origin socket; result survives owner change and run end", async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const control = f.accept(); const body = f.body(control);
  const accepted = await f.service.submit("owner", body);
  assert.equal(accepted.status, "pending");
  const execute = f.sent.at(-1);
  assert.equal(execute.ws, f.ws);
  assert.equal(execute.payload.surfaceId, "panel");
  assert.equal(execute.payload.callerOperationId, "turn-1");
  f.snapshot(5); control.finish();
  f.envelope("result", { connectionGeneration: f.connectionGeneration, status: "applied", generation: 5, desired: "stopped", observed: "stopped", target: source }, body.operationId);
  assert.equal(f.service.getResult("owner", body.operationId).status, "applied");
  assert.equal((await f.service.submit("owner", body)).status, "applied");
  assert.equal(f.sent.filter((entry) => entry.op === "app.control.execute").length, 1);
  await assert.rejects(f.service.submit("owner", { ...body, expectedGeneration: 5 }), { code: "operation_conflict" });
  assert.equal(f.service.getResult("other", body.operationId).status, "operation_status_unknown");
});

test("handoff final result is independent from source surface lifetime, pending does not mean applied", async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const control = f.accept(); const body = f.body(control, "handoff");
  await f.service.submit("owner", body);
  f.envelope("result", { connectionGeneration: f.connectionGeneration, status: "pending", reason: "waiting_for_caller_reply" }, body.operationId);
  control.finish(); f.snapshot(5, target);
  assert.equal(f.service.getResult("owner", body.operationId).status, "pending");
  f.envelope("result", { connectionGeneration: f.connectionGeneration, status: "applied", generation: 5, desired: "listening", observed: "recording", target }, body.operationId);
  assert.equal(f.service.getResult("owner", body.operationId).status, "applied");
});

test("other authenticated socket cannot ACK or change delivery ownership", async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const control = f.accept(); const body = f.body(control);
  await f.service.submit("owner", body);
  const other = {};
  f.service.handleMessage(other, { channel: "control", op: "app.control.register", payload: { version: 1, clientInstanceId: "phone" } });
  const otherGeneration = f.sent.at(-1).payload.connectionGeneration;
  f.service.handleMessage(other, { channel: "control", op: "app.control.result", operationId: body.operationId,
    payload: { connectionGeneration: otherGeneration, status: "applied", desired: "stopped", observed: "stopped" } });
  assert.equal(f.service.getResult("owner", body.operationId).status, "pending");
  f.service.disconnect(f.ws);
  assert.equal(f.service.getResult("owner", body.operationId).status, "client_offline");
  assert.equal(f.sent.filter((entry) => entry.op === "app.control.execute" && entry.ws === other).length, 0);
});

test("old context cannot follow background, reconnect, next turn or manual owner change", async (t) => {
  for (const change of [(f) => f.snapshot(5), (f) => f.snapshot(4, source, false), (f) => f.accept("turn-2"),
    (f) => f.envelope("register", { version: 1, clientInstanceId: "phone" })]) {
    const f = fixture(); t.after(() => f.service.close());
    const control = f.accept(); const body = f.body(control); change(f);
    assert.notEqual((await f.service.submit("owner", body)).status, "pending");
    assert.equal(f.sent.filter((entry) => entry.op === "app.control.execute").length, 0);
  }
});

test("one mutation is claimed before target validation; no delivery after origin expires during await", async (t) => {
  let resolve; const validation = new Promise((r) => { resolve = r; });
  const f = fixture(() => validation); t.after(() => f.service.close());
  const control = f.accept(); const body = f.body(control, "handoff");
  const submission = f.service.submit("owner", body);
  await assert.rejects(f.service.submit("owner", { ...body, operationId: `${f.epoch}.${randomUUID()}` }), { code: "operation_conflict" });
  assert.equal((await f.service.submit("owner", body)).status, "pending");
  control.finish(); resolve();
  assert.equal((await submission).status, "context_expired");
  assert.equal(f.sent.filter((entry) => entry.op === "app.control.execute").length, 0);
});

test("finite schema rejects arbitrary action, malformed targets, oversized IDs and stale runner epoch", async (t) => {
  const f = fixture(); t.after(() => f.service.close()); const control = f.accept();
  for (const patch of [{ action: "open" }, { action: "stop", target }, { context: "x".repeat(1024) },
    { action: "handoff", target: { ...source, cwd: "relative" } }, { extra: "command" }]) {
    await assert.rejects(f.service.submit("owner", { ...f.body(control), ...patch }));
  }
  await assert.rejects(f.service.submit("owner", { ...f.body(control), operationId: `${randomUUID()}.${randomUUID()}` }), { code: "operation_status_unknown" });
  assert.equal(f.service.acceptTurn(f.ws, { clientInstanceId: "forged" }, { target: source }), null);
  assert.equal(f.sent.filter((entry) => entry.op === "app.control.execute").length, 0);
});

test("success ACK requires the requested observable native state", async (t) => {
  const f = fixture(); t.after(() => f.service.close()); const body = f.body(f.accept(), "handoff");
  await f.service.submit("owner", body);
  f.envelope("result", { connectionGeneration: f.connectionGeneration, status: "applied", desired: "listening", observed: "waiting", target }, body.operationId);
  assert.equal(f.service.getResult("owner", body.operationId).status, "pending");
  assert.equal(f.sent.at(-1).op, "app.control.error");
});

test("Bearer protected HTTP handler passes bounded request and JSON result end to end", async (t) => {
  const f = fixture(); t.after(() => f.service.close()); const body = f.body(f.accept());
  const responses = []; let reads = 0;
  const handler = createAppControlHttpHandler({ service: f.service, runnerToken: "secret", subjectId: "owner",
    parseAuthToken: (req) => req.token, json: (_res, status, value) => responses.push({ status, value }),
    readJsonBody: async (_req, limit) => { assert.equal(limit, 8192); reads++; return body; } });
  await handler({ method: "POST", token: "bad" }, {}, null, "/app-control/operations");
  assert.equal(responses.at(-1).status, 401); assert.equal(reads, 0);
  await handler({ method: "GET", token: "secret" }, {}, null, `/app-control/contexts/${body.context}`);
  assert.equal(responses.at(-1).value.status, "ready");
  await handler({ method: "POST", token: "secret" }, {}, null, "/app-control/operations");
  assert.equal(responses.at(-1).status, 202);
  f.envelope("result", { connectionGeneration: f.connectionGeneration, status: "applied", generation: 5, desired: "stopped", observed: "stopped", target: source }, body.operationId);
  await handler({ method: "GET", token: "secret" }, {}, null, `/app-control/operations/${body.operationId}`);
  assert.equal(responses.at(-1).value.status, "applied");
  assert.equal(JSON.stringify(responses).includes("secret"), false);
});

test("first accepted session waits for both provider resolution and matching app snapshot", async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const unresolved = { ...source, sessionRef: { backendId: "codex", nativeSessionId: null } };
  f.snapshot(4, unresolved);
  const control = f.accept("first-turn", unresolved); const body = f.body(control);
  assert.equal((await f.service.submit("owner", body)).status, "stale_origin");
  control.bindResolvedSession(source.sessionRef, source.cwd);
  f.snapshot(4, unresolved); f.snapshot(4, unresolved);
  assert.equal(f.service.getContext("owner", body.context).status, "pending_session_resolution");
  assert.equal((await f.service.submit("owner", body)).status, "pending_session_resolution");
  f.snapshot(4, source);
  assert.equal(f.service.getContext("owner", body.context).status, "ready");
  assert.equal((await f.service.submit("owner", body)).status, "pending");
  assert.equal(f.sent.filter((entry) => entry.op === "app.control.execute").length, 1);
});

test("deadline cancels pending start; late native confirmation only reconciles result", async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const body = f.body(f.accept()); await f.service.submit("owner", body);
  await new Promise((resolve) => setTimeout(resolve, 5050));
  assert.equal(f.service.getResult("owner", body.operationId).status, "operation_status_unknown");
  assert.equal(f.sent.at(-1).op, "app.control.cancel");
  f.envelope("result", { connectionGeneration: f.connectionGeneration, status: "pending" }, body.operationId);
  assert.equal(f.service.getResult("owner", body.operationId).status, "operation_status_unknown");
  f.envelope("result", { connectionGeneration: f.connectionGeneration, status: "applied", generation: 5, desired: "stopped", observed: "stopped", target: source }, body.operationId);
  assert.equal(f.service.getResult("owner", body.operationId).status, "applied");
  assert.equal(f.sent.filter((entry) => entry.op === "app.control.execute").length, 1);
});

test("background cancels accepted waiting start and never accepts a later start acknowledgement", async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const body = f.body(f.accept(), "handoff"); await f.service.submit("owner", body);
  f.snapshot(4, source, false);
  assert.equal(f.service.getResult("owner", body.operationId).status, "client_background");
  assert.equal(f.sent.at(-1).op, "app.control.cancel");
  f.envelope("result", { connectionGeneration: f.connectionGeneration, status: "applied", generation: 5, desired: "listening", observed: "recording", target }, body.operationId);
  assert.equal(f.service.getResult("owner", body.operationId).status, "client_background");
});

test("context capacity and final result retention are bounded without durable command replay", async (t) => {
  let clock = 1_000_000;
  const f = fixture(async () => {}, () => clock); t.after(() => f.service.close());
  const first = f.accept(); const body = f.body(first);
  await f.service.submit("owner", body);
  f.envelope("result", { connectionGeneration: f.connectionGeneration, status: "applied", generation: 4, desired: "stopped", observed: "stopped", target: source }, body.operationId);
  for (let index = 1; index < 2048; index++) assert.ok(f.accept(`turn-${index}`));
  assert.equal(f.accept("over-capacity"), null);
  clock += 15 * 60_000 + 1;
  assert.equal(f.service.getResult("owner", body.operationId).status, "operation_status_unknown");
  await assert.rejects(f.service.submit("owner", body), { code: "context_expired" });
  assert.ok(f.accept("after-expiry"));
  assert.equal(f.sent.filter((entry) => entry.op === "app.control.execute").length, 1);
});

test("app target_not_found ACK finalizes immediately instead of timing out", async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const body = f.body(f.accept(), "handoff"); await f.service.submit("owner", body);
  f.envelope("result", { connectionGeneration: f.connectionGeneration, status: "target_not_found",
    desired: "listening", observed: "waiting", target: source, generation: 4 }, body.operationId);
  assert.equal(f.service.getResult("owner", body.operationId).status, "target_not_found");
  assert.notEqual(f.sent.at(-1).op, "app.control.error");
});

test("deadline returns a pending validation POST and late validation never dispatches", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 1_000_000;
  let resolveValidation;
  const validation = new Promise((resolve) => { resolveValidation = resolve; });
  const f = fixture(() => validation, () => clock); t.after(() => f.service.close());
  const body = f.body(f.accept(), "handoff");
  const submission = f.service.submit("owner", body);
  let returned = false;
  submission.then(() => { returned = true; });
  await Promise.resolve();
  assert.equal(returned, false);
  clock += 15_001;
  t.mock.timers.tick(15_001);
  assert.equal((await submission).status, "operation_status_unknown");
  assert.equal(returned, true);
  assert.equal(f.service.getResult("owner", body.operationId).status, "operation_status_unknown");
  assert.equal(f.sent.at(-1).op, "app.control.cancel");
  resolveValidation(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.sent.filter((message) => message.op === "app.control.execute").length, 0);
  assert.equal(f.service.getResult("owner", body.operationId).status, "operation_status_unknown");
});
