import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexScheduleHttpHandler } from "../src/codex-schedule-http.mjs";
import {
  CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES,
  CODEX_SCHEDULE_RUNTIME_MAX_BYTES,
  CodexScheduleRevisionConflictError,
  CodexScheduleStoreUnavailableError,
  codexScheduleDefinitionHash,
  createCodexScheduleService,
} from "../src/codex-schedule-service.mjs";

const ID_A = "11111111-1111-4111-8111-111111111111";

function clock(initial = "2026-08-13T00:00:00.000Z") {
  let current = new Date(initial);
  return {
    now: () => new Date(current),
    set: (value) => { current = new Date(value); },
  };
}

function definition(overrides = {}) {
  return {
    id: ID_A,
    name: "Daily check",
    enabled: true,
    startLocal: "2026-08-14T09:00:00",
    timeZone: "Asia/Tokyo",
    rrule: "FREQ=DAILY",
    cwd: process.cwd(),
    modelRef: "openai-codex/gpt-5.6",
    reasoningEffort: "high",
    prompt: "Check the project",
    ...overrides,
  };
}

function parseCodexOptions(modelRef, reasoningEffort) {
  const normalized = String(modelRef).includes("/")
    ? String(modelRef)
    : `openai-codex/${modelRef}`;
  return {
    modelInfo: { modelRef: normalized, model: normalized.split("/")[1] },
    reasoningEffort,
  };
}

async function makeHarness(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-schedule-test-"));
  const definitionsPath = path.join(directory, "codex_schedules.json");
  const runtimePath = path.join(directory, "codex_schedule_runtime.json");
  const currentClock = options.clock || clock();
  const timers = [];
  const service = createCodexScheduleService({
    definitionsPath,
    runtimePath,
    parseCodexOptions: options.parseCodexOptions || parseCodexOptions,
    validateCwd: options.validateCwd || (async (cwd) => {
      if (!(await fs.stat(cwd)).isDirectory()) throw new Error("not a directory");
    }),
    startNormalCodexTurn: options.startNormalCodexTurn || (async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
    })),
    now: currentClock.now,
    scheduleTimer: options.scheduleTimer || ((callback, delay) => {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    }),
    clearTimer: options.clearTimer || ((timer) => { timer.cleared = true; }),
    fileSystem: options.fileSystem,
  });
  return { directory, definitionsPath, runtimePath, currentClock, timers, service };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

test("missing stores initialize empty while corrupt or orphaned stores fail closed", async (t) => {
  const empty = await makeHarness();
  t.after(() => fs.rm(empty.directory, { recursive: true, force: true }));
  assert.deepEqual(await empty.service.snapshot(), { revision: 0, schedules: [] });
  assert.equal((await readJson(empty.definitionsPath)).revision, 0);
  assert.equal((await readJson(empty.runtimePath)).definitionsRevision, 0);

  for (const kind of ["definitions", "runtime", "orphaned-runtime"]) {
    const harness = await makeHarness();
    t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
    if (kind === "definitions") {
      await fs.writeFile(harness.definitionsPath, "{broken", "utf8");
    } else if (kind === "runtime") {
      await fs.writeFile(harness.definitionsPath, JSON.stringify({
        version: 1, revision: 0, schedules: [], updatedAt: harness.currentClock.now().toISOString(),
      }));
      await fs.writeFile(harness.runtimePath, "{broken", "utf8");
    } else {
      await fs.writeFile(harness.runtimePath, JSON.stringify({
        version: 1, definitionsRevision: 0, runtimes: {}, updatedAt: harness.currentClock.now().toISOString(),
      }));
    }
    await assert.rejects(harness.service.snapshot(), CodexScheduleStoreUnavailableError);
    await assert.rejects(harness.service.replaceSchedules({ baseRevision: 0, schedules: [] }),
      CodexScheduleStoreUnavailableError);
  }
});

