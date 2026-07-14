import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

// JSON-file persistence for registered APNs device tokens, keyed by deviceId.
// Mirrors the atomic write pattern used by llm-cli-session-index.mjs (write to a
// temp file, then rename) so a crash mid-write cannot corrupt the store.
export function createPushDeviceStore(storePath) {
  let loadPromise = null;
  let writeQueue = Promise.resolve();
  const byDeviceId = new Map();

  function normalizeRecord(raw) {
    const deviceId = String(raw?.deviceId || "").trim();
    const apnsToken = String(raw?.apnsToken || "").trim();
    if (!deviceId || !apnsToken) return null;
    const env = String(raw?.env || "").trim().toLowerCase() === "production" ? "production" : "sandbox";
    const registeredAt = String(raw?.registeredAt || "").trim() || new Date().toISOString();
    const lastSeenAt = String(raw?.lastSeenAt || "").trim() || registeredAt;
    return { deviceId, apnsToken, env, registeredAt, lastSeenAt };
  }

  async function load() {
    let parsed = null;
    try {
      const raw = await fs.readFile(storePath, "utf8");
      parsed = raw ? JSON.parse(raw) : null;
    } catch (err) {
      if (err && typeof err === "object" && err.code === "ENOENT") {
        parsed = null;
      } else {
        // Corrupted file (bad JSON, unreadable, etc.): reinitialize safely instead of throwing.
        console.warn(`[push-device-store] failed to read ${storePath}, reinitializing: ${errMessage(err)}`);
        parsed = null;
      }
    }
    byDeviceId.clear();
    const entries = Array.isArray(parsed?.devices) ? parsed.devices : [];
    for (const rawEntry of entries) {
      const record = normalizeRecord(rawEntry);
      if (record) byDeviceId.set(record.deviceId, record);
    }
  }

  function errMessage(err) {
    return err instanceof Error ? err.message : String(err);
  }

  async function ensureLoaded() {
    if (!loadPromise) {
      loadPromise = load().catch((err) => {
        loadPromise = null;
        throw err;
      });
    }
    await loadPromise;
  }

  async function persist() {
    const parentDir = path.dirname(storePath);
    await fs.mkdir(parentDir, { recursive: true });
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      devices: Array.from(byDeviceId.values()),
    };
    const tmpPath = `${storePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, storePath);
  }

  function enqueuePersist() {
    const op = writeQueue.then(() => persist());
    writeQueue = op.catch(() => {});
    return op;
  }

  async function upsertDevice({ deviceId, apnsToken, env }) {
    await ensureLoaded();
    const id = String(deviceId || "").trim();
    const existing = byDeviceId.get(id);
    const now = new Date().toISOString();
    const record = normalizeRecord({
      deviceId,
      apnsToken,
      env,
      registeredAt: existing?.registeredAt || now,
      lastSeenAt: now,
    });
    if (!record) {
      throw new Error("push device record requires deviceId and apnsToken");
    }
    byDeviceId.set(record.deviceId, record);
    await enqueuePersist();
    return record;
  }

  async function removeDevice(deviceId) {
    await ensureLoaded();
    const id = String(deviceId || "").trim();
    if (!id || !byDeviceId.has(id)) return false;
    byDeviceId.delete(id);
    await enqueuePersist();
    return true;
  }

  async function listDevices() {
    await ensureLoaded();
    return Array.from(byDeviceId.values());
  }

  return {
    upsertDevice,
    removeDevice,
    listDevices,
  };
}
