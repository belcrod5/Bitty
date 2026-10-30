import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createStreamTtsSegments, takeNextStreamTtsSegment } from "../src/stream-tts-segments.mjs";

const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-tts-media-"));
test.after(() => fs.rm(mediaDir, { recursive: true, force: true }));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
process.env.TTS_FETCH_TIMEOUT_MS = "1000";
process.env.STREAM_TTS_MAX_CHARS = "1000";
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.TTS_MEDIA_DIR = mediaDir;

const {
  sanitizeTtsInputText,
  createVoiceTurnSpeech,
  fetchTtsWithTimeout,
  startLlmStreamJob,
  handleRunnerRequest,
  STREAM_TTS_MAX_CHARS,
  TTS_FETCH_TIMEOUT_MS,
} = (await import("../src/server-runtime.mjs")).__TESTING__;

function collectSegments(text) {
  const segments = [];
  let buffer = text;
  for (;;) {
    const next = takeNextStreamTtsSegment(buffer, true);
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
    speedScale: 1, sanitizeText: sanitizeTtsInputText,
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
    speedScale: 1, sanitizeText: sanitizeTtsInputText,
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
    speedScale: 1, sanitizeText: sanitizeTtsInputText,
    estimateDurationMs: () => 100,
  });
  segments.append("Unfinished");
  controller.abort();
  segments.append(". Later.");
  await segments.finish();
  assert.deepEqual(events, []);
});

test("only Japanese full stops delimit segments and preserve all raw text", () => {
  const text = "一。二、three.four,five!?！？:：;；\n 空白　も同じ文。末尾";
  assert.deepEqual(collectSegments(text), ["一。", "二、three.four,five!?！？:：;；\n 空白　も同じ文。", "末尾"]);
  assert.equal(collectSegments(text).join(""), text);
});

test("provider text preserves internal punctuation, decimals and line separation", () => {
  assert.equal(sanitizeTtsInputText("価格3.14、1,234円! 本当？\nNext sentence。"),
    "価格3.14、1,234円! 本当？\nNext sentence");
  assert.equal(sanitizeTtsInputText("Last sentence."), "Last sentence.");
  assert.equal(sanitizeTtsInputText("最初。次。3.14、最後。"), "最初次3.14、最後");
});