test("replacement is atomic, serialized, and preserves action-only next occurrence", async (t) => {
  const renameTargets = [];
  const fileSystem = {
    ...fs,
    rename: async (source, target) => {
      renameTargets.push(target);
      await fs.rename(source, target);
    },
  };
  const harness = await makeHarness({ fileSystem });
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  await harness.service.snapshot();
  renameTargets.length = 0;

  const created = await harness.service.replaceSchedules({ baseRevision: 0, schedules: [definition()] });
  assert.equal(created.revision, 1);
  assert.equal(created.schedules[0].nextOccurrenceAt, "2026-08-14T00:00:00.000Z");
  assert.deepEqual(renameTargets, [harness.definitionsPath, harness.runtimePath]);

  const actionEdit = definition({ name: "Renamed", prompt: "A new action" });
  const edited = await harness.service.replaceSchedules({ baseRevision: 1, schedules: [actionEdit] });
  assert.equal(edited.schedules[0].nextOccurrenceAt, created.schedules[0].nextOccurrenceAt);
  assert.equal(edited.schedules[0].lastDispatch, null);

  const staleSave = harness.service.replaceSchedules({ baseRevision: 2, schedules: [] });
  const competingSave = harness.service.replaceSchedules({ baseRevision: 2, schedules: [actionEdit] });
  assert.equal((await staleSave).revision, 3);
  await assert.rejects(competingSave, (error) =>
    error instanceof CodexScheduleRevisionConflictError && error.revision === 3);
  assert.deepEqual(await harness.service.snapshot(), { revision: 3, schedules: [] });
  assert.equal(harness.service.timerArmed, false);
});

test("trigger edits, disable, and re-enable always calculate strictly from save time", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  await harness.service.replaceSchedules({ baseRevision: 0, schedules: [definition()] });
  harness.currentClock.set("2026-08-14T00:30:00.000Z");

  let snapshot = await harness.service.replaceSchedules({
    baseRevision: 1,
    schedules: [definition({ startLocal: "2026-08-14T10:00:00" })],
  });
  assert.equal(snapshot.schedules[0].nextOccurrenceAt, "2026-08-14T01:00:00.000Z");
  snapshot = await harness.service.replaceSchedules({
    baseRevision: 2,
    schedules: [definition({ enabled: false, startLocal: "2026-08-14T10:00:00" })],
  });
  assert.equal(snapshot.schedules[0].nextOccurrenceAt, null);
  harness.currentClock.set("2026-08-14T01:30:00.000Z");
  snapshot = await harness.service.replaceSchedules({
    baseRevision: 3,
    schedules: [definition({ startLocal: "2026-08-14T10:00:00" })],
  });
  assert.equal(snapshot.schedules[0].nextOccurrenceAt, "2026-08-15T01:00:00.000Z");
});

test("revision mismatch recovery rebuilds future runtime and keeps only matching dispatch", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  const schedule = definition();
  const definitionHash = codexScheduleDefinitionHash(schedule);
  await fs.writeFile(harness.definitionsPath, `${JSON.stringify({
    version: 1,
    revision: 2,
    schedules: [schedule],
    updatedAt: "2026-08-12T00:00:00.000Z",
  })}\n`);
  await fs.writeFile(harness.runtimePath, `${JSON.stringify({
    version: 1,
    definitionsRevision: 1,
    runtimes: {
      [ID_A]: {
        definitionHash,
        nextOccurrenceAt: "2026-08-13T00:00:00.000Z",
        lastDispatch: {
          occurrenceAt: "2026-08-12T00:00:00.000Z",
          claimedAt: "2026-08-12T00:00:00.000Z",
          definitionHash,
          status: "fired",
          threadId: "thread-old",
          turnId: "turn-old",
          errorCode: "",
          errorMessage: "",
          updatedAt: "2026-08-12T00:00:00.000Z",
        },
      },
      "22222222-2222-4222-8222-222222222222": {
        definitionHash: "a".repeat(64), nextOccurrenceAt: null, lastDispatch: null,
      },
    },
    updatedAt: "2026-08-12T00:00:00.000Z",
  })}\n`);

  const snapshot = await harness.service.snapshot();
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.schedules[0].nextOccurrenceAt, "2026-08-14T00:00:00.000Z");
  assert.equal(snapshot.schedules[0].lastDispatch.threadId, "thread-old");
  const runtime = await readJson(harness.runtimePath);
  assert.deepEqual(Object.keys(runtime.runtimes), [ID_A]);
  assert.equal(runtime.definitionsRevision, 2);
});

