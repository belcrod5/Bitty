import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const MAX_ENABLED_RULES = 20;
const MAX_PROMPT_CHARS = 24_000;
const OCCURRENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const REENTRY_OCCURRENCE_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
// window開始時に最後の位置状態がこの時間より古い場合は、発火前にサイレントpushで
// 端末に現在地の再報告を求める。応答が無い場合は古い状態で発火しない。
const STATE_FRESH_MS = 3 * 60 * 1000;
const STATE_REFRESH_REQUEST_RETENTION_MS = 6 * 60 * 60 * 1000;
const MAX_LOCATION_CLOCK_SKEW_MS = 5 * 60 * 1000;
const REENTRY_COOLDOWN_MS = 15 * 60 * 1000;
const REENTRY_OUTSIDE_MIN_MS = 5 * 60 * 1000;

export class LocationScheduleStoreUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocationScheduleStoreUnavailableError";
    this.code = "LOCATION_SCHEDULE_STORE_UNAVAILABLE";
  }
}

function localDateTime(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    minute: Number(value.hour) * 60 + Number(value.minute),
  };
}

function parseMinute(raw, field) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(raw || ""));
  if (!match) throw new Error(`${field} must be HH:mm`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`${field} must be HH:mm`);
  return hour * 60 + minute;
}

export function windowAt(rule, now = new Date()) {
  const startMinute = parseMinute(rule.startTime, "startTime");
  const endMinute = parseMinute(rule.endTime, "endTime");
  if (endMinute <= startMinute) throw new Error("endTime must be later than startTime");
  const local = localDateTime(now, rule.timeZone);
  return {
    active: local.minute >= startMinute && local.minute < endMinute,
    localDate: local.date,
    occurrenceKey: [rule.id, local.date, rule.startTime, rule.endTime, rule.timeZone].join("|"),
  };
}

function validateTimeZone(raw) {
  const timeZone = String(raw || "").trim();
  if (!timeZone || timeZone.length > 100) throw new Error("timeZone is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error(`invalid timeZone: ${timeZone}`);
  }
  return timeZone;
}

export function parseLocationScheduleRules(rawRules, phoneTimeZone, parseCodexOptions) {
  if (!Array.isArray(rawRules)) throw new Error("rules must be an array");
  if (rawRules.length > 100) throw new Error("rules must contain at most 100 entries");
  const timeZone = validateTimeZone(phoneTimeZone);
  const ids = new Set();
  const rules = rawRules.map((raw, index) => {
    const id = String(raw?.id || "").trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error(`rules[${index}].id is invalid`);
    if (ids.has(id)) throw new Error(`duplicate rule id: ${id}`);
    ids.add(id);
    const enabled = raw?.enabled === true;
    const startTime = String(raw?.startTime || "").trim();
    const endTime = String(raw?.endTime || "").trim();
    const startMinute = parseMinute(startTime, `rules[${index}].startTime`);
    const endMinute = parseMinute(endTime, `rules[${index}].endTime`);
    if (endMinute <= startMinute) throw new Error(`rules[${index}] cannot cross midnight`);
    const ruleTimeZone = validateTimeZone(raw?.timeZone || timeZone);
    if (ruleTimeZone !== timeZone) throw new Error(`rules[${index}].timeZone must match phoneTimeZone`);
    const latitude = Number(raw?.latitude);
    const longitude = Number(raw?.longitude);
    const radiusMeters = Number(raw?.radiusMeters);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error(`rules[${index}].latitude is invalid`);
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error(`rules[${index}].longitude is invalid`);
    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 100_000) throw new Error(`rules[${index}].radiusMeters is invalid`);
    const cwd = String(raw?.cwd || "").trim();
    if (!cwd || cwd.length > 2048) throw new Error(`rules[${index}].cwd is invalid`);
    const prompt = String(raw?.prompt || "").trim();
    if (!prompt || prompt.length > MAX_PROMPT_CHARS) throw new Error(`rules[${index}].prompt is invalid`);
    const regionRevision = String(raw?.regionRevision || "").trim();
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(regionRevision)) {
      throw new Error(`rules[${index}].regionRevision is invalid`);
    }
    const modelRef = String(raw?.modelRef || "").trim();
    if (!modelRef) throw new Error(`rules[${index}].modelRef is required`);
    const requestedEffort = String(raw?.reasoningEffort || "").trim().toLowerCase();
    if (!["low", "medium", "high", "xhigh"].includes(requestedEffort)) {
      throw new Error(`rules[${index}].reasoningEffort is invalid`);
    }
    let codexOptions;
    try {
      codexOptions = parseCodexOptions(modelRef, requestedEffort);
    } catch (error) {
      throw new Error(`rules[${index}] Codex options are invalid: ${error instanceof Error ? error.message : error}`);
    }
    const effort = String(codexOptions?.reasoningEffort || "").trim();
    if (effort !== requestedEffort) throw new Error(`rules[${index}].reasoningEffort was not preserved`);
    return {
      id,
      enabled,
      startTime,
      endTime,
      timeZone,
      latitude,
      longitude,
      radiusMeters,
      regionRevision,
      cwd,
      modelRef: codexOptions.modelInfo.modelRef,
      model: codexOptions.modelInfo.model,
      reasoningEffort: effort,
      prompt,
    };
  });
  if (rules.filter((rule) => rule.enabled).length > MAX_ENABLED_RULES) {
    throw new Error(`at most ${MAX_ENABLED_RULES} rules may be enabled`);
  }
  return rules;
}

