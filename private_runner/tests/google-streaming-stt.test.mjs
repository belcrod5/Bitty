import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createGoogleStreamingSttHandler,
  normalizeStreamingResults,
  __TESTING__,
} from "../src/google-streaming-stt.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code) { this.closeCode = code; this.readyState = 3; }
}

class FakeGoogleStream extends EventEmitter {
  writes = [];
  ended = false;
  destroyed = false;
  blockAudio = false;
  write(request) {
    this.writes.push(request);
    return !(this.blockAudio && request.audio);
  }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
}

function snapshot(usedSeconds = 0, limitSeconds = 3600) {
  return {
    projectId: "valid-project-123",
    monthUtc: "2026-09",
    usedSeconds,
    limitSeconds,
    remainingSeconds: limitSeconds - usedSeconds,
    resetAt: "2026-10-01T00:00:00.000Z",
  };
}

function fixture(overrides = {}) {
  const ws = new FakeWebSocket();
  const stream = new FakeGoogleStream();
  const clientOptions = [];
  const logs = [];
  let usedSeconds = 0;
  const usageLedger = {
    get: async () => snapshot(usedSeconds),
    reserve: async (_projectId, seconds) => {
      usedSeconds += seconds;
      return { reserved: true, ...snapshot(usedSeconds) };
    },
    ...overrides.usageLedger,
  };
  const client = {
    _streamingRecognize: () => stream,
    close: async () => {},
  };
  const handler = createGoogleStreamingSttHandler({
    googleCloudService: {
      credentials: async () => ({
        projectId: "valid-project-123",
        monthlyLimitMinutes: 60,
        sttRegion: "us",
        sttModel: "chirp_3",
        keyFilename: "/dedicated/adc.json",
      }),
      accessToken: async () => ({ accessToken: "validated", projectId: "valid-project-123" }),
      ...overrides.googleCloudService,
    },
    usageLedger,
    speechClientFactory: (options) => { clientOptions.push(options); return client; },
    log: { info(message, payload) { logs.push({ message, payload }); } },
    finalizationTimeoutMs: overrides.finalizationTimeoutMs,
  });
  handler(ws);
  return { ws, stream, client, clientOptions, usageLedger, logs };
}

async function start(f) {
  f.ws.emit("message", Buffer.from(JSON.stringify({ type: "start", sampleRate: 16000 })), false);
  await tick();
}

test("normalizes every ordered Google result into final append and interim replacement", () => {
  assert.deepEqual(normalizeStreamingResults([
    { isFinal: true, alternatives: [{ transcript: "確定1" }] },
    { isFinal: true, alternatives: [{ transcript: "確定2" }] },
    { isFinal: false, stability: 0.7, alternatives: [{ transcript: "暫定A" }] },
    { isFinal: false, stability: 0.8, alternatives: [{ transcript: "暫定B" }] },
  ]), {
    finalAppend: "確定1確定2",
    interimReplacement: "暫定A暫定B",
    interimStability: 0.8,
  });
});

test("each session uses its saved model and matching regional endpoint and recognizer", async () => {
  const selected = {
    projectId: "valid-project-123", monthlyLimitMinutes: 60,
    sttRegion: "us", sttModel: "chirp_3", keyFilename: "/dedicated/adc.json",
  };
  const googleCloudService = { credentials: async () => ({ ...selected }) };
  const first = fixture({ googleCloudService });
  await start(first);
  selected.sttRegion = "asia-northeast1";
  selected.sttModel = "short";
  assert.equal(first.clientOptions[0].apiEndpoint, "us-speech.googleapis.com");
  assert.equal(first.stream.writes[0].recognizer, "projects/valid-project-123/locations/us/recognizers/_");
  assert.equal(first.stream.writes[0].streamingConfig.config.model, "chirp_3");
  first.stream.emit("end");
  await tick();
  assert.equal(first.logs[0].payload.region, "us");
  assert.equal(first.logs[0].payload.model, "chirp_3");

  const next = fixture({ googleCloudService });
  await start(next);
  assert.equal(next.clientOptions[0].apiEndpoint, "asia-northeast1-speech.googleapis.com");
  assert.equal(next.stream.writes[0].recognizer, "projects/valid-project-123/locations/asia-northeast1/recognizers/_");
  assert.equal(next.stream.writes[0].streamingConfig.config.model, "short");
  next.stream.emit("error", Object.assign(new Error("provider secret"), { code: 9 }));
  assert.deepEqual(next.ws.sent.find((message) => message.type === "error"), {
    type: "error",
    code: "google_stream_invalid",
    message: "Google Cloud Speech rejected the selected model or region (short / asia-northeast1)",
    retryable: false,
  });
  assert.equal(next.logs[0].payload.region, "asia-northeast1");
  assert.equal(next.logs[0].payload.model, "short");
  assert.doesNotMatch(JSON.stringify(next.logs), /provider secret/);
});

