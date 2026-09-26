import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createMacosStreamingSttHandler } from "../src/macos-streaming-stt.mjs";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit("close"); }
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  writes = [];
  stdin = {
    write: (buffer, callback) => { this.writes.push(Buffer.from(buffer)); callback(); },
    end: () => { this.ended = true; },
    destroy: () => {},
  };
  kill() { this.killed = true; }
  emitMessage(message) { this.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`)); }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const start = (ws) => ws.emit("message", Buffer.from('{"type":"start","sampleRate":16000}'), false);

test("macOS stream sends progressive transcript, detects silence, and completes without Google usage", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  createMacosStreamingSttHandler({ startHelper: async () => child })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  assert.deepEqual(ws.sent, [{ type: "ready" }]);

  const voiced = Buffer.alloc(6400);
  for (let offset = 0; offset < voiced.length; offset += 2) voiced.writeInt16LE(4000, offset);
  ws.emit("message", voiced, true);
  await tick();
  child.emitMessage({ type: "transcript", text: "こんにちは", isFinal: false });
  ws.emit("message", Buffer.alloc(28_800), true);
  await tick();
  assert.equal(child.ended, true);
  child.emitMessage({ type: "transcript", text: "こんにちは。", isFinal: true });
  child.emit("close", 0);
  assert.equal(ws.readyState, 3);
  assert.deepEqual(ws.sent.map((message) => message.type), [
    "ready", "speech_activity_begin", "transcript", "speech_activity_end", "transcript", "done",
  ]);
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "speech_end_timeout", hasSpeech: true });
  assert.equal(child.writes.length, 2);
});

test("macOS speech permission failure is explicit and never falls back", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  createMacosStreamingSttHandler({ startHelper: async () => child })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "error", code: "macos_speech_permission_denied" });
  assert.deepEqual(ws.sent, [{
    type: "error", code: "macos_speech_permission_denied",
    message: "Runner Macのシステム設定でBitty Private Runner Speechの音声認識を許可してください。",
    retryable: false,
  }]);
  assert.equal(child.killed, true);
});

test("native no-speech error after timeout completes without a spurious failure", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  createMacosStreamingSttHandler({ startHelper: async () => child, noSpeechTimeoutMs: 5 })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(child.ended, true);
  child.emitMessage({ type: "error", code: "macos_recognition_failed" });
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "no_speech_timeout", hasSpeech: false });
});
