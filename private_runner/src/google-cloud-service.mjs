import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { GoogleAuth } from "google-auth-library";

const ADC_FILE = "application_default_credentials.json";
const CONFIG_FILE = "bitty-google-cloud.json";

function validateProjectId(value) {
  const projectId = String(value || "").trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error("projectId is invalid");
  }
  return projectId;
}

function validateLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("monthlyLimitMinutes must be a positive integer");
  }
  return limit;
}

function validateSttRegion(value) {
  if (value !== "us" && value !== "asia-northeast1") throw new Error("sttRegion is invalid");
  return value;
}

function validateSttModel(value) {
  if (value !== "chirp_3" && value !== "long" && value !== "short") throw new Error("sttModel is invalid");
  return value;
}

function sanitizedProcessError(code, signal) {
  if (signal) return `Google Cloud authentication stopped (${signal})`;
  return `Google Cloud authentication failed (exit ${Number.isInteger(code) ? code : "unknown"})`;
}

export function createGoogleCloudService({
  authDir = process.env.BITTY_GOOGLE_AUTH_DIR || path.join(os.homedir(), ".bitty", "private-runner", "google-cloud"),
  initialProjectId = process.env.GOOGLE_CLOUD_PROJECT_ID || "",
  spawn = nodeSpawn,
  fileSystem = fs,
  googleAuthFactory = (options) => new GoogleAuth(options),
  fetchImpl = fetch,
  authTimeoutMs = 10 * 60 * 1000,
  authKillGraceMs = 5 * 1000,
} = {}) {
  const adcPath = path.join(authDir, ADC_FILE);
  const configPath = path.join(authDir, CONFIG_FILE);
  let authProcess = null;
  let authStartPending = null;
  let authState = { status: "idle", message: "", account: "" };
  let initialized = false;
  let config = { projectId: "", monthlyLimitMinutes: 60, sttRegion: "us", sttModel: "chirp_3", account: "" };
  let writeQueue = Promise.resolve();

  const restrictiveMode = async (target, expected, label, expectedType) => {
    const stat = await fileSystem.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
    if (expectedType === "directory" && !stat.isDirectory()) throw new Error(`${label} must be a directory`);
    if (expectedType === "file" && !stat.isFile()) throw new Error(`${label} must be a regular file`);
    const actual = stat.mode & 0o777;
    if (actual !== expected) {
      throw new Error(`${label} permissions must be ${expected.toString(8)}`);
    }
  };

  const ensureDirectory = async () => {
    await fileSystem.mkdir(authDir, { recursive: true, mode: 0o700 });
    await restrictiveMode(authDir, 0o700, "Google auth directory", "directory");
  };

  const serializedWrite = (operation) => {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => {});
    return result;
  };

  const writeConfigFile = async (target, nextConfig) => {
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    let committed = false;
    try {
      handle = await fileSystem.open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fileSystem.rename(temp, target);
      await fileSystem.chmod(target, 0o600);
      committed = true;
    } finally {
      await handle?.close().catch(() => {});
      if (!committed) await fileSystem.unlink(temp).catch(() => {});
    }
  };

  const atomicWriteConfig = (nextConfig) => serializedWrite(async () => {
    const next = typeof nextConfig === "function" ? await nextConfig(config) : nextConfig;
    await ensureDirectory();
    await writeConfigFile(configPath, next);
    config = next;
    return { ...config };
  });

  const initialize = async () => {
    if (initialized) return;
    await ensureDirectory();
    try {
      await restrictiveMode(configPath, 0o600, "Google config file", "file");
      config = JSON.parse(await fileSystem.readFile(configPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const migratedProjectId = String(initialProjectId || "").trim();
      config = {
        projectId: migratedProjectId ? validateProjectId(migratedProjectId) : "",
        monthlyLimitMinutes: 60,
        sttRegion: "us",
        sttModel: "chirp_3",
        account: "",
      };
      await atomicWriteConfig(config);
    }
    config = {
      projectId: config.projectId ? validateProjectId(config.projectId) : "",
      monthlyLimitMinutes: validateLimit(config.monthlyLimitMinutes ?? 60),
      sttRegion: validateSttRegion(config.sttRegion === undefined ? "us" : config.sttRegion),
      sttModel: validateSttModel(config.sttModel === undefined ? "chirp_3" : config.sttModel),
      account: typeof config.account === "string" ? config.account : "",
    };
    await adcExists();
    initialized = true;
  };

  const adcExists = async () => {
    try {
      await restrictiveMode(adcPath, 0o600, "Google ADC file", "file");
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };

  const gcloudEnvironment = (configDir = authDir) => ({ ...process.env, CLOUDSDK_CONFIG: configDir });

  const runGcloud = (args, configDir = authDir) => new Promise((resolve, reject) => {
    const child = spawn("gcloud", args, { env: gcloudEnvironment(configDir), stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(sanitizedProcessError(code, signal)));
    });
  });

  const setQuotaProject = async (projectId, configDir = authDir) => {
    await runGcloud(["auth", "application-default", "set-quota-project", projectId, "--quiet"], configDir);
    const target = path.join(configDir, ADC_FILE);
    await fileSystem.chmod(target, 0o600);
    await restrictiveMode(target, 0o600, "Google ADC file", "file");
    const payload = JSON.parse(await fileSystem.readFile(target, "utf8"));
    if (payload?.quota_project_id !== projectId) {
      throw new Error("Google Cloud quota project validation failed");
    }
  };

  const credentials = async () => {
    await initialize();
    await writeQueue;
    if (!config.projectId) throw new Error("Google Cloud project is not configured");
    if (!await adcExists()) throw new Error("Google Cloud is not connected");
    return {
      projectId: config.projectId,
      monthlyLimitMinutes: config.monthlyLimitMinutes,
      sttRegion: config.sttRegion,
      sttModel: config.sttModel,
      keyFilename: adcPath,
    };
  };

  const accessTokenFor = async (credentialConfig) => {
    const auth = googleAuthFactory({
      keyFilename: credentialConfig.keyFilename,
      projectId: credentialConfig.projectId,
      quotaProjectId: credentialConfig.projectId,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const token = await auth.getAccessToken();
    if (!token) throw new Error("Google Cloud access token is unavailable");
    return { accessToken: token, projectId: credentialConfig.projectId };
  };

  const accessToken = async (credentialConfig) => accessTokenFor(credentialConfig || await credentials());

  const discoverAccount = async (projectId, keyFilename = adcPath) => {
    const token = await accessTokenFor({ projectId, keyFilename });
    const response = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${token.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Google Cloud account validation failed");
    const payload = await response.json().catch(() => ({}));
    const email = String(payload?.email || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Google Cloud account validation failed");
    }
    return email;
  };

  const status = async () => {
    await initialize();
    if (authProcess?.finishing) await authProcess.completion;
    if (authState.status === "authenticating") {
      return {
        ...authState,
        projectId: config.projectId,
        monthlyLimitMinutes: config.monthlyLimitMinutes,
        sttRegion: config.sttRegion,
        sttModel: config.sttModel,
      };
    }
    await writeQueue;
    const connected = Boolean(config.projectId) && await adcExists();
    return {
      status: connected ? "connected" : authState.status === "error" ? "error" : "idle",
      message: authState.status === "error"
        ? authState.message
        : connected ? "" : "Google Cloud is not connected",
      account: connected ? (config.account || authState.account) : "",
      projectId: config.projectId,
      monthlyLimitMinutes: config.monthlyLimitMinutes,
      sttRegion: config.sttRegion,
      sttModel: config.sttModel,
    };
  };

  return {
    authDir,
    adcPath,
    initialize,

    async getSettings() {
      await initialize();
      await writeQueue;
      return { ...config };
    },

    async updateSettings({ projectId, monthlyLimitMinutes, sttRegion, sttModel }) {
      await initialize();
      return atomicWriteConfig(async (current) => {
        if (authProcess || authStartPending) throw new Error("Google Cloud authentication is already in progress");
        const next = {
          projectId: projectId === undefined ? current.projectId : validateProjectId(projectId),
          monthlyLimitMinutes: monthlyLimitMinutes === undefined
            ? current.monthlyLimitMinutes
            : validateLimit(monthlyLimitMinutes),
          sttRegion: sttRegion === undefined ? current.sttRegion : validateSttRegion(sttRegion),
          sttModel: sttModel === undefined ? current.sttModel : validateSttModel(sttModel),
          account: current.account,
        };
        if (next.projectId && await adcExists() && next.projectId !== current.projectId) {
          await setQuotaProject(next.projectId);
        }
        return next;
      });
    },

    status,

    async startAuthentication(projectId) {
      if (authProcess || authStartPending) throw new Error("Google Cloud authentication is already in progress");
      let finishStart;
      authStartPending = new Promise((resolve) => { finishStart = resolve; });
      try {
        await initialize();
        const requestedProjectId = validateProjectId(projectId || config.projectId);
        await ensureDirectory();
        const stagingDir = await fileSystem.mkdtemp(path.join(authDir, ".authentication-"));
        await fileSystem.chmod(stagingDir, 0o700);
        await restrictiveMode(stagingDir, 0o700, "Google authentication staging directory", "directory");
        const stagingAdcPath = path.join(stagingDir, ADC_FILE);
        try {
          await runGcloud(["--version"], stagingDir);
        } catch (error) {
          await fileSystem.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        authState = { status: "authenticating", message: "Continue authentication in the Runner Mac browser", account: "" };
        let child;
        try {
          child = spawn("gcloud", [
            "auth", "application-default", "login",
            "--scopes=https://www.googleapis.com/auth/cloud-platform,openid,https://www.googleapis.com/auth/userinfo.email",
          ], { env: gcloudEnvironment(stagingDir), stdio: "ignore" });
        } catch {
          await fileSystem.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
          authState = { status: "error", message: "Unable to start Google Cloud authentication", account: "" };
          throw new Error("Unable to start Google Cloud authentication");
        }
        let resolveCompletion;
        const job = {
          child,
          cancelled: false,
          timedOut: false,
          finishing: false,
          settled: false,
          timeout: null,
          forceKill: null,
          stagingDir,
          completion: new Promise((resolve) => { resolveCompletion = resolve; }),
        };
        authProcess = job;
        const finalize = async (code, signal, spawnError) => {
          if (job.finishing || job.settled) return;
          job.finishing = true;
          clearTimeout(job.timeout);
          clearTimeout(job.forceKill);
          try {
            if (job.cancelled) {
              authState = { status: "idle", message: "Google Cloud authentication cancelled", account: "" };
            } else if (job.timedOut) {
              authState = { status: "error", message: "Google Cloud authentication timed out", account: "" };
            } else if (spawnError || code !== 0) {
              authState = {
                status: "error",
                message: spawnError
                  ? `Unable to start Google Cloud authentication: ${spawnError.code || "process error"}`
                  : sanitizedProcessError(code, signal),
                account: "",
              };
            } else {
              try {
                await restrictiveMode(stagingAdcPath, 0o600, "Google ADC file", "file");
                await setQuotaProject(requestedProjectId, stagingDir);
                await accessTokenFor({ projectId: requestedProjectId, keyFilename: stagingAdcPath });
                const account = await discoverAccount(requestedProjectId, stagingAdcPath);
                if (job.cancelled) {
                  authState = { status: "idle", message: "Google Cloud authentication cancelled", account: "" };
                } else {
                  const next = { ...config, projectId: requestedProjectId, account };
                  const backupPath = path.join(authDir, `.adc-backup-${randomUUID()}`);
                  const configBackupPath = path.join(authDir, `.config-backup-${randomUUID()}`);
                  const stagingConfigPath = path.join(stagingDir, CONFIG_FILE);
                  await writeConfigFile(stagingConfigPath, next);
                  await serializedWrite(async () => {
                    const hadLiveAdc = await adcExists();
                    try {
                      if (hadLiveAdc) {
                        await fileSystem.copyFile(adcPath, backupPath);
                        await fileSystem.chmod(backupPath, 0o600);
                      }
                      await fileSystem.copyFile(configPath, configBackupPath);
                      await fileSystem.chmod(configBackupPath, 0o600);
                      if (job.cancelled) throw new Error("Google Cloud authentication cancelled");
                      await fileSystem.rename(stagingAdcPath, adcPath);
                      await fileSystem.chmod(adcPath, 0o600);
                      if (job.cancelled) throw new Error("Google Cloud authentication cancelled");
                      await fileSystem.rename(stagingConfigPath, configPath);
                      await fileSystem.chmod(configPath, 0o600);
                    } catch (error) {
                      if (hadLiveAdc) await fileSystem.rename(backupPath, adcPath).catch(() => {});
                      else await fileSystem.unlink(adcPath).catch(() => {});
                      await fileSystem.rename(configBackupPath, configPath).catch(() => {});
                      throw error;
                    } finally {
                      await fileSystem.unlink(backupPath).catch(() => {});
                      await fileSystem.unlink(configBackupPath).catch(() => {});
                    }
                    config = next;
                  });
                  authState = { status: "connected", message: "", account };
                }
              } catch (error) {
                if (job.cancelled) {
                  authState = { status: "idle", message: "Google Cloud authentication cancelled", account: "" };
                } else {
                  const localValidation = /permissions must be|regular file|symbolic link/i.test(String(error?.message || ""));
                  authState = {
                    status: "error",
                    message: localValidation
                      ? String(error.message)
                      : "Google Cloud authentication validation failed",
                    account: "",
                  };
                }
              }
            }
          } finally {
            const completedState = authState;
            authState = {
              status: "authenticating",
              message: "Cleaning up Google Cloud authentication",
              account: "",
            };
            await fileSystem.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
            authState = completedState;
            job.settled = true;
            if (authProcess === job) authProcess = null;
            resolveCompletion();
          }
        };
        child.once("error", (error) => { void finalize(null, "", error); });
        child.once("close", (code, signal) => { void finalize(code, signal, null); });
        job.timeout = setTimeout(() => {
          if (job.settled) return;
          job.timedOut = true;
          child.kill("SIGTERM");
          job.forceKill = setTimeout(() => child.kill("SIGKILL"), authKillGraceMs);
        }, authTimeoutMs);
        return status();
      } finally {
        authStartPending = null;
        finishStart();
      }
    },

    async cancelAuthentication() {
      if (authStartPending) await authStartPending;
      if (authProcess) {
        const job = authProcess;
        job.cancelled = true;
        job.child.kill("SIGTERM");
        job.forceKill = setTimeout(() => job.child.kill("SIGKILL"), authKillGraceMs);
        await job.completion;
      }
      authState = { status: "idle", message: "Google Cloud authentication cancelled", account: "" };
      return status();
    },

    async disconnect() {
      if (authStartPending) await authStartPending;
      await initialize();
      if (authProcess) {
        const job = authProcess;
        job.cancelled = true;
        job.child.kill("SIGTERM");
        job.forceKill = setTimeout(() => job.child.kill("SIGKILL"), authKillGraceMs);
        await job.completion;
      }
      if (await adcExists()) {
        await runGcloud(["auth", "application-default", "revoke", "--quiet"]).catch(() => {});
        await fileSystem.unlink(adcPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
      const next = { ...config, account: "" };
      await atomicWriteConfig(next);
      authState = { status: "idle", message: "Google Cloud disconnected", account: "" };
      return status();
    },

    credentials,
    accessToken,
  };
}
