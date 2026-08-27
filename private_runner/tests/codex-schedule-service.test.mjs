import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexScheduleHttpHandler } from "../src/codex-schedule-http.mjs";
import {
  CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES,
  CODEX_SCHEDULE_RUNTIME_MAX_BYTES,
  CodexScheduleIdempotencyConflictError,
  CodexScheduleNotFoundError,
  CodexScheduleRevisionConflictError,
  CodexScheduleStoreUnavailableError,
  codexScheduleDefinitionHash,
  createCodexScheduleService,
} from "../src/codex-schedule-service.mjs";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

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
    validateShellScript: options.validateShellScript || (async () => {}),
    startScheduledCodexTurn: options.startScheduledCodexTurn || (async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
    })),
    startShellScript: options.startShellScript || (async () => ({ jobId: "script-job-1" })),
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
  assert.equal(created.schedules[0].action.threadId, null);
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

test("item create, patch, and delete share revision and preserve idempotent retries", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  const input = { ...definition(), id: undefined };
  delete input.id;

  const created = await harness.service.createSchedule({ baseRevision: 0, schedule: input }, ID_A);
  assert.equal(created.created, true);
  assert.equal(created.revision, 1);
  assert.equal(created.schedule.id, ID_A);
  await harness.service.snapshot();
  const timerCountAfterCreate = harness.timers.length;

  const retried = await harness.service.createSchedule({ baseRevision: 0, schedule: input }, ID_A);
  assert.equal(retried.created, false);
  assert.equal(retried.revision, 1);
  await harness.service.snapshot();
  assert.equal(harness.timers.length, timerCountAfterCreate);
  await assert.rejects(
    harness.service.createSchedule({
      baseRevision: 1,
      schedule: { ...input, name: "Different" },
    }, ID_A),
    CodexScheduleIdempotencyConflictError,
  );

  const updated = await harness.service.patchSchedule(ID_A, {
    baseRevision: 1,
    patch: { prompt: "Updated action", threadId: "thread-existing" },
  });
  assert.equal(updated.updated, true);
  assert.equal(updated.revision, 2);
  assert.equal(updated.schedule.action.threadId, "thread-existing");
  assert.equal(updated.schedule.nextOccurrenceAt, created.schedule.nextOccurrenceAt);
  await harness.service.snapshot();
  const timerCountAfterPatch = harness.timers.length;

  const noOp = await harness.service.patchSchedule(ID_A, {
    baseRevision: 0,
    patch: { prompt: "Updated action" },
  });
  assert.equal(noOp.updated, false);
  assert.equal(noOp.revision, 2);
  await harness.service.snapshot();
  assert.equal(harness.timers.length, timerCountAfterPatch);
  await assert.rejects(
    harness.service.patchSchedule(ID_A, { baseRevision: 0, patch: { enabled: false } }),
    CodexScheduleRevisionConflictError,
  );

  const deleted = await harness.service.deleteSchedule(ID_A, { baseRevision: 2 });
  assert.deepEqual(deleted, { deleted: true, id: ID_A, revision: 3 });
  assert.deepEqual(await harness.service.snapshot(), { revision: 3, schedules: [] });
  await assert.rejects(
    harness.service.deleteSchedule(ID_A, { baseRevision: 3 }),
    CodexScheduleNotFoundError,
  );
  await assert.rejects(
    harness.service.createSchedule({ baseRevision: 0, schedule: input }, ID_A),
    CodexScheduleRevisionConflictError,
  );
});

test("item mutations are strict and competing revisions serialize", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  const withoutId = ({ id: _id, ...schedule }) => schedule;
  await assert.rejects(
    harness.service.createSchedule({
      baseRevision: 0,
      schedule: { ...withoutId(definition()), unknown: true },
    }, ID_A),
    /not supported/,
  );
  await harness.service.createSchedule({ baseRevision: 0, schedule: withoutId(definition()) }, ID_A);
  await assert.rejects(
    harness.service.patchSchedule(ID_A, { baseRevision: 1, patch: {} }),
    /must not be empty/,
  );
  await assert.rejects(
    harness.service.patchSchedule(ID_A, { baseRevision: 1, patch: { id: ID_B } }),
    /not supported/,
  );
  await assert.rejects(
    harness.service.patchSchedule(ID_A, { baseRevision: 1, patch: { threadId: "invalid thread" } }),
    /threadId is invalid/,
  );

  const patch = harness.service.patchSchedule(ID_A, {
    baseRevision: 1,
    patch: { name: "Winner" },
  });
  const create = harness.service.createSchedule({
    baseRevision: 1,
    schedule: withoutId(definition({ name: "Second" })),
  }, ID_B);
  assert.equal((await patch).revision, 2);
  await assert.rejects(create, CodexScheduleRevisionConflictError);
});

