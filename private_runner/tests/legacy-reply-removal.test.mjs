import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "legacy-reply-removal-"));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-token";
process.env.RUNNER_LOG_REQUESTS = "0";
process.env.CODEX_AUTH_STORE_DIR = path.join(root, "auth");
process.env.ACP_SESSION_STORE_PATH = path.join(root, "sessions.json");
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.TTS_MEDIA_DIR = path.join(root, "media");
const { server, startLlmStreamJob } = (await import("../src/server-runtime.mjs")).__TESTING__;
const requestHandler = server.listeners("request")[0];

test.after(() => rm(root, { recursive: true, force: true }));

async function request(method, url, body = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1", authorization: "Bearer test-token" };
  req.socket = { remoteAddress: "test" };
  let status;
  let payload;
  await requestHandler(req, {
    writeHead(code) { status = code; },
    end(value) { payload = JSON.parse(String(value)); },
  });
  return { status, payload };
}

test("retired reply routes and their mutable loop config return 404", async () => {
  for (const url of ["/reply", "/reply-files", "/config/limits"]) {
    const result = await request("POST", url, { transcript: "hello" });
    assert.equal(result.status, 404, url);
    assert.deepEqual(result.payload, { error: "not_found" });
  }
});

test("runtime limits keep active Responses and speech settings", async () => {
  const { status, payload } = await request("GET", "/config/limits");
  assert.equal(status, 200);
  assert.ok(payload.llm.timeoutMs > 0);
  assert.equal(typeof payload.llm.upstreamMaxRetries, "number");
  assert.ok(payload.tts.maxChars > 0);
  assert.ok(payload.stt.maxDurationSeconds > 0);
  assert.equal("toolMaxRounds" in payload.llm, false);
  assert.equal("approval" in payload, false);
});

test("obsolete reply modes reject before deduping or cancelling an active text TTS job", async () => {
  const originalFetch = globalThis.fetch;
  let releaseFetch;
  const gate = new Promise((resolve) => { releaseFetch = resolve; });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    await gate;
    return new Response(Buffer.from("audio"), { headers: { "content-type": "audio/mpeg" } });
  };
  const payload = {
    mode: "text", text: "Hello.", ttsProvider: "elevenlabs",
    clientRequestId: "current-tts", sessionId: "current-session",
  };
  const job = startLlmStreamJob(payload);
  try {
    for (const mode of ["reply", "unknown"]) {
      assert.throws(() => startLlmStreamJob({ ...payload, mode }),
        (error) => error.apiStatus === 400 && error.apiPayload.error === "stream_tts_mode_invalid");
      assert.equal(job.status, "running");
      assert.equal(job.abortController.signal.aborted, false);
    }
    releaseFetch();
    await job.runPromise;
    assert.equal(job.status, "completed");
    assert.equal(job.reply, "Hello.");
    assert.equal(job.route, "stream-tts:text");
    assert.ok(job.events.some((event) => event.type === "audio_chunk"));
    assert.ok(urls.every((url) => url.includes("api.elevenlabs.io")));

    const defaultJob = startLlmStreamJob({ text: "Default text.", ttsProvider: "elevenlabs" });
    await defaultJob.runPromise;
    assert.equal(defaultJob.mode, "text");
    assert.equal(defaultJob.reply, "Default text.");
    assert.equal(defaultJob.status, "completed");
  } finally {
    releaseFetch();
    await job.runPromise;
    globalThis.fetch = originalFetch;
  }
});
