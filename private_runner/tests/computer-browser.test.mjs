import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Exercise the real dispatch without opening a port or touching the user's stores.
const runnerRoot = fileURLToPath(new URL("..", import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "computer-browser-"));
await fs.cp(path.join(runnerRoot, "src"), path.join(temp, "private_runner/src"), { recursive: true });
await fs.symlink(path.join(runnerRoot, "node_modules"), path.join(temp, "private_runner/node_modules"));
const originalCwd = process.cwd();
process.chdir(temp);
Object.assign(process.env, { RUNNER_SKIP_SERVER_START: "1", RUNNER_MOCK: "1", RUNNER_TOKEN: "synthetic-token",
  RUNNER_LOG_REQUESTS: "0", DIRECTORY_EXPLORER_MAX_ENTRIES: "2", CODEX_WS_DEBUG_FILE: path.join(temp, "ws-debug.jsonl"),
  CODEX_AUTH_STORE_DIR: path.join(temp, "auth"), ACP_SESSION_STORE_PATH: path.join(temp, "agent-sessions.json") });
const { __TESTING__ } = await import(pathToFileURL(path.join(temp, "private_runner/src/server-runtime.mjs")));
test.after(async () => { process.chdir(originalCwd); await fs.rm(temp, { recursive: true, force: true }); });

async function request(url, { token = "synthetic-token", method = "GET" } = {}) {
  let status, payload;
  await __TESTING__.handleRunnerRequest({ method, url,
    headers: { host: "127.0.0.1", authorization: `Bearer ${token}` }, socket: { remoteAddress: "synthetic" } }, {
    writeHead(code) { status = code; }, end(body) { payload = body ? JSON.parse(body.toString()) : null; },
  });
  return { status, payload };
}

test("computer information requires authentication and has only a read endpoint", async () => {
  assert.equal((await request("/computer", { token: "wrong" })).status, 401);
  const { status, payload } = await request("/computer");
  assert.equal(status, 200);
  assert.equal(payload.hostname, os.hostname());
  assert.equal(payload.homePath, os.homedir());
  assert.equal(payload.architecture, os.arch());
  assert.equal(payload.totalMemory, os.totalmem());
  assert.equal((await request("/computer", { method: "DELETE" })).status, 404);
});

test("computer list provides modification dates and preserves literal paths while legacy lists keep scan filtering", async () => {
  const directory = path.join(temp, "list ");
  await fs.mkdir(directory);
  await fs.mkdir(path.join(directory, "node_modules"));
  await fs.writeFile(path.join(directory, "report .txt "), "fixture");
  const date = new Date("2026-10-30T12:34:00.000Z");
  await fs.utimes(path.join(directory, "report .txt "), date, date);
  await fs.writeFile(path.join(directory, ".hidden"), "hidden");
  const url = `/directories?${new URLSearchParams({ path: directory, view: "computer" })}`;
  assert.equal((await request(url, { token: "wrong" })).status, 401);
  const { status, payload } = await request(url);
  assert.equal(status, 200);
  assert.equal(payload.basePath, await fs.realpath(directory));
  assert.equal(payload.parentPath, await fs.realpath(temp));
  assert.deepEqual(payload.entries.map((entry) => entry.name), ["node_modules", "report .txt "]);
  assert.equal(payload.entries[1].path, path.join(await fs.realpath(directory), "report .txt "));
  assert.equal(payload.entries[1].modifiedAt, date.toISOString());
  const ordinary = path.join(temp, "ordinary");
  await fs.mkdir(ordinary);
  await fs.mkdir(path.join(ordinary, "node_modules"));
  assert.equal((await __TESTING__.listLlmDirectories(ordinary)).entries.length, 0);
  assert.equal((await __TESTING__.listLlmDirectories(ordinary, false, true)).entries.length, 1);
});

test("computer list includes readable symlinks, reports truncated lists, and preserves directory errors", async () => {
  const directory = path.join(temp, "links");
  await fs.mkdir(directory);
  await fs.symlink(temp, path.join(directory, "folder-link"));
  await fs.writeFile(path.join(directory, "a.txt"), "a");
  await fs.symlink(path.join(directory, "a.txt"), path.join(directory, "b-link"));
  await fs.symlink(path.join(directory, "missing"), path.join(directory, "broken-link"));
  await fs.writeFile(path.join(directory, "c.txt"), "c");
  const result = await __TESTING__.listLlmDirectories(directory, false, true);
  assert.equal(result.entries.find((entry) => entry.name === "folder-link").kind, "dir");
  assert.equal(result.entries.find((entry) => entry.name === "b-link").kind, "file");
  assert.equal(result.entries.some((entry) => entry.name === "broken-link"), false);
  assert.equal(result.truncated, true);
  assert.equal(result.files.length, 2);
  const legacy = await __TESTING__.listLlmDirectories(directory);
  assert.equal(legacy.entries.some((entry) => entry.name.endsWith("-link")), false);
  const missing = `/directories?${new URLSearchParams({ path: path.join(temp, "missing"), view: "computer" })}`;
  assert.equal((await request(missing)).status, 404);
  const root = await __TESTING__.listLlmDirectories(path.parse(temp).root, false, true);
  assert.equal(root.parentPath, "");
});

test("one unavailable modification date does not hide the other files", async () => {
  const directory = path.join(temp, "metadata");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "unavailable.txt"), "fixture");
  await fs.writeFile(path.join(directory, "readable.txt"), "fixture");
  const originalStat = fs.stat;
  fs.stat = async (target, ...args) => {
    if (path.basename(target) === "unavailable.txt") throw new Error("metadata unavailable");
    return originalStat(target, ...args);
  };
  try {
    const result = await __TESTING__.listLlmDirectories(directory, false, true);
    assert.equal(result.entries.find((entry) => entry.name === "unavailable.txt").modifiedAt, null);
    assert.ok(result.entries.find((entry) => entry.name === "readable.txt").modifiedAt);
  } finally { fs.stat = originalStat; }
});
