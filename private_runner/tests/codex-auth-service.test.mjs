import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createCodexAuthService } from "../src/codex-auth-service.mjs";
import { normalizeRegistrationCredential } from "../src/codex-auth-service.mjs";

const profile = (authId = "a", overrides = {}) => ({
  version: 1,
  authId,
  accountId: authId,
  clientId: "client",
  tokens: { access_token: "access", refresh_token: "refresh", id_token: "id", account_id: authId },
  ...overrides,
});

test("normalizes direct and default profile credentials without raw fields", () => {
  const direct = normalizeRegistrationCredential({ apiKey: "secret", tokens: { access_token: "access", refresh_token: "refresh", account_id: "acct" }, clientId: "client" });
  assert.deepEqual(direct, { tokens: { access_token: "access", refresh_token: "refresh", account_id: "acct" }, clientId: "client", tokenEndpoint: "https://auth.openai.com/oauth/token" });
  const nested = normalizeRegistrationCredential({ apiKey: "secret", profiles: { default: { tokens: { access_token: "access", refresh_token: "refresh", account_id: "acct" }, planType: "pro" } } });
  assert.equal(nested.planType, "pro");
  assert.equal(JSON.stringify(nested).includes("secret"), false);
});

test("normalizes JWT fallback and rejects invalid credentials safely", () => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const access = `x.${encode({ client_id: "jwt-client", "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account" } })}.x`;
  const result = normalizeRegistrationCredential({ tokens: { access_token: access, refresh_token: "refresh" } });
  assert.equal(result.tokens.account_id, "jwt-account");
  assert.equal(result.clientId, "jwt-client");
  for (const credential of [{ tokens: { access_token: "dummy", refresh_token: "" } }, { tokens: { access_token: "dummy", refresh_token: "dummy" } }]) {
    assert.throws(() => normalizeRegistrationCredential(credential), (error) => error.message === "credential unavailable" && !error.message.includes("dummy"));
  }
});

async function withService(fn, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-service-"));
  try { return await fn(root, createCodexAuthService({ rootDir: root, ...options })); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

function createFakeRegistrationProcess({ account = { email: "user@example.test" }, credential } = {}) {
  const calls = [];
  let listener;
  let exitResolve;
  const exit = new Promise((resolve) => { exitResolve = resolve; });
  let stopCount = 0;
  let cleanupCount = 0;
  return {
    calls,
    get stopCount() { return stopCount; },
    get cleanupCount() { return cleanupCount; },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "account/login/start") return { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://example.test/login", userCode: "CODE-1" };
      if (method === "account/read") return { account };
      return {};
    },
    notify: (method, params) => calls.push({ method, params }),
    onNotification: (next) => { listener = next; },
    emit: async (message) => { await listener?.(message); },
    stop: async () => { calls.push({ method: "stop" }); stopCount += 1; exitResolve(); },
    waitForExit: () => { calls.push({ method: "waitForExit" }); return exit; },
    exit: () => exitResolve(),
    cleanup: async () => { calls.push({ method: "cleanup" }); cleanupCount += 1; },
    readCredential: async () => { calls.push({ method: "readCredential" }); return credential || ({ tokens: { access_token: "dummy-access", refresh_token: "dummy-refresh", account_id: "a" } }); },
  };
}

test("shutdown cancels pending registrations and is idempotent", async () => {
  await withService(async (_root, service) => {
    let process;
    const registrationService = createCodexAuthService({
      rootDir: _root,
      registrationProcessFactory: async () => {
        process = createFakeRegistrationProcess();
        return process;
      },
    });
    await registrationService.startRegistration("shutdown-test");
    await Promise.all([registrationService.shutdown(), registrationService.shutdown()]);
    assert.equal(process.cleanupCount, 1);
    await assert.rejects(() => registrationService.startRegistration("after-shutdown"), /shutting down/);
  });
});

test("shutdown waits for a starting process and cleans it without making registration pending", async () => {
  await withService(async (root) => {
    let releaseFactory;
    const factoryGate = new Promise((resolve) => { releaseFactory = resolve; });
    const process = createFakeRegistrationProcess();
    const service = createCodexAuthService({
      rootDir: root,
      registrationProcessFactory: async () => {
        await factoryGate;
        return process;
      },
    });
    const starting = service.startRegistration("starting");
    await new Promise((resolve) => setImmediate(resolve));
    const stopping = service.shutdown();
    releaseFactory();

    await assert.rejects(starting, /registration unavailable/);
    await stopping;
    assert.equal(process.cleanupCount, 1);
    assert.equal(process.stopCount, 1);
    assert.equal(process.calls.some(({ method }) => method === "initialize" || method === "account/login/start"), false);
  });
});

test("shutdown stops a finalizing registration before deferred account/read can save", async () => {
  await withService(async (root) => {
    let process;
    let releaseRead;
    const readReady = new Promise((resolve) => { releaseRead = resolve; });
    const service = createCodexAuthService({ rootDir: root, registrationProcessFactory: async () => {
      process = createFakeRegistrationProcess();
      const request = process.request;
      process.request = async (method, params) => method === "account/read" ? readReady : request(method, params);
      return process;
    } });
    const { registrationId } = await service.startRegistration("deferred");
    void process.emit({ method: "account/login/completed", params: { success: true } });
    await new Promise((resolve) => setImmediate(resolve));
    const stopping = service.shutdown();
    releaseRead({ account: {} });
    await stopping;
    assert.equal(process.cleanupCount, 1);
    assert.equal((await service.registrationStatus(registrationId)).status, "cancelled");
    await assert.rejects(() => fs.access(path.join(root, "profiles", "deferred.json")), { code: "ENOENT" });
  });
});

function createFakeRateLimitProcess(response = { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1234 } } }) {
  const calls = [];
  return {
    calls,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "account/rateLimits/read") return response;
      if (method === "account/login/start") return { type: "chatgptAuthTokens" };
      return {};
    },
    notify: (method, params) => calls.push({ method, params }),
    cleanup: async () => { calls.push({ method: "cleanup" }); },
  };
}

