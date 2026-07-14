import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Isolate CODEX_HOME so these tests never touch a real ~/.codex/profiles
// directory or a real auth.json.
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-switch-"));
const profilesDir = path.join(tempDir, "profiles");
await fs.mkdir(profilesDir, { recursive: true });
await fs.writeFile(path.join(profilesDir, "profile-a_auth.json"), '{"OPENAI_API_KEY":"a"}\n');
await fs.writeFile(path.join(profilesDir, "profile-b_auth.json"), '{"OPENAI_API_KEY":"b"}\n');

process.env.CODEX_HOME = tempDir;
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
// Kept generous on purpose: none of these tests ever let the process reach
// restartRunnerForAuthSwitch(), so this timeout is never actually exercised.
process.env.CODEX_AUTH_SWITCH_RESTART_TIMEOUT_MS = "5000";

const { __TESTING__ } = await import("../src/server-runtime.mjs");
const {
  server,
  RUNNER_TOKEN,
  CODEX_AUTH_SWITCH_LOCK_PATH,
  acquireCodexAuthSwitchLock,
  isCodexAuthSwitchLockStale,
  buildAuthSwitchRestartInvocation,
  switchCodexAuthProfile,
} = __TESTING__;

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

async function removeLockFileIfPresent() {
  await fs.unlink(CODEX_AUTH_SWITCH_LOCK_PATH).catch(() => {});
}

// --- restartEnv / argv shape -------------------------------------------------

test("buildAuthSwitchRestartInvocation hands the runner token over via env only, never argv", () => {
  const invocation = buildAuthSwitchRestartInvocation();
  assert.equal(invocation.env.RUN_LOCAL_RUNNER_TOKEN, RUNNER_TOKEN);
  assert.equal(invocation.env.RUN_LOCAL_REUSE_EXISTING, "0");
  assert.ok(!invocation.args.some((arg) => arg.includes(RUNNER_TOKEN)));
  assert.ok(!invocation.command.includes(RUNNER_TOKEN));
});

// --- switchCodexAuthProfile no longer waits on (or performs) a restart ------

test("switchCodexAuthProfile replaces auth.json, updates the marker, and releases the lock without running a restart", async () => {
  await removeLockFileIfPresent();
  const startedAt = Date.now();
  const result = await switchCodexAuthProfile("profile-a");
  const elapsedMs = Date.now() - startedAt;

  // A real restart (or even just launching run-local.sh) takes well over a
  // second; if switchCodexAuthProfile ever awaited it again this would be slow.
  assert.ok(elapsedMs < 1000, `switchCodexAuthProfile took ${elapsedMs}ms, expected < 1000ms`);

  assert.equal(result.authId, "profile-a");
  assert.equal(typeof result.restartCommand, "string");
  assert.ok(result.restartCommand.length > 0);
  assert.equal(result.snapshot.currentAuthId, "profile-a");

  const authJson = await fs.readFile(path.join(tempDir, "auth.json"), "utf8");
  assert.equal(authJson.trim(), '{"OPENAI_API_KEY":"a"}');

  const marker = await fs.readFile(path.join(profilesDir, ".active_auth_id"), "utf8");
  assert.equal(marker.trim(), "profile-a");

  await assert.rejects(() => fs.access(CODEX_AUTH_SWITCH_LOCK_PATH));
});

test("switchCodexAuthProfile rejects an unknown authId with 404 before touching the lock", async () => {
  await removeLockFileIfPresent();
  await assert.rejects(
    () => switchCodexAuthProfile("does-not-exist"),
    (err) => {
      assert.equal(err.apiStatus, 404);
      assert.equal(err.apiPayload.error, "auth_profile_not_found");
      return true;
    }
  );
  await assert.rejects(() => fs.access(CODEX_AUTH_SWITCH_LOCK_PATH));
});

// --- stale-lock recovery ------------------------------------------------------

test("acquireCodexAuthSwitchLock removes a lock left by a dead pid and retries once", async () => {
  await removeLockFileIfPresent();

  // Spawn and let a child exit so its pid is (almost certainly) free again.
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = dead.pid;
  assert.ok(Number.isInteger(deadPid) && deadPid > 0);

  await fs.writeFile(CODEX_AUTH_SWITCH_LOCK_PATH, `${deadPid}\n${new Date().toISOString()}\n`);
  assert.equal(await isCodexAuthSwitchLockStale(), true);

  const releaseLock = await acquireCodexAuthSwitchLock();
  const lockContents = await fs.readFile(CODEX_AUTH_SWITCH_LOCK_PATH, "utf8");
  assert.equal(lockContents.split("\n")[0], String(process.pid));

  await releaseLock();
  await assert.rejects(() => fs.access(CODEX_AUTH_SWITCH_LOCK_PATH));
});

