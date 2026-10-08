import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSttSettingsService, createSttSettingsHttpHandler } from "../src/stt-settings.mjs";

test("provider selection persists independently of Google credentials", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-stt-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "stt-settings.json");
  const service = createSttSettingsService({ filePath });
  assert.equal(await service.get(), "google");
  assert.deepEqual(await service.getCorrection(), { model: "gpt-6-luna", effort: "low" });
  await service.set("macos");
  await service.setCorrection({ model: "gpt-6-astra", effort: "high" });
  assert.equal(await createSttSettingsService({ filePath }).get(), "macos");
  assert.deepEqual(await createSttSettingsService({ filePath }).getCorrection(),
    { model: "gpt-6-astra", effort: "high" });
  await assert.rejects(service.set("unknown"), /sttProvider is invalid/);
  assert.equal(await service.get(), "macos");
});

test("authenticated STT settings endpoint validates the provider", async () => {
  let provider = "google";
  const replies = [];
  const handler = createSttSettingsHttpHandler({
    service: { get: async () => provider, getCorrection: async () => ({ model: "gpt-6-luna", effort: "low" }),
      setCorrection: async (next) => next, set: async (next) => {
      if (next !== "google" && next !== "macos") throw new Error("sttProvider is invalid");
      provider = next;
      return provider;
    } },
    listModels: async () => [{ modelId: "gpt-6-luna", effortOptions: ["low"] }],
    runnerToken: "token",
    parseAuthToken: (req) => req.token,
    readJsonBody: async (req) => req.body,
    json: (_res, status, payload) => replies.push({ status, payload }),
  });
  const request = async (method, body, token = "token") => {
    await handler({ method, body, token }, {}, "/stt/settings");
    return replies.pop();
  };
  assert.deepEqual(await request("GET", undefined, "wrong"), { status: 401, payload: { error: "unauthorized" } });
  assert.deepEqual(await request("GET"), { status: 200, payload: { provider: "google",
    correction: { model: "gpt-6-luna", effort: "low" } } });
  assert.deepEqual(await request("PUT", { provider: "macos" }), { status: 200, payload: { provider: "macos" } });
  assert.deepEqual(await request("PATCH", { correction: { model: "gpt-6-luna", effort: "low" } }),
    { status: 200, payload: { correction: { model: "gpt-6-luna", effort: "low" } } });
  assert.deepEqual(await request("PATCH", { correction: { model: "other", effort: "low" } }),
    { status: 400, payload: { error: "stt_correction_invalid" } });
  assert.deepEqual(await request("PUT", { provider: "other" }), {
    status: 400, payload: { error: "stt_provider_invalid", message: "sttProvider is invalid" },
  });
  assert.equal(provider, "macos");
});
