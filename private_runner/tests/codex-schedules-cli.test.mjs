import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentService } from "../src/agent/agent-service.mjs";
import { operationStore, sessionStore } from "./agent-service-fixtures.mjs";
import { createCodexScheduleService } from "../src/codex-schedule-service.mjs";
import { createCodexScheduleHttpHandler } from "../src/codex-schedule-http.mjs";
import { createRunnerLoginHttp } from "../src/runner-login-http.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tools/codex-schedules.mjs",
);

async function makeCliRoot(t, envText, token = "test-runner-token") {
  const root = await fs.mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "codex-schedules-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "private_runner/tools"), { recursive: true });
  await fs.mkdir(path.join(root, "private_runner/secrets"), { recursive: true });
  await fs.mkdir(path.join(root, "private_runner/logs"), { recursive: true });
  await fs.mkdir(path.join(root, "skills/bitty-session-orchestrator/scripts"), { recursive: true });
  await fs.copyFile(path.resolve("skills/bitty-session-orchestrator/scripts/runner-control.mjs"), path.join(root, "skills/bitty-session-orchestrator/scripts/runner-control.mjs"));
  await fs.copyFile(SOURCE_CLI, path.join(root, "private_runner/tools/codex-schedules.mjs"));
  await fs.writeFile(path.join(root, "private_runner/.env"), envText, "utf8");
  const tokenPath = path.join(root, "private_runner/secrets/token");
  await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  await fs.chmod(tokenPath, 0o600);
  return { root, cli: path.join(root, "private_runner/tools/codex-schedules.mjs"), tokenPath };
}

function runCli(cli, args, { input = "", env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function listen(handler) {
  const server = http.createServer(handler);
  const dir = await fs.mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "codex-cli-socket-"));
  const socketPath = path.join(await fs.realpath(dir), "runner.sock");
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    server, socketPath,
    close: async () => {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : null;
}

test("CLI uses env-file overrides, the token file, and Unix socket CRUD requests", async (t) => {
  const requests = [];
  const listener = await listen(async (req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      requestId: req.headers["idempotency-key"],
      body: await readBody(req),
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, method: req.method }));
  });
  t.after(listener.close);
  const cli = await makeCliRoot(t, [
    "RUNNER_TOKEN_FILE=ignored",
    "export RUNNER_TOKEN_FILE=\"private_runner/secrets/to#ken\" # final value",
    "RUNNER_CONTROL_SOCKET=",
    `RUNNER_CONTROL_SOCKET='${listener.socketPath}'`,
    "IGNORED=$(touch /tmp/must-not-run)",
  ].join("\n"));
  await fs.writeFile(path.join(cli.root, "private_runner/secrets/to#ken"), "test-runner-token\n", {
    mode: 0o600,
  });
  const processEnv = { RUNNER_TOKEN_FILE: "wrong", RUNNER_CONTROL_SOCKET: "/wrong/socket" };

  assert.equal((await runCli(cli.cli, ["list"], { env: processEnv })).code, 0);
  const createInput = {
    baseRevision: 0,
    requestId: ID,
    schedule: { prompt: "secret prompt", threadId: "thread-current" },
  };
  assert.equal((await runCli(cli.cli, ["create"], {
    env: processEnv,
    input: JSON.stringify(createInput),
  })).code, 0);
  assert.equal((await runCli(cli.cli, ["update", ID], {
    env: processEnv,
    input: JSON.stringify({ baseRevision: 1, patch: { enabled: false } }),
  })).code, 0);
  assert.equal((await runCli(cli.cli, ["delete", ID], {
    env: processEnv,
    input: JSON.stringify({ baseRevision: 2 }),
  })).code, 0);

  assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
    ["GET", "/codex-schedules"],
    ["POST", "/codex-schedules"],
    ["PATCH", `/codex-schedules/${ID}`],
    ["DELETE", `/codex-schedules/${ID}`],
  ]);
  assert.equal(requests.every((request) => request.authorization === "Bearer test-runner-token"), true);
  assert.equal(requests[1].requestId, ID);
  assert.equal("requestId" in requests[1].body, false);
  assert.equal(requests[1].body.baseRevision, 0);
  assert.equal(requests[1].body.schedule.threadId, "thread-current");
});

