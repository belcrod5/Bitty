import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createMacosStreamingSttHandler } from "../src/macos-streaming-stt.mjs";
import { MAX_DURATION_SECONDS } from "../src/streaming-stt-protocol.mjs";

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
  ws.emit("message", pcm(0, 1_250), true);
  await tick();
  assert.equal(child.ended, true);
  child.emitMessage({ type: "transcript", text: "こんにちは。", isFinal: true });
  child.emit("close", 0);
  assert.equal(ws.readyState, 3);
  assert.deepEqual(ws.sent.map((message) => message.type), [
    "ready", "speech_activity_begin", "transcript", "speech_activity_end", "transcript", "done",
  ]);
  assert.deepEqual(ws.sent.at(-2), {
    type: "transcript", text: "こんにちは。", isFinal: true, stability: 1,
  });
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "speech_end_timeout", hasSpeech: true });
  assert.equal(child.writes.length, 2);
  const inputEnded = logs.find(([event]) => event === "[stream-stt] macos_input_ended")[1];
  assert.equal(inputEnded.trigger, "pcm_silence");
  assert.equal(inputEnded.silentMs, 1_250);
  assert.equal(inputEnded.vadEndMs, 1_250);
  assert.deepEqual(logs.map(([event]) => event), [
    "[stream-stt] macos_starting",
    "[stream-stt] macos_ready",
    "[stream-stt] macos_input_ended",
    "[stream-stt] macos_final_transcript",
    "[stream-stt] macos_done_attempted",
  ]);
  const final = logs.find(([event]) => event === "[stream-stt] macos_final_transcript")[1];
  const done = logs.find(([event]) => event === "[stream-stt] macos_done_attempted")[1];
  assert.equal(final.cumulativeChars, "こんにちは。".length);
  assert.equal(final.lastPartialChars, "こんにちは".length);
  assert.equal(final.nativeHadText, true);
  assert.ok(final.finalizationMs >= 0);
  assert.equal(done.hasSpeech, true);
  assert.equal(done.lastPartialChars, "こんにちは".length);
  assert.ok(done.finalizationMs >= 0);
  assert.equal(JSON.stringify(logs).includes("こんにちは"), false);
});

test("empty native final commits the last nonempty partial and diagnoses the fallback", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  const logs = [];
  createMacosStreamingSttHandler({ startHelper: async () => child, log: { info: (...entry) => logs.push(entry) } })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  child.emitMessage({ type: "transcript", text: "秘密の途中結果", isFinal: false });
  child.emitMessage({ type: "transcript", text: "", isFinal: true });
  child.emit("close", 0);
  assert.deepEqual(ws.sent.find((message) => message.type === "transcript" && message.isFinal), {
    type: "transcript", text: "秘密の途中結果", isFinal: true, stability: 1,
  });
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "recognition_segment_end", hasSpeech: true });
  const final = logs.find(([event]) => event === "[stream-stt] macos_final_transcript")[1];
  const done = logs.find(([event]) => event === "[stream-stt] macos_done_attempted")[1];
  assert.equal(final.chars, 0);
  assert.equal(final.nativeHadText, false);
  assert.equal(final.cumulativeChars, 0);
  assert.equal(logs.find(([event]) => event === "[stream-stt] macos_partial_fallback")[1].chars, "秘密の途中結果".length);
  assert.equal(final.lastPartialChars, "秘密の途中結果".length);
  assert.equal(done.hasSpeech, true);
  assert.equal(done.lastPartialChars, "秘密の途中結果".length);
  assert.equal(JSON.stringify(logs).includes("秘密の途中結果"), false);
});

test("silence-ended macOS stream commits only the latest nonempty partial when native final is blank", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  const logs = [];
  createMacosStreamingSttHandler({ startHelper: async () => child, log: { info: (...entry) => logs.push(entry) } })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  child.emitMessage({ type: "transcript", text: "古い", isFinal: false });
  child.emitMessage({ type: "transcript", text: "新しい途中結果", isFinal: false });
  ws.emit("message", pcm(0, 1_250), true);
  await tick();
  assert.equal(child.ended, true);
  child.emitMessage({ type: "transcript", text: " \t", isFinal: true });
  child.emit("close", 0);
  assert.deepEqual(ws.sent.at(-2), {
    type: "transcript", text: "新しい途中結果", isFinal: true, stability: 1,
  });
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "speech_end_timeout", hasSpeech: true });
  const final = logs.find(([event]) => event === "[stream-stt] macos_final_transcript")[1];
  assert.equal(final.chars, 2);
  assert.equal(final.nativeHadText, false);
  assert.equal(JSON.stringify(logs).includes("新しい途中結果"), false);
});

