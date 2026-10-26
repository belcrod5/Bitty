import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { convertTtsAudioToMp3 } from "../src/tts-audio.mjs";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tts-quality-"));
Object.assign(process.env, {
  RUNNER_SKIP_SERVER_START: "1", RUNNER_MOCK: "1", RUNNER_TOKEN: "tts-quality-token", RUNNER_LOG_REQUESTS: "0",
  ELEVENLABS_API_KEY: "test-key", AIVISSPEECH_SPEAKER: "1", TTS_MEDIA_DIR: path.join(tempDir, "media"),
  BITTY_GOOGLE_AUTH_DIR: path.join(tempDir, "google"), ACP_SESSION_STORE_PATH: path.join(tempDir, "sessions.json"),
  CLIENT_STATE_STORE_PATH: path.join(tempDir, "client-state.json"), CODEX_WS_PROXY_DEBUG_LOG_DIR: path.join(tempDir, "debug"),
});
const { __TESTING__: runtime } = await import("../src/server-runtime.mjs");
const nativeFetch = globalThis.fetch;
const ffmpegReady = ["ffmpeg", "ffprobe"].every((command) => spawnSync(command, ["-version"]).status === 0);
const needsFfmpeg = { skip: ffmpegReady ? false : "ffmpeg and ffprobe are required for audio verification" };
let base;
const providerRequests = [];
let providerAudio;

// A deterministic four-second 48 kHz stereo PCM fixture, with no provider or user data.
const wav = Buffer.alloc(44 + 48000 * 4 * 4);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(48000 * 4, 28);
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let frame = 0; frame < 48000 * 4; frame++) {
  wav.writeInt16LE(Math.round(Math.sin(frame * 2 * Math.PI * 440 / 48000) * 10000), 44 + frame * 4);
  wav.writeInt16LE(Math.round(Math.sin(frame * 2 * Math.PI * 660 / 48000) * 10000), 46 + frame * 4);
}

async function probe(audio) {
  const file = path.join(tempDir, "probe.mp3");
  await fs.writeFile(file, audio);
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file])).streams[0];
}

async function assertLightweight(audio) {
  const info = await probe(audio);
  assert.equal(info.codec_name, "mp3");
  assert.equal(info.channels, 1);
  assert.equal(Number(info.sample_rate), 24000);
  assert.equal(Number(info.bit_rate), 32000);
  assert.ok(Math.abs(Number(info.duration) - 4) < 0.15, `duration ${info.duration} preserves the whole fixture`);
}

async function post(body, token = "tts-quality-token") {
  return nativeFetch(`${base}/tts`, { method: "POST", headers: { authorization: `Bearer ${token}`,
    "content-type": "application/json" }, body: JSON.stringify({ text: "fixture", ttsProvider: "elevenlabs", ...body }) });
}

async function connect(endpoint) {
  const ws = new WebSocket(`${base.replace("http:", "ws:")}${endpoint}`, {
    headers: { authorization: "Bearer tts-quality-token" },
  });
  const messages = [];
  ws.on("message", (value) => messages.push(JSON.parse(String(value))));
  await once(ws, "open");
  return { ws, messages };
}

async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("TTS event timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function chunkFrom(message) {
  return message.type === "audio_chunk" ? message : message.channel === "tts" && message.op === "audio_chunk" ? message.payload : null;
}

async function checkChunk(messages) {
  await waitFor(() => messages.some((message) => chunkFrom(message)));
  const chunk = messages.map(chunkFrom).find(Boolean);
  assert.equal(chunk.audioQuality, "lightweight");
  assert.equal(chunk.mimeType, "audio/mpeg");
  const res = await nativeFetch(chunk.audioUrl);
  const audio = Buffer.from(await res.arrayBuffer());
  assert.equal(audio.length, chunk.audioBytes);
  await assertLightweight(audio);
  return chunk;
}