test("create validates requestId before config and preserves it on later failures", async (t) => {
  const cli = await makeCliRoot(t, "RUNNER_CONTROL_SOCKET=$(bad)\nRUNNER_TOKEN_FILE=private_runner/secrets/token\n");
  const invalid = await runCli(cli.cli, ["create"], {
    input: JSON.stringify({ requestId: "private-value", schedule: { prompt: "do not echo" } }),
  });
  assert.equal(invalid.code, 1);
  const invalidPayload = JSON.parse(invalid.stderr);
  assert.equal(invalidPayload.error, "invalid_input");
  assert.equal(invalid.stderr.includes("private-value"), false);
  assert.equal("requestId" in invalidPayload, false);

  const configFailure = await runCli(cli.cli, ["create"], {
    input: JSON.stringify({ requestId: ID, baseRevision: 0, schedule: { prompt: "do not echo" } }),
  });
  assert.equal(configFailure.code, 1);
  assert.deepEqual(JSON.parse(configFailure.stderr), {
    error: "runner_config_invalid",
    message: "RUNNER_CONTROL_SOCKET contains unsupported shell syntax",
    requestId: ID,
  });
  assert.equal(configFailure.stderr.includes("do not echo"), false);
});

test("HTTP errors keep requestId while token and body remain out of output", async (t) => {
  const listener = await listen(async (_req, res) => {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      error: "codex_schedule_store_unavailable",
      message: "never-print-this-token",
      prompt: "never print this prompt",
      authorization: "Bearer never-print-this-token",
    }));
  });
  t.after(listener.close);
  const token = "never-print-this-token";
  const cli = await makeCliRoot(t, [
    "RUNNER_TOKEN_FILE=private_runner/secrets/token",
    `RUNNER_CONTROL_SOCKET=${listener.socketPath}`,
  ].join("\n"), token);
  const result = await runCli(cli.cli, ["create"], {
    input: JSON.stringify({
      requestId: ID,
      baseRevision: 0,
      schedule: { prompt: "never print this prompt" },
    }),
  });
  assert.equal(result.code, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    error: "codex_schedule_store_unavailable",
    requestId: ID,
  });
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes("never print this prompt"), false);

  const generated = await runCli(cli.cli, ["create"], {
    input: JSON.stringify({ baseRevision: 0, schedule: { prompt: "also private" } }),
  });
  const generatedPayload = JSON.parse(generated.stderr);
  assert.equal(generated.code, 2);
  assert.match(generatedPayload.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(generated.stderr.includes("also private"), false);
});

test("HTTP errors retain only bounded messages unrelated to token and input strings", async (t) => {
  const listener = await listen(async (_req, res) => {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      error: "invalid_codex_schedules",
      message: "baseRevision must be a non-negative integer",
      ignored: "unknown field",
    }));
  });
  t.after(listener.close);
  const cli = await makeCliRoot(t, [
    "RUNNER_TOKEN_FILE=private_runner/secrets/token",
    `RUNNER_CONTROL_SOCKET=${listener.socketPath}`,
  ].join("\n"));
  const result = await runCli(cli.cli, ["create"], {
    input: JSON.stringify({
      requestId: ID,
      baseRevision: -1,
      schedule: { prompt: "private prompt" },
    }),
  });
  assert.equal(result.code, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    error: "invalid_codex_schedules",
    message: "baseRevision must be a non-negative integer",
    requestId: ID,
  });
});

