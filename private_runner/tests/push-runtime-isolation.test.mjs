import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { promises as fs } from "node:fs";
import http2 from "node:http2";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "push-runtime-isolation-"));
const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const keyPath = path.join(root, "fake-apns-key.p8");
await fs.writeFile(keyPath, privateKey, { mode: 0o600 });
Object.assign(process.env, {
  RUNNER_SKIP_SERVER_START: "1",
  RUNNER_TOKEN: "test-token",
  APNS_KEY_PATH: keyPath,
  APNS_KEY_ID: "TESTKEYID1",
  APPLE_TEAM_ID: "TESTTEAMID",
  // Even an inherited, configured device store must not enable real delivery.
  PUSH_DEVICE_STORE_PATH: path.join(root, "push-devices.json"),
  CODEX_AUTH_STORE_DIR: path.join(root, "auth"),
  CLIENT_STATE_STORE_PATH: path.join(root, "client-state.json"),
  CODEX_WS_PROXY_DEBUG_LOG_DIR: path.join(root, "ws-debug"),
});
const { __TESTING__: runtime } = await import("../src/server-runtime.mjs");
await runtime.pushDeviceStore.upsertDevice({ deviceId: "fake-device", apnsToken: "fake-token", env: "production" });

test.after(async () => {
  await new Promise((resolve) => runtime.server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

test("an imported Runner never sends synthetic quota or widget notifications with configured APNs credentials and devices", async (t) => {
  const connections = [];
  t.mock.method(http2, "connect", (authority) => {
    connections.push(authority);
    throw new Error("test must not contact APNs");
  });
  t.mock.method(console, "warn", () => {});
  t.mock.method(runtime.codexAuthRuntime, "activePayload", () => ({ chatgptAccountId: "test-account" }));

  const snapshot = await runtime.codexUsageService.observeNotification("test-account", "error", {
    error: { codexErrorInfo: "usageLimitExceeded" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(snapshot.usageLimitReached, true);
  assert.deepEqual(connections, []);
  assert.equal(runtime.apnsClient.enabled, false);
  await assert.rejects(runtime.apnsClient.sendToDevice("fake-token", {}), /apns_client_disabled/);
});

test("imported push hooks remain testable with an explicit mocked sender", async (t) => {
  const sent = [];
  t.mock.method(runtime.apnsClient, "sendToDevice", async (token, payload) => {
    sent.push({ token, payload });
    return { ok: true, status: 200 };
  });

  await runtime.turnCompletionNotifier.notifyUsageLimitReached({ accountId: "mock-account", episode: "test-episode" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, "fake-token");
  assert.equal(sent[0].payload.aps.category, "CODEX_USAGE_LIMIT");
});
