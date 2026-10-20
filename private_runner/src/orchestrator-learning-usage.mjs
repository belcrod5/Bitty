import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

const DAY = 86_400_000;
const DEFAULT_LIMITS = { dailyCalls: 12, dailyTokens: 100_000, detailDays: 90,
  detailCount: 10_000, detailBytes: 20 * 1024 * 1024, aggregateDays: 400, aggregateBytes: 4 * 1024 * 1024 };
const copy = (value) => structuredClone(value);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const token = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, limit = 256) => typeof value === "string" && value.length <= limit ? value : null;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const dayOf = (time) => new Date(time).toISOString().slice(0, 10);
const empty = () => ({ schemaVersion: 1, priceSnapshot: null, calls: [], days: {}, retention: { createdAt: null,
  detailPrunedThrough: null, aggregatePrunedThrough: null, unmatchedSettlements: 0 } });

function normalizeUsage(value = {}) {
  const usage = { inputTokens: token(value.inputTokens), outputTokens: token(value.outputTokens),
    cachedInputTokens: token(value.cachedInputTokens), reasoningOutputTokens: token(value.reasoningOutputTokens),
    cacheWriteInputTokens: token(value.cacheWriteInputTokens), totalTokens: token(value.totalTokens),
    cachedInputIncluded: typeof value.cachedInputIncluded === "boolean" ? value.cachedInputIncluded : null,
    reasoningOutputIncluded: typeof value.reasoningOutputIncluded === "boolean" ? value.reasoningOutputIncluded : null,
    cacheWriteInputIncluded: typeof value.cacheWriteInputIncluded === "boolean" ? value.cacheWriteInputIncluded : null,
    source: text(value.source), schema: text(value.schema) };
  if (usage.inputTokens !== null && usage.outputTokens !== null
    && !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)) throw new Error("Unsafe learning usage total");
  if (usage.cachedInputTokens !== null && usage.inputTokens !== null
    && usage.cachedInputIncluded && usage.cachedInputTokens > usage.inputTokens) throw new Error("Invalid cached input usage");
  if (usage.reasoningOutputTokens !== null && usage.outputTokens !== null
    && usage.reasoningOutputIncluded && usage.reasoningOutputTokens > usage.outputTokens) throw new Error("Invalid reasoning usage");
  usage.state = usage.inputTokens !== null && usage.outputTokens !== null
    && !(usage.cachedInputTokens > 0 && usage.cachedInputIncluded !== true)
    && !(usage.reasoningOutputTokens > 0 && usage.reasoningOutputIncluded !== true)
    && !(usage.cacheWriteInputTokens > 0 && usage.cacheWriteInputIncluded !== true)
    && (usage.totalTokens === null || usage.totalTokens === usage.inputTokens + usage.outputTokens) ? "measured"
    : [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.reasoningOutputTokens,
      usage.cacheWriteInputTokens, usage.totalTokens].some((v) => v !== null) ? "partial" : "missing";
  return usage;
}

function normalizePrice(value) {
  if (!value) return null;
  const rates = {};
  for (const name of ["input", "cachedInput", "output", "reasoningOutput"]) {
    const rate = value.ratesPerMillion?.[name];
    rates[name] = typeof rate === "number" && Number.isFinite(rate) && rate >= 0 ? rate : null;
  }
  if (!text(value.version) || !text(value.source, 1024) || !/^[A-Z]{3}$/.test(value.currency || "")
    || !Number.isFinite(Date.parse(value.validFrom)) || !text(value.contract)) throw new Error("Invalid learning price snapshot");
  return { version: value.version, source: value.source, currency: value.currency,
    validFrom: new Date(value.validFrom).toISOString(), contract: value.contract,
    model: text(value.model), unit: "per-million-tokens", ratesPerMillion: rates };
}

