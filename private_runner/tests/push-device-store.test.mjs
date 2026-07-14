import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPushDeviceStore } from "../src/push-device-store.mjs";

async function withTempStorePath(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-device-store-"));
  try {
    return await fn(path.join(tempDir, "push_devices.json"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("upsertDevice creates a new record with registeredAt and lastSeenAt set", async () => {
  await withTempStorePath(async (storePath) => {
    const store = createPushDeviceStore(storePath);
    const record = await store.upsertDevice({ deviceId: "device-1", apnsToken: "token-1", env: "sandbox" });
    assert.equal(record.deviceId, "device-1");
    assert.equal(record.apnsToken, "token-1");
    assert.equal(record.env, "sandbox");
    assert.ok(record.registeredAt);
    assert.equal(record.registeredAt, record.lastSeenAt);

    const devices = await store.listDevices();
    assert.equal(devices.length, 1);
    assert.deepEqual(devices[0], record);
  });
});

test("upsertDevice is idempotent by deviceId: keeps registeredAt, updates token/env/lastSeenAt", async () => {
  await withTempStorePath(async (storePath) => {
    const store = createPushDeviceStore(storePath);
    const first = await store.upsertDevice({ deviceId: "device-1", apnsToken: "token-1", env: "sandbox" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.upsertDevice({ deviceId: "device-1", apnsToken: "token-2", env: "production" });

    assert.equal(second.registeredAt, first.registeredAt);
    assert.equal(second.apnsToken, "token-2");
    assert.equal(second.env, "production");

    const devices = await store.listDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].apnsToken, "token-2");
  });
});

test("upsertDevice rejects records missing deviceId or apnsToken", async () => {
  await withTempStorePath(async (storePath) => {
    const store = createPushDeviceStore(storePath);
    await assert.rejects(store.upsertDevice({ deviceId: "", apnsToken: "token-1" }));
    await assert.rejects(store.upsertDevice({ deviceId: "device-1", apnsToken: "" }));
  });
});

test("removeDevice deletes an existing record and reports missing ones", async () => {
  await withTempStorePath(async (storePath) => {
    const store = createPushDeviceStore(storePath);
    await store.upsertDevice({ deviceId: "device-1", apnsToken: "token-1" });
    assert.equal(await store.removeDevice("device-1"), true);
    assert.deepEqual(await store.listDevices(), []);
    assert.equal(await store.removeDevice("device-1"), false);
    assert.equal(await store.removeDevice("never-registered"), false);
  });
});

test("a corrupted store file is reinitialized safely instead of throwing", async () => {
  await withTempStorePath(async (storePath) => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, "{not valid json", "utf8");
    const store = createPushDeviceStore(storePath);
    assert.deepEqual(await store.listDevices(), []);
    const record = await store.upsertDevice({ deviceId: "device-1", apnsToken: "token-1" });
    assert.equal(record.deviceId, "device-1");
  });
});

test("registrations persist across store instances (same file)", async () => {
  await withTempStorePath(async (storePath) => {
    const storeA = createPushDeviceStore(storePath);
    await storeA.upsertDevice({ deviceId: "device-1", apnsToken: "token-1" });

    const storeB = createPushDeviceStore(storePath);
    const devices = await storeB.listDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].deviceId, "device-1");
    assert.equal(devices[0].apnsToken, "token-1");
  });
});
