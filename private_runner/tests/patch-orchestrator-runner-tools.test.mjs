import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { patchOrchestratorRunnerTools } from "../scripts/patch-orchestrator-runner-tools.mjs";
import { createVoiceContextService } from "../src/voice-context-service.mjs";

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "runner-tools-patch-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const rootDir = path.join(temp, "v1"), owner = randomUUID();
  const context = createVoiceContextService({ rootDir, orchestratorId: "main", createClient: () => { throw new Error("No model calls during patching"); } });
  await context.open(); await context.close();
  const active = JSON.parse(await fs.readFile(path.join(rootDir, "active.json"), "utf8"));
  const files = [];
  for (const directory of [rootDir, path.join(rootDir, "scopes", randomUUID()),
    path.join(rootDir, "orchestrators", owner), path.join(rootDir, "orchestrators", owner, "scopes", randomUUID())]) {
    const logicalConversationId = directory === rootDir ? active.logicalConversationId : randomUUID();
    await fs.mkdir(path.join(directory, logicalConversationId), { recursive: true });
    const file = path.join(directory, "active.json"); files.push(file);
    await fs.writeFile(file, JSON.stringify({ ...active, logicalConversationId, nativeThreadId: `native-${files.length}`,
      nativeManagedSessionsEnabled: true, systemInstruction: "Keep user settings", completedCount: 5, readCompletedCount: 3 }));
    await fs.writeFile(path.join(directory, logicalConversationId, "events.jsonl"), "");
  }
  await fs.writeFile(path.join(rootDir, "orchestrators.json"), JSON.stringify({ orchestrators: [{ id: "main" }, { id: owner }], selectedId: owner }));
  const server = net.createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve));
  return { rootDir, files, owner, port, receipt: path.join(rootDir, "runner-tools-patch.json"),
    patch: (apply = false) => patchOrchestratorRunnerTools({ rootDir, runnerPort: port, codexPort: port, apply }) };
}
async function change(file, update) {
  const active = JSON.parse(await fs.readFile(file, "utf8")); update(active);
  await fs.writeFile(file, JSON.stringify(active));
}

