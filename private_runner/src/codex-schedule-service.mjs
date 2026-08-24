import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

import {
  codexScheduleOccurrenceAfter,
  codexScheduleOccurrenceAtOrBefore,
  normalizeCodexScheduleRrule,
  parseCodexScheduleStartLocal,
  validateCodexScheduleTimeZone,
} from "./codex-schedule-recurrence.mjs";

export const CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES = 8 * 1024 * 1024;
export const CODEX_SCHEDULE_RUNTIME_MAX_BYTES = 512 * 1024;
export const CODEX_SCHEDULE_MAX_COUNT = 100;

const MAX_PROMPT_CHARS = 24_000;
const MAX_THREAD_ID_CHARS = 120;
const MAX_ERROR_CHARS = 1_000;
const MAX_TIMER_DELAY_MS = 60_000;
const MAX_START_CONCURRENCY = 4;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const DISPATCH_STATUSES = new Set([
  "claimed",
  "fired",
  "failed",
  "failed_uncertain_after_restart",
]);
const DEFINITION_KEYS = new Set([
  "id", "name", "enabled", "startLocal", "timeZone", "rrule",
  "cwd", "modelRef", "reasoningEffort", "prompt", "threadId",
]);
const CREATE_DEFINITION_KEYS = new Set([
  "name", "enabled", "startLocal", "timeZone", "rrule",
  "cwd", "modelRef", "reasoningEffort", "prompt", "threadId",
]);

export const CODEX_SCHEDULE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CodexScheduleStoreUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodexScheduleStoreUnavailableError";
    this.code = "CODEX_SCHEDULE_STORE_UNAVAILABLE";
  }
}

export class CodexScheduleRevisionConflictError extends Error {
  constructor(revision) {
    super("Codex schedule revision conflict");
    this.name = "CodexScheduleRevisionConflictError";
    this.code = "CODEX_SCHEDULE_REVISION_CONFLICT";
    this.revision = revision;
  }
}

export class CodexScheduleNotFoundError extends Error {
  constructor() {
    super("Codex schedule was not found");
    this.name = "CodexScheduleNotFoundError";
    this.code = "CODEX_SCHEDULE_NOT_FOUND";
  }
}

export class CodexScheduleIdempotencyConflictError extends Error {
  constructor(id, revision) {
    super("Idempotency key is already used by a different Codex schedule");
    this.name = "CodexScheduleIdempotencyConflictError";
    this.code = "CODEX_SCHEDULE_IDEMPOTENCY_CONFLICT";
    this.id = id;
    this.revision = revision;
  }
}

function errorMessage(error) {
  return String(error instanceof Error ? error.message : error || "unknown error");
}

