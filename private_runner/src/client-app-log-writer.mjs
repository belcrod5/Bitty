import { promises as fs } from "node:fs";
import path from "node:path";

export const CLIENT_APP_LOG_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CLIENT_APP_LOG_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

// Only client_auto_logs uses this writer; the queue also serializes rotation and pruning.
export function createClientAppLogWriter({ directory, stamp, maxFiles: configuredMaxFiles = 10 }) {
  const count = Number(configuredMaxFiles);
  const maxFiles = Number.isFinite(count) && count >= 1 ? Math.floor(count) : 10;
  let sequence = 0;
  let currentPath = path.join(directory, `${stamp}.jsonl`);
  let initialized = false;
  let queue = Promise.resolve();

  async function prune(reservedBytes = 0, creating = false) {
    const files = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(directory, entry.name);
      const stat = await fs.stat(filePath);
      files.push({ filePath, size: stat.size, mtime: stat.mtimeMs });
    }
    files.sort((a, b) => a.mtime - b.mtime || a.filePath.localeCompare(b.filePath));
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let fileCount = files.length;
    for (const file of files) {
      if (file.filePath === currentPath && !creating) continue;
      if (file.size <= CLIENT_APP_LOG_MAX_FILE_BYTES && fileCount + Number(creating) <= maxFiles
        && totalBytes + reservedBytes <= CLIENT_APP_LOG_MAX_TOTAL_BYTES) continue;
      await fs.unlink(file.filePath);
      totalBytes -= file.size;
      fileCount -= 1;
    }
  }

  async function initialize() {
    if (initialized) return;
    await fs.mkdir(directory, { recursive: true });
    while (await fs.stat(currentPath).then(() => true, (error) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    })) currentPath = path.join(directory, `${stamp}_${++sequence}.jsonl`);
    await prune();
    initialized = true;
  }

  async function appendChunk(chunk) {
    const bytes = Buffer.byteLength(chunk);
    let size = await fs.stat(currentPath).then((stat) => stat.size, (error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (size !== null && size + bytes > CLIENT_APP_LOG_MAX_FILE_BYTES) {
      do { currentPath = path.join(directory, `${stamp}_${++sequence}.jsonl`); }
      while (await fs.stat(currentPath).then(() => true, (error) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      }));
      size = null;
    }
    await prune(bytes, size === null);
    await fs.appendFile(currentPath, chunk, "utf8");
  }

  function enqueue(action) {
    const result = queue.then(action);
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    get path() { return currentPath; },
    maxFiles,
    initialize: () => enqueue(initialize),
    append: (lines) => enqueue(async () => {
      await initialize();
      let chunk = "";
      let chunkBytes = 0;
      let droppedLines = 0;
      for (const line of lines) {
        const next = `${line}\n`;
        const bytes = Buffer.byteLength(next);
        if (bytes > CLIENT_APP_LOG_MAX_FILE_BYTES) { droppedLines += 1; continue; }
        if (chunkBytes + bytes > CLIENT_APP_LOG_MAX_FILE_BYTES) {
          await appendChunk(chunk);
          chunk = "";
          chunkBytes = 0;
        }
        chunk += next;
        chunkBytes += bytes;
      }
      if (chunk) await appendChunk(chunk);
      return { droppedLines };
    }),
  };
}
