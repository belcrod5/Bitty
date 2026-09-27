import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStreamTtsSegments } from "../src/stream-tts-segments.mjs";

const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-tts-media-"));
test.after(() => fs.rm(mediaDir, { recursive: true, force: true }));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
process.env.TTS_FETCH_TIMEOUT_MS = "1000";
process.env.STREAM_TTS_MAX_CHARS = "1000";
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.TTS_MEDIA_DIR = mediaDir;

const {
  takeNextStreamTtsSegment,
  findStreamTtsSplitIndex,
  sanitizeStreamTtsText,
  resolveStreamTtsSegmentTargetChars,
  fetchTtsWithTimeout,
  startLlmStreamJob,
  STREAM_TTS_SEGMENT_MAX_CHARS,
  STREAM_TTS_MAX_CHARS,
  TTS_FETCH_TIMEOUT_MS,
} = (await import("../src/server-runtime.mjs")).__TESTING__;

function collectSegments(text, maxChars = STREAM_TTS_SEGMENT_MAX_CHARS) {
  const segments = [];
  let buffer = text;
  for (;;) {
    const next = takeNextStreamTtsSegment(buffer, maxChars, true);
    if (!next) break;
    segments.push(next.segment);
    buffer = next.rest;
  }
  return segments;
}

test("shared segment queue speaks genuine deltas once and flushes the tail", async () => {
  const events = [];
  const spoken = [];
  const segments = createStreamTtsSegments({
    emit: (event) => events.push(event),
    synthesizeSegment: async (text) => { spoken.push(text); return { audioUrl: `audio:${text}`, speedScale: 1 }; },
    speedScale: 1, takeNextSegment: takeNextStreamTtsSegment, sanitizeText: sanitizeStreamTtsText,
    maxChars: STREAM_TTS_SEGMENT_MAX_CHARS, targetChars: 12, maxEstMs: 1200,
    estimateDurationMs: () => 100,
  });
  segments.append("こんに");
  segments.append("ちは。残り😀");
  assert.deepEqual(events.map((event) => event.type), ["segment_queued"]);
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(events.some((event) => event.type === "audio_chunk" && event.seq === 0),
    "first audio is available before generation finishes");
  await segments.finish();
  await segments.finish();
  assert.deepEqual(spoken, ["こんにちは", "残り😀"]);
  assert.deepEqual(events.map((event) => `${event.type}:${event.seq}`), [
    "segment_queued:0",
    "segment_tts_started:0", "audio_chunk:0", "segment_tts_done:0",
    "segment_queued:1",
    "segment_tts_started:1", "audio_chunk:1", "segment_tts_done:1",
  ]);
});

test("cancelling shared segments discards queued work and suppresses late audio", async () => {
  const events = [];
  let resolveAudio;
  const segments = createStreamTtsSegments({
    emit: (event) => events.push(event),
    synthesizeSegment: () => new Promise((resolve) => { resolveAudio = resolve; }),
    speedScale: 1, takeNextSegment: takeNextStreamTtsSegment, sanitizeText: sanitizeStreamTtsText,
    maxChars: STREAM_TTS_SEGMENT_MAX_CHARS, targetChars: 12, maxEstMs: 1200,
    estimateDurationMs: () => 100,
  });
  segments.append("一。二。未完成");
  await Promise.resolve();
  segments.cancel();
  resolveAudio({ audioUrl: "late", speedScale: 1 });
  await segments.finish();
  assert.equal(events.filter((event) => event.type === "audio_chunk").length, 0);
  assert.equal(events.filter((event) => event.type === "segment_tts_started").length, 1);
});

test("aborted shared segments ignore later deltas and do not flush their tail", async () => {
  const controller = new AbortController();
  const events = [];
  const segments = createStreamTtsSegments({
    emit: (event) => events.push(event),
    synthesizeSegment: async () => ({ audioUrl: "unused", speedScale: 1 }),
    signal: controller.signal,
    speedScale: 1, takeNextSegment: takeNextStreamTtsSegment, sanitizeText: sanitizeStreamTtsText,
    maxChars: STREAM_TTS_SEGMENT_MAX_CHARS, targetChars: 12, maxEstMs: 1200,
    estimateDurationMs: () => 100,
  });
  segments.append("Unfinished");
  controller.abort();
  segments.append(". Later.");
  await segments.finish();
  assert.deepEqual(events, []);
});

