import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createZstdDecompress } from "node:zlib";

async function rolloutStream(filePath, fileSystem = fs) {
  const source = (await fileSystem.open(filePath, "r")).createReadStream();
  if (!filePath.endsWith(".jsonl.zst")) return source;
  const expanded = source.pipe(createZstdDecompress());
  source.on("error", (error) => expanded.destroy(error));
  expanded.on("close", () => source.destroy());
  return expanded;
}

// Metadata scans stop at the first matching line without expanding an archive.
export async function* readLlmSessionRolloutLines(filePath, maxBytes, fileSystem = fs) {
  const input = await rolloutStream(filePath, fileSystem);
  const decoder = new StringDecoder("utf8");
  let bytesRead = 0;
  let carry = "";
  try {
    for await (const chunk of input) {
      const bounded = chunk.subarray(0, maxBytes - bytesRead);
      bytesRead += bounded.length;
      carry += decoder.write(bounded);
      let newline;
      while ((newline = carry.indexOf("\n")) >= 0) {
        yield carry.slice(0, newline).replace(/\r$/, "");
        carry = carry.slice(newline + 1);
      }
      if (bytesRead >= maxBytes) return;
    }
    carry += decoder.end();
    if (carry) yield carry;
  } finally {
    input.destroy();
  }
}

// Rollout parsers use byte offsets. Materialize compressed input on disk rather
// than retaining an entire conversation in memory; the source stays read-only.
export async function openLlmSessionRollout(filePath) {
  if (!filePath.endsWith(".jsonl.zst")) return fs.open(filePath, "r");
  const sourceStat = await fs.stat(filePath);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-rollout-"));
  const expandedPath = path.join(temporaryDirectory, "rollout.jsonl");
  let handle;
  try {
    await pipeline(await rolloutStream(filePath), createWriteStream(expandedPath, { mode: 0o600 }));
    handle = await fs.open(expandedPath, "r");
    return {
      path: expandedPath,
      read: handle.read.bind(handle),
      async stat() {
        // Cursors identify the source, not a different temporary inode per read.
        return Object.assign({}, sourceStat, { size: (await handle.stat()).size });
      },
      async close() {
        try { await handle.close(); }
        finally { await fs.rm(temporaryDirectory, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

// Keep one expansion alive for a compound read (summary or history + metadata).
export async function withLlmSessionRollout(filePath, read) {
  if (!filePath.endsWith(".jsonl.zst")) return read(filePath);
  const handle = await openLlmSessionRollout(filePath);
  try { return await read(handle.path, await handle.stat()); }
  finally { await handle.close(); }
}
