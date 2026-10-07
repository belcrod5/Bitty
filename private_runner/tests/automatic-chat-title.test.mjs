import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateAutomaticChatTitle, normalizeAutomaticTitle, selectTitleModel } from "../src/automatic-chat-title.mjs";
import { createClientStateStore } from "../src/client-state-store.mjs";

const sessionRef = { backendId: "codex", nativeSessionId: "first-chat" };
const catalog = [
  { modelId: "gpt-6-luna", effortOptions: ["low"] },
  { modelId: "gpt-6.1-luna", effortOptions: ["low", "medium"] },
  { modelId: "gpt-6.1-sol", effortOptions: ["high"] },
];

test("title model prefers 6.1 Luna, falls back to 6 Luna, and requires low effort", () => {
  assert.equal(selectTitleModel(catalog)?.modelId, "gpt-6.1-luna");
  assert.equal(selectTitleModel(catalog.slice(0, 1))?.modelId, "gpt-6-luna");
  assert.equal(selectTitleModel(catalog, "gpt-6.1-sol"), null);
  assert.equal(selectTitleModel([{ modelId: "gpt-6.1-luna", effortOptions: [] }, catalog[0]])?.modelId, "gpt-6-luna");
  assert.equal(selectTitleModel(catalog, "missing"), null);
});

test("generated titles use the selected model and preserve marker changes", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-title-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createClientStateStore(path.join(dir, "client-state.json"));
  await store.mutate({ type: "title-model.set", modelId: "gpt-6-luna" });
  await store.mutate({ type: "session.set", backendId: "codex", sessionId: "first-chat", markerColor: "red" });
  let options;
  const saved = await generateAutomaticChatTitle({
    input: "旅行は11月1日に行きたい", sessionRef, catalog, store,
    runCodex: async (_prompt, opts) => { options = opts; return "「旅行 11/1」\n余計な説明"; },
  });
  assert.equal(saved, true);
  assert.equal(options.modelInfo.model, "gpt-6-luna");
  assert.equal(options.reasoningEffort, "low");
  const snapshot = await store.snapshot();
  assert.equal(snapshot.sessions[JSON.stringify(["codex", "first-chat"])].title, "旅行 11/1");
  assert.equal(snapshot.sessions[JSON.stringify(["codex", "first-chat"])].markerColor, "red");
  const reopened = createClientStateStore(path.join(dir, "client-state.json"));
  assert.equal(await reopened.getTitleModelId(), "gpt-6-luna");
  assert.equal((await reopened.snapshot()).sessions[JSON.stringify(["codex", "first-chat"])].titleSource, "generated");
  assert.equal(normalizeAutomaticTitle("タイトル: お問い合わせ内容修正と確認"), "お問い合わせ内容修正と確認".slice(0, 12));
});

test("manual edit and explicit clear win when title generation finishes later", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-title-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createClientStateStore(path.join(dir, "client-state.json"));
  let release;
  const reply = new Promise((resolve) => { release = resolve; });
  const generating = generateAutomaticChatTitle({
    input: "内容を直して", sessionRef, catalog, store, runCodex: () => reply,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await store.mutate({ type: "session.set", backendId: "codex", sessionId: "first-chat", title: "" });
  release("内容修正");
  assert.equal(await generating, false);
  assert.equal((await store.snapshot()).sessions[JSON.stringify(["codex", "first-chat"])].title, "");
  await store.mutate({ type: "session.set", backendId: "codex", sessionId: "first-chat", title: "自分の題名" });
  assert.equal(await store.setGeneratedTitle(sessionRef, "別の題名"), false);
  assert.equal((await store.snapshot()).sessions[JSON.stringify(["codex", "first-chat"])].title, "自分の題名");
  const reopened = createClientStateStore(path.join(dir, "client-state.json"));
  assert.equal(await reopened.setGeneratedTitle(sessionRef, "遅い題名"), false);
});

test("failed or timed-out title requests never save a late title", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-title-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createClientStateStore(path.join(dir, "client-state.json"));
  const log = { warn: () => {} };
  assert.equal(await generateAutomaticChatTitle({
    input: "失敗する要求", sessionRef, catalog, store, log,
    runCodex: async () => { throw new Error("offline"); },
  }), false);
  const timer = t.mock.timers;
  timer.enable({ apis: ["setTimeout"] });
  let release;
  const reply = new Promise((resolve) => { release = resolve; });
  const pending = generateAutomaticChatTitle({
    input: "時間切れ", sessionRef, catalog, store, log, runCodex: () => reply,
  });
  await new Promise((resolve) => setImmediate(resolve));
  timer.tick(20_000);
  release("遅い題名");
  assert.equal(await pending, false);
  timer.reset();
  assert.equal(await store.getSessionTitles([sessionRef]).then((titles) => titles[0]), "");
});
