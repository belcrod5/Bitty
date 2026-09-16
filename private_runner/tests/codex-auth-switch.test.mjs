import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-switch-"));
const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-store-"));
process.env.CODEX_HOME = tempDir;
process.env.CODEX_AUTH_STORE_DIR = storeDir;
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";

const { __TESTING__ } = await import("../src/server-runtime.mjs");
const { server, RUNNER_TOKEN, codexAuthService, codexAuthRuntime } = __TESTING__;

const profile = (authId) => ({
  version: 1,
  authId,
  accountId: `account-${authId}`,
  tokens: { access_token: `access-${authId}`, refresh_token: `refresh-${authId}` },
});

test.after(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.rm(storeDir, { recursive: true, force: true });
});

async function withServer(fn) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(() => resolve())); }
}

test("skip-start runtime does not acquire the owner lock", async () => {
  await assert.rejects(fs.access(path.join(storeDir, "profiles", ".owner.lock")), { code: "ENOENT" });
});

test("profiles snapshot is canonical, safe, and token-free", async () => {
  await codexAuthService.save(profile("canonical"));
  await codexAuthService.setActiveAuthId("canonical");
  await withServer(async (base) => {
    const response = await fetch(`${base}/codex-auth/profiles`, { headers: { authorization: `Bearer ${RUNNER_TOKEN}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.currentAuthId, "canonical");
    assert.equal(body.profiles[0].authId, "canonical");
    assert.equal("accountId" in body.profiles[0], false);
    assert.equal(JSON.stringify(body).includes("access-canonical"), false);
  });
});

test("profile endpoint requires bearer authentication", async () => {
  await withServer(async (base) => assert.equal((await fetch(`${base}/codex-auth/profiles`)).status, 401));
});

test("switch endpoint requires bearer authentication", async () => {
  await withServer(async (base) => assert.equal((await fetch(`${base}/codex-auth/switch`, { method: "POST", body: "{}" })).status, 401));
});

test("switch endpoint maps invalid and unknown auth ids without route-local validation", async () => {
  const original = codexAuthRuntime.switchAccount;
  codexAuthRuntime.switchAccount = async (authId) => {
    if (authId === "../invalid") throw new Error("invalid auth id");
    throw new Error("auth profile not found");
  };
  try {
    await withServer(async (base) => {
      const headers = { authorization: `Bearer ${RUNNER_TOKEN}`, "content-type": "application/json" };
      const invalid = await fetch(`${base}/codex-auth/switch`, { method: "POST", headers, body: JSON.stringify({ authId: "../invalid" }) });
      assert.deepEqual([invalid.status, await invalid.json()], [400, { error: "invalid_auth_id", message: "Invalid auth id" }]);
      const unknown = await fetch(`${base}/codex-auth/switch`, { method: "POST", headers, body: JSON.stringify({ authId: "unknown" }) });
      assert.deepEqual([unknown.status, await unknown.json()], [404, { error: "auth_profile_not_found", message: "Auth profile not found" }]);
    });
  } finally { codexAuthRuntime.switchAccount = original; }
});

test("successful switch response exposes no account id or tokens", async () => {
  const original = codexAuthRuntime.switchAccount;
  codexAuthRuntime.switchAccount = async (authId) => {
    await codexAuthService.setActiveAuthId(authId);
    return { accessToken: "secret-access", chatgptAccountId: "secret-account" };
  };
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/codex-auth/switch`, {
        method: "POST",
        headers: { authorization: `Bearer ${RUNNER_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ authId: "canonical" }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.currentAuthId, "canonical");
      assert.equal("account" in body, false);
      assert.equal(JSON.stringify(body).includes("secret-access"), false);
      assert.equal(JSON.stringify(body).includes("secret-account"), false);
    });
  } finally { codexAuthRuntime.switchAccount = original; }
});

test("switch source no longer schedules a Runner restart", async () => {
  const source = await fs.readFile("private_runner/src/server-runtime.mjs", "utf8");
  assert.doesNotMatch(source, /scheduleAuthSwitchRestartAfterResponse|restartRunnerForAuthSwitch|authSwitchRestartInFlight/);
  assert.doesNotMatch(source, /CODEX_AUTH_SWITCH_RESTART/);
});

test("owner lock startup releases after an early stop request and never listens", async () => {
  const source = await fs.readFile("private_runner/src/server-runtime.mjs", "utf8");
  assert.match(source, /let stopRequested = false;/);
  assert.match(source, /stopRequested = true;/);
  assert.match(source, /if \(stopRequested\) \{\s+await releaseCodexAuthOwnerLock\(\);\s+return;/);
  assert.match(source, /if \(!release \|\| codexAuthOwnerLockReleased\) return;/);
});

test("schedule services start only after auth initialization", async () => {
  const source = await fs.readFile("private_runner/src/server-runtime.mjs", "utf8");
  const auth = source.indexOf("await codexAuthRuntime.initialize()");
  const location = source.indexOf("await locationScheduleService.start()");
  const codex = source.indexOf("await codexScheduleService.start()");
  assert.ok(auth >= 0 && location > auth && codex > location);
});

test("inactive profile deletion succeeds and active profile returns stable 409", async () => {
  await codexAuthService.save(profile("inactive"));
  await withServer(async (base) => {
    const headers = { authorization: `Bearer ${RUNNER_TOKEN}` };
    const deleted = await fetch(`${base}/codex-auth/profiles/inactive`, { method: "DELETE", headers });
    assert.equal(deleted.status, 200);
    assert.equal((await fetch(`${base}/codex-auth/profiles/inactive`, { method: "DELETE", headers })).status, 404);
    const active = await fetch(`${base}/codex-auth/profiles/canonical`, { method: "DELETE", headers });
    assert.equal(active.status, 409);
    assert.deepEqual(await active.json(), { error: "active_auth_profile", message: "Active auth profile cannot be deleted" });
  });
});

test("profile mutations expose stable conflicts", async () => {
  await codexAuthService.save(profile("existing-inactive"));
  await withServer(async (base) => {
    const headers = { authorization: `Bearer ${RUNNER_TOKEN}`, "content-type": "application/json" };
    for (const authId of ["canonical", "existing-inactive"]) {
      const existing = await fetch(`${base}/codex-auth/registrations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ authId }),
      });
      assert.deepEqual([existing.status, await existing.json()], [409, { error: "auth_profile_exists", message: "Auth profile already exists" }]);
    }
    assert.equal((await codexAuthService.read("canonical")).tokens.access_token, "access-canonical");
    assert.equal((await codexAuthService.read("existing-inactive")).tokens.access_token, "access-existing-inactive");

    const originalDelete = codexAuthService.deleteProfile;
    codexAuthService.deleteProfile = async () => { throw new Error("auth profile busy"); };
    try {
      const busy = await fetch(`${base}/codex-auth/profiles/existing-inactive`, { method: "DELETE", headers });
      assert.deepEqual([busy.status, await busy.json()], [409, { error: "auth_profile_busy", message: "Auth profile has an active registration" }]);
    } finally { codexAuthService.deleteProfile = originalDelete; }
  });
});

