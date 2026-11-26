import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(callback);
const script = fileURLToPath(new URL("../../skills/bitty-browser-input/scripts/bitty-browser-input.mjs", import.meta.url));
const id = "ed7136da-8e5a-492d-b7ef-7e8eab59188d";
async function fixture(t, handle) {
  const directory = await fs.realpath(await fs.mkdtemp("/tmp/bitty-input-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenPath = path.join(directory, "token"); await fs.writeFile(tokenPath, "local-cli-test-token", { mode: 0o600 });
  const socketPath = path.join(directory, "runner.sock");
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer local-cli-test-token");
    let text = ""; for await (const chunk of req) text += chunk;
    await handle(req, res, text ? JSON.parse(text) : null);
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (...args) => execFile(process.execPath, [script, ...args], { cwd: directory,
    env: { ...process.env, BITTY_REPO_ROOT: directory, BITTY_RUNNER_TOKEN_FILE: tokenPath, RUNNER_CONTROL_SOCKET: socketPath, BITTY_RUNNER_URL: "https://must-not-use.example" } });
}

test("CLI requests a form using non-secret metadata and returns only status through Unix socket", async (t) => {
  let body; let posts = 0; let reads = 0;
  const run = await fixture(t, (req, res, input) => {
    if (req.method === "POST") { posts++; body = input; assert.equal(req.url, "/browser-input/requests"); }
    else { reads++; assert.equal(req.url, `/browser-input/requests/${body.requestId}`); }
    res.end(JSON.stringify({ requestId: body.requestId, status: req.method === "POST" ? "pending" : "completed", unexpected: "PRIVATE_UNEXPECTED_FIELD" }));
  });
  const result = await run("request", "--context", "ctx_current", "--cdp-url", "ws://127.0.0.1:9222/devtools/page/TAB", "--origin", "https://example.com", "--selector", "#password", "--label", "Password");
  assert.equal(posts, 1);
  assert.equal(reads, 0);
  assert.deepEqual(Object.keys(body).sort(), ["context", "requestId", "target"]);
  assert.deepEqual(body.target, { cdpUrl: "ws://127.0.0.1:9222/devtools/page/TAB", origin: "https://example.com", selector: "#password", label: "Password" });
  const lines = result.stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.status), ["requesting", "pending"]);
  assert.equal(result.stdout.includes("PRIVATE"), false);
});

test("status recovery is read-only; raw backend errors and invalid IDs cannot leak", async (t) => {
  let requests = 0;
  const run = await fixture(t, (req, res) => {
    requests++; assert.equal(req.method, "GET");
    if (requests === 1) res.end(JSON.stringify({ requestId: id, status: "input_status_unknown", extra: "PRIVATE" }));
    else if (requests === 2) { res.statusCode = 500; res.end(JSON.stringify({ message: "PRIVATE_BACKEND_ERROR" })); }
    else res.end(JSON.stringify({ requestId: "PRIVATE_FAKE_ID", status: "completed" }));
  });
  assert.deepEqual(JSON.parse((await run("status", "--request", id)).stdout), { requestId: id, status: "input_status_unknown" });
  for (let n = 0; n < 2; n++) await assert.rejects(run("status", "--request", id), (error) => !error.stderr.includes("PRIVATE"));
  await assert.rejects(run("status", "--request", "../wrong"));
  await assert.rejects(run("request", "--value", "DO_NOT_ACCEPT_SECRETS"));
  assert.equal(requests, 3);
});