test("refreshes rate limits in an isolated server and persists only safe metadata", async () => {
  await withService(async (root) => {
    const process = createFakeRateLimitProcess();
    const access = `x.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.x`;
    const service = createCodexAuthService({ rootDir: root, isolatedProcessFactory: async () => process });
    await service.save(profile("a", { tokens: { access_token: access, refresh_token: "refresh", account_id: "a" }, rateLimits: { old: { usedPercent: 1 } } }));
    await service.save(profile("b", { tokens: { access_token: access, refresh_token: "refresh-b", account_id: "b" } }));
    await service.setActiveAuthId("b");
    const limits = await service.refreshRateLimits("a");
    assert.deepEqual(limits, { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1234 } });
    assert.equal((await service.read("a")).rateLimits.primary.windowDurationMins, 300);
    assert.equal(await service.activeAuthId(), "b");
    assert.equal(process.calls.find((call) => call.method === "account/login/start").params.type, "chatgptAuthTokens");
    assert.equal(process.calls.at(-1).method, "cleanup");
    assert.equal(JSON.stringify(await service.snapshot()).includes("access_token"), false);
  });
});

test("marks only the failing profile unavailable and rejects malformed limits safely", async () => {
  await withService(async (root) => {
    const service = createCodexAuthService({ rootDir: root, isolatedProcessFactory: async () => createFakeRateLimitProcess({ rateLimits: { primary: { usedPercent: "secret" } } }) });
    await service.save(profile("a"));
    await service.save(profile("b"));
    await assert.rejects(() => service.refreshRateLimits("a"), /rate limits unavailable/);
    assert.equal((await service.read("a")).status, "unavailable");
    assert.equal((await service.read("a")).tokens.refresh_token, "refresh");
    assert.equal((await service.read("b")).status, undefined);
  });
});

