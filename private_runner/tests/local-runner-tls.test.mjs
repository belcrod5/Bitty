import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { loadLocalRunnerTls, resolveLocalRunnerTlsConfig } from "../src/local-runner-tls.mjs";
import { installRunnerWebSocketUpgradeHandler } from "../src/runner-websocket-upgrade.mjs";

function configuration(t, overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "bitty-tls-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return resolveLocalRunnerTlsConfig({
    RUNNER_LOCAL_HOSTNAME: "test-mac",
    RUNNER_LOCAL_TLS_DIR: path.join(root, "credentials"),
    ...overrides,
  });
}

test("local URL contract uses a separate HTTPS port and migrates only old HTTP hostname", () => {
  assert.equal(resolveLocalRunnerTlsConfig({ RUNNER_LOCAL_HOSTNAME: "test-mac" }).url,
    "https://test-mac.local:8789");
  assert.equal(resolveLocalRunnerTlsConfig({ RUNNER_LOCAL_URL: "http://192.168.1.5:8788" }).url,
    "https://192.168.1.5:8789");
  assert.equal(resolveLocalRunnerTlsConfig({ RUNNER_LOCAL_URL: "https://test-mac.local:9443" }).port, 9443);
  assert.equal(resolveLocalRunnerTlsConfig({ RUNNER_LOCAL_HOSTNAME: "test-mac.local", PORT: "9000" }).port, 9001);
  assert.equal(resolveLocalRunnerTlsConfig({ RUNNER_LOCAL_HOSTNAME: "test-mac", RUNNER_PORT: "9000", PORT: "9001" }).port, 9002);
  for (const url of ["https://host.local/path", "https://user@host.local", "https://host.local?token=x",
    "https://host.local#fragment", "ftp://host.local", "https://host.local:8788", "https://evil;command.local",
    "https://host\n.local"]) {
    assert.throws(() => resolveLocalRunnerTlsConfig({ RUNNER_LOCAL_URL: url }));
  }
  for (const hostname of ["bad/name", "bad name", "bad:8443", "bad\nname", "-bad"]) {
    assert.throws(() => resolveLocalRunnerTlsConfig({ RUNNER_LOCAL_HOSTNAME: hostname }));
  }
  assert.throws(() => resolveLocalRunnerTlsConfig({ RUNNER_LOCAL_HOSTNAME: "mac", RUNNER_LOCAL_PORT: "65536" }));
  assert.throws(() => resolveLocalRunnerTlsConfig({ RUNNER_LOCAL_URL: "https://mac.local:9000", RUNNER_LOCAL_PORT: "9443" }));
});

test("CA and ECDSA leaf persist with private permissions and a public-only pairing anchor", (t) => {
  const config = configuration(t);
  const first = loadLocalRunnerTls(config);
  const second = loadLocalRunnerTls(config);
  assert.deepEqual(second, first);
  const root = new X509Certificate(Buffer.from(first.localRunnerCertificate, "base64"));
  const leaf = new X509Certificate(first.cert);
  assert.equal(root.ca, true);
  assert.equal(leaf.ca, false);
  assert.equal(leaf.publicKey.asymmetricKeyType, "ec");
  assert.equal(leaf.checkHost(config.hostname), config.hostname);
  assert.equal(leaf.verify(root.publicKey), true);
  assert.equal(first.minVersion, "TLSv1.2");
  assert.equal(statSync(config.directory).mode & 0o777, 0o700);
  for (const file of ["authority.json", "server.json"]) {
    assert.equal(statSync(path.join(config.directory, file)).mode & 0o777, 0o600);
  }
});

test("leaf is renewed for hostname changes while QR trust remains stable", (t) => {
  const config = configuration(t);
  const first = loadLocalRunnerTls(config);
  const second = loadLocalRunnerTls({ ...config, hostname: "new-mac.local" });
  assert.equal(second.localRunnerCertificate, first.localRunnerCertificate);
  assert.notEqual(second.cert, first.cert);
  assert.equal(new X509Certificate(second.cert).checkHost("new-mac.local"), "new-mac.local");
});