test.before(async () => {
  providerAudio = ffmpegReady ? await convertTtsAudioToMp3(wav, { inputFormat: "wav" }) : Buffer.from("fixture");
  runtime.googleCloudService.accessToken = async () => ({ accessToken: "test-token", projectId: "test-project" });
  globalThis.fetch = async (url, init = {}) => {
    const address = new URL(String(url));
    if (address.origin === base) return nativeFetch(url, init);
    providerRequests.push({ url: address, body: init.body ? JSON.parse(init.body) : undefined });
    if (address.pathname === "/speakers") return { ok: true };
    if (address.pathname === "/audio_query") return { ok: true, json: async () => ({ speedScale: 1 }) };
    if (address.pathname === "/synthesis") return { ok: true, arrayBuffer: async () => wav };
    if (address.pathname === "/v1/text:synthesize") return { ok: true, json: async () => ({ audioContent: providerAudio.toString("base64") }) };
    if (address.pathname.startsWith("/v1/text-to-speech/")) return { ok: true, arrayBuffer: async () => providerAudio };
    throw new Error(`Unexpected provider request: ${address.pathname}`);
  };
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${runtime.server.address().port}`;
});

test.after(async () => {
  globalThis.fetch = nativeFetch;
  await new Promise((resolve) => runtime.server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("one encoding preserves standard output and makes mono 24 kHz 32 kbps audio smaller", needsFfmpeg, async (t) => {
  const baseline = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0",
    "-codec:a", "libmp3lame", "-b:a", "96k", "-f", "mp3", "pipe:1"], { input: wav });
  assert.deepEqual(providerAudio, baseline, "standard Aivis encoding is byte-compatible");
  const low = await convertTtsAudioToMp3(wav, { audioQuality: "lightweight", inputFormat: "wav" });
  await assertLightweight(low);
  t.diagnostic(`4-second fixture: standard=${providerAudio.length} bytes, lightweight=${low.length} bytes`);
  const standard = await probe(providerAudio);
  assert.equal(Number(standard.bit_rate), 96000);
  assert.equal(Number(standard.sample_rate), 48000);
  assert.equal(standard.channels, 2);
  assert.ok(low.length < providerAudio.length * 0.4, `${low.length} < 40% of ${providerAudio.length}`);
});

test("invalid or undecodable audio fails instead of serving an uncompressed fallback", needsFfmpeg, async () => {
  await assert.rejects(convertTtsAudioToMp3(Buffer.alloc(0)), /input is empty/);
  await assert.rejects(convertTtsAudioToMp3(Buffer.from("not audio"), { audioQuality: "lightweight" }), /conversion failed/);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = tempDir;
    await assert.rejects(convertTtsAudioToMp3(wav, { audioQuality: "lightweight" }), /conversion failed/);
  } finally { process.env.PATH = oldPath; }
});

test("HTTP validates authentication and audio quality before any provider call", async (t) => {
  t.mock.method(console, "error", () => {});
  const before = providerRequests.length;
  assert.equal((await post({ audioQuality: "lightweight" }, "wrong")).status, 401);
  for (const audioQuality of [null, false, "", "unexpected", { profile: "lightweight" }]) {
    const res = await post({ audioQuality });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "audio_quality_invalid");
  }
  assert.equal(providerRequests.length, before);
});

for (const provider of ["elevenlabs", "google", "aivisspeech"]) {
  test(`${provider} HTTP keeps standard semantics and returns verifiable lightweight media`, {
    ...needsFfmpeg, skip: !ffmpegReady ? needsFfmpeg.skip : provider === "aivisspeech" && process.platform !== "darwin" ? "AivisSpeech requires macOS" : false,
  }, async () => {
    const standardResponse = await post({ ttsProvider: provider, outputFormat: "pcm_16000", audioEncoding: "LINEAR16" });
    assert.equal(standardResponse.status, 200);
    const standard = await standardResponse.json();
    assert.equal(standard.audioQuality, "standard");
    const standardBytes = Buffer.from(await (await nativeFetch(standard.audioUrl)).arrayBuffer());
    assert.deepEqual(standardBytes, providerAudio);
    if (provider === "elevenlabs") { assert.equal(standard.outputFormat, "pcm_16000"); assert.equal(standard.mimeType, "audio/pcm"); }
    if (provider === "google") { assert.equal(standard.audioEncoding, "LINEAR16"); assert.equal(standard.mimeType, "audio/wav"); }
    const start = providerRequests.length;
    const lowResponse = await post({ ttsProvider: provider, audioQuality: "lightweight", outputFormat: "pcm_16000", audioEncoding: "LINEAR16" });
    assert.equal(lowResponse.status, 200);
    const low = await lowResponse.json();
    assert.equal(low.audioQuality, "lightweight");
    assert.equal(low.mimeType, "audio/mpeg");
    if (provider === "elevenlabs") {
      assert.equal(providerRequests[start].url.searchParams.get("output_format"), "mp3_44100_128");
      assert.equal(low.outputFormat, "mp3_24000_32");
    }
    if (provider === "google") {
      assert.equal(providerRequests[start].body.audioConfig.audioEncoding, "MP3");
      assert.equal(low.audioEncoding, "MP3");
    }
    const full = await nativeFetch(low.audioUrl);
    const audio = Buffer.from(await full.arrayBuffer());
    assert.equal(low.audioBytes, audio.length);
    assert.ok(audio.length < standardBytes.length * 0.4);
    await assertLightweight(audio);
    const head = await nativeFetch(low.audioUrl, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(Number(head.headers.get("content-length")), audio.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const range = await nativeFetch(low.audioUrl, { headers: { range: "bytes=5-15" } });
    assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), audio.subarray(5, 16));
    assert.equal((await nativeFetch(low.audioUrl, { headers: { range: `bytes=${audio.length}-` } })).status, 416);
    assert.deepEqual(Buffer.from(await (await nativeFetch(standard.audioUrl)).arrayBuffer()), standardBytes,
      "a later lightweight request cannot change an existing standard media URL");
  });
}

for (const endpoint of ["/runner-ws", "/stream-tts"]) {
  test(`${endpoint} direct text emits lightweight chunks and preserves them on reattach`, needsFfmpeg, async () => {
    const { ws, messages } = await connect(endpoint);
    try {
      const payload = { type: "start", mode: "text", text: "fixture", ttsProvider: "elevenlabs", audioQuality: "lightweight" };
      ws.send(JSON.stringify(endpoint === "/runner-ws" ? { channel: "tts", op: "start", operationId: `quality-${endpoint}`, payload } : payload));
      const chunk = await checkChunk(messages);
      const jobId = endpoint === "/runner-ws" ? messages.find((message) => message.op === "audio_chunk").streamId
        : messages.find((message) => message.type === "job_started").jobId;
      const attached = await connect(endpoint);
      try {
        attached.ws.send(JSON.stringify(endpoint === "/runner-ws"
          ? { channel: "tts", op: "attach", streamId: jobId, payload: { jobId, sinceSeq: 0 } }
          : { type: "attach", jobId, sinceSeq: 0 }));
        await waitFor(() => attached.messages.some((message) => chunkFrom(message)));
        assert.equal(attached.messages.map(chunkFrom).find(Boolean).audioUrl, chunk.audioUrl);
      } finally { attached.ws.close(); await once(attached.ws, "close"); }
    } finally { ws.close(); await once(ws, "close"); }
  });
}

for (const endpoint of ["/runner-ws", "/stream-tts"]) {
  test(`${endpoint} rejects unsupported quality without calling a provider`, async () => {
    const before = providerRequests.length;
    const { ws, messages } = await connect(endpoint);
    try {
      const payload = { type: "start", mode: "text", text: "fixture", ttsProvider: "elevenlabs", audioQuality: "invalid" };
      ws.send(JSON.stringify(endpoint === "/runner-ws" ? { channel: "tts", op: "start", operationId: `invalid-${endpoint}`, payload } : payload));
      await waitFor(() => messages.some((message) => message.type === "error" || message.op === "error"));
      const error = messages.find((message) => message.type === "error" || message.op === "error");
      assert.equal((error.payload || error).error, "stream_tts_failed");
      assert.match((error.payload || error).message, /audioQuality/);
      assert.equal(messages.some(chunkFrom), false);
      assert.equal(providerRequests.length, before);
    } finally { ws.close(); await once(ws, "close"); }
  });
}

test("voice.turn carries lightweight quality into the shared segment generator", needsFfmpeg, async () => {
  const originalStart = runtime.voiceContextService.start;
  runtime.voiceContextService.start = async (_message, _onResult, _onApproval, hooks) => {
    hooks.onAccepted({ ttsProvider: "elevenlabs", voiceId: "voice" });
    hooks.onText("fixture。");
    return { clientOperationId: "quality-voice", status: "accepted" };
  };
  const { ws, messages } = await connect("/runner-ws");
  try {
    ws.send(JSON.stringify({ channel: "agent", op: "turn.start", operationId: "quality-voice", payload: {
      backendId: "codex", logicalConversationId: "quality-conversation", clientOperationId: "quality-voice",
      input: { blocks: [{ type: "text", text: "fixture" }] }, tts: { speedScale: 1, audioQuality: "lightweight" },
    } }));
    await waitFor(() => messages.some((message) => message.op === "turn.accepted"));
    const jobId = messages.find((message) => message.op === "turn.accepted").payload.jobId;
    ws.send(JSON.stringify({ channel: "tts", op: "attach", streamId: jobId, payload: { jobId, sinceSeq: 0 } }));
    await checkChunk(messages);
  } finally {
    runtime.voiceContextService.start = originalStart;
    ws.close(); await once(ws, "close");
  }
});