test("starts only after exact fixed-rate control and configures regional Chirp 3 V2 VAD", async () => {
  const f = fixture();
  await start(f);
  assert.deepEqual(f.ws.sent.slice(0, 2), [
    { type: "ready" },
    {
      type: "usage",
      usedSeconds: 0,
      limitSeconds: 3600,
      remainingSeconds: 3600,
      monthUtc: "2026-09",
      resetAt: "2026-10-01T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(f.clientOptions, [{
    apiEndpoint: "us-speech.googleapis.com",
    projectId: "valid-project-123",
    quotaProjectId: "valid-project-123",
    keyFilename: "/dedicated/adc.json",
  }]);
  const config = f.stream.writes[0];
  assert.equal(config.recognizer, "projects/valid-project-123/locations/us/recognizers/_");
  assert.equal(config.streamingConfig.config.model, "chirp_3");
  assert.equal(config.streamingConfig.config.explicitDecodingConfig.sampleRateHertz, 16000);
  assert.deepEqual(config.streamingConfig.streamingFeatures.voiceActivityTimeout, {
    speechStartTimeout: { seconds: 55 },
    speechEndTimeout: { nanos: 850_000_000 },
  });
});

test("chunks PCM in order, reserves rounded seconds, waits for final, and emits one exact user_stop terminal", async () => {
  const f = fixture();
  await start(f);
  f.ws.emit("message", Buffer.alloc(32_002), true);
  await tick();
  await tick();
  const audioWrites = f.stream.writes.slice(1).map((request) => request.audio.length);
  assert.deepEqual(audioWrites, [15_360, 15_360, 1_280, 2]);
  assert.ok(audioWrites.every((size) => size <= __TESTING__.GOOGLE_CHUNK_BYTES));

  f.stream.emit("data", {
    speechEventType: 2,
    results: [
      { isFinal: true, alternatives: [{ transcript: "確定" }] },
      { isFinal: false, stability: 0.75, alternatives: [{ transcript: "暫定" }] },
    ],
  });
  f.stream.emit("data", { speechEventType: 3, results: [] });
  f.ws.emit("message", Buffer.from(JSON.stringify({ type: "stop" })), false);
  await tick();
  assert.equal(f.stream.ended, true);
  f.stream.emit("end");
  await tick();
  const terminals = f.ws.sent.filter((message) => message.type === "done" || message.type === "error");
  assert.deepEqual(terminals, [{
    type: "done",
    reason: "user_stop",
    hasSpeech: true,
    usage: {
      usedSeconds: 2,
      limitSeconds: 3600,
      remainingSeconds: 3598,
      monthUtc: "2026-09",
      resetAt: "2026-10-01T00:00:00.000Z",
    },
  }]);
  assert.equal("type" in terminals[0].usage, false);
  assert.deepEqual(f.logs.map(({ message, payload }) => ({
    message,
    projectId: payload.projectId,
    outcome: payload.outcome,
    reason: payload.reason,
    addedSeconds: payload.addedSeconds,
    reservedSeconds: payload.reservedSeconds,
    usedSeconds: payload.usedSeconds,
  })), [{
    message: "[stream-stt] session_finished",
    projectId: "valid-project-123",
    outcome: "done",
    reason: "user_stop",
    addedSeconds: 2,
    reservedSeconds: 2,
    usedSeconds: 2,
  }]);
  const { timing } = f.logs[0].payload;
  assert.ok(timing.firstAudioReceivedMs >= 0);
  assert.ok(timing.firstGrpcAudioWriteMs >= timing.firstAudioReceivedMs);
  assert.ok(timing.firstSpeechBeginMs >= timing.firstGrpcAudioWriteMs);
  assert.ok(timing.firstSpeechEndMs >= timing.firstSpeechBeginMs);
  assert.ok(timing.firstFinalMs >= timing.firstSpeechBeginMs);
  assert.ok(timing.firstInterimMs >= timing.firstSpeechBeginMs);
  assert.equal(timing.interimCount, 1);
  assert.equal(timing.finalCount, 1);
  assert.ok(timing.maxReserveWaitMs >= 0);
  assert.ok(timing.lastGrpcAudioWriteMs >= timing.firstGrpcAudioWriteMs);
  assert.ok(timing.lastSpeechEndMs >= timing.firstSpeechEndMs);
  assert.ok(timing.lastFinalMs >= timing.firstFinalMs);
  assert.equal(f.logs[0].payload.localEndRequest.reason, "user_stop");
  assert.equal(f.logs[0].payload.localEndRequest.closeGoogleInput, true);
  assert.ok(f.logs[0].payload.localEndRequest.atMs >= f.logs[0].payload.stopRequestedMs);
  assert.ok(f.logs[0].payload.googleEndObservedMs >= f.logs[0].payload.localEndRequest.atMs);
  assert.equal(f.logs[0].payload.errorState, null);
  assert.doesNotMatch(JSON.stringify(timing), /確定|暫定/);
});

