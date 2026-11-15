import assert from "node:assert/strict";
import test from "node:test";
import { createICloudCalendarHttpHandler } from "../src/icloud-calendar-http.mjs";
import { RUNNER_AUTHENTICATION, createRunnerLoginHttp } from "../src/runner-login-http.mjs";

function fixture() {
  const calls = [], responses = [];
  const service = Object.fromEntries(["status", "test", "save", "setEnabled", "disconnect"].map((name) => [name, async (...args) => { calls.push([name, ...args]); return { configured: false, enabled: false, account: "", testedAt: null }; }]));
  const handler = createICloudCalendarHttpHandler({ service, readJsonBody: async (req) => req.body,
    json: (_res, status, payload) => responses.push({ status, payload }) });
  const req = async (method, pathname, body, authenticated = true) => {
    const request = { method, body, [RUNNER_AUTHENTICATION]: authenticated ? { ownerSubjectId: "owner:one", sessionId: "session" } : undefined };
    const handled = await handler(request, { setHeader() {} }, pathname);
    return { handled, ...responses.pop() };
  };
  return { service, handler, calls, req };
}

test("all iCloud management routes require Runner authentication before reading any body", async () => {
  const f = fixture();
  for (const [method, path] of [["GET", "status"], ["POST", "test"], ["PUT", "connection"], ["PATCH", "connection"], ["DELETE", "connection"]]) {
    assert.equal((await f.req(method, `/calendar/icloud/${path}`, {}, false)).status, 401);
  }
  assert.deepEqual(f.calls, []);
  assert.equal((await f.req("GET", "/unrelated")).handled, false);
  assert.equal((await f.req("POST", "/calendar/icloud/status")).status, 404);
});

test("test/save/toggle/disconnect delegate only through the authenticated service and errors are sanitized", async () => {
  const f = fixture();
  await f.req("POST", "/calendar/icloud/test", { account: "test@example.invalid", password: "test-secret" });
  assert.equal(f.calls[0][0], "test");
  assert.equal(f.calls[0][2].ownerSubjectId, "owner:one");
  await f.req("PUT", "/calendar/icloud/connection", { verificationToken: "tested-token" });
  assert.deepEqual(f.calls[1][1], { verificationToken: "tested-token" });
  await f.req("PATCH", "/calendar/icloud/connection", { enabled: false });
  assert.deepEqual(f.calls[2], ["setEnabled", false]);
  await f.req("DELETE", "/calendar/icloud/connection");
  assert.deepEqual(f.calls[3], ["disconnect"]);
  f.service.test = async () => { throw new Error("password=test-secret response=private"); };
  const failure = await f.req("POST", "/calendar/icloud/test", {});
  assert.equal(failure.status, 503);
  assert.ok(!JSON.stringify(failure).includes("test-secret"));
});

test("existing Runner login wrapper rejects an unauthenticated network caller before iCloud handler", async () => {
  let touched = false;
  const auth = createRunnerLoginHttp({ service: { authenticate: async () => { throw Object.assign(new Error("authentication_required"), { status: 401 }); } } });
  const handler = auth.wrap(async () => { touched = true; });
  let result;
  await handler({ method: "POST", url: "/calendar/icloud/test", headers: {} }, {
    setHeader() {}, writeHead(status) { result = status; }, end() {},
  });
  assert.equal(result, 401);
  assert.equal(touched, false);
});
