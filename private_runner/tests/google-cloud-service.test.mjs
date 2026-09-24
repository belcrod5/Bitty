import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import test from "node:test";
import { createGoogleCloudService } from "../src/google-cloud-service.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

class Child extends EventEmitter {
  kills = [];
  kill(signal) { this.kills.push(signal); }
}

async function fixture(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-google-auth-"));
  const authDir = path.join(root, "auth");
  const calls = [];
  let loginChild = null;
  let failConfigPromotion = Boolean(overrides.failConfigPromotion);
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property !== "rename") return target[property];
      return async (source, destination) => {
        if (failConfigPromotion
          && destination === path.join(authDir, "bitty-google-cloud.json")
          && path.dirname(source) !== authDir) {
          failConfigPromotion = false;
          throw new Error("injected config promotion failure");
        }
        return fs.rename(source, destination);
      };
    },
  });
  const spawn = (command, args, options) => {
    const child = new Child();
    calls.push({ command, args, options, child });
    if (args.includes("login")) loginChild = child;
    else queueMicrotask(async () => {
      if (args.includes("set-quota-project") && overrides.writeQuotaProject !== false) {
        const adcPath = path.join(options.env.CLOUDSDK_CONFIG, "application_default_credentials.json");
        const adc = JSON.parse(await fs.readFile(adcPath, "utf8"));
        adc.quota_project_id = args[3];
        await fs.writeFile(adcPath, JSON.stringify(adc), { mode: 0o600 });
      }
      child.emit("close", 0, null);
    });
    return child;
  };
  const service = createGoogleCloudService({
    authDir,
    initialProjectId: "valid-project-123",
    spawn,
    fileSystem,
    googleAuthFactory: () => ({ getAccessToken: async () => "secret-access-token" }),
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, "Bearer secret-access-token");
      return { ok: true, json: async () => ({ email: "runner@example.com" }) };
    },
    ...overrides,
  });
  return { root, authDir, calls, service, loginChild: () => loginChild };
}

test("authentication uses only dedicated CLOUDSDK_CONFIG, browser login, sanitized account, and explicit ADC", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.service.startAuthentication("valid-project-123");
  const login = f.calls.find((call) => call.args.includes("login"));
  const stagingDir = login.options.env.CLOUDSDK_CONFIG;
  assert.notEqual(stagingDir, f.authDir);
  assert.equal(path.dirname(stagingDir), f.authDir);
  assert.equal(login.options.stdio, "ignore");
  assert.ok(!login.args.includes("--no-launch-browser"));
  assert.match(login.args.find((arg) => arg.startsWith("--scopes=")), /userinfo\.email/);

  await fs.writeFile(path.join(stagingDir, "application_default_credentials.json"), "{}", { mode: 0o600 });
  f.loginChild().emit("close", 0, null);
  let status;
  for (let index = 0; index < 50; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = await f.service.status();
    if (status.status !== "authenticating") break;
  }
  assert.equal(status.status, "connected");
  assert.equal(status.account, "runner@example.com");
  assert.deepEqual(await f.service.credentials(), {
    projectId: "valid-project-123",
    monthlyLimitMinutes: 60,
    sttRegion: "us",
    sttModel: "chirp_3",
    keyFilename: path.join(f.authDir, "application_default_credentials.json"),
  });
  assert.ok(f.calls.every((call) => call.options.env.CLOUDSDK_CONFIG === stagingDir));
  await assert.rejects(fs.stat(stagingDir), { code: "ENOENT" });
});