test("splits at punctuation boundaries as before for normal text", () => {
  const segments = collectSegments("こんにちは。今日は良い天気ですね、散歩に行きましょう。");
  assert.deepEqual(segments, ["こんにちは。", "今日は良い天気ですね、", "散歩に行きましょう。"]);
});

test("removes Japanese and ASCII sentence punctuation from provider text", () => {
  assert.equal(
    sanitizeStreamTtsText("こんにちは。今日は、sunny. Let's walk, together."),
    "こんにちは今日はsunny Let's walk together"
  );
});

test("uses removable punctuation as boundaries without losing text", () => {
  const text = "一。二、three.four,five";
  const segments = collectSegments(text);
  assert.deepEqual(segments, ["一。", "二、", "three.", "four,", "five"]);
  assert.equal(segments.join(""), text);
  assert.deepEqual(segments.map(sanitizeStreamTtsText), ["一", "二", "three", "four", "five"]);
});

test("waits for more streamed input when no boundary and below max chars", () => {
  const next = takeNextStreamTtsSegment("まだ途中の文", STREAM_TTS_SEGMENT_MAX_CHARS, false);
  assert.equal(next, null);
});

test("force flush emits trailing text without boundary", () => {
  const next = takeNextStreamTtsSegment("最後の残り", STREAM_TTS_SEGMENT_MAX_CHARS, true);
  assert.deepEqual(next, { segment: "最後の残り", rest: "" });
});

test("force-splits boundary-free long text at the segment max chars", () => {
  const text = "あ".repeat(300);
  const segments = collectSegments(text);
  assert.equal(segments.join(""), text);
  assert.ok(segments.length > 1, "long boundary-free text must produce multiple segments");
  for (const segment of segments) {
    assert.ok(
      segment.length <= STREAM_TTS_SEGMENT_MAX_CHARS,
      `segment length ${segment.length} must not exceed ${STREAM_TTS_SEGMENT_MAX_CHARS}`
    );
  }
  assert.equal(segments[0].length, STREAM_TTS_SEGMENT_MAX_CHARS);
});

test("boundary-free buffer at exactly max chars is split without waiting", () => {
  const text = "い".repeat(STREAM_TTS_SEGMENT_MAX_CHARS);
  const next = takeNextStreamTtsSegment(text, STREAM_TTS_SEGMENT_MAX_CHARS, false);
  assert.ok(next, "buffer reaching max chars must be flushed even while streaming");
  assert.equal(next.segment.length, STREAM_TTS_SEGMENT_MAX_CHARS);
  assert.equal(next.rest, "");
});

test("prefers a soft split char inside the force-split window", () => {
  const text = `${"x".repeat(60)} ${"y".repeat(60)}`;
  const next = takeNextStreamTtsSegment(text, STREAM_TTS_SEGMENT_MAX_CHARS, false);
  assert.ok(next);
  assert.equal(next.segment, `${"x".repeat(60)} `);
  assert.equal(next.rest, "y".repeat(60));
});

test("segments a 6000+ char text with sparse punctuation completely", () => {
  const sentence = `${"長".repeat(200)}。`;
  const text = sentence.repeat(30);
  assert.ok(text.length > 6000);
  const segments = collectSegments(text);
  assert.equal(segments.join(""), text);
  for (const segment of segments) {
    assert.ok(segment.length <= STREAM_TTS_SEGMENT_MAX_CHARS);
  }
});

test("findStreamTtsSplitIndex prefers boundary chars in the trailing window", () => {
  const text = `${"a".repeat(50)}。${"b".repeat(50)}`;
  assert.equal(findStreamTtsSplitIndex(text, 70), 50);
});

test("findStreamTtsSplitIndex falls back to a hard cut without split chars", () => {
  const text = "c".repeat(100);
  assert.equal(findStreamTtsSplitIndex(text, 70), 69);
});