test("shutdown waits for isolated rate-limit cleanup and rejects new auth work", async () => {
  await withService(async (root) => {
    let allowResponse;
    let rateLimitRequested;
    let cleaned = false;
    const responseAllowed = new Promise((resolve) => { allowResponse = resolve; });
    const requested = new Promise((resolve) => { rateLimitRequested = resolve; });
    const access = `x.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.x`;
    const service = createCodexAuthService({
      rootDir: root,
      isolatedProcessFactory: async () => ({
        request: async (method) => {
          if (method === "account/login/start") return { type: "chatgptAuthTokens" };
          if (method === "account/rateLimits/read") {
            rateLimitRequested();
            await responseAllowed;
            return { rateLimits: { primary: { usedPercent: 12 } } };
          }
          return {};
        },
        notify: () => {},
        cleanup: async () => { cleaned = true; },
      }),
    });
    await service.save(profile("a", { tokens: { access_token: access, refresh_token: "refresh", account_id: "a" } }));

    const refreshing = service.refreshRateLimits("a");
    await requested;
    let shutdownFinished = false;
    const stopping = service.shutdown().then(() => { shutdownFinished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownFinished, false);
    await assert.rejects(() => service.refreshRateLimits("a"), /shutting down/);
    await assert.rejects(() => service.refresh("a"), /shutting down/);

    allowResponse();
    await Promise.all([refreshing, stopping]);
    assert.equal(cleaned, true);
    assert.equal(shutdownFinished, true);
  });
});

function createFakeSpawn() {
  const captures = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const request = JSON.parse(line);
        const result = request.method === "account/login/start"
          ? { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://example.test/login", userCode: "CODE-1" }
          : request.method === "account/read" ? { account: { email: "transport@example.test" } } : {};
        if (request.id !== undefined) child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
    child.kill = (signal) => { child.exitCode = 0; child.emit("exit", 0, signal); return true; };
    captures.push({ command, args, options, child });
    return child;
  };
  return { captures, spawnImpl };
}

test("default registration transport rejects unknown server requests once", async () => {
  await withService(async (root) => {
    const registrationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-registration-root-"));
    const { captures, spawnImpl } = createFakeSpawn();
    try {
      const service = createCodexAuthService({ rootDir: root, spawnImpl, registrationTempRoot: registrationRoot });
      const result = await service.startRegistration("transport");
      const child = captures[0].child;
      const replies = [];
      child.stdin.on("data", (chunk) => { for (const line of chunk.toString().split("\n").filter(Boolean)) replies.push(JSON.parse(line)); });
      child.stdout.write(`${JSON.stringify({ id: 77, method: "unknown/request", params: {} })}\n`);
      for (let i = 0; i < 20 && !replies.some((message) => message.id === 77); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(replies.filter((message) => message.id === 77), [{ id: 77, error: { code: -32601, message: "Registration server request not handled" } }]);
      assert.deepEqual(await service.registrationStatus(result.registrationId), { status: "pending" });
    } finally { await fs.rm(registrationRoot, { recursive: true, force: true }); }
  });
});

test("registration child error fails and cleans staging without hanging", async () => {
  await withService(async (root) => {
    const registrationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-registration-root-"));
    const { captures, spawnImpl } = createFakeSpawn();
    try {
      const service = createCodexAuthService({ rootDir: root, spawnImpl, registrationTempRoot: registrationRoot });
      const result = await service.startRegistration("transport");
      const staging = captures[0].options.env.CODEX_HOME;
      captures[0].child.emit("error", new Error("transport failed"));
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && (await service.registrationStatus(result.registrationId)).status !== "failed") await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(await service.registrationStatus(result.registrationId), { status: "failed", errorCode: "process_exit" });
      await assert.rejects(() => fs.stat(staging), { code: "ENOENT" });
    } finally { await fs.rm(registrationRoot, { recursive: true, force: true }); }
  });
});

test("default registration transport stages an isolated restricted CODEX_HOME", async () => {
  await withService(async (root) => {
    const registrationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-registration-root-"));
    const { captures, spawnImpl } = createFakeSpawn();
    const original = { ...process.env };
    try {
      const service = createCodexAuthService({ rootDir: root, spawnImpl, registrationTempRoot: registrationRoot, childEnv: { ...process.env, OPENAI_API_KEY: "original-openai", CODEX_ACCESS_TOKEN: "original-codex" } });
      const result = await service.startRegistration("transport");
      const capture = captures[0];
      assert.deepEqual(capture.args.slice(0, 3), ["app-server", "--strict-config", "--stdio"]);
      assert.equal(capture.options.shell, false);
      assert.deepEqual(capture.options.stdio, ["pipe", "pipe", "pipe"]);
      assert.ok(capture.options.env.CODEX_HOME.startsWith(registrationRoot));
      assert.equal((await fs.stat(capture.options.env.CODEX_HOME)).mode & 0o777, 0o700);
      for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CHATGPT_ACCESS_TOKEN", "CODEX_ACCESS_TOKEN"]) assert.equal(key in capture.options.env, false);
      assert.deepEqual({ ...process.env }, original);
      await service.cancelRegistration(result.registrationId);
      assert.equal(capture.child.exitCode, 0);
      await assert.rejects(() => fs.stat(capture.options.env.CODEX_HOME), { code: "ENOENT" });
    } finally { await fs.rm(registrationRoot, { recursive: true, force: true }); }
  });
});

test("default registration transport persists completed credentials and removes staging", async () => {
  await withService(async (root) => {
    const registrationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-registration-root-"));
    const sentinel = path.join(os.tmpdir(), `codex-sentinel-${process.pid}`);
    await fs.writeFile(sentinel, "keep");
    const { captures, spawnImpl } = createFakeSpawn();
    try {
      const service = createCodexAuthService({ rootDir: root, spawnImpl, registrationTempRoot: registrationRoot });
      const result = await service.startRegistration("transport");
      const staging = captures[0].options.env.CODEX_HOME;
      await fs.writeFile(path.join(staging, "auth.json"), JSON.stringify({ tokens: { access_token: "access", refresh_token: "refresh", account_id: "account" }, clientId: "client" }));
      captures[0].child.stdout.write(`${JSON.stringify({ method: "account/login/completed", params: { success: true }})}\n`);
      for (let i = 0; i < 50 && (await service.registrationStatus(result.registrationId)).status !== "completed"; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(await service.registrationStatus(result.registrationId), { status: "completed" });
      assert.equal((await service.read("transport")).accountId, "account");
      assert.equal((await fs.readFile(sentinel, "utf8")), "keep");
      assert.equal(JSON.stringify(await service.snapshot()).includes("refresh"), false);
      await assert.rejects(() => fs.stat(staging), { code: "ENOENT" });
    } finally { await fs.rm(registrationRoot, { recursive: true, force: true }); await fs.rm(sentinel, { force: true }); }
  });
});

test("rejects unsafe auth ids without creating external files", async () => {
  await withService(async (root, service) => {
    await service.save(profile("user.name@example.test"));
    assert.equal((await service.read("user.name@example.test")).authId, "user.name@example.test");
    for (const authId of ["../escape", ".", "..", "a".repeat(65), "a/b", "a\\b"]) await assert.rejects(() => service.save(profile(authId)), /invalid auth id/);
    assert.deepEqual(await fs.readdir(root), ["profiles"]);
  });
});

test("uses restricted permissions for store, profile, and marker", async () => {
  await withService(async (root, service) => {
    await service.save(profile("a"));
    await service.setActiveAuthId("a");
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(root, "profiles"))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(root, "profiles", "a.json"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(root, "profiles", ".active_auth_id"))).mode & 0o777, 0o600);
  });
});