test("leaf nearing expiration is renewed without changing CA", (t) => {
  const config = configuration(t);
  const first = loadLocalRunnerTls(config);
  const authority = JSON.parse(readFileSync(path.join(config.directory, "authority.json"), "utf8"));
  const leaf = JSON.parse(readFileSync(path.join(config.directory, "server.json"), "utf8"));
  const caCert = path.join(config.directory, "ca.pem");
  const caKey = path.join(config.directory, "ca-key.pem");
  const leafKey = path.join(config.directory, "leaf-key.pem");
  const request = path.join(config.directory, "request.pem");
  const extensions = path.join(config.directory, "extensions.cnf");
  for (const [file, content] of [[caCert, authority.cert], [caKey, authority.key], [leafKey, leaf.key],
    [extensions, "[server]\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:test-mac.local"]]) {
    writeFileSync(file, content, { mode: 0o600 });
  }
  const run = (args) => {
    const result = spawnSync("openssl", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  run(["req", "-new", "-key", leafKey, "-out", request, "-subj", "/CN=test-mac.local"]);
  leaf.cert = run(["x509", "-req", "-in", request, "-CA", caCert, "-CAkey", caKey,
    "-set_serial", "42", "-days", "1", "-extfile", extensions, "-extensions", "server"]);
  writeFileSync(path.join(config.directory, "server.json"), JSON.stringify(leaf), { mode: 0o600 });
  const renewed = loadLocalRunnerTls(config);
  assert.notEqual(renewed.cert, leaf.cert);
  assert.equal(renewed.localRunnerCertificate, first.localRunnerCertificate);
  assert.ok(Date.parse(new X509Certificate(renewed.cert).validTo) > Date.now() + 300 * 86400000);
});

test("missing, corrupt, unrelated, or symlinked credentials fail closed", (t) => {
  const config = configuration(t);
  loadLocalRunnerTls(config);
  const authorityFile = path.join(config.directory, "authority.json");
  const authority = readFileSync(authorityFile);
  unlinkSync(authorityFile);
  assert.throws(() => loadLocalRunnerTls(config), /CA is missing/);
  writeFileSync(authorityFile, "invalid", { mode: 0o600 });
  assert.throws(() => loadLocalRunnerTls(config));
  writeFileSync(authorityFile, authority, { mode: 0o600 });
  const unrelated = loadLocalRunnerTls(configuration(t));
  writeFileSync(path.join(config.directory, "server.json"), JSON.stringify({ key: unrelated.key, cert: unrelated.cert }), { mode: 0o600 });
  assert.throws(() => loadLocalRunnerTls(config), /not issued/);
  const link = path.join(path.dirname(config.directory), "linked");
  symlinkSync(config.directory, link);
  assert.throws(() => loadLocalRunnerTls({ ...config, directory: link }), /not a symlink/);
  unlinkSync(authorityFile);
  symlinkSync(path.join(config.directory, "server.json"), authorityFile);
  assert.throws(() => loadLocalRunnerTls(config), /private regular files/);
});

test("paired CA authenticates HTTPS and all WebSocket routes; impostor certificate receives no bearer", async (t) => {
  const config = configuration(t);
  const credentials = loadLocalRunnerTls(config);
  const ca = new X509Certificate(Buffer.from(credentials.localRunnerCertificate, "base64")).toString();
  let requests = 0;
  const server = https.createServer(credentials, (req, res) => {
    requests += 1;
    assert.equal(req.headers.authorization, "Bearer test-token");
    res.end("secure");
  });
  const wsServers = [0, 1, 2].map(() => new WebSocketServer({ noServer: true }));
  for (const ws of wsServers) ws.on("connection", (socket) => socket.send("secure"));
  installRunnerWebSocketUpgradeHandler({
    server, runnerToken: "test-token", runnerWsPath: "/runner-ws", runnerWsServer: wsServers[0],
    streamTtsWsServer: wsServers[1], streamSttWsServer: wsServers[2], appendDebug: () => {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const ws of wsServers) { for (const client of ws.clients) client.terminate(); ws.close(); }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const options = { hostname: "127.0.0.1", port, servername: config.hostname, ca,
    headers: { authorization: "Bearer test-token" } };
  const get = (opts) => new Promise((resolve, reject) => {
    https.get(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
  assert.equal(await get(options), "secure");
  for (const route of ["/runner-ws", "/stream-tts", "/stream-stt"]) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}${route}`, options);
      ws.on("error", reject);
      ws.on("message", (data) => { assert.equal(String(data), "secure"); ws.close(); });
      ws.on("close", resolve);
    });
  }
  assert.equal(requests, 1);
  await assert.rejects(get({ ...options, servername: "wrong-mac.local" }), /Hostname\/IP does not match/);
  const unrelated = loadLocalRunnerTls(configuration(t));
  const wrongCa = new X509Certificate(Buffer.from(unrelated.localRunnerCertificate, "base64")).toString();
  await assert.rejects(get({ ...options, ca: wrongCa }));
  assert.equal(requests, 1, "certificate failures must happen before HTTP bearer transmission");
});

test("real QR generator pairs HTTPS URL with public CA DER only and persists trust", (t) => {
  const config = configuration(t);
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const env = {
    PATH: process.env.PATH,
    RUNNER_PUBLIC_URL: "https://app.example.test", RUNNER_TOKEN: "fake-test-token",
    CLOUDFLARE_ACCESS_CLIENT_ID: "fake-id", CLOUDFLARE_ACCESS_CLIENT_SECRET: "fake-secret",
    RUNNER_LOCAL_HOSTNAME: "test-mac", RUNNER_LOCAL_TLS_DIR: config.directory,
  };
  const script = "import qrcode from 'qrcode-terminal'; qrcode.generate = (value) => process.stdout.write(value); await import('./src/print-runner-pairing-qr.mjs');";
  const run = () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = run();
  const second = run();
  assert.equal(first.localRunnerUrl, config.url);
  assert.equal(first.localRunnerCertificate, second.localRunnerCertificate);
  assert.equal(new X509Certificate(Buffer.from(first.localRunnerCertificate, "base64")).ca, true);
  assert.equal("key" in first, false);
  assert.equal(JSON.stringify(first).includes("PRIVATE KEY"), false);
});