test("session timing captures the longest usage reservation wait", async () => {
  const f = fixture({
    usageLedger: {
      reserve: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { reserved: true, ...snapshot(1) };
      },
    },
  });
  await start(f);
  f.ws.emit("message", Buffer.alloc(2), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  f.stream.emit("end");
  await tick();
  assert.ok(f.logs[0].payload.timing.maxReserveWaitMs >= 10);
  assert.ok(f.logs[0].payload.timing.firstGrpcAudioWriteMs >= f.logs[0].payload.timing.firstAudioReceivedMs);
  assert.equal(f.logs[0].payload.timing.firstInterimMs, null);
  assert.equal(f.logs[0].payload.timing.firstFinalMs, null);
});

test("active streams reserve without reapplying their start-time limit", async () => {
  let reserveArgs;
  const f = fixture({
    usageLedger: {
      reserve: async (...args) => {
        reserveArgs = args;
        return { reserved: false, ...snapshot(61, 60) };
      },
    },
  });
  await start(f);
  f.ws.emit("message", Buffer.alloc(2), true);
  await tick();
  assert.deepEqual(reserveArgs, ["valid-project-123", 1]);
  assert.equal(f.stream.ended, true);
  f.stream.emit("end");
  await tick();
  assert.equal(f.ws.sent.find((message) => message.type === "done").reason, "limit_reached");
});

test("infers no-speech and speech timeout reasons only after normal Google completion", async () => {
  const silent = fixture();
  await start(silent);
  silent.stream.emit("end");
  await tick();
  assert.equal(silent.ws.sent.find((message) => message.type === "done").reason, "no_speech_timeout");
  assert.equal(silent.ws.sent.find((message) => message.type === "done").hasSpeech, false);

  const speech = fixture();
  await start(speech);
  speech.stream.emit("data", { speechEventType: 2, results: [] });
  speech.stream.emit("end");
  await tick();
  assert.equal(speech.ws.sent.find((message) => message.type === "done").reason, "speech_end_timeout");
  assert.equal(speech.ws.sent.find((message) => message.type === "done").hasSpeech, false);
  assert.equal(speech.logs[0].payload.localEndRequest, null);
  assert.equal(speech.logs[0].payload.stopRequestedMs, null);
  assert.ok(speech.logs[0].payload.googleEndObservedMs >= speech.logs[0].payload.timing.firstSpeechBeginMs);
  assert.equal(speech.logs[0].payload.errorState, null);
});

