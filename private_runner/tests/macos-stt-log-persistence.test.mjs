import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createMacosStreamingSttHandler } from "../src/macos-streaming-stt.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-macos-stt-log-test-"));
after(() => fs.rm(root, { recursive: true, force: true }));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-token";
for (const name of ["CODEX_AUTH_STORE_DIR", "BITTY_GOOGLE_AUTH_DIR", "CODEX_CLI_SESSIONS_DIR",
  "TTS_MEDIA_DIR", "LLM_REQUEST_LOG_DIR", "CLIENT_APP_LOG_DIR", "CODEX_WS_PROXY_DEBUG_LOG_DIR",
  "ACP_SESSION_STORE_PATH", "CLI_SESSION_INDEX_PATH", "PUSH_DEVICE_STORE_PATH", "CLIENT_STATE_STORE_PATH",
  "SKIA_BOARD_STORE_PATH", "LLM_FILE_AUDIT_LOG_PATH"]) {
  process.env[name] = path.join(root, name);
}
const { __TESTING__: { macosSttLog } } = await import("../src/server-runtime.mjs");

test("actual Runner log adapter persists correlated success and failure diagnostics without speech contents", async () => {
  const writes = [];
  const handler = createMacosStreamingSttHandler({
    startHelper: async () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdin = { end() {}, destroy() {} };
      child.kill = () => {};
      children.push(child);
      return child;
    },
    log: { info: (...entry) => writes.push(macosSttLog.info(...entry)) },
  });
  const children = [];
  for (const outcome of ["failure", "success"]) {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.send = () => {};
    ws.close = () => { ws.readyState = 3; ws.emit("close"); };
    handler(ws);
    ws.emit("message", Buffer.from('{"type":"start","sampleRate":16000}'), false);
    await new Promise((resolve) => setImmediate(resolve));
    const child = children.at(-1);
    const emit = (message) => child.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
    emit({ type: "ready" });
    if (outcome === "failure") {
      emit({ type: "error", code: "macos_recognition_failed",
        nativeErrorDomain: "kAFAssistantErrorDomain", nativeErrorCode: 1101,
        localizedDescription: "PRIVATE_DESCRIPTION", userInfo: { text: "PRIVATE_USER_INFO" } });
    } else {
      emit({ type: "transcript", text: "PRIVATE_TRANSCRIPT", isFinal: true });
      child.emit("close", 0);
    }
  }
  await Promise.all(writes);
  const [file] = await fs.readdir(process.env.CLIENT_APP_LOG_DIR);
  const text = await fs.readFile(path.join(process.env.CLIENT_APP_LOG_DIR, file), "utf8");
  const events = text.trim().split("\n").map((line) => JSON.parse(line));
  const failed = events.find((entry) => entry.event === "macos_failed");
  const done = events.find((entry) => entry.event === "macos_done_attempted");
  assert.equal(failed.source, "runner_stt");
  assert.equal(failed.payload.nativeErrorDomain, "kAFAssistantErrorDomain");
  assert.equal(failed.payload.nativeErrorCode, 1101);
  assert.equal(done.payload.hasSpeech, true);
  assert.notEqual(failed.sessionId, done.sessionId);
  assert.equal(events.filter((entry) => entry.event === "macos_starting").length, 2);
  assert.equal(events.filter((entry) => entry.event === "macos_ready").length, 2);
  assert.ok(events.every((entry) => entry.sessionId === entry.payload.streamId));
  assert.doesNotMatch(text, /PRIVATE_/);
});