test("empty native final without a nonempty partial remains no speech", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  const logs = [];
  createMacosStreamingSttHandler({ startHelper: async () => child, log: { info: (...entry) => logs.push(entry) } })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  child.emitMessage({ type: "transcript", text: " \t", isFinal: false });
  child.emitMessage({ type: "transcript", text: "", isFinal: true });
  child.emit("close", 0);
  assert.equal(ws.sent.some((message) => message.type === "transcript"), false);
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "recognition_segment_end", hasSpeech: false });
  const final = logs.find(([event]) => event === "[stream-stt] macos_final_transcript")[1];
  assert.equal(final.nativeHadText, false);
  assert.equal(final.lastPartialChars, 0);
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
  ws.emit("message", pcm(100, 1_249), true);
  await tick();
  assert.equal(child.ended, undefined);
  ws.emit("message", pcm(400, 200), true);
  await tick();
  ws.emit("message", pcm(100, 1_249), true);
  await tick();
  assert.equal(child.ended, undefined);
  ws.emit("message", pcm(100, 1), true);
  await tick();
  assert.equal(child.ended, true);
  const inputEnded = logs.find(([event]) => event === "[stream-stt] macos_input_ended")[1];
  assert.equal(inputEnded.trigger, "pcm_silence");
  assert.equal(inputEnded.silentMs, 1_250);
  assert.equal(inputEnded.vadEndMs, 1_250);
  assert.equal(inputEnded.maxSilentRms, 0.0031);
  assert.equal(inputEnded.vadThreshold, 0.005);
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
    assert.equal(logs.filter(([event]) => event === "[stream-stt] macos_input_ended").length, 1);
    assert.equal(logs.find(([event]) => event === "[stream-stt] macos_input_ended")[1].trigger, trigger);
    assert.equal(JSON.stringify(logs).includes("途中"), false);
    assert.equal(JSON.stringify(logs).includes("確定"), false);
    child.emit("close", 0);
    assert.equal(ws.sent.at(-1).reason, trigger === "apple_final" ? "recognition_segment_end" : "user_stop");
  }
});

test("macOS stream logs a close before done without recording transcript content", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  const logs = [];
  createMacosStreamingSttHandler({ startHelper: async () => child, log: { info: (...entry) => logs.push(entry) } })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  child.emitMessage({ type: "transcript", text: "記録しない", isFinal: true });
  ws.close();
  assert.equal(logs.at(-1)[0], "[stream-stt] macos_closed_before_done");
  assert.equal(logs.at(-1)[1].finalHadText, true);
  assert.equal(JSON.stringify(logs).includes("記録しない"), false);
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
  assert.equal(logs.find(([event]) => event === "[stream-stt] macos_input_ended")[1].trigger, "no_speech_timeout");
  child.emitMessage({
    type: "error", code: "macos_recognition_failed",
    nativeErrorDomain: "kAFAssistantErrorDomain", nativeErrorCode: 1110,
  });
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "no_speech_timeout", hasSpeech: false });
});

test("native no-speech completion commits its visible partial once for the next segment", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  createMacosStreamingSttHandler({ startHelper: async () => child, log: {} })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  child.emitMessage({ type: "transcript", text: "前の文章", isFinal: false });
  child.emitMessage({
    type: "error", code: "macos_recognition_failed",
    nativeErrorDomain: "kAFAssistantErrorDomain", nativeErrorCode: 1110,
  });
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "recognition_segment_end", hasSpeech: true });
  assert.deepEqual(ws.sent.filter((message) => message.type === "transcript"), [
    { type: "transcript", text: "前の文章", isFinal: false, stability: 0 },
    { type: "transcript", text: "前の文章", isFinal: true, stability: 1 },
  ]);
  assert.equal(ws.sent.some((message) => message.type === "error"), false);
});

test("Apple no-speech completion tolerates PCM activity and preserves the stop reason", async () => {
  for (const outcome of ["ready", "pcm_silence", "user_stop"]) {
    const ws = new FakeSocket();
    const child = new FakeChild();
    const logs = [];
    createMacosStreamingSttHandler({ startHelper: async () => child, log: { info: (...entry) => logs.push(entry) } })(ws);
    start(ws);
    await tick();
    child.emitMessage({ type: "ready" });
    if (outcome === "pcm_silence") {
      ws.emit("message", pcm(4000, 200), true);
      await tick();
      ws.emit("message", pcm(0, 1_250), true);
      await tick();
      assert.equal(child.ended, true);
      assert.ok(ws.sent.some((message) => message.type === "speech_activity_begin"));
    } else if (outcome === "user_stop") {
      ws.emit("message", Buffer.from('{"type":"stop"}'), false);
      await tick();
    }
    child.emitMessage({
      type: "error", code: "macos_recognition_failed",
      nativeErrorDomain: "kAFAssistantErrorDomain", nativeErrorCode: 1110, recognizerAvailable: true,
    });
    assert.deepEqual(ws.sent.at(-1), {
      type: "done", reason: outcome === "ready" ? "no_speech_timeout"
        : outcome === "user_stop" ? "user_stop" : "speech_end_timeout", hasSpeech: false,
    });
    assert.equal(ws.sent.some((message) => message.type === "error"), false);
    assert.equal(child.killed, true);
    assert.equal(ws.readyState, 3);
    const nativeError = logs.find(([event]) => event === "[stream-stt] macos_no_speech_error")[1];
    assert.equal(nativeError.nativeErrorCode, 1110);
    assert.equal(nativeError.recognizerAvailable, true);
    assert.equal(nativeError.speechBegan, outcome === "pcm_silence");
    child.emit("close", 1);
    child.emitMessage({ type: "transcript", text: "late", isFinal: true });
    assert.equal(ws.sent.filter((message) => message.type === "done").length, 1);
    assert.equal(ws.sent.some((message) => message.type === "transcript"), false);
  }
});

