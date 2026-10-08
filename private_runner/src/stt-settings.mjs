import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const PROVIDERS = new Set(["google", "macos"]);
const DEFAULT_CORRECTION = { model: "gpt-6-luna", effort: "low" };

export function createSttSettingsService({ filePath, fileSystem = fs }) {
  let settings;
  let loadPromise;
  let writeQueue = Promise.resolve();

  const get = () => {
    if (settings) return Promise.resolve(settings);
    loadPromise ??= (async () => {
      try {
        const saved = JSON.parse(await fileSystem.readFile(filePath, "utf8"));
        if (!PROVIDERS.has(saved?.provider)) throw new Error("Invalid STT settings file");
        settings = { provider: saved.provider,
          correction: validCorrection(saved.correction) ? saved.correction : DEFAULT_CORRECTION };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        settings = { provider: "google", correction: DEFAULT_CORRECTION };
      }
      return settings;
    })();
    return loadPromise;
  };

  return {
    async get() {
      await writeQueue;
      return (await get()).provider;
    },
    async getCorrection() {
      await writeQueue;
      return (await get()).correction;
    },
    async set(next) {
      if (!PROVIDERS.has(next)) throw new Error("sttProvider is invalid");
      const update = writeQueue.then(async () => {
        const current = await get();
        if (current.provider === next) return next;
        await persist({ ...current, provider: next });
        return next;
      });
      writeQueue = update.catch(() => {});
      return update;
    },
    async setCorrection(next) {
      if (!validCorrection(next)) throw new Error("sttCorrection is invalid");
      const update = writeQueue.then(async () => {
        const current = await get();
        if (current.correction.model === next.model && current.correction.effort === next.effort) return next;
        await persist({ ...current, correction: next });
        return next;
      });
      writeQueue = update.catch(() => {});
      return update;
    },
  };

  async function persist(next) {
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fileSystem.writeFile(temp, `${JSON.stringify(next)}\n`, { flag: "wx", mode: 0o600 });
      await fileSystem.rename(temp, filePath);
      settings = next;
    } finally {
      await fileSystem.unlink(temp).catch(() => {});
    }
  }
}

function validCorrection(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/.test(value.model)
    && typeof value.effort === "string" && /^[a-z]{2,10}$/.test(value.effort);
}

export function createSttSettingsHttpHandler({ service, listModels, runnerToken, parseAuthToken, readJsonBody, json }) {
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
        json(res, 200, { provider: await service.get(), correction: await service.getCorrection() });
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
      } else if (req.method === "PATCH") {
        const body = await readJsonBody(req, 16 * 1024);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).length !== 1 || !validCorrection(body.correction)) {
          json(res, 400, { error: "stt_correction_invalid" });
        } else {
          const models = await listModels();
          if (!models.some((model) => model.modelId === body.correction.model
            && model.effortOptions.includes(body.correction.effort))) {
            json(res, 400, { error: "stt_correction_invalid" });
          } else json(res, 200, { correction: await service.setCorrection(body.correction) });
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