function iso(date) {
  return new Date(date).toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function onlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function codexScheduleDefinitionHash(definition) {
  const canonical = {
    id: definition.id,
    enabled: definition.enabled,
    startLocal: definition.startLocal,
    timeZone: definition.timeZone,
    rrule: definition.rrule,
    cwd: definition.cwd,
    modelRef: definition.modelRef,
    reasoningEffort: definition.reasoningEffort,
    prompt: definition.prompt,
  };
  const threadId = String(definition.threadId || "").trim();
  // Keep the legacy new-thread hash stable so existing version 1 runtime stores remain readable.
  if (threadId) canonical.threadId = threadId;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function normalizeDefinition(raw, index, parseCodexOptions, strictStoredFields = false) {
  const value = requireObject(raw, `schedules[${index}]`);
  if (strictStoredFields) onlyKeys(value, DEFINITION_KEYS, `schedules[${index}]`);
  const id = requireString(value.id, `schedules[${index}].id`).trim();
  if (!CODEX_SCHEDULE_UUID_PATTERN.test(id)) {
    throw new Error(`schedules[${index}].id is invalid`);
  }
  const name = requireString(value.name, `schedules[${index}].name`).trim();
  if (!name || name.length > 100) throw new Error(`schedules[${index}].name is invalid`);
  if (typeof value.enabled !== "boolean") throw new Error(`schedules[${index}].enabled is invalid`);
  const startLocal = parseCodexScheduleStartLocal(
    requireString(value.startLocal, `schedules[${index}].startLocal`),
  ).value;
  const timeZone = validateCodexScheduleTimeZone(
    requireString(value.timeZone, `schedules[${index}].timeZone`),
  );
  const rrule = normalizeCodexScheduleRrule(value.rrule);
  const cwd = requireString(value.cwd, `schedules[${index}].cwd`).trim();
  if (!cwd || cwd.length > 2048) throw new Error(`schedules[${index}].cwd is invalid`);
  const prompt = requireString(value.prompt, `schedules[${index}].prompt`).trim();
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) throw new Error(`schedules[${index}].prompt is invalid`);
  const threadId = value.threadId === null || value.threadId === undefined
    ? null
    : requireString(value.threadId, `schedules[${index}].threadId`).trim();
  if (threadId !== null && (
    !threadId || threadId.length > MAX_THREAD_ID_CHARS || !/^[A-Za-z0-9._:-]+$/.test(threadId)
  )) {
    throw new Error(`schedules[${index}].threadId is invalid`);
  }
  const modelRef = requireString(value.modelRef, `schedules[${index}].modelRef`).trim();
  if (!modelRef) throw new Error(`schedules[${index}].modelRef is invalid`);
  const reasoningEffort = requireString(
    value.reasoningEffort,
    `schedules[${index}].reasoningEffort`,
  ).trim().toLowerCase();
  if (!EFFORTS.has(reasoningEffort)) throw new Error(`schedules[${index}].reasoningEffort is invalid`);
  let options;
  try {
    options = parseCodexOptions(modelRef, reasoningEffort);
  } catch (error) {
    throw new Error(`schedules[${index}] Codex options are invalid: ${errorMessage(error)}`);
  }
  if (String(options?.reasoningEffort || "") !== reasoningEffort) {
    throw new Error(`schedules[${index}].reasoningEffort was not preserved`);
  }
  const normalizedModelRef = String(options?.modelInfo?.modelRef || "").trim();
  if (!normalizedModelRef) throw new Error(`schedules[${index}].modelRef is invalid`);
  if (strictStoredFields && normalizedModelRef !== modelRef) {
    throw new Error(`schedules[${index}].modelRef is not normalized`);
  }
  return {
    id,
    name,
    enabled: value.enabled,
    startLocal,
    timeZone,
    rrule,
    cwd,
    modelRef: normalizedModelRef,
    reasoningEffort,
    prompt,
    threadId,
  };
}

async function normalizeDefinitions(raw, { parseCodexOptions, validateCwd, strictStoredFields = false }) {
  if (!Array.isArray(raw)) throw new Error("schedules must be an array");
  if (raw.length > CODEX_SCHEDULE_MAX_COUNT) throw new Error("schedules must contain at most 100 entries");
  const ids = new Set();
  const schedules = raw.map((value, index) => normalizeDefinition(
    value, index, parseCodexOptions, strictStoredFields,
  ));
  for (const schedule of schedules) {
    if (ids.has(schedule.id)) throw new Error(`duplicate schedule id: ${schedule.id}`);
    ids.add(schedule.id);
    if (validateCwd) await validateCwd(schedule.cwd);
  }
  return schedules;
}

function triggerChanged(left, right) {
  return !left || left.enabled !== right.enabled || left.startLocal !== right.startLocal ||
    left.timeZone !== right.timeZone || left.rrule !== right.rrule;
}

function validateLastDispatch(raw, label) {
  if (raw === null) return null;
  const value = requireObject(raw, label);
  onlyKeys(value, new Set([
    "occurrenceAt", "claimedAt", "definitionHash", "status", "threadId", "turnId",
    "errorCode", "errorMessage", "updatedAt",
  ]), label);
  if (!validIso(value.occurrenceAt) || !validIso(value.claimedAt) || !validIso(value.updatedAt)) {
    throw new Error(`${label} timestamps are invalid`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.definitionHash || ""))) {
    throw new Error(`${label}.definitionHash is invalid`);
  }
  if (!DISPATCH_STATUSES.has(value.status)) throw new Error(`${label}.status is invalid`);
  if (value.threadId !== null && (typeof value.threadId !== "string" || !value.threadId.trim())) {
    throw new Error(`${label}.threadId is invalid`);
  }
  if (value.turnId !== null && (typeof value.turnId !== "string" || !value.turnId.trim())) {
    throw new Error(`${label}.turnId is invalid`);
  }
  if (value.status === "fired" && (!value.threadId || !value.turnId)) {
    throw new Error(`${label} fired IDs are required`);
  }
  if (value.status === "claimed" && (value.threadId !== null || value.turnId !== null)) {
    throw new Error(`${label} claimed IDs must be null`);
  }
  if (typeof value.errorCode !== "string" || value.errorCode.length > 200) throw new Error(`${label}.errorCode is invalid`);
  if (typeof value.errorMessage !== "string" || value.errorMessage.length > MAX_ERROR_CHARS) {
    throw new Error(`${label}.errorMessage is invalid`);
  }
  return clone(value);
}