test("real failures and no-speech errors after a final remain failures", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const outcome of ["missing_metadata", "other_domain", "other_code", "permission", "starting", "final"]) {
    const ws = new FakeSocket();
    const child = new FakeChild();
    const logs = [];
    createMacosStreamingSttHandler({ startHelper: async () => child, noSpeechTimeoutMs: 5, log: { info: (...entry) => logs.push(entry) } })(ws);
    start(ws);
    await tick();
    if (outcome !== "starting") child.emitMessage({ type: "ready" });
    if (outcome === "final") {
      child.emitMessage({ type: "transcript", text: "保護する本文", isFinal: true });
      ws.emit("message", Buffer.from('{"type":"stop"}'), false);
      await tick();
    } else if (outcome !== "starting") {
      t.mock.timers.tick(5);
      assert.equal(child.ended, true);
    }
    const error = {
      type: "error", code: outcome === "permission" ? "macos_speech_permission_denied" : "macos_recognition_failed",
      nativeErrorDomain: outcome === "other_domain" ? "kLSRErrorDomain" : "kAFAssistantErrorDomain",
      nativeErrorCode: outcome === "other_code" ? 1101 : 1110,
    };
    if (outcome === "missing_metadata") {
      delete error.nativeErrorDomain;
      delete error.nativeErrorCode;
    }
    child.emitMessage(error);
    assert.equal(ws.sent.at(-1).type, "error", outcome);
    assert.equal(ws.sent.at(-1).retryable, outcome !== "permission", outcome);
    assert.equal(ws.sent.some((message) => message.type === "done"), false, outcome);
    assert.equal(logs.at(-1)[0], "[stream-stt] macos_failed", outcome);
    assert.equal(child.killed, true);
    assert.doesNotMatch(JSON.stringify(logs), /保護する本文/);
  }
});

test("unchanged macOS transcript ends despite loud noise and waits for the native final", async (t) => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  const logs = [];
  createMacosStreamingSttHandler({ startHelper: async () => child, log: { info: (...entry) => logs.push(entry) } })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  child.emitMessage({ type: "transcript", text: "途中", isFinal: false });
  for (let index = 0; index < 3; index += 1) {
    ws.emit("message", pcm(4000, 200), true);
    await tick();
    t.mock.timers.tick(500);
    child.emitMessage({ type: "transcript", text: "途中", isFinal: false });
  }
  assert.equal(child.ended, undefined);
  t.mock.timers.tick(500);
  assert.equal(child.ended, true);
  assert.equal(ws.sent.some((message) => message.type === "done"), false);
  const inputEnded = logs.find(([event]) => event === "[stream-stt] macos_input_ended")[1];
  assert.equal(inputEnded.trigger, "transcript_inactivity");
  assert.equal(inputEnded.silentMs, 0);
  ws.emit("message", pcm(4000, 200), true);
  await tick();
  assert.equal(child.writes.length, 3);
  child.emitMessage({ type: "transcript", text: "", isFinal: true });
  child.emit("close", 0);
  assert.deepEqual(ws.sent.at(-2), { type: "transcript", text: "途中", isFinal: true, stability: 1 });
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "speech_end_timeout", hasSpeech: true });
  t.mock.timers.tick(20_000);
  assert.equal(ws.sent.filter((message) => message.type === "done" || message.type === "error").length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /途中/);
});

test("macOS loud noise without recognized text never starts transcript completion", async (t) => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  createMacosStreamingSttHandler({ startHelper: async () => child, log: {} })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  ws.emit("message", pcm(4000, 200), true);
  await tick();
  child.emitMessage({ type: "transcript", text: " \t", isFinal: false });
  t.mock.timers.tick(3_000);
  assert.equal(child.ended, undefined);
  assert.equal(ws.sent.some((message) => message.type === "speech_activity_end"), false);
  ws.close();
});