function ruleFingerprint(rule) {
  return createHash("sha256").update(JSON.stringify(rule)).digest("hex");
}

export function createLocationScheduleService({
  storePath,
  parseCodexOptions,
  executeTurn,
  validateCwd,
  requestStateRefresh,
  now = () => new Date(),
  scheduleTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = clearTimeout,
}) {
  let loaded = false;
  let mutationQueue = Promise.resolve();
  let timer = null;
  const stateRefreshRequests = new Map();
  let data = {
    version: 1,
    phoneTimeZone: "UTC",
    rules: [],
    states: {},
    occurrences: {},
    updatedAt: "",
  };

  async function load() {
    if (loaded) return;
    try {
      const parsed = JSON.parse(await fs.readFile(storePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("store must be an object");
      if (parsed.version !== 1) throw new Error(`unsupported store version: ${parsed.version}`);
      if (!Array.isArray(parsed.rules)) throw new Error("store.rules must be an array");
      if (!parsed.states || typeof parsed.states !== "object" || Array.isArray(parsed.states)) {
        throw new Error("store.states must be an object");
      }
      if (!parsed.occurrences || typeof parsed.occurrences !== "object" || Array.isArray(parsed.occurrences)) {
        throw new Error("store.occurrences must be an object");
      }
      const phoneTimeZone = validateTimeZone(parsed.phoneTimeZone);
      const rules = parseLocationScheduleRules(parsed.rules, phoneTimeZone, parseCodexOptions);
      const allowedStatuses = new Set([
        "queued",
        "pending",
        "running",
        "completed",
        "failed",
        "failed_uncertain_after_restart",
        "failed_configuration_changed_while_queued",
        "skipped_edited_active_window",
      ]);
      for (const [key, occurrence] of Object.entries(parsed.occurrences)) {
        if (!occurrence || typeof occurrence !== "object" || Array.isArray(occurrence)) {
          throw new Error(`store.occurrences[${key}] must be an object`);
        }
        if (key !== occurrence.occurrenceKey) throw new Error(`store.occurrences[${key}] key mismatch`);
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(occurrence.ruleId || ""))) {
          throw new Error(`store.occurrences[${key}].ruleId is invalid`);
        }
        if (!allowedStatuses.has(occurrence.status)) {
          throw new Error(`store.occurrences[${key}].status is invalid`);
        }
        if (!Number.isFinite(Date.parse(String(occurrence.createdAt || "")))) {
          throw new Error(`store.occurrences[${key}].createdAt is invalid`);
        }
        if (occurrence.windowKey !== undefined) {
          const windowKey = String(occurrence.windowKey || "");
          if (key !== windowKey && key !== `${windowKey}|edited` && !key.startsWith(`${windowKey}|entry|`)) {
            throw new Error(`store.occurrences[${key}].windowKey is invalid`);
          }
        }
        let legacyRule = null;
        if (occurrence.ruleSignature !== undefined
          && !/^[a-f0-9]{64}$/.test(String(occurrence.ruleSignature))) {
          try {
            legacyRule = JSON.parse(occurrence.ruleSignature);
          } catch {
            throw new Error(`store.occurrences[${key}].ruleSignature is invalid`);
          }
          if (!legacyRule || typeof legacyRule !== "object" || Array.isArray(legacyRule)) {
            throw new Error(`store.occurrences[${key}].ruleSignature is invalid`);
          }
          occurrence.ruleSignature = ruleFingerprint(legacyRule);
        }
        if (occurrence.status !== "queued") continue;
        if (!/^[a-f0-9]{64}$/.test(String(occurrence.ruleSignature || ""))) {
          throw new Error(`store.occurrences[${key}].ruleSignature is invalid`);
        }
        const createdAt = new Date(occurrence.createdAt);
        const [ruleId, , startTime, endTime, timeZone, extra] = String(occurrence.windowKey || "").split("|");
        const claimedWindow = extra === undefined
          ? windowAt({ id: ruleId, startTime, endTime, timeZone }, createdAt)
          : null;
        if (!claimedWindow
          || ruleId !== occurrence.ruleId
          || occurrence.windowKey !== claimedWindow.occurrenceKey
          || !claimedWindow.active
          || (key !== claimedWindow.occurrenceKey && !key.startsWith(`${claimedWindow.occurrenceKey}|entry|`))) {
          throw new Error(`store.occurrences[${key}] queued claim is inconsistent with its rule`);
        }
        if (legacyRule && (legacyRule.id !== occurrence.ruleId || legacyRule.enabled !== true)) {
          throw new Error(`store.occurrences[${key}] queued claim is inconsistent with its rule`);
        }
      }
      data = {
        ...data,
        phoneTimeZone,
        rules,
        states: parsed.states,
        occurrences: parsed.occurrences,
        updatedAt: String(parsed.updatedAt || ""),
      };
      loaded = true;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        loaded = true;
        return;
      }
      throw new LocationScheduleStoreUnavailableError(
        `failed to load location schedule store: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  async function persist() {
    data.updatedAt = now().toISOString();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, storePath);
  }

  function serialize(operation) {
    const result = mutationQueue.then(async () => {
      await load();
      return operation();
    });
    mutationQueue = result.catch(() => {});
    return result;
  }

  function pruneOccurrences(at) {
    let changed = false;
    const initialCutoff = at.getTime() - OCCURRENCE_RETENTION_MS;
    const reentryCutoff = at.getTime() - REENTRY_OCCURRENCE_RETENTION_MS;
    for (const [key, occurrence] of Object.entries(data.occurrences)) {
      if (occurrence?.status === "queued" || occurrence?.status === "pending" || occurrence?.status === "running") {
        continue;
      }
      const windowKey = String(occurrence?.windowKey || occurrence?.occurrenceKey || "");
      const initialOccurrence = key === windowKey && occurrence?.status !== "skipped_edited_active_window";
      const cutoff = initialOccurrence ? initialCutoff : reentryCutoff;
      if (Date.parse(String(occurrence?.createdAt || "")) < cutoff) {
        delete data.occurrences[key];
        changed = true;
      }
    }
    const refreshCutoff = at.getTime() - STATE_REFRESH_REQUEST_RETENTION_MS;
    for (const [key, requestedAtMs] of stateRefreshRequests) {
      if (requestedAtMs < refreshCutoff) stateRefreshRequests.delete(key);
    }
    return changed;
  }

  function occurrencesForWindow(windowKey) {
    return Object.values(data.occurrences).filter((occurrence) => (
      String(occurrence?.windowKey || occurrence?.occurrenceKey || "") === windowKey
    ));
  }

  function latestClaim(occurrences) {
    return occurrences
      .filter((occurrence) => occurrence?.status !== "skipped_edited_active_window")
      .reduce((latest, occurrence) => (
        !latest || Date.parse(String(occurrence?.createdAt || "")) > Date.parse(String(latest.createdAt || ""))
          ? occurrence
          : latest
      ), null);
  }

  function claimEligibleRules(at) {
    let claimedCount = 0;
    const staleRules = [];
    for (const rule of data.rules) {
      const state = data.states[rule.id];
      if (!rule.enabled || !state || state.regionRevision !== rule.regionRevision) continue;
      const window = windowAt(rule, at);
      if (!window.active) continue;
      const windowOccurrences = occurrencesForWindow(window.occurrenceKey);
      if (windowOccurrences.some((occurrence) => occurrence?.status === "skipped_edited_active_window")) continue;
      if (typeof requestStateRefresh === "function") {
        const observedAtMs = Date.parse(String(state.observedAt || ""));
        const receivedAtMs = Date.parse(String(state.receivedAt || ""));
        const freshAtMs = Number.isFinite(observedAtMs) && Number.isFinite(receivedAtMs)
          ? Math.min(observedAtMs, receivedAtMs)
          : 0;
        const ageMs = at.getTime() - freshAtMs;
        if (ageMs > STATE_FRESH_MS) {
          if (!stateRefreshRequests.has(window.occurrenceKey)) {
            stateRefreshRequests.set(window.occurrenceKey, at.getTime());
            staleRules.push({ ...rule });
          }
          continue;
        }
      }
      if (state.state !== "inside") continue;
      const previousClaim = latestClaim(windowOccurrences);
      let occurrenceKey = window.occurrenceKey;
      if (previousClaim) {
        if (state.reentryEligible !== true || !state.entryId || !state.stateSince) continue;
        const previousClaimAtMs = Date.parse(String(previousClaim.createdAt || ""));
        const entryAtMs = Date.parse(String(state.stateSince || ""));
        if (!Number.isFinite(previousClaimAtMs)
          || !Number.isFinite(entryAtMs)
          || at.getTime() - previousClaimAtMs < REENTRY_COOLDOWN_MS
          || entryAtMs - previousClaimAtMs < REENTRY_COOLDOWN_MS) {
          continue;
        }
        occurrenceKey = `${window.occurrenceKey}|entry|${encodeURIComponent(state.stateSince)}|${encodeURIComponent(state.entryId)}`;
        if (data.occurrences[occurrenceKey]) continue;
      }
      stateRefreshRequests.delete(window.occurrenceKey);
      const createdAt = at.toISOString();
      data.occurrences[occurrenceKey] = {
        occurrenceKey,
        windowKey: window.occurrenceKey,
        ruleId: rule.id,
        ruleSignature: ruleFingerprint(rule),
        status: "queued",
        threadId: "",
        turnId: "",
        errorMessage: "",
        createdAt,
        updatedAt: createdAt,
      };
      state.reentryEligible = false;
      claimedCount += 1;
    }
    return { claimedCount, staleRules };
  }

  function takeRunnableClaims(at) {
    const runnable = [];
    let changed = false;
    const activeRuleIds = new Set(
      Object.values(data.occurrences)
        .filter((occurrence) => occurrence?.status === "pending" || occurrence?.status === "running")
        .map((occurrence) => occurrence.ruleId)
    );
    const queued = Object.values(data.occurrences)
      .filter((occurrence) => occurrence?.status === "queued")
      .sort((left, right) => Date.parse(String(left.createdAt || "")) - Date.parse(String(right.createdAt || "")));
    for (const occurrence of queued) {
      if (activeRuleIds.has(occurrence.ruleId)) continue;
      const rule = data.rules.find((candidate) => candidate.id === occurrence.ruleId && candidate.enabled);
      if (!rule || occurrence.ruleSignature !== ruleFingerprint(rule)) {
        occurrence.status = "failed_configuration_changed_while_queued";
        occurrence.errorMessage = "Schedule changed after this enter was queued; not executed with different settings";
        occurrence.updatedAt = at.toISOString();
        changed = true;
        continue;
      }
      occurrence.status = "pending";
      occurrence.updatedAt = at.toISOString();
      runnable.push({ rule: { ...rule }, occurrenceKey: occurrence.occurrenceKey });
      activeRuleIds.add(rule.id);
      changed = true;
    }
    return { runnable, changed };
  }

  async function runClaim({ rule, occurrenceKey }) {
    await serialize(async () => {
      const occurrence = data.occurrences[occurrenceKey];
      occurrence.status = "running";
      occurrence.updatedAt = now().toISOString();
      await persist();
    });
    let result = null;
    let failure = null;
    try {
      await validateCwd(rule.cwd);
      result = await executeTurn({
        inputText: rule.prompt,
        cwd: rule.cwd,
        model: rule.model,
        effort: rule.reasoningEffort,
        approvalPolicy: "never",
      });
    } catch (error) {
      failure = error;
    }
    await serialize(async () => {
      const occurrence = data.occurrences[occurrenceKey];
      if (failure) {
        occurrence.status = "failed";
        occurrence.errorMessage = String(failure instanceof Error ? failure.message : failure).slice(0, 1000);
      } else {
        occurrence.status = "completed";
        occurrence.threadId = String(result?.threadId || "").trim();
        occurrence.turnId = String(result?.turnId || "").trim();
      }
      occurrence.updatedAt = now().toISOString();
      await persist();
    });
    await evaluate();
  }

  async function evaluate() {
    const { claimedCount, runnable, staleRules } = await serialize(async () => {
      const at = now();
      const pruned = pruneOccurrences(at);
      const result = claimEligibleRules(at);
      const pending = takeRunnableClaims(at);
      if (pruned || result.claimedCount || pending.changed) await persist();
      return { ...result, runnable: pending.runnable };
    });
    if (staleRules.length && typeof requestStateRefresh === "function") {
      void Promise.resolve(requestStateRefresh({ rules: staleRules })).catch((error) => {
        console.warn(`[location-schedule] state refresh request failed: ${error instanceof Error ? error.message : error}`);
      });
    }
    for (const item of runnable) {
      void runClaim(item).catch((error) => {
        console.warn(`[location-schedule] failed to record execution result: ${error instanceof Error ? error.message : error}`);
      });
    }
    return claimedCount;
  }

  function armTimer() {
    if (timer) clearTimer(timer);
    const ms = now().getTime();
    const delay = 60_050 - (ms % 60_000);
    timer = scheduleTimer(async () => {
      timer = null;
      await evaluate().catch((error) => console.warn(`[location-schedule] evaluation failed: ${error instanceof Error ? error.message : error}`));
      armTimer();
    }, delay);
    timer?.unref?.();
  }

  async function replaceSchedules(payload) {
    const result = await serialize(async () => {
      const at = now();
      const phoneTimeZone = validateTimeZone(payload?.phoneTimeZone);
      const rules = parseLocationScheduleRules(payload?.rules, phoneTimeZone, parseCodexOptions);
      const previous = new Map(data.rules.map((rule) => [rule.id, rule]));
      for (const rule of rules) {
        const old = previous.get(rule.id);
        if (!old) continue;
        const locationChanged = old.latitude !== rule.latitude
          || old.longitude !== rule.longitude
          || old.radiusMeters !== rule.radiusMeters;
        const revisionChanged = old.regionRevision !== rule.regionRevision;
        if (locationChanged !== revisionChanged) {
          throw new Error(`rule ${rule.id} regionRevision must change exactly when its location changes`);
        }
      }
      data.phoneTimeZone = phoneTimeZone;
      data.rules = rules;
      const liveIds = new Set(rules.map((rule) => rule.id));
      for (const id of Object.keys(data.states)) if (!liveIds.has(id)) delete data.states[id];
      for (const rule of rules) {
        const old = previous.get(rule.id);
        if (!old || (
          rule.enabled && (
            !old.enabled ||
            old.latitude !== rule.latitude ||
            old.longitude !== rule.longitude ||
            old.radiusMeters !== rule.radiusMeters
          )
        )) {
          delete data.states[rule.id];
        }
        if (!rule.enabled || (old && ruleFingerprint(old) === ruleFingerprint(rule))) continue;
        const window = windowAt(rule, at);
        if (!window.active || occurrencesForWindow(window.occurrenceKey).some((occurrence) => (
          occurrence?.status === "skipped_edited_active_window"
        ))) continue;
        const occurrenceKey = data.occurrences[window.occurrenceKey]
          ? `${window.occurrenceKey}|edited`
          : window.occurrenceKey;
        data.occurrences[occurrenceKey] = {
          occurrenceKey,
          windowKey: window.occurrenceKey,
          ruleId: rule.id,
          status: "skipped_edited_active_window",
          threadId: "",
          turnId: "",
          errorMessage: "",
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
        };
      }
      await persist();
      return snapshot();
    });
    await evaluate();
    armTimer();
    return result;
  }

  async function recordState(payload) {
    const accepted = await serialize(async () => {
      const ruleId = String(payload?.ruleId || "").trim();
      const state = String(payload?.state || "").trim().toLowerCase();
      const rule = data.rules.find((item) => item.id === ruleId);
      if (!rule) throw new Error(`unknown ruleId: ${ruleId}`);
      const regionRevision = String(payload?.regionRevision || "").trim();
      if (regionRevision !== rule.regionRevision) throw new Error(`stale regionRevision for ruleId: ${ruleId}`);
      if (state !== "inside" && state !== "outside") throw new Error("state must be inside or outside");
      const eventId = String(payload?.eventId || "").trim().slice(0, 200);
      if (!eventId) throw new Error("eventId is required");
      if (eventId && data.states[ruleId]?.eventId === eventId) return false;
      const receivedAt = now();
      const observedAt = String(payload?.observedAt || "").trim();
      const parsedObservedAt = Date.parse(observedAt);
      if (!Number.isFinite(parsedObservedAt)) throw new Error("observedAt must be an ISO timestamp");
      if (parsedObservedAt > receivedAt.getTime() + MAX_LOCATION_CLOCK_SKEW_MS) {
        throw new Error("observedAt is too far in the future");
      }
      const currentObservedAt = Date.parse(String(data.states[ruleId]?.observedAt || ""));
      if (Number.isFinite(parsedObservedAt) && Number.isFinite(currentObservedAt) && parsedObservedAt < currentObservedAt) {
        return false;
      }
      const previousState = data.states[ruleId];
      const observedAtIso = new Date(parsedObservedAt).toISOString();
      const sameState = previousState?.state === state;
      let stateSince = observedAtIso;
      let receivedStateSince = receivedAt.toISOString();
      let entryId = state === "inside" ? eventId : "";
      let reentryEligible = false;
      if (sameState) {
        stateSince = String(previousState.stateSince || previousState.observedAt || observedAtIso);
        receivedStateSince = String(
          previousState.receivedStateSince || previousState.receivedAt || receivedAt.toISOString()
        );
        if (state === "inside") {
          entryId = String(previousState.entryId || previousState.eventId || eventId);
          reentryEligible = previousState.reentryEligible === true;
        }
      } else if (state === "inside" && previousState?.state === "outside") {
        const outsideSinceMs = Date.parse(String(previousState.stateSince || previousState.observedAt || ""));
        const outsideReceivedSinceMs = Date.parse(String(
          previousState.receivedStateSince || previousState.receivedAt || ""
        ));
        const window = windowAt(rule, receivedAt);
        const previousClaim = window.active ? latestClaim(occurrencesForWindow(window.occurrenceKey)) : null;
        const previousClaimAtMs = Date.parse(String(previousClaim?.createdAt || ""));
        reentryEligible = Number.isFinite(outsideSinceMs)
          && parsedObservedAt - outsideSinceMs >= REENTRY_OUTSIDE_MIN_MS
          && Number.isFinite(outsideReceivedSinceMs)
          && receivedAt.getTime() - outsideReceivedSinceMs >= REENTRY_OUTSIDE_MIN_MS
          && Number.isFinite(previousClaimAtMs)
          && parsedObservedAt - previousClaimAtMs >= REENTRY_COOLDOWN_MS
          && receivedAt.getTime() - previousClaimAtMs >= REENTRY_COOLDOWN_MS;
      }
      data.states[ruleId] = {
        regionRevision,
        state,
        eventId,
        observedAt: observedAtIso,
        receivedAt: receivedAt.toISOString(),
        stateSince,
        receivedStateSince,
        entryId,
        reentryEligible,
      };
      await persist();
      return true;
    });
    if (accepted) await evaluate();
    armTimer();
    return snapshotAsync();
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(data));
  }

  function snapshotAsync() {
    return serialize(async () => snapshot());
  }

  async function start() {
    await serialize(async () => {
      for (const occurrence of Object.values(data.occurrences)) {
        if (occurrence?.status === "pending" || occurrence?.status === "running") {
          occurrence.status = "failed_uncertain_after_restart";
          occurrence.errorMessage = "Runner restarted after claiming this occurrence; not retried to avoid duplicate side effects";
          occurrence.updatedAt = now().toISOString();
        }
      }
      await persist();
    });
    await evaluate();
    armTimer();
  }

  return { start, evaluate, replaceSchedules, recordState, snapshot: snapshotAsync };
}