test("CLI preserves the required session directory on create and update cwd mismatches", async (t) => {
  const parent = "/Volumes/SSD-500GB-SanDisk/work/家";
  const child = `${parent}/生活費調査_261024`;
  const agent = createAgentService({
    backends: [{ backendId: "codex", resolveSessionCwd: async () => parent }],
    operationStore: operationStore(), sessionStore: sessionStore(),
    workspaceAdmission: { assertAllowed: async () => {} },
    resolveCanonicalCwd: async (cwd) => cwd,
  });
  const listener = await listen(async (req, res) => {
    const body = await readBody(req);
    const action = body.schedule || body.patch;
    try {
      await agent.resolveExecutionCwd({
        sessionRef: { backendId: "codex", nativeSessionId: action.threadId }, cwd: action.cwd,
      });
      assert.fail("The child directory must be rejected");
    } catch (error) {
      assert.equal(error.code, "session_cwd_mismatch");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_codex_schedules", message: error.message }));
    }
  });
  t.after(listener.close);
  const cli = await makeCliRoot(t, [
    "RUNNER_TOKEN_FILE=private_runner/secrets/token", `RUNNER_CONTROL_SOCKET=${listener.socketPath}`,
  ].join("\n"));
  const action = { cwd: child, threadId: "thread-existing", prompt: "private prompt" };
  for (const [args, input] of [
    [["create"], { requestId: ID, baseRevision: 0, schedule: action }],
    [["update", ID], { baseRevision: 0, patch: action }],
  ]) {
    const result = await runCli(cli.cli, args, { input: JSON.stringify(input) });
    assert.equal(result.code, 2);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.error, "invalid_codex_schedules");
    assert.match(payload.message, /cwd does not match/);
    assert.ok(payload.message.includes(`Set cwd to ${parent}`));
    assert.equal(result.stderr.includes(child), false);
    assert.equal(result.stderr.includes(action.prompt), false);
  }
});

test("CLI rejects 2xx objects without ok true and never echoes unknown error payloads", async (t) => {
  let mode = "success";
  const listener = await listen(async (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (mode === "success") {
      res.end(JSON.stringify({ schedules: [], prompt: "private response" }));
    } else {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "unknown_error", token: "private token" }));
    }
  });
  t.after(listener.close);
  const cli = await makeCliRoot(t, [
    "RUNNER_TOKEN_FILE=private_runner/secrets/token",
    `RUNNER_CONTROL_SOCKET=${listener.socketPath}`,
  ].join("\n"));

  const invalidSuccess = await runCli(cli.cli, ["list"]);
  assert.equal(invalidSuccess.code, 1);
  assert.equal(JSON.parse(invalidSuccess.stderr).error, "invalid_runner_response");
  assert.equal(invalidSuccess.stderr.includes("private response"), false);

  mode = "error";
  const invalidError = await runCli(cli.cli, ["list"]);
  assert.equal(invalidError.code, 1);
  assert.equal(JSON.parse(invalidError.stderr).error, "invalid_runner_response");
  assert.equal(invalidError.stderr.includes("private token"), false);
});