test("oversized normalized candidates stay validation failures without latching the store", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  await harness.service.snapshot();
  const schedules = Array.from({ length: 100 }, (_, index) => definition({
    id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    name: `schedule ${index}`,
    prompt: "\u0000".repeat(24_000),
  }));
  await assert.rejects(
    harness.service.replaceSchedules({ baseRevision: 0, schedules }),
    (error) => !(error instanceof CodexScheduleStoreUnavailableError) && /size limit/.test(error.message),
  );
  assert.deepEqual(await harness.service.snapshot(), { revision: 0, schedules: [] });
  const saved = await harness.service.replaceSchedules({ baseRevision: 0, schedules: [definition()] });
  assert.equal(saved.revision, 1);
});

test("oversized POST and PATCH candidates leave files and service healthy", async (t) => {
  const largeSchedules = Array.from({ length: 99 }, (_, index) => definition({
    id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    name: `schedule ${index}`,
    prompt: "\u0000".repeat(14_000),
  }));

  const post = await makeHarness();
  t.after(() => fs.rm(post.directory, { recursive: true, force: true }));
  await post.service.replaceSchedules({ baseRevision: 0, schedules: largeSchedules });
  const postDefinitions = await fs.readFile(post.definitionsPath, "utf8");
  const postRuntime = await fs.readFile(post.runtimePath, "utf8");
  const largeCreate = { ...definition({ prompt: "\u0000".repeat(14_000) }) };
  delete largeCreate.id;
  await assert.rejects(
    post.service.createSchedule({ baseRevision: 1, schedule: largeCreate }, ID_A),
    (error) => !(error instanceof CodexScheduleStoreUnavailableError) && /size limit/.test(error.message),
  );
  assert.equal(await fs.readFile(post.definitionsPath, "utf8"), postDefinitions);
  assert.equal(await fs.readFile(post.runtimePath, "utf8"), postRuntime);
  assert.equal((await post.service.snapshot()).revision, 1);
  assert.equal((await post.service.patchSchedule(largeSchedules[0].id, {
    baseRevision: 1,
    patch: { name: "small edit" },
  })).revision, 2);

  const patch = await makeHarness();
  t.after(() => fs.rm(patch.directory, { recursive: true, force: true }));
  await patch.service.replaceSchedules({ baseRevision: 0, schedules: largeSchedules });
  await assert.rejects(
    patch.service.patchSchedule(largeSchedules[0].id, {
      baseRevision: 1,
      patch: { prompt: "\u0000".repeat(24_000) },
    }),
    (error) => !(error instanceof CodexScheduleStoreUnavailableError) && /size limit/.test(error.message),
  );
  assert.equal((await patch.service.snapshot()).revision, 1);
  const smallCreate = { ...definition({ name: "small create" }) };
  delete smallCreate.id;
  assert.equal((await patch.service.createSchedule({
    baseRevision: 1,
    schedule: smallCreate,
  }, ID_A)).revision, 2);
});

test("actual definition-store I/O failure still latches service unavailable", async (t) => {
  let failRename = false;
  const fileSystem = {
    ...fs,
    rename: async (source, target) => {
      if (failRename && target.endsWith("codex_schedules.json")) {
        const error = new Error("simulated rename failure");
        error.code = "EIO";
        throw error;
      }
      await fs.rename(source, target);
    },
  };
  const harness = await makeHarness({ fileSystem });
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  await harness.service.snapshot();
  failRename = true;
  await assert.rejects(
    harness.service.replaceSchedules({ baseRevision: 0, schedules: [definition()] }),
    CodexScheduleStoreUnavailableError,
  );
  await assert.rejects(harness.service.snapshot(), CodexScheduleStoreUnavailableError);
});

