import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readVoiceEventState } from "../src/voice-context-service.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT = "runner-tools-patch.json";
const record = (value) => value && typeof value === "object" && !Array.isArray(value);

async function readFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Patch requires ordinary files without links");
  return fs.readFile(file, "utf8");
}
async function readOptional(file) {
  try { return await readFile(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function entries(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Patch requires ordinary directories without links");
  return fs.readdir(directory, { withFileTypes: true });
}
async function assertStopped(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Runner and Codex ports must be specified explicitly");
  for (const host of ["127.0.0.1", "::1"]) await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); reject(new Error(`Port ${port} is active. Stop Runner and Codex before patching.`)); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`Could not verify stopped port ${port}`)); });
    socket.once("error", (error) => {
      socket.destroy();
      if (["ECONNREFUSED", "EAFNOSUPPORT"].includes(error.code)) resolve(); else reject(error);
    });
  });
}
async function writeFile(file, text, replace = true) {
  const temporary = replace ? `${file}.${randomUUID()}.tmp` : file;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text); await handle.sync(); await handle.close();
    if (replace) await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle.close().catch(() => {});
    if (replace) await fs.rm(temporary, { force: true });
    throw error;
  }
}
function patched(active) {
  const next = { ...active };
  delete next.nativeManagedSessionsEnabled;
  delete next.nativeManagedSessionsVersion;
  if (active.nativeThreadId && (!active.pendingSwitch || active.pendingSwitch.reason === "learning")) {
    next.parentGeneration = active.parentGeneration || 0;
    next.pendingSwitch = { parentGeneration: next.parentGeneration,
      turnSeq: active.pendingSwitch?.turnSeq || Math.max(1, active.turnSeq || 0), reason: "tools" };
  }
  return JSON.stringify(next);
}

