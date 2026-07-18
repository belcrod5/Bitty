import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

const MAX_ENABLED_RULES = 20;
const MAX_PROMPT_CHARS = 24_000;
const OCCURRENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

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

function ruleSignature(rule) {
  return JSON.stringify(rule);
}

export function createLocationScheduleService({
  storePath,
  parseCodexOptions,
  executeTurn,
  validateCwd,
  now = () => new Date(),
  scheduleTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = clearTimeout,
}) {
  let loaded = false;
  let mutationQueue = Promise.resolve();
  let timer = null;
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
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const phoneTimeZone = validateTimeZone(parsed.phoneTimeZone || "UTC");
        data = {
          ...data,
          phoneTimeZone,
          rules: parseLocationScheduleRules(parsed.rules || [], phoneTimeZone, parseCodexOptions),
          states: parsed.states && typeof parsed.states === "object" ? parsed.states : {},
          occurrences: parsed.occurrences && typeof parsed.occurrences === "object" ? parsed.occurrences : {},
          updatedAt: String(parsed.updatedAt || ""),
        };
      }
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) {
        console.warn(`[location-schedule] reinitializing unreadable store: ${error instanceof Error ? error.message : error}`);
      }
    }
    loaded = true;
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
    const cutoff = at.getTime() - OCCURRENCE_RETENTION_MS;
    for (const [key, occurrence] of Object.entries(data.occurrences)) {
      if (Date.parse(String(occurrence?.createdAt || "")) < cutoff) delete data.occurrences[key];
    }
  }

  function claimEligibleRules(at) {
    const claimed = [];
    for (const rule of data.rules) {
      if (!rule.enabled || data.states[rule.id]?.state !== "inside") continue;
      const window = windowAt(rule, at);
      if (!window.active || data.occurrences[window.occurrenceKey]) continue;
      const createdAt = at.toISOString();
      data.occurrences[window.occurrenceKey] = {
        occurrenceKey: window.occurrenceKey,
        ruleId: rule.id,
        status: "pending",
        threadId: "",
        turnId: "",
        errorMessage: "",
        createdAt,
        updatedAt: createdAt,
      };
      claimed.push({ rule: { ...rule }, occurrenceKey: window.occurrenceKey });
    }
    return claimed;
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
        approvalPolicy: "on-request",
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
  }

  async function evaluate() {
    const claimed = await serialize(async () => {
      const at = now();
      pruneOccurrences(at);
      const result = claimEligibleRules(at);
      if (result.length) await persist();
      return result;
    });
    for (const item of claimed) {
      void runClaim(item).catch((error) => {
        console.warn(`[location-schedule] failed to record execution result: ${error instanceof Error ? error.message : error}`);
      });
    }
    return claimed.length;
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
        if (!rule.enabled || (old && ruleSignature(old) === ruleSignature(rule))) continue;
        const window = windowAt(rule, at);
        if (!window.active || data.occurrences[window.occurrenceKey]) continue;
        data.occurrences[window.occurrenceKey] = {
          occurrenceKey: window.occurrenceKey,
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
      if (!data.rules.some((rule) => rule.id === ruleId)) throw new Error(`unknown ruleId: ${ruleId}`);
      if (state !== "inside" && state !== "outside") throw new Error("state must be inside or outside");
      const eventId = String(payload?.eventId || "").trim().slice(0, 200);
      if (!eventId) throw new Error("eventId is required");
      if (eventId && data.states[ruleId]?.eventId === eventId) return false;
      const observedAt = String(payload?.observedAt || "").trim();
      const parsedObservedAt = Date.parse(observedAt);
      if (!Number.isFinite(parsedObservedAt)) throw new Error("observedAt must be an ISO timestamp");
      const currentObservedAt = Date.parse(String(data.states[ruleId]?.observedAt || ""));
      if (Number.isFinite(parsedObservedAt) && Number.isFinite(currentObservedAt) && parsedObservedAt < currentObservedAt) {
        return false;
      }
      data.states[ruleId] = {
        state,
        eventId,
        observedAt: new Date(parsedObservedAt).toISOString(),
        receivedAt: now().toISOString(),
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
