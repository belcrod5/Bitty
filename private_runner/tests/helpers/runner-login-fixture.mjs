import { mock } from "node:test";

// Business-runtime tests inject their identity provider. The actual authentication
// service, persistence, HTTP/TLS gates and WS revocation are exercised separately
// by runner-login*.test.mjs and runner-local-https.test.mjs with real session flows.
export function mockRunnerLogin(runtime, token = process.env.RUNNER_TOKEN) {
  const context = { sessionId: "fixture-session", ownerSubjectId: runtime.runnerLoginService.ownerSubjectId, local: false };
  mock.method(runtime.runnerLoginService, "authenticate", async (value) => {
    if (!token || value !== token) throw Object.assign(new Error("authentication_required"), { status: 401, code: "authentication_required" });
    return context;
  });
  mock.method(runtime.runnerLoginService, "attachSocket", () => {});
  mock.method(runtime.runnerLoginService, "isSessionActive", (id) => id === context.sessionId);
  mock.method(runtime.runnerLoginService, "assertReauthenticated", () => {});
}