test("rejects empty tokens, mismatches, and invalid JSON without leaking secrets", async () => {
  await withService(async (root, service) => {
    for (const bad of [profile("empty", { tokens: { access_token: "", refresh_token: "refresh" } }), profile("mismatch", { tokens: { access_token: "a", refresh_token: "r", account_id: "other" } })]) await assert.rejects(() => service.save(bad));
    await service.save(profile("a"));
    await fs.writeFile(path.join(root, "profiles", "a.json"), "not-json-secret\n");
    await assert.rejects(() => service.read("a"), (error) => !error.message.includes("not-json-secret"));
    await fs.writeFile(path.join(root, "profiles", "a.json"), JSON.stringify(profile("other")));
    await assert.rejects(() => service.read("a"), /invalid auth profile/);
  });
});

test("round-trips a valid marker and treats invalid marker as empty", async () => {
  await withService(async (root, service) => {
    await service.save(profile("a"));
    await service.setActiveAuthId("a");
    assert.equal(await service.activeAuthId(), "a");
    await fs.writeFile(path.join(root, "profiles", ".active_auth_id"), "../bad\n");
    assert.equal(await service.activeAuthId(), "");
  });
});

test("owner lock rejects alive, EPERM, and grace-period owners", async () => {
  await withService(async (root, service) => {
    const lockPath = path.join(root, "profiles", ".owner.lock");
    await service.save(profile("a"));
    await fs.writeFile(lockPath, JSON.stringify({ pid: 12, acquiredAt: 1000, nonce: "n" }));
    const alive = createCodexAuthService({ rootDir: root, kill: () => {}, now: () => 100_000 });
    await assert.rejects(() => alive.acquireOwnerLock(), /unavailable/);
    await fs.writeFile(lockPath, JSON.stringify({ pid: 12, acquiredAt: 0, nonce: "n" }));
    const eperm = Object.assign(new Error("eperm"), { code: "EPERM" });
    const denied = createCodexAuthService({ rootDir: root, pid: 99, kill: () => { throw eperm; }, now: () => 100_000 });
    await assert.rejects(() => denied.acquireOwnerLock(), /unavailable/);
    const grace = createCodexAuthService({ rootDir: root, pid: 99, kill: () => { const e = new Error(); e.code = "ESRCH"; throw e; }, now: () => 1_010, staleLockMs: 60_000 });
    await assert.rejects(() => grace.acquireOwnerLock(), /unavailable/);
  });
});

test("ESRCH stale lock is replaced and release only removes matching nonce", async () => {
  await withService(async (root, service) => {
    const lockPath = path.join(root, "profiles", ".owner.lock");
    await service.save(profile("a"));
    await fs.writeFile(lockPath, JSON.stringify({ pid: 12, acquiredAt: 0, nonce: "old" }));
    const acquired = await createCodexAuthService({ rootDir: root, pid: 99, kill: () => { const e = new Error(); e.code = "ESRCH"; throw e; }, now: () => 100_000, staleLockMs: 1 }).acquireOwnerLock();
    await fs.writeFile(lockPath, JSON.stringify({ pid: 88, acquiredAt: 100_000, nonce: "new" }));
    await acquired();
    assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).nonce, "new");
  });
});

test("snapshot contains no token fields and marks invalid profiles", async () => {
  await withService(async (root, service) => {
    await service.save(profile("a", { rateLimits: { fiveHour: 10 } }));
    await fs.writeFile(path.join(root, "profiles", "broken.json"), JSON.stringify({ version: 1, authId: "broken" }));
    const snapshot = await service.snapshot();
    const text = JSON.stringify(snapshot);
    assert.equal(text.includes("access"), false);
    assert.equal(text.includes("refresh"), false);
    assert.equal(text.includes("id_token"), false);
    assert.equal(snapshot.profiles.find((item) => item.authId === "broken").status, "invalid");
  });
});

