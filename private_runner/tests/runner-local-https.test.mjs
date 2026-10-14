import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadLocalRunnerTls, resolveLocalRunnerTlsConfig } from "../src/local-runner-tls.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "bitty-runtime-tls-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-token";
process.env.HOST = "0.0.0.0";
for (const name of ["CODEX_AUTH_STORE_DIR", "BITTY_GOOGLE_AUTH_DIR", "CODEX_CLI_SESSIONS_DIR",
  "TTS_MEDIA_DIR", "LLM_REQUEST_LOG_DIR", "CLIENT_APP_LOG_DIR", "CODEX_WS_PROXY_DEBUG_LOG_DIR",
  "ACP_SESSION_STORE_PATH", "CLI_SESSION_INDEX_PATH", "PUSH_DEVICE_STORE_PATH", "CLIENT_STATE_STORE_PATH",
  "SKIA_BOARD_STORE_PATH", "LLM_FILE_AUDIT_LOG_PATH"]) {
  process.env[name] = path.join(root, name);
}
const { __TESTING__: runtime } = await import("../src/server-runtime.mjs");

test("actual runtime request handler works over HTTPS, while HTTP remains loopback", async (t) => {
  assert.equal(runtime.HOST, "127.0.0.1");
  const config = resolveLocalRunnerTlsConfig({ RUNNER_LOCAL_HOSTNAME: "test-mac", RUNNER_LOCAL_TLS_DIR: path.join(root, "tls") });
  const credentials = loadLocalRunnerTls(config);
  const server = https.createServer(credentials, runtime.handleRunnerRequest);
  const ca = new X509Certificate(Buffer.from(credentials.localRunnerCertificate, "base64")).toString();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  assert.equal(runtime.server.listeners("request")[0], runtime.handleRunnerRequest);
  const request = (token) => new Promise((resolve, reject) => {
    https.get({ hostname: "127.0.0.1", port: server.address().port, servername: config.hostname,
      path: "/health", ca, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let body = "";
      res.on("data", (data) => body += data);
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    }).on("error", reject);
  });
  assert.equal((await request("wrong-token")).status, 401);
  const valid = await request("test-token");
  assert.equal(valid.status, 200);
  assert.equal(valid.json.ok, true);
});

test("actual media origin uses TLS socket before forwarded headers", () => {
  const host = "test-mac.local:8789";
  assert.equal(runtime.resolvePublicBaseUrl({ headers: { host }, socket: { encrypted: true } }), `https://${host}`);
  assert.equal(runtime.resolvePublicBaseUrl({ headers: { host, "x-forwarded-proto": "http", "x-forwarded-host": "untrusted" },
    socket: { encrypted: true } }), `https://${host}`);
  assert.equal(runtime.resolvePublicBaseUrl({ headers: { host: "127.0.0.1:8788", "x-forwarded-proto": "https",
    "x-forwarded-host": "app.example.test" }, socket: {} }), "https://app.example.test");
});