test("real HTTP handler maps oversized PUT, POST, and PATCH to 400 without poisoning GET", async (t) => {
  async function request(service, { method, pathname = "/codex-schedules", body, headers = {} }) {
    const responses = [];
    const handler = createCodexScheduleHttpHandler({
      service,
      runnerToken: "secret",
      parseAuthToken: (req) => req.auth,
      readJsonBody: async (req) => req.body,
      json: (_res, status, payload) => responses.push({ status, payload }),
    });
    await handler({ method, auth: "secret", body, headers }, {}, pathname);
    return responses[0];
  }

  const largeSchedules = Array.from({ length: 99 }, (_, index) => definition({
    id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    name: `schedule ${index}`,
    prompt: "\u0000".repeat(14_000),
  }));
  const cases = [];

  const put = await makeHarness();
  t.after(() => fs.rm(put.directory, { recursive: true, force: true }));
  cases.push({
    harness: put,
    request: {
      method: "PUT",
      body: {
        baseRevision: 0,
        schedules: Array.from({ length: 100 }, (_, index) => definition({
          id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
          name: `schedule ${index}`,
          prompt: "\u0000".repeat(24_000),
        })),
      },
    },
    revision: 0,
  });

  const post = await makeHarness();
  t.after(() => fs.rm(post.directory, { recursive: true, force: true }));
  await post.service.replaceSchedules({ baseRevision: 0, schedules: largeSchedules });
  const largeCreate = { ...definition({ prompt: "\u0000".repeat(14_000) }) };
  delete largeCreate.id;
  cases.push({
    harness: post,
    request: {
      method: "POST",
      headers: { "idempotency-key": ID_A },
      body: { baseRevision: 1, schedule: largeCreate },
    },
    revision: 1,
  });

  const patch = await makeHarness();
  t.after(() => fs.rm(patch.directory, { recursive: true, force: true }));
  await patch.service.replaceSchedules({ baseRevision: 0, schedules: largeSchedules });
  cases.push({
    harness: patch,
    request: {
      method: "PATCH",
      pathname: `/codex-schedules/${largeSchedules[0].id}`,
      body: { baseRevision: 1, patch: { prompt: "\u0000".repeat(24_000) } },
    },
    revision: 1,
  });

  for (const item of cases) {
    const mutation = await request(item.harness.service, item.request);
    assert.equal(mutation.status, 400);
    assert.equal(mutation.payload.error, "invalid_codex_schedules");
    const get = await request(item.harness.service, { method: "GET" });
    assert.equal(get.status, 200);
    assert.equal(get.payload.revision, item.revision);
  }
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
  assert.equal(snapshot.schedules[0].action.threadId, null);
  assert.equal(snapshot.schedules[0].nextOccurrenceAt, "2026-08-14T00:00:00.000Z");
  assert.deepEqual(snapshot.schedules[0].lastDispatch.result, {
    kind: "llm", threadId: "thread-old", turnId: "turn-old",
  });
  const runtime = await readJson(harness.runtimePath);
  const definitions = await readJson(harness.definitionsPath);
  assert.equal(definitions.version, 2);
  assert.equal(definitions.schedules[0].action.kind, "llm");
  assert.equal(runtime.version, 2);
  assert.deepEqual(Object.keys(runtime.runtimes), [ID_A]);
  assert.equal(runtime.definitionsRevision, 2);
});

test("version 1 migration preserves a failed dispatch with only a thread ID", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  const schedule = definition();
  const definitionHash = codexScheduleDefinitionHash(schedule);
  await fs.writeFile(harness.definitionsPath, `${JSON.stringify({
    version: 1,
    revision: 1,
    schedules: [schedule],
    updatedAt: "2026-08-12T00:00:00.000Z",
  })}\n`);
  await fs.writeFile(harness.runtimePath, `${JSON.stringify({
    version: 1,
    definitionsRevision: 1,
    runtimes: {
      [ID_A]: {
        definitionHash,
        nextOccurrenceAt: "2026-08-14T00:00:00.000Z",
        lastDispatch: {
          occurrenceAt: "2026-08-12T00:00:00.000Z",
          claimedAt: "2026-08-12T00:00:00.000Z",
          definitionHash,
          status: "failed",
          threadId: "thread-partial",
          turnId: null,
          errorCode: "upstream_failed",
          errorMessage: "turn start failed",
          updatedAt: "2026-08-12T00:00:00.000Z",
        },
      },
    },
    updatedAt: "2026-08-12T00:00:00.000Z",
  })}\n`);

  const dispatch = (await harness.service.snapshot()).schedules[0].lastDispatch;
  assert.deepEqual(dispatch.result, {
    kind: "llm", threadId: "thread-partial", turnId: null,
  });
  const storedRuntime = await readJson(harness.runtimePath);
  assert.equal(storedRuntime.version, 2);
  assert.deepEqual(storedRuntime.runtimes[ID_A].lastDispatch.result, dispatch.result);
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
    startScheduledCodexTurn: async () => ({ threadId: "thread", turnId: "turn" }),
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
    startScheduledCodexTurn: async (request) => {
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
  assert.equal(
    starts[0].clientOperationId,
    `codex_schedule:${ID_A}:2026-08-14T00:00:00.000Z`,
  );
  assert.equal(starts[0].threadId, "");

  const recurringStarts = [];
  const recurring = await makeHarness({
    clock: clock("2026-08-12T00:00:00.000Z"),
    startScheduledCodexTurn: async (request) => {
      recurringStarts.push(request);
      return { threadId: "thread-recurring", turnId: "turn-recurring" };
    },
  });
  t.after(() => fs.rm(recurring.directory, { recursive: true, force: true }));
  await recurring.service.replaceSchedules({
    baseRevision: 0,
    schedules: [definition({ threadId: "thread-existing" })],
  });
  recurring.currentClock.set("2026-08-17T12:00:00.000Z");
  await recurring.service.start();
  snapshot = await recurring.service.snapshot();
  assert.equal(recurringStarts.length, 1);
  assert.equal(recurringStarts[0].threadId, "thread-existing");
  assert.equal(
    recurringStarts[0].clientOperationId,
    `codex_schedule:${ID_A}:2026-08-17T00:00:00.000Z`,
  );
  assert.equal(snapshot.schedules[0].lastDispatch.occurrenceAt, "2026-08-17T00:00:00.000Z");
  assert.equal(snapshot.schedules[0].nextOccurrenceAt, "2026-08-18T00:00:00.000Z");
});

