import test from "node:test";
import { WebSocketServer } from "ws";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(callback);
const script = fileURLToPath(new URL("../../skills/bitty-browser-control/scripts/bitty-browser-control.mjs", import.meta.url));
const id = "ed7136da-8e5a-492d-b7ef-7e8eab59188d";
async function fixture(t, handle) {
  const directory = await fs.realpath(await fs.mkdtemp("/tmp/bitty-control-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "private_runner"));
  await fs.symlink(fileURLToPath(new URL("../src", import.meta.url)), path.join(directory, "private_runner/src"));
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

test("CLI requests a browser panel using non-secret metadata and returns only status through Unix socket", async (t) => {
  let body; let posts = 0; let reads = 0;
  const run = await fixture(t, (req, res, input) => {
    if (req.method === "POST") { posts++; body = input; assert.equal(req.url, "/browser-control/requests"); }
    else { reads++; assert.equal(req.url, `/browser-control/requests/${body.requestId}`); }
    res.end(JSON.stringify({ requestId: body.requestId, status: req.method === "POST" ? "pending" : "completed", unexpected: "PRIVATE_UNEXPECTED_FIELD" }));
  });
  const result = await run("request", "--context", "ctx_current", "--cdp-url", "ws://127.0.0.1:9222/devtools/page/TAB", "--origin", "https://example.com", "--label", "Password");
  assert.equal(posts, 1);
  assert.equal(reads, 0);
  assert.deepEqual(Object.keys(body).sort(), ["context", "requestId", "target"]);
  assert.deepEqual(body.target, { cdpUrl: "ws://127.0.0.1:9222/devtools/page/TAB", origin: "https://example.com", label: "Password" });
  const lines = result.stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.status), ["requesting", "pending"]);
  assert.equal(result.stdout.includes("PRIVATE"), false);
});

test("status recovery is read-only; raw backend errors and invalid IDs cannot leak", async (t) => {
  let requests = 0;
  const run = await fixture(t, (req, res) => {
    requests++; assert.equal(req.method, "GET");
    if (requests === 1) res.end(JSON.stringify({ requestId: id, status: "control_status_unknown", inputStatusUnknown: true, extra: "PRIVATE" }));
    else if (requests === 2) { res.statusCode = 500; res.end(JSON.stringify({ message: "PRIVATE_BACKEND_ERROR" })); }
    else res.end(JSON.stringify({ requestId: "PRIVATE_FAKE_ID", status: "completed" }));
  });
  assert.deepEqual(JSON.parse((await run("status", "--request", id)).stdout), { requestId: id, status: "control_status_unknown", inputStatusUnknown: true });
  for (let n = 0; n < 2; n++) await assert.rejects(run("status", "--request", id), (error) => !error.stderr.includes("PRIVATE"));
  await assert.rejects(run("status", "--request", "../wrong"));
  await assert.rejects(run("request", "--value", "DO_NOT_ACCEPT_SECRETS"));
  assert.equal(requests, 3);
});

test("explicit replace and cancel carry only the current context and fixed panel metadata", async (t) => {
  const bodies = [];
  const run = await fixture(t, (req, res, body) => {
    assert.equal(req.method, "POST"); bodies.push(body);
    assert.equal(req.url, bodies.length === 1 ? "/browser-control/requests" : `/browser-control/requests/${id}/cancel`);
    res.end(JSON.stringify({ requestId: body.requestId, status: bodies.length === 1 ? "pending" : "cancelled", inputStatusUnknown: true, extra: "PRIVATE" }));
  });
  const replaced = await run("replace", "--context", "ctx_current", "--cdp-url", "ws://127.0.0.1:9222/devtools/page/TAB", "--origin", "https://example.com", "--label", "Login");
  assert.equal(bodies[0].replace, true);
  assert.deepEqual(Object.keys(bodies[0]).sort(), ["context", "replace", "requestId", "target"]);
  const cancelled = await run("cancel", "--context", "ctx_current", "--request", id);
  assert.deepEqual(bodies[1], { requestId: id, context: "ctx_current" });
  assert.deepEqual(JSON.parse(cancelled.stdout), { requestId: id, status: "cancelled", inputStatusUnknown: true });
  assert.equal((replaced.stdout + cancelled.stdout).includes("PRIVATE"), false);
  for (const args of [["cancel", "--request", id], ["cancel", "--context", "ctx_current", "--request", "../wrong"],
    ["cancel", "--context", "ctx_current", "--request", id, "--value", "PRIVATE"], ["replace", "--context", "ctx_current"]]) await assert.rejects(run(...args));
  assert.equal(bodies.length, 2);
});


test("CLI uses origin-filtered discovery and resolves browser endpoints locally without printing capabilities", async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp("/tmp/bitty-control-discovery-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await new Promise((r) => server.once("listening", r));
  t.after(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  let connections = 0, body;
  server.on("connection", (socket) => {
    connections++; socket.once("message", (raw) => {
      assert.equal(JSON.parse(String(raw)).method, "Target.getTargets");
      socket.send(JSON.stringify({ id: 1, result: { targetInfos: [{ type: "page", targetId: "PAGE", url: "https://example.com/private?SECRET", title: "SECRET" }] } }));
    });
  });
  await fs.writeFile(path.join(directory, "DevToolsActivePort"), `${server.address().port}\n/devtools/browser/PRIVATE_CAPABILITY\n`);
  const run = await fixture(t, (req, res, input) => { body = input; res.end(JSON.stringify({ requestId: input.requestId, status: "pending" })); });
  const found = await run("discover", "--user-data-dir", directory, "--origin", "https://example.com");
  assert.deepEqual(JSON.parse(found.stdout), { targets: [{ targetId: "PAGE", origin: "https://example.com" }] });
  const result = await run("request", "--context", "ctx_current", "--user-data-dir", directory, "--target-id", "PAGE", "--origin", "https://example.com", "--label", "Control");
  assert.equal(body.target.targetId, "PAGE"); assert.equal(body.target.cdpUrl, `ws://127.0.0.1:${server.address().port}/devtools/browser/PRIVATE_CAPABILITY`);
  assert.equal(connections, 1); assert.equal((found.stdout + result.stdout).includes("PRIVATE"), false); assert.equal(found.stdout.includes("SECRET"), false);
  await assert.rejects(run("discover", "--user-data-dir", path.join(directory, "missing"), "--origin", "https://example.com"), (error) => error.stderr.includes("chrome_debugging_not_enabled") && !error.stderr.includes(directory));
  for (const args of [["--user-data-dir", directory], ["--user-data-dir", directory, "--target-id", "PAGE", "--cdp-url", "ws://127.0.0.1:9222/devtools/page/P"]]) await assert.rejects(run("request", "--context", "ctx_current", "--origin", "https://example.com", "--label", "Control", ...args));
});
