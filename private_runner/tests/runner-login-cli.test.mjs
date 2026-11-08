import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const kind of ["current-file", "missing-file", "empty-file", "unsafe-file", "symlink-file"]) {
  test(`owner setup CLI credential precedence: ${kind}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bl-cli-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const runner = path.join(root, "private_runner"), tools = path.join(runner, "tools");
    const helpers = path.join(root, "skills/bitty-session-orchestrator/scripts");
    const logs = path.join(runner, "logs");
    await Promise.all([fs.mkdir(tools, { recursive: true }), fs.mkdir(helpers, { recursive: true }), fs.mkdir(logs, { recursive: true })]);
    await fs.copyFile(new URL("../tools/runner-login.mjs", import.meta.url), path.join(tools, "runner-login.mjs"));
    await fs.copyFile(new URL("../../skills/bitty-session-orchestrator/scripts/runner-control.mjs", import.meta.url), path.join(helpers, "runner-control.mjs"));
    await fs.symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(runner, "node_modules"));
    const tokenFile = path.join(logs, "runner-token");
    if (kind !== "missing-file") {
      const target = kind === "symlink-file" ? path.join(logs, "other-token") : tokenFile;
      await fs.writeFile(target, kind === "empty-file" ? "" : "current-runtime-token\n", { mode: kind === "unsafe-file" ? 0o644 : 0o600 });
      if (kind === "unsafe-file") await fs.chmod(target, 0o644);
      if (kind === "symlink-file") await fs.symlink(target, tokenFile);
    }
    const preload = path.join(root, "terminal.mjs");
    await fs.writeFile(preload, 'Object.defineProperty(process.stdin, "isTTY", { value: true }); Object.defineProperty(process.stdout, "isTTY", { value: true });');
    const received = [];
    const server = http.createServer((req, res) => {
      received.push({ route: req.url, authorization: req.headers.authorization });
      req.resume(); res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "fixture_stop" }));
    });
    const socket = path.join(root, "c.sock");
    await new Promise((resolve) => server.listen(socket, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const child = spawn(process.execPath, ["--import", preload, path.join(tools, "runner-login.mjs"), "setup"], {
      cwd: os.tmpdir(), env: { ...process.env, RUNNER_TOKEN: "stale-env-token", RUNNER_TOKEN_FILE: tokenFile, RUNNER_CONTROL_SOCKET: socket },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", errors = "", entered = false;
    const timeout = setTimeout(() => child.kill(), 10000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!entered && output.includes("Owner email:")) { entered = true; child.stdin.write("owner@example.test\n"); }
    });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    clearTimeout(timeout);
    assert.equal(code, 1, errors);
    if (kind === "current-file" || kind === "missing-file") {
      assert.deepEqual(received, [{ route: "/auth/setup/start", authorization: `Bearer ${kind === "current-file" ? "current-runtime-token" : "stale-env-token"}` }]);
      assert.match(errors, /fixture_stop/);
    } else {
      assert.deepEqual(received, []);
      assert.match(errors, kind === "empty-file" ? /Local credential is missing/ : /Unsafe local credential file/);
    }
    assert.ok(!output.includes("stale-env-token") && !output.includes("current-runtime-token"));
    assert.ok(!errors.includes("stale-env-token") && !errors.includes("current-runtime-token"));
  });
}