function validateRuntime(raw, definitions, allowDefinitionMismatch = false) {
  const root = requireObject(raw, "runtime store");
  onlyKeys(root, new Set(["version", "definitionsRevision", "runtimes", "updatedAt"]), "runtime store");
  if (root.version !== 1 || !Number.isInteger(root.definitionsRevision) || root.definitionsRevision < 0) {
    throw new Error("runtime store header is invalid");
  }
  if (!validIso(root.updatedAt)) throw new Error("runtime store updatedAt is invalid");
  const runtimes = requireObject(root.runtimes, "runtime store.runtimes");
  const definitionIds = new Set(definitions.map((definition) => definition.id));
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  const runtimeIds = Object.keys(runtimes);
  if (!allowDefinitionMismatch && (
    runtimeIds.length !== definitionIds.size || runtimeIds.some((id) => !definitionIds.has(id))
  )) {
    throw new Error("runtime schedules do not match definitions");
  }
  for (const id of runtimeIds) {
    const label = `runtimes.${id}`;
    const value = requireObject(runtimes[id], label);
    onlyKeys(value, new Set(["definitionHash", "nextOccurrenceAt", "lastDispatch"]), label);
    if (!/^[a-f0-9]{64}$/.test(String(value.definitionHash || ""))) throw new Error(`${label}.definitionHash is invalid`);
    if (!allowDefinitionMismatch &&
      value.definitionHash !== codexScheduleDefinitionHash(definitionsById.get(id))) {
      throw new Error(`${label}.definitionHash does not match its definition`);
    }
    if (value.nextOccurrenceAt !== null && !validIso(value.nextOccurrenceAt)) {
      throw new Error(`${label}.nextOccurrenceAt is invalid`);
    }
    value.lastDispatch = validateLastDispatch(value.lastDispatch, `${label}.lastDispatch`);
  }
  return clone(root);
}

function buildSnapshot(definitions, runtimeStore) {
  return {
    revision: runtimeStore.definitionsRevision,
    schedules: definitions.map((definition) => ({
      ...clone(definition),
      nextOccurrenceAt: runtimeStore.runtimes[definition.id]?.nextOccurrenceAt ?? null,
      lastDispatch: clone(runtimeStore.runtimes[definition.id]?.lastDispatch ?? null),
    })),
  };
}