test("refresh query uses the canonical rate-limit refresh path", async () => {
  const original = codexAuthService.refreshAllRateLimits;
  let called = 0;
  codexAuthService.refreshAllRateLimits = async () => { called += 1; return {}; };
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/codex-auth/profiles?refresh=1`, { headers: { authorization: `Bearer ${RUNNER_TOKEN}` } });
      assert.equal(response.status, 200);
      assert.equal(called, 1);
    });
  } finally { codexAuthService.refreshAllRateLimits = original; }
});

test("isolated rate-limit refresh does not hold the live identity gate", async () => {
  const original = codexAuthService.refreshAllRateLimits;
  let started;
  let finish;
  const entered = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { finish = resolve; });
  codexAuthService.refreshAllRateLimits = async () => { started(); await blocked; return {}; };
  try {
    await withServer(async (base) => {
      const response = fetch(`${base}/codex-auth/profiles?refresh=1`, { headers: { authorization: `Bearer ${RUNNER_TOKEN}` } });
      await entered;
      assert.deepEqual(codexAuthService.gateSnapshot(), { state: "open", leases: 0 });
      await codexAuthService.closeAndDrain({ timeoutMs: 20 });
      finish();
      assert.equal((await response).status, 200);
      codexAuthService.openGate();
    });
  } finally {
    finish?.();
    codexAuthService.openGate();
    codexAuthService.refreshAllRateLimits = original;
  }
});

test("dropped relay RPC releases its auth lease and request metadata", async () => {
  const source = await fs.readFile("private_runner/src/server-runtime.mjs", "utf8");
  assert.match(source, /if \(relay\.upstreamWs\.readyState !== WebSocket\.OPEN\) \{[\s\S]*?releaseCodexRelayRpcLease\(relay, codexRpcIdKey\(meta\?\.id\)\);[\s\S]*?return;/);
  assert.match(source, /if \(admission\) \{[\s\S]*?forwarded === false[\s\S]*?releaseCodexRelayRpcLease/);
  assert.match(source, /relay\.upstreamWs\.send\(data,[\s\S]*?catch \(error\) \{[\s\S]*?releaseCodexRelayRpcLease/);
});

test("rate-limit refresh is blocked while unready but profile snapshots remain readable", async () => {
  const original = codexAuthService.refreshAllRateLimits;
  let called = 0;
  codexAuthService.refreshAllRateLimits = async () => { called += 1; return {}; };
  codexAuthService.markUnready();
  try {
    await withServer(async (base) => {
      const headers = { authorization: `Bearer ${RUNNER_TOKEN}` };
      const refresh = await fetch(`${base}/codex-auth/profiles?refresh=1`, { headers });
      assert.deepEqual([refresh.status, await refresh.json()], [503, { error: "codex_auth_unready", message: "Codex auth service is unavailable" }]);
      assert.equal(called, 0);

      const snapshot = await fetch(`${base}/codex-auth/profiles`, { headers });
      assert.equal(snapshot.status, 200);
      assert.equal((await snapshot.json()).currentAuthId, "canonical");
    });
  } finally { codexAuthService.refreshAllRateLimits = original; }
});

test("auth mutations return stable unavailable response when gate is unready", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/codex-auth/registrations`, { method: "POST", headers: { authorization: `Bearer ${RUNNER_TOKEN}`, "content-type": "application/json" }, body: "{}" });
    assert.deepEqual([response.status, await response.json()], [503, { error: "codex_auth_unready", message: "Codex auth service is unavailable" }]);
  });
});
