import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.CALENDAR_CODEX_WS_UPSTREAM_URL = "ws://calendar-only.test/app-server";
process.env.CALENDAR_CODEX_WS_UPSTREAM_TOKEN = "calendar-ws-token";
process.env.CALENDAR_CODEX_CAPABILITY_URL = "https://calendar-only.test/capability";
process.env.CALENDAR_CODEX_CAPABILITY_TOKEN = "capability-token";
process.env.CODEX_WS_PROXY_UPSTREAM_URL = "ws://shared-upstream.test/app-server";

const { __TESTING__ } = await import("../src/server-runtime.mjs?calendar-schedule-test");

test("calendar capability preflight is authenticated and fails closed", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        capability: "calendar-read-v1",
        sandbox: { hostMounts: false, inheritedEnv: false, toolNetwork: false },
      }),
    };
  };
  try {
    assert.equal(await __TESTING__.calendarSchedulePreflight(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://calendar-only.test/capability");
    assert.deepEqual(calls[0].options.headers, { authorization: "Bearer capability-token" });
    assert.equal(__TESTING__.calendarCapabilityMatches({
      capability: "calendar-read-v1",
      sandbox: { hostMounts: false, inheritedEnv: true, toolNetwork: false },
    }), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("calendar connection has no shared-upstream fallback", () => {
  assert.deepEqual(__TESTING__.calendarScheduleConnectionOptions(), {
    upstreamUrl: "ws://calendar-only.test/app-server",
    upstreamToken: "calendar-ws-token",
  });
});
