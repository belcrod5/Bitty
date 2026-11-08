import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import * as OTPAuth from "otpauth";
import { createRunnerLoginService } from "../src/runner-login-service.mjs";

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
let clock = Date.parse("2026-11-08T00:00:00Z");
const messages = [], binding = "x".repeat(43);
const login = createRunnerLoginService({ directory: path.join(temp, "login"), legacyToken: "synthetic-token",
  keyProvider: async () => Buffer.alloc(32, 42), now: () => clock,
  sendMail: async (message) => { messages.push(message); } });
await login.initialize();
const start = async (method) => {
  const challenge = await login[method]({ email: "owner@example.test", clientBinding: binding });
  const deadline = Date.now() + 5000;
  while (true) {
    const state = JSON.parse(await fs.readFile(path.join(temp, "login/state.json"), "utf8"));
    if (state.challenges.some((item) => item.id === challenge.challengeId && item.delivered)) break;
    assert.ok(Date.now() < deadline, "isolated login email delivery timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { ...challenge, clientBinding: binding,
    emailCode: messages.find((message) => message.id === challenge.challengeId).text.match(/\d{8}/)[0] };
};
const prepared = await login.prepareSetup(await start("startSetup"));
const otp = () => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(prepared.secret) }).generate({ timestamp: clock });
await login.completeSetup({ setupId: prepared.setupId, clientBinding: binding, totpCode: otp() });
clock += 61000;
const session = await login.completeLogin({ ...await start("startLogin"), totpCode: otp() });
const handler = __TESTING__.createAuthenticatedHandler(login);
test.after(async () => { await login.close(); process.chdir(originalCwd); await fs.rm(temp, { recursive: true, force: true }); });

async function request(url, { token = session.token, method = "GET", body } = {}) {
  let status, headers;
  const chunks = [];
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  Object.assign(req, { method, url,
    headers: { host: "127.0.0.1", authorization: `Bearer ${token}` }, socket: { remoteAddress: "synthetic" } });
  const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  res.req = req;
  res.setHeader = () => {};
  res.writeHead = (code, values) => { status = code; headers = values; };
  await handler(req, res);
  await finished(res);
  const data = Buffer.concat(chunks).toString();
  return { status, payload: headers?.["content-type"]?.includes("application/json") ? JSON.parse(data) : data };
}

test("computer information requires authentication and has only a read endpoint", async () => {
  assert.equal((await request("/computer", { token: "wrong" })).status, 401);
  assert.equal((await request("/computer", { token: "synthetic-token" })).status, 401);
  assert.equal((await request("/directories", { token: "synthetic-token" })).status, 401);
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


test("the real text and media routes preserve selected absolute file identities", async () => {
  const root = path.join(temp, "literal ");
  const otherRoot = path.join(temp, "literal");
  await fs.mkdir(root); await fs.mkdir(otherRoot);
  const file = path.join(root, "memo.md ");
  await fs.writeFile(file, "selected trailing-space file");
  await fs.writeFile(path.join(root, "memo.md"), "unselected trimmed filename");
  await fs.writeFile(path.join(otherRoot, "memo.md"), "unselected trimmed directory");
  const canonicalRoot = await fs.realpath(root);
  const canonicalFile = path.join(canonicalRoot, "memo.md ");
  const textUrl = `/workspace/files?${new URLSearchParams({ path: canonicalFile, rootDir: canonicalRoot })}`;
  const opened = await request(textUrl);
  assert.equal(opened.status, 200);
  assert.equal(opened.payload.content, "selected trailing-space file");
  const saved = await request("/workspace/files", { method: "PUT", body: {
    rootDir: canonicalRoot, path: canonicalFile, content: "saved selected file", expectedVersion: opened.payload.version,
  } });
  assert.equal(saved.status, 200);
  assert.equal(await fs.readFile(file, "utf8"), "saved selected file");
  assert.equal(await fs.readFile(path.join(root, "memo.md"), "utf8"), "unselected trimmed filename");
  assert.equal(await fs.readFile(path.join(otherRoot, "memo.md"), "utf8"), "unselected trimmed directory");

  const imageName = String.raw`photo\copy.png `;
  const image = path.join(canonicalRoot, imageName);
  await fs.writeFile(image, "selected image bytes");
  await fs.writeFile(path.join(canonicalRoot, "photocopy.png"), "unselected image");
  const media = await request(`/files/media?${new URLSearchParams({ path: image, rootDir: canonicalRoot })}`);
  assert.equal(media.status, 200, JSON.stringify(media.payload));
  assert.equal(media.payload, "selected image bytes");
  const missing = await request(`/files/media?${new URLSearchParams({ path: path.join(canonicalRoot, "photocopy.png "), rootDir: canonicalRoot })}`);
  assert.equal(missing.status, 400);
});

test("symlink metadata separates alias copying from canonical opening while existing guards remain", async () => {
  const aliases = path.join(temp, "aliases");
  const targets = path.join(temp, "targets ");
  await fs.mkdir(aliases); await fs.mkdir(targets);
  const target = path.join(targets, "note.md ");
  const alias = path.join(aliases, "Shortcut.md");
  await fs.writeFile(target, "symlink target content");
  await fs.symlink(target, alias);
  const listing = await request(`/directories?${new URLSearchParams({ path: aliases, view: "computer" })}`);
  const entry = listing.payload.entries[0];
  assert.equal(entry.path, path.join(await fs.realpath(aliases), "Shortcut.md"));
  assert.equal(entry.resolvedPath, await fs.realpath(target));
  assert.equal(listing.payload.rootPath, "/");
  const opened = await request(`/workspace/files?${new URLSearchParams({ path: entry.resolvedPath, rootDir: listing.payload.rootPath })}`);
  assert.equal(opened.status, 200);
  assert.equal(opened.payload.content, "symlink target content");
  assert.equal((await request(`/workspace/files?${new URLSearchParams({ path: entry.path, rootDir: "/" })}`)).status, 400);
  assert.equal((await request(`/workspace/files?${new URLSearchParams({ path: entry.resolvedPath, rootDir: await fs.realpath(aliases) })}`)).status, 400);
});