test("offline patch covers every owner and scope, keeps backups and becomes a no-op after consumption", async (t) => {
  const f = await fixture(t);
  const helper = path.join(f.rootDir, "orchestrators", "maintenance-workspace");
  await fs.mkdir(helper); await fs.writeFile(path.join(helper, "keep.txt"), "Unregistered helper data");
  await change(f.files[1], (active) => { active.pendingSwitch = { parentGeneration: active.parentGeneration, turnSeq: 2, reason: "calendar" }; });
  await change(f.files[2], (active) => { active.pendingSwitch = { parentGeneration: active.parentGeneration, turnSeq: 2, reason: "learning" }; });
  await change(f.files[3], (active) => { delete active.parentGeneration; active.nativeManagedSessionsVersion = 1; });
  const originals = await Promise.all(f.files.map((file) => fs.readFile(file, "utf8")));
  assert.deepEqual(await f.patch(), { status: "dry_run", conversations: 4, updates: 4 });
  await assert.rejects(fs.stat(f.receipt), { code: "ENOENT" });
  assert.deepEqual(await Promise.all(f.files.map((file) => fs.readFile(file, "utf8"))), originals);
  assert.equal((await f.patch(true)).status, "applied");
  const receipt = JSON.parse(await fs.readFile(f.receipt, "utf8"));
  assert.equal(receipt.status, "applied"); assert.equal((await fs.stat(f.receipt)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(path.join(helper, "keep.txt"), "utf8"), "Unregistered helper data");
  assert.deepEqual(receipt.entries.map(({ before }) => before), originals);
  for (const [index, file] of f.files.entries()) {
    const saved = JSON.parse(await fs.readFile(file, "utf8")), original = JSON.parse(originals[index]);
    assert.equal(saved.nativeThreadId, original.nativeThreadId); assert.equal(saved.logicalConversationId, original.logicalConversationId);
    assert.equal(saved.systemInstruction, original.systemInstruction); assert.equal(saved.readCompletedCount, 3);
    assert.equal(saved.nativeManagedSessionsEnabled, undefined); assert.equal(saved.nativeManagedSessionsVersion, undefined);
    assert.equal(saved.pendingSwitch.reason, index === 1 ? "calendar" : "tools");
    assert.equal(saved.pendingSwitch.parentGeneration, saved.parentGeneration);
    if (index === 2) assert.equal(saved.pendingSwitch.turnSeq, 2);
    await change(file, (active) => { active.nativeThreadId = "new-native-parent"; delete active.pendingSwitch; });
  }
  const consumed = await Promise.all(f.files.map((file) => fs.readFile(file, "utf8")));
  assert.equal((await f.patch(true)).status, "already_applied");
  assert.deepEqual(await Promise.all(f.files.map((file) => fs.readFile(file, "utf8"))), consumed);
});

for (const pending of ["pendingDispatch", "pendingConfirmation", "journal", "delegate"]) test(`offline patch rejects ${pending} before writing any data`, async (t) => {
  const f = await fixture(t), file = f.files.at(-1);
  if (pending === "journal") {
    const active = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(path.join(path.dirname(file), active.logicalConversationId, "events.jsonl"), `${JSON.stringify({
      seq: 1, at: new Date().toISOString(), type: "accepted", text: "Still pending", clientOperationId: randomUUID() })}\n`);
  } else if (pending === "delegate") await fs.writeFile(path.join(f.rootDir, "subagents.json"), JSON.stringify([{ status: "awaiting_action" }]));
  else await change(file, (active) => { active[pending] = {}; });
  const originals = await Promise.all(f.files.map((file) => fs.readFile(file, "utf8")));
  await assert.rejects(f.patch(true), /unresolved operations|delegated operations/);
  await assert.rejects(fs.stat(f.receipt), { code: "ENOENT" });
  assert.deepEqual(await Promise.all(f.files.map((file) => fs.readFile(file, "utf8"))), originals);
  if (pending === "journal") {
    const active = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(path.join(path.dirname(file), active.logicalConversationId, "events.jsonl"), "");
    assert.equal((await f.patch(true)).status, "applied");
  }
});

test("offline patch rejects a running server and linked owner containers", async (t) => {
  const f = await fixture(t), server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await assert.rejects(patchOrchestratorRunnerTools({ rootDir: f.rootDir, runnerPort: server.address().port, codexPort: f.port, apply: true }), /is active/);
  await new Promise((resolve) => server.close(resolve));
  const owners = path.join(f.rootDir, "orchestrators"); await fs.rename(owners, `${owners}-original`);
  await fs.symlink(`${owners}-original`, owners);
  await assert.rejects(f.patch(true), /ordinary directories/);
  await assert.rejects(fs.stat(f.receipt), { code: "ENOENT" });
});

test("prepared patch resumes partial writes and refuses changed metadata or store membership", async (t) => {
  const f = await fixture(t); await f.patch(true);
  const receipt = JSON.parse(await fs.readFile(f.receipt, "utf8")); receipt.status = "prepared";
  for (const [index, item] of receipt.entries.entries()) await fs.writeFile(path.join(f.rootDir, item.file), index === 0 ? item.after : item.before);
  await fs.writeFile(f.receipt, JSON.stringify(receipt));
  assert.equal((await f.patch(true)).status, "applied");
  for (const item of receipt.entries) assert.equal(await fs.readFile(path.join(f.rootDir, item.file), "utf8"), item.after);
  await fs.writeFile(f.receipt, JSON.stringify(receipt));
  const changed = f.files.at(-1); await change(changed, (active) => { active.systemInstruction = "New user data"; });
  await assert.rejects(f.patch(true), /metadata changed/);
  assert.equal(JSON.parse(await fs.readFile(changed, "utf8")).systemInstruction, "New user data");
  await fs.writeFile(changed, receipt.entries.at(-1).after);
  await fs.mkdir(path.join(f.rootDir, "scopes", randomUUID()));
  await assert.rejects(f.patch(true), /ENOENT|stores changed/);
  assert.equal(JSON.parse(await fs.readFile(f.receipt, "utf8")).status, "prepared");
});


test("a failed metadata write leaves backups and a resumable prepared receipt", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const f = await fixture(t), blockedDirectory = path.dirname(f.files[2]);
  await fs.chmod(blockedDirectory, 0o500);
  try {
    await assert.rejects(f.patch(true), { code: "EACCES" });
    const receipt = JSON.parse(await fs.readFile(f.receipt, "utf8"));
    assert.equal(receipt.status, "prepared");
    assert.equal(await fs.readFile(f.files[0], "utf8"), receipt.entries[0].after);
    assert.equal(await fs.readFile(f.files[2], "utf8"), receipt.entries[2].before);
  } finally { await fs.chmod(blockedDirectory, 0o700); }
  assert.equal((await f.patch(true)).status, "applied");
});