test("macOS inactivity closes input during a submitted write without a second VAD completion", async (t) => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  let completeWrite;
  child.stdin.write = (_buffer, callback) => { completeWrite = callback; };
  createMacosStreamingSttHandler({ startHelper: async () => child, log: {} })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  child.emitMessage({ type: "transcript", text: "途中", isFinal: false });
  ws.emit("message", pcm(0, 1_250), true);
  await tick();
  t.mock.timers.tick(2_000);
  assert.equal(child.ended, true);
  completeWrite();
  await tick();
  assert.equal(ws.sent.filter((message) => message.type === "speech_activity_end").length, 1);
  child.emitMessage({ type: "transcript", text: "確定", isFinal: true });
  child.emit("close", 0);
  assert.equal(ws.sent.at(-1).hasSpeech, true);
});

test("macOS stop, disconnect, errors, and duration limit disarm transcript inactivity", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const outcome of ["user_stop", "disconnect", "error", "max_duration"]) {
    const ws = new FakeSocket();
    const child = new FakeChild();
    createMacosStreamingSttHandler({ startHelper: async () => child, log: {} })(ws);
    start(ws);
    await tick();
    child.emitMessage({ type: "ready" });
    if (outcome === "max_duration") {
      ws.emit("message", pcm(4000, 200), true);
      await tick();
      t.mock.timers.tick(MAX_DURATION_SECONDS * 1000 - 1_000);
    }
    child.emitMessage({ type: "transcript", text: "途中", isFinal: false });
    if (outcome === "user_stop") {
      ws.emit("message", Buffer.from('{"type":"stop"}'), false);
      await tick();
    } else if (outcome === "disconnect") ws.close();
    else if (outcome === "error") child.emitMessage({ type: "error", code: "macos_recognition_failed" });
    else t.mock.timers.tick(1_000);
    child.emitMessage({ type: "transcript", text: "遅延応答", isFinal: false });
    t.mock.timers.tick(3_000);
    assert.equal(ws.sent.some((message) => message.type === "speech_activity_end"), false, outcome);
    child.emit("close", 0);
  }
});

test("macOS inactivity finalization stays bounded even while an audio callback is pending", async (t) => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  child.stdin.write = () => {};
  createMacosStreamingSttHandler({ startHelper: async () => child, log: {} })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  child.emitMessage({ type: "transcript", text: "途中", isFinal: false });
  ws.emit("message", pcm(4000, 200), true);
  await tick();
  t.mock.timers.tick(2_000);
  assert.equal(child.ended, true);
  t.mock.timers.tick(15_000);
  assert.equal(ws.sent.at(-1).code, "macos_finalization_timeout");
  assert.equal(child.killed, true);
});

test("native recognition failure records safe Apple error details and stream audio timing", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  child.pid = 1234;
  const logs = [];
  createMacosStreamingSttHandler({ startHelper: async () => child, log: { info: (...entry) => logs.push(entry) } })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  ws.emit("message", pcm(4000, 200), true);
  await tick();
  ws.emit("message", pcm(0, 1_250), true);
  await tick();
  child.emitMessage({
    type: "error", code: "macos_recognition_failed",
    nativeErrorDomain: "kAFAssistantErrorDomain", nativeErrorCode: 1101,
    underlyingErrorDomain: "NSOSStatusErrorDomain", underlyingErrorCode: -50,
    recognizerAvailable: false,
    localizedDescription: "PRIVATE_DESCRIPTION", userInfo: { secret: "PRIVATE_USER_INFO" },
    text: "PRIVATE_TRANSCRIPT",
  });
  const failed = logs.at(-1)[1];
  assert.equal(logs.at(-1)[0], "[stream-stt] macos_failed");
  assert.match(failed.streamId, /^[a-f0-9-]{36}$/);
  assert.ok(logs.every(([, payload]) => payload.streamId === failed.streamId));
  assert.equal(failed.helperPid, 1234);
  assert.equal(failed.phase, "finalizing");
  assert.equal(failed.audioMs, 1_450);
  assert.equal(failed.pendingAudioMs, 0);
  assert.equal(failed.speechBegan, true);
  assert.equal(failed.lastPartialChars, 0);
  assert.equal(failed.maxRms, 0.1221);
  assert.ok(failed.firstAudioAfterReadyMs >= 0);
  assert.ok(failed.lastAudioAgoMs >= 0);
  assert.ok(failed.elapsedMs >= failed.finalizationMs);
  assert.equal(failed.nativeErrorDomain, "kAFAssistantErrorDomain");
  assert.equal(failed.nativeErrorCode, 1101);
  assert.equal(failed.underlyingErrorDomain, "NSOSStatusErrorDomain");
  assert.equal(failed.underlyingErrorCode, -50);
  assert.equal(failed.recognizerAvailable, false);
  assert.equal(failed.retryable, true);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_/);
  assert.deepEqual(ws.sent.at(-1), {
    type: "error", code: "macos_recognition_failed",
    message: "Macの音声認識に失敗しました。", retryable: true,
  });
  child.emitMessage({ type: "error", code: "macos_recognition_failed" });
  child.emit("close", 1);
  assert.equal(logs.filter(([event]) => event === "[stream-stt] macos_failed").length, 1);
});

