import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const PROVIDERS = new Set(["google", "macos"]);

export function createSttSettingsService({ filePath, fileSystem = fs }) {
  let provider;
  let loadPromise;
  let writeQueue = Promise.resolve();

  const get = () => {
    if (provider) return Promise.resolve(provider);
    loadPromise ??= (async () => {
      try {
        const saved = JSON.parse(await fileSystem.readFile(filePath, "utf8"));
        if (!PROVIDERS.has(saved?.provider)) throw new Error("Invalid STT settings file");
        provider = saved.provider;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        provider = "google";
      }
      return provider;
    })();
    return loadPromise;
  };

  return {
    async get() {
      await writeQueue;
      return get();
    },
    async set(next) {
      if (!PROVIDERS.has(next)) throw new Error("sttProvider is invalid");
      const update = writeQueue.then(async () => {
        if (await get() === next) return next;
        await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
        const temp = `${filePath}.${randomUUID()}.tmp`;
        try {
          await fileSystem.writeFile(temp, `${JSON.stringify({ provider: next })}\n`, { flag: "wx", mode: 0o600 });
          await fileSystem.rename(temp, filePath);
          provider = next;
          return provider;
        } finally {
          await fileSystem.unlink(temp).catch(() => {});
        }
      });
      writeQueue = update.catch(() => {});
      return update;
    },
  };
}

export function createSttSettingsHttpHandler({ service, runnerToken, parseAuthToken, readJsonBody, json }) {
  return async (req, res, pathname) => {
    if (pathname !== "/stt/settings") return false;
    if (!runnerToken) {
      json(res, 500, { error: "runner_token_missing", message: "RUNNER_TOKEN is required" });
      return true;
    }
    if (parseAuthToken(req) !== runnerToken) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    try {
      if (req.method === "GET") {
        json(res, 200, { provider: await service.get() });
      } else if (req.method === "PUT") {
        const body = await readJsonBody(req, 16 * 1024);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).length !== 1 || typeof body.provider !== "string") {
          json(res, 400, { error: "stt_provider_invalid", message: "sttProvider is invalid" });
        } else {
          try {
            json(res, 200, { provider: await service.set(body.provider) });
          } catch (error) {
            if (error?.message !== "sttProvider is invalid") throw error;
            json(res, 400, { error: "stt_provider_invalid", message: error.message });
          }
        }
      } else {
        json(res, 404, { error: "not_found" });
      }
    } catch {
      json(res, 500, { error: "stt_settings_failed", message: "Speech settings could not be saved or read" });
    }
    return true;
  };
}
