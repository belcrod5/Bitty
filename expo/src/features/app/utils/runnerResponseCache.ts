import { runnerResponseCacheKey } from "../../runnerWs/runnerConnectionIdentity";
import * as FileSystem from "expo-file-system/legacy";

type Resource = "client-state" | "voice-orchestrators";
let io: Promise<unknown> = Promise.resolve();

// Two conditional response owners share atomic disk IO, never cache policy.
// One slot per resource bounds storage even when Runner credentials change.
export function readRunnerResponseCache(resource: Resource, key: string | null): Promise<{ etag: string; body: unknown } | null> {
  const task = io.then(async () => {
    if (!key || !FileSystem.cacheDirectory) return null;
    try {
      const value = JSON.parse(await FileSystem.readAsStringAsync(`${FileSystem.cacheDirectory}runner-${resource}.json`));
      if (value.version !== 1 || value.key !== key || typeof value.etag !== "string" || !value.etag) return null;
      if (value.checksum !== await runnerResponseCacheKey(JSON.stringify([value.etag, value.body]))) return null;
      return { etag: value.etag, body: value.body };
    } catch { return null; }
  });
  io = task.catch(() => {});
  return task;
}

export function writeRunnerResponseCache(resource: Resource, key: Promise<string | null> | string, value: { etag: string; body: unknown } | null): Promise<void> {
  // Serialize now so subsequent in-memory changes cannot alter this response.
  const serialized = value ? JSON.stringify([value.etag, value.body]) : null;
  const task = io.then(async () => {
    const resolvedKey = await key;
    if (!resolvedKey || !FileSystem.cacheDirectory) return;
    const path = `${FileSystem.cacheDirectory}runner-${resource}.json`;
    if (!value) {
      await FileSystem.deleteAsync(path, { idempotent: true });
      return;
    }
    const [etag, body] = JSON.parse(serialized!);
    const checksum = await runnerResponseCacheKey(serialized!);
    if (!checksum) return;
    await FileSystem.writeAsStringAsync(`${path}.pending`, JSON.stringify({ version: 1, key: resolvedKey,
      etag, body, checksum }));
    await FileSystem.moveAsync({ from: `${path}.pending`, to: path });
  }).catch(() => {}); // A disposable cache must never prevent synchronization.
  io = task;
  return task;
}