test("unknown native domains and malformed metadata never enter diagnostics", async () => {
  for (const metadata of [
    { nativeErrorDomain: "PRIVATE_DOMAIN", nativeErrorCode: 42, underlyingErrorDomain: "PRIVATE_UNDERLYING", underlyingErrorCode: -2 },
    { nativeErrorDomain: "NSCocoaErrorDomain", nativeErrorCode: "PRIVATE_CODE", underlyingErrorDomain: {}, underlyingErrorCode: 1, recognizerAvailable: "PRIVATE_VALUE" },
    { nativeErrorDomain: "NSCocoaErrorDomain", nativeErrorCode: 1.5, underlyingErrorDomain: "kLSRErrorDomain", underlyingErrorCode: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const ws = new FakeSocket();
    const child = new FakeChild();
    const logs = [];
    createMacosStreamingSttHandler({ startHelper: async () => child, log: { info: (...entry) => logs.push(entry) } })(ws);
    start(ws);
    await tick();
    child.emitMessage({ type: "error", code: "macos_recognition_failed", ...metadata });
    const failed = logs.at(-1)[1];
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_/);
    if (metadata.nativeErrorCode === 42) {
      assert.equal(failed.nativeErrorDomain, "unknown");
      assert.equal(failed.nativeErrorCode, 42);
      assert.equal(failed.underlyingErrorDomain, "unknown");
      assert.equal(failed.underlyingErrorCode, -2);
    } else {
      assert.equal(Object.hasOwn(failed, "nativeErrorDomain"), false);
      assert.equal(Object.hasOwn(failed, "underlyingErrorCode"), false);
      assert.equal(Object.hasOwn(failed, "recognizerAvailable"), false);
    }
    assert.equal(failed.audioMs, 0);
    assert.equal(failed.firstAudioAfterReadyMs, null);
    assert.equal(failed.lastAudioAgoMs, null);
  }
});

test("no-speech native errors remain successful while preserving error metadata for diagnosis", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  const logs = [];
  createMacosStreamingSttHandler({ startHelper: async () => child, noSpeechTimeoutMs: 5, log: { info: (...entry) => logs.push(entry) } })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  child.emitMessage({ type: "error", code: "macos_recognition_failed", nativeErrorDomain: "kAFAssistantErrorDomain", nativeErrorCode: 1110 });
  const nativeError = logs.find(([event]) => event === "[stream-stt] macos_no_speech_error")[1];
  const done = logs.at(-1)[1];
  assert.equal(nativeError.nativeErrorDomain, "kAFAssistantErrorDomain");
  assert.equal(nativeError.nativeErrorCode, 1110);
  assert.equal(nativeError.streamId, done.streamId);
  assert.equal(done.hasSpeech, false);
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "no_speech_timeout", hasSpeech: false });
});

test("native append summaries are diagnostic only and allowlist numeric counts and known states", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  const logs = [];
  createMacosStreamingSttHandler({ startHelper: async () => child, log: { info: (...entry) => logs.push(entry) } })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  child.emitMessage({ type: "audio_summary", appendedFrames: 672000, appendedBuffers: 88,
    taskState: "running", trigger: "audio_progress", text: "PRIVATE_AUDIO_SUMMARY", userInfo: { value: "SECRET" } });
  const summary = logs.find(([event]) => event === "[stream-stt] macos_audio_summary")[1];
  assert.equal(summary.appendedFrames, 672000);
  assert.equal(summary.appendedBuffers, 88);
  assert.equal(summary.taskState, "running");
  assert.equal(summary.trigger, "audio_progress");
  assert.deepEqual(ws.sent, [{ type: "ready" }]);
  const count = logs.length;
  child.emitMessage({ type: "audio_summary", appendedFrames: -1, appendedBuffers: "88", taskState: "PRIVATE_STATE", trigger: "PRIVATE_TRIGGER" });
  child.emitMessage({ type: "audio_summary", appendedFrames: Number.MAX_SAFE_INTEGER + 1, appendedBuffers: 0.5 });
  assert.equal(logs.length, count);
  child.emitMessage({ type: "audio_summary", appendedFrames: 672001, appendedBuffers: 89, taskState: "completed", trigger: "error" });
  child.emitMessage({ type: "error", code: "macos_recognition_failed", nativeErrorDomain: "kAFAssistantErrorDomain", nativeErrorCode: 1110 });
  assert.equal(ws.sent.at(-1).type, "done");
  assert.ok(logs.findIndex(([event]) => event === "[stream-stt] macos_audio_summary") < logs.findIndex(([event]) => event === "[stream-stt] macos_done_attempted"));
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_|SECRET/);
});

