import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// IPC EOF survives a Runner crash. The lock keeps a replacement Runner from
// opening the same Codex home until this supervisor has stopped the old group.
const lock = path.join(process.env.CODEX_HOME, ".runtime-process.lock");
const claim = `${lock}.${process.pid}.${randomUUID()}`;
let ownsLock = false;
let child;
let stopping = false;
let timer;
const signalGroup = (signal) => {
  try {
    if (process.platform !== "win32" && child?.pid) process.kill(-child.pid, signal);
    else child?.kill(signal);
  } catch {}
};
const stop = () => {
  if (stopping) return;
  stopping = true;
  signalGroup("SIGTERM");
  timer = setTimeout(() => signalGroup("SIGKILL"), 2_000);
};
const finish = async (code) => {
  clearTimeout(timer);
  signalGroup("SIGKILL");
  if (ownsLock && await fs.readFile(lock, "utf8").catch(() => "") === String(process.pid)) {
    await fs.unlink(lock).catch(() => {});
  }
  await fs.unlink(claim).catch(() => {});
  process.exit(code || 0);
};
process.once("disconnect", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
if (!process.connected) stop();

try {
  await fs.writeFile(claim, String(process.pid), { flag: "wx", mode: 0o600 });
  for (let attempt = 0; attempt < 160 && !stopping; attempt++) {
    try {
      await fs.link(claim, lock);
      ownsLock = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.lstat(lock).catch((failure) => { if (failure.code !== "ENOENT") throw failure; return null; });
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()
        || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Unsafe runtime lock");
      const contents = await fs.readFile(lock, "utf8").catch((failure) => { if (failure.code !== "ENOENT") throw failure; return null; });
      if (contents === null) continue;
      const pid = Number(contents);
      let alive = true;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (failure) { if (failure.code === "ESRCH") alive = false; }
      }
      if (!alive) await fs.unlink(lock).catch(() => {});
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!ownsLock || stopping) await finish(1);
  const [codexBin, ...args] = process.argv.slice(2);
  child = spawn(codexBin, args, { env: process.env, stdio: ["ignore", "ignore", "inherit"],
    detached: process.platform !== "win32", shell: false });
  child.once("error", () => void finish(1));
  child.once("exit", (code) => void finish(code));
  if (stopping) signalGroup("SIGTERM");
} catch { await finish(1); }
