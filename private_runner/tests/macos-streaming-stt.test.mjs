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
const pcm = (sample, durationMs) => {
  const buffer = Buffer.alloc(durationMs * 32);
  for (let offset = 0; offset < buffer.length; offset += 2) buffer.writeInt16LE(sample, offset);
  return buffer;
};

test("macOS stream sends progressive transcript, detects silence, and completes without Google usage", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  const logs = [];
  createMacosStreamingSttHandler({ startHelper: async () => child, log: { info: (...entry) => logs.push(entry) } })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  assert.deepEqual(ws.sent, [{ type: "ready" }]);

  const voiced = pcm(4000, 200);
  ws.emit("message", voiced, true);
  await tick();
  child.emitMessage({ type: "transcript", text: "こんにちは", isFinal: false });
  ws.emit("message", pcm(0, 2_000), true);
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
  assert.equal(logs[0][0], "[stream-stt] macos_input_ended");
  assert.equal(logs[0][1].trigger, "pcm_silence");
  assert.equal(logs[0][1].silentMs, 2_000);
});

test("quiet ongoing speech and short pauses do not end the macOS stream", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  const logs = [];
  createMacosStreamingSttHandler({ startHelper: async () => child, log: { info: (...entry) => logs.push(entry) } })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });

  ws.emit("message", pcm(400, 200), true);
  await tick();
  child.emitMessage({ type: "transcript", text: "小さい声", isFinal: false });
  ws.emit("message", pcm(100, 1_000), true);
  await tick();
  assert.equal(child.ended, undefined);
  ws.emit("message", pcm(400, 200), true);
  await tick();
  ws.emit("message", pcm(100, 1_000), true);
  await tick();
  assert.equal(child.ended, undefined);
  ws.emit("message", pcm(100, 1_000), true);
  await tick();
  assert.equal(child.ended, true);
  assert.equal(logs[0][1].trigger, "pcm_silence");
  assert.equal(logs[0][1].maxSilentRms, 0.0031);
  assert.equal(logs[0][1].vadThreshold, 0.005);
  assert.equal(JSON.stringify(logs).includes("小さい声"), false);
});

test("Apple final and user stop remain distinct terminal triggers", async () => {
  for (const trigger of ["apple_final", "user_stop"]) {
    const ws = new FakeSocket();
    const child = new FakeChild();
    const logs = [];
    createMacosStreamingSttHandler({ startHelper: async () => child, log: { info: (...entry) => logs.push(entry) } })(ws);
    start(ws);
    await tick();
    child.emitMessage({ type: "ready" });
    child.emitMessage({ type: "transcript", text: "途中", isFinal: false });
    if (trigger === "apple_final") child.emitMessage({ type: "transcript", text: "確定", isFinal: true });
    else ws.emit("message", Buffer.from('{"type":"stop"}'), false);
    await tick();
    assert.equal(child.ended, true);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][1].trigger, trigger);
    assert.equal(JSON.stringify(logs).includes("途中"), false);
    assert.equal(JSON.stringify(logs).includes("確定"), false);
    child.emit("close", 0);
    assert.equal(ws.sent.at(-1).reason, trigger === "apple_final" ? "speech_end_timeout" : "user_stop");
  }
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
  const logs = [];
  createMacosStreamingSttHandler({
    startHelper: async () => child, noSpeechTimeoutMs: 5, log: { info: (...entry) => logs.push(entry) },
  })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(child.ended, true);
  assert.equal(logs[0][1].trigger, "no_speech_timeout");
  child.emitMessage({ type: "error", code: "macos_recognition_failed" });
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "no_speech_timeout", hasSpeech: false });
});