test("single TTS removes all Japanese full stops before calling the provider", async () => {
  const originalFetch = globalThis.fetch;
  const spoken = [];
  globalThis.fetch = async (_url, init) => {
    spoken.push(JSON.parse(init.body).text);
    return { ok: true, arrayBuffer: async () => Uint8Array.of(1, 2, 3).buffer };
  };
  try {
    for (const [text, expectedStatus] of [["最初。次。価格3.14、1,234円。", 200], ["。。。", 400]]) {
      const req = Readable.from([Buffer.from(JSON.stringify({ text, ttsProvider: "elevenlabs" }))]);
      Object.assign(req, { method: "POST", url: "/tts",
        headers: { host: "127.0.0.1", authorization: "Bearer test-runner-token" },
        socket: { remoteAddress: "test" } });
      let status;
      await handleRunnerRequest(req, {
        writeHead(code) { status = code; },
        end() {},
      });
      assert.equal(status, expectedStatus);
    }
    assert.deepEqual(spoken, ["最初次価格3.14、1,234円"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("long sentences wait for a Japanese full stop regardless of length or ASCII", () => {
  for (const text of ["a".repeat(70), "abc123".repeat(100), "😀".repeat(100), "長".repeat(6000)]) {
    assert.equal(takeNextStreamTtsSegment(text), null);
    assert.deepEqual(takeNextStreamTtsSegment(`${text}。残り`), { segment: `${text}。`, rest: "残り" });
    assert.deepEqual(takeNextStreamTtsSegment(text, true), { segment: text, rest: "" });
  }
});

test("decimals, URLs, English sentences and whitespace never split audio", () => {
  const text = "API v3.14 at https://example.com/a?x=1,234&y=abc; works! Yes?\n".repeat(3);
  assert.equal(takeNextStreamTtsSegment(text), null);
  assert.deepEqual(collectSegments(text), [text]);
  assert.deepEqual(collectSegments(`${text}。次。`), [`${text}。`, "次。"]);
});

test("keeps long sentences intact and flushes a boundary-free tail", () => {
  const sentence = `${"長".repeat(200)}。`;
  const tail = `a${"😀".repeat(100)}`;
  const text = sentence.repeat(30) + tail;
  const segments = collectSegments(text);
  assert.deepEqual(segments, [...Array(30).fill(sentence), tail]);
  assert.equal(segments.join(""), text);
  assert.ok(segments.every((segment) => segment.isWellFormed()));
  assert.equal(takeNextStreamTtsSegment("  \n", true), null);
});

test("streamed ASCII deltas stay buffered until a true boundary, then finish flushes once", async () => {
  const spoken = [];
  const events = [];
  const segments = createStreamTtsSegments({
    emit: (event) => events.push(event),
    synthesizeSegment: async (text) => { spoken.push(text); return { audioUrl: "mock", speedScale: 1 }; },
    speedScale: 1, sanitizeText: sanitizeTtsInputText, estimateDurationMs: () => 100,
  });
  const prefix = "abc123".repeat(30);
  for (const delta of [prefix, ".", "14, !?\n", "https://example", ".com/path ", "次"]) segments.append(delta);
  assert.deepEqual(events, []);
  segments.append("。終わり.");
  assert.equal(events.filter((event) => event.type === "segment_queued").length, 1);
  await segments.finish();
  await segments.finish();
  segments.append("追加。拒否");
  assert.deepEqual(spoken, [`${prefix}.14, !?\n 次`, "終わり."]);
  assert.deepEqual(events.filter((event) => event.type === "audio_chunk").map((event) => event.seq), [0, 1]);
});

test("records serial synthesis queue wait on each audio event", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  let releaseFirst;
  const events = [];
  const segments = createStreamTtsSegments({
    emit: (event) => events.push(event), speedScale: 1,
    sanitizeText: sanitizeTtsInputText, estimateDurationMs: () => 100,
    synthesizeSegment: async (_text, seq) => {
      if (seq === 0) await new Promise((resolve) => { releaseFirst = resolve; });
      return { audioUrl: "mock", speedScale: 1 };
    },
  });
  segments.append("一。二。");
  now = 5;
  await Promise.resolve();
  assert.equal(events.filter((event) => event.type === "segment_tts_started").length, 1);
  now = 205;
  releaseFirst();
  await segments.finish();
  assert.deepEqual(events.filter((event) => event.type === "audio_chunk").map((event) => event.queueWaitMs), [5, 205]);
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
    const job = startLlmStreamJob({ mode: "text", text: "One. Two!。Three3.14, end!", ttsProvider: "elevenlabs" }, {
      publicBaseUrl: "http://127.0.0.1:8788",
    });
    await job.runPromise;
    assert.equal(job.status, "completed");
    assert.deepEqual(spoken, ["One. Two!", "Three3.14, end!"]);
    for (const chunk of job.events.filter((event) => event.type === "audio_chunk")) {
      for (const field of ["queueWaitMs", "synthesisMs", "mediaRegistrationMs"]) {
        assert.ok(Number.isFinite(chunk[field]) && chunk[field] >= 0, `${field} must be a non-negative duration`);
      }
    }
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

test("the shared ordinary/consultation voice job lifecycle synthesizes full stops before completion and finishes its tail once", async () => {
  const previousFetch = globalThis.fetch, spoken = [];
  globalThis.fetch = async (_url, init) => {
    spoken.push(JSON.parse(init.body).text);
    return { ok: true, arrayBuffer: async () => Uint8Array.of(1, 2, 3).buffer };
  };
  try {
    const speech = createVoiceTurnSpeech("synthetic-shared-speech", { speedScale: 1 }, { ttsProvider: "elevenlabs", voiceId: "" }, "http://localhost:1");
    speech.append("途中の文。");
    const until = Date.now() + 3000;
    while (!speech.job.events.some((event) => event.type === "audio_chunk") && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(spoken, ["途中の文"]);
    assert.equal(speech.job.status, "running", "audio is ready before model completion");
    speech.append("末尾"); speech.complete("途中の文。末尾"); speech.complete("途中の文。末尾");
    await speech.job.runPromise;
    assert.deepEqual(spoken, ["途中の文", "末尾"]);
    assert.equal(speech.job.status, "completed");
    assert.equal(speech.job.events.filter((event) => event.type === "done").length, 1);
    assert.equal(speech.job.events.filter((event) => event.type === "audio_chunk").length, 2);
  } finally { globalThis.fetch = previousFetch; }
});

test("the common voice job cancellation suppresses queued and late audio without changing provider cancellation semantics", async () => {
  const previousFetch = globalThis.fetch; let release, count = 0;
  globalThis.fetch = async () => {
    count += 1; await new Promise((resolve) => { release = resolve; });
    return { ok: true, arrayBuffer: async () => Uint8Array.of(1, 2, 3).buffer };
  };
  try {
    const speech = createVoiceTurnSpeech("synthetic-cancel-speech", { speedScale: 1 }, { ttsProvider: "elevenlabs", voiceId: "" }, "http://localhost:1");
    speech.append("一。二。"); speech.complete("一。二。");
    await Promise.resolve(); await Promise.resolve();
    assert.ok(release); speech.cancel("synthetic stop"); release();
    speech.complete("一。二。");
    await speech.job.runPromise;
    assert.equal(count, 1); assert.equal(speech.job.status, "cancelled");
    assert.equal(speech.job.events.filter((event) => event.type === "audio_chunk").length, 0);
  } finally { globalThis.fetch = previousFetch; }
});
