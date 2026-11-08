import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID, createHash, createCipheriv } from "node:crypto";
import * as OTPAuth from "otpauth";
import { WebSocket, WebSocketServer } from "ws";
import { createRunnerLoginService } from "../src/runner-login-service.mjs";
import { createRunnerLoginStore } from "../src/runner-login-store.mjs";
import { createRunnerLoginHttp, RUNNER_AUTHENTICATION } from "../src/runner-login-http.mjs";
import { installRunnerWebSocketUpgradeHandler } from "../src/runner-websocket-upgrade.mjs";
import { createRunnerLoginMailer } from "../src/runner-login-mail.mjs";
import { createApnsClient } from "../src/apns-client.mjs";
import { startRunnerControlListener } from "../src/runner-control-listener.mjs";
import { createLlmAcpSessionStore } from "../src/llm-acp-session-store.mjs";

const codeFor = (secret, timestamp) => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate({ timestamp });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-login-"));
  const directory = path.join(root, "auth");
  let time = Date.parse("2026-11-08T00:00:00Z"), deliveryFailure = false;
  const messages = [], key = randomBytes(32);
  const params = { directory, legacyToken: "old-private-token", keyProvider: async () => key, now: () => time,
    sendMail: async (message) => { if (options.beforeSend) await options.beforeSend(message); if (deliveryFailure) throw new Error("mock delivery failure"); messages.push(message); }, ...options };
  let service = createRunnerLoginService(params); await service.initialize();
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const binding = randomBytes(32).toString("base64url");
  const start = async (purpose = "login", input = {}, context) => {
    const fn = { login: "startLogin", setup: "startSetup", recovery: "startRecovery", reauth: "startReauthentication" }[purpose];
    const result = await service[fn]({ email: "owner@example.test", clientBinding: binding, ...input }, context);
    await settle();
    return { ...result, clientBinding: binding, emailCode: messages.findLast((message) => message.id === result.challengeId)?.text.match(/\d{8}/)?.[0] || "00000000" };
  };
  const setup = async () => {
    const challenge = await start("setup"), prepared = await service.prepareSetup(challenge);
    const result = await service.completeSetup({ setupId: prepared.setupId, clientBinding: binding, totpCode: codeFor(prepared.secret, time) });
    time += 61000;
    return { secret: prepared.secret, recoveryCodes: result.recoveryCodes };
  };
  const login = async (secret, input = {}) => {
    const challenge = await start("login");
    return service.completeLogin({ ...challenge, totpCode: codeFor(secret, time), deviceName: "Test Mac", os: "macOS", ...input });
  };
  return { root, directory, messages, binding, start, setup, login, get service() { return service; }, get time() { return time; }, key,
    setTime(value) { time = value; },
    advance(ms) { time += ms; }, failMail(value) { deliveryFailure = value; },
    async restart(overrides = {}) { await service.close(); Object.assign(params, overrides); service = createRunnerLoginService(params); await service.initialize(); },
  };
}

test("local owner ceremony, opaque device session, encrypted secrets and fixed ACL subject survive restart", async (t) => {
  const f = await fixture(t), owner = await f.setup(), session = await f.login(owner.secret);
  assert.match(session.token, /^bitty_session_v1\.[A-Za-z0-9_-]{43}$/);
  const context = await f.service.authenticate(session.token);
  assert.equal(context.ownerSubjectId, "runner:" + createHash("sha256").update("old-private-token").digest("hex"));
  const raw = await fs.readFile(path.join(f.directory, "state.json"), "utf8");
  for (const secret of [owner.secret, session.token, ...owner.recoveryCodes]) assert.ok(!raw.includes(secret));
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(f.directory, "state.json"))).mode & 0o777, 0o600);
  await f.restart();
  assert.equal((await f.service.authenticate(session.token)).ownerSubjectId, context.ownerSubjectId);
  assert.equal(f.service.listDevices(context).devices[0].current, true);
});

test("shared token is rejected on network regardless of spoofed metadata; UDS authority is explicit", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.authenticate("old-private-token"), { code: "authentication_required" });
  assert.equal((await f.service.authenticate("old-private-token", { local: true })).local, true);
  await assert.rejects(f.service.authenticate("", { local: true }), { code: "authentication_required" });
});