test("a write-after-end race after final speech waits for normal Google completion", async () => {
  const f = fixture();
  await start(f);
  f.stream.emit("data", { speechEventType: 2 });
  f.stream.emit("data", { speechEventType: 3, results: [{
    isFinal: true, alternatives: [{ transcript: "確定" }],
  }] });
  f.stream.emit("error", Object.assign(new Error("secret write failure"), {
    code: "ERR_STREAM_WRITE_AFTER_END",
  }));
  assert.equal(f.ws.sent.some((message) => message.type === "error"), false);
  f.ws.emit("message", Buffer.alloc(2), true);
  assert.equal(f.stream.writes.length, 1);
  f.stream.emit("end");
  await tick();
  assert.equal(f.ws.sent.find((message) => message.type === "done").reason, "speech_end_timeout");
  assert.deepEqual(f.logs[0].payload.failureDetail, {
    source: "google_stream", grpcCode: null, nodeCode: "ERR_STREAM_WRITE_AFTER_END",
  });
  assert.equal(f.logs[0].payload.localEndRequest.reason, "closed_write_race");
  assert.equal(f.logs[0].payload.localEndRequest.closeGoogleInput, false);
  assert.ok(f.logs[0].payload.localEndRequest.atMs >= 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /secret write failure|確定/);
});

test("an audio write-after-end exception after final speech also waits for Google completion", async () => {
  const f = fixture();
  await start(f);
  f.stream.emit("data", { speechEventType: 2 });
  f.stream.emit("data", { speechEventType: 3, results: [{
    isFinal: true, alternatives: [{ transcript: "確定" }],
  }] });
  f.stream.write = (request) => {
    if (request.audio) throw Object.assign(new Error("secret write failure"), {
      code: "ERR_STREAM_WRITE_AFTER_END",
    });
    return true;
  };
  f.ws.emit("message", Buffer.alloc(2), true);
  await tick();
  assert.equal(f.ws.sent.some((message) => message.type === "error"), false);
  f.stream.emit("end");
  await tick();
  assert.equal(f.ws.sent.find((message) => message.type === "done").reason, "speech_end_timeout");
  assert.deepEqual(f.logs[0].payload.failureDetail, {
    source: "audio_write", grpcCode: null, nodeCode: "ERR_STREAM_WRITE_AFTER_END",
  });
});

test("a queued audio write cannot turn a completed Google stream into an error", async () => {
  let releaseReserve;
  const f = fixture({ usageLedger: {
    reserve: () => new Promise((resolve) => { releaseReserve = resolve; }),
  } });
  await start(f);
  f.ws.emit("message", Buffer.alloc(2), true);
  await tick();
  f.ws.emit("message", Buffer.from(JSON.stringify({ type: "stop" })), false);
  f.stream.emit("end");
  releaseReserve({ reserved: true, ...snapshot(1) });
  await tick();
  assert.equal(f.stream.writes.length, 1);
  assert.equal(f.ws.sent.some((message) => message.type === "error"), false);
  assert.equal(f.ws.sent.find((message) => message.type === "done").reason, "no_speech_timeout");
  assert.ok(f.logs[0].payload.stopRequestedMs >= 0);
  assert.equal(f.logs[0].payload.localEndRequest, null);
  assert.ok(f.logs[0].payload.googleEndObservedMs >= f.logs[0].payload.stopRequestedMs);
});

