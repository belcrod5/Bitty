import assert from "node:assert/strict";
import test from "node:test";
import { createTranscriptInactivityTimer } from "../src/stt-transcript-inactivity.mjs";

test("text inactivity starts only with recognized text and ignores duplicate responses", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let completions = 0;
  const timer = createTranscriptInactivityTimer(() => { completions += 1; });
  timer.update(" \t");
  t.mock.timers.tick(3_000);
  assert.equal(completions, 0);
  timer.update("一");
  t.mock.timers.tick(1_999);
  timer.update("一");
  assert.equal(completions, 0);
  t.mock.timers.tick(1);
  assert.equal(completions, 1);
  timer.stop();
});

test("changed text restarts inactivity and empty text disarms it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let completions = 0;
  const timer = createTranscriptInactivityTimer(() => { completions += 1; });
  timer.update("前");
  t.mock.timers.tick(1_500);
  timer.update("新");
  t.mock.timers.tick(1_500);
  assert.equal(completions, 0);
  timer.update("");
  t.mock.timers.tick(2_000);
  assert.equal(completions, 0);
  timer.update("次");
  t.mock.timers.tick(2_000);
  assert.equal(completions, 1);
  timer.stop();
});

test("stopped sessions cannot rearm timers or affect a new session", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let firstCompletions = 0;
  let nextCompletions = 0;
  const first = createTranscriptInactivityTimer(() => { firstCompletions += 1; });
  first.update("旧");
  first.stop();
  first.update("遅延応答");
  const next = createTranscriptInactivityTimer(() => { nextCompletions += 1; });
  t.mock.timers.tick(2_000);
  assert.equal(firstCompletions, 0);
  assert.equal(nextCompletions, 0);
  next.update("新");
  t.mock.timers.tick(2_000);
  assert.equal(nextCompletions, 1);
  next.stop();
});