test("email code, binding, purpose, single use and TOTP replay are all required", async (t) => {
  const f = await fixture(t), owner = await f.setup(), challenge = await f.start();
  await assert.rejects(f.service.completeLogin({ ...challenge, clientBinding: randomBytes(32).toString("base64url"), totpCode: codeFor(owner.secret, f.time) }), { code: "invalid_authentication" });
  await assert.rejects(f.service.completeLogin({ ...challenge, emailCode: "0000000x", totpCode: codeFor(owner.secret, f.time) }), { code: "invalid_authentication" });
  const session = await f.service.completeLogin({ ...challenge, totpCode: codeFor(owner.secret, f.time) });
  await assert.rejects(f.service.completeLogin({ ...challenge, totpCode: codeFor(owner.secret, f.time) }), { code: "invalid_authentication" });
  f.advance(61000);
  const again = await f.start();
  await assert.rejects(f.service.completeReauthentication(again, await f.service.authenticate(session.token)), { code: "invalid_authentication" });
});

test("challenge attempts and owner-wide cross-flow budget survive restart", async (t) => {
  const f = await fixture(t), owner = await f.setup(), challenge = await f.start();
  for (let i = 0; i < 5; i++) await assert.rejects(f.service.completeLogin({ ...challenge, emailCode: "bad", totpCode: "000000" }));
  await f.restart();
  await assert.rejects(f.service.completeLogin({ ...challenge, totpCode: codeFor(owner.secret, f.time) }), { code: "invalid_authentication" });
  let last;
  for (let i = 0; i < 20; i++) { try { await f.service.completeRecovery({ recoveryId: "missing", clientBinding: f.binding, totpCode: "000000" }); } catch (error) { last = error; } }
  assert.equal(last.code, "authentication_rate_limited");
});

test("mail failure never authorizes, unknown email has same response, all delivery goes to owner", async (t) => {
  const f = await fixture(t), owner = await f.setup();
  f.failMail(true);
  const challenge = await f.start();
  await assert.rejects(f.service.completeLogin({ ...challenge, totpCode: codeFor(owner.secret, f.time) }), { code: "invalid_authentication" });
  f.failMail(false); f.advance(61000);
  const unknown = await f.start("login", { email: "stranger@example.test" });
  assert.deepEqual(Object.keys(unknown), Object.keys(challenge));
  assert.ok(f.messages.every((message) => message.to === "owner@example.test"));
});

test("notification failure preserves login, is retried durably and never leaks tokens", async (t) => {
  const f = await fixture(t), owner = await f.setup(), challenge = await f.start();
  f.failMail(true);
  const session = await f.service.completeLogin({ ...challenge, totpCode: codeFor(owner.secret, f.time) });
  await f.service.flushOutbox();
  const context = await f.service.authenticate(session.token);
  assert.equal(f.service.listDevices(context).devices[0].notificationStatus, "pending");
  await f.restart(); f.failMail(false); f.advance(130000); await f.service.flushOutbox();
  assert.equal(f.service.listDevices(context).devices[0].notificationStatus, "sent");
  const notices = f.messages.filter((message) => message.subject.includes("新しい端末"));
  assert.equal(notices.length, 1); assert.ok(!notices[0].text.includes(session.token));
});

test("idle/absolute expiry applies to sessions; polling does not extend absolute lifetime", async (t) => {
  const f = await fixture(t), owner = await f.setup(), session = await f.login(owner.secret);
  for (let day = 0; day < 29; day++) { f.advance(86400000); await f.service.authenticate(session.token); }
  f.advance(86400000);
  await assert.rejects(f.service.authenticate(session.token), { code: "authentication_required" });
  f.advance(61000); const next = await f.login(owner.secret); f.advance(7 * 86400000);
  await assert.rejects(f.service.authenticate(next.token), { code: "authentication_required" });
});