test("CLI maps unreadable config, invalid JSON, and interrupted bodies to fixed local errors", async (t) => {
  const config = await makeCliRoot(t, "RUNNER_PORT=8788\n");
  await fs.rm(path.join(config.root, "private_runner/.env"));
  await fs.mkdir(path.join(config.root, "private_runner/.env"));
  const configResult = await runCli(config.cli, ["list"]);
  assert.equal(configResult.code, 1);
  assert.equal(JSON.parse(configResult.stderr).error, "runner_config_invalid");

  let mode = "invalid-json";
  const listener = await listen(async (req, res) => {
    if (mode === "invalid-json") {
      res.statusCode = 200;
      res.end("not json");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100" });
    res.flushHeaders();
    res.write('{"ok":true');
    setTimeout(() => req.socket.destroy(), 50);
  });
  t.after(listener.close);
  const cli = await makeCliRoot(t, [
    "RUNNER_TOKEN_FILE=private_runner/secrets/token",
    `RUNNER_CONTROL_SOCKET=${listener.socketPath}`,
  ].join("\n"));
  const invalidJson = await runCli(cli.cli, ["list"]);
  assert.equal(invalidJson.code, 1);
  assert.equal(JSON.parse(invalidJson.stderr).error, "invalid_runner_response");

  mode = "interrupted";
  const interrupted = await runCli(cli.cli, ["create"], {
    input: JSON.stringify({ requestId: ID, baseRevision: 0, schedule: { prompt: "private" } }),
  });
  assert.equal(interrupted.code, 1);
  assert.equal(JSON.parse(interrupted.stderr).error, "invalid_runner_response");
  assert.equal(JSON.parse(interrupted.stderr).requestId, ID);
});

test("CLI rejects missing, empty, and directory token files", async (t) => {
  for (const kind of ["missing", "empty", "directory"]) {
    const cli = await makeCliRoot(t, "RUNNER_TOKEN_FILE=private_runner/secrets/token\n");
    if (kind === "missing") {
      await fs.rm(cli.tokenPath);
    } else if (kind === "empty") {
      await fs.writeFile(cli.tokenPath, "", { mode: 0o600 });
    } else {
      await fs.rm(cli.tokenPath);
      await fs.mkdir(cli.tokenPath);
    }
    const result = await runCli(cli.cli, ["list"]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error, "runner_token_file_invalid");
  }
});

test("CLI aborts a request after the fixed ten-second timeout", async (t) => {
  const listener = await listen(async () => {});
  t.after(listener.close);
  const cli = await makeCliRoot(t, [
    "RUNNER_TOKEN_FILE=private_runner/secrets/token",
    `RUNNER_CONTROL_SOCKET=${listener.socketPath}`,
  ].join("\n"));
  const startedAt = Date.now();
  const result = await runCli(cli.cli, ["create"], {
    input: JSON.stringify({ requestId: ID, baseRevision: 0, schedule: { prompt: "private" } }),
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error, "runner_request_timeout");
  assert.equal(JSON.parse(result.stderr).requestId, ID);
  assert.ok(elapsed >= 9_500 && elapsed < 12_000, `unexpected timeout duration: ${elapsed}ms`);
});

test("CLI keeps redirects manual and reports connection failures without leaking the token", async (t) => {
  let redirected = 0;
  const target = await listen(async (_req, res) => {
    redirected += 1;
    res.end(JSON.stringify({ ok: true }));
  });
  t.after(target.close);
  const redirect = await listen(async (_req, res) => {
    res.statusCode = 302;
    res.setHeader("Location", "https://example.test/stolen");
    res.end(JSON.stringify({ error: "unauthorized", message: "redirect was refused" }));
  });
  t.after(redirect.close);
  const cli = await makeCliRoot(t, [
    "RUNNER_TOKEN_FILE=private_runner/secrets/token",
    `RUNNER_CONTROL_SOCKET=${redirect.socketPath}`,
  ].join("\n"));
  const redirectedResult = await runCli(cli.cli, ["list"]);
  assert.equal(redirectedResult.code, 2);
  assert.deepEqual(JSON.parse(redirectedResult.stderr), {
    error: "unauthorized",
    message: "redirect was refused",
  });
  assert.equal(redirected, 0);

  const closedSocket = redirect.socketPath;
  await new Promise(resolve => redirect.server.close(resolve));
  const connection = await runCli(cli.cli, ["list"]);
  assert.equal(connection.code, 1);
  assert.equal(JSON.parse(connection.stderr).error, "runner_connection_failed");
  assert.equal(connection.stderr.includes("test-runner-token"), false);
  assert.ok(path.isAbsolute(closedSocket));
});

test("response-loss create retry sends two POSTs, no GET, and preserves baseRevision", async (t) => {
  const requests = [];
  const listener = await listen(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, body, requestId: req.headers["idempotency-key"] });
    if (requests.length === 1) {
      req.socket.destroy();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, created: false, revision: 5, schedule: { id: ID } }));
  });
  t.after(listener.close);
  const cli = await makeCliRoot(t, [
    "RUNNER_TOKEN_FILE=private_runner/secrets/token",
    `RUNNER_CONTROL_SOCKET=${listener.socketPath}`,
  ].join("\n"));
  const input = JSON.stringify({
    requestId: ID,
    baseRevision: 4,
    schedule: { prompt: "same request" },
  });
  const lost = await runCli(cli.cli, ["create"], { input });
  assert.equal(lost.code, 1);
  assert.equal(JSON.parse(lost.stderr).requestId, ID);
  const retried = await runCli(cli.cli, ["create"], { input });
  assert.equal(retried.code, 0);
  assert.deepEqual(requests.map((request) => request.method), ["POST", "POST"]);
  assert.deepEqual(requests.map((request) => request.body.baseRevision), [4, 4]);
  assert.equal(requests.every((request) => request.requestId === ID), true);
});

