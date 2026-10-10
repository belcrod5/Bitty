import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Both upstream APIs describe the same account quota. Keep only quota metadata.
export function codexUsageFromWham(usage) {
  const limits = usage?.rate_limit || {};
  return {
    ...(typeof limits.allowed === "boolean" ? { ordinaryUsageAllowed: limits.allowed } : {}),
    rateLimits: {
      primary: whamWindow(limits.primary_window),
      secondary: whamWindow(limits.secondary_window),
      credits: usage?.credits ? {
        hasCredits: usage.credits.has_credits === true,
        unlimited: usage.credits.unlimited === true,
      } : undefined,
    },
  };
}

function whamWindow(window) {
  if (!window) return undefined;
  return { usedPercent: window.used_percent,
    windowDurationMins: number(window.limit_window_seconds) / 60,
    resetsAt: window.reset_at };
}

function normalizeWindow(raw) {
  const usedPercent = number(raw?.usedPercent);
  if (usedPercent === undefined || usedPercent < 0) return null;
  return { usedPercent: Math.min(100, usedPercent),
    ...(number(raw.windowDurationMins) > 0 ? { windowDurationMins: raw.windowDurationMins } : {}),
    ...(number(raw.resetsAt) > 0 ? { resetsAt: raw.resetsAt } : {}),
  };
}

function mergeLimits(previous = {}, raw = {}) {
  const result = { ...previous };
  for (const name of ["primary", "secondary"]) {
    const incoming = normalizeWindow(raw[name]);
    if (!incoming) continue;
    // Window positions can differ between APIs, so match by duration.
    const matching = Object.entries(result).find(([, window]) =>
      incoming.windowDurationMins && window?.windowDurationMins === incoming.windowDurationMins);
    const conflictingDuration = incoming.windowDurationMins && result[name]?.windowDurationMins
      && incoming.windowDurationMins !== result[name].windowDurationMins;
    const key = matching?.[0] || (conflictingDuration ? ["primary", "secondary"].find((slot) => !result[slot]) : name) || name;
    const old = result[key];
    if (old?.resetsAt && incoming.resetsAt && incoming.resetsAt < old.resetsAt) continue;
    const sameWindow = old && (!incoming.resetsAt || !old.resetsAt || incoming.resetsAt === old.resetsAt);
    result[key] = { ...(sameWindow ? old : {}), ...incoming,
      ...(sameWindow ? { usedPercent: Math.max(old.usedPercent, incoming.usedPercent) } : {}),
    };
  }
  if (typeof raw.credits?.hasCredits === "boolean" && typeof raw.credits?.unlimited === "boolean") {
    result.credits = { hasCredits: raw.credits.hasCredits, unlimited: raw.credits.unlimited };
  }
  if (typeof raw.spendControlReached === "boolean") result.spendControlReached = raw.spendControlReached;
  return result;
}

export function formatCodexUsageStatus(rateLimits = {}, usageLimitReached = false) {
  const windows = [rateLimits.primary, rateLimits.secondary];
  const lines = [
    { minutes: 300, label: "5h limit", includeDate: false },
    { minutes: 10080, label: "Weekly limit", includeDate: true },
  ].flatMap(({ minutes, label, includeDate }) => {
    const window = windows.find((candidate) => candidate?.windowDurationMins === minutes);
    if (!window) return [];
    const left = Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
    const filled = left === 100 ? 10 : Math.min(9, Math.round(left / 10));
    const value = `[${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${left}% left`;
    let reset = "-";
    if (window.resetsAt) {
      const date = new Date(window.resetsAt * 1000);
      reset = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
      if (includeDate) reset += ` on ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date)}`;
    }
    return [{ label, value, reset }];
  });
  return {
    statusText: [...lines.flatMap(({ label, value, reset }) => [`${label}: ${value}`, `(resets ${reset})`]),
      ...(usageLimitReached ? ["Codex の利用上限に達しました。"] : [])].join("\n"),
    limitLines: lines.map(({ label, value, reset }) => ({ section: "default", label, value: `${value} (resets ${reset})` })),
    usageLimitReached,
  };
}

export function buildCodexStatusFromWham(usage) {
  const limits = mergeLimits({}, codexUsageFromWham(usage).rateLimits);
  const snapshot = formatCodexUsageStatus(limits);
  if (!snapshot.limitLines.length) throw new Error("wham usage payload missing 5h/weekly windows");
  return snapshot;
}