test("resolveStreamTtsSegmentTargetChars stays within configured bounds", () => {
  for (const speedScale of [undefined, 0.5, 1, 2, Number.NaN]) {
    const target = resolveStreamTtsSegmentTargetChars(speedScale);
    assert.ok(Number.isInteger(target));
    assert.ok(target >= 1);
    assert.ok(target <= STREAM_TTS_SEGMENT_MAX_CHARS);
  }
});

test("fetchTtsWithTimeout rejects with a timeout error when the provider hangs", async () => {
  const originalFetch = globalThis.fetch;
  // AbortSignal.timeout timers are unref'd, so keep the event loop alive until it fires.
  const keepAlive = setTimeout(() => {}, TTS_FETCH_TIMEOUT_MS + 5000);
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  try {
    await assert.rejects(
      fetchTtsWithTimeout("test tts", "https://tts.invalid/synthesize", { method: "POST" }),
      new RegExp(`test tts timeout \\(${TTS_FETCH_TIMEOUT_MS}ms\\)`)
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearTimeout(keepAlive);
  }
});

test("hard cut never splits a surrogate pair", () => {
  // "a" offsets the emoji pairs so the hard cut at max chars lands on a high surrogate.
  const text = `a${"😀".repeat(100)}`;
  const splitIndex = findStreamTtsSplitIndex(text, STREAM_TTS_SEGMENT_MAX_CHARS);
  assert.equal(splitIndex, STREAM_TTS_SEGMENT_MAX_CHARS - 2);
  const segments = collectSegments(text);
  assert.equal(segments.join(""), text);
  for (const segment of segments) {
    assert.ok(segment.isWellFormed(), `segment must not contain lone surrogates: ${segment}`);
  }
});

test("hard cut on an aligned emoji run keeps pairs intact", () => {
  const text = "😀".repeat(100);
  const segments = collectSegments(text);
  assert.equal(segments.join(""), text);
  for (const segment of segments) {
    assert.ok(segment.isWellFormed());
  }
});

test("stream-tts text mode rejects text above the sanity limit with text_too_long", async () => {
  assert.equal(STREAM_TTS_MAX_CHARS, 1000);
  const job = startLlmStreamJob({
    mode: "text",
    text: "あ".repeat(STREAM_TTS_MAX_CHARS + 1),
    ttsProvider: "elevenlabs",
  });
  await job.runPromise;
  const errors = job.events.filter((e) => e.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, "text_too_long");
  assert.equal(errors[0].max, STREAM_TTS_MAX_CHARS);
  assert.ok(!job.events.some((e) => e.type === "segment_queued"));
});

test("text mode uses the shared queue and records the last emitted audio seq", async () => {
  const originalFetch = globalThis.fetch;
  const spoken = [];
  globalThis.fetch = async (_url, init) => {
    spoken.push(JSON.parse(init.body).text);
    return { ok: true, arrayBuffer: async () => Uint8Array.of(1, 2, 3).buffer };
  };
  try {
    const job = startLlmStreamJob({ mode: "text", text: "One. Two!", ttsProvider: "elevenlabs" }, {
      publicBaseUrl: "http://127.0.0.1:8788",
    });
    await job.runPromise;
    assert.equal(job.status, "completed");
    assert.deepEqual(spoken, ["One", "Two!"]);
    assert.deepEqual(job.events.filter((event) => event.type === "audio_chunk").map((event) => event.seq), [0, 1]);
    assert.equal(job.lastAudioChunkSeq, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("text mode preserves segment and provider context for synthesis errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("provider offline"); };
  try {
    const job = startLlmStreamJob({ mode: "text", text: "One.", ttsProvider: "elevenlabs" }, {
      publicBaseUrl: "http://127.0.0.1:8788",
    });
    await job.runPromise;
    assert.equal(job.status, "failed");
    assert.match(job.error.message, /stream-tts segment failed: seq=0 provider=elevenlabs message=.*provider offline/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchTtsWithTimeout passes through successful responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.ok(init.signal instanceof AbortSignal, "fetch must receive a timeout signal");
    return { ok: true, marker: "ok" };
  };
  try {
    const response = await fetchTtsWithTimeout("test tts", "https://tts.invalid/synthesize", {});
    assert.equal(response.marker, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