test("legacy settings default STT selection; updates validate and persist it independently", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.service.initialize();
  const configPath = path.join(f.authDir, "bitty-google-cloud.json");
  await fs.writeFile(configPath, JSON.stringify({
    projectId: "valid-project-123", monthlyLimitMinutes: 60, account: "",
  }), { mode: 0o600 });
  const legacy = createGoogleCloudService({ authDir: f.authDir });
  assert.equal((await legacy.getSettings()).sttRegion, "us");
  assert.equal((await legacy.getSettings()).sttModel, "chirp_3");
  await legacy.updateSettings({ sttRegion: "asia-northeast1", sttModel: "long" });
  await legacy.updateSettings({ monthlyLimitMinutes: 90 });
  const persisted = await createGoogleCloudService({ authDir: f.authDir }).getSettings();
  assert.deepEqual({
    projectId: persisted.projectId,
    monthlyLimitMinutes: persisted.monthlyLimitMinutes,
    sttRegion: persisted.sttRegion,
    sttModel: persisted.sttModel,
  }, {
    projectId: "valid-project-123",
    monthlyLimitMinutes: 90,
    sttRegion: "asia-northeast1",
    sttModel: "long",
  });
  await assert.rejects(legacy.updateSettings({ sttRegion: "eu" }), /sttRegion is invalid/);
  await assert.rejects(legacy.updateSettings({ sttModel: "chirp" }), /sttModel is invalid/);
  assert.equal((await legacy.getSettings()).sttRegion, "asia-northeast1");
  assert.equal((await legacy.getSettings()).sttModel, "long");
  assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).sttModel, "long");
});

test("concurrent general and STT saves retain both changes", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.service.getSettings();
  await Promise.all([
    f.service.updateSettings({ monthlyLimitMinutes: 90 }),
    f.service.updateSettings({ sttRegion: "asia-northeast1", sttModel: "short" }),
  ]);
  const saved = await f.service.getSettings();
  assert.equal(saved.monthlyLimitMinutes, 90);
  assert.equal(saved.sttRegion, "asia-northeast1");
  assert.equal(saved.sttModel, "short");
});

test("authentication cancellation waits for child cleanup", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.service.startAuthentication("valid-project-123");
  let completed = false;
  const cancel = f.service.cancelAuthentication().then(() => { completed = true; });
  await tick();
  assert.equal(completed, false);
  assert.deepEqual(f.loginChild().kills, ["SIGTERM"]);
  f.loginChild().emit("close", null, "SIGTERM");
  await cancel;
  assert.equal((await f.service.status()).status, "idle");
});

test("concurrent authentication starts claim the pending setup before spawning", async (t) => {
  const calls = [];
  let versionChild;
  let loginChild;
  let reachedVersion;
  const versionStarted = new Promise((resolve) => { reachedVersion = resolve; });
  const f = await fixture({
    spawn: (_command, args, options) => {
      const child = new Child();
      calls.push({ args, options, child });
      if (args.includes("--version")) {
        versionChild = child;
        reachedVersion();
      }
      if (args.includes("login")) loginChild = child;
      return child;
    },
  });
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));

  const first = f.service.startAuthentication("valid-project-123");
  await assert.rejects(f.service.startAuthentication("valid-project-123"), /already in progress/);
  await versionStarted;
  assert.equal(calls.length, 1);

  const cancel = f.service.cancelAuthentication();
  versionChild.emit("close", 0, null);
  await tick();
  assert.equal(calls.filter(({ args }) => args.includes("login")).length, 1);
  assert.deepEqual(loginChild.kills, ["SIGTERM"]);
  loginChild.emit("close", null, "SIGTERM");
  await Promise.all([first, cancel]);
});

test("authentication timeout terminates the child and exposes no process output", async (t) => {
  const f = await fixture({ authTimeoutMs: 5, authKillGraceMs: 5 });
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.service.startAuthentication("valid-project-123");
  const stagingDir = f.loginChild() && f.calls.find((call) => call.args.includes("login")).options.env.CLOUDSDK_CONFIG;
  const adcPath = path.join(f.authDir, "application_default_credentials.json");
  const configPath = path.join(f.authDir, "bitty-google-cloud.json");
  await fs.writeFile(adcPath, "old-adc", { mode: 0o600 });
  const oldConfig = await fs.readFile(configPath, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(f.loginChild().kills.includes("SIGTERM"));
  f.loginChild().emit("close", null, "SIGTERM");
  assert.equal((await f.service.status()).status, "connected");
  assert.match((await f.service.status()).message, /timed out/);
  assert.equal(await fs.readFile(adcPath, "utf8"), "old-adc");
  assert.equal(await fs.readFile(configPath, "utf8"), oldConfig);
  await assert.rejects(fs.stat(stagingDir), { code: "ENOENT" });
});

test("dedicated auth rejects symlinked ADC even when host credentials may exist", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.service.getSettings();
  const hostLikeAdc = path.join(f.root, "host-adc.json");
  await fs.writeFile(hostLikeAdc, "{}", { mode: 0o600 });
  await fs.symlink(hostLikeAdc, path.join(f.authDir, "application_default_credentials.json"));
  await assert.rejects(f.service.credentials(), /symbolic link/);
});

