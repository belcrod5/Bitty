import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocationScheduleService,
  parseLocationScheduleRules,
  windowAt,
} from "../src/location-schedule-service.mjs";

const parseCodexOptions = (raw, reasoningEffort) => {
  const model = String(raw || "").replace(/^openai-codex\//, "").trim();
  if (!model) throw new Error("model required");
  return { modelInfo: { model, modelRef: `openai-codex/${model}` }, reasoningEffort };
};

function rule(overrides = {}) {
  return {
    id: "home",
    enabled: true,
    startTime: "09:00",
    endTime: "10:00",
    timeZone: "Asia/Tokyo",
    latitude: 35.6812,
    longitude: 139.7671,
    radiusMeters: 200,
    cwd: "/work/project",
    modelRef: "gpt-5.6-sol",
    reasoningEffort: "high",
    prompt: "run checks",
    ...overrides,
  };
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

async function withService(fn) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "location-schedule-"));
  let current = new Date("2026-07-18T23:59:00.000Z"); // 08:59 JST
  const executions = [];
  const storePath = path.join(temp, "store.json");
  const create = () => createLocationScheduleService({
    storePath,
    parseCodexOptions,
    executeTurn: async (request) => {
      executions.push(request);
      return { threadId: `thread-${executions.length}`, turnId: `turn-${executions.length}` };
    },
    validateCwd: async () => {},
    now: () => current,
    scheduleTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  try {
    await fn({ create, executions, setNow: (value) => { current = new Date(value); } });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

test("validates rules with the normal model parser and enabled-region limit", () => {
  assert.equal(parseLocationScheduleRules([rule()], "Asia/Tokyo", parseCodexOptions)[0].model, "gpt-5.6-sol");
  assert.throws(
    () => parseLocationScheduleRules(Array.from({ length: 21 }, (_, index) => rule({ id: `r${index}` })), "Asia/Tokyo", parseCodexOptions),
    /at most 20/
  );
  assert.throws(() => parseLocationScheduleRules([rule({ endTime: "08:00" })], "Asia/Tokyo", parseCodexOptions), /cross midnight/);
});

test("uses exact [start,end) boundaries in the phone timezone", () => {
  assert.equal(windowAt(rule(), new Date("2026-07-19T00:00:00.000Z")).active, true);
  assert.equal(windowAt(rule(), new Date("2026-07-19T01:00:00.000Z")).active, false);
  assert.equal(windowAt(rule(), new Date("2026-07-18T23:59:59.000Z")).active, false);
});

test("DST repeated local hour maps to one deterministic occurrence", () => {
  const dstRule = rule({ id: "dst", timeZone: "America/New_York", startTime: "01:00", endTime: "02:00" });
  const firstHour = windowAt(dstRule, new Date("2026-11-01T05:30:00.000Z"));
  const repeatedHour = windowAt(dstRule, new Date("2026-11-01T06:30:00.000Z"));
  assert.equal(firstHour.active, true);
  assert.equal(repeatedHour.active, true);
  assert.equal(firstHour.occurrenceKey, repeatedHour.occurrenceKey);
});

test("fires once when already inside at start and persists idempotency across restart", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    await service.recordState({ ruleId: "home", state: "inside", eventId: "initial", observedAt: "2026-07-18T23:59:00Z" });
    setNow("2026-07-19T00:00:00.000Z");
    await service.evaluate();
    await waitFor(() => executions.length === 1);
    await service.evaluate();
    const restarted = create();
    await restarted.start();
    assert.equal(executions.length, 1);
    const snapshot = await restarted.snapshot();
    assert.equal(Object.values(snapshot.occurrences)[0].status, "completed");
  });
});

test("enter during the window fires once; exit and re-entry do not duplicate", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:30:00.000Z");
    await service.recordState({ ruleId: "home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:30:00Z" });
    await waitFor(() => executions.length === 1);
    await service.recordState({ ruleId: "home", state: "outside", eventId: "exit-1", observedAt: "2026-07-19T00:31:00Z" });
    await service.recordState({ ruleId: "home", state: "inside", eventId: "enter-2", observedAt: "2026-07-19T00:32:00Z" });
    assert.equal(executions.length, 1);
  });
});

test("unknown/outside state does not fire and active-window edits are skipped", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:30:00.000Z");
    await service.evaluate();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule({ radiusMeters: 300 })] });
    await service.recordState({ ruleId: "home", state: "inside", eventId: "enter-after-edit", observedAt: "2026-07-19T00:30:00Z" });
    assert.equal(executions.length, 0);
    const snapshot = await service.snapshot();
    assert.equal(Object.values(snapshot.occurrences)[0].status, "skipped_edited_active_window");
  });
});

test("ignores an older delayed location event", async () => {
  await withService(async ({ create }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    await service.recordState({ ruleId: "home", state: "inside", eventId: "new", observedAt: "2026-07-19T00:00:00Z" });
    await service.recordState({ ruleId: "home", state: "outside", eventId: "old", observedAt: "2026-07-18T23:00:00Z" });
    assert.equal((await service.snapshot()).states.home.state, "inside");
  });
});
