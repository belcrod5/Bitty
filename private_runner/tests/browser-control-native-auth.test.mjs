import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { readBrowserControlNativeKey, authenticateBrowserControlNativeKey } from "../src/browser-control-native-auth.mjs";
import { installRunnerWebSocketUpgradeHandler } from "../src/runner-websocket-upgrade.mjs";
import { runnerBearerToken } from "../src/runner-login-http.mjs";

async function key(t) {
  const directory = await fs.realpath(await fs.mkdtemp("/tmp/bitty-native-key-")), file = path.join(directory, "native-key"), value = randomBytes(32).toString("base64url");
  await fs.chmod(directory, 0o700); await fs.writeFile(file, value, { mode: 0o600 });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file, value };
}
test("native key requires an owner-only regular file in a safe directory and compares credentials without exposing them", async (t) => {
  const f = await key(t); assert.equal(await readBrowserControlNativeKey(f.file), f.value);
  await authenticateBrowserControlNativeKey(f.value, f.file);
  for (const value of [undefined, "", "wrong", "x".repeat(43)]) await assert.rejects(authenticateBrowserControlNativeKey(value, f.file), (error) => !error.message.includes(f.value));
  await fs.chmod(f.file, 0o644); await assert.rejects(readBrowserControlNativeKey(f.file)); await fs.chmod(f.file, 0o600);
  await fs.chmod(f.directory, 0o777); await assert.rejects(readBrowserControlNativeKey(f.file)); await fs.chmod(f.directory, 0o700);
  const link = path.join(f.directory, "link"); await fs.symlink(f.file, link); await assert.rejects(readBrowserControlNativeKey(link));
  await fs.writeFile(f.file, "invalid"); await assert.rejects(readBrowserControlNativeKey(f.file)); await fs.unlink(f.file); await assert.rejects(readBrowserControlNativeKey(f.file));
});
test("native credentials authorize only the dedicated local route; master/device/query credentials do not", async (t) => {
  const f = await key(t), server = new EventEmitter(), accepted = [], logs = [];
  const wsServer = (name) => ({ handleUpgrade: (_req, _socket, _head, done) => { accepted.push(name); done({}); }, emit() {} });
  installRunnerWebSocketUpgradeHandler({ server, runnerWsPath: "/runner-ws", runnerWsServer: wsServer("generic"), browserExtensionWsServer: wsServer("native"),
    authenticate: async (req) => { if (runnerBearerToken(req) !== "MASTER") throw new Error(); return { local: true }; },
    authenticateBrowserExtension: async (req) => { await authenticateBrowserControlNativeKey(runnerBearerToken(req), f.file); return { local: true, ownerSubjectId: "current-owner" }; },
    appendDebug: (...args) => logs.push(args) });
  const upgrade = async (url, credential) => {
    const socket = { destroyed: false, write() {}, destroy() { this.destroyed = true; } };
    server.emit("upgrade", { url, headers: credential ? { authorization: `Bearer ${credential}` } : {}, socket: {} }, socket, Buffer.alloc(0));
    await new Promise((r) => setTimeout(r, 10)); return !socket.destroyed;
  };
  assert.equal(await upgrade("/runner-ws", f.value), false);
  for (const credential of ["MASTER", "DEVICE", ""]) assert.equal(await upgrade("/browser-extension", credential), false);
  assert.equal(await upgrade(`/browser-extension?token=${f.value}`, ""), false);
  assert.equal(await upgrade("/browser-extension", f.value), true);
  assert.deepEqual(accepted, ["native"]); assert.equal(JSON.stringify(logs).includes(f.value), false);
});
