import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleCloudHttpHandler } from "../src/google-cloud-http.mjs";

const RUNNER_TOKEN = "runner-token";

function fixture() {
  const calls = [];
  let settings = {
    projectId: "valid-project-123", monthlyLimitMinutes: 60,
    sttRegion: "us", sttModel: "chirp_3",
  };
  const responses = [];
  const googleCloudService = {
    status: async () => ({
      status: "connected",
      message: "",
      account: "runner@example.com",
      ...settings,
    }),
    startAuthentication: async (projectId) => { calls.push(["start", projectId]); },
    cancelAuthentication: async () => { calls.push(["cancel"]); },
    disconnect: async () => { calls.push(["disconnect"]); },
    updateSettings: async (next) => {
      calls.push(["settings", next]);
      settings = { ...settings, ...next };
    },
  };
  const usageLedger = {
    get: async (projectId) => {
      calls.push(["usage", projectId]);
      return {
        projectId,
        monthUtc: "2026-09",
        usedSeconds: 12,
        limitSeconds: settings.monthlyLimitMinutes * 60,
        remainingSeconds: settings.monthlyLimitMinutes * 60 - 12,
        resetAt: "2026-10-01T00:00:00.000Z",
      };
    },
  };
  const handler = createGoogleCloudHttpHandler({
    runnerToken: RUNNER_TOKEN,
    parseAuthToken: (req) => req.auth || "",
    readJsonBody: async (req) => req.body || {},
    json: (_res, status, payload) => responses.push({ status, payload }),
    googleCloudService,
    usageLedger,
  });
  const request = async (method, pathname, body, auth = RUNNER_TOKEN) => {
    const handled = await handler({ method, auth, body }, {}, pathname);
    return { handled, response: responses.pop() };
  };
  return { calls, request, googleCloudService };
}

test("Google Cloud HTTP handler accepts only the exact authenticated management endpoints", async () => {
  const f = fixture();
  assert.deepEqual(await f.request("GET", "/health"), { handled: false, response: undefined });
  assert.deepEqual((await f.request("GET", "/google-cloud/status", undefined, "wrong")).response, {
    status: 401,
    payload: { error: "unauthorized" },
  });
  assert.deepEqual((await f.request("GET", "/google-cloud/status/extra")).response, {
    status: 404,
    payload: { error: "not_found" },
  });
  assert.deepEqual((await f.request("POST", "/google-cloud/status")).response, {
    status: 404,
    payload: { error: "not_found" },
  });
});

test("Google Cloud status exposes usage but no ADC or access token", async () => {
  const f = fixture();
  const { response } = await f.request("GET", "/google-cloud/status");
  assert.deepEqual(response, {
    status: 200,
    payload: {
      status: "connected",
      message: "",
      account: "runner@example.com",
      projectId: "valid-project-123",
      sttRegion: "us",
      sttModel: "chirp_3",
      usage: {
        usedSeconds: 12,
        limitSeconds: 3600,
        remainingSeconds: 3588,
        monthUtc: "2026-09",
        resetAt: "2026-10-01T00:00:00.000Z",
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(response), /access.?token|adc|keyFilename/i);
});

test("Google Cloud settings, browser auth, cancellation, and disconnect use their exact methods", async () => {
  const f = fixture();
  assert.equal((await f.request("PUT", "/google-cloud/settings", {
    projectId: "second-project-123",
    monthlyLimitMinutes: 90,
  })).response.status, 200);
  assert.equal((await f.request("POST", "/google-cloud/auth/start")).response.status, 202);
  assert.equal((await f.request("POST", "/google-cloud/auth/cancel")).response.status, 200);
  assert.equal((await f.request("POST", "/google-cloud/auth/disconnect")).response.status, 200);
  assert.deepEqual(f.calls.filter(([name]) => name !== "usage"), [
    ["settings", {
      projectId: "second-project-123", monthlyLimitMinutes: 90,
      sttRegion: undefined, sttModel: undefined,
    }],
    ["start", undefined],
    ["cancel"],
    ["disconnect"],
  ]);
});

test("advanced STT settings use the existing settings endpoint", async () => {
  const f = fixture();
  const { response } = await f.request("PUT", "/google-cloud/settings", {
    sttRegion: "asia-northeast1", sttModel: "short",
  });
  assert.equal(response.status, 200);
  assert.equal(response.payload.sttRegion, "asia-northeast1");
  assert.equal(response.payload.sttModel, "short");
  assert.deepEqual(f.calls.find(([name]) => name === "settings"), ["settings", {
    projectId: undefined, monthlyLimitMinutes: undefined,
    sttRegion: "asia-northeast1", sttModel: "short",
  }]);
});

test("invalid STT selection is reported as a safe settings error", async () => {
  const f = fixture();
  f.googleCloudService.updateSettings = async () => { throw new Error("sttRegion is invalid"); };
  assert.deepEqual((await f.request("PUT", "/google-cloud/settings", { sttRegion: "eu" })).response, {
    status: 400,
    payload: { error: "google_cloud_settings_invalid", message: "sttRegion is invalid" },
  });
});
