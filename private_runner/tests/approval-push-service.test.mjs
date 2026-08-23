import assert from "node:assert/strict";
import test from "node:test";

import { createApprovalPushService } from "../src/approval-push-service.mjs";

function approvalEvent({ backendId = "claude", runId = "run-1", requestId = "approval-1" } = {}) {
  return {
    type: "action.requested",
    runId,
    sessionRef: { backendId, nativeSessionId: `${backendId}-session` },
    payload: {
      requestId,
      kind: "approval",
      title: "Allow a safe command?",
      decisions: ["allow", "deny"],
    },
  };
}

function createHarness(overrides = {}) {
  const sent = [];
  const removed = [];
  const actions = [];
  const devices = overrides.devices || [{ deviceId: "device-1", apnsToken: "token-1", env: "sandbox" }];
  const service = createApprovalPushService({
    enabled: overrides.enabled ?? true,
    runnerToken: "runner-token",
    apnsClient: {
      async sendToDevice(token, payload, options) {
        sent.push({ token, payload, options });
        return overrides.sendToDevice ? await overrides.sendToDevice(token, payload, options, service) : { ok: true, status: 200 };
      },
    },
    deviceStore: {
      listDevices: overrides.listDevices || (async () => devices),
      async removeDevice(deviceId) { removed.push(deviceId); },
    },
    getAgentSessionBinding: overrides.getAgentSessionBinding || (async () => ({ canonicalCwd: "/work/project" })),
    respondToAgentAction: overrides.respondToAgentAction || (async (request) => { actions.push(request); }),
    getRawRelay: () => null,
    forwardRawData() {},
    parseAuthToken: (req) => req.token,
    readJsonBody: async (req) => req.body,
    json(res, status, payload) {
      res.status = status;
      res.payload = payload;
    },
    writeJsonRequestError(res, error, fallbackError) {
      res.status = 400;
      res.payload = { error: fallbackError, message: error.message };
    },
  });
  return { service, sent, removed, actions };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

async function respond(service, approvalId, approved, overrides = {}) {
  const req = {
    method: "POST",
    token: overrides.token ?? "runner-token",
    body: overrides.body ?? { approved },
  };
  const res = {};
  const handled = await service.handleHttpRequest(req, res, `/push/approvals/${approvalId}/respond`);
  assert.equal(handled, true);
  return res;
}

test("observes Claude and Codex approvals through one path and clears stale IDs", async () => {
  const { service, sent } = createHarness();
  const claude = approvalEvent();
  service.onRunEvent(claude);
  await waitFor(() => sent.length === 1);

  const first = sent[0].payload;
  assert.match(first.approvalId, /^agent-approval:/);
  assert.equal(first.backendId, "claude");
  assert.equal(first.sessionId, "claude-session");
  assert.equal(first.directory, "/work/project");
  assert.equal(first.aps.alert.title, "project");
  assert.equal(first.aps.alert.body, "Allow a safe command?");
  assert.equal(first.aps.category, "APPROVAL_REQUEST");
  assert.equal(first.aps["interruption-level"], "time-sensitive");

  service.onRunEvent({ ...claude, sequence: 99 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1, "action handoff must not send a duplicate approval push");

  service.onRunEvent({ ...claude, type: "action.resolved", payload: { requestId: "approval-1" } });
  assert.equal((await respond(service, first.approvalId, true)).status, 409);

  service.onRunEvent(approvalEvent({ backendId: "codex", runId: "run-2", requestId: "approval-2" }));
  await waitFor(() => sent.length === 2);
  assert.equal(sent[1].payload.backendId, "codex");
  service.onRunEvent({ type: "turn.completed", runId: "run-2", payload: {} });
  assert.equal((await respond(service, sent[1].payload.approvalId, true)).status, 409);
});

test("ignores dynamic tools and actions without allow and deny", async () => {
  const { service, sent } = createHarness();
  const event = approvalEvent();
  service.onRunEvent({ ...event, payload: { requestId: "tool", kind: "dynamic_tool", decisions: ["result"] } });
  service.onRunEvent({ ...event, payload: { requestId: "partial", kind: "approval", decisions: ["allow"] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
});

test("rechecks neutral pending state after device listing and before every device", async () => {
  let releaseDevices;
  let listingStarted;
  const started = new Promise((resolve) => { listingStarted = resolve; });
  const stale = createHarness({
    listDevices: async () => {
      listingStarted();
      return await new Promise((resolve) => { releaseDevices = resolve; });
    },
  });
  const event = approvalEvent({ runId: "stale-run", requestId: "stale-request" });
  stale.service.onRunEvent(event);
  await started;
  stale.service.onRunEvent({ ...event, type: "action.resolved", payload: { requestId: "stale-request" } });
  releaseDevices([{ deviceId: "stale", apnsToken: "stale-token", env: "sandbox" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stale.sent.length, 0);

  let requestedEvent;
  const perDevice = createHarness({
    devices: [
      { deviceId: "first", apnsToken: "first-token", env: "sandbox" },
      { deviceId: "second", apnsToken: "second-token", env: "sandbox" },
    ],
    sendToDevice: async (_token, _payload, _options, service) => {
      service.onRunEvent({ ...requestedEvent, type: "action.resolved", payload: { requestId: "race-request" } });
      return { ok: true, status: 200 };
    },
  });
  requestedEvent = approvalEvent({ runId: "race-run", requestId: "race-request" });
  perDevice.service.onRunEvent(requestedEvent);
  await waitFor(() => perDevice.sent.length > 0);
  assert.equal(perDevice.sent.length, 1);
});

test("routes neutral approve and deny decisions with responder-compatible results", async () => {
  const { service, sent, actions } = createHarness();
  for (const [index, approved, decision] of [[1, true, "allow"], [2, false, "deny"]]) {
    service.onRunEvent(approvalEvent({ runId: `run-${index}`, requestId: `request-${index}` }));
    await waitFor(() => sent.length === index);
    const response = await respond(service, sent[index - 1].payload.approvalId, approved);
    assert.equal(response.status, 200);
    assert.deepEqual(response.payload, { ok: true, enabled: true, approved });
    assert.equal(actions.at(-1).decision, decision);
  }
});

test("reserves neutral responses synchronously and allows retry after unexpected failure", async () => {
  let release;
  const calls = [];
  let attempt = 0;
  const { service, sent } = createHarness({
    respondToAgentAction(request) {
      calls.push(request);
      attempt += 1;
      if (attempt === 1) return new Promise((resolve) => { release = resolve; });
      if (attempt === 2) throw new Error("temporary failure");
    },
  });
  service.onRunEvent(approvalEvent());
  await waitFor(() => sent.length === 1);
  const approvalId = sent[0].payload.approvalId;

  const first = respond(service, approvalId, true);
  await waitFor(() => calls.length === 1);
  assert.equal((await respond(service, approvalId, false)).status, 409);
  assert.equal(calls.length, 1);
  release();
  assert.equal((await first).status, 200);

  service.onRunEvent(approvalEvent({ runId: "retry-run", requestId: "retry-request" }));
  await waitFor(() => sent.length === 2);
  const retryId = sent[1].payload.approvalId;
  assert.equal((await respond(service, retryId, true)).status, 500);
  assert.equal((await respond(service, retryId, true)).status, 200);
});

test("normalizes expired and malformed neutral approvals and keeps auth/no-op behavior", async () => {
  const expired = new Error("expired");
  expired.code = "action_expired";
  const { service, sent } = createHarness({ respondToAgentAction: async () => { throw expired; } });
  service.onRunEvent(approvalEvent());
  await waitFor(() => sent.length === 1);
  const approvalId = sent[0].payload.approvalId;
  assert.equal((await respond(service, approvalId, true)).status, 409);
  assert.equal((await respond(service, approvalId, true)).status, 409);
  assert.equal((await respond(service, "agent-approval:not-a-uuid", true)).status, 400);
  assert.equal((await respond(service, approvalId, true, { token: "wrong" })).status, 401);

  const disabled = createHarness({ enabled: false }).service;
  const noOp = await respond(disabled, "anything", true);
  assert.deepEqual(noOp, { status: 200, payload: { ok: true, enabled: false } });
});

test("keeps shared APNs 410 cleanup behavior", async () => {
  const { service, removed } = createHarness({
    sendToDevice: async () => ({ ok: false, status: 410, reason: "Unregistered" }),
  });
  service.onRunEvent(approvalEvent());
  await waitFor(() => removed.length === 1);
  assert.deepEqual(removed, ["device-1"]);
});