test("empty partials preserve the displayed hypothesis and its original two-second completion", async (t) => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  createMacosStreamingSttHandler({ startHelper: async () => child, log: {} })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  child.emitMessage({ type: "transcript", text: "残す文章", isFinal: false });
  t.mock.timers.tick(1_500);
  child.emitMessage({ type: "transcript", text: "", isFinal: false });
  child.emitMessage({ type: "transcript", text: " \t", isFinal: false });
  assert.deepEqual(ws.sent.filter((message) => message.type === "transcript"), [
    { type: "transcript", text: "残す文章", isFinal: false, stability: 0 },
  ]);
  t.mock.timers.tick(499);
  assert.equal(child.ended, undefined);
  t.mock.timers.tick(1);
  assert.equal(child.ended, true);
  assert.equal(ws.sent.some((message) => message.type === "done"), false);
  child.emitMessage({
    type: "error", code: "macos_recognition_failed",
    nativeErrorDomain: "kAFAssistantErrorDomain", nativeErrorCode: 1110,
  });
  assert.deepEqual(ws.sent.at(-2), { type: "transcript", text: "残す文章", isFinal: true, stability: 1 });
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "speech_end_timeout", hasSpeech: true });
  child.emit("close", 0);
  t.mock.timers.tick(20_000);
  assert.equal(ws.sent.filter((message) => message.type === "transcript" && message.isFinal).length, 1);
  assert.equal(ws.sent.filter((message) => message.type === "done").length, 1);
});

test("a late nonempty final replaces the partial after an empty final without fallback duplication", async () => {
  const ws = new FakeSocket();
  const child = new FakeChild();
  createMacosStreamingSttHandler({ startHelper: async () => child, log: {} })(ws);
  start(ws);
  await tick();
  child.emitMessage({ type: "ready" });
  child.emitMessage({ type: "transcript", text: "未訂正", isFinal: false });
  child.emitMessage({ type: "transcript", text: "", isFinal: true });
  assert.equal(ws.sent.some((message) => message.type === "transcript" && message.isFinal), false);
  child.emitMessage({ type: "transcript", text: "訂正後", isFinal: true });
  child.emit("close", 0);
  assert.deepEqual(ws.sent.filter((message) => message.type === "transcript" && message.isFinal), [
    { type: "transcript", text: "訂正後", isFinal: true, stability: 1 },
  ]);
});

async function candidateStream(log = {}) {
  const ws = new FakeSocket();
  const children = [new FakeChild(), new FakeChild(), new FakeChild()];
  let launches = 0;
  createMacosStreamingSttHandler({ startHelper: async () => children[launches++], log })(ws, { continuation: true });
  start(ws);
  await tick();
  children[0].emitMessage({ type: "ready" });
  children[0].emitMessage({ type: "transcript", text: "前半", isFinal: false });
  ws.emit("message", pcm(0, 1250), true);
  await tick();
  children[0].emitMessage({ type: "transcript", text: "前半", isFinal: true });
  children[0].emit("close", 0);
  return { ws, children, launches: () => launches };
}
const commitCandidate = (ws, revision = 1) => ws.emit("message", Buffer.from(JSON.stringify({ type: "commit", revision })), false);

test("continuation offers a nonterminal candidate and immediately commits a quiet stream", async () => {
  const { ws, children, launches } = await candidateStream();
  assert.deepEqual(ws.sent.at(-1), { type: "candidate", revision: 1 });
  assert.equal(ws.readyState, 1);
  assert.equal(launches(), 1);
  assert.equal(children[0].killed, true);
  ws.emit("message", pcm(0, 100), true);
  commitCandidate(ws);
  await tick();
  assert.deepEqual(ws.sent.at(-1), { type: "committed", revision: 1, accepted: true });
  assert.equal(ws.readyState, 3);
  assert.equal(ws.sent.some((message) => message.type === "done"), false);
});