test("startup initialization rejects a permissive dedicated auth directory", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await fs.mkdir(f.authDir, { recursive: true, mode: 0o700 });
  await fs.chmod(f.authDir, 0o755);
  await assert.rejects(f.service.initialize(), /permissions must be 700/);
});

test("startup initialization eagerly rejects an unsafe existing dedicated ADC", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await fs.mkdir(f.authDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(f.authDir, "application_default_credentials.json"), "{}", { mode: 0o644 });
  await assert.rejects(f.service.initialize(), /permissions must be 600/);
});

test("cancelled reauthentication preserves live ADC and config and removes staging", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.service.getSettings();
  const adcPath = path.join(f.authDir, "application_default_credentials.json");
  const configPath = path.join(f.authDir, "bitty-google-cloud.json");
  await fs.writeFile(adcPath, "old-adc", { mode: 0o600 });
  const oldConfig = await fs.readFile(configPath, "utf8");

  await f.service.startAuthentication("replacement-project-123");
  const stagingDir = f.calls.find((call) => call.args.includes("login")).options.env.CLOUDSDK_CONFIG;
  await fs.writeFile(path.join(stagingDir, "application_default_credentials.json"), "partial-new-adc", { mode: 0o600 });
  const cancellation = f.service.cancelAuthentication();
  f.loginChild().emit("close", null, "SIGTERM");
  await cancellation;

  assert.equal(await fs.readFile(adcPath, "utf8"), "old-adc");
  assert.equal(await fs.readFile(configPath, "utf8"), oldConfig);
  await assert.rejects(fs.stat(stagingDir), { code: "ENOENT" });
});

test("failed reauthentication keeps the saved connection visible with a safe failure message", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.service.getSettings();
  const adcPath = path.join(f.authDir, "application_default_credentials.json");
  const configPath = path.join(f.authDir, "bitty-google-cloud.json");
  await fs.writeFile(adcPath, "old-adc", { mode: 0o600 });
  const oldConfig = await fs.readFile(configPath, "utf8");

  await f.service.startAuthentication("replacement-project-123");
  const stagingDir = f.calls.find((call) => call.args.includes("login")).options.env.CLOUDSDK_CONFIG;
  await fs.writeFile(path.join(stagingDir, "application_default_credentials.json"), "partial-new-adc", { mode: 0o600 });
  f.loginChild().emit("close", 1, null);
  for (let index = 0; index < 50 && (await f.service.status()).status === "authenticating"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const status = await f.service.status();
  assert.equal(status.status, "connected");
  assert.equal(status.message, "Google Cloud authentication failed (exit 1)");
  assert.equal(status.projectId, "valid-project-123");
  assert.equal(await fs.readFile(adcPath, "utf8"), "old-adc");
  assert.equal(await fs.readFile(configPath, "utf8"), oldConfig);
  await assert.rejects(fs.stat(stagingDir), { code: "ENOENT" });
});

test("failed first authentication reports an error without a saved connection", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.service.startAuthentication("valid-project-123");
  f.loginChild().emit("close", 1, null);
  const status = await f.service.status();
  assert.equal(status.status, "error");
  assert.equal(status.message, "Google Cloud authentication failed (exit 1)");
});

