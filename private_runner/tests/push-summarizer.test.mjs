import assert from "node:assert/strict";
import test from "node:test";

import { createPushSummarizer } from "../src/push-summarizer.mjs";

test("summarize returns an empty string for empty input without calling runCodex", async () => {
  let called = false;
  const summarizer = createPushSummarizer({
    runCodex: async () => {
      called = true;
      return "should not be used";
    },
  });
  assert.equal(await summarizer.summarize(""), "");
  assert.equal(await summarizer.summarize("   "), "");
  assert.equal(called, false);
});

test("summarize returns the runCodex result, forwarding modelInfo/reasoningEffort", async () => {
  const calls = [];
  const modelInfo = { modelRef: "openai-codex/gpt-5.6-luna", model: "gpt-5.6-luna", provider: "openai-codex" };
  const summarizer = createPushSummarizer({
    runCodex: async (prompt, opts) => {
      calls.push({ prompt, opts });
      return "  短い要約です。  ";
    },
    modelInfo,
    reasoningEffort: "low",
  });
  const result = await summarizer.summarize("これはターン完了時の長い応答テキストです。");
  assert.equal(result, "短い要約です。");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.modelInfo, modelInfo);
  assert.equal(calls[0].opts.reasoningEffort, "low");
  assert.match(calls[0].prompt, /これはターン完了時の長い応答テキストです。/);
});

test("summarize falls back to a truncated copy of the source when runCodex throws", async () => {
  const longText = "あ".repeat(200);
  const summarizer = createPushSummarizer({
    runCodex: async () => {
      throw new Error("upstream failed");
    },
    fallbackMaxChars: 20,
  });
  const result = await summarizer.summarize(longText);
  assert.equal(result.length, 20);
  assert.ok(result.endsWith("..."));
});

test("summarize falls back when runCodex returns an empty string", async () => {
  const summarizer = createPushSummarizer({
    runCodex: async () => "   ",
    fallbackMaxChars: 50,
  });
  const result = await summarizer.summarize("短い元テキスト");
  assert.equal(result, "短い元テキスト");
});

test("summarize falls back when runCodex exceeds the configured timeout", async () => {
  const summarizer = createPushSummarizer({
    runCodex: () => new Promise((resolve) => setTimeout(() => resolve("too late"), 200)),
    timeoutMs: 20,
    fallbackMaxChars: 50,
  });
  const started = Date.now();
  const result = await summarizer.summarize("タイムアウトのテスト用テキスト");
  assert.equal(result, "タイムアウトのテスト用テキスト");
  assert.ok(Date.now() - started < 150, "should resolve well before the slow runCodex call");
});

test("summarize falls back when no runCodex function is provided", async () => {
  const summarizer = createPushSummarizer({});
  const result = await summarizer.summarize("runCodexなしのテスト");
  assert.equal(result, "runCodexなしのテスト");
});