test("speech during correction invalidates the candidate and preserves PCM order over helper startup", async () => {
  const { ws, children } = await candidateStream();
  const first = pcm(4000, 100), second = pcm(5000, 100), third = pcm(6000, 100), fourth = pcm(7000, 100);
  ws.emit("message", first, true);
  ws.emit("message", second, true);
  await tick();
  assert.equal(ws.sent.some((message) => message.type === "candidate_invalidated"), false);
  ws.emit("message", third, true);
  await tick();
  // A queued live frame must never overtake the buffered onset when ready fires.
  ws.emit("message", fourth, true);
  children[1].emitMessage({ type: "ready" });
  await tick();
  assert.deepEqual(children[1].writes, [first, second, third, fourth]);
  assert.equal(ws.sent.filter((message) => message.type === "ready").length, 1);
  assert.equal(ws.sent.filter((message) => message.type === "segment_start").length, 0);
  children[1].emitMessage({ type: "transcript", text: "後半", isFinal: false });
  assert.deepEqual(ws.sent.slice(-3).map((message) => message.type), [
    "candidate_invalidated", "segment_start", "transcript",
  ]);
  children[0].emitMessage({ type: "transcript", text: "古いfinal", isFinal: true });
  assert.equal(ws.sent.some((message) => message.text === "古いfinal"), false);
  commitCandidate(ws);
  await tick();
  assert.deepEqual(ws.sent.at(-1), { type: "committed", revision: 1, accepted: false });
  assert.equal(ws.readyState, 1);
  children[1].emitMessage({ type: "transcript", text: "後半", isFinal: true });
  children[1].emit("close", 0);
  assert.deepEqual(ws.sent.at(-1), { type: "candidate", revision: 2 });
  commitCandidate(ws, 2);
  await tick();
  assert.deepEqual(ws.sent.at(-1), { type: "committed", revision: 2, accepted: true });
});

for (const resumes of [false, true]) {
  test(`commit waits only for an uncertain onset; resumed speech=${resumes}`, async () => {
    const { ws, children } = await candidateStream();
    ws.emit("message", pcm(4000, 100), true);
    commitCandidate(ws);
    await tick();
    assert.equal(ws.sent.some((message) => message.type === "committed"), false);
    ws.emit("message", pcm(resumes ? 4000 : 0, 100), true);
    await tick();
    if (resumes) {
      assert.equal(ws.sent.some((message) => message.type === "committed"), false);
      children[1].emitMessage({ type: "ready" });
      await tick();
      children[1].emitMessage({ type: "transcript", text: "続き", isFinal: false });
    }
    assert.deepEqual(ws.sent.find((message) => message.type === "committed"), { type: "committed", revision: 1, accepted: !resumes });
    if (resumes) ws.close();
  });
}

test("manual stop during helper restart drains the onset and ends without a ready protocol error", async () => {
  const { ws, children } = await candidateStream();
  ws.emit("message", pcm(4000, 200), true);
  await tick();
  ws.emit("message", Buffer.from('{"type":"stop"}'), false);
  await tick();
  children[1].emitMessage({ type: "ready" });
  await tick();
  assert.equal(children[1].writes.length, 1);
  assert.equal(children[1].ended, true);
  children[1].emitMessage({ type: "transcript", text: "後半", isFinal: true });
  children[1].emit("close", 0);
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "user_stop", hasSpeech: true });
});

test("native no-speech finalization keeps continuation capture alive for the next segment", async () => {
  const ws = new FakeSocket();
  const children = [new FakeChild(), new FakeChild()];
  let launches = 0;
  createMacosStreamingSttHandler({ startHelper: async () => children[launches++], log: {} })(ws, { continuation: true });
  start(ws);
  await tick();
  children[0].emitMessage({ type: "ready" });
  children[0].emitMessage({ type: "transcript", text: "途中結果", isFinal: false });
  children[0].emitMessage({ type: "error", code: "macos_recognition_failed", nativeErrorDomain: "kAFAssistantErrorDomain", nativeErrorCode: 1110 });
  assert.deepEqual(ws.sent.at(-1), { type: "candidate", revision: 1 });
  ws.emit("message", pcm(4000, 200), true);
  await tick();
  children[1].emitMessage({ type: "ready" });
  await tick();
  assert.equal(children[1].writes.length, 1);
  assert.equal(ws.sent.some((message) => message.type === "error"), false);
  ws.close();
});

test("resumed speech during previous finalization is handed off without offering a stale candidate", async () => {
  const ws = new FakeSocket();
  const children = [new FakeChild(), new FakeChild()];
  let launches = 0;
  createMacosStreamingSttHandler({ startHelper: async () => children[launches++], log: {} })(ws, { continuation: true });
  start(ws);
  await tick();
  children[0].emitMessage({ type: "ready" });
  children[0].emitMessage({ type: "transcript", text: "前半", isFinal: false });
  ws.emit("message", pcm(0, 1250), true);
  await tick();
  const onset = pcm(4000, 200);
  ws.emit("message", onset, true);
  await tick();
  children[0].emitMessage({ type: "transcript", text: "前半", isFinal: true });
  children[0].emit("close", 0);
  await tick();
  children[1].emitMessage({ type: "ready" });
  await tick();
  assert.equal(ws.sent.some((message) => message.type === "candidate"), false);
  assert.deepEqual(children[1].writes, [onset]);
  ws.close();
});

