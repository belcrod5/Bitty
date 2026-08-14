import assert from "node:assert/strict";
import test from "node:test";

import { createCodexScheduleHttpHandler } from "../src/codex-schedule-http.mjs";
import {
  CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES,
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

test("missing runner token and unsupported methods do not enter the service", async () => {
  const missing = harness({ token: "" });
  await missing.handler({ method: "GET" }, {}, "/codex-schedules");
  assert.equal(missing.responses[0].status, 500);

  const method = harness();
  await method.handler({ method: "POST", auth: "secret" }, {}, "/codex-schedules");
  assert.deepEqual(method.responses[0], {
    status: 405,
    payload: { error: "method_not_allowed" },
  });
});