test("gRPC CANCELLED after final remains an error with lifecycle diagnostics and no private data", async () => {
  const f = fixture();
  await start(f);
  f.stream.blockAudio = true;
  f.ws.emit("message", Buffer.from("secret audio"), true);
  await tick();
  f.stream.emit("data", { speechEventType: 3, results: [{
    isFinal: true, alternatives: [{ transcript: "private transcript" }],
  }] });
  const error = Object.assign(new Error("private provider error"), {
    code: 1,
    metadata: { authorization: "private credentials" },
  });
  f.stream.emit("error", error);
  f.stream.emit("drain");
  await tick();

  assert.equal(f.ws.sent.find((message) => message.type === "done"), undefined);
  assert.equal(f.ws.sent.find((message) => message.type === "error").code, "google_stream_failed");
  const diagnostic = f.logs[0].payload;
  assert.equal(diagnostic.outcome, "error");
  assert.deepEqual(diagnostic.failureDetail, {
    source: "google_stream", grpcCode: 1, nodeCode: null,
  });
  assert.deepEqual(diagnostic.errorState, { phase: "ready", inputEnded: false, pendingBytes: 12 });
  assert.equal(diagnostic.localEndRequest, null);
  assert.equal(diagnostic.googleEndObservedMs, null);
  assert.ok(diagnostic.timing.lastGrpcAudioWriteMs >= 0);
  assert.ok(diagnostic.timing.lastSpeechEndMs >= diagnostic.timing.lastGrpcAudioWriteMs);
  assert.ok(diagnostic.timing.lastFinalMs >= diagnostic.timing.lastSpeechEndMs);
  assert.doesNotMatch(JSON.stringify(f.logs), /private transcript|private provider error|private credentials|secret audio|authorization/);
});

test("gRPC CANCELLED after explicit stop records the local end before the provider error", async () => {
  const f = fixture();
  await start(f);
  f.stream.emit("data", { speechEventType: 3, results: [{
    isFinal: true, alternatives: [{ transcript: "確定" }],
  }] });
  f.ws.emit("message", Buffer.from(JSON.stringify({ type: "stop" })), false);
  await tick();
  assert.equal(f.stream.ended, true);
  f.stream.emit("error", Object.assign(new Error("private provider error"), { code: 1 }));

  assert.equal(f.ws.sent.find((message) => message.type === "done"), undefined);
  assert.equal(f.ws.sent.find((message) => message.type === "error").code, "google_stream_failed");
  const diagnostic = f.logs[0].payload;
  assert.ok(diagnostic.stopRequestedMs >= 0);
  assert.equal(diagnostic.localEndRequest.reason, "user_stop");
  assert.ok(diagnostic.localEndRequest.atMs >= diagnostic.stopRequestedMs);
  assert.equal(diagnostic.localEndRequest.closeGoogleInput, true);
  assert.deepEqual(diagnostic.errorState, { phase: "finalizing", inputEnded: true, pendingBytes: 0 });
  assert.equal(diagnostic.googleEndObservedMs, null);
  assert.doesNotMatch(JSON.stringify(f.logs), /確定|private provider error/);
});

test("provider errors after final speech remain errors with safe numeric diagnostics", async () => {
  const f = fixture();
  await start(f);
  f.stream.emit("data", { speechEventType: 3, results: [{
    isFinal: true, alternatives: [{ transcript: "確定" }],
  }] });
  f.stream.emit("error", Object.assign(new Error("secret provider detail"), { code: 7 }));
  assert.equal(f.ws.sent.find((message) => message.type === "done"), undefined);
  assert.equal(f.ws.sent.find((message) => message.type === "error").code, "permission_denied");
  assert.deepEqual(f.logs[0].payload.failureDetail, {
    source: "google_stream", grpcCode: 7, nodeCode: null,
  });
  assert.doesNotMatch(JSON.stringify(f.logs), /secret provider detail|確定/);
});

test("a provider error after a closed-write race still ends in error", async () => {
  const f = fixture();
  await start(f);
  f.stream.emit("data", { speechEventType: 3, results: [{
    isFinal: true, alternatives: [{ transcript: "確定" }],
  }] });
  f.stream.emit("error", Object.assign(new Error("local closed write"), {
    code: "ERR_STREAM_WRITE_AFTER_END",
  }));
  f.stream.emit("error", Object.assign(new Error("secret provider detail"), { code: 14 }));
  f.stream.emit("end");
  await tick();
  assert.equal(f.ws.sent.find((message) => message.type === "done"), undefined);
  assert.equal(f.ws.sent.find((message) => message.type === "error").code, "google_unavailable");
  assert.deepEqual(f.logs[0].payload.failureDetail, {
    source: "google_stream", grpcCode: 14, nodeCode: null,
  });
});

