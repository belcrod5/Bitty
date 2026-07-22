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

test("scheduled turns never wait for interactive approval", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:30:00.000Z");
    await service.recordState({
      ruleId: "home",
      regionRevision: "revision-home",
      state: "inside",
      eventId: "inside",
      observedAt: "2026-07-19T00:30:00Z",
    });
    await waitFor(() => executions.length === 1);
    assert.equal(executions[0].approvalPolicy, "never");
    await waitFor(async () => Object.values((await service.snapshot()).occurrences)[0]?.status === "completed");
  });
});

test("re-entry before five continuous minutes outside does not fire", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:05:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:05:00Z" });
    await waitFor(() => executions.length === 1);
    await waitFor(async () => Object.values((await service.snapshot()).occurrences)[0]?.status === "completed");
    setNow("2026-07-19T00:20:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-1", observedAt: "2026-07-19T00:20:00Z" });
    setNow("2026-07-19T00:24:59.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-2", observedAt: "2026-07-19T00:24:59Z" });
    assert.equal(executions.length, 1);
  });
});

test("future-skewed observedAt cannot manufacture five minutes outside at one Runner time", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:05:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:05:00Z" });
    await waitFor(() => executions.length === 1);
    await waitFor(async () => Object.values((await service.snapshot()).occurrences)[0]?.status === "completed");

    setNow("2026-07-19T00:20:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-skew", observedAt: "2026-07-19T00:20:00Z" });
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-skew", observedAt: "2026-07-19T00:25:00Z" });
    assert.equal(executions.length, 1);
  });
});

test("re-entry before the fifteen-minute cooldown does not fire", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:30:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:30:00Z" });
    await waitFor(() => executions.length === 1);
    await waitFor(async () => Object.values((await service.snapshot()).occurrences)[0]?.status === "completed");
    setNow("2026-07-19T00:31:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-1", observedAt: "2026-07-19T00:31:00Z" });
    setNow("2026-07-19T00:36:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-2", observedAt: "2026-07-19T00:36:00Z" });
    assert.equal(executions.length, 1);
  });
});

test("re-entry fires after both the outside minimum and cooldown", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:05:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:05:00Z" });
    await waitFor(() => executions.length === 1);
    await waitFor(async () => Object.values((await service.snapshot()).occurrences)[0]?.status === "completed");
    setNow("2026-07-19T00:20:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-1", observedAt: "2026-07-19T00:20:00Z" });
    setNow("2026-07-19T00:24:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "outside-refresh", observedAt: "2026-07-19T00:24:00Z" });
    setNow("2026-07-19T00:25:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-2", observedAt: "2026-07-19T00:25:00Z" });
    await waitFor(() => executions.length === 2);
    await waitFor(async () => Object.values((await service.snapshot()).occurrences).every((occurrence) => occurrence.status === "completed"));
  });
});

test("duplicate enter and same-inside refresh reports do not fire again", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:05:00.000Z");
    const firstEnter = { ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:05:00Z" };
    await service.recordState(firstEnter);
    await waitFor(() => executions.length === 1);
    await service.recordState(firstEnter);
    setNow("2026-07-19T00:25:00.000Z");
    await service.recordState({ ...firstEnter, eventId: "silent-push-inside", observedAt: "2026-07-19T00:25:00Z" });
    await service.evaluate();
    assert.equal(executions.length, 1);
  });
});

test("restart preserves rejected and qualified re-entry state", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:05:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:05:00Z" });
    await waitFor(() => executions.length === 1);
    await waitFor(async () => Object.values((await service.snapshot()).occurrences)[0]?.status === "completed");

    setNow("2026-07-19T00:20:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-short", observedAt: "2026-07-19T00:20:00Z" });
    setNow("2026-07-19T00:24:00.000Z");
    const beforeShortReentry = create();
    await beforeShortReentry.start();
    await beforeShortReentry.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-short", observedAt: "2026-07-19T00:24:00Z" });
    assert.equal(executions.length, 1);

    setNow("2026-07-19T00:25:00.000Z");
    await beforeShortReentry.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-long", observedAt: "2026-07-19T00:25:00Z" });
    setNow("2026-07-19T00:30:00.000Z");
    const beforeQualifiedReentry = create();
    await beforeQualifiedReentry.start();
    await beforeQualifiedReentry.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-qualified", observedAt: "2026-07-19T00:30:00Z" });
    await waitFor(() => executions.length === 2);
    await waitFor(async () => Object.values((await beforeQualifiedReentry.snapshot()).occurrences).every((occurrence) => occurrence.status === "completed"));
  });
});