function calculatePrice(call) {
  const price = call.priceSnapshot;
  const usage = call.usage;
  const unavailable = (reason) => ({ kind: "rate-estimate", formulaVersion: 1, amount: null,
    currency: price?.currency ?? null, reason });
  if (!price) return unavailable("price-unavailable");
  if (Date.parse(price.validFrom) > Date.parse(call.startedAt)) return unavailable("price-not-effective");
  if (!call.reportedModel || !price.model || call.reportedModel !== price.model) return unavailable("price-model-unconfirmed");
  if (usage.cacheWriteInputTokens > 0) return unavailable("cache-write-price-unavailable");
  if (usage.cachedInputTokens !== null && !usage.cachedInputIncluded
    || usage.reasoningOutputTokens !== null && !usage.reasoningOutputIncluded) return unavailable("usage-inclusion-unconfirmed");
  if (usage.state !== "measured") return unavailable("usage-incomplete");
  const rates = price.ratesPerMillion;
  if (rates.input === null || rates.output === null) return unavailable("rate-unavailable");
  if (rates.cachedInput !== null && usage.cachedInputTokens === null
    || rates.reasoningOutput !== null && usage.reasoningOutputTokens === null) return unavailable("usage-breakdown-missing");
  const cached = usage.cachedInputTokens ?? 0;
  const reasoning = usage.reasoningOutputTokens ?? 0;
  const amount = ((usage.inputTokens - cached) * rates.input + cached * (rates.cachedInput ?? rates.input)
    + (usage.outputTokens - reasoning) * rates.output + reasoning * (rates.reasoningOutput ?? rates.output)) / 1_000_000;
  if (!Number.isFinite(amount)) return unavailable("cost-overflow");
  return { kind: "rate-estimate", formulaVersion: 1, amount, currency: price.currency, reason: null };
}

function contribution(call) {
  const complete = call.usage.state === "measured";
  const known = (call.usage.inputTokens ?? 0) + (call.usage.outputTokens ?? 0);
  return { calls: 1, failedCalls: call.status === "failed" ? 1 : 0,
    missingCalls: complete ? 0 : 1, inputTokens: call.usage.inputTokens ?? 0,
    outputTokens: call.usage.outputTokens ?? 0, cachedInputTokens: call.usage.cachedInputTokens ?? 0,
    reasoningOutputTokens: call.usage.reasoningOutputTokens ?? 0,
    cacheWriteInputTokens: call.usage.cacheWriteInputTokens ?? 0,
    missingInputCalls: call.usage.inputTokens === null ? 1 : 0,
    missingOutputCalls: call.usage.outputTokens === null ? 1 : 0,
    budgetTokens: complete ? known : Math.max(call.reservedTokens, known, call.usage.totalTokens ?? 0),
    reservationChargedTokens: complete ? 0 : Math.max(call.reservedTokens, known, call.usage.totalTokens ?? 0),
    estimatedAmount: call.cost.amount ?? 0, unpricedCalls: call.cost.amount === null ? 1 : 0 };
}

function bucketDimensions(call) {
  return { purpose: call.purpose, settingsRevision: call.settingsRevision, reportedModel: call.reportedModel,
    reportedEffort: call.reportedEffort, requestedModel: call.requestedModel, requestedEffort: call.requestedEffort,
    provider: call.provider, reportedProvider: call.reportedProvider ?? null,
    runtime: call.runtime, status: call.status, usageState: call.usage.state,
    priceSnapshot: call.priceSnapshot, currency: call.cost.currency };
}

function account(state, call, direction) {
  const day = state.days[call.day] ||= { buckets: {}, compacted: { count: 0, callIdHash: null, throughStartedAt: null, reasons: [] } };
  const dimensions = bucketDimensions(call);
  const key = hash(JSON.stringify(dimensions));
  const bucket = day.buckets[key] ||= { dimensions, totals: Object.fromEntries(Object.keys(contribution(call)).map((key) => [key, 0])) };
  for (const [key, value] of Object.entries(contribution(call))) bucket.totals[key] += direction * value;
  if (bucket.totals.calls === 0) delete day.buckets[key];
}

