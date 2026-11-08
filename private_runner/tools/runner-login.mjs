#!/usr/bin/env node
import { requestControl, resolveControlSocket } from "../../skills/bitty-session-orchestrator/scripts/runner-control.mjs";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import qrcode from "qrcode-terminal";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const action = process.argv[2] || "setup";
if (action === "--help") {
  console.log("Usage: node private_runner/tools/runner-login.mjs [setup|reset|unlock]\nRun setup/reset on the owner's Mac terminal. unlock requires a stopped Runner.");
  process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Owner setup requires a local interactive terminal");
const logs = await fs.realpath(path.join(repository, "private_runner/logs"));
const directory = path.resolve(process.env.RUNNER_LOGIN_DIRECTORY || path.join(logs, "runner-login"));
const socketPath = await resolveControlSocket(repository);
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  if (action === "unlock") {
    const lock = path.join(directory, "writer.lock");
    const stat = await fs.lstat(lock).catch((failure) => { if (failure.code !== "ENOENT") throw failure; return null; });
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error("Unsafe writer lock");
      const pid = Number(await fs.readFile(lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Invalid writer lock; inspect manually");
      try { process.kill(pid, 0); throw new Error("Runner process still exists; do not unlock"); }
      catch (failure) { if (failure.code !== "ESRCH") throw failure; }
    }
    const socket = await fs.lstat(socketPath).catch((failure) => { if (failure.code !== "ENOENT") throw failure; return null; });
    if (socket) {
      if (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o777) !== 0o600) throw new Error("Unsafe control socket");
      await new Promise((resolve, reject) => {
        const probe = net.createConnection({ path: socketPath });
        probe.setTimeout(3000, () => probe.destroy(new Error("Could not verify stopped control socket")));
        probe.once("connect", () => { probe.destroy(); reject(new Error("Control socket is live; do not unlock")); });
        probe.once("error", (failure) => { if (["ECONNREFUSED", "ENOENT"].includes(failure.code)) resolve(); else reject(failure); });
      });
    }
    if (!stat && !socket) throw new Error("No stale control files");
    if (await rl.question("Stopped Runner confirmed. Type UNLOCK to remove stale lock/socket: ") !== "UNLOCK") throw new Error("Cancelled");
    const current = await fs.lstat(lock).catch((failure) => { if (failure.code !== "ENOENT") throw failure; return null; });
    if (stat ? (!current || current.ino !== stat.ino || current.dev !== stat.dev) : current) throw new Error("Writer lock changed");
    if (stat) await fs.unlink(lock);
    if (socket) {
      const currentSocket = await fs.lstat(socketPath);
      if (currentSocket.ino !== socket.ino || currentSocket.dev !== socket.dev) throw new Error("Control socket changed");
      await fs.unlink(socketPath);
    }
    console.log("Stale control files removed; authentication state preserved.");
  } else {
    if (!["setup", "reset"].includes(action)) throw new Error("Unknown action");
    const tokenPath = process.env.RUNNER_TOKEN_FILE || path.join(logs, "runner-token");
    const file = path.resolve(repository, tokenPath);
    const stat = await fs.lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    let token;
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error("Unsafe local credential file");
      token = (await fs.readFile(file, "utf8")).trim();
    } else {
      token = process.env.RUNNER_TOKEN;
    }
    if (!token) throw new Error("Local credential is missing");
    const request = async (route, input) => {
      const response = await requestControl(socketPath, route, { method: "POST", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json",
      }, body: JSON.stringify(input) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Request failed");
      return value;
    };
    if (action === "reset") {
      const answer = await rl.question("All remote sessions and authentication factors will be reset. Type RESET OWNER: ");
      if (answer !== "RESET OWNER") throw new Error("Cancelled");
      await request("/auth/setup/reset", { confirm: answer });
      console.log("Owner reset. Existing owner identity and conversation ACLs are preserved; run setup again.");
    } else {
      const email = await rl.question("Owner email: ");
      const clientBinding = randomBytes(32).toString("base64url");
      const start = await request("/auth/setup/start", { email, clientBinding });
      const emailCode = await rl.question("Email verification code: ");
      const prepared = await request("/auth/setup/prepare", { ...start, clientBinding, emailCode });
      console.log("Scan this private QR in your Authenticator. Do not share or save it.");
      qrcode.generate(prepared.uri, { small: true });
      const totpCode = await rl.question("Authenticator code: ");
      if (await rl.question("Ready to save recovery codes securely? Type SAVE: ") !== "SAVE") throw new Error("Cancelled");
      const result = await request("/auth/setup/complete", { setupId: prepared.setupId, clientBinding, totpCode });
      console.log("Recovery codes (shown once):\n" + result.recoveryCodes.join("\n"));
      console.log("Owner registered. Use the app's connection QR, then email code and Authenticator to log in.");
    }
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally { rl.close(); }
