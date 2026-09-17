import type { CodexAuthProfileEntry, CodexAuthRateLimit } from "../types/appTypes";

export function parseCodexAuthRateLimits(value: unknown): CodexAuthRateLimit[] {
  const values = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
  return values.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const windowDurationMins = Number(item.windowDurationMins ?? item.window_duration_mins);
    const usedPercent = Number(item.usedPercent ?? item.used_percent);
    if (!Number.isFinite(windowDurationMins) || windowDurationMins <= 0 || !Number.isFinite(usedPercent)) return [];
    const reset = item.resetsAt ?? item.resets_at;
    return [{ windowDurationMins, usedPercent: Math.max(0, Math.min(100, usedPercent)), ...(reset ? { resetsAt: String(reset) } : {}) }];
  });
}

function resetAtMs(value: string | undefined): number {
  if (!value) return NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  return Date.parse(value);
}

export function formatCodexAuthRateLimits(
  profile: Pick<CodexAuthProfileEntry, "rateLimits">,
  nowMs = Date.now()
): string {
  const limits = profile.rateLimits || [];
  const fiveHour = limits.find((limit) => limit.windowDurationMins === 300);
  const weekly = limits.find((limit) => limit.windowDurationMins === 10080);
  const parts = [
    fiveHour ? `5h ${Math.round(100 - fiveHour.usedPercent)}%` : "",
    weekly ? `週 ${Math.round(100 - weekly.usedPercent)}%` : "",
  ].filter(Boolean);

  const weeklyResetAtMs = resetAtMs(weekly?.resetsAt);
  if (Number.isFinite(weeklyResetAtMs)) {
    const remainingMinutes = Math.ceil(Math.max(0, weeklyResetAtMs - nowMs) / 60_000);
    const days = Math.floor(remainingMinutes / 1440);
    const hours = Math.floor((remainingMinutes % 1440) / 60);
    const minutes = remainingMinutes % 60;
    parts.push(`${days}日${hours}:${String(minutes).padStart(2, "0")}`);
  }

  return parts.join(" | ");
}