test("device revocation closes socket and suppresses new incoming and outgoing messages", async (t) => {
  const f = await fixture(t), owner = await f.setup(), session = await f.login(owner.secret), context = await f.service.authenticate(session.token);
  const ws = new EventEmitter(); let closed = 0, sent = 0, received = 0;
  ws.close = () => { closed++; }; ws.send = () => { sent++; };
  f.service.attachSocket(ws, context); ws.on("message", () => { received++; });
  ws.emit("message", "before"); ws.send("before");
  await f.service.revoke(context, context.sessionId);
  ws.emit("message", "after"); ws.send("after");
  assert.equal(received, 1); assert.equal(sent, 1); assert.ok(closed >= 1);
  await assert.rejects(f.service.authenticate(session.token), { code: "authentication_required" });
});

test("other-device revocation requires fresh reauthentication after five minutes", async (t) => {
  const f = await fixture(t), owner = await f.setup(), first = await f.login(owner.secret); f.advance(61000);
  const second = await f.login(owner.secret), context = await f.service.authenticate(first.token);
  f.advance(6 * 60000);
  await assert.rejects(f.service.revoke(context, second.sessionId), { code: "reauthentication_required" });
  const challenge = await f.start("reauth", {}, context);
  await f.service.completeReauthentication({ ...challenge, totpCode: codeFor(owner.secret, f.time) }, context);
  await f.service.revoke(context, second.sessionId);
  assert.equal(f.service.isSessionActive(second.sessionId), false);
});

test("recovery changes generation, rejects concurrent pending recovery and invalidates every session", async (t) => {
  const f = await fixture(t), owner = await f.setup(), session = await f.login(owner.secret); f.advance(61000);
  const challenge = await f.start("recovery");
  const prepared = await f.service.prepareRecovery({ ...challenge, recoveryCode: owner.recoveryCodes[0] });
  f.advance(61000); const pendingLogin = await f.start();
  const result = await f.service.completeRecovery({ recoveryId: prepared.recoveryId, clientBinding: f.binding, totpCode: codeFor(prepared.secret, f.time) });
  assert.equal(result.recoveryCodes.length, 8);
  assert.equal(f.service.isSessionActive(session.sessionId), false);
  await assert.rejects(f.service.completeRecovery({ recoveryId: prepared.recoveryId, clientBinding: f.binding, totpCode: codeFor(prepared.secret, f.time) }));
  await assert.rejects(f.service.completeLogin({ ...pendingLogin, totpCode: codeFor(owner.secret, f.time) }));
});

