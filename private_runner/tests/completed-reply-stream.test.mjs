import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = await mkdtemp(path.join(os.tmpdir(), "bitty-completed-reply-"));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_MOCK = "0";
process.env.RUNNER_TOKEN = "test-runner-token";
process.env.CODEX_AUTH_STORE_DIR = path.join(testRoot, "auth");
process.env.CODEX_CLI_SESSIONS_DIR = path.join(testRoot, "sessions");
process.env.CLI_SESSION_INDEX_PATH = path.join(testRoot, "cli_sessions_index.json");
process.env.ACP_SESSION_STORE_PATH = path.join(testRoot, "acp_sessions.json");

const { __TESTING__ } = await import("../src/server-runtime.mjs");
const auth = __TESTING__.codexAuthService;
const originalSnapshot = auth.snapshot;
const originalToken = auth.externalTokenPayload;
const originalLease = auth.acquireLease;
const originalFetch = globalThis.fetch;
const reply = "A completed response with punctuation. And enough text to require several old chunks.";

auth.snapshot = async () => ({ profiles: [{ authId: "test" }], activeAuthId: "test" });
auth.externalTokenPayload = async () => ({ accessToken: "test-token", chatgptAccountId: "test-account" });
auth.acquireLease = async () => () => {};

test.after(async () => {
  auth.snapshot = originalSnapshot;
  auth.externalTokenPayload = originalToken;
  auth.acquireLease = originalLease;
  globalThis.fetch = originalFetch;
  await rm(testRoot, { recursive: true, force: true });
});

test("Codex completed response without native deltas emits the full text once", async () => {
  globalThis.fetch = async () => new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { output: [
      { type: "message", content: [{ type: "output_text", text: reply }] },
    ] } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
  const modes = [];
  const deltas = [];
  const result = await __TESTING__.runCodexStream("hello", {
    onMode: (mode) => modes.push(mode),
    onText: (text, source) => deltas.push({ text, source }),
  });

  assert.equal(result, reply);
  assert.deepEqual(modes, ["pseudo_delta"]);
  assert.deepEqual(deltas, [{ text: reply, source: "pseudo" }]);
});

test("Codex passes task instructions to the upstream request and keeps the default for other calls", async () => {
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [
      { type: "message", content: [{ type: "output_text", text: reply }] },
    ] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  await __TESTING__.runCodexStream("title data", { instructions: "Generate only a natural short title." });
  await __TESTING__.runCodexStream("ordinary request");
  assert.equal(requests[0].instructions, "Generate only a natural short title.");
  assert.ok(requests[1].instructions);
  assert.notEqual(requests[1].instructions, requests[0].instructions);
});

test("file-tools completed reply emits once and keeps its reply identity", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: reply }));
  const modes = [];
  const deltas = [];
  const request = __TESTING__.normalizeReplyExecutionRequest({ transcript: "hello", directory: testRoot });
  const result = await __TESTING__.runReplyUsecase(request, {
    stream: true,
    onMode: (mode) => modes.push(mode),
    onText: (text, source) => deltas.push({ text, source }),
  });

  assert.equal(result.reply, reply);
  assert.equal(result.mode, "file-tools");
  assert.ok(result.sessionId);
  assert.deepEqual(modes, ["file_tools_pseudo"]);
  assert.deepEqual(deltas, [{ text: reply, source: "pseudo" }]);
});

test("file-tools completed reply honors abort before text emission", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: reply }));
  const controller = new AbortController();
  const deltas = [];
  const request = __TESTING__.normalizeReplyExecutionRequest({ transcript: "hello", directory: testRoot });
  const result = await __TESTING__.runReplyUsecase(request, {
    stream: true,
    signal: controller.signal,
    onMode: () => controller.abort(),
    onText: (text) => deltas.push(text),
  });

  assert.equal(result.reply, reply);
  assert.deepEqual(deltas, []);
});
