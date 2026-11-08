import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { resolveControlSocket, requestControl } from "../../skills/bitty-session-orchestrator/scripts/runner-control.mjs";

const execFile = promisify(callback);
const repoRoot = path.resolve(".");
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "runner-ctl-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return await fs.realpath(dir);
}

test("socket discovery resolves a long worktree symlink and rejects OS path overflow", async t => {
  const dir = await directory(t);
  const logs = path.join(dir, "logs");
  const root = path.join(dir, "worktree-" + "long".repeat(30));
  await fs.mkdir(logs, { mode: 0o700 });
  await fs.mkdir(path.join(root, "private_runner"), { recursive: true });
  await fs.symlink(logs, path.join(root, "private_runner/logs"));
  assert.equal(await resolveControlSocket(root, ""), path.join(logs, "runner-control.sock"));
  await assert.rejects(resolveControlSocket(root, path.join(logs, "s".repeat(120))), /OS path limit/);
  await assert.rejects(resolveControlSocket(root, "relative.sock"), /absolute path/);
});

test("a missing control socket never sends the local credential to a configured TCP URL", async t => {
  const dir = await directory(t);
  const token = path.join(dir, "token");
  await fs.writeFile(token, "private-control-credential", { mode: 0o600 });
  let requests = 0;
  const server = http.createServer((_, response) => { requests++; response.end("{}"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(execFile(process.execPath, [path.join(repoRoot, "private_runner/bin/bitty-history"), "search", "needle", "--cwd", dir], {
    env: { ...process.env, BITTY_RUNNER_TOKEN_FILE: token, RUNNER_CONTROL_SOCKET: path.join(dir, "missing.sock"),
      BITTY_RUNNER_URL: `http://127.0.0.1:${server.address().port}` },
  }));
  assert.equal(requests, 0);
});

test("control transport bounds the total request lifetime including a slowly delivered body", async t => {
  const dir = await directory(t);
  const socketPath = path.join(dir, "runner.sock");
  const server = http.createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
    const timer = setInterval(() => response.write(" "), 20);
    response.on("close", () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(requestControl(socketPath, "/agent/workspaces", { timeout: 100 }), /timed out/);
});

test("Runner startup creates its fresh control directory only when needed and propagates invalid paths", async t => {
  const dir = await directory(t);
  const runner = path.join(dir, "private_runner");
  const scripts = path.join(dir, "skills/bitty-session-orchestrator/scripts");
  await fs.mkdir(runner);
  await fs.mkdir(scripts, { recursive: true });
  await fs.copyFile(path.join(repoRoot, "skills/bitty-session-orchestrator/scripts/runner-control.mjs"), path.join(scripts, "runner-control.mjs"));
  const source = path.join(repoRoot, "private_runner/src/run-local-public-runner.sh");
  const command = 'set -euo pipefail; source "$CONTROL_SOURCE"; prepare_runner_control_socket; printf "%s" "${RUNNER_CONTROL_SOCKET-unset}"';
  const environment = { ...process.env, SCRIPT_DIR: runner, CONTROL_SOURCE: source, RUNNER_CONTROL_SOCKET: "" };
  for (const [enabled, action] of [["0", "start"], ["1", "status"], ["1", "pairing-qr"]]) {
    assert.equal((await execFile("bash", ["-c", command], { cwd: dir,
      env: { ...environment, RUNNER_ENABLE: enabled, RUN_LOCAL_COMMAND: action } })).stdout, "");
    await assert.rejects(fs.stat(path.join(runner, "logs")), { code: "ENOENT" });
  }
  const start = await execFile("bash", ["-c", command], { cwd: dir,
    env: { ...environment, RUNNER_ENABLE: "1", RUN_LOCAL_COMMAND: "start" } });
  assert.equal(start.stdout, path.join(runner, "logs/runner-control.sock"));
  await assert.rejects(execFile("bash", ["-c", command], { cwd: dir,
    env: { ...environment, RUNNER_ENABLE: "1", RUN_LOCAL_COMMAND: "restart", RUNNER_CONTROL_SOCKET: path.join(runner, "s".repeat(120)) } }));
});

test("local control token writes enforce private mode and never follow a token symlink", async t => {
  const dir = await directory(t);
  const source = path.join(repoRoot, "private_runner/src/run-local-public-runner.sh");
  const tokenFile = path.join(dir, "token");
  const environment = { ...process.env, CONTROL_SOURCE: source, RUNNER_TOKEN_FILE: tokenFile, RUNNER_TOKEN: "fixture-only" };
  const command = 'set -euo pipefail; source "$CONTROL_SOURCE"; write_runner_token_file';
  await fs.writeFile(tokenFile, "old", { mode: 0o644 });
  await execFile("bash", ["-c", command], { env: environment });
  assert.equal((await fs.stat(tokenFile)).mode & 0o777, 0o600);
  await fs.unlink(tokenFile);
  const target = path.join(dir, "unrelated");
  await fs.writeFile(target, "unchanged");
  await fs.symlink(target, tokenFile);
  await assert.rejects(execFile("bash", ["-c", command], { env: environment }));
  assert.equal(await fs.readFile(target, "utf8"), "unchanged");
});