test("version 1 state and occurrence records without re-entry fields remain compatible", async () => {
  await withService(async ({ create, executions, storePath, setNow }) => {
    const windowKey = "home|2026-07-19|09:00|10:00|Asia/Tokyo";
    await fs.writeFile(storePath, `${JSON.stringify({
      version: 1,
      phoneTimeZone: "Asia/Tokyo",
      rules: [rule()],
      states: {
        home: {
          regionRevision: "revision-home",
          state: "outside",
          eventId: "legacy-exit",
          observedAt: "2026-07-19T00:20:00.000Z",
          receivedAt: "2026-07-19T00:20:00.000Z",
        },
      },
      occurrences: {
        [windowKey]: {
          occurrenceKey: windowKey,
          ruleId: "home",
          status: "completed",
          threadId: "legacy-thread",
          turnId: "legacy-turn",
          errorMessage: "",
          createdAt: "2026-07-19T00:05:00.000Z",
          updatedAt: "2026-07-19T00:05:00.000Z",
        },
      },
      updatedAt: "2026-07-19T00:20:00.000Z",
    }, null, 2)}\n`, "utf8");
    setNow("2026-07-19T00:25:00.000Z");
    const service = create();
    await service.start();
    await service.recordState({
      ruleId: "home",
      regionRevision: "revision-home",
      state: "inside",
      eventId: "legacy-reentry",
      observedAt: "2026-07-19T00:25:00.000Z",
    });
    await waitFor(() => executions.length === 1);
    await waitFor(async () => Object.values((await service.snapshot()).occurrences).every((occurrence) => occurrence.status === "completed"));
  });
});

test("a failed firing still counts toward re-entry cooldown", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const service = create({
      executeTurn: async (request) => {
        executions.push(request);
        throw new Error("turn failed");
      },
    });
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:30:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:30:00Z" });
    await waitFor(() => executions.length === 1);
    await waitFor(async () => Object.values((await service.snapshot()).occurrences)[0]?.status === "failed");
    setNow("2026-07-19T00:31:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-1", observedAt: "2026-07-19T00:31:00Z" });
    setNow("2026-07-19T00:36:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-2", observedAt: "2026-07-19T00:36:00Z" });
    assert.equal(executions.length, 1);
    setNow("2026-07-19T00:40:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-2", observedAt: "2026-07-19T00:40:00Z" });
    setNow("2026-07-19T00:45:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-3", observedAt: "2026-07-19T00:45:00Z" });
    await waitFor(() => executions.length === 2);
    await waitFor(async () => Object.values((await service.snapshot()).occurrences).every((occurrence) => occurrence.status === "failed"));
  });
});

test("a qualified re-entry waits for an in-flight firing of the same rule", async () => {
  await withService(async ({ create, executions, setNow }) => {
    let releaseFirst;
    const firstTurn = new Promise((resolve) => { releaseFirst = resolve; });
    const service = create({
      executeTurn: async (request) => {
        executions.push(request);
        if (executions.length === 1) await firstTurn;
        return { threadId: `thread-${executions.length}`, turnId: `turn-${executions.length}` };
      },
    });
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:05:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:05:00Z" });
    await waitFor(() => executions.length === 1);

    setNow("2026-07-19T00:20:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-1", observedAt: "2026-07-19T00:20:00Z" });
    setNow("2026-07-19T00:25:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-2", observedAt: "2026-07-19T00:25:00Z" });
    assert.equal(executions.length, 1);
    assert.ok(Object.values((await service.snapshot()).occurrences).some((occurrence) => occurrence.status === "queued"));

    setNow("2026-07-19T00:26:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-2", observedAt: "2026-07-19T00:26:00Z" });

    setNow("2026-07-19T01:00:00.000Z");
    releaseFirst();
    await waitFor(() => executions.length === 2);
    await waitFor(async () => Object.values((await service.snapshot()).occurrences).every((occurrence) => occurrence.status === "completed"));
  });
});