test("a closed-write race without Google completion times out", async () => {
  const f = fixture({ finalizationTimeoutMs: 5 });
  await start(f);
  f.stream.emit("data", { speechEventType: 3, results: [{
    isFinal: true, alternatives: [{ transcript: "確定" }],
  }] });
  f.stream.emit("error", Object.assign(new Error("local closed write"), {
    code: "ERR_STREAM_WRITE_AFTER_END",
  }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.ws.sent.find((message) => message.type === "error").code, "finalization_timeout");
  assert.equal(f.ws.sent.find((message) => message.type === "done"), undefined);
  assert.deepEqual(f.logs[0].payload.failureDetail, {
    source: "google_stream", grpcCode: null, nodeCode: "ERR_STREAM_WRITE_AFTER_END",
  });
});

test("audio write failures map provider codes without logging raw errors", async () => {
  const f = fixture();
  await start(f);
  f.stream.write = (request) => {
    if (request.audio) throw Object.assign(new Error("secret quota detail"), { code: 8 });
    return true;
  };
  f.ws.emit("message", Buffer.alloc(2), true);
  await tick();
  await tick();
  assert.equal(f.ws.sent.find((message) => message.type === "error").code, "google_quota_exceeded");
  assert.deepEqual(f.logs[0].payload.failureDetail, {
    source: "audio_write", grpcCode: 8, nodeCode: null,
  });
  assert.doesNotMatch(JSON.stringify(f.logs), /secret quota detail/);
});

test("usage reservation failures keep their own error code and safe source", async () => {
  const f = fixture({ usageLedger: {
    reserve: async () => { throw new Error("secret ledger detail"); },
  } });
  await start(f);
  f.ws.emit("message", Buffer.alloc(2), true);
  await tick();
  await tick();
  assert.equal(f.ws.sent.find((message) => message.type === "error").code, "usage_store_failed");
  assert.deepEqual(f.logs[0].payload.failureDetail, {
    source: "usage_store", grpcCode: null, nodeCode: null,
  });
  assert.doesNotMatch(JSON.stringify(f.logs), /secret ledger detail/);
});

test("rejects protocol drift and emits only one safe terminal", async () => {
  const f = fixture();
  f.ws.emit("message", Buffer.from(JSON.stringify({ type: "start", sampleRate: 16000, mode: "auto" })), false);
  await tick();
  assert.deepEqual(f.ws.sent, [{
    type: "error",
    code: "invalid_start",
    message: "Expected start with sampleRate 16000",
    retryable: false,
  }]);
  f.ws.emit("message", Buffer.from(JSON.stringify({ type: "start", sampleRate: 16000 })), false);
  assert.equal(f.ws.sent.length, 1);
  assert.deepEqual(f.logs.map(({ payload }) => [payload.outcome, payload.reason, payload.usedSeconds]), [
    ["error", "invalid_start", null],
  ]);
  assert.deepEqual(f.logs[0].payload.timing, {
    firstAudioReceivedMs: null,
    firstGrpcAudioWriteMs: null,
    lastGrpcAudioWriteMs: null,
    firstSpeechBeginMs: null,
    firstSpeechEndMs: null,
    lastSpeechEndMs: null,
    firstInterimMs: null,
    firstFinalMs: null,
    lastFinalMs: null,
    interimCount: 0,
    finalCount: 0,
    maxReserveWaitMs: 0,
  });
});

test("dedicated ADC token failure never sends ready and emits one safe error", async () => {
  const f = fixture({
    googleCloudService: {
      accessToken: async () => { throw Object.assign(new Error("raw token failure"), { code: 16 }); },
    },
  });
  await start(f);
  assert.equal(f.ws.sent.some((message) => message.type === "ready"), false);
  assert.deepEqual(f.ws.sent, [{
    type: "error",
    code: "credentials_revoked",
    message: "Google Cloud authentication has expired",
    retryable: false,
  }]);
  assert.doesNotMatch(JSON.stringify(f.ws.sent), /raw token/);
});

for (const [name, providerError, expected] of [
  ["disabled Speech API", { code: 7, statusDetails: [{ reason: "SERVICE_DISABLED" }] }, {
    code: "speech_api_disabled", message: "Google Cloud Speech-to-Text API is not enabled",
  }],
  ["disabled billing", { code: 7, statusDetails: [{ reason: "BILLING_DISABLED" }] }, {
    code: "billing_disabled", message: "Google Cloud billing is not enabled",
  }],
  ["missing Speech IAM", { code: 7 }, {
    code: "permission_denied", message: "Google Cloud Speech permissions are missing",
  }],
  ["invalid stream configuration", { code: 9 }, {
    code: "google_stream_invalid", message: "Google Cloud Speech rejected the selected model or region (chirp_3 / us)",
  }],
]) {
  test(`actual stream reports ${name} without exposing the provider error`, async () => {
    const f = fixture();
    await start(f);
    assert.equal(f.ws.sent[0].type, "ready");
    f.stream.emit("error", Object.assign(new Error("raw provider secret"), providerError));
    assert.deepEqual(f.ws.sent.filter((message) => message.type === "error"), [{
      type: "error", ...expected, retryable: false,
    }]);
    assert.doesNotMatch(JSON.stringify(f.ws.sent), /raw provider secret/);
  });
}

test("finalizing has a bounded timeout and emits exactly one terminal error", async () => {
  const f = fixture({ finalizationTimeoutMs: 5 });
  await start(f);
  f.ws.emit("message", Buffer.from(JSON.stringify({ type: "stop" })), false);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.stream.ended, true);
  assert.deepEqual(f.ws.sent.filter((message) => message.type === "done" || message.type === "error"), [{
    type: "error",
    code: "finalization_timeout",
    message: "Google Cloud Speech did not finish the session",
    retryable: true,
  }]);
  f.stream.emit("end");
  await tick();
  assert.equal(f.ws.sent.filter((message) => message.type === "done" || message.type === "error").length, 1);
});