test("a missing runtime rebuilds strictly future and does not catch up old one-time work", async (t) => {
  const harness = await makeHarness({ clock: clock("2026-08-15T00:00:00.000Z") });
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  await fs.writeFile(harness.definitionsPath, `${JSON.stringify({
    version: 1,
    revision: 4,
    schedules: [definition({ rrule: null })],
    updatedAt: "2026-08-14T00:00:00.000Z",
  })}\n`);
  const snapshot = await harness.service.snapshot();
  assert.equal(snapshot.revision, 4);
  assert.equal(snapshot.schedules[0].nextOccurrenceAt, null);
  assert.equal(snapshot.schedules[0].lastDispatch, null);
  assert.equal((await readJson(harness.runtimePath)).definitionsRevision, 4);
});

test("matching revisions with a stale definition hash fail closed", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  await harness.service.replaceSchedules({ baseRevision: 0, schedules: [definition()] });
  const runtime = await readJson(harness.runtimePath);
  runtime.runtimes[ID_A].definitionHash = "a".repeat(64);
  await fs.writeFile(harness.runtimePath, `${JSON.stringify(runtime)}\n`);
  const restarted = createCodexScheduleService({
    definitionsPath: harness.definitionsPath,
    runtimePath: harness.runtimePath,
    parseCodexOptions,
    validateCwd: async () => {},
    startNormalCodexTurn: async () => ({ threadId: "thread", turnId: "turn" }),
    now: harness.currentClock.now,
  });
  await assert.rejects(restarted.snapshot(), CodexScheduleStoreUnavailableError);
  const responses = [];
  const handler = createCodexScheduleHttpHandler({
    service: restarted,
    runnerToken: "secret",
    parseAuthToken: () => "secret",
    readJsonBody: async () => ({}),
    json: (_res, status, payload) => responses.push({ status, payload }),
  });
  await handler({ method: "GET" }, {}, "/codex-schedules");
  assert.equal(responses[0].status, 503);
  assert.equal(responses[0].payload.error, "codex_schedule_store_unavailable");
});

test("startup catches up one-time once and recurring schedules at only the latest occurrence", async (t) => {
  const starts = [];
  const oneTime = await makeHarness({
    startNormalCodexTurn: async (request) => {
      starts.push(request);
      const runtime = await readJson(oneTime.runtimePath);
      assert.equal(runtime.runtimes[ID_A].lastDispatch.status, "claimed");
      return { threadId: "thread-one", turnId: "turn-one" };
    },
  });
  t.after(() => fs.rm(oneTime.directory, { recursive: true, force: true }));
  await oneTime.service.replaceSchedules({
    baseRevision: 0,
    schedules: [definition({ rrule: null })],
  });
  oneTime.currentClock.set("2026-08-15T00:00:00.000Z");
  await oneTime.service.start();
  await oneTime.service.evaluate();
  assert.equal(starts.length, 1);
  let snapshot = await oneTime.service.snapshot();
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.schedules[0].nextOccurrenceAt, null);
  assert.equal(snapshot.schedules[0].lastDispatch.status, "fired");
  assert.equal(starts[0].serviceName, "private-runner-codex-schedule");

  const recurringStarts = [];
  const recurring = await makeHarness({
    clock: clock("2026-08-12T00:00:00.000Z"),
    startNormalCodexTurn: async (request) => {
      recurringStarts.push(request);
      return { threadId: "thread-recurring", turnId: "turn-recurring" };
    },
  });
  t.after(() => fs.rm(recurring.directory, { recursive: true, force: true }));
  await recurring.service.replaceSchedules({ baseRevision: 0, schedules: [definition()] });
  recurring.currentClock.set("2026-08-17T12:00:00.000Z");
  await recurring.service.start();
  snapshot = await recurring.service.snapshot();
  assert.equal(recurringStarts.length, 1);
  assert.equal(snapshot.schedules[0].lastDispatch.occurrenceAt, "2026-08-17T00:00:00.000Z");
  assert.equal(snapshot.schedules[0].nextOccurrenceAt, "2026-08-18T00:00:00.000Z");
});

