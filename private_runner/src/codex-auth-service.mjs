import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";

const AUTH_ID = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,63}$/;
const VERSION = 1;

function decodeJwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function resolveCredentialRecord(credential) {
  if (credential?.tokens && typeof credential.tokens === "object") return credential;
  if (credential?.profiles?.default && typeof credential.profiles.default === "object") return credential.profiles.default;
  throw new Error("credential unavailable");
}

export function normalizeRegistrationCredential(credential) {
  try {
    const record = resolveCredentialRecord(credential);
    const source = record.tokens;
    if (typeof source.access_token !== "string" || !source.access_token.trim() || typeof source.refresh_token !== "string" || !source.refresh_token.trim()) throw new Error("credential invalid");
    const accessClaims = decodeJwtPayload(source.access_token) || {};
    const accountId = source.account_id || accessClaims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId.trim()) throw new Error("credential invalid");
    const idClaims = decodeJwtPayload(source.id_token) || {};
    const clientId = record.clientId || accessClaims.client_id || (typeof idClaims.aud === "string" ? idClaims.aud : Array.isArray(idClaims.aud) ? idClaims.aud[0] : "");
    return { tokens: { access_token: source.access_token, refresh_token: source.refresh_token, ...(source.id_token ? { id_token: source.id_token } : {}), account_id: accountId }, ...(clientId ? { clientId } : {}), tokenEndpoint: "https://auth.openai.com/oauth/token", ...(record.planType ? { planType: record.planType } : {}) };
  } catch {
    throw new Error("credential unavailable");
  }
}

export async function createCodexRegistrationProcess({ codexBin = "codex", spawnImpl = spawn, registrationTempRoot = os.tmpdir(), childEnv = process.env } = {}) {
  await fs.mkdir(registrationTempRoot, { recursive: true, mode: 0o700 });
  const stagingHome = await fs.mkdtemp(path.join(registrationTempRoot, "bitty-codex-auth-"));
  await fs.chmod(stagingHome, 0o700);
  let child;
  try {
    const env = { ...childEnv, CODEX_HOME: stagingHome };
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CHATGPT_ACCESS_TOKEN", "CODEX_ACCESS_TOKEN"]) delete env[key];
    child = spawnImpl(codexBin, ["app-server", "--strict-config", "--stdio", "-c", 'cli_auth_credentials_store="file"', "-c", "analytics.enabled=false"], { env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    child.stderr?.resume();
    const pending = new Map();
    const listeners = new Set();
    let nextId = 1;
    let stopped = false;
    let resolveExit;
    const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
    const send = (payload) => {
      if (stopped || exited || !child.stdin?.writable || child.stdin.destroyed) throw new Error("registration process stopped");
      try { child.stdin.write(`${JSON.stringify(payload)}\n`); } catch { throw new Error("registration process unavailable"); }
    };
    let exited = false;
    const settleExit = () => {
      if (exited) return;
      exited = true;
      resolveExit();
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("registration process exited")); }
      pending.clear();
      rl.close();
    };
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && !message.method) {
        const entry = pending.get(Number(message.id)); if (!entry) return;
        pending.delete(Number(message.id)); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error("registration RPC failed")); else entry.resolve(message.result);
      } else if (message.method && message.id !== undefined) { try { send({ id: message.id, error: { code: -32601, message: "Registration server request not handled" } }); } catch {} }
      else if (message.method) for (const listener of listeners) Promise.resolve(listener(message)).catch(() => {});
    });
    const request = (method, params = {}) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("registration RPC timeout")); }, 10_000);
        pending.set(id, { resolve, reject, timer });
        try { send({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(new Error("registration process unavailable")); }
      });
    };
    child.once("exit", settleExit);
    child.once("error", settleExit);
    child.stdin?.once("error", settleExit);
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      if (exited) return;
      try { child.kill("SIGTERM"); } catch {}
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (!exited) { try { child.kill("SIGKILL"); } catch {} await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 1_000))]); }
    };
    return { request, notify: (method, params = {}) => send({ method, params }), onNotification: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, stop, waitForExit: () => exitPromise, readCredential: async () => { if (!exited) throw new Error("credential unavailable"); try { return normalizeRegistrationCredential(JSON.parse(await fs.readFile(path.join(stagingHome, "auth.json"), "utf8"))); } catch { throw new Error("credential unavailable"); } }, cleanup: async () => { try { await stop(); } finally { await fs.rm(stagingHome, { recursive: true, force: true }); } } };
  } catch (error) {
    try { child?.kill?.("SIGKILL"); } catch {}
    await fs.rm(stagingHome, { recursive: true, force: true });
    throw new Error("registration process unavailable");
  }
}

function sanitizeRateLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("rate limits unavailable");
  const result = {};
  for (const [name, limit] of Object.entries(value)) {
    if (!limit || typeof limit !== "object" || Array.isArray(limit)) continue;
    const safe = {};
    for (const key of ["usedPercent", "windowDurationMins", "resetsAt"]) {
      const item = limit[key];
      if (key === "resetsAt" ? Number.isFinite(Number(item)) : Number.isFinite(Number(item))) safe[key] = Number(item);
    }
    if (Object.keys(safe).length) result[name] = safe;
  }
  if (!Object.keys(result).length) throw new Error("rate limits unavailable");
  return result;
}

function checkedAuthId(value) {
  const id = String(value ?? "");
  if (!AUTH_ID.test(id) || id === "." || id === "..") throw new Error("invalid auth id");
  return id;
}

function validateProfile(profile, expectedAuthId = "") {
  if (!profile || typeof profile !== "object" || Array.isArray(profile) || profile.version !== VERSION) throw new Error("invalid auth profile");
  const authId = checkedAuthId(profile.authId);
  if (expectedAuthId && authId !== checkedAuthId(expectedAuthId)) throw new Error("auth profile id mismatch");
  if (typeof profile.accountId !== "string" || !profile.accountId.trim()) throw new Error("invalid account id");
  const tokens = profile.tokens;
  if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token.trim() || typeof tokens.refresh_token !== "string" || !tokens.refresh_token.trim()) throw new Error("invalid auth tokens");
  if (tokens.account_id && tokens.account_id !== profile.accountId) throw new Error("auth profile account mismatch");
  return { ...profile, authId };
}

