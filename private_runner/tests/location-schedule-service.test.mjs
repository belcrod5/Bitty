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
    regionRevision: "revision-home",
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
  const create = (overrides = {}) => createLocationScheduleService({
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
    ...overrides,
  });
  try {
    await fn({ create, executions, storePath, setNow: (value) => { current = new Date(value); } });
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
  assert.throws(() => parseLocationScheduleRules([rule({ regionRevision: "" })], "Asia/Tokyo", parseCodexOptions), /regionRevision is invalid/);
  assert.throws(() => parseLocationScheduleRules([rule({ modelRef: "" })], "Asia/Tokyo", parseCodexOptions), /modelRef is required/);
  assert.throws(() => parseLocationScheduleRules([rule({ reasoningEffort: "" })], "Asia/Tokyo", parseCodexOptions), /reasoningEffort is invalid/);
  assert.throws(() => parseLocationScheduleRules([rule({ reasoningEffort: "minimal" })], "Asia/Tokyo", parseCodexOptions), /reasoningEffort is invalid/);
});

test("does not let the normal Codex parser default missing scheduled model or effort", () => {
  let parserCalls = 0;
  const defaultingParser = () => {
    parserCalls += 1;
    return {
      modelInfo: { model: "fallback", modelRef: "openai-codex/fallback" },
      reasoningEffort: "medium",
    };
  };
  assert.throws(
    () => parseLocationScheduleRules([rule({ modelRef: "" })], "Asia/Tokyo", defaultingParser),
    /modelRef is required/
  );
  assert.throws(
    () => parseLocationScheduleRules([rule({ reasoningEffort: "" })], "Asia/Tokyo", defaultingParser),
    /reasoningEffort is invalid/
  );
  assert.equal(parserCalls, 0);
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
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "initial", observedAt: "2026-07-18T23:59:00Z" });
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
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:30:00Z" });
    await waitFor(() => executions.length === 1);
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-1", observedAt: "2026-07-19T00:31:00Z" });
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-2", observedAt: "2026-07-19T00:32:00Z" });
    assert.equal(executions.length, 1);
  });
});

test("unknown/outside state does not fire and active-window edits are skipped", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:30:00.000Z");
    await service.evaluate();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule({ radiusMeters: 300, regionRevision: "revision-home-moved" })] });
    await service.recordState({ ruleId: "home", regionRevision: "revision-home-moved", state: "inside", eventId: "enter-after-edit", observedAt: "2026-07-19T00:30:00Z" });
    assert.equal(executions.length, 0);
    const snapshot = await service.snapshot();
    assert.equal(Object.values(snapshot.occurrences)[0].status, "skipped_edited_active_window");
  });
});

test("stale state at window start defers firing until a fresh report arrives", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const refreshRequests = [];
    const service = create({ requestStateRefresh: async (request) => refreshRequests.push(request) });
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "stale", observedAt: "2026-07-18T23:40:00Z" });
    setNow("2026-07-19T00:00:00.000Z");
    await service.evaluate();
    assert.equal(executions.length, 0);
    await waitFor(() => refreshRequests.length === 1);
    assert.equal(refreshRequests[0].rules[0].id, "home");

    // 圏外の新しい報告が来たら発火しない
    setNow("2026-07-19T00:00:30.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "fresh-outside", observedAt: "2026-07-19T00:00:30Z" });
    assert.equal(executions.length, 0);

    // 新しい圏内報告が来たら発火する
    setNow("2026-07-19T00:01:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "fresh-inside", observedAt: "2026-07-19T00:01:00Z" });
    await waitFor(() => executions.length === 1);
    assert.equal(refreshRequests.length, 1);
  });
});

