import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

export async function runnerLoginKey(directory, { create = false } = {}) {
  if (process.platform !== "darwin") throw new Error("runner_login_keychain_required");
  const account = createHash("sha256").update(directory).digest("hex");
  const run = (args, input) => new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", () => reject(new Error("runner_login_keychain_unavailable")));
    child.once("close", (code) => resolve({ code, output: output.trim() }));
    child.stdin.end(input);
  });
  let result = await run(["find-generic-password", "-a", account, "-s", "bitty-runner-login-master-key", "-w"]);
  if (result.code === 44 && create) {
    const value = randomBytes(32).toString("hex");
    // Feed the credential to security's interactive stdin, never to process arguments.
    await run(["-i"], `add-generic-password -a ${account} -s bitty-runner-login-master-key -w ${value}\n`);
    result = await run(["find-generic-password", "-a", account, "-s", "bitty-runner-login-master-key", "-w"]);
  }
  if (result.code === 44 && !create) return null;
  if (result.code !== 0 || !/^[a-f0-9]{64}$/.test(result.output)) throw new Error("runner_login_keychain_unavailable");
  return Buffer.from(result.output, "hex");
}

export function validateRunnerLoginState(state, at = Date.now()) {
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const uuid = (value) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
  const address = (value) => typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const encrypted = (value) => value && typeof value === "object" && typeof value.iv === "string" && Buffer.from(value.iv, "base64").length === 12
    && typeof value.tag === "string" && Buffer.from(value.tag, "base64").length === 16
    && typeof value.data === "string" && Buffer.from(value.data, "base64").length >= 20 && value.data.length <= 256;
  const text = (value, max = 120) => typeof value === "string" && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
  const owner = state?.owner;
  const budget = state?.budget;
  let valid = state?.version === 1 && /^(runner:[a-f0-9]{64}|owner:[a-f0-9-]{36})$/.test(state.ownerSubjectId)
    && integer(state.generation) && budget && integer(budget.windowAt) && integer(budget.sentAt)
    && budget.windowAt <= at + 30000 && budget.sentAt <= at + 30000
    && integer(budget.attempts) && budget.attempts <= 20 && integer(budget.sends) && budget.sends <= 10
    && Array.isArray(state.sessions) && state.sessions.length <= 250 && Array.isArray(state.challenges) && state.challenges.length <= 3
    && Array.isArray(state.outbox) && state.outbox.length <= 300
    && (owner === null || (address(owner?.email) && encrypted(owner.secret) && integer(owner.lastTotpStep)
      && Array.isArray(owner.recoveryHashes) && owner.recoveryHashes.length <= 8 && owner.recoveryHashes.every(digest)));
  if (valid) valid = state.sessions.every((session) => uuid(session.id) && digest(session.tokenHash) && integer(session.generation)
    && session.generation <= state.generation && integer(session.createdAt) && integer(session.lastUsedAt) && integer(session.expiresAt)
    && session.createdAt <= at + 30000 && session.lastUsedAt <= at + 30000
    && session.lastUsedAt >= session.createdAt && session.lastUsedAt < session.expiresAt
    && session.expiresAt - session.createdAt === 30 * 86400000 && integer(session.reauthenticatedUntil) && session.reauthenticatedUntil <= at + 5 * 60000
    && text(session.name) && text(session.os, 60) && text(session.location)
    && (session.revokedAt === undefined || (integer(session.revokedAt) && session.revokedAt >= session.createdAt)));
  if (valid) valid = state.challenges.every((challenge) => uuid(challenge.id) && digest(challenge.binding) && digest(challenge.codeHash)
    && ["login", "reauth", "recovery", "setup", "setup-confirm", "recovery-confirm"].includes(challenge.purpose)
    && integer(challenge.generation) && challenge.generation === state.generation && integer(challenge.createdAt) && integer(challenge.expiresAt)
    && challenge.createdAt <= at + 30000 && challenge.expiresAt - challenge.createdAt === 10 * 60000 && integer(challenge.attempts) && challenge.attempts <= 5
    && typeof challenge.valid === "boolean" && typeof challenge.delivered === "boolean" && (challenge.email === "" || address(challenge.email))
    && (challenge.sessionId === null || uuid(challenge.sessionId)) && (!challenge.purpose.endsWith("-confirm") || encrypted(challenge.secret)));
  if (valid) valid = state.outbox.every((item) => uuid(item.id) && (item.sessionId === null || uuid(item.sessionId)) && address(item.to)
    && ["login", "recovery", "reset"].includes(item.kind) && text(item.name) && text(item.os, 60) && text(item.location)
    && integer(item.at) && integer(item.nextAt) && integer(item.attempts) && item.attempts <= 5 && ["pending", "sent", "failed"].includes(item.status));
  if (valid) valid = new Set(state.sessions.map((item) => item.id)).size === state.sessions.length
    && new Set(state.sessions.map((item) => item.tokenHash)).size === state.sessions.length
    && new Set(state.challenges.map((item) => item.id)).size === state.challenges.length;
  if (!valid) throw new Error("runner_login_store_invalid");
}

export function createRunnerLoginStore(directory, { now = Date.now } = {}) {
  let root, lock, state, queue = Promise.resolve();
  const validate = async (target, kind, mode) => {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())
      || (stat.mode & 0o777) !== mode || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("runner_login_storage_permissions");
    }
  };
  const write = async (next) => {
    validateRunnerLoginState(next, now());
    const temporary = path.join(root, `${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(next) + "\n");
      await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, path.join(root, "state.json"));
      const parent = await fs.open(root, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } finally {
      await handle?.close();
      await fs.unlink(temporary).catch(() => {});
    }
  };
  return {
    async initialize(initial) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await validate(directory, "directory", 0o700);
      root = await fs.realpath(directory);
      lock = await fs.open(path.join(root, "writer.lock"), "wx", 0o600).catch(() => { throw new Error("runner_login_writer_locked"); });
      await lock.writeFile(String(process.pid)); await lock.sync();
      try {
        const file = path.join(root, "state.json");
        try {
          await validate(file, "file", 0o600);
          state = JSON.parse(await fs.readFile(file, "utf8"));
          validateRunnerLoginState(state, now());
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          state = initial; await write(state);
        }
        return state;
      } catch (error) { await this.close(); throw error; }
    },
    get directory() { return root; },
    get state() { return state; },
    transaction(operation) {
      const result = queue.then(async () => {
        const next = structuredClone(state);
        const value = await operation(next);
        await write(next);
        state = next;
        return value;
      });
      queue = result.catch(() => {});
      return result;
    },
    async close() {
      await queue;
      if (lock) { await lock.close(); lock = null; await fs.unlink(path.join(root, "writer.lock")); }
    },
  };
}
