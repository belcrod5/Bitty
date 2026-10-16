import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClientAppLogWriter, CLIENT_APP_LOG_MAX_FILE_BYTES as LIMIT,
  CLIENT_APP_LOG_MAX_TOTAL_BYTES as TOTAL } from "../src/client-app-log-writer.mjs";

async function withDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-client-log-"));
  try { await run(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
async function sizes(directory) {
  return Promise.all((await fs.readdir(directory)).filter((name) => name.endsWith(".jsonl"))
    .map(async (name) => ({ name, size: (await fs.stat(path.join(directory, name))).size })));
}
const lineOfBytes = (bytes) => JSON.stringify({ value: "x".repeat(bytes - 13) });

test("retains previous startup logs and serializes concurrent append/rotation by UTF-8 bytes", () => withDirectory(async (directory) => {
  const oldPath = path.join(directory, "old.jsonl");
  await fs.writeFile(oldPath, '{"old":true}\n');
  const writer = createClientAppLogWriter({ directory, stamp: "new", maxFiles: 10 });
  const first = JSON.stringify({ value: "あ".repeat(Math.floor(LIMIT / 6)) });
  await Promise.all([writer.initialize(), writer.append([first]), writer.append([first]), writer.append(['{"last":true}'])]);
  assert.equal(await fs.readFile(oldPath, "utf8"), '{"old":true}\n');
  const files = await sizes(directory);
  assert.equal(files.length, 3);
  assert.ok(files.every((file) => file.size <= LIMIT));
  const rows = [];
  for (const filePath of [path.join(directory, "new.jsonl"), writer.path]) {
    rows.push(...(await fs.readFile(filePath, "utf8")).trim().split("\n").map(JSON.parse));
  }
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1).last, true);
}));

test("splits an oversized batch on complete JSONL lines, drops only oversized individual lines", () => withDirectory(async (directory) => {
  const writer = createClientAppLogWriter({ directory, stamp: "batch" });
  const line = lineOfBytes(LIMIT / 2 + 100);
  assert.deepEqual(await writer.append([line, "x".repeat(LIMIT), line, '{"tail":true}']), { droppedLines: 1 });
  const files = await sizes(directory);
  assert.equal(files.length, 2);
  assert.ok(files.every((file) => file.size <= LIMIT));
  for (const file of files) for (const row of (await fs.readFile(path.join(directory, file.name), "utf8")).trim().split("\n")) JSON.parse(row);
}));

test("maxFiles=1 removes the previous active file on rotation and recovers after active deletion", () => withDirectory(async (directory) => {
  const writer = createClientAppLogWriter({ directory, stamp: "one", maxFiles: 1 });
  await writer.append([lineOfBytes(LIMIT - 1)]);
  await writer.append(['{"after":true}']);
  assert.equal((await sizes(directory)).length, 1);
  assert.match(await fs.readFile(writer.path, "utf8"), /after/);
  await fs.unlink(writer.path);
  await writer.append(['{"recreated":true}']);
  assert.equal((await sizes(directory)).length, 1);
  assert.match(await fs.readFile(writer.path, "utf8"), /recreated/);
}));

test("initialization prunes preexisting large files and caps total bytes even with a large file count setting", () => withDirectory(async (directory) => {
  for (let index = 0; index < 12; index++) {
    const handle = await fs.open(path.join(directory, `old_${index}.jsonl`), "w");
    await handle.truncate(index === 0 ? LIMIT + 1 : LIMIT);
    await handle.close();
  }
  await fs.writeFile(path.join(directory, "keep.txt"), "untouched");
  const writer = createClientAppLogWriter({ directory, stamp: "next", maxFiles: 1000 });
  await writer.initialize();
  assert.ok((await sizes(directory)).reduce((sum, file) => sum + file.size, 0) <= TOTAL);
  assert.ok((await sizes(directory)).every((file) => file.size <= LIMIT));
  await writer.append([lineOfBytes(LIMIT - 1)]);
  assert.ok((await sizes(directory)).reduce((sum, file) => sum + file.size, 0) <= TOTAL);
  assert.equal(await fs.readFile(path.join(directory, "keep.txt"), "utf8"), "untouched");
}));

test("invalid maxFiles values stay bounded and restart timestamp collisions never overwrite history", () => withDirectory(async (directory) => {
  for (const maxFiles of [NaN, Infinity, -Infinity, "invalid", 0, -1]) {
    assert.equal(createClientAppLogWriter({ directory, stamp: "unused", maxFiles }).maxFiles, 10);
  }
  const first = createClientAppLogWriter({ directory, stamp: "same", maxFiles: 2 });
  await first.append(['{"first":true}']);
  const second = createClientAppLogWriter({ directory, stamp: "same", maxFiles: 2 });
  await second.append(['{"second":true}']);
  assert.notEqual(first.path, second.path);
  assert.match(await fs.readFile(first.path, "utf8"), /first/);
  assert.equal((await sizes(directory)).length, 2);
}));

test("failed appends do not poison the serialized queue", () => withDirectory(async (directory) => {
  const writer = createClientAppLogWriter({ directory, stamp: "retry" });
  await writer.initialize();
  await fs.mkdir(writer.path);
  await assert.rejects(writer.append(['{"failed":true}']));
  await fs.rmdir(writer.path);
  await writer.append(['{"ok":true}']);
  assert.equal(await fs.readFile(writer.path, "utf8"), '{"ok":true}\n');
}));

test("long-running appends remain within count and total limits over repeated rotations", () => withDirectory(async (directory) => {
  for (const maxFiles of [10, 100]) {
    const destination = path.join(directory, String(maxFiles));
    const writer = createClientAppLogWriter({ directory: destination, stamp: "continuous", maxFiles });
    const line = lineOfBytes(LIMIT - 1);
    for (let index = 0; index < 12; index++) {
      await writer.append([line]);
      const files = await sizes(destination);
      assert.ok(files.length <= maxFiles);
      assert.ok(files.every((file) => file.size <= LIMIT));
      assert.ok(files.reduce((sum, file) => sum + file.size, 0) <= TOTAL);
    }
    assert.equal((await sizes(destination)).length, 10);
    assert.equal((await sizes(destination)).some((file) => file.name === "continuous.jsonl"), false);
  }
}));
