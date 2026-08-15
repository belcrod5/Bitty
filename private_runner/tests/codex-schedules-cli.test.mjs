import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tools/codex-schedules.mjs",
);

async function makeCliRoot(t, envText, token = "test-runner-token") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-schedules-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "private_runner/tools"), { recursive: true });
  await fs.mkdir(path.join(root, "private_runner/secrets"), { recursive: true });
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : null;
}

test("CLI uses env-file overrides, the token file, and fixed loopback CRUD requests", async (t) => {
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
    "RUNNER_PORT=",
    `PORT='${listener.port}'`,
    "IGNORED=$(touch /tmp/must-not-run)",
  ].join("\n"));
  await fs.writeFile(path.join(cli.root, "private_runner/secrets/to#ken"), "test-runner-token\n", {
    mode: 0o600,
  });
  const processEnv = { RUNNER_TOKEN_FILE: "wrong", RUNNER_PORT: "2", PORT: "3" };

  assert.equal((await runCli(cli.cli, ["list"], { env: processEnv })).code, 0);
  const createInput = {
    baseRevision: 0,
    requestId: ID,
    schedule: { prompt: "secret prompt" },
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
});

test("create validates requestId before config and preserves it on later failures", async (t) => {
  const cli = await makeCliRoot(t, "RUNNER_PORT=$(bad)\nRUNNER_TOKEN_FILE=private_runner/secrets/token\n");
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
    message: "RUNNER_PORT contains unsupported shell syntax",
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
    `RUNNER_PORT=${listener.port}`,
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
    `RUNNER_PORT=${listener.port}`,
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
    `RUNNER_PORT=${listener.port}`,
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
    `RUNNER_PORT=${listener.port}`,
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
    `RUNNER_PORT=${listener.port}`,
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
    res.setHeader("Location", `http://127.0.0.1:${target.port}/stolen`);
    res.end(JSON.stringify({ error: "unauthorized", message: "redirect was refused" }));
  });
  t.after(redirect.close);
  const cli = await makeCliRoot(t, [
    "RUNNER_TOKEN_FILE=private_runner/secrets/token",
    `RUNNER_PORT=${redirect.port}`,
  ].join("\n"));
  const redirectedResult = await runCli(cli.cli, ["list"]);
  assert.equal(redirectedResult.code, 2);
  assert.deepEqual(JSON.parse(redirectedResult.stderr), {
    error: "unauthorized",
    message: "redirect was refused",
  });
  assert.equal(redirected, 0);

  const closedPort = redirect.port;
  await redirect.close();
  const connection = await runCli(cli.cli, ["list"]);
  assert.equal(connection.code, 1);
  assert.equal(JSON.parse(connection.stderr).error, "runner_connection_failed");
  assert.equal(connection.stderr.includes("test-runner-token"), false);
  assert.equal(Number.isInteger(closedPort), true);
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
    `RUNNER_PORT=${listener.port}`,
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
    "readonly RUNNER_PORT=8788",
    "declare -x RUNNER_TOKEN_FILE=private_runner/secrets/token",
    "typeset PORT=8788",
    "unset -v RUNNER_PORT",
    "export -n PORT",
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