test("restart fails an ambiguous running fire but executes a persisted queued re-entry", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const neverCompletes = new Promise(() => {});
    const service = create({
      executeTurn: async (request) => {
        executions.push(request);
        await neverCompletes;
      },
    });
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:05:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:05:00Z" });
    await waitFor(() => executions.length === 1);
    setNow("2026-07-19T00:20:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-1", observedAt: "2026-07-19T00:20:00Z" });
    setNow("2026-07-19T00:25:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-2", observedAt: "2026-07-19T00:25:00Z" });
    assert.ok(Object.values((await service.snapshot()).occurrences).some((occurrence) => occurrence.status === "queued"));

    const restarted = create();
    await restarted.start();
    await waitFor(() => executions.length === 2);
    await waitFor(async () => Object.values((await restarted.snapshot()).occurrences).some((occurrence) => occurrence.status === "completed"));
    const statuses = Object.values((await restarted.snapshot()).occurrences).map((occurrence) => occurrence.status);
    assert.deepEqual(statuses.sort(), ["completed", "failed_uncertain_after_restart"]);
  });
});

test("restart fails a valid queued claim after its rule was disabled before evaluation", async () => {
  await withService(async ({ create, executions, storePath, setNow }) => {
    const neverCompletes = new Promise(() => {});
    const service = create({
      executeTurn: async (request) => {
        executions.push(request);
        await neverCompletes;
      },
    });
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:05:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:05:00Z" });
    await waitFor(() => executions.length === 1);
    setNow("2026-07-19T00:20:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-1", observedAt: "2026-07-19T00:20:00Z" });
    setNow("2026-07-19T00:25:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-2", observedAt: "2026-07-19T00:25:00Z" });
    const persisted = await service.snapshot();
    persisted.rules[0].enabled = false;
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    executions.length = 0;

    const restarted = create();
    await restarted.start();
    assert.equal(executions.length, 0);
    const statuses = Object.values((await restarted.snapshot()).occurrences).map((occurrence) => occurrence.status);
    assert.deepEqual(statuses.sort(), [
      "failed_configuration_changed_while_queued",
      "failed_uncertain_after_restart",
    ]);
  });
});

test("prunes terminal re-entry claims after two days but keeps initial and active claims", async () => {
  await withService(async ({ create, executions, setNow, storePath }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:05:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:05:00Z" });
    await waitFor(() => executions.length === 1);
    await waitFor(async () => Object.values((await service.snapshot()).occurrences)[0]?.status === "completed");
    setNow("2026-07-19T00:20:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-1", observedAt: "2026-07-19T00:20:00Z" });
    setNow("2026-07-19T00:25:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-2", observedAt: "2026-07-19T00:25:00Z" });
    await waitFor(() => executions.length === 2);
    await waitFor(async () => Object.values((await service.snapshot()).occurrences).every((occurrence) => occurrence.status === "completed"));
    setNow("2026-07-19T00:26:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-2", observedAt: "2026-07-19T00:26:00Z" });

    setNow("2026-07-21T00:25:00.000Z");
    await service.evaluate();
    assert.equal(Object.keys((await service.snapshot()).occurrences).length, 2);
    setNow("2026-07-21T00:25:00.001Z");
    await service.evaluate();
    const retained = Object.values((await service.snapshot()).occurrences);
    assert.equal(retained.length, 1);
    assert.equal(retained[0].occurrenceKey, retained[0].windowKey);
    const persisted = JSON.parse(await fs.readFile(storePath, "utf8"));
    assert.equal(Object.keys(persisted.occurrences).length, 1);
  });

  await withService(async ({ create, setNow }) => {
    const neverCompletes = new Promise(() => {});
    const service = create({ executeTurn: async () => neverCompletes });
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:05:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:05:00Z" });
    await waitFor(async () => Object.values((await service.snapshot()).occurrences)[0]?.status === "running");
    setNow("2026-07-19T00:20:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-1", observedAt: "2026-07-19T00:20:00Z" });
    setNow("2026-07-19T00:25:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-2", observedAt: "2026-07-19T00:25:00Z" });
    setNow("2026-07-19T00:26:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-2", observedAt: "2026-07-19T00:26:00Z" });
    setNow("2026-10-28T02:00:00.000Z");
    await service.evaluate();
    const statuses = Object.values((await service.snapshot()).occurrences).map((occurrence) => occurrence.status);
    assert.deepEqual(statuses.sort(), ["queued", "running"]);
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

