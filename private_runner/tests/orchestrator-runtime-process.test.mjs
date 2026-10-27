import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const supervisor = fileURLToPath(new URL("../src/orchestrator-runtime-process.mjs", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, message) {
  for (let attempt = 0; attempt < 120; attempt++) { if (await check()) return; await delay(50); }
  throw new Error(message);
}

test("IPC loss stops the old process group before a rapid replacement opens the same home", { timeout: 15_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrator-supervisor-"));
  const trace = path.join(home, "trace.jsonl");
  const binary = path.join(home, "fake-codex.mjs");
  await fs.writeFile(binary, `import {appendFileSync} from 'node:fs';\nconst trace=${JSON.stringify(trace)};\nconst record=(event)=>appendFileSync(trace,JSON.stringify({event,pid:process.pid})+'\\n');\nrecord('start');\nprocess.on('SIGTERM',()=>{record('stop');setTimeout(()=>{record('exit');process.exit(0)},400)});\nsetInterval(()=>{},1000);\n`);
  const children = [];
  const start = () => {
    const child = spawn(process.execPath, [supervisor, process.execPath, binary], {
      cwd: home, env: { PATH: process.env.PATH, CODEX_HOME: home }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr.resume(); children.push(child); return child;
  };
  t.after(async () => {
    for (const child of children) if (child.connected) child.disconnect();
    await Promise.all(children.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve))));
    await fs.rm(home, { recursive: true, force: true });
  });
  const events = async () => fs.readFile(trace, "utf8").then((text) => text.trim().split("\n").map((line) => JSON.parse(line)), () => []);
  const first = start();
  await waitFor(async () => (await events()).length === 1, "first runtime did not start");
  const firstPid = (await events())[0].pid;
  first.disconnect();
  const replacement = start();
  await waitFor(async () => (await events()).filter((event) => event.event === "start").length === 2, "replacement runtime did not start");
  const recorded = await events();
  assert.deepEqual(recorded.map((event) => event.event), ["start", "stop", "exit", "start"]);
  assert.notEqual(recorded[3].pid, firstPid);
  assert.throws(() => process.kill(firstPid, 0), { code: "ESRCH" });
  replacement.disconnect();
  await waitFor(async () => (await events()).length === 6, "replacement did not stop");
  await waitFor(async () => fs.stat(path.join(home, ".runtime-process.lock")).then(() => false, () => true), "runtime lock was not released");
});
