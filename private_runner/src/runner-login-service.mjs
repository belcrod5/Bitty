import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import * as OTPAuth from "otpauth";
import { createRunnerLoginStore, runnerLoginKey } from "./runner-login-store.mjs";

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
export const RUNNER_SESSION_PREFIX = "bitty_session_v1.";
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const clean = (value, length = 120) => String(value || "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, length);
const email = (value) => clean(value, 254).toLowerCase();
const same = (a, b) => {
  const x = Buffer.from(String(a || "")); const y = Buffer.from(String(b || ""));
  return x.length === y.length && timingSafeEqual(x, y);
};
function error(code, status = 400) { return Object.assign(new Error(code), { code, status }); }

export function createRunnerLoginService({ directory, legacyToken = "", sendMail, now = Date.now,
  keyProvider = runnerLoginKey, store = createRunnerLoginStore(directory, { now }), inspectOwners = async () => [] } = {}) {
  let key = null, ready = false, closing = false, unavailable = false, flushPromise = null;
  const sockets = new Map();
  const touching = new Map();
  let timer = null;
  const initial = () => ({ version: 1, ownerSubjectId: legacyToken ? `runner:${hash(legacyToken)}` : `owner:${randomUUID()}`,
    owner: null, generation: 0, sessions: [], challenges: [], outbox: [], budget: { windowAt: now(), attempts: 0, sends: 0, sentAt: 0 } });
  const initialState = initial();
  const encrypt = (value) => {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), data: data.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  };
  const decrypt = (value) => {
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    cipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([cipher.update(Buffer.from(value.data, "base64")), cipher.final()]).toString("utf8");
  };
  const mailHash = (value) => createHmac("sha256", createHmac("sha256", key).update("email-code").digest()).update(String(value)).digest("hex");
  const needKey = async (create = false) => {
    if (closing) throw error("authentication_unavailable", 503);
    if (!key) key = await keyProvider(store.directory, { create });
    if (!Buffer.isBuffer(key) || key.length !== 32) throw error("authentication_unavailable", 503);
  };
  const sessionActive = (session) => Boolean(ready && !closing && !unavailable && session && !session.revokedAt && session.generation === store.state.generation
    && now() < session.expiresAt && now() - session.lastUsedAt < 7 * DAY);
  const sessionById = (id) => store.state?.sessions.find((session) => session.id === id);
  const checkSockets = () => {
    for (const [ws, context] of sockets) if (!sessionActive(sessionById(context.sessionId))) {
      sockets.delete(ws); ws.close(4401, "authentication_required");
    }
  };
  const change = async (operation) => {
    if (!ready || closing || unavailable) throw error("authentication_unavailable", 503);
    let result;
    try {
      result = await store.transaction(async (next) => {
        next.challenges = next.challenges.filter((item) => item.expiresAt > now());
        const active = next.sessions.filter((item) => sessionActive(item));
        const archived = next.sessions.filter((item) => !sessionActive(item) && now() - (item.revokedAt || item.expiresAt) < 30 * DAY).slice(-200);
        next.sessions = [...archived, ...active];
        const previous = structuredClone(next);
        try { return { value: await operation(next) }; }
        catch (failure) {
          if (!failure.status) throw failure;
          const budget = next.budget;
          const attempts = new Map(next.challenges.map((item) => [item.id, item.attempts]));
          Object.assign(next, previous, { budget });
          for (const challenge of next.challenges) challenge.attempts = Math.max(challenge.attempts, attempts.get(challenge.id) || 0);
          return { failure: { code: failure.code, status: failure.status } };
        }
      });
    } catch {
      unavailable = true; checkSockets(); throw error("authentication_unavailable", 503);
    }
    checkSockets();
    if (result.failure) throw error(result.failure.code, result.failure.status);
    return result.value;
  };
  const rate = (state, send = false) => {
    if (now() - state.budget.windowAt >= 15 * MINUTE) state.budget = { ...state.budget, windowAt: now(), attempts: 0, sends: 0 };
    if (send) {
      if (state.budget.sends >= 10 || now() - state.budget.sentAt < MINUTE) throw error("authentication_rate_limited", 429);
      state.budget.sends++; state.budget.sentAt = now();
    } else {
      if (state.budget.attempts >= 20) throw error("authentication_rate_limited", 429);
      state.budget.attempts++;
    }
  };
  const totp = (secret, label = "Bitty") => new OTPAuth.TOTP({ issuer: "Bitty", label, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
  const verifyTotp = (state, secret, code) => {
    const delta = /^\d{6}$/.test(String(code)) ? totp(secret).validate({ token: String(code), timestamp: now(), window: 1 }) : null;
    const step = Math.floor(now() / 30000) + (delta ?? 0);
    if (delta === null || step <= (state.owner?.lastTotpStep ?? -1)) throw error("invalid_authentication");
    return step;
  };
  const recoveries = () => Array.from({ length: 8 }, () => randomBytes(16).toString("hex"));
  const newTotp = (ownerEmail) => {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    return { secret, uri: totp(secret, ownerEmail).toString() };
  };
  const notification = (state, session, kind = "login") => {
    if (state.outbox.filter((item) => item.status === "pending").length >= 100) throw error("authentication_rate_limited", 429);
    state.outbox.push({ id: randomUUID(), sessionId: session?.id || null, to: state.owner.email, kind,
      name: session?.name || "", os: session?.os || "不明", location: session?.location || "不明", at: now(), attempts: 0, nextAt: now(), status: "pending" });
    const pending = state.outbox.filter((item) => item.status === "pending");
    const completed = state.outbox.filter((item) => item.status !== "pending" && now() - item.at < 30 * DAY).slice(-200);
    state.outbox = [...completed, ...pending];
  };
  const requireSession = (state, context, fresh = false) => {
    const session = state.sessions.find((item) => item.id === context?.sessionId);
    if (!sessionActive(session)) throw error("authentication_required", 401);
    if (fresh && session.reauthenticatedUntil <= now()) throw error("reauthentication_required", 403);
    return session;
  };
  const challengeFor = (state, input, purpose) => {
    rate(state);
    const challenge = state.challenges.find((item) => item.id === input.challengeId);
    if (!challenge || challenge.purpose !== purpose || challenge.generation !== state.generation || challenge.expiresAt <= now()
      || !same(challenge.binding, hash(input.clientBinding)) || !challenge.delivered || challenge.attempts >= 5) throw error("invalid_authentication");
    challenge.attempts++;
    if (!same(challenge.codeHash, mailHash(input.emailCode)) || !challenge.valid) throw error("invalid_authentication");
    return challenge;
  };
  const binding = (input) => {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(String(input.clientBinding || ""))) throw error("invalid_authentication");
    return hash(input.clientBinding);
  };
  const start = async (input, purpose, context) => {
    await needKey(purpose === "setup");
    const clientBinding = binding(input), id = randomUUID(), code = String(randomInt(100000000)).padStart(8, "0");
    let destination;
    const result = await change((state) => {
      if (purpose === "setup" && state.owner) throw error("owner_already_registered", 409);
      if (purpose === "reauth") requireSession(state, context);
      rate(state, true);
      state.challenges = state.challenges.filter((item) => item.purpose !== purpose || item.binding !== clientBinding);
      if (state.challenges.length >= 3) throw error("authentication_rate_limited", 429);
      destination = purpose === "setup" ? email(input.email) : state.owner?.email;
      if (purpose === "setup" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)) throw error("invalid_authentication");
      const valid = purpose === "setup" || Boolean(state.owner && same(email(input.email), destination));
      state.challenges.push({ id, purpose, binding: clientBinding, generation: state.generation, codeHash: mailHash(code),
        createdAt: now(), expiresAt: now() + 10 * MINUTE, attempts: 0, delivered: false, valid, email: destination || "", sessionId: context?.sessionId || null });
      return { challengeId: id, expiresAt: new Date(now() + 10 * MINUTE).toISOString(), valid };
    });
    const deliver = async () => {
      let delivered = false;
      try { await sendMail({ to: destination, subject: "Bitty 本人確認コード", text: `本人確認コード: ${code}\n10分間有効です。心当たりがない場合は入力せず、このメールを破棄してください。`, id }); delivered = true; } catch {}
      await change((state) => { const challenge = state.challenges.find((item) => item.id === id); if (challenge) challenge.delivered = delivered; });
      return delivered;
    };
    // Local owner setup can report delivery errors; public login remains generic.
    if (purpose === "setup") {
      if (!await deliver()) throw error("authentication_unavailable", 503);
    } else if (result.valid) void deliver().catch(() => {});
    return { challengeId: id, expiresAt: result.expiresAt };
  };
  const info = (session) => ({ sessionId: session.id, expiresAt: new Date(session.expiresAt).toISOString(), ownerEmail: store.state.owner.email,
    reauthenticatedUntil: new Date(session.reauthenticatedUntil).toISOString() });
  const flushOutbox = async () => {
    if (!ready || closing || unavailable) return;
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      for (const item of store.state.outbox.filter((entry) => entry.status === "pending" && entry.nextAt <= now())) {
        let status = "pending";
        if (item.attempts >= 5 || now() - item.at >= DAY) status = "failed";
        else {
          try {
            await sendMail({ to: item.to, id: item.id, subject: item.kind === "login" ? "Bitty 新しい端末からログインしました" : "Bitty 認証情報が変更されました",
              text: item.kind === "login" ? `新しい端末からログインしました。\n端末: ${item.name}\n推定OS: ${item.os}\n推定地域: ${item.location || "不明"}\n日時: ${new Date(item.at).toISOString()}\n心当たりがない場合はBittyの端末管理から失効してください。` : "認証情報が変更され、以前の端末セッションは失効しました。心当たりがない場合はMacでローカル復旧してください。" });
            status = "sent";
          } catch { if (item.attempts + 1 >= 5) status = "failed"; }
        }
        await change((state) => {
          const current = state.outbox.find((entry) => entry.id === item.id);
          if (current) { current.attempts = Math.min(5, current.attempts + 1); current.status = status; current.nextAt = now() + Math.min(DAY, 60000 * 2 ** current.attempts); }
        });
      }
    })().finally(() => { flushPromise = null; });
    return flushPromise;
  };

  return {
    async initialize() {
      try {
        const state = await store.initialize(initialState);
        key = await keyProvider(store.directory, { create: false });
        if (state.owner && (!Buffer.isBuffer(key) || key.length !== 32)) throw error("authentication_unavailable", 503);
        if (state.owner) decrypt(state.owner.secret);
        for (const challenge of state.challenges) if (challenge.secret) {
          if (!key) throw error("authentication_unavailable", 503);
          decrypt(challenge.secret);
        }
        ready = true;
        timer = setInterval(() => { checkSockets(); void flushOutbox().catch(() => {}); }, 1000);
        timer.unref();
      } catch (failure) { await store.close(); throw failure; }
    },
    get ownerSubjectId() { return store.state?.ownerSubjectId || initialState.ownerSubjectId; },
    get directory() { return store.directory; },
    get registered() { return Boolean(ready && store.state.owner); },
    startLogin: (input) => start(input, "login"),
    startReauthentication: (input, context) => start(input, "reauth", context),
    startRecovery: (input) => start(input, "recovery"),
    startSetup: (input) => start(input, "setup"),
    async prepareSetup(input) {
      await needKey(true);
      return change((state) => {
        if (state.owner) throw error("owner_already_registered", 409);
        const challenge = challengeFor(state, input, "setup");
        const result = newTotp(challenge.email);
        challenge.secret = encrypt(result.secret); challenge.delivered = false;
        challenge.purpose = "setup-confirm";
        return { ...result, setupId: challenge.id, expiresAt: new Date(challenge.expiresAt).toISOString() };
      });
    },
    async completeSetup(input) {
      const owners = await inspectOwners();
      return change((state) => {
        if (state.owner) throw error("owner_already_registered", 409);
        if (owners.some((owner) => owner !== state.ownerSubjectId)) throw error("owner_migration_required", 409);
        rate(state);
        const pending = state.challenges.find((item) => item.id === input.setupId && item.purpose === "setup-confirm");
        if (!pending || pending.expiresAt <= now() || pending.attempts >= 5 || pending.generation !== state.generation || !same(pending.binding, hash(input.clientBinding))) throw error("invalid_authentication");
        pending.attempts++;
        const step = verifyTotp(state, decrypt(pending.secret), input.totpCode), codes = recoveries();
        state.owner = { email: pending.email, secret: pending.secret, recoveryHashes: codes.map(hash), lastTotpStep: step };
        state.generation++; state.challenges = []; state.sessions = [];
        return { recoveryCodes: codes };
      });
    },
    async completeLogin(input, { location = "不明" } = {}) {
      await needKey();
      const result = await change((state) => {
        const challenge = challengeFor(state, input, "login");
        const step = verifyTotp(state, decrypt(state.owner.secret), input.totpCode);
        if (state.sessions.filter((session) => sessionActive(session)).length >= 50) throw error("authentication_rate_limited", 429);
        const token = RUNNER_SESSION_PREFIX + randomBytes(32).toString("base64url");
        const session = { id: randomUUID(), tokenHash: hash(token), generation: state.generation, name: clean(input.deviceName) || "Bitty",
          os: clean(input.os, 60) || "不明", location: clean(location) || "不明", createdAt: now(), lastUsedAt: now(), expiresAt: now() + 30 * DAY, reauthenticatedUntil: now() + 5 * MINUTE };
        notification(state, session); state.sessions.push(session); state.owner.lastTotpStep = step;
        state.challenges = state.challenges.filter((item) => item.id !== challenge.id);
        return { token, sessionId: session.id, expiresAt: new Date(session.expiresAt).toISOString(), ownerEmail: state.owner.email };
      });
      void flushOutbox().catch(() => {}); return result;
    },
    async completeReauthentication(input, context) {
      await needKey();
      return change((state) => {
        const session = requireSession(state, context), challenge = challengeFor(state, input, "reauth");
        if (challenge.sessionId !== session.id) throw error("invalid_authentication");
        const step = verifyTotp(state, decrypt(state.owner.secret), input.totpCode);
        state.owner.lastTotpStep = step; session.reauthenticatedUntil = now() + 5 * MINUTE;
        state.challenges = state.challenges.filter((item) => item.id !== challenge.id);
        return info(session);
      });
    },
    async prepareRecovery(input) {
      await needKey();
      return change((state) => {
        const challenge = challengeFor(state, input, "recovery");
        const index = state.owner.recoveryHashes.findIndex((value) => same(value, hash(input.recoveryCode)));
        if (index < 0) throw error("invalid_authentication");
        state.owner.recoveryHashes.splice(index, 1);
        const result = newTotp(state.owner.email);
        challenge.secret = encrypt(result.secret); challenge.purpose = "recovery-confirm"; challenge.delivered = false;
        return { ...result, recoveryId: challenge.id, expiresAt: new Date(challenge.expiresAt).toISOString() };
      });
    },
    async completeRecovery(input) {
      await needKey();
      const result = await change((state) => {
        rate(state);
        const pending = state.challenges.find((item) => item.id === input.recoveryId && item.purpose === "recovery-confirm");
        if (!pending || pending.expiresAt <= now() || pending.attempts >= 5 || pending.generation !== state.generation || !same(pending.binding, hash(input.clientBinding))) throw error("invalid_authentication");
        pending.attempts++;
        const step = verifyTotp({ owner: null }, decrypt(pending.secret), input.totpCode), codes = recoveries();
        state.owner.secret = pending.secret; state.owner.recoveryHashes = codes.map(hash); state.owner.lastTotpStep = step;
        state.generation++; state.challenges = []; for (const session of state.sessions) session.revokedAt = now();
        notification(state, null, "recovery"); return { recoveryCodes: codes };
      });
      void flushOutbox().catch(() => {}); return result;
    },
    async resetOwner() {
      const result = await change((state) => {
        if (state.owner) notification(state, null, "reset");
        state.owner = null; state.generation++; state.challenges = [];
        for (const session of state.sessions) session.revokedAt = now(); return { ok: true };
      });
      void flushOutbox().catch(() => {}); return result;
    },
    async authenticate(token, { local = false } = {}) {
      if (!ready || closing || unavailable) throw error("authentication_unavailable", 503);
      if (local && legacyToken && same(token, legacyToken)) return { local: true, ownerSubjectId: store.state.ownerSubjectId };
      if (!String(token).startsWith(RUNNER_SESSION_PREFIX)) throw error("authentication_required", 401);
      const session = store.state.sessions.find((item) => same(item.tokenHash, hash(token)));
      if (!sessionActive(session)) throw error("authentication_required", 401);
      if (now() - session.lastUsedAt >= MINUTE) await this.touchSession(session.id);
      if (!sessionActive(sessionById(session.id))) throw error("authentication_required", 401);
      return { sessionId: session.id, ownerSubjectId: store.state.ownerSubjectId, local: false };
    },
    sessionInfo(context) { const session = sessionById(context?.sessionId); if (!sessionActive(session)) throw error("authentication_required", 401); return info(session); },
    isSessionActive(id) { return sessionActive(sessionById(id)); },
    async touchSession(id) {
      const session = sessionById(id);
      if (!sessionActive(session)) throw error("authentication_required", 401);
      if (now() - session.lastUsedAt < MINUTE) return;
      if (touching.has(id)) return touching.get(id);
      const operation = change((state) => { const current = requireSession(state, { sessionId: id }); current.lastUsedAt = now(); }).finally(() => touching.delete(id));
      touching.set(id, operation); return operation;
    },
    assertReauthenticated(context) { requireSession(store.state, context, true); },
    listDevices(context) {
      if (!sessionActive(sessionById(context?.sessionId))) throw error("authentication_required", 401);
      return { devices: store.state.sessions.filter((session) => sessionActive(session)).map((session) => ({
        id: session.id, name: session.name, os: session.os, createdAt: new Date(session.createdAt).toISOString(),
        lastUsedAt: new Date(session.lastUsedAt).toISOString(), expiresAt: new Date(session.expiresAt).toISOString(), current: session.id === context.sessionId,
        notificationStatus: store.state.outbox.find((item) => item.sessionId === session.id)?.status || "unknown",
      })) };
    },
    revoke(context, id) { return change((state) => {
      requireSession(state, context, id !== context?.sessionId);
      const session = state.sessions.find((item) => item.id === id);
      if (session) session.revokedAt = now(); return { ok: true };
    }); },
    attachSocket(ws, context) {
      if (context.local) return;
      sockets.set(ws, context);
      const emit = ws.emit, send = ws.send;
      ws.emit = function (event, ...args) {
        if (event === "message") {
          if (!sessionActive(sessionById(context.sessionId))) { ws.close(4401, "authentication_required"); return false; }
          void thisLogin.touchSession(context.sessionId).catch(() => ws.close(4401, "authentication_required"));
        }
        return emit.call(this, event, ...args);
      };
      ws.send = function (...args) {
        if (!sessionActive(sessionById(context.sessionId))) { ws.close(4401, "authentication_required"); return; }
        return send.apply(this, args);
      };
      const thisLogin = this;
      ws.once("close", () => sockets.delete(ws));
    },
    flushOutbox,
    async close() {
      closing = true; clearInterval(timer);
      for (const ws of sockets.keys()) { if (ws.terminate) ws.terminate(); else ws.close(1001, "shutdown"); }
      sockets.clear();
      // In-flight mail may finish later, but change() now rejects every late write.
      // Drain only already-admitted storage transactions before releasing the lock.
      try { await store.close(); } finally { ready = false; }
    },
  };
}