test("an active-window edit blocks re-entry after the initial firing", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    setNow("2026-07-19T00:05:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-1", observedAt: "2026-07-19T00:05:00Z" });
    await waitFor(() => executions.length === 1);
    await waitFor(async () => Object.values((await service.snapshot()).occurrences)[0]?.status === "completed");
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule({ prompt: "edited prompt" })] });
    setNow("2026-07-19T00:20:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "outside", eventId: "exit-1", observedAt: "2026-07-19T00:20:00Z" });
    setNow("2026-07-19T00:25:00.000Z");
    await service.recordState({ ruleId: "home", regionRevision: "revision-home", state: "inside", eventId: "enter-2", observedAt: "2026-07-19T00:25:00Z" });
    assert.equal(executions.length, 1);
    assert.ok(Object.values((await service.snapshot()).occurrences).some((occurrence) => (
      occurrence.status === "skipped_edited_active_window"
    )));
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
    await waitFor(async () => Object.values((await service.snapshot()).occurrences)[0]?.status === "completed");
  });
});

test("stale inside state stays fail-closed after the refresh request times out", async () => {
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

    // タイムアウト後も古い位置情報だけでは発火しない
    setNow("2026-07-19T00:02:00.000Z");
    assert.equal(await service.evaluate(), 0);
    assert.equal(executions.length, 0);
    assert.equal(refreshRequests.length, 1);
  });
});

test("stale outside state requests a refresh during an active window", async () => {
  await withService(async ({ create, executions, setNow }) => {
    const refreshRequests = [];
    const service = create({ requestStateRefresh: async (request) => refreshRequests.push(request) });
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    await service.recordState({
      ruleId: "home",
      regionRevision: "revision-home",
      state: "outside",
      eventId: "stale-outside",
      observedAt: "2026-07-18T23:40:00Z",
    });
    setNow("2026-07-19T00:00:00.000Z");
    await service.evaluate();
    await waitFor(() => refreshRequests.length === 1);
    assert.equal(refreshRequests[0].rules[0].id, "home");
    assert.equal(executions.length, 0);
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

test("rejects a location event too far in the future", async () => {
  await withService(async ({ create }) => {
    const service = create();
    await service.replaceSchedules({ phoneTimeZone: "Asia/Tokyo", rules: [rule()] });
    await assert.rejects(
      service.recordState({
        ruleId: "home",
        regionRevision: "revision-home",
        state: "inside",
        eventId: "future",
        observedAt: "2099-01-01T00:00:00Z",
      }),
      /future/
    );
    assert.equal((await service.snapshot()).states.home, undefined);
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

test("fails closed without executing a malformed persisted queued claim", async () => {
  await withService(async ({ create, executions, storePath, setNow }) => {
    setNow("2026-07-19T00:30:00.000Z");
    const corrupt = `${JSON.stringify({
      version: 1,
      phoneTimeZone: "Asia/Tokyo",
      rules: [rule()],
      states: {},
      occurrences: {
        "wrong-map-key": {
          occurrenceKey: "home|2026-07-19|09:00|10:00|Asia/Tokyo",
          windowKey: "home|2026-07-19|09:00|10:00|Asia/Tokyo",
          ruleId: "home",
          ruleSignature: "untrusted",
          status: "queued",
          createdAt: "2026-07-19T00:30:00.000Z",
          updatedAt: "2026-07-19T00:30:00.000Z",
        },
      },
      updatedAt: "2026-07-19T00:30:00.000Z",
    }, null, 2)}\n`;
    await fs.writeFile(storePath, corrupt, "utf8");
    const service = create();

    await assert.rejects(service.start(), /key mismatch/);
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
