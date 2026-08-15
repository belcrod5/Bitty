import assert from "node:assert/strict";
import test from "node:test";

import { createCodexScheduleHttpHandler } from "../src/codex-schedule-http.mjs";
import {
  CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES,
  CodexScheduleIdempotencyConflictError,
  CodexScheduleNotFoundError,
  CodexScheduleRevisionConflictError,
  CodexScheduleStoreUnavailableError,
} from "../src/codex-schedule-service.mjs";

function harness({ service, token = "secret", body = {} } = {}) {
  const responses = [];
  let requestedMaxBytes = null;
  const handler = createCodexScheduleHttpHandler({
    service: service || {
      snapshot: async () => ({ revision: 2, schedules: [] }),
      replaceSchedules: async () => ({ revision: 3, schedules: [] }),
      createSchedule: async () => ({ created: true, revision: 3, schedule: { id: ID } }),
      patchSchedule: async () => ({ updated: true, revision: 3, schedule: { id: ID } }),
      deleteSchedule: async () => ({ deleted: true, revision: 3, id: ID }),
    },
    runnerToken: token,
    parseAuthToken: (req) => req.auth || "",
    readJsonBody: async (_req, maxBytes) => {
      requestedMaxBytes = maxBytes;
      if (body instanceof Error) throw body;
      return body;
    },
    json: (_res, status, payload) => responses.push({ status, payload }),
  });
  return { handler, responses, requestedMaxBytes: () => requestedMaxBytes };
}

const ID = "11111111-1111-4111-8111-111111111111";

test("GET and PUT use bearer auth and return the flat revision snapshot", async () => {
  const get = harness();
  assert.equal(await get.handler({ method: "GET", auth: "secret" }, {}, "/other"), false);
  assert.equal(await get.handler({ method: "GET", auth: "bad" }, {}, "/codex-schedules"), true);
  assert.deepEqual(get.responses.pop(), { status: 401, payload: { error: "unauthorized" } });
  await get.handler({ method: "GET", auth: "secret" }, {}, "/codex-schedules");
  assert.deepEqual(get.responses.pop(), {
    status: 200,
    payload: { ok: true, revision: 2, schedules: [] },
  });

  const put = harness({ body: { baseRevision: 2, schedules: [] } });
  await put.handler({ method: "PUT", auth: "secret" }, {}, "/codex-schedules");
  assert.equal(put.requestedMaxBytes(), CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES);
  assert.deepEqual(put.responses.pop(), {
    status: 200,
    payload: { ok: true, revision: 3, schedules: [] },
  });
});

test("endpoint maps invalid input, revision conflicts, and unavailable stores", async () => {
  const invalid = harness({ body: new Error("request body is too large") });
  await invalid.handler({ method: "PUT", auth: "secret" }, {}, "/codex-schedules");
  assert.deepEqual(invalid.responses.pop(), {
    status: 400,
    payload: { error: "invalid_codex_schedules", message: "request body is too large" },
  });

  const conflict = harness({
    service: {
      replaceSchedules: async () => { throw new CodexScheduleRevisionConflictError(9); },
    },
  });
  await conflict.handler({ method: "PUT", auth: "secret" }, {}, "/codex-schedules");
  assert.deepEqual(conflict.responses.pop(), {
    status: 409,
    payload: { error: "revision_conflict", revision: 9 },
  });

  const unavailable = harness({
    service: {
      snapshot: async () => { throw new CodexScheduleStoreUnavailableError("store is corrupt"); },
    },
  });
  await unavailable.handler({ method: "GET", auth: "secret" }, {}, "/codex-schedules");
  assert.deepEqual(unavailable.responses.pop(), {
    status: 503,
    payload: { error: "codex_schedule_store_unavailable", message: "store is corrupt" },
  });
});