test("overlapping evaluation dispatches once and restart never retries a persisted claim", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const harness = await makeHarness({
    startNormalCodexTurn: async () => {
      calls += 1;
      await gate;
      return { threadId: "thread", turnId: "turn" };
    },
  });
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  await harness.service.replaceSchedules({ baseRevision: 0, schedules: [definition({ rrule: null })] });
  harness.currentClock.set("2026-08-14T00:00:00.000Z");
  const first = harness.service.evaluate();
  const second = harness.service.evaluate();
  await waitFor(() => calls === 1);
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);

  const runtime = await readJson(harness.runtimePath);
  runtime.runtimes[ID_A].lastDispatch.status = "claimed";
  runtime.runtimes[ID_A].lastDispatch.threadId = null;
  runtime.runtimes[ID_A].lastDispatch.turnId = null;
  await fs.writeFile(harness.runtimePath, `${JSON.stringify(runtime)}\n`);
  const restarted = createCodexScheduleService({
    definitionsPath: harness.definitionsPath,
    runtimePath: harness.runtimePath,
    parseCodexOptions,
    validateCwd: async () => {},
    startNormalCodexTurn: async () => { throw new Error("must not retry"); },
    now: harness.currentClock.now,
  });
  await restarted.start();
  const snapshot = await restarted.snapshot();
  assert.equal(snapshot.schedules[0].lastDispatch.status, "failed_uncertain_after_restart");
});

test("dispatch failures are clipped and definition data is not rewritten on fire", async (t) => {
  const harness = await makeHarness({
    startNormalCodexTurn: async () => {
      const error = new Error("x".repeat(2_000));
      error.code = "upstream_failed";
      throw error;
    },
  });
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  await harness.service.replaceSchedules({ baseRevision: 0, schedules: [definition({ rrule: null })] });
  const definitionsBefore = await fs.readFile(harness.definitionsPath, "utf8");
  harness.currentClock.set("2026-08-14T00:00:00.000Z");
  await harness.service.evaluate();
  const snapshot = await harness.service.snapshot();
  assert.equal(snapshot.schedules[0].lastDispatch.status, "failed");
  assert.equal(snapshot.schedules[0].lastDispatch.errorMessage.length, 1_000);
  assert.equal(await fs.readFile(harness.definitionsPath, "utf8"), definitionsBefore);
});

test("five simultaneous schedules keep at most four turn starts in flight", async (t) => {
  const releases = [];
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const harness = await makeHarness({
    startNormalCodexTurn: async () => {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return { threadId: `thread-${calls}`, turnId: `turn-${calls}` };
    },
  });
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  const schedules = Array.from({ length: 5 }, (_, index) => definition({
    id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    name: `schedule ${index}`,
    rrule: null,
  }));
  await harness.service.replaceSchedules({ baseRevision: 0, schedules });
  harness.currentClock.set("2026-08-14T00:00:00.000Z");
  const evaluation = harness.service.evaluate();
  while (calls < 4) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 4);
  assert.equal(calls, 4);
  releases.shift()();
  while (calls < 5) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 4);
  for (const release of releases.splice(0)) release();
  await evaluation;
});

test("queued due work does not create a zero-delay timer loop while four starts are active", async (t) => {
  const releases = [];
  let calls = 0;
  const callbacks = [];
  const harness = await makeHarness({
    startNormalCodexTurn: async () => {
      calls += 1;
      await new Promise((resolve) => releases.push(resolve));
      return { threadId: `thread-${calls}`, turnId: `turn-${calls}` };
    },
    scheduleTimer: (callback, delay) => {
      callbacks.push({ callback, delay, cleared: false, unref() {} });
      return callbacks.at(-1);
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  const schedules = Array.from({ length: 5 }, (_, index) => definition({
    id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    name: `schedule ${index}`,
    rrule: null,
  }));
  await harness.service.replaceSchedules({ baseRevision: 0, schedules });
  harness.currentClock.set("2026-08-14T00:00:00.000Z");
  const evaluation = harness.service.evaluate();
  await waitFor(() => calls === 4);
  const armedAfterQueue = callbacks.filter((timer) => !timer.cleared);
  assert.equal(armedAfterQueue.length, 0);
  assert.equal(callbacks.some((timer) => timer.delay === 0 && !timer.cleared), false);
  releases.shift()();
  await waitFor(() => calls === 5);
  for (const release of releases.splice(0)) release();
  await evaluation;
  assert.equal(callbacks.some((timer) => timer.delay === 0 && !timer.cleared), false);
});

test("single timer uses a sixty-second wall-clock guard and clears after deletion", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  await harness.service.replaceSchedules({ baseRevision: 0, schedules: [definition()] });
  assert.equal(harness.timers.at(-1).delay, 60_000);
  assert.equal(harness.service.timerArmed, true);
  const armed = harness.timers.at(-1);
  harness.currentClock.set("2026-08-14T00:01:00.000Z");
  armed.callback();
  await waitFor(async () => (await harness.service.snapshot()).schedules[0].lastDispatch?.status === "fired");
  await harness.service.replaceSchedules({ baseRevision: 1, schedules: [] });
  assert.equal(harness.service.timerArmed, false);
});

test("schema rejects invalid definitions and does not persist client runtime fields", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  await assert.rejects(harness.service.replaceSchedules({
    baseRevision: 0,
    schedules: [definition({ reasoningEffort: "never" })],
  }), /reasoningEffort/);
  await assert.rejects(harness.service.replaceSchedules({
    baseRevision: 0,
    schedules: [definition({ startLocal: " 2026-08-14T09:00:00" })],
  }), /startLocal/);
  await assert.rejects(harness.service.replaceSchedules({
    baseRevision: 0,
    schedules: [definition({ rrule: null, startLocal: "2026-08-12T09:00:00" })],
  }), /future/);
  const saved = await harness.service.replaceSchedules({
    baseRevision: 0,
    schedules: [definition({ nextOccurrenceAt: "1999-01-01", lastDispatch: { status: "fired" } })],
  });
  assert.equal(saved.schedules[0].nextOccurrenceAt, "2026-08-14T00:00:00.000Z");
  const stored = await readJson(harness.definitionsPath);
  assert.equal("nextOccurrenceAt" in stored.schedules[0], false);
  assert.equal("lastDispatch" in stored.schedules[0], false);
});

test("schema accepts max and ultra reasoning efforts supported by turn execution", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  for (const [index, reasoningEffort] of ["max", "ultra"].entries()) {
    const saved = await harness.service.replaceSchedules({
      baseRevision: index,
      schedules: [definition({ reasoningEffort })],
    });
    assert.equal(saved.schedules[0].reasoningEffort, reasoningEffort);
  }
});