test("external payload uses official fields and zero profiles stays native", async () => {
  await withService(async (_root, service) => {
    assert.equal(await service.activeExternalTokenPayload(), null);
    const access = `x.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.x`;
    await service.save(profile("a", { tokens: { access_token: access, refresh_token: "keep", account_id: "a" }, planType: "pro" }));
    await service.setActiveAuthId("a");
    assert.deepEqual(await service.activeExternalTokenPayload(), { accessToken: access, chatgptAccountId: "a", chatgptPlanType: "pro" });
  });
});

test("external payload fails closed for a missing or invalid active marker", async () => {
  await withService(async (_root, service) => {
    await service.save(profile("a"));
    await assert.rejects(() => service.activeExternalTokenPayload(), /auth profiles unready/);
    await service.setActiveAuthId("a");
    await fs.writeFile(path.join(_root, "profiles", ".active_auth_id"), "../outside\n");
    await assert.rejects(() => service.activeExternalTokenPayload(), /auth profiles unready/);
  });
});

test("expiring access token refreshes once, while a valid token is reused", async () => {
  await withService(async (_root, service) => {
    const now = 1_700_000_000_000;
    let calls = 0;
    service = createCodexAuthService({ rootDir: _root, now: () => now, fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ access_token: "renewed" }) }; } });
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    await service.save(profile("a", { tokens: { access_token: `x.${encode({ exp: now / 1000 + 30 })}.x`, refresh_token: "keep", account_id: "a" } }));
    await service.setActiveAuthId("a");
    assert.equal((await service.activeExternalTokenPayload()).accessToken, "renewed");
    assert.equal(calls, 1);
    await service.save(profile("b", { tokens: { access_token: `x.${encode({ exp: now / 1000 + 3600 })}.x`, refresh_token: "b-refresh", account_id: "b" } }));
    await service.setActiveAuthId("b");
    assert.equal((await service.activeExternalTokenPayload()).chatgptAccountId, "b");
    assert.equal(calls, 1);
  });
});

test("force refresh exchanges even a non-expiring access token", async () => {
  await withService(async (_root, service) => {
    let calls = 0;
    const access = `x.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.x`;
    service = createCodexAuthService({ rootDir: _root, fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ access_token: "forced-refresh" }) }; } });
    await service.save(profile("a", { tokens: { access_token: access, refresh_token: "keep", account_id: "a" } }));
    assert.equal((await service.externalTokenPayload("a", { forceRefresh: true })).accessToken, "forced-refresh");
    assert.equal(calls, 1);
  });
});

test("metadata updates preserve tokens and deletion refuses the active profile", async () => {
  await withService(async (_root, service) => {
    await service.save(profile("a"));
    await service.save(profile("b"));
    await service.setActiveAuthId("a");
    await service.updateMetadata("a", { rateLimits: { fiveHour: 42 }, displayName: "A" });
    assert.deepEqual((await service.read("a")).tokens, profile("a").tokens);
    await assert.rejects(() => service.deleteProfile("a"), /active auth profile/);
    await service.deleteProfile("b");
    await assert.rejects(() => service.read("b"), /not found/);
  });
});

test("concurrent refreshes share one request and save rotation", async () => {
  await withService(async (_root, service) => {
    let calls = 0;
    service = createCodexAuthService({ rootDir: _root, fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ access_token: "next-access", refresh_token: "next-refresh" }) }; } });
    await service.save(profile());
    await Promise.all([service.refresh("a"), service.refresh("a")]);
    assert.equal(calls, 1);
    assert.equal((await service.read("a")).tokens.refresh_token, "next-refresh");
  });
});

test("withSwitch is FIFO and waits for the first callback", async () => {
  await withService(async (_root, service) => {
    let releaseFirst;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    const events = [];
    const first = service.withSwitch(async () => { events.push("first-start"); await gate; events.push("first-end"); });
    const second = service.withSwitch(async () => { events.push("second"); });
    await Promise.resolve();
    assert.deepEqual(events, ["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first-start", "first-end", "second"]);
  });
});

test("withSwitch continues after a rejected callback", async () => {
  await withService(async (_root, service) => {
    const second = service.withSwitch(async () => { throw new Error("first"); });
    await assert.rejects(second, /first/);
    const result = await service.withSwitch(async () => "continued");
    assert.equal(result, "continued");
  });
});