test("total duration stays bounded while a continuation helper is starting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws, children } = await candidateStream();
  t.mock.timers.tick((MAX_DURATION_SECONDS - 1) * 1000);
  ws.emit("message", pcm(4000, 200), true);
  await tick();
  t.mock.timers.tick(1000);
  assert.deepEqual(ws.sent.at(-1), { type: "done", reason: "max_duration", hasSpeech: false });
  children[1].emitMessage({ type: "ready" });
  assert.equal(ws.sent.some((message) => message.type === "error"), false);
  assert.equal(ws.readyState, 3);
});

test("candidate commit remains bounded when no more PCM arrives after an uncertain onset", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws } = await candidateStream();
  ws.emit("message", pcm(4000, 100), true);
  commitCandidate(ws);
  await tick();
  t.mock.timers.tick(15_000);
  assert.equal(ws.sent.at(-1).code, "macos_commit_timeout");
  assert.equal(ws.readyState, 3);
});

test("continuation PCM handoff remains bounded if a helper never becomes ready", async () => {
  const { ws } = await candidateStream();
  ws.emit("message", pcm(4000, 200), true);
  await tick();
  for (let index = 0; index < 6; index += 1) {
    ws.emit("message", pcm(4000, 2000), true);
    await tick();
  }
  assert.equal(ws.sent.at(-1).code, "backpressure_exceeded");
  assert.equal(ws.readyState, 3);
});

test("noise preserves the candidate and settles its pending commit after the existing two-second watchdog", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs = [];
  const { ws, children } = await candidateStream({ info: (...args) => logs.push(args) });
  ws.emit("message", pcm(4000, 200), true);
  await tick();
  children[1].emitMessage({ type: "ready" });
  await tick();
  commitCandidate(ws);
  await tick();
  assert.equal(ws.sent.some((message) => message.type === "committed"), false);
  assert.equal(ws.sent.some((message) => message.type === "candidate_invalidated" || message.type === "segment_start"), false);
  t.mock.timers.tick(1999);
  assert.notEqual(children[1].ended, true);
  t.mock.timers.tick(1);
  assert.equal(children[1].ended, true);
  children[1].emitMessage({ type: "error", code: "macos_recognition_failed", nativeErrorDomain: "kAFAssistantErrorDomain", nativeErrorCode: 1110 });
  assert.deepEqual(ws.sent.filter((message) => message.type === "candidate"), [{ type: "candidate", revision: 1 }]);
  assert.deepEqual(ws.sent.at(-1), { type: "committed", revision: 1, accepted: true });
  assert.ok(logs.some(([event, details]) => event === "[stream-stt] macos_continuation_probe" && details.revision === 1));
  assert.ok(logs.some(([event, details]) => event === "[stream-stt] macos_candidate_noise_ignored" && details.revision === 1));
  assert.equal(JSON.stringify(logs).includes("前半"), false);
});

test("live speech after buffered silence is handed to the following segment instead of discarded", async () => {
  const { ws, children } = await candidateStream();
  ws.emit("message", pcm(4000, 200), true);
  await tick();
  ws.emit("message", pcm(0, 1250), true);
  await tick();
  const nextOnset = pcm(6000, 200);
  ws.emit("message", nextOnset, true);
  children[1].emitMessage({ type: "ready" });
  await tick();
  assert.equal(children[1].ended, true);
  children[1].emitMessage({ type: "transcript", text: "後半", isFinal: true });
  children[1].emit("close", 0);
  await tick();
  children[2].emitMessage({ type: "ready" });
  await tick();
  assert.deepEqual(children[2].writes, [nextOnset]);
  ws.close();
});

test("a resumed helper with early Apple no-speech preserves the turn as a candidate", async () => {
  const { ws, children } = await candidateStream();
  ws.emit("message", pcm(4000, 200), true);
  await tick();
  children[1].emitMessage({ type: "ready" });
  await tick();
  children[1].emitMessage({ type: "error", code: "macos_recognition_failed", nativeErrorDomain: "kAFAssistantErrorDomain", nativeErrorCode: 1110 });
  assert.deepEqual(ws.sent.filter((message) => message.type === "candidate"), [{ type: "candidate", revision: 1 }]);
  assert.equal(ws.sent.some((message) => message.type === "candidate_invalidated" || message.type === "segment_start"), false);
  assert.equal(ws.readyState, 1);
  commitCandidate(ws);
  await tick();
  assert.deepEqual(ws.sent.at(-1), { type: "committed", revision: 1, accepted: true });
});