test("setup preserves the current owner and leaves historical workspace grants isolated and untouched", async (t) => {
  const current = "runner:" + createHash("sha256").update("old-private-token").digest("hex");
  const other = "runner:" + createHash("sha256").update("historical-token").digest("hex");
  // The removed runtime-wide scan used to reject this unrelated historical grant.
  const f = await fixture(t, { inspectOwners: async () => [current, other] });
  const file = path.join(f.root, "acp_sessions.json");
  const grants = [current, other].map((subjectId, index) => ({ subjectId, canonicalRoot: path.join(f.root, `project-${index}`),
    identity: `project-${index}`, approvedAt: new Date(f.time).toISOString(), revokedAt: "" }));
  await fs.writeFile(file, JSON.stringify({ version: 5, sessions: {}, agentWorkspaces: grants }));
  const before = await fs.readFile(file, "utf8");
  const store = createLlmAcpSessionStore({ acpSessionStorePath: file, workspaceRoot: f.root,
    normalizeSessionUpdatedAt: (value) => value || "", normalizeSessionRootRelativePath: (value) => value,
    normalizeLlmExecutionSessionId: (value) => value });
  const owner = await f.setup(), session = await f.login(owner.secret), context = await f.service.authenticate(session.token);
  assert.equal(context.ownerSubjectId, current);
  assert.deepEqual((await store.listAgentWorkspaces(context.ownerSubjectId)).map((entry) => entry.canonicalRoot), [grants[0].canonicalRoot]);
  assert.deepEqual((await store.listAgentWorkspaces(other)).map((entry) => entry.canonicalRoot), [grants[1].canonicalRoot]);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("first setup refuses a changed local identity before mail and rejects an older pending ceremony", async (t) => {
  const f = await fixture(t), current = f.service.ownerSubjectId;
  const challenge = await f.start("setup"), prepared = await f.service.prepareSetup(challenge);
  await f.restart({ legacyToken: "replacement-token" });
  const sent = f.messages.length;
  await assert.rejects(f.start("setup"), { code: "owner_migration_required" });
  assert.equal(f.messages.length, sent);
  await assert.rejects(f.service.prepareSetup(challenge), { code: "owner_migration_required" });
  await assert.rejects(f.service.completeSetup({ setupId: prepared.setupId, clientBinding: f.binding, totpCode: codeFor(prepared.secret, f.time) }), { code: "owner_migration_required" });
  assert.equal(f.service.registered, false);
  assert.equal(f.service.ownerSubjectId, current);
});

test("reset keeps an established owner across local credential rotation and allows re-registration", async (t) => {
  const f = await fixture(t), current = f.service.ownerSubjectId;
  await f.setup();
  await f.restart({ legacyToken: "replacement-token" });
  await f.service.resetOwner();
  await f.setup();
  assert.equal(f.service.registered, true);
  assert.equal(f.service.ownerSubjectId, current);
});

test("corrupt storage, wrong permissions and simultaneous writer fail closed", async (t) => {
  const f = await fixture(t), other = createRunnerLoginStore(f.directory);
  await assert.rejects(other.initialize({}), /runner_login_writer_locked/);
  await f.service.close();
  await fs.writeFile(path.join(f.directory, "state.json"), "not json", { mode: 0o600 });
  await assert.rejects(f.restart());
});

test("ambiguous storage failure latches authentication unavailable and never restores legacy access", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-failed-login-"));
  const real = createRunnerLoginStore(path.join(root, "auth"));
  const store = { initialize: (...args) => real.initialize(...args), get state() { return real.state; }, get directory() { return real.directory; },
    transaction: async () => { throw new Error("simulated fsync failure"); }, close: () => real.close() };
  const service = createRunnerLoginService({ directory: root, store, legacyToken: "old", keyProvider: async () => randomBytes(32), sendMail: async () => {} });
  await service.initialize(); t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  await assert.rejects(service.startSetup({ email: "owner@example.test", clientBinding: randomBytes(32).toString("base64url") }), { code: "authentication_unavailable" });
  await assert.rejects(service.authenticate("old", { local: true }), { code: "authentication_unavailable" });
});

test("HTTP default-deny covers all methods, unknown paths, media, spoofed loopback/CF headers and public setup", async (t) => {
  const f = await fixture(t), adapter = createRunnerLoginHttp({ service: f.service });
  let called = 0;
  const server = http.createServer(adapter.wrap((req, res) => { called++; res.end("private"); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ["/workspace/files", "/files/media", "/tts-media/test", "/auth/setup/start", "/agent/sessions", "/unknown"]) {
    const response = await fetch(base + route, { method: "POST", headers: { authorization: "Bearer old-private-token", "cf-connecting-ip": "127.0.0.1", "cf-access-jwt-assertion": "fake" } });
    assert.equal(response.status, 401, route);
  }
  assert.equal(called, 0);
  assert.deepEqual(await (await fetch(base + "/health")).json(), { ok: true });
  const owner = await f.setup(), session = await f.login(owner.secret);
  assert.equal((await fetch(base + "/unknown", { headers: { authorization: `Bearer ${session.token}` } })).status, 200);
});

test("real WebSocket handshakes share gate with HTTP; no query-token fallback", async (t) => {
  const f = await fixture(t), owner = await f.setup(), session = await f.login(owner.secret), adapter = createRunnerLoginHttp({ service: f.service });
  const wss = new WebSocketServer({ noServer: true }), server = http.createServer();
  installRunnerWebSocketUpgradeHandler({ server, runnerWsPath: "/runner-ws", runnerWsServer: wss, streamTtsWsServer: wss, streamSttWsServer: wss,
    authenticate: (req) => adapter.authenticate(req), attachSocket: (ws, context) => f.service.attachSocket(ws, context), appendDebug: async () => {} });
  wss.on("connection", (ws) => { ws.on("message", (value) => ws.send(value)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { wss.close(); server.close(); });
  const base = `ws://127.0.0.1:${server.address().port}/runner-ws`;
  await new Promise((resolve) => { const ws = new WebSocket(base + `?token=${session.token}`); ws.on("error", () => resolve()); });
  const ws = new WebSocket(base, { headers: { authorization: `Bearer ${session.token}` } });
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  const closed = new Promise((resolve) => ws.on("close", resolve));
  await f.service.revoke(await f.service.authenticate(session.token), session.sessionId);
  await closed;
});

test("APNs common send boundary suppresses revoked/unbound registrations before reading signing key", async () => {
  let keyReads = 0;
  const client = createApnsClient({ keyPath: "/fake/key", keyId: "fake", teamId: "fake" }, {
    canDeliver: async (_token, sessionId) => sessionId === "valid", readKeyFile: () => { keyReads++; throw new Error("should not read"); },
  });
  assert.equal((await client.sendToDevice("token", {}, { authSessionId: "revoked" })).status, 403);
  assert.equal((await client.sendToDevice("token", {}, {})).status, 403);
  assert.equal(keyReads, 0);
});

test("Mailjet status errors and timeouts reject without exposing response secrets", async () => {
  const mail = createRunnerLoginMailer({ env: { MJ_APIKEY_PUBLIC: "key", MJ_APIKEY_PRIVATE: "secret", RUNNER_LOGIN_MAIL_FROM: "sender@example.test" },
    fetchImpl: async (_url, init) => { assert.equal(init.redirect, "error"); return { ok: true, json: async () => ({ Messages: [{ Status: "error", Errors: ["sensitive detail"] }] }) }; } });
  await assert.rejects(mail({ to: "owner@example.test", subject: "test", text: "body", id: "test" }), /runner_login_mail_unavailable/);
});

test("UDS listener enforces private owner directory, path length and no existing file overwrite", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-uds-"));
  await fs.chmod(root, 0o700); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(startRunnerControlListener({ directory: root, socketPath: path.join(root, "x".repeat(110)) }), /path_invalid/);
  const socket = path.join(root, "control.sock"); await fs.writeFile(socket, "preserve");
  await assert.rejects(startRunnerControlListener({ directory: root, socketPath: socket }), /socket_exists/);
  assert.equal(await fs.readFile(socket, "utf8"), "preserve");
});

test("APNs revocation during asynchronous registration lookup is rechecked at final synchronous admission", async () => {
  let allow, active = true, keyReads = 0;
  const registration = new Promise((resolve) => { allow = resolve; });
  const client = createApnsClient({ keyPath: "/fake/key", keyId: "fake", teamId: "fake" }, {
    canDeliver: () => registration, isSessionActive: () => active,
    readKeyFile: () => { keyReads++; throw new Error("should not read"); },
  });
  const result = client.sendToDevice("token", {}, { authSessionId: "session" });
  active = false; allow(true);
  assert.equal((await result).status, 403); assert.equal(keyReads, 0);
});

test("resending the same purpose/binding replaces its previous challenge and code", async (t) => {
  const f = await fixture(t), owner = await f.setup(), first = await f.start();
  f.advance(61000); const second = await f.start();
  await assert.rejects(f.service.completeLogin({ ...first, totpCode: codeFor(owner.secret, f.time) }), { code: "invalid_authentication" });
  assert.ok((await f.service.completeLogin({ ...second, totpCode: codeFor(owner.secret, f.time) })).token);
});

test("valid JSON with a negative rate budget is rejected without resetting owner state", async (t) => {
  const f = await fixture(t); await f.setup(); await f.service.close();
  const filename = path.join(f.directory, "state.json"), state = JSON.parse(await fs.readFile(filename, "utf8"));
  state.budget.attempts = -1; await fs.writeFile(filename, JSON.stringify(state));
  await assert.rejects(f.restart(), /runner_login_store_invalid/);
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).budget.attempts, -1);
});

test("exhausted recovery OTP attempts do not corrupt state or invalidate unrelated active sessions", async (t) => {
  const f = await fixture(t), owner = await f.setup(), session = await f.login(owner.secret); f.advance(61000);
  const challenge = await f.start("recovery"), prepared = await f.service.prepareRecovery({ ...challenge, recoveryCode: owner.recoveryCodes[0] });
  const valid = codeFor(prepared.secret, f.time), wrong = valid === "000000" ? "000001" : "000000";
  for (let attempt = 0; attempt < 8; attempt++) await assert.rejects(f.service.completeRecovery({ recoveryId: prepared.recoveryId, clientBinding: f.binding, totpCode: wrong }), { code: "invalid_authentication" });
  assert.equal((await f.service.authenticate(session.token)).sessionId, session.sessionId);
});

test("shutdown releases the writer while mail is pending and late delivery cannot write into a new process", async (t) => {
  let release, entered;
  const mailEntered = new Promise((resolve) => { entered = resolve; });
  const pendingMail = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { beforeSend: async (message) => { if (message.subject.includes("新しい端末")) { entered(); await pendingMail; } } });
  const owner = await f.setup(); await f.login(owner.secret); await mailEntered;
  await f.restart();
  const before = await fs.readFile(path.join(f.directory, "state.json"), "utf8");
  release(); await settle();
  assert.equal(await fs.readFile(path.join(f.directory, "state.json"), "utf8"), before);
});

test("RFC 6238 fixed SHA1 vector passes the real six-digit login verifier", async (t) => {
  const f = await fixture(t); await f.setup(); await f.service.close();
  const file = path.join(f.directory, "state.json"), state = JSON.parse(await fs.readFile(file, "utf8"));
  // RFC 6238 Appendix B at time 1111111109: 8-digit 07081804, six-digit truncation 081804.
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const iv = Buffer.alloc(12, 7), cipher = createCipheriv("aes-256-gcm", f.key, iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  state.owner.secret = { iv: iv.toString("base64"), data: data.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  state.owner.lastTotpStep = 0; state.budget = { windowAt: 0, sentAt: 0, sends: 0, attempts: 0 };
  f.setTime(1111111109000); await fs.writeFile(file, JSON.stringify(state)); await f.restart();
  const challenge = await f.start();
  assert.ok((await f.service.completeLogin({ ...challenge, totpCode: "081804" })).token);
});

test("UDS owner bootstrap and app-shaped HTTP login/reauth/device APIs integrate with WS revocation", async (t) => {
  const f = await fixture(t), adapter = createRunnerLoginHttp({ service: f.service });
  const local = await startRunnerControlListener({ directory: f.root, socketPath: path.join(await fs.realpath(f.root), "ctl.sock"),
    handler: adapter.wrap(() => {}, { local: true }), installWebSocket: () => {} });
  const server = http.createServer(adapter.wrap((_req, res) => res.end("private")));
  const wss = new WebSocketServer({ noServer: true });
  installRunnerWebSocketUpgradeHandler({ server, runnerWsPath: "/runner-ws", runnerWsServer: wss, streamTtsWsServer: wss, streamSttWsServer: wss,
    authenticate: (req) => adapter.authenticate(req), attachSocket: (ws, context) => f.service.attachSocket(ws, context), appendDebug: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const uds = (route, value) => new Promise((resolve, reject) => {
      const data = JSON.stringify(value), req = http.request({ socketPath: local.socketPath, path: route, method: "POST", headers: {
        authorization: "Bearer old-private-token", "content-type": "application/json", "content-length": Buffer.byteLength(data),
      } }, (res) => { let raw = ""; res.on("data", (chunk) => { raw += chunk; }); res.on("end", () => { assert.equal(res.statusCode, 200); resolve(JSON.parse(raw)); }); });
      req.on("error", reject); req.end(data);
    });
    const setup = await uds("/auth/setup/start", { email: "owner@example.test", clientBinding: f.binding });
    const prepared = await uds("/auth/setup/prepare", { ...setup, clientBinding: f.binding, emailCode: f.messages.find((m) => m.id === setup.challengeId).text.match(/\d{8}/)[0] });
    await uds("/auth/setup/complete", { setupId: prepared.setupId, clientBinding: f.binding, totpCode: codeFor(prepared.secret, f.time) });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (route, value, token, method = "POST") => {
      const response = await fetch(base + route, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      return { status: response.status, value: await response.json() };
    };
    const start = async (purpose, token) => {
      const response = await request(`/auth/${purpose}/start`, { email: "owner@example.test", clientBinding: f.binding }, token);
      assert.equal(response.status, 200); await settle();
      return { ...response.value, clientBinding: f.binding, emailCode: f.messages.find((m) => m.id === response.value.challengeId).text.match(/\d{8}/)[0], totpCode: codeFor(prepared.secret, f.time) };
    };
    f.advance(61000);
    const first = await request("/auth/login/complete", { ...await start("login"), deviceName: "Mac", os: "macOS" });
    assert.equal(first.status, 200); const token = first.value.token;
    assert.equal((await request("/auth/session", undefined, token, "GET")).value.sessionId, first.value.sessionId);
    assert.equal((await request("/auth/devices", undefined, token, "GET")).value.devices[0].current, true);
    f.advance(61000);
    const second = await request("/auth/login/complete", await start("login"));
    const ws = new WebSocket(base.replace("http:", "ws:") + "/runner-ws", { headers: { authorization: `Bearer ${second.value.token}` } });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    f.advance(6 * 60000);
    assert.equal((await request(`/auth/devices/${second.value.sessionId}`, undefined, token, "DELETE")).status, 403);
    assert.equal((await request("/auth/reauth/complete", await start("reauth", token), token)).status, 200);
    const closed = new Promise((resolve) => ws.once("close", resolve));
    assert.equal((await request(`/auth/devices/${second.value.sessionId}`, undefined, token, "DELETE")).status, 200);
    await closed;
    assert.equal((await request("/auth/session", undefined, second.value.token, "GET")).status, 401);
  } finally {
    for (const client of wss.clients) client.terminate(); wss.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await local.close();
  }
});

test("control listener closes an open local WebSocket and removes only its own socket", async (t) => {
  const root = await fs.mkdtemp("/tmp/bitty-local-ws-"); await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const wss = new WebSocketServer({ noServer: true });
  const listener = await startRunnerControlListener({ directory: root, socketPath: path.join(root, "ctl.sock"), handler: (_req, res) => res.end(),
    installWebSocket: (server) => installRunnerWebSocketUpgradeHandler({ server, runnerWsPath: "/runner-ws", runnerWsServer: wss,
      streamTtsWsServer: wss, streamSttWsServer: wss, authenticate: async () => ({ local: true }), appendDebug: () => {} }) });
  const ws = new WebSocket(`ws+unix://${listener.socketPath}:/runner-ws`);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const closed = new Promise((resolve) => ws.once("close", resolve));
  await listener.close(); await closed; wss.close();
  await assert.rejects(fs.lstat(listener.socketPath), { code: "ENOENT" });
});

test("legal login compacts full inactive/session notification history without disrupting existing sessions", async (t) => {
  const f = await fixture(t), owner = await f.setup(), existing = await f.login(owner.secret); await f.service.flushOutbox(); await f.service.close();
  const file = path.join(f.directory, "state.json"), state = JSON.parse(await fs.readFile(file, "utf8"));
  const live = state.sessions[0], notice = state.outbox[0];
  state.sessions = Array.from({ length: 249 }, () => ({ ...live, id: randomUUID(), tokenHash: randomBytes(32).toString("hex"), revokedAt: f.time }));
  state.sessions.push(live);
  state.outbox = Array.from({ length: 300 }, () => ({ ...notice, id: randomUUID(), status: "sent" }));
  await fs.writeFile(file, JSON.stringify(state)); f.advance(61000); await f.restart();
  const created = await f.login(owner.secret);
  assert.ok(created.token); assert.equal((await f.service.authenticate(existing.token)).sessionId, existing.sessionId);
  const after = JSON.parse(await fs.readFile(file, "utf8"));
  assert.ok(after.sessions.length <= 250); assert.ok(after.outbox.length <= 300);
});

test("UDS local credential parser accepts RFC 6750 base64 characters without enabling network fallback", async (t) => {
  const token = "private+/~credential==", f = await fixture(t, { legacyToken: token });
  const adapter = createRunnerLoginHttp({ service: f.service });
  const request = { headers: { authorization: `Bearer ${token}` } };
  assert.equal((await adapter.authenticate(request, true)).local, true);
  await assert.rejects(adapter.authenticate({ headers: { authorization: `Bearer ${token}` } }), { code: "authentication_required" });
});