test("fails when pending audio exceeds 256 KiB without dropping or replaying audio", async () => {
  const f = fixture();
  await start(f);
  f.stream.blockAudio = true;
  for (let index = 0; index < 5; index += 1) {
    f.ws.emit("message", Buffer.alloc(65_536), true);
  }
  await tick();
  assert.deepEqual(f.ws.sent.filter((message) => message.type === "error"), [{
    type: "error",
    code: "backpressure_exceeded",
    message: "Speech audio could not be processed quickly enough",
    retryable: true,
  }]);
  assert.equal(f.stream.destroyed, true);
});

test("peer disconnect during asynchronous start never creates a Google stream", async () => {
  let resolveCredentials;
  const credentials = new Promise((resolve) => { resolveCredentials = resolve; });
  const f = fixture({ googleCloudService: { credentials: () => credentials } });
  f.ws.emit("message", Buffer.from(JSON.stringify({ type: "start", sampleRate: 16000 })), false);
  f.ws.readyState = 3;
  f.ws.emit("close");
  resolveCredentials({
    projectId: "valid-project-123",
    monthlyLimitMinutes: 60,
    keyFilename: "/dedicated/adc.json",
  });
  await tick();
  assert.equal(f.clientOptions.length, 0);
  assert.equal(f.ws.sent.length, 0);
  assert.deepEqual(f.logs.map(({ payload }) => ({
    outcome: payload.outcome,
    reason: payload.reason,
    reservedSeconds: payload.reservedSeconds,
    usedSeconds: payload.usedSeconds,
  })), [{
    outcome: "disconnected",
    reason: "client_disconnect",
    reservedSeconds: 0,
    usedSeconds: null,
  }]);
});