test("profile deletion waits for an in-flight account switch", async () => {
  await withService(async (_root, service) => {
    await service.save(profile("inactive"));
    let releaseSwitch;
    let switchStarted;
    const started = new Promise((resolve) => { switchStarted = resolve; });
    const blocked = new Promise((resolve) => { releaseSwitch = resolve; });
    const switching = service.withSwitch(async () => {
      switchStarted();
      await blocked;
    });
    await started;

    let deleteFinished = false;
    const deleting = service.deleteProfile("inactive").then(() => { deleteFinished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deleteFinished, false);

    releaseSwitch();
    await Promise.all([switching, deleting]);
    await assert.rejects(() => service.read("inactive"), /not found/);
  });
});

test("lease release is idempotent and drain closes after existing lease release", async () => {
  await withService(async (_root, service) => {
    const release = await service.acquireLease();
    const draining = service.closeAndDrain({ timeoutMs: 100 });
    assert.throws(() => service.acquireLease(), /unavailable/);
    release();
    release();
    await draining;
    assert.deepEqual(service.gateSnapshot(), { state: "closing", leases: 0 });
  });
});

test("drain timeout rolls back to open while retaining the lease", async () => {
  await withService(async (_root, service) => {
    const release = await service.acquireLease();
    await assert.rejects(() => service.closeAndDrain({ timeoutMs: 10 }), /timeout/);
    assert.deepEqual(service.gateSnapshot(), { state: "open", leases: 1 });
    release();
    assert.deepEqual(service.gateSnapshot(), { state: "open", leases: 0 });
  });
});

test("unready gate rejects leases and cannot be reopened", async () => {
  await withService(async (_root, service) => {
    service.markUnready();
    assert.throws(() => service.acquireLease(), /unavailable/);
    await assert.rejects(() => service.closeAndDrain(), /unready/);
    service.openGate();
    assert.throws(() => service.acquireLease(), /unavailable/);
    assert.deepEqual(service.gateSnapshot(), { state: "unready", leases: 0 });
  });
});

test("refresh reads the latest profile after an earlier mutation completes", async () => {
  await withService(async (root) => {
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const fetchBodies = [];
    const service = createCodexAuthService({
      rootDir: root,
      fetchImpl: async (_url, options) => {
        fetchBodies.push(new URLSearchParams(options.body).get("refresh_token"));
        return { ok: true, json: async () => ({ access_token: "next-access" }) };
      },
    });
    await service.save(profile("a"));
    const mutation = service.withMutation(async () => { await hold; });
    const pending = service.refresh("a");
    await Promise.resolve();
    await service.save(profile("a", { tokens: { access_token: "latest-access", refresh_token: "latest-refresh", account_id: "a" } }));
    release();
    await mutation;
    await pending;
    assert.deepEqual(fetchBodies, ["latest-refresh"]);
  });
});

test("same-profile refresh is single-flight and sends one current token", async () => {
  await withService(async (root, service) => {
    await service.save(profile("a"));
    let calls = 0;
    const bodies = [];
    service = createCodexAuthService({
      rootDir: root,
      fetchImpl: async (_url, options) => {
        calls += 1;
        bodies.push(new URLSearchParams(options.body).get("refresh_token"));
        return { ok: true, json: async () => ({ access_token: "next-access", refresh_token: "next-refresh" }) };
      },
    });
    await Promise.all([service.refresh("a"), service.refresh("a")]);
    assert.equal(calls, 1);
    assert.deepEqual(bodies, ["refresh"]);
  });
});

test("refresh preserves old token when response omits rotation and saves rotation when returned", async () => {
  await withService(async (root, service) => {
    await service.save(profile("a"));
    const preserve = createCodexAuthService({
      rootDir: root,
      fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: "new-access" }) }),
    });
    await preserve.refresh("a");
    assert.equal((await preserve.read("a")).tokens.refresh_token, "refresh");
    const rotate = createCodexAuthService({
      rootDir: root,
      fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: "newer-access", refresh_token: "rotated-refresh" }) }),
    });
    await rotate.refresh("a");
    assert.equal((await rotate.read("a")).tokens.refresh_token, "rotated-refresh");
  });
});

test("refresh failures preserve the canonical profile and do not leak secrets", async () => {
  const cases = [
    { name: "http", fetchImpl: async () => ({ ok: false, json: async () => ({ body: "dummy raw body" }) }) },
    { name: "json", fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("dummy raw body"); } }) },
    { name: "account", fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: "dummy access", refresh_token: "dummy refresh", account_id: "other" }) }) },
  ];
  for (const item of cases) {
    await withService(async (root, service) => {
      await service.save(profile("a"));
      const before = await service.read("a");
      const failing = createCodexAuthService({ rootDir: root, fetchImpl: item.fetchImpl });
      await assert.rejects(() => failing.refresh("a"), (error) => {
        assert.equal(error.message.includes("dummy"), false);
        return true;
      });
      assert.deepEqual((await service.read("a")).tokens, before.tokens);
    });
  }
});

