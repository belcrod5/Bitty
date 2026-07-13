import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-devices-endpoint-"));

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
// Registration never reads the key file, so a placeholder path is enough to flip
// PUSH_ENABLED on for this process.
process.env.APNS_KEY_PATH = path.join(tempDir, "AuthKey_TEST.p8");
process.env.APNS_KEY_ID = "TESTKEYID1";
process.env.APPLE_TEAM_ID = "TESTTEAMID";
process.env.PUSH_DEVICE_STORE_PATH = path.join(tempDir, "push_devices.json");

const { __TESTING__ } = await import("../src/server-runtime.mjs");
const { server, pushDeviceStore } = __TESTING__;

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

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

test("POST /push/devices rejects a body missing deviceId or apnsToken", async () => {
  await withServer(async (baseUrl) => {
    const missingToken = await fetch(`${baseUrl}/push/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-runner-token" },
      body: JSON.stringify({ deviceId: "device-1" }),
    });
    assert.equal(missingToken.status, 400);

    const missingDeviceId = await fetch(`${baseUrl}/push/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-runner-token" },
      body: JSON.stringify({ apnsToken: "token-1" }),
    });
    assert.equal(missingDeviceId.status, 400);
  });
});

test("POST /push/devices registers a device and persists it idempotently", async () => {
  await withServer(async (baseUrl) => {
    const first = await fetch(`${baseUrl}/push/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-runner-token" },
      body: JSON.stringify({ deviceId: "device-1", apnsToken: "token-1" }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.enabled, true);
    assert.equal(firstBody.device.deviceId, "device-1");
    assert.equal(firstBody.device.env, "sandbox");

    const second = await fetch(`${baseUrl}/push/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-runner-token" },
      body: JSON.stringify({ deviceId: "device-1", apnsToken: "token-2" }),
    });
    assert.equal(second.status, 200);

    const devices = await pushDeviceStore.listDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].apnsToken, "token-2");
  });
});

test("DELETE /push/devices/:deviceId removes a registered device", async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/push/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-runner-token" },
      body: JSON.stringify({ deviceId: "device-to-remove", apnsToken: "token-x" }),
    });

    const removed = await fetch(`${baseUrl}/push/devices/device-to-remove`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-runner-token" },
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true, enabled: true, removed: true });

    const removedAgain = await fetch(`${baseUrl}/push/devices/device-to-remove`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-runner-token" },
    });
    assert.deepEqual(await removedAgain.json(), { ok: true, enabled: true, removed: false });
  });
});