test("oversized definition and runtime stores fail closed", async (t) => {
  for (const [file, bytes] of [
    ["definitions", CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES],
    ["runtime", CODEX_SCHEDULE_RUNTIME_MAX_BYTES],
  ]) {
    const harness = await makeHarness();
    t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
    if (file === "runtime") {
      await fs.writeFile(harness.definitionsPath, JSON.stringify({
        version: 1, revision: 0, schedules: [], updatedAt: harness.currentClock.now().toISOString(),
      }));
    }
    await fs.writeFile(
      file === "definitions" ? harness.definitionsPath : harness.runtimePath,
      Buffer.alloc(bytes + 1, 32),
    );
    await assert.rejects(harness.service.snapshot(), CodexScheduleStoreUnavailableError);
  }
});

test("ten thousand virtual fires keep one bounded runtime record", async () => {
  const files = new Map();
  const memoryFs = {
    async stat(filePath) {
      if (!files.has(filePath)) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return { size: Buffer.byteLength(files.get(filePath)) };
    },
    async readFile(filePath) { return files.get(filePath); },
    async mkdir() {},
    async writeFile(filePath, contents) { files.set(filePath, String(contents)); },
    async rename(source, target) {
      files.set(target, files.get(source));
      files.delete(source);
    },
    async unlink(filePath) { files.delete(filePath); },
  };
  const currentClock = clock("2025-12-31T00:00:00.000Z");
  const definitionsPath = "/memory/codex_schedules.json";
  const runtimePath = "/memory/codex_schedule_runtime.json";
  const service = createCodexScheduleService({
    definitionsPath,
    runtimePath,
    parseCodexOptions,
    validateCwd: async () => {},
    startNormalCodexTurn: async () => ({ threadId: "thread", turnId: "turn" }),
    now: currentClock.now,
    scheduleTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    fileSystem: memoryFs,
  });
  await service.replaceSchedules({
    baseRevision: 0,
    schedules: [definition({ startLocal: "2026-01-01T09:00:00", timeZone: "UTC" })],
  });
  const definitionsAfterSave = files.get(definitionsPath);
  for (let occurrence = 0; occurrence < 10_000; occurrence += 1) {
    const next = (await service.snapshot()).schedules[0].nextOccurrenceAt;
    currentClock.set(next);
    await service.evaluate();
  }
  const runtime = JSON.parse(files.get(runtimePath));
  assert.deepEqual(Object.keys(runtime.runtimes), [ID_A]);
  assert.equal(files.get(definitionsPath), definitionsAfterSave);
  assert.ok(Buffer.byteLength(files.get(runtimePath)) <= CODEX_SCHEDULE_RUNTIME_MAX_BYTES);
});