test("registration starts with initialize, initialized, and device login in order", async () => {
  await withService(async (_root) => {
    const process = createFakeRegistrationProcess();
    const service = createCodexAuthService({ rootDir: _root, registrationProcessFactory: async () => process });
    const result = await service.startRegistration("a");
    assert.ok(result.registrationId);
    assert.equal(result.verificationUrl, "https://example.test/login");
    assert.equal(result.userCode, "CODE-1");
    assert.deepEqual(process.calls.map((call) => call.method).filter((method) => method !== "waitForExit"), ["initialize", "initialized", "account/login/start"]);
    const initializeCall = process.calls.find((call) => call.method === "initialize");
    assert.equal(initializeCall.params.capabilities.experimentalApi, true);
    assert.deepEqual(await service.registrationStatus(result.registrationId), { status: "pending" });
    assert.equal(JSON.stringify(await service.registrationStatus(result.registrationId)).includes("CODE-1"), false);
  });
});

test("duplicate pending registration is rejected", async () => {
  await withService(async (_root) => {
    const process = createFakeRegistrationProcess();
    let factories = 0;
    const service = createCodexAuthService({ rootDir: _root, registrationProcessFactory: async () => { factories += 1; return process; } });
    await service.startRegistration("a");
    await assert.rejects(() => service.startRegistration("a"), /already pending/);
    assert.equal(factories, 1);
  });
});

test("add registration cannot overwrite an existing active or inactive profile", async () => {
  await withService(async (_root, service) => {
    await service.save(profile("active"));
    await service.save(profile("inactive"));
    await service.setActiveAuthId("active");
    const beforeActive = await service.read("active");
    const beforeInactive = await service.read("inactive");
    let factories = 0;
    const managed = createCodexAuthService({
      rootDir: _root,
      registrationProcessFactory: async () => { factories += 1; return createFakeRegistrationProcess(); },
    });

    await assert.rejects(() => managed.startRegistration("active"), /auth profile exists/);
    await assert.rejects(() => managed.startRegistration("inactive"), /auth profile exists/);

    assert.equal(factories, 0);
    assert.deepEqual(await service.read("active"), beforeActive);
    assert.deepEqual(await service.read("inactive"), beforeInactive);
  });
});

test("concurrent add registrations claim an auth id before spawning", async () => {
  await withService(async (_root) => {
    let releaseFactory;
    const factoryGate = new Promise((resolve) => { releaseFactory = resolve; });
    let factories = 0;
    const service = createCodexAuthService({
      rootDir: _root,
      registrationProcessFactory: async () => {
        factories += 1;
        await factoryGate;
        return createFakeRegistrationProcess();
      },
    });

    const first = service.startRegistration("same-id");
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(() => service.startRegistration("same-id"), /already pending/);
    releaseFactory();
    await first;
    assert.equal(factories, 1);
  });
});

test("failed login stops and cleans registration safely", async () => {
  await withService(async (_root) => {
    const process = createFakeRegistrationProcess();
    const service = createCodexAuthService({ rootDir: _root, registrationProcessFactory: async () => process });
    const result = await service.startRegistration("a");
    await process.emit({ method: "account/login/completed", params: { success: false, error: "dummy-secret" } });
    assert.deepEqual(await service.registrationStatus(result.registrationId), { status: "failed", errorCode: "login_failed" });
    assert.equal(process.stopCount, 1);
    assert.equal(process.cleanupCount, 1);
    assert.equal(JSON.stringify(await service.registrationStatus(result.registrationId)).includes("dummy-secret"), false);
  });
});

test("cancel sends login id and is idempotent", async () => {
  await withService(async (_root) => {
    const process = createFakeRegistrationProcess();
    const service = createCodexAuthService({ rootDir: _root, registrationProcessFactory: async () => process });
    const result = await service.startRegistration("a");
    await service.cancelRegistration(result.registrationId);
    await service.cancelRegistration(result.registrationId);
    assert.equal(process.calls.filter((call) => call.method === "account/login/cancel").length, 1);
    assert.deepEqual(await service.registrationStatus(result.registrationId), { status: "cancelled" });
    assert.equal(process.stopCount, 1);
    assert.equal(process.cleanupCount, 1);
  });
});

test("unexpected process exit marks pending registration failed", async () => {
  await withService(async (_root) => {
    const process = createFakeRegistrationProcess();
    const service = createCodexAuthService({ rootDir: _root, registrationProcessFactory: async () => process });
    const result = await service.startRegistration("a");
    process.exit();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await service.registrationStatus(result.registrationId)).status, "failed");
  });
});

async function completeRegistration(service, process, registrationId) {
  await process.emit({ method: "account/login/completed", params: { success: true } });
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await service.registrationStatus(registrationId), { status: "completed" });
}