test("unsafe config and broad token permissions fail closed before a request", async (t) => {
  const unsafe = await makeCliRoot(t, "RUNNER_TOKEN_FILE=private_runner\\secrets\\token\n");
  const unsafeResult = await runCli(unsafe.cli, ["list"]);
  assert.equal(unsafeResult.code, 1);
  assert.equal(JSON.parse(unsafeResult.stderr).error, "runner_config_invalid");

  for (const operation of [
    "readonly RUNNER_CONTROL_SOCKET=/tmp/runner.sock",
    "declare -x RUNNER_TOKEN_FILE=private_runner/secrets/token",
    "typeset RUNNER_CONTROL_SOCKET=/tmp/runner.sock",
    "unset -v RUNNER_CONTROL_SOCKET",
    "export -n RUNNER_CONTROL_SOCKET",
  ]) {
    const operated = await makeCliRoot(t, `${operation}\n`);
    const operatedResult = await runCli(operated.cli, ["list"]);
    assert.equal(operatedResult.code, 1);
    assert.equal(JSON.parse(operatedResult.stderr).error, "runner_config_invalid");
  }

  const mentioned = await makeCliRoot(t, [
    "OTHER=RUNNER_PORT",
    "# RUNNER_TOKEN_FILE must not affect parsing",
    "RUNNER_TOKEN_FILE=private_runner/secrets/token",
    "RUNNER_PORT=1",
  ].join("\n"));
  const mentionedResult = await runCli(mentioned.cli, ["list"]);
  assert.notEqual(JSON.parse(mentionedResult.stderr).error, "runner_config_invalid");

  const permissions = await makeCliRoot(t, "RUNNER_TOKEN_FILE=private_runner/secrets/token\n");
  await fs.chmod(permissions.tokenPath, 0o644);
  const permissionResult = await runCli(permissions.cli, ["list"]);
  assert.equal(permissionResult.code, 1);
  assert.equal(JSON.parse(permissionResult.stderr).error, "runner_token_file_invalid");
});

test("owner CLI uses the same GET/PUT endpoint as UI and help explains interval versus calendar", async (t) => {
  const requests = [];
  const listener = await listen(async (req, res) => {
    requests.push({ method: req.method, url: req.url, body: await readBody(req) });
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, revision: 2 }));
  });
  t.after(listener.close);
  const f = await makeCliRoot(t, `RUNNER_TOKEN_FILE=private_runner/secrets/token\nRUNNER_CONTROL_SOCKET=${listener.socketPath}\n`);
  const settings = { enabled: true, trigger: { kind: "calendar", startLocal: "2026-11-16T09:00:00", timeZone: "Asia/Tokyo", rrule: "FREQ=DAILY" }, prompt: "Check", systemInstruction: "" };
  const file = path.join(f.root, "settings.json"); await fs.writeFile(file, JSON.stringify({ baseRevision: 1, settings }), { mode: 0o600 });
  assert.equal((await runCli(f.cli, ["orchestrator-get", "main"])).code, 0);
  assert.equal((await runCli(f.cli, ["orchestrator-set", ID, "--file", file])).code, 0);
  assert.deepEqual(requests, [{ method: "GET", url: "/orchestrators/main/schedule", body: null },
    { method: "PUT", url: `/orchestrators/${ID}/schedule`, body: { baseRevision: 1, settings } }]);
  assert.match((await runCli(f.cli, ["--help"])).stdout, /Never mix interval and calendar fields/);
  for (const args of [["orchestrator-get", "bad"], ["orchestrator-get", "main", "--file", file], ["orchestrator-set"]]) {
    assert.equal(JSON.parse((await runCli(f.cli, args)).stderr).error, "invalid_cli_usage");
  }
});