test("POST, PATCH, and DELETE map item operations without editing schedules in the route", async () => {
  const calls = [];
  const service = {
    createSchedule: async (body, id) => {
      calls.push(["create", body, id]);
      return { created: true, revision: 3, schedule: { id } };
    },
    patchSchedule: async (id, body) => {
      calls.push(["patch", id, body]);
      return { updated: false, revision: 3, schedule: { id } };
    },
    deleteSchedule: async (id, body) => {
      calls.push(["delete", id, body]);
      return { deleted: true, id, revision: 4 };
    },
  };
  const post = harness({ service, body: { baseRevision: 2, schedule: {} } });
  await post.handler({
    method: "POST",
    auth: "secret",
    headers: { "idempotency-key": ID },
  }, {}, "/codex-schedules");
  assert.equal(post.responses[0].status, 201);
  assert.equal(post.requestedMaxBytes(), CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES);

  const patch = harness({ service, body: { baseRevision: 3, patch: { enabled: false } } });
  await patch.handler({ method: "PATCH", auth: "secret" }, {}, `/codex-schedules/${ID}`);
  assert.equal(patch.responses[0].status, 200);
  assert.equal(patch.responses[0].payload.updated, false);

  const deletion = harness({ service, body: { baseRevision: 3 } });
  await deletion.handler({ method: "DELETE", auth: "secret" }, {}, `/codex-schedules/${ID}`);
  assert.equal(deletion.responses[0].status, 200);
  assert.equal(deletion.requestedMaxBytes(), 16 * 1024);
  assert.deepEqual(calls, [
    ["create", { baseRevision: 2, schedule: {} }, ID],
    ["patch", ID, { baseRevision: 3, patch: { enabled: false } }],
    ["delete", ID, { baseRevision: 3 }],
  ]);
});

test("route matching authenticates before method and member ID validation", async () => {
  const trailing = harness();
  assert.equal(await trailing.handler({ method: "PATCH", auth: "secret" }, {}, "/codex-schedules/"), false);
  assert.equal(await trailing.handler({ method: "PATCH", auth: "secret" }, {}, `/codex-schedules/${ID}/more`), false);

  const unauthorized = harness();
  await unauthorized.handler({ method: "PATCH", auth: "bad" }, {}, "/codex-schedules/%ZZ");
  assert.equal(unauthorized.responses[0].status, 401);

  const unsupported = harness();
  await unsupported.handler({ method: "GET", auth: "secret" }, {}, "/codex-schedules/%ZZ");
  assert.equal(unsupported.responses[0].status, 405);

  for (const raw of ["%ZZ", "%2F", "not-a-uuid"]) {
    const invalid = harness();
    await invalid.handler({ method: "PATCH", auth: "secret" }, {}, `/codex-schedules/${raw}`);
    assert.deepEqual(invalid.responses[0], {
      status: 400,
      payload: { error: "invalid_codex_schedule_id" },
    });
  }
});

test("item errors and POST idempotency headers map to the fixed contract", async () => {
  const missing = harness();
  await missing.handler({ method: "POST", auth: "secret", headers: {} }, {}, "/codex-schedules");
  assert.equal(missing.responses[0].payload.error, "idempotency_key_required");

  const invalid = harness();
  await invalid.handler({
    method: "POST",
    auth: "secret",
    headers: { "idempotency-key": "bad" },
  }, {}, "/codex-schedules");
  assert.equal(invalid.responses[0].payload.error, "invalid_idempotency_key");

  const conflict = harness({
    service: {
      createSchedule: async () => { throw new CodexScheduleIdempotencyConflictError(ID, 7); },
    },
  });
  await conflict.handler({
    method: "POST",
    auth: "secret",
    headers: { "idempotency-key": ID },
  }, {}, "/codex-schedules");
  assert.deepEqual(conflict.responses[0], {
    status: 409,
    payload: { error: "idempotency_conflict", id: ID, revision: 7 },
  });

  const notFound = harness({
    service: { patchSchedule: async () => { throw new CodexScheduleNotFoundError(); } },
  });
  await notFound.handler({ method: "PATCH", auth: "secret" }, {}, `/codex-schedules/${ID}`);
  assert.deepEqual(notFound.responses[0], {
    status: 404,
    payload: { error: "codex_schedule_not_found" },
  });
});

test("missing runner token and unsupported methods do not enter the service", async () => {
  const missing = harness({ token: "" });
  await missing.handler({ method: "GET" }, {}, "/codex-schedules");
  assert.equal(missing.responses[0].status, 500);

  const method = harness();
  await method.handler({ method: "DELETE", auth: "secret" }, {}, "/codex-schedules");
  assert.deepEqual(method.responses[0], {
    status: 405,
    payload: { error: "method_not_allowed" },
  });
});
