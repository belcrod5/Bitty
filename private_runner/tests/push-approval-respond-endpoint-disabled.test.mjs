import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
// Intentionally leave APNS_KEY_PATH / APNS_KEY_ID / APPLE_TEAM_ID unset so this process
// imports server-runtime.mjs with the push feature disabled end-to-end.
delete process.env.APNS_KEY_PATH;
delete process.env.APNS_KEY_ID;
delete process.env.APPLE_TEAM_ID;

const { __TESTING__ } = await import("../src/server-runtime.mjs");
const { server } = __TESTING__;

async function withServer(fn) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("POST /push/approvals/:id/respond requires a bearer token", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/push/approvals/relay-x:1/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(response.status, 401);
  });
});

test("POST /push/approvals/:id/respond is a harmless no-op when push is not configured", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/push/approvals/relay-x:1/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-runner-token",
      },
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, enabled: false });
  });
});