test("stale state falls back to firing after the refresh request times out", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const refreshRequests = [];
    const service = create({ requestStateRefresh: async (request) => refreshRequests.push(request) });
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "stale", observedAt: "2026-07-18T23:40:00Z" });
    setNow("2026-07-19T00:00:00.000Z");
    await service.evaluate();
    assert.equal(executions.length, 0);
    await waitFor(() => refreshRequests.length === 1);

    // タイムアウト前は発火せず、要求も重複しない
    setNow("2026-07-19T00:01:00.000Z");
    await service.evaluate();
    assert.equal(executions.length, 0);
    assert.equal(refreshRequests.length, 1);

    // タイムアウト後は従来どおり最終状態で発火する
    setNow("2026-07-19T00:02:00.000Z");
    await service.evaluate();
    await waitFor(() => executions.length === 1);
    assert.equal(refreshRequests.length, 1);
  });
});

test("ignores an older delayed location event", async () => {
  await withService(async ({ create }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "new", observedAt: "2026-07-19T00:00:00Z" });
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "old", observedAt: "2026-07-18T23:00:00Z" });
    assert.equal((await service.snapshot()).states.home.state, "inside");
  });
});

test("rejects stale region state after a location revision changes", async () => {
  await withService(async ({ create, executions }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    await service.recordState({
      ruleId: "home",
      regionRevision: "revision-home",
      state: "inside",
      eventId: "before-move",
      observedAt: "2026-07-18T23:59:00Z",
    });
    await assert.rejects(
      service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule({ latitude: 36 })] }),
      /regionRevision must change exactly when its location changes/
    );
    await assert.rejects(
      service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule({ prompt: "edited", regionRevision: "prompt-only-revision" })] }),
      /regionRevision must change exactly when its location changes/
    );

    await service.replaceSchedules({
      phoneTimeZone: "Asia/Tokyo",
      rules: [rule({ latitude: 36, regionRevision: "revision-home-moved" })],
    });
    await assert.rejects(
      service.recordState({
        ruleId: "home",
        regionRevision: "revision-home",
        state: "inside",
        eventId: "stale-after-move",
        observedAt: "2026-07-19T00:00:00Z",
      }),
      /stale regionRevision/
    );
    assert.equal((await service.snapshot()).states.home, undefined);
    assert.equal(executions.length, 0);
  });
});

test("fails closed without changing a corrupt existing store", async () => {
  await withService(async ({ create, executions, storePath, setNow }) => {
    const corrupt = "{not-json";
    await fs.writeFile(storePath, corrupt, "utf8");
    setNow("2026-07-19T00:30:00.000Z");
    const service = create();

    await assert.rejects(service.start(), /failed to load location schedule store/);
    await assert.rejects(service.evaluate(), /failed to load location schedule store/);
    assert.equal(executions.length, 0);
    assert.equal(await fs.readFile(storePath, "utf8"), corrupt);
  });
});

test("fails closed without changing persisted rules with invalid model or effort", async () => {
  await withService(async ({ create, executions, storePath, setNow }) => {
    setNow("2026-07-19T00:30:00.000Z");
    for (const invalidRule of [rule({ modelRef: "" }), rule({ reasoningEffort: "" })]) {
      const persisted = `${JSON.stringify({
        version: 1,
        phoneTimeZone: "Asia/Tokyo",
        rules: [invalidRule],
        states: {
          home: {
            state: "inside",
            regionRevision: invalidRule.regionRevision,
            eventId: "inside",
            observedAt: "2026-07-19T00:30:00.000Z",
            receivedAt: "2026-07-19T00:30:00.000Z",
          },
        },
        occurrences: {},
        updatedAt: "2026-07-19T00:30:00.000Z",
      }, null, 2)}\n`;
      await fs.writeFile(storePath, persisted, "utf8");
      const service = create();

      await assert.rejects(service.start(), /failed to load location schedule store/);
      await assert.rejects(service.snapshot(), /failed to load location schedule store/);
      assert.equal(await fs.readFile(storePath, "utf8"), persisted);
    }
    assert.equal(executions.length, 0);
  });
});
