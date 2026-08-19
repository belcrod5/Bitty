import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = await mkdtemp(path.join(os.tmpdir(), "bitty-reply-text-"));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_MOCK = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
process.env.CODEX_CLI_SESSIONS_DIR = path.join(testRoot, "sessions");
process.env.CLI_SESSION_INDEX_PATH = path.join(testRoot, "cli_sessions_index.json");
process.env.ACP_SESSION_STORE_PATH = path.join(testRoot, "acp_sessions.json");

const {
  normalizeReplyExecutionRequest,
  runReplyUsecase,
} = (await import("../src/server-runtime.mjs")).__TESTING__;

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

test("reply text contains only the generated assistant response", async () => {
  const request = normalizeReplyExecutionRequest({
    transcript: "テスト応答",
    directory: testRoot,
  });

  const result = await runReplyUsecase(request);

  assert.equal(result.reply, "[mock] テスト応答");
});