export function createCodexScheduleService({
  definitionsPath,
  runtimePath,
  parseCodexOptions,
  validateCwd,
  startNormalCodexTurn,
  now = () => new Date(),
  scheduleTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
  fileSystem = fs,
}) {
  let loaded = false;
  let unavailable = null;
  let definitionsStore = null;
  let runtimeStore = null;
  let mutationQueue = Promise.resolve();
  let timer = null;
  const queuedIds = [];
  const queuedIdSet = new Set();
  let activeStarts = 0;
  const idleWaiters = new Set();

  function storeError(context, error) {
    const failure = error instanceof CodexScheduleStoreUnavailableError
      ? error
      : new CodexScheduleStoreUnavailableError(`${context}: ${errorMessage(error)}`);
    unavailable = failure;
    return failure;
  }

  async function readStore(filePath, maxBytes) {
    const stat = await fileSystem.stat(filePath);
    if (stat.size > maxBytes) throw new Error(`${path.basename(filePath)} exceeds its size limit`);
    return JSON.parse(await fileSystem.readFile(filePath, "utf8"));
  }

  function encoded(value, maxBytes, label) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`${label} exceeds its size limit`);
    return text;
  }

  async function writeTemporary(filePath, text) {
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await fileSystem.writeFile(temporaryPath, text, "utf8");
    return temporaryPath;
  }

  async function persistRuntime(nextRuntime = runtimeStore) {
    nextRuntime.updatedAt = iso(now());
    let temporaryPath;
    try {
      temporaryPath = await writeTemporary(
        runtimePath,
        encoded(nextRuntime, CODEX_SCHEDULE_RUNTIME_MAX_BYTES, "runtime store"),
      );
      await fileSystem.rename(temporaryPath, runtimePath);
      temporaryPath = null;
    } catch (error) {
      if (temporaryPath) await fileSystem.unlink(temporaryPath).catch(() => {});
      throw storeError("failed to persist Codex schedule runtime", error);
    }
  }

  async function persistBoth(definitionsText, runtimeText) {
    let definitionsTemporaryPath;
    let runtimeTemporaryPath;
    try {
      definitionsTemporaryPath = await writeTemporary(definitionsPath, definitionsText);
      runtimeTemporaryPath = await writeTemporary(runtimePath, runtimeText);
      await fileSystem.rename(definitionsTemporaryPath, definitionsPath);
      definitionsTemporaryPath = null;
      await fileSystem.rename(runtimeTemporaryPath, runtimePath);
      runtimeTemporaryPath = null;
    } catch (error) {
      for (const temporaryPath of [definitionsTemporaryPath, runtimeTemporaryPath]) {
        if (temporaryPath) await fileSystem.unlink(temporaryPath).catch(() => {});
      }
      throw storeError("failed to persist Codex schedules", error);
    }
  }

  function rebuildRuntime(definitions, revision, at, previous = null) {
    const runtimes = {};
    for (const definition of definitions) {
      const definitionHash = codexScheduleDefinitionHash(definition);
      const previousRuntime = previous?.runtimes?.[definition.id];
      const preservedDispatch = previousRuntime?.definitionHash === definitionHash &&
        previousRuntime?.lastDispatch?.definitionHash === definitionHash
        ? clone(previousRuntime.lastDispatch)
        : null;
      runtimes[definition.id] = {
        definitionHash,
        nextOccurrenceAt: definition.enabled
          ? codexScheduleOccurrenceAfter(definition, at, false)
          : null,
        lastDispatch: preservedDispatch,
      };
    }
    return { version: 1, definitionsRevision: revision, runtimes, updatedAt: iso(at) };
  }

  async function load() {
    if (unavailable) throw unavailable;
    if (loaded) return;
    let definitionsRaw;
    let runtimeRaw;
    let definitionsMissing = false;
    let runtimeMissing = false;
    try {
      try {
        definitionsRaw = await readStore(definitionsPath, CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES);
      } catch (error) {
        if (error?.code === "ENOENT") definitionsMissing = true;
        else throw error;
      }
      try {
        runtimeRaw = await readStore(runtimePath, CODEX_SCHEDULE_RUNTIME_MAX_BYTES);
      } catch (error) {
        if (error?.code === "ENOENT") runtimeMissing = true;
        else throw error;
      }
      if (definitionsMissing && !runtimeMissing) throw new Error("definitions store is missing while runtime exists");
      if (definitionsMissing && runtimeMissing) {
        const at = now();
        definitionsStore = { version: 1, revision: 0, schedules: [], updatedAt: iso(at) };
        runtimeStore = { version: 1, definitionsRevision: 0, runtimes: {}, updatedAt: iso(at) };
        const definitionsText = encoded(
          definitionsStore,
          CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES,
          "definitions store",
        );
        const runtimeText = encoded(runtimeStore, CODEX_SCHEDULE_RUNTIME_MAX_BYTES, "runtime store");
        await persistBoth(definitionsText, runtimeText);
        loaded = true;
        return;
      }

      const root = requireObject(definitionsRaw, "definitions store");
      onlyKeys(root, new Set(["version", "revision", "schedules", "updatedAt"]), "definitions store");
      if (root.version !== 1 || !Number.isInteger(root.revision) || root.revision < 0 || !validIso(root.updatedAt)) {
        throw new Error("definitions store header is invalid");
      }
      const schedules = await normalizeDefinitions(root.schedules, {
        parseCodexOptions,
        strictStoredFields: true,
      });
      definitionsStore = { ...clone(root), schedules };
      if (runtimeMissing) {
        runtimeStore = rebuildRuntime(schedules, root.revision, now());
        await persistRuntime(runtimeStore);
      } else {
        const parsedRuntime = validateRuntime(
          runtimeRaw,
          schedules,
          runtimeRaw?.definitionsRevision !== root.revision,
        );
        if (parsedRuntime.definitionsRevision !== root.revision) {
          runtimeStore = rebuildRuntime(schedules, root.revision, now(), parsedRuntime);
          await persistRuntime(runtimeStore);
        } else {
          runtimeStore = parsedRuntime;
        }
      }
      loaded = true;
    } catch (error) {
      throw storeError("failed to load Codex schedules", error);
    }
  }

  function serialize(operation) {
    const result = mutationQueue.then(async () => {
      await load();
      if (unavailable) throw unavailable;
      return operation();
    });
    mutationQueue = result.catch(() => {});
    return result;
  }

  function notifyIdle() {
    if (queuedIds.length > 0 || activeStarts > 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function whenIdle() {
    if (queuedIds.length === 0 && activeStarts === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  function clearArmedTimer() {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  }

  function armTimer() {
    clearArmedTimer();
    if (!loaded || unavailable) return;
    let earliest = Infinity;
    const nowMs = now().getTime();
    for (const definition of definitionsStore.schedules) {
      if (!definition.enabled) continue;
      const nextMs = Date.parse(runtimeStore.runtimes[definition.id]?.nextOccurrenceAt || "");
      if (queuedIdSet.has(definition.id) && nextMs <= nowMs) continue;
      if (Number.isFinite(nextMs)) earliest = Math.min(earliest, nextMs);
    }
    if (!Number.isFinite(earliest)) return;
    const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, earliest - nowMs));
    timer = scheduleTimer(() => {
      timer = null;
      void evaluate().catch(() => {});
    }, delay);
    timer?.unref?.();
  }

  async function claimSchedule(id) {
    return serialize(async () => {
      const definition = definitionsStore.schedules.find((item) => item.id === id);
      const runtime = runtimeStore.runtimes[id];
      const at = now();
      if (!definition?.enabled || !runtime?.nextOccurrenceAt) return null;
      if (Date.parse(runtime.nextOccurrenceAt) > at.getTime()) return null;
      const occurrenceAt = definition.rrule
        ? codexScheduleOccurrenceAtOrBefore(definition, at)
        : runtime.nextOccurrenceAt;
      if (!occurrenceAt || Date.parse(occurrenceAt) < Date.parse(runtime.nextOccurrenceAt)) return null;
      const definitionHash = codexScheduleDefinitionHash(definition);
      runtime.definitionHash = definitionHash;
      runtime.nextOccurrenceAt = definition.rrule
        ? codexScheduleOccurrenceAfter(definition, at, false)
        : null;
      runtime.lastDispatch = {
        occurrenceAt,
        claimedAt: iso(at),
        definitionHash,
        status: "claimed",
        threadId: null,
        turnId: null,
        errorCode: "",
        errorMessage: "",
        updatedAt: iso(at),
      };
      await persistRuntime();
      return { definition: clone(definition), occurrenceAt, definitionHash };
    });
  }

  async function finishDispatch(claim, result, failure) {
    await serialize(async () => {
      const runtime = runtimeStore.runtimes[claim.definition.id];
      const dispatch = runtime?.lastDispatch;
      if (!dispatch || dispatch.occurrenceAt !== claim.occurrenceAt ||
        dispatch.definitionHash !== claim.definitionHash || dispatch.status !== "claimed") return;
      if (failure) {
        dispatch.status = "failed";
        dispatch.errorCode = String(failure.code || "codex_schedule_dispatch_failed").slice(0, 200);
        dispatch.errorMessage = errorMessage(failure).slice(0, MAX_ERROR_CHARS);
        dispatch.threadId = failure.threadId ? String(failure.threadId) : null;
        dispatch.turnId = failure.turnId ? String(failure.turnId) : null;
      } else {
        const threadId = String(result?.threadId || "").trim();
        const turnId = String(result?.turnId || "").trim();
        if (!threadId || !turnId) {
          dispatch.status = "failed";
          dispatch.errorCode = "codex_start_ids_missing";
          dispatch.errorMessage = "Codex turn start did not return thread and turn IDs";
        } else {
          dispatch.status = "fired";
          dispatch.threadId = threadId;
          dispatch.turnId = turnId;
          dispatch.errorCode = "";
          dispatch.errorMessage = "";
        }
      }
      dispatch.updatedAt = iso(now());
      await persistRuntime();
    });
  }

  async function runQueued(id) {
    let claim = null;
    let result = null;
    let failure = null;
    try {
      claim = await claimSchedule(id);
      if (!claim) return;
      try {
        await validateCwd(claim.definition.cwd);
      } catch (error) {
        const failure = new Error(errorMessage(error));
        failure.code = "cwd_unavailable";
        throw failure;
      }
      let options;
      try {
        options = parseCodexOptions(claim.definition.modelRef, claim.definition.reasoningEffort);
      } catch (error) {
        const failure = new Error(errorMessage(error));
        failure.code = "codex_options_invalid";
        throw failure;
      }
      if (String(options?.reasoningEffort || "") !== claim.definition.reasoningEffort) {
        const error = new Error("reasoning effort is no longer available");
        error.code = "codex_options_invalid";
        throw error;
      }
      result = await startNormalCodexTurn({
        inputText: claim.definition.prompt,
        cwd: claim.definition.cwd,
        model: options.modelInfo.model,
        effort: claim.definition.reasoningEffort,
        threadId: claim.definition.threadId || "",
        serviceName: "private-runner-codex-schedule",
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error(errorMessage(error));
    }
    if (claim) await finishDispatch(claim, result, failure);
  }

  function pump() {
    while (activeStarts < MAX_START_CONCURRENCY && queuedIds.length > 0) {
      const id = queuedIds.shift();
      activeStarts += 1;
      void runQueued(id).catch(() => {}).finally(() => {
        queuedIdSet.delete(id);
        activeStarts -= 1;
        pump();
        notifyIdle();
        armTimer();
      });
    }
    notifyIdle();
  }

  async function evaluate() {
    const dueIds = await serialize(async () => {
      const atMs = now().getTime();
      return definitionsStore.schedules
        .filter((definition) => definition.enabled &&
          Date.parse(runtimeStore.runtimes[definition.id]?.nextOccurrenceAt || "") <= atMs)
        .map((definition) => definition.id);
    });
    for (const id of dueIds) {
      if (queuedIdSet.has(id)) continue;
      queuedIdSet.add(id);
      queuedIds.push(id);
    }
    pump();
    armTimer();
    await whenIdle();
  }

  async function snapshot() {
    return serialize(async () => buildSnapshot(definitionsStore.schedules, runtimeStore));
  }

  async function commitNormalizedDefinitions(schedules, at) {
    const previousDefinitions = new Map(
      definitionsStore.schedules.map((definition) => [definition.id, definition]),
    );
    const runtimes = {};
    for (const definition of schedules) {
      const previousDefinition = previousDefinitions.get(definition.id);
      const previousRuntime = runtimeStore.runtimes[definition.id];
      const changedTrigger = triggerChanged(previousDefinition, definition);
      let nextOccurrenceAt = previousRuntime?.nextOccurrenceAt ?? null;
      if (changedTrigger) {
        nextOccurrenceAt = definition.enabled
          ? codexScheduleOccurrenceAfter(definition, at, false)
          : null;
        if (definition.rrule === null && definition.enabled && !nextOccurrenceAt) {
          throw new Error(`schedule ${definition.id} one-time start must be in the future`);
        }
      }
      runtimes[definition.id] = {
        definitionHash: codexScheduleDefinitionHash(definition),
        nextOccurrenceAt: definition.enabled ? nextOccurrenceAt : null,
        lastDispatch: clone(previousRuntime?.lastDispatch ?? null),
      };
    }
    const updatedAt = iso(at);
    const nextRevision = definitionsStore.revision + 1;
    const nextDefinitions = {
      version: 1,
      revision: nextRevision,
      schedules,
      updatedAt,
    };
    const nextRuntime = {
      version: 1,
      definitionsRevision: nextRevision,
      runtimes,
      updatedAt,
    };
    const definitionsText = encoded(
      nextDefinitions,
      CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES,
      "definitions store",
    );
    const runtimeText = encoded(nextRuntime, CODEX_SCHEDULE_RUNTIME_MAX_BYTES, "runtime store");
    await persistBoth(definitionsText, runtimeText);
    definitionsStore = nextDefinitions;
    runtimeStore = nextRuntime;
    return buildSnapshot(schedules, nextRuntime);
  }

  async function replaceSchedules(payload) {
    const result = await serialize(async () => {
      const body = requireObject(payload, "request");
      if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) {
        throw new Error("baseRevision must be a non-negative integer");
      }
      if (body.baseRevision !== definitionsStore.revision) {
        throw new CodexScheduleRevisionConflictError(definitionsStore.revision);
      }
      const schedules = await normalizeDefinitions(body.schedules, {
        parseCodexOptions,
        validateCwd,
      });
      return commitNormalizedDefinitions(schedules, now());
    });
    armTimer();
    void evaluate().catch(() => {});
    return result;
  }

  async function createSchedule(payload, idempotencyKey) {
    let committed = false;
    const result = await serialize(async () => {
      const body = requireObject(payload, "request");
      onlyKeys(body, new Set(["baseRevision", "schedule"]), "request");
      if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) {
        throw new Error("baseRevision must be a non-negative integer");
      }
      if (!CODEX_SCHEDULE_UUID_PATTERN.test(String(idempotencyKey || ""))) {
        throw new Error("idempotency key is invalid");
      }
      const input = requireObject(body.schedule, "schedule");
      onlyKeys(input, CREATE_DEFINITION_KEYS, "schedule");
      const schedule = normalizeDefinition(
        { ...input, id: idempotencyKey },
        0,
        parseCodexOptions,
        true,
      );
      const existing = definitionsStore.schedules.find((item) => item.id === idempotencyKey);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(schedule)) {
          const snapshot = buildSnapshot(definitionsStore.schedules, runtimeStore);
          return {
            created: false,
            revision: snapshot.revision,
            schedule: snapshot.schedules.find((item) => item.id === idempotencyKey),
          };
        }
        throw new CodexScheduleIdempotencyConflictError(idempotencyKey, definitionsStore.revision);
      }
      if (body.baseRevision !== definitionsStore.revision) {
        throw new CodexScheduleRevisionConflictError(definitionsStore.revision);
      }
      if (definitionsStore.schedules.length >= CODEX_SCHEDULE_MAX_COUNT) {
        throw new Error("schedules must contain at most 100 entries");
      }
      await validateCwd(schedule.cwd);
      const snapshot = await commitNormalizedDefinitions(
        [...definitionsStore.schedules, schedule],
        now(),
      );
      committed = true;
      return {
        created: true,
        revision: snapshot.revision,
        schedule: snapshot.schedules.find((item) => item.id === idempotencyKey),
      };
    });
    if (committed) {
      armTimer();
      void evaluate().catch(() => {});
    }
    return result;
  }

  async function patchSchedule(id, payload) {
    let committed = false;
    const result = await serialize(async () => {
      if (!CODEX_SCHEDULE_UUID_PATTERN.test(String(id || ""))) {
        throw new Error("schedule id is invalid");
      }
      const body = requireObject(payload, "request");
      onlyKeys(body, new Set(["baseRevision", "patch"]), "request");
      if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) {
        throw new Error("baseRevision must be a non-negative integer");
      }
      const patch = requireObject(body.patch, "patch");
      onlyKeys(patch, CREATE_DEFINITION_KEYS, "patch");
      const patchKeys = Object.keys(patch);
      if (patchKeys.length === 0) throw new Error("patch must not be empty");
      const index = definitionsStore.schedules.findIndex((schedule) => schedule.id === id);
      if (index < 0) throw new CodexScheduleNotFoundError();
      const current = definitionsStore.schedules[index];
      const schedule = normalizeDefinition({ ...current, ...patch }, index, parseCodexOptions, true);
      if (patchKeys.every((key) => current[key] === schedule[key])) {
        const snapshot = buildSnapshot(definitionsStore.schedules, runtimeStore);
        return {
          updated: false,
          revision: snapshot.revision,
          schedule: snapshot.schedules.find((item) => item.id === id),
        };
      }
      if (body.baseRevision !== definitionsStore.revision) {
        throw new CodexScheduleRevisionConflictError(definitionsStore.revision);
      }
      await validateCwd(schedule.cwd);
      const schedules = [...definitionsStore.schedules];
      schedules[index] = schedule;
      const snapshot = await commitNormalizedDefinitions(schedules, now());
      committed = true;
      return {
        updated: true,
        revision: snapshot.revision,
        schedule: snapshot.schedules.find((item) => item.id === id),
      };
    });
    if (committed) {
      armTimer();
      void evaluate().catch(() => {});
    }
    return result;
  }

  async function deleteSchedule(id, payload) {
    const result = await serialize(async () => {
      if (!CODEX_SCHEDULE_UUID_PATTERN.test(String(id || ""))) {
        throw new Error("schedule id is invalid");
      }
      const body = requireObject(payload, "request");
      onlyKeys(body, new Set(["baseRevision"]), "request");
      if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) {
        throw new Error("baseRevision must be a non-negative integer");
      }
      const index = definitionsStore.schedules.findIndex((schedule) => schedule.id === id);
      if (index < 0) throw new CodexScheduleNotFoundError();
      if (body.baseRevision !== definitionsStore.revision) {
        throw new CodexScheduleRevisionConflictError(definitionsStore.revision);
      }
      const schedules = definitionsStore.schedules.filter((schedule) => schedule.id !== id);
      const snapshot = await commitNormalizedDefinitions(schedules, now());
      return { deleted: true, id, revision: snapshot.revision };
    });
    armTimer();
    void evaluate().catch(() => {});
    return result;
  }

  async function start() {
    await serialize(async () => {
      let changed = false;
      for (const runtime of Object.values(runtimeStore.runtimes)) {
        if (runtime.lastDispatch?.status !== "claimed") continue;
        runtime.lastDispatch.status = "failed_uncertain_after_restart";
        runtime.lastDispatch.errorCode = "runner_restarted_after_claim";
        runtime.lastDispatch.errorMessage = "Runner restarted after claim; not retried to avoid duplicate side effects";
        runtime.lastDispatch.updatedAt = iso(now());
        changed = true;
      }
      if (changed) await persistRuntime();
    });
    await evaluate();
    armTimer();
  }

  function stop() {
    clearArmedTimer();
  }

  return {
    start,
    stop,
    evaluate,
    replaceSchedules,
    createSchedule,
    patchSchedule,
    deleteSchedule,
    snapshot,
    whenIdle,
    get activeStartCount() { return activeStarts; },
    get timerArmed() { return Boolean(timer); },
  };
}