test("successful registration saves canonical metadata without changing marker", async () => {
  await withService(async (root) => {
    const process = createFakeRegistrationProcess({
      account: { email: "meta@example.test", displayName: "Meta", planType: "pro" },
      credential: { clientId: "client", tokens: { access_token: "dummy-access", refresh_token: "dummy-refresh", account_id: "a" } },
    });
    const service = createCodexAuthService({ rootDir: root, registrationProcessFactory: async () => process });
    const result = await service.startRegistration("a");
    await completeRegistration(service, process, result.registrationId);
    assert.equal((await service.read("a")).displayName, "meta@example.test");
    assert.equal((await service.read("a")).planType, "pro");
    assert.equal((await service.snapshot()).activeAuthId, "");
    const order = process.calls.map((call) => call.method);
    assert.ok(order.indexOf("account/read") < order.indexOf("stop"));
    const stopIndex = order.indexOf("stop");
    const waitIndex = order.findIndex((method, index) => method === "waitForExit" && index > stopIndex);
    assert.ok(stopIndex < waitIndex);
    assert.ok(waitIndex < order.indexOf("readCredential"));
    assert.ok(order.indexOf("readCredential") < order.indexOf("cleanup"));
    assert.equal(process.stopCount, 1);
    assert.equal(process.cleanupCount, 1);
  });
});

test("invalid credential fails without creating a profile", async () => {
  await withService(async (root) => {
    const process = createFakeRegistrationProcess({ credential: { tokens: { access_token: "dummy-access" } } });
    const service = createCodexAuthService({ rootDir: root, registrationProcessFactory: async () => process });
    const result = await service.startRegistration("a");
    await completeRegistration(service, process, result.registrationId).catch(() => {});
    assert.deepEqual(await service.registrationStatus(result.registrationId), { status: "failed", errorCode: "credential_invalid" });
    await assert.rejects(() => service.read("a"), /not found/);
  });
});

test("reauth account mismatch preserves old profile and marker", async () => {
  await withService(async (root, service) => {
    await service.save(profile("a"));
    await service.setActiveAuthId("a");
    const process = createFakeRegistrationProcess({ credential: { tokens: { access_token: "new", refresh_token: "new-refresh", account_id: "other" } } });
    const managed = createCodexAuthService({ rootDir: root, registrationProcessFactory: async () => process });
    const result = await managed.startRegistration("a", { reauth: true });
    await process.emit({ method: "account/login/completed", params: { success: true } });
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await managed.registrationStatus(result.registrationId), { status: "failed", errorCode: "reauth_account_mismatch" });
    assert.equal((await service.read("a")).tokens.access_token, "access");
    assert.equal(await service.activeAuthId(), "a");
  });
});

test("profile deletion is rejected while reauth is finalizing", async () => {
  await withService(async (root, service) => {
    await service.save(profile("a"));
    let releaseRead;
    let readStarted;
    const readReady = new Promise((resolve) => { releaseRead = resolve; });
    const accountReadStarted = new Promise((resolve) => { readStarted = resolve; });
    const process = createFakeRegistrationProcess({
      credential: { tokens: { access_token: "new-access", refresh_token: "new-refresh", account_id: "a" } },
    });
    const request = process.request;
    process.request = async (method, params) => {
      if (method !== "account/read") return request(method, params);
      readStarted();
      return readReady;
    };
    const managed = createCodexAuthService({ rootDir: root, registrationProcessFactory: async () => process });
    const { registrationId } = await managed.startRegistration("a", { reauth: true });
    const completing = process.emit({ method: "account/login/completed", params: { success: true } });
    await accountReadStarted;

    await assert.rejects(() => managed.deleteProfile("a"), /auth profile busy/);
    assert.equal((await service.read("a")).tokens.access_token, "access");

    releaseRead({ account: { email: "reauth@example.test" } });
    await completing;
    assert.deepEqual(await managed.registrationStatus(registrationId), { status: "completed" });
    assert.equal((await service.read("a")).tokens.access_token, "new-access");
  });
});

test("duplicate account and refresh token are rejected", async () => {
  await withService(async (root, service) => {
    await service.save(profile("existing"));
    const duplicateAccount = createFakeRegistrationProcess({ credential: { tokens: { access_token: "new", refresh_token: "new-refresh", account_id: "existing" } } });
    const managed = createCodexAuthService({ rootDir: root, registrationProcessFactory: async () => duplicateAccount });
    const first = await managed.startRegistration("new-account");
    await duplicateAccount.emit({ method: "account/login/completed", params: { success: true } });
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await managed.registrationStatus(first.registrationId)).errorCode, "duplicate_account");
    assert.equal((await service.snapshot()).profiles.some((item) => item.authId === "new-account"), false);
  });
});

test("duplicate refresh token with a different account is rejected", async () => {
  await withService(async (root) => {
    const service = createCodexAuthService({ rootDir: root });
    await service.save(profile("existing"));
    const process = createFakeRegistrationProcess({ credential: { tokens: { access_token: "new", refresh_token: "refresh", account_id: "other" } } });
    const managed = createCodexAuthService({ rootDir: root, registrationProcessFactory: async () => process });
    const result = await managed.startRegistration("new-account");
    await process.emit({ method: "account/login/completed", params: { success: true } });
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await managed.registrationStatus(result.registrationId)).errorCode, "duplicate_account");
    assert.equal((await service.snapshot()).profiles.some((item) => item.authId === "new-account"), false);
  });
});