export function createCodexAuthService({ rootDir, pid = process.pid, now = () => Date.now(), kill = process.kill, staleLockMs = 60_000, fetchImpl = globalThis.fetch, registrationProcessFactory, isolatedProcessFactory, codexBin = "codex", spawnImpl = spawn, registrationTempRoot = os.tmpdir(), childEnv = process.env } = {}) {
  if (!rootDir) throw new TypeError("rootDir is required");
  const profilesDir = path.join(rootDir, "profiles");
  const markerPath = path.join(profilesDir, ".active_auth_id");
  const lockPath = path.join(profilesDir, ".owner.lock");
  const profilePath = (authId) => path.join(profilesDir, `${checkedAuthId(authId)}.json`);
  const refreshFlights = new Map();
  const rateLimitOperations = new Set();
  const registrations = new Map();
  const createMutex = () => {
    let tail = Promise.resolve();
    return async (callback) => {
      let release;
      const turn = new Promise((resolve) => { release = resolve; });
      const previous = tail;
      tail = tail.then(() => turn);
      await previous;
      try { return await callback(); } finally { release(); }
    };
  };
  const switchMutex = createMutex();
  const mutationMutex = createMutex();
  let gateState = "open";
  let leases = 0;
  const drainWaiters = new Set();
  const notifyDrain = () => { if (leases !== 0) return; for (const resolve of drainWaiters) resolve(); };
  const ensureDir = async () => {
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(profilesDir, { recursive: true, mode: 0o700 });
    await fs.chmod(rootDir, 0o700);
    await fs.chmod(profilesDir, 0o700);
  };
  const atomicWrite = async (file, content) => {
    const temp = `${file}.tmp-${pid}-${crypto.randomUUID()}`;
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, file);
      const dir = await fs.open(path.dirname(file), "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  };
  const save = async (profile) => {
    const valid = validateProfile(profile);
    await ensureDir();
    await atomicWrite(profilePath(valid.authId), `${JSON.stringify(valid)}\n`);
    return valid;
  };
  const read = async (authId) => {
    const checked = checkedAuthId(authId);
    let raw;
    try {
      raw = await fs.readFile(profilePath(checked), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error("auth profile not found");
      }
      throw new Error("auth profile unavailable");
    }
    try {
      return validateProfile(JSON.parse(raw), checked);
    } catch {
      throw new Error("invalid auth profile");
    }
  };
  const acquireOwnerLock = async () => {
    await ensureDir();
    const nonce = crypto.randomUUID();
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid, acquiredAt: now(), nonce }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = JSON.parse(await fs.readFile(lockPath, "utf8"));
          if (current.nonce === nonce) await fs.unlink(lockPath);
        } catch {}
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let lock;
      try {
        lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
      } catch {
        throw new Error("auth lock unavailable");
      }
      const ownerPid = Number(lock?.pid);
      const acquiredAt = Number(lock?.acquiredAt);
      if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !Number.isFinite(acquiredAt) || typeof lock?.nonce !== "string" || !lock.nonce) {
        throw new Error("auth lock unavailable");
      }
      let ownerAlive = false;
      try {
        kill(ownerPid, 0);
        ownerAlive = true;
      } catch (probe) {
        if (probe?.code !== "ESRCH") throw new Error("auth lock unavailable");
      }
      if (ownerAlive || now() - acquiredAt <= staleLockMs) {
        throw new Error("auth lock unavailable");
      }
      await fs.unlink(lockPath);
      return acquireOwnerLock();
    }
  };
  const refresh = async (authId) => {
    if (shuttingDown) throw new Error("auth service is shutting down");
    const checked = checkedAuthId(authId);
    if (refreshFlights.has(checked)) return refreshFlights.get(checked);
    const flight = mutationMutex(async () => {
      const profile = await read(checked);
      if (typeof fetchImpl !== "function") throw new Error("auth refresh unavailable");
      const body = { grant_type: "refresh_token", refresh_token: profile.tokens.refresh_token };
      if (profile.clientId) body.client_id = profile.clientId;
      const response = await fetchImpl(profile.tokenEndpoint || "https://auth.openai.com/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
      if (!response?.ok) throw new Error("auth refresh failed");
      let tokens;
      try { tokens = await response.json(); } catch { throw new Error("auth refresh returned invalid JSON"); }
      if (typeof tokens?.access_token !== "string" || !tokens.access_token.trim()) throw new Error("auth refresh returned invalid tokens");
      if (tokens.account_id && tokens.account_id !== profile.accountId) throw new Error("auth refresh account mismatch");
      const next = await save({ ...profile, tokens: { ...profile.tokens, ...tokens, refresh_token: tokens.refresh_token || profile.tokens.refresh_token, account_id: profile.accountId } });
      return { accessToken: next.tokens.access_token, accountId: next.accountId, ...(next.planType ? { planType: next.planType } : {}) };
    });
    refreshFlights.set(checked, flight);
    try {
      return await flight;
    } finally {
      refreshFlights.delete(checked);
    }
  };
  const activeAuthId = async () => {
    try {
      return checkedAuthId((await fs.readFile(markerPath, "utf8")).trim());
    } catch {
      return "";
    }
  };
  const profileIds = async () => {
    const entries = await fs.readdir(profilesDir, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')).map((entry) => entry.name.slice(0, -5));
  };
  const accessTokenNeedsRefresh = (token, skewMs = 60_000) => {
    const exp = Number(decodeJwtPayload(token)?.exp);
    return !Number.isFinite(exp) || exp * 1000 <= now() + skewMs;
  };
  const externalTokenPayload = async (authId, { forceRefresh = false } = {}) => {
    const checked = checkedAuthId(authId);
    let profile = await read(checked);
    if (forceRefresh || accessTokenNeedsRefresh(profile.tokens.access_token)) await refresh(checked);
    profile = await read(checked);
    return { accessToken: profile.tokens.access_token, chatgptAccountId: profile.accountId, ...(profile.planType ? { chatgptPlanType: profile.planType } : {}) };
  };
  const refreshRateLimits = async (authId) => {
    if (shuttingDown) throw new Error("auth service is shutting down");
    const checked = checkedAuthId(authId);
    const operation = (async () => {
      let process;
      try {
        const payload = await externalTokenPayload(checked);
        const factory = isolatedProcessFactory || (() => createCodexRegistrationProcess({ codexBin, spawnImpl, registrationTempRoot, childEnv }));
        process = await factory({ purpose: "rate-limits", authId: checked });
        await process.request("initialize", { clientInfo: { name: "bitty-rate-limits", title: "Bitty Rate Limits", version: "0.1.0" }, capabilities: { experimentalApi: true, optOutNotificationMethods: [] } });
        process.notify("initialized", {});
        const login = await process.request("account/login/start", { type: "chatgptAuthTokens", accessToken: payload.accessToken, chatgptAccountId: payload.chatgptAccountId, ...(payload.chatgptPlanType ? { chatgptPlanType: payload.chatgptPlanType } : {}) });
        if (login?.type !== "chatgptAuthTokens") throw new Error("rate limits login rejected");
        const response = await process.request("account/rateLimits/read", {});
        const rateLimits = sanitizeRateLimits(response?.rateLimits || response);
        await updateMetadata(checked, { rateLimits, status: "active" });
        return rateLimits;
      } catch {
        await updateMetadata(checked, { status: "unavailable" }).catch(() => {});
        throw new Error("rate limits unavailable");
      } finally {
        try { await process?.cleanup?.(); } catch {}
      }
    })();
    rateLimitOperations.add(operation);
    try {
      return await operation;
    } finally {
      rateLimitOperations.delete(operation);
    }
  };
  const refreshAllRateLimits = async () => {
    const ids = await profileIds();
    const result = {};
    for (const authId of ids) {
      try { result[authId] = { rateLimits: await refreshRateLimits(authId), status: "active" }; }
      catch { result[authId] = { status: "unavailable" }; }
    }
    return result;
  };
  const activeExternalTokenPayload = async () => {
    const ids = await profileIds();
    if (ids.length === 0) return null;
    const checked = await activeAuthId();
    if (!checked || !ids.includes(checked)) throw new Error('auth profiles unready');
    return externalTokenPayload(checked);
  };
  const updateMetadata = async (authId, metadata = {}) => mutationMutex(async () => {
    const profile = await read(authId);
    const allowed = {};
    for (const key of ['status', 'displayName', 'planType', 'rateLimits']) {
      if (metadata[key] !== undefined) allowed[key] = metadata[key];
    }
    return save({ ...profile, ...allowed, tokens: profile.tokens });
  });
  const deleteProfile = async (authId) => switchMutex(() => mutationMutex(async () => {
    const checked = checkedAuthId(authId);
    for (const item of registrations.values()) {
      if (item.authId === checked && ["starting", "pending", "finalizing"].includes(item.status)) throw new Error("auth profile busy");
    }
    if (await activeAuthId() === checked) throw new Error('active auth profile');
    await fs.unlink(profilePath(checked)).catch((error) => {
      if (error?.code !== 'ENOENT') throw new Error('auth profile unavailable');
      throw new Error('auth profile not found');
    });
  }));
  const stopRegistrationProcess = (state) => {
    if (state.stopPromise) return state.stopPromise;
    state.stopPromise = (async () => {
      try { await state.process?.stop(); } catch {}
      try { await state.process?.waitForExit(); } catch {}
    })();
    return state.stopPromise;
  };
  const cleanupRegistration = (state) => {
    if (state.cleanupPromise) return state.cleanupPromise;
    state.cleanupPromise = stopRegistrationProcess(state).then(async () => { try { await state.process?.cleanup?.(); } catch {} });
    return state.cleanupPromise;
  };
  let shutdownPromise = null;
  let shuttingDown = false;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      await Promise.all(Array.from(registrations.values()).map(async (state) => {
        if (!["starting", "pending", "finalizing"].includes(state.status)) return;
        await mutationMutex(async () => {
          if (["starting", "pending", "finalizing"].includes(state.status)) state.status = "cancelled";
        });
        try { await state.startPromise; } catch {}
        try { await state.process?.request("account/login/cancel", { loginId: state.loginId }); } catch {}
        await cleanupRegistration(state);
        try { await state.finalizePromise; } catch {}
      }));
      await Promise.allSettled([...refreshFlights.values(), ...rateLimitOperations]);
    })();
    return shutdownPromise;
  };
  const failRegistration = async (state, code) => {
    if (!["completed", "failed", "cancelled"].includes(state.status)) { state.status = "failed"; state.errorCode = code; }
    await cleanupRegistration(state);
  };
  const finalizeRegistration = async (state) => {
    if (state.status !== "pending") return;
    state.status = "finalizing";
    try {
      const metadata = await state.process.request("account/read", {});
      if (state.status !== "finalizing") return;
      await stopRegistrationProcess(state);
      const credential = await state.process.readCredential();
      if (state.status !== "finalizing") return;
      const tokens = credential?.tokens;
      if (typeof tokens?.access_token !== "string" || typeof tokens?.refresh_token !== "string" || typeof tokens?.account_id !== "string") throw new Error("credential_invalid");
      const saved = await mutationMutex(async () => {
        if (state.status !== "finalizing") return false;
        if (state.expectedAccountId && tokens.account_id !== state.expectedAccountId) throw new Error("reauth_account_mismatch");
        const entries = await fs.readdir(profilesDir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const otherId = entry.name.slice(0, -5);
          if (otherId === state.authId) continue;
          try {
            const other = await read(otherId);
            if (other.accountId === tokens.account_id || other.tokens.refresh_token === tokens.refresh_token) throw new Error("duplicate_account");
          } catch (error) { if (error.message === "duplicate_account") throw error; }
        }
        const account = metadata?.account || {};
        const displayName = String(credential.displayName || account.email || account.displayName || "").trim();
        if (state.status !== "finalizing") return false;
        await save({ version: VERSION, authId: state.authId, accountId: tokens.account_id, tokens, ...(credential.clientId ? { clientId: credential.clientId } : {}), ...(credential.tokenEndpoint ? { tokenEndpoint: credential.tokenEndpoint } : {}), ...(credential.planType || account.planType ? { planType: credential.planType || account.planType } : {}), ...(displayName ? { displayName } : {}) });
        return true;
      });
      if (!saved || state.status !== "finalizing") return;
      await cleanupRegistration(state);
      if (state.status === "finalizing") state.status = "completed";
    } catch (error) {
      const code = ["reauth_account_mismatch", "duplicate_account", "credential_invalid"].includes(error?.message) ? error.message : "registration_failed";
      await failRegistration(state, code);
    }
  };
  const startRegistration = async (authId, { reauth = false } = {}) => {
    if (shuttingDown) throw new Error("auth service is shutting down");
    const checked = checkedAuthId(authId);
    const processFactory = registrationProcessFactory || (() => createCodexRegistrationProcess({ codexBin, spawnImpl, registrationTempRoot, childEnv }));
    const state = await mutationMutex(async () => {
      if (shuttingDown) throw new Error("auth service is shutting down");
      for (const item of registrations.values()) {
        if (item.authId === checked && ["starting", "pending", "finalizing"].includes(item.status)) throw new Error("registration already pending");
      }
      let expectedAccountId = "";
      if (reauth) {
        expectedAccountId = (await read(checked)).accountId;
      } else {
        try {
          await fs.access(profilePath(checked));
          throw new Error("auth profile exists");
        } catch (error) {
          if (error?.message === "auth profile exists") throw error;
          if (error?.code !== "ENOENT") throw new Error("auth profile unavailable");
        }
      }
      const registrationId = crypto.randomUUID();
      const claimed = { registrationId, authId: checked, expectedAccountId, process: null, startPromise: null, status: "starting" };
      registrations.set(registrationId, claimed);
      return claimed;
    });
    const { registrationId } = state;
    let process;
    state.startPromise = Promise.resolve().then(() => processFactory({ authId, reauth }));
    try { process = await state.startPromise; state.process = process; }
    catch { await failRegistration(state, "process_start_failed"); throw new Error("registration unavailable"); }
    if (shuttingDown || state.status === "cancelled") {
      await cleanupRegistration(state);
      throw new Error("registration unavailable");
    }
    state.status = "pending";
    process.onNotification(async (notification) => {
      if (state.status !== "pending" || notification?.method !== "account/login/completed") return;
      if (notification.params?.success !== true) { void failRegistration(state, "login_failed"); return; }
      state.finalizePromise = finalizeRegistration(state);
      await state.finalizePromise;
    });
    process.waitForExit().then(() => { if (["starting", "pending"].includes(state.status)) void failRegistration(state, "process_exit"); }).catch(() => {});
    let login;
    try {
      await process.request("initialize", { clientInfo: { name: "bitty-auth-registration", title: "Bitty Auth Registration", version: "0.1.0" }, capabilities: { experimentalApi: true, optOutNotificationMethods: [] } });
      process.notify("initialized", {});
      login = await process.request("account/login/start", { type: "chatgptDeviceCode" });
      if (login?.type !== "chatgptDeviceCode" || typeof login.loginId !== "string" || !login?.verificationUrl || !login?.userCode) throw new Error("invalid login response");
    } catch {
      await failRegistration(state, "invalid_login_response");
      throw new Error("registration unavailable");
    }
    state.loginId = login.loginId;
    return { registrationId, verificationUrl: login.verificationUrl, userCode: login.userCode, ...(login.expiresAt ? { expiresAt: login.expiresAt } : {}) };
  };
  return {
    save, read, refresh, acquireOwnerLock, shutdown, activeAuthId, activeExternalTokenPayload,
    externalTokenPayload, refreshRateLimits, refreshAllRateLimits, updateMetadata, deleteProfile, startRegistration,
    registrationStatus: async (registrationId) => {
      const state = registrations.get(String(registrationId));
      if (!state) return { status: "failed", errorCode: "registration_not_found" };
      const status = ["starting", "finalizing"].includes(state.status) ? "pending" : state.status;
      return { status, ...(state.errorCode ? { errorCode: state.errorCode } : {}) };
    },
    cancelRegistration: async (registrationId) => {
      const state = registrations.get(String(registrationId));
      if (!state || state.status !== "pending") return;
      state.status = "cancelled";
      try { await state.process.request("account/login/cancel", { loginId: state.loginId }); } catch {}
      await cleanupRegistration(state);
    },
    withSwitch: switchMutex,
    withMutation: mutationMutex,
    acquireLease: () => {
      if (gateState !== "open") throw new Error("auth gate unavailable");
      leases += 1;
      let released = false;
      return () => { if (released) return; released = true; leases -= 1; notifyDrain(); };
    },
    closeAndDrain: async ({ timeoutMs = 8000 } = {}) => {
      if (gateState === "unready") throw new Error("auth gate unready");
      gateState = "closing";
      if (leases > 0) {
        let timer;
        let resolveDrain;
        const drain = new Promise((resolve) => { resolveDrain = resolve; drainWaiters.add(resolve); });
        try {
          await Promise.race([
            drain,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("auth gate drain timeout")), timeoutMs); }),
          ]);
        } catch (error) {
          gateState = "open";
          throw error;
        } finally {
          clearTimeout(timer);
          drainWaiters.delete(resolveDrain);
        }
      }
    },
    openGate: () => { if (gateState === "closing") gateState = "open"; },
    markUnready: () => { gateState = "unready"; },
    gateSnapshot: () => ({ state: gateState, leases }),
    async setActiveAuthId(authId) {
      await ensureDir();
      await atomicWrite(markerPath, `${checkedAuthId(authId)}\n`);
    },
    async snapshot() {
      const entries = await fs.readdir(profilesDir, { withFileTypes: true }).catch(() => []);
      const profiles = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
        const authId = entry.name.slice(0, -5);
        try {
          const profile = await read(authId);
          profiles.push({
            authId,
            status: profile.status || "active",
            ...(profile.displayName ? { displayName: profile.displayName } : {}),
            ...(profile.planType ? { planType: profile.planType } : {}),
            ...(profile.rateLimits ? { rateLimits: profile.rateLimits } : {}),
          });
        } catch {
          profiles.push({ authId: AUTH_ID.test(authId) ? authId : "invalid", status: "invalid" });
        }
      }
      return { profiles, activeAuthId: await activeAuthId() };
    },
  };
}
