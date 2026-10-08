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

test("title generation uses only the selected model and an advertised effort", () => {
  assert.equal(selectTitleModel(catalog, "gpt-6-luna", "low")?.modelId, "gpt-6-luna");
  assert.equal(selectTitleModel(catalog.slice(1), "gpt-6-luna", "low"), null);
  assert.equal(selectTitleModel(catalog, "gpt-6.1-sol", "low"), null);
  assert.equal(selectTitleModel(catalog, "gpt-6.1-sol", "high")?.modelId, "gpt-6.1-sol");
  assert.equal(selectTitleModel(catalog, "gpt-6.1-luna", "high"), null);
  assert.equal(selectTitleModel([{ modelId: "gpt-6.1-luna", effortOptions: [] }, catalog[0]], "gpt-6.1-luna", "low"), null);
  assert.equal(selectTitleModel(catalog, "missing", "low"), null);
});

test("generated titles use the selected model and preserve marker changes", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-title-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createClientStateStore(path.join(dir, "client-state.json"));
  assert.deepEqual(await store.getTitleSettings(), { modelId: "gpt-6-luna", reasoningEffort: "low" });
  await store.mutate({ type: "session.set", backendId: "codex", sessionId: "first-chat", markerColor: "red" });
  let options;
  let input;
  const saved = await generateAutomaticChatTitle({
    input: "旅行は11月1日に行きたい", sessionRef, catalog, store,
    runCodex: async (prompt, opts) => { input = prompt; options = opts; return "「旅行 11/1」\n余計な説明"; },
  });
  assert.equal(saved, true);
  assert.equal(options.modelInfo.model, "gpt-6-luna");
  assert.equal(options.reasoningEffort, "low");
  assert.deepEqual(JSON.parse(input), { firstMessage: "旅行は11月1日に行きたい" });
  assert.match(options.instructions, /12文字程度/u);
  assert.match(options.instructions, /途中で切らない/u);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.sessions[JSON.stringify(["codex", "first-chat"])].title, "旅行 11/1");
  assert.equal(snapshot.sessions[JSON.stringify(["codex", "first-chat"])].markerColor, "red");
  const reopened = createClientStateStore(path.join(dir, "client-state.json"));
  assert.deepEqual(await reopened.getTitleSettings(), { modelId: "gpt-6-luna", reasoningEffort: "low" });
  assert.equal((await reopened.snapshot()).sessions[JSON.stringify(["codex", "first-chat"])].titleSource, "generated");
  assert.equal(normalizeAutomaticTitle("タイトル: お問い合わせ内容修正と確認"), "お問い合わせ内容修正と確認");
});

test("natural titles longer than the guideline are saved without cutting words", async () => {
  const title = "音声認識の誤変換と文脈補正";
  let saved;
  assert.equal(await generateAutomaticChatTitle({
    input: "音声認識の誤変換を会話の文脈で直したい", sessionRef, catalog,
    store: { getTitleSettings: async () => ({ modelId: "gpt-6-luna", reasoningEffort: "low" }),
      setGeneratedTitle: async (_ref, value) => { saved = value; return true; } },
    runCodex: async () => `「${title}」`,
  }), true);
  assert.equal(saved, title);
  assert.equal(normalizeAutomaticTitle("  \nタイトル： 『自然な　短いタイトル』\n説明"), "自然な 短いタイトル");
});

test("title effort is independent, persisted, and passed to the selected model", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-title-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "client-state.json");
  const store = createClientStateStore(file);
  await store.mutate({ type: "title-settings.set", modelId: "gpt-6.1-sol", reasoningEffort: "high" });
  let called;
  assert.equal(await generateAutomaticChatTitle({
    input: "設計レビュー", sessionRef, catalog, store,
    runCodex: async (_prompt, options) => { called = options; return "設計レビュー"; },
  }), true);
  assert.equal(called.modelInfo.model, "gpt-6.1-sol");
  assert.equal(called.reasoningEffort, "high");
  assert.deepEqual(await createClientStateStore(file).getTitleSettings(), {
    modelId: "gpt-6.1-sol", reasoningEffort: "high",
  });
  const warnings = [];
  assert.equal(await generateAutomaticChatTitle({
    input: "後からモデル契約変更", sessionRef: { ...sessionRef, nativeSessionId: "other-chat" },
    catalog: [{ modelId: "gpt-6.1-sol", effortOptions: ["low"] }], store,
    runCodex: () => { throw new Error("unsupported effort should not call Codex"); },
    log: { warn: (message) => warnings.push(message) },
  }), false);
  assert.match(warnings[0], /model\/effort unavailable/u);
  await assert.rejects(store.mutate({ type: "title-settings.set", modelId: "", reasoningEffort: "high" }),
    /modelId is invalid/u);
  assert.deepEqual(await store.getTitleSettings(), { modelId: "gpt-6.1-sol", reasoningEffort: "high" });
});

test("the default GPT-6 Luna model can use another advertised effort", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-title-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createClientStateStore(path.join(dir, "client-state.json"));
  await store.mutate({ type: "title-settings.set", modelId: "gpt-6-luna", reasoningEffort: "medium" });
  let effort;
  assert.equal(await generateAutomaticChatTitle({
    input: "旅行計画", sessionRef, catalog: [{ modelId: "gpt-6-luna", effortOptions: ["low", "medium"] }], store,
    runCodex: async (_prompt, options) => { effort = options.reasoningEffort; return "旅行計画"; },
  }), true);
  assert.equal(effort, "medium");
});

test("legacy and empty title settings load as GPT-6 Luna/low", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-title-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "client-state.json");
  const oldState = { version: 1, revision: 0, directories: [], sessions: {}, composerHistory: [], drafts: {} };
  await fs.writeFile(file, JSON.stringify(oldState));
  assert.deepEqual(await createClientStateStore(file).getTitleSettings(), { modelId: "gpt-6-luna", reasoningEffort: "low" });
  await fs.writeFile(file, JSON.stringify({ ...oldState, titleModelId: "", titleReasoningEffort: "high" }));
  const restored = createClientStateStore(file);
  assert.deepEqual(await restored.getTitleSettings(), { modelId: "gpt-6-luna", reasoningEffort: "low" });
  assert.equal((await restored.snapshot()).titleModelId, "gpt-6-luna");
  await fs.writeFile(file, JSON.stringify({ ...oldState, titleModelId: "  ", titleReasoningEffort: "high" }));
  assert.deepEqual(await createClientStateStore(file).getTitleSettings(), { modelId: "gpt-6-luna", reasoningEffort: "low" });
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