test("CLI accepts the earlier owner-only API error even when prompt overlaps its guidance", async (t) => {
  const listener = await listen(async (req, res) => {
    await readBody(req); res.statusCode = 400; res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "orchestrator_schedule_api_required", message: "定期実行は専用設定を使ってください orchestrator-get" }));
  });
  t.after(listener.close);
  const f = await makeCliRoot(t, `RUNNER_TOKEN_FILE=private_runner/secrets/token\nRUNNER_CONTROL_SOCKET=${listener.socketPath}\n`);
  const result = await runCli(f.cli, ["create"], { input: JSON.stringify({ baseRevision: 1, schedule: { action: { kind: "voice", prompt: "定期実行" } } }) });
  assert.equal(result.code, 2); assert.equal(JSON.parse(result.stderr).error, "orchestrator_schedule_api_required");
  assert.match(JSON.parse(result.stderr).message, /orchestrator-get.*orchestrator-set/);
});

test("deployed legacy CLI updates and restores orchestrator timing through authenticated HTTP and UDS", async (t) => {
  const cli = await makeCliRoot(t, "RUNNER_TOKEN_FILE=private_runner/secrets/token\n");
  await fs.copyFile(new URL("./fixtures/codex-schedules-cli-legacy.mjs", import.meta.url), cli.cli);
  const ownerId = "22222222-2222-4222-8222-222222222222";
  const definitionsPath = path.join(cli.root, "private_runner/logs/schedules.json");
  const original = { id: ID, name: "Morning check", enabled: true, startLocal: "2026-08-14T09:00:00", timeZone: "Asia/Tokyo", rrule: "FREQ=DAILY",
    action: { kind: "voice", orchestratorId: "main", prompt: "Original prompt" } };
  const other = { ...original, id: ownerId, action: { ...original.action, orchestratorId: ownerId } };
  await fs.writeFile(definitionsPath, JSON.stringify({ version: 2, revision: 0, schedules: [original, other], updatedAt: "2026-08-13T00:00:00.000Z" }));
  let dispatchAttempts = 0;
  const service = createCodexScheduleService({ definitionsPath, runtimePath: path.join(cli.root, "private_runner/logs/runtime.json"),
    voiceContextService: { list: async () => ({ orchestrators: [{ id: "main" }, { id: ownerId }] }),
      open: async () => { dispatchAttempts++; throw new Error("No dispatch should be attempted"); } },
    parseCodexOptions: () => { throw new Error("Voice uses owner model settings"); },
    now: () => new Date("2026-08-13T00:00:00.000Z"), scheduleTimer: () => ({ unref() {} }), clearTimer() {} });
  const handler = createCodexScheduleHttpHandler({ service, readJsonBody: readBody,
    json: (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); } });
  const login = createRunnerLoginHttp({ service: { authenticate: async (token, { local }) => {
    assert.equal(token, "test-runner-token"); assert.equal(local, true);
    return { local, ownerSubjectId: "fixture-owner", sessionId: "fixture-session" };
  } } });
  const listener = await listen(login.wrap(async (req, res) => handler(req, res, new URL(req.url, "http://runner.local").pathname), { local: true }));
  t.after(listener.close);
  await fs.appendFile(path.join(cli.root, "private_runner/.env"), `RUNNER_CONTROL_SOCKET=${listener.socketPath}\n`);
  const call = async (args, input) => {
    const file = path.join(cli.root, "request.json");
    if (input) await fs.writeFile(file, JSON.stringify(input), { mode: 0o600 });
    try { return await runCli(cli.cli, input ? [...args, "--file", file] : args); }
    finally { if (input) await fs.rm(file); }
  };
  const list = async () => {
    const result = await call(["list"]); assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const before = await list();
  const preservedOther = before.schedules.find(item => item.id === ownerId);
  const patch = async (patch) => {
    const before = await list();
    const result = await call(["update", ID], { baseRevision: before.revision, patch });
    assert.equal(result.code, 0, result.stderr);
    const after = await list();
    assert.equal(after.schedules.length, 2);
    assert.deepEqual(after.schedules.find(item => item.id === ownerId), preservedOther);
    assert.equal(after.schedules.find(item => item.action.orchestratorId === "main").id, ID);
    return { result: JSON.parse(result.stdout), owner: await service.getOrchestratorSchedule("main"), snapshot: after };
  };
  const noOp = await patch({ enabled: true });
  assert.equal(noOp.result.updated, false); assert.equal(noOp.snapshot.revision, before.revision);
  const disabled = await patch({ enabled: false });
  assert.equal(disabled.owner.settings.enabled, false); assert.equal(disabled.owner.settings.trigger.startLocal, original.startLocal);
  const interval = await patch({ rrule: "FREQ=MINUTELY;INTERVAL=45", prompt: "Temporary interval prompt" });
  assert.deepEqual(interval.owner.settings.trigger, { kind: "interval", minutes: 45 });
  assert.equal(interval.owner.settings.prompt, "Temporary interval prompt"); assert.equal(interval.owner.nextOccurrenceAt, null);
  const calendar = await patch({ enabled: true, rrule: "FREQ=DAILY", startLocal: "2026-08-14T10:00:00" });
  assert.equal(calendar.owner.settings.trigger.startLocal, "2026-08-14T10:00:00");
  assert.equal(calendar.owner.nextOccurrenceAt, "2026-08-14T01:00:00.000Z");
  const restored = await patch({ enabled: original.enabled, startLocal: original.startLocal, rrule: original.rrule, action: original.action });
  assert.deepEqual(restored.snapshot.schedules.find(item => item.id === ID), before.schedules.find(item => item.id === ID));
  assert.equal(restored.owner.settings.trigger.startLocal, original.startLocal);
  assert.equal(restored.owner.nextOccurrenceAt, "2026-08-14T00:00:00.000Z");
  for (const input of [
    { baseRevision: restored.snapshot.revision, patch: { action: { ...original.action, orchestratorId: ownerId } } },
    { baseRevision: restored.snapshot.revision, patch: { rrule: "FREQ=DAILY", minutes: 60 } },
    { baseRevision: restored.snapshot.revision, patch: { cwd: "/bad" } },
  ]) {
    const result = await call(["update", ID], input);
    assert.equal(result.code, 2); assert.equal(JSON.parse(result.stderr).error, "invalid_codex_schedules");
    assert.doesNotMatch(result.stderr, /unknown error response/);
  }
  const { id, ...duplicate } = original;
  const duplicateResult = await call(["create"], { baseRevision: restored.snapshot.revision, requestId: "33333333-3333-4333-8333-333333333333", schedule: duplicate });
  assert.equal(duplicateResult.code, 2); assert.equal(JSON.parse(duplicateResult.stderr).error, "invalid_codex_schedules");
  assert.match(JSON.parse(duplicateResult.stderr).message, /update the existing/);
  const missingResult = await call(["create"], { baseRevision: restored.snapshot.revision, requestId: "44444444-4444-4444-8444-444444444444",
    schedule: { ...duplicate, action: { ...duplicate.action, orchestratorId: "55555555-5555-4555-8555-555555555555" } } });
  assert.equal(missingResult.code, 2); assert.equal(JSON.parse(missingResult.stderr).error, "invalid_codex_schedules");
  assert.deepEqual((await list()).schedules, restored.snapshot.schedules); assert.equal(dispatchAttempts, 0);
});