// One-off, offline data repair. This module is never imported by the Runner startup or turn path.
export async function patchOrchestratorRunnerTools({ rootDir, runnerPort, codexPort, apply = false }) {
  await assertStopped(runnerPort); await assertStopped(codexPort);
  const root = await fs.realpath(rootDir), receiptFile = path.join(root, RECEIPT);
  const saved = await readOptional(receiptFile);
  const receipt = saved === null ? null : JSON.parse(saved);
  if (receipt && (!record(receipt) || !["prepared", "applied"].includes(receipt.status) || !Array.isArray(receipt.entries)))
    throw new Error("Invalid Runner tools patch receipt; preserve it and inspect before retrying");
  if (receipt?.status === "applied") return { status: "already_applied", receipt: receiptFile };

  const registryText = await readOptional(path.join(root, "orchestrators.json"));
  if (receipt && receipt.registryText !== registryText) throw new Error("Orchestration registry changed after patch preparation; inspect the patch receipt");
  const registry = registryText === null ? { orchestrators: [{ id: "main" }] } : JSON.parse(registryText);
  if (!Array.isArray(registry.orchestrators) || registry.orchestrators[0]?.id !== "main"
    || !registry.orchestrators.every((item) => record(item) && (item.id === "main" || UUID.test(item.id)))
    || new Set(registry.orchestrators.map(({ id }) => id)).size !== registry.orchestrators.length)
    throw new Error("Invalid orchestration registry");
  try { await entries(path.join(root, "orchestrators")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const delegatesText = await readOptional(path.join(root, "subagents.json"));
  const delegates = delegatesText === null ? [] : JSON.parse(delegatesText);
  if (!Array.isArray(delegates) || delegates.some((item) => !["completed", "failed", "interrupted"].includes(item?.status)))
    throw new Error("Finish or interrupt delegated operations in the old Runner before patching");
  const stores = new Map();
  for (const { id } of registry.orchestrators) {
    const owner = id === "main" ? root : path.join(root, "orchestrators", id);
    await entries(owner);
    const directories = [owner];
    const scopes = path.join(owner, "scopes");
    let scopeEntries;
    try { scopeEntries = await entries(scopes); } catch (error) { if (error.code !== "ENOENT") throw error; scopeEntries = []; }
    for (const entry of scopeEntries) {
      if (entry.name === ".DS_Store") continue;
      if (!entry.isDirectory() || !UUID.test(entry.name)) throw new Error("Invalid conversation scope");
      const directory = path.join(scopes, entry.name); await entries(directory); directories.push(directory);
    }
    for (const directory of directories) {
      const file = path.join(directory, "active.json"), before = await readFile(file), active = JSON.parse(before);
      if (!record(active) || active.isolationVersion !== 1 || !UUID.test(active.logicalConversationId)
        || active.nativeThreadId != null && (typeof active.nativeThreadId !== "string" || !active.nativeThreadId)
        || active.parentGeneration !== undefined && (!Number.isSafeInteger(active.parentGeneration) || active.parentGeneration < 0)
        || active.turnSeq !== undefined && (!Number.isSafeInteger(active.turnSeq) || active.turnSeq < 0)
        || active.pendingSwitch !== undefined && (!record(active.pendingSwitch)
          || active.pendingSwitch.parentGeneration !== active.parentGeneration
          || !Number.isSafeInteger(active.pendingSwitch.turnSeq) || active.pendingSwitch.turnSeq < 1
          || !["topic", "message_limit", "settings", "memory", "checklist", "calendar", "tools", "learning"].includes(active.pendingSwitch.reason)))
        throw new Error("Invalid isolated conversation metadata");
      await entries(path.join(directory, active.logicalConversationId));
      const events = readVoiceEventState(Buffer.from(await readFile(path.join(directory, active.logicalConversationId, "events.jsonl"))), active.prunedThroughPairSeq || 0);
      if (active.pendingDispatch || active.pendingConfirmation || events.unresolvedOperationIds.length)
        throw new Error("Finish or interrupt unresolved operations and confirmations in the old Runner before patching");
      stores.set(path.relative(root, file).split(path.sep).join("/"), { before, after: patched(active) });
    }
  }
  const plan = receipt?.entries || [...stores].map(([file, value]) => ({ file, ...value }));
  if (plan.length !== stores.size || new Set(plan.map((item) => item?.file)).size !== plan.length)
    throw new Error("Conversation stores changed after patch preparation; inspect the patch receipt");
  for (const item of plan) {
    if (!record(item) || !stores.has(item.file) || typeof item.before !== "string" || typeof item.after !== "string"
      || patched(JSON.parse(item.before)) !== item.after) throw new Error("Invalid Runner tools patch receipt");
    const current = stores.get(item.file).before;
    if (current !== item.before && current !== item.after) throw new Error("Conversation metadata changed after patch preparation; refusing to overwrite it");
  }
  const updates = plan.filter((item) => item.before !== item.after).length;
  if (!apply) return { status: "dry_run", conversations: stores.size, updates };
  await assertStopped(runnerPort); await assertStopped(codexPort);
  if (!receipt) await writeFile(receiptFile, JSON.stringify({ status: "prepared", registryText, entries: plan }), false);
  for (const item of plan) {
    const file = path.join(root, item.file), current = await readFile(file);
    if (current === item.after) continue;
    if (current !== item.before) throw new Error("Conversation metadata changed during patching; refusing to overwrite it");
    await writeFile(file, item.after);
  }
  await writeFile(receiptFile, JSON.stringify({ status: "applied", registryText, entries: plan }));
  return { status: "applied", conversations: stores.size, updates, receipt: receiptFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (![6, 7].includes(args.length) || args[0] !== "--root" || args[2] !== "--runner-port" || args[4] !== "--codex-port"
    || args.length === 7 && args[6] !== "--apply") {
    process.stderr.write("Usage: node patch-orchestrator-runner-tools.mjs --root <context/v1> --runner-port <port> --codex-port <port> [--apply]\n");
    process.exitCode = 1;
  } else {
    try { process.stdout.write(`${JSON.stringify(await patchOrchestratorRunnerTools({ rootDir: args[1], runnerPort: Number(args[3]),
      codexPort: Number(args[5]), apply: args[6] === "--apply" }))}\n`); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