test("failed staged config promotion rolls back the live ADC and config pair", async (t) => {
  const f = await fixture({ failConfigPromotion: true });
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.service.getSettings();
  const adcPath = path.join(f.authDir, "application_default_credentials.json");
  const configPath = path.join(f.authDir, "bitty-google-cloud.json");
  await fs.writeFile(adcPath, "old-adc", { mode: 0o600 });
  const oldConfig = await fs.readFile(configPath, "utf8");

  await f.service.startAuthentication("replacement-project-123");
  const stagingDir = f.calls.find((call) => call.args.includes("login")).options.env.CLOUDSDK_CONFIG;
  await fs.writeFile(path.join(stagingDir, "application_default_credentials.json"), "{}", { mode: 0o600 });
  f.loginChild().emit("close", 0, null);
  const status = await f.service.status();

  assert.equal(status.status, "connected");
  assert.equal(await fs.readFile(adcPath, "utf8"), "old-adc");
  assert.equal(await fs.readFile(configPath, "utf8"), oldConfig);
  await assert.rejects(fs.stat(stagingDir), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(f.authDir)).filter((name) => name.includes("backup")), []);
});

for (const [name, overrides] of [
  ["quota validation", { writeQuotaProject: false }],
  ["token validation", {
    googleAuthFactory: () => ({ getAccessToken: async () => { throw new Error("secret token failure"); } }),
  }],
  ["account validation", {
    fetchImpl: async () => ({ ok: false, json: async () => ({ secret: "provider detail" }) }),
  }],
]) {
  test(`failed ${name} preserves live ADC and config and removes staging`, async (t) => {
    const f = await fixture(overrides);
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    await f.service.getSettings();
    const adcPath = path.join(f.authDir, "application_default_credentials.json");
    const configPath = path.join(f.authDir, "bitty-google-cloud.json");
    await fs.writeFile(adcPath, "old-adc", { mode: 0o600 });
    const oldConfig = await fs.readFile(configPath, "utf8");

    await f.service.startAuthentication("replacement-project-123");
    const stagingDir = f.calls.find((call) => call.args.includes("login")).options.env.CLOUDSDK_CONFIG;
    await fs.writeFile(path.join(stagingDir, "application_default_credentials.json"), "{}", { mode: 0o600 });
    f.loginChild().emit("close", 0, null);
    const status = await f.service.status();

    assert.equal(status.status, "connected");
    assert.equal(status.message, "Google Cloud authentication validation failed");
    assert.doesNotMatch(JSON.stringify(status), /secret|provider detail/);
    assert.equal(await fs.readFile(adcPath, "utf8"), "old-adc");
    assert.equal(await fs.readFile(configPath, "utf8"), oldConfig);
    await assert.rejects(fs.stat(stagingDir), { code: "ENOENT" });
  });
}

test("connected status reports only the persisted connection without a Speech request", async (t) => {
  const f = await fixture({
    googleAuthFactory: () => { throw new Error("status must not validate Speech"); },
  });
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.service.getSettings();
  await fs.writeFile(path.join(f.authDir, "application_default_credentials.json"), "{}", { mode: 0o600 });

  const first = await f.service.status();
  const second = await f.service.status();
  assert.equal(first.status, "connected");
  assert.equal(first.message, "");
  assert.equal("sttAvailable" in first, false);
  assert.equal("availabilityCode" in first, false);
  assert.deepEqual(first, second);
});

test("access token uses dedicated credentials without falling back to host ADC", async (t) => {
  const f = await fixture({
    googleAuthFactory: (options) => ({
      getAccessToken: async () => {
        assert.equal(options.keyFilename, path.join(f.authDir, "application_default_credentials.json"));
        throw Object.assign(new Error("raw revoked token response"), { code: 16 });
      },
    }),
  });
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.service.getSettings();
  await fs.writeFile(path.join(f.authDir, "application_default_credentials.json"), "{}", { mode: 0o600 });
  await assert.rejects(f.service.accessToken(), /raw revoked token response/);
});