test("script actions validate and start the selected .sh inside their cwd without requiring Codex IDs", async (t) => {
  const validations = [];
  const starts = [];
  let codexStarts = 0;
  const harness = await makeHarness({
    validateShellScript: async (...args) => { validations.push(args); },
    startShellScript: async (...args) => {
      starts.push(args);
      return { jobId: "script-job-42" };
    },
    startScheduledCodexTurn: async () => {
      codexStarts += 1;
      return { threadId: "unexpected", turnId: "unexpected" };
    },
  });
  t.after(() => fs.rm(harness.directory, { recursive: true, force: true }));
  const scriptPath = path.join(harness.directory, "scheduled.sh");
  const schedule = {
    ...definition({ rrule: null }),
    action: { kind: "script", cwd: harness.directory, scriptPath },
  };
  for (const key of ["cwd", "modelRef", "reasoningEffort", "prompt", "threadId"]) delete schedule[key];
  await harness.service.replaceSchedules({ baseRevision: 0, schedules: [schedule] });
  harness.currentClock.set("2026-08-14T00:00:00.000Z");
  await harness.service.evaluate();
  const snapshot = await harness.service.snapshot();
  assert.equal(codexStarts, 0);
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0], [scriptPath, { allowExternal: true, allowedRoot: harness.directory }]);
  assert.equal(validations.length, 2);
  assert.deepEqual(snapshot.schedules[0].lastDispatch.result, {
    kind: "script", jobId: "script-job-42",
  });
});

test("new-chat definitions retain their legacy hash while thread targets affect identity", () => {
  const legacy = definition();
  assert.equal(codexScheduleDefinitionHash(legacy), codexScheduleDefinitionHash({ ...legacy, threadId: null }));
  assert.notEqual(
    codexScheduleDefinitionHash(legacy),
    codexScheduleDefinitionHash({ ...legacy, threadId: "thread-existing" }),
  );
});

test("overlapping evaluation dispatches once and restart never retries a persisted claim", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const harness = await makeHarness({
    startScheduledCodexTurn: async () => {
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
  runtime.runtimes[ID_A].lastDispatch.result = null;
  await fs.writeFile(harness.runtimePath, `${JSON.stringify(runtime)}\n`);
  const restarted = createCodexScheduleService({
    definitionsPath: harness.definitionsPath,
    runtimePath: harness.runtimePath,
    parseCodexOptions,
    validateCwd: async () => {},
    startScheduledCodexTurn: async () => { throw new Error("must not retry"); },
    now: harness.currentClock.now,
  });
  await restarted.start();
  const snapshot = await restarted.snapshot();
  assert.equal(snapshot.schedules[0].lastDispatch.status, "failed_uncertain_after_restart");
});

test("dispatch failures are clipped and definition data is not rewritten on fire", async (t) => {
  const harness = await makeHarness({
    startScheduledCodexTurn: async () => {
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
    startScheduledCodexTurn: async () => {
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
    startScheduledCodexTurn: async () => {
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
    assert.equal(saved.schedules[0].action.reasoningEffort, reasoningEffort);
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
    startScheduledCodexTurn: async () => ({ threadId: "thread", turnId: "turn" }),
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