// One persistent episode per account, independent of the number of sessions,
// connections, turns or limit windows reporting it. Reserve before any delivery.
export function createCodexUsageService({ storePath, onChanged, onLimitReached, now = Date.now }) {
  let loaded;
  let accounts = {};
  let queue = Promise.resolve();
  const load = () => loaded ||= fs.readFile(storePath, "utf8").then((raw) => {
    accounts = JSON.parse(raw).accounts || {};
  }).catch((error) => { if (error.code !== "ENOENT") throw error; });
  const persist = async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const temp = `${storePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({ version: 1, accounts }), { mode: 0o600 });
      await fs.rename(temp, storePath);
    } finally { await fs.unlink(temp).catch(() => {}); }
  };
  const snapshot = (state) => state && {
    ...formatCodexUsageStatus(state.rateLimits, state.blocked), fetchedAt: state.fetchedAt,
  };

  function observe(accountId, update = {}, { usageLimitExceeded = false, observedAt } = {}) {
    if (!accountId || (update.accountId && update.accountId !== accountId)) return Promise.resolve(null);
    const operation = queue.then(async () => {
      await load();
      const previous = accounts[accountId] || { rateLimits: {}, blocked: false, episode: 0 };
      // A late read must not replace a newer observation, whether it reports
      // exhaustion or recovery (including credits and spend controls).
      if (observedAt !== undefined && observedAt <= Date.parse(previous.fetchedAt)) return { accountId, snapshot: snapshot(previous) };
      const source = update.rateLimitsByLimitId?.codex || update.rateLimits;
      // Other model buckets do not overwrite the ordinary Codex quota.
      if (source?.limitId && source.limitId !== "codex" && !usageLimitExceeded) return snapshot(previous);
      const limits = mergeLimits(previous.rateLimits, source);
      const newlyExhausted = [limits.primary, limits.secondary].some((incoming) =>
        incoming?.usedPercent >= 100 && !Object.values(previous.rateLimits).some((old) =>
          old?.windowDurationMins === incoming.windowDurationMins && old.usedPercent >= 100 && old.resetsAt === incoming.resetsAt));
      const allowance = typeof update.ordinaryUsageAllowed === "boolean"
        ? update.ordinaryUsageAllowed : previous.ordinaryUsageAllowed;
      const windows = [limits.primary, limits.secondary].filter(Boolean);
      const hasCredits = limits.credits?.hasCredits || limits.credits?.unlimited;
      const exhausted = windows.some((window) => window.usedPercent >= 100);
      const oldExhausted = [previous.rateLimits.primary, previous.rateLimits.secondary].filter((window) => window?.usedPercent >= 100);
      const rolledOver = oldExhausted.length > 0 && oldExhausted.every((old) => old.resetsAt && old.resetsAt * 1000 <= now() && windows.some((window) =>
          window.windowDurationMins === old.windowDurationMins && window.resetsAt > old.resetsAt));
      const recovered = update.ordinaryUsageAllowed === true || (source?.credits && hasCredits)
        || (source?.spendControlReached === false && previous.rateLimits.spendControlReached === true) || (allowance === undefined && windows.length > 0 && !exhausted && rolledOver);
      const blocked = usageLimitExceeded || limits.spendControlReached === true || (!hasCredits && allowance === false)
        || (!hasCredits && exhausted && (allowance === undefined || (newlyExhausted && update.ordinaryUsageAllowed !== true)))
        || (previous.blocked && !recovered);
      const newEpisode = blocked && (!previous.blocked || (rolledOver && exhausted));
      const state = { rateLimits: limits, blocked, ordinaryUsageAllowed: allowance,
        episode: previous.episode + (newEpisode ? 1 : 0), fetchedAt: new Date(Math.max(now(), Date.parse(previous.fetchedAt || "") + 1 || 0)).toISOString() };
      accounts[accountId] = state;
      // Persist the reservation before fanout; no TTL can create repeated alerts.
      try { await persist(); } catch (error) { accounts[accountId] = previous; throw error; }
      const current = snapshot(state);
      try { await onChanged?.({ accountId, snapshot: current }); }
      catch { console.warn("[codex-usage] status broadcast failed"); }
      return { accountId, snapshot: current, newEpisode };
    });
    // Delivery is outside the state queue, so a slow APNs call cannot serialize usage ingestion.
    queue = operation.then(() => {}, () => {});
    return operation.then(async (result) => {
      if (result?.newEpisode) await onLimitReached?.({ accountId, episode: result.snapshot.fetchedAt });
      return result?.snapshot || result;
    });
  }

  async function observeNotification(accountId, method, params) {
    if (method === "account/rateLimits/updated") return observe(accountId, params);
    const error = method === "error" ? params?.error : method === "turn/completed" ? params?.turn?.error : null;
    if (error?.codexErrorInfo === "usageLimitExceeded") return observe(accountId, {}, { usageLimitExceeded: true });
    return null;
  }

  return { observe, observeNotification, async snapshot(accountId) { await queue; await load(); return snapshot(accounts[accountId]); } };
}