test("acquireCodexAuthSwitchLock still returns 409 when the lock holder is alive", async () => {
  await removeLockFileIfPresent();
  // The current test process is trivially alive.
  await fs.writeFile(CODEX_AUTH_SWITCH_LOCK_PATH, `${process.pid}\n${new Date().toISOString()}\n`);
  assert.equal(await isCodexAuthSwitchLockStale(), false);

  await assert.rejects(
    () => acquireCodexAuthSwitchLock(),
    (err) => {
      assert.equal(err.apiStatus, 409);
      assert.equal(err.apiPayload.error, "auth_switch_busy");
      return true;
    }
  );
  await removeLockFileIfPresent();
});

// --- HTTP-level checks that never reach the restart trigger ------------------
// (A real success response fires restartRunnerForAuthSwitch() after res
// "finish", which would spawn the real run-local.sh restart. That is exactly
// the server-stopping E2E this test suite intentionally does not perform, so
// only error paths that return before scheduling a restart are exercised here.)

test("POST /codex-auth/switch requires a bearer token", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/codex-auth/switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authId: "profile-a" }),
    });
    assert.equal(response.status, 401);
  });
});

test("POST /codex-auth/switch returns 404 for an unknown authId (never schedules a restart)", async () => {
  await removeLockFileIfPresent();
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/codex-auth/switch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${RUNNER_TOKEN}`,
      },
      body: JSON.stringify({ authId: "does-not-exist" }),
    });
    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.error, "auth_profile_not_found");
  });
});

// --- source wiring: the success path really does defer the restart ----------
// (Complements the runtime tests above, which cannot safely exercise the
// success path end-to-end because it would spawn a real run-local.sh restart.)

test("the /codex-auth/switch handler sends its 200 response before scheduling the restart", async () => {
  const source = await fs.readFile("private_runner/src/server-runtime.mjs", "utf8");
  const handlerMatch = source.match(
    /if \(req\.method === "POST" && pathname === "\/codex-auth\/switch"\) \{[\s\S]*?\n {2}\}\n/
  );
  assert.ok(handlerMatch, "could not locate the /codex-auth/switch handler block");
  const handlerBody = handlerMatch[0];

  const jsonCallIndex = handlerBody.indexOf("json(res, 200, {");
  const scheduleCallIndex = handlerBody.indexOf("scheduleAuthSwitchRestartAfterResponse(res)");
  assert.ok(jsonCallIndex >= 0, "expected a 200 json() response in the handler");
  assert.ok(scheduleCallIndex >= 0, "expected scheduleAuthSwitchRestartAfterResponse(res) in the handler");
  assert.ok(
    jsonCallIndex < scheduleCallIndex,
    "the 200 response must be sent before the restart is scheduled"
  );

  // scheduleAuthSwitchRestartAfterResponse itself must wait for the response
  // to actually flush (or the connection to close) before restarting.
  assert.match(source, /res\.once\("finish", trigger\)/);
  assert.match(source, /res\.once\("close", trigger\)/);
  assert.match(source, /let authSwitchRestartInFlight = false;/);
});

test("run-local-public-runner.sh reuses a handed-over RUNNER_TOKEN before the random/env case", async () => {
  const source = await fs.readFile("private_runner/src/run-local-public-runner.sh", "utf8");
  assert.match(
    source,
    /prepare_runner_runtime_token\(\) \{\s+if \[ "\$RUNNER_ENABLE" != "1" \]; then\s+return 0\s+fi\s+if \[ -n "\$\{RUN_LOCAL_RUNNER_TOKEN:-\}" \]; then\s+RUNNER_TOKEN="\$RUN_LOCAL_RUNNER_TOKEN"\s+export RUNNER_TOKEN\s+write_runner_token_file\s+RUN_LOCAL_REUSE_EXISTING=0/
  );
});

test("run-local.sh unsets RUN_LOCAL_RUNNER_TOKEN only after prepare_runner_runtime_token has consumed it", async () => {
  const source = await fs.readFile("private_runner/run-local.sh", "utf8");
  const prepareIndex = source.indexOf("prepare_runner_runtime_token\n");
  const unsetIndex = source.indexOf("unset RUN_LOCAL_RUNNER_TOKEN");
  assert.ok(prepareIndex >= 0, "expected a prepare_runner_runtime_token call");
  assert.ok(unsetIndex >= 0, "expected an unset RUN_LOCAL_RUNNER_TOKEN line");
  assert.ok(
    prepareIndex < unsetIndex,
    "RUN_LOCAL_RUNNER_TOKEN must be unset after prepare_runner_runtime_token reads it, " +
      "not in the earlier unset-RUN_LOCAL_* block (which runs before that call)"
  );
});
