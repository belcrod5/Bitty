import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
// Intentionally leave APNS_KEY_PATH / APNS_KEY_ID / APPLE_TEAM_ID unset so this
// process imports server-runtime.mjs with the push feature disabled end-to-end.
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

test("POST /push/devices requires a bearer token", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/push/devices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "device-1", apnsToken: "token-1" }),
    });
    assert.equal(response.status, 401);
    const data = await response.json();
    assert.equal(data.error, "unauthorized");
  });
});

test("POST /push/devices rejects an incorrect bearer token", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/push/devices`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ deviceId: "device-1", apnsToken: "token-1" }),
    });
    assert.equal(response.status, 401);
  });
});

test("POST /push/devices is a harmless no-op when push is not configured", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/push/devices`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-runner-token",
      },
      body: JSON.stringify({ deviceId: "device-1", apnsToken: "token-1" }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data, { ok: true, enabled: false });
  });
});

test("DELETE /push/devices/:deviceId requires a bearer token and is a no-op when disabled", async () => {
  await withServer(async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/push/devices/device-1`, { method: "DELETE" });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/push/devices/device-1`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-runner-token" },
    });
    assert.equal(authorized.status, 200);
    const data = await authorized.json();
    assert.deepEqual(data, { ok: true, enabled: false });
  });
});