/** Single-writer ledger exclusively for orchestrator learning and evaluation calls. */
export function createOrchestratorLearningUsage({ directory, now = Date.now, fileSystem = fs, limits: overrides = {} }) {
  if (!directory) throw new Error("Learning usage directory is required");
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid learning usage limit");
  const file = path.join(directory, "ledger.json");
  let state = empty();
  let blockedReason = null;
  let writes = Promise.resolve();
  const serialize = (work) => {
    const result = writes.then(work);
    writes = result.catch(() => {});
    return result;
  };

  async function ownedDirectory() {
    try { await fileSystem.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await fileSystem.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Unsafe learning usage directory");
  }

  function validateFile(stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || typeof process.getuid === "function" && stat.uid !== process.getuid()
      || stat.size > limits.detailBytes + limits.aggregateBytes + 65_536) throw new Error("Unsafe learning usage file");
  }

  async function persist(next) {
    let temporary;
    try {
      await ownedDirectory();
      try { validateFile(await fileSystem.lstat(file)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await fileSystem.open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(next)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await fileSystem.rename(temporary, file);
      const parent = await fileSystem.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      try { await parent.sync(); } finally { await parent.close(); }
      state = next;
    } catch (error) {
      blockedReason = "usage-storage-failed";
      if (temporary) await fileSystem.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  function prune(next, time) {
    const cutoff = dayOf(time - limits.aggregateDays * DAY);
    for (const day of Object.keys(next.days).sort()) if (day < cutoff) {
      delete next.days[day];
      next.retention.aggregatePrunedThrough = day;
    }
    for (const [day, record] of Object.entries(next.days)) {
      if (day < dayOf(time) && record.buckets.anonymous) {
        record.compacted.count -= record.buckets.anonymous.totals.calls;
        delete record.buckets.anonymous;
      }
      if (!Object.keys(record.buckets).length && record.compacted.reasons.includes("explicit-deletion")) delete next.days[day];
    }
    const expired = time - limits.detailDays * DAY;
    next.calls.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    while (next.calls.length && (Date.parse(next.calls[0].startedAt) < expired
      || next.calls.length > limits.detailCount || bytes(next.calls) > limits.detailBytes)) {
      const reason = Date.parse(next.calls[0].startedAt) < expired ? "age" : "capacity";
      const call = next.calls.shift();
      const day = next.days[call.day];
      if (day) {
        day.compacted.callIdHash = hash(`${day.compacted.callIdHash || ""}:${call.callId}`);
        day.compacted.count++;
        day.compacted.throughStartedAt = call.startedAt;
        if (!day.compacted.reasons.includes(reason)) day.compacted.reasons.push(reason);
      }
      next.retention.detailPrunedThrough = call.startedAt;
    }
    if (bytes(next.days) > limits.aggregateBytes) throw new Error("Learning usage aggregate capacity exceeded");
  }

  async function load() {
    try {
      await ownedDirectory();
      const handle = await fileSystem.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw;
      try { validateFile(await handle.stat()); raw = await handle.readFile("utf8"); }
      finally { await handle.close(); }
      const loaded = JSON.parse(raw);
      if (loaded.schemaVersion !== 1 || !Array.isArray(loaded.calls) || !loaded.days || !loaded.retention
        || bytes(loaded.calls) > limits.detailBytes || bytes(loaded.days) > limits.aggregateBytes) throw new Error("Invalid learning usage ledger");
      if (loaded.calls.some((call) => !text(call.callId) || !/^\d{4}-\d{2}-\d{2}$/.test(call.day)
        || !Number.isFinite(Date.parse(call.startedAt)) || token(call.reservedTokens) === null
        || !["pending", "completed", "failed", "interrupted", "unknown"].includes(call.status)
        || !call.usage || normalizeUsage(call.usage).state !== call.usage.state || !call.cost)
        || new Set(loaded.calls.map((call) => call.callId)).size !== loaded.calls.length
        || Object.entries(loaded.days).some(([day, value]) => !/^\d{4}-\d{2}-\d{2}$/.test(day)
          || !value?.buckets || !value.compacted || !Array.isArray(value.compacted.reasons)
          || Object.values(value.buckets).some((bucket) => !bucket?.dimensions || !bucket.totals
            || !Number.isSafeInteger(bucket.totals.calls) || bucket.totals.calls < 0
            || !Number.isSafeInteger(bucket.totals.budgetTokens) || bucket.totals.budgetTokens < 0
            || Object.values(bucket.totals).some((value) => !Number.isFinite(value))))) throw new Error("Invalid learning usage ledger");
      normalizePrice(loaded.priceSnapshot);
      const retained = { days: {} };
      const cutoff = dayOf(now() - limits.aggregateDays * DAY);
      for (const call of loaded.calls) account(retained, call, 1);
      for (const [day, expected] of Object.entries(retained.days)) {
        if (day < cutoff && !loaded.days[day]) continue;
        for (const [key, bucket] of Object.entries(expected.buckets)) {
          const actual = loaded.days[day]?.buckets[key]?.totals;
          if (!actual || Object.entries(bucket.totals).some(([name, minimum]) => !Number.isFinite(actual[name])
            || actual[name] < minimum - (name === "estimatedAmount" ? Math.abs(minimum) * 1e-12 : 0))) {
            throw new Error("Learning usage accounting is incomplete");
          }
        }
      }
      for (const [day, value] of Object.entries(loaded.days)) {
        const retainedCount = Object.values(retained.days[day]?.buckets || {}).reduce((sum, bucket) => sum + bucket.totals.calls, 0);
        const aggregatedCount = Object.values(value.buckets).reduce((sum, bucket) => sum + bucket.totals.calls, 0);
        if (!Number.isSafeInteger(value.compacted.count) || value.compacted.count < 0
          || aggregatedCount !== retainedCount + value.compacted.count) throw new Error("Learning usage call count is inconsistent");
      }
      state = loaded;
    } catch (error) {
      if (error.code !== "ENOENT") { blockedReason = "usage-ledger-unreadable"; return; }
      state = empty();
      state.retention.createdAt = new Date(now()).toISOString();
    }
    blockedReason = null;
    const next = copy(state);
    let changed = false;
    for (const call of next.calls) if (call.status === "pending") {
      account(next, call, -1);
      call.status = "unknown";
      call.reasonCode = "restart-without-result";
      call.endedAt = new Date(now()).toISOString();
      account(next, call, 1);
      changed = true;
    }
    try {
      prune(next, now());
      if (changed || JSON.stringify(next) !== JSON.stringify(state)) await persist(next);
    } catch { blockedReason ||= "usage-capacity-exceeded"; }
  }
  const ready = load();

  function budget(day = dayOf(now())) {
    const totals = Object.values(state.days[day]?.buckets || {}).reduce((sum, bucket) => ({
      calls: sum.calls + bucket.totals.calls, tokens: sum.tokens + bucket.totals.budgetTokens,
    }), { calls: 0, tokens: 0 });
    return { day, ...totals, maxCalls: limits.dailyCalls, maxTokens: limits.dailyTokens };
  }

  function todaySummary() {
    const summary = { measuredCalls: 0, partialCalls: 0, missingCalls: 0, unpricedCalls: 0,
      inputTokens: null, outputTokens: null, reservationChargedTokens: 0, anonymousCalls: 0, estimatedCosts: [] };
    const currencies = new Map();
    for (const { dimensions, totals } of Object.values(state.days[dayOf(now())]?.buckets || {})) {
      if (dimensions.anonymous) { summary.anonymousCalls += totals.calls; continue; }
      summary[`${dimensions.usageState}Calls`] += totals.calls;
      summary.unpricedCalls += totals.unpricedCalls;
      summary.reservationChargedTokens += totals.reservationChargedTokens;
      if (totals.missingInputCalls < totals.calls) summary.inputTokens = (summary.inputTokens ?? 0) + totals.inputTokens;
      if (totals.missingOutputCalls < totals.calls) summary.outputTokens = (summary.outputTokens ?? 0) + totals.outputTokens;
      if (dimensions.currency && totals.unpricedCalls < totals.calls) {
        currencies.set(dimensions.currency, (currencies.get(dimensions.currency) || 0) + totals.estimatedAmount);
      }
    }
    summary.estimatedCosts = [...currencies].map(([currency, amount]) => ({ currency, amount }));
    return summary;
  }

  return {
    reserve(input) { return serialize(async () => {
      await ready;
      if (blockedReason) return { ok: false, reason: blockedReason };
      if (!text(input.batchId) || !Number.isSafeInteger(input.attempt) || input.attempt < 1
        || !Number.isSafeInteger(input.settingsRevision) || input.settingsRevision < 0 || !text(input.model)
        || token(input.estimatedInputTokens) === null || token(input.maxOutputTokens) === null) throw new Error("Invalid learning usage reservation");
      const time = now();
      const reservedTokens = input.estimatedInputTokens + input.maxOutputTokens;
      if (!Number.isSafeInteger(reservedTokens)) throw new Error("Invalid learning token reservation");
      const used = budget(dayOf(time));
      if (used.calls + 1 > limits.dailyCalls || used.tokens + reservedTokens > limits.dailyTokens) return { ok: false, reason: "daily-budget-exceeded", budget: used };
      const call = { callId: randomUUID(), batchId: input.batchId, attempt: input.attempt,
        purpose: text(input.purpose) || "learning-evaluation", settingsRevision: input.settingsRevision,
        requestedModel: input.model, requestedEffort: text(input.effort), provider: text(input.provider), runtime: text(input.runtime),
        reportedModel: null, reportedEffort: null, reportedProvider: null, requestId: null, turnId: null,
        day: dayOf(time), startedAt: new Date(time).toISOString(), endedAt: null, status: "pending", reasonCode: null,
        estimatedInputTokens: input.estimatedInputTokens, maxOutputTokens: input.maxOutputTokens, reservedTokens,
        usage: normalizeUsage(), priceSnapshot: normalizePrice(input.priceSnapshot === undefined ? state.priceSnapshot : input.priceSnapshot), cost: null };
      call.cost = calculatePrice(call);
      const next = copy(state);
      next.calls.push(call);
      account(next, call, 1);
      try { prune(next, time); } catch { blockedReason = "usage-capacity-exceeded"; return { ok: false, reason: blockedReason }; }
      if (!next.calls.some((saved) => saved.callId === call.callId)) {
        blockedReason = "usage-capacity-exceeded";
        return { ok: false, reason: blockedReason };
      }
      await persist(next);
      return { ok: true, call: copy(call), budget: budget(call.day) };
    }); },

    settle(callId, result = {}) { return serialize(async () => {
      await ready;
      if (blockedReason) return { ok: false, reason: blockedReason };
      const next = copy(state);
      const call = next.calls.find((call) => call.callId === callId);
      if (!call) {
        next.retention.unmatchedSettlements++;
        await persist(next);
        return { ok: false, reason: "call-not-retained" };
      }
      if (!["completed", "failed", "interrupted", "unknown"].includes(result.status)) throw new Error("Invalid learning call status");
      account(next, call, -1);
      const incoming = normalizeUsage(result.usage);
      // Terminal retries and late partial notifications cannot erase already measured fields.
      const merged = { ...call.usage };
      for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens", "cacheWriteInputTokens", "totalTokens", "source", "schema"]) {
        if (incoming[key] !== null) merged[key] = incoming[key];
      }
      for (const key of ["cachedInputIncluded", "reasoningOutputIncluded", "cacheWriteInputIncluded"]) {
        if (incoming[key] !== null) merged[key] = incoming[key];
      }
      call.usage = normalizeUsage(merged);
      call.status = result.status;
      call.reasonCode = text(result.reasonCode);
      call.endedAt ||= new Date(now()).toISOString();
      for (const key of ["reportedModel", "reportedEffort", "reportedProvider", "requestId", "turnId"]) if (text(result[key]) !== null) call[key] = result[key];
      call.cost = calculatePrice(call);
      account(next, call, 1);
      try { prune(next, now()); } catch { blockedReason = "usage-capacity-exceeded"; return { ok: false, reason: blockedReason }; }
      if (JSON.stringify(next) !== JSON.stringify(state)) await persist(next);
      return { ok: true, call: copy(call), budget: budget(call.day) };
    }); },

    status() { return serialize(async () => { await ready; return { blockedReason, budget: budget(), today: todaySummary(), retention: copy(state.retention),
      detailCount: state.calls.length, detailBytes: bytes(state.calls), aggregateBytes: bytes(state.days), priceSnapshot: copy(state.priceSnapshot) }; }); },
    history({ since, until, limit = 100 } = {}) { return serialize(async () => {
      await ready;
      const start = since ? Date.parse(since) : -Infinity;
      const end = until ? Date.parse(until) : Infinity;
      if (Number.isNaN(start) || Number.isNaN(end) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Invalid usage history range");
      return { calls: copy(state.calls.filter((call) => Date.parse(call.startedAt) >= start && Date.parse(call.startedAt) <= end).slice(-limit)),
        days: copy(Object.fromEntries(Object.entries(state.days).filter(([day]) => Date.parse(day) + DAY > start && Date.parse(day) <= end))),
        retention: copy(state.retention), blockedReason, aggregateGranularity: "UTC-day" };
    }); },
    detachLearning() { return serialize(async () => {
      await ready;
      if (blockedReason) return { ok: false, reason: blockedReason };
      const next = copy(state);
      for (const call of next.calls) call.batchId = null;
      await persist(next);
      return { ok: true };
    }); },
    configurePrice(snapshot) { return serialize(async () => {
      await ready;
      if (blockedReason) return { ok: false, reason: blockedReason };
      const next = copy(state);
      next.priceSnapshot = normalizePrice(snapshot);
      await persist(next);
      return { ok: true, priceSnapshot: copy(next.priceSnapshot) };
    }); },
    clearHistory() { return serialize(async () => {
      await ready;
      if (blockedReason) return { ok: false, reason: blockedReason };
      const next = empty();
      next.priceSnapshot = copy(state.priceSnapshot);
      const day = dayOf(now());
      next.retention.createdAt = new Date(now()).toISOString();
      // Anonymous current-day totals remain so deletion cannot replenish the budget.
      const used = budget(day);
      next.days[day] = { buckets: { anonymous: { dimensions: { anonymous: true },
        totals: { calls: used.calls, budgetTokens: used.tokens } } }, compacted: { count: used.calls, callIdHash: null, throughStartedAt: null, reasons: ["explicit-deletion"] } };
      await persist(next);
      return { ok: true, anonymousBudgetUntil: `${day}T23:59:59.999Z` };
    }); },
    recover() { return serialize(async () => { await ready; await load(); return { ok: !blockedReason, reason: blockedReason }; }); },
  };
}
