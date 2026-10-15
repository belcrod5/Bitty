import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { openLlmSessionRollout, readLlmSessionRolloutLines } from "../src/llm-session-rollout-file.mjs";

test("archive metadata stops before the body and bounds an unterminated line", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-rollout-stream-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl.zst");
  const head = '{"type":"session_meta"}\n';
  // A corrupt tail would reject full expansion; metadata must never reach it.
  await fs.writeFile(file, Buffer.concat([
    zstdCompressSync(Buffer.concat([Buffer.from(head), randomBytes(1024 * 1024)])), Buffer.from("invalid-frame"),
  ]));
  for await (const line of readLlmSessionRolloutLines(file, 512 * 1024)) {
    assert.equal(line, head.trim());
    break;
  }
  await fs.writeFile(file, Buffer.concat([
    zstdCompressSync(randomBytes(1024 * 1024).toString("hex")), Buffer.from("invalid-frame"),
  ]));
  const lines = [];
  for await (const line of readLlmSessionRolloutLines(file, 512 * 1024)) lines.push(line);
  assert.deepEqual(lines, []);
});

test("archive handles preserve source times and delete private expanded data on close and failure", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-rollout-handle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl.zst");
  await fs.writeFile(file, zstdCompressSync(Buffer.from("data\n")));
  await fs.utimes(file, new Date(1000), new Date(1000));
  const handle = await openLlmSessionRollout(file);
  const expandedPath = handle.path;
  const stat = await handle.stat();
  assert.equal(stat.size, 5);
  assert.equal(stat.mtimeMs, 1000);
  assert.equal((await fs.stat(path.dirname(expandedPath))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(expandedPath)).mode & 0o777, 0o600);
  await handle.close();
  await assert.rejects(fs.stat(expandedPath), { code: "ENOENT" });
  const mkdtemp = fs.mkdtemp;
  let failedTemporaryDirectory;
  fs.mkdtemp = async (...args) => {
    failedTemporaryDirectory = await mkdtemp(...args);
    return failedTemporaryDirectory;
  };
  try {
    await fs.writeFile(file, "invalid-frame");
    await assert.rejects(openLlmSessionRollout(file));
    await assert.rejects(fs.stat(failedTemporaryDirectory), { code: "ENOENT" });
  } finally { fs.mkdtemp = mkdtemp; }
});
