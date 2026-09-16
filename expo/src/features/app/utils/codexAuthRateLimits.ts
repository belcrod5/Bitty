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

export function formatCodexAuthRateLimits(profile: Pick<CodexAuthProfileEntry, "rateLimits">): string {
  return (profile.rateLimits || []).map((limit) => {
    const minutes = limit.windowDurationMins;
    const window = minutes % 1440 === 0 ? `${minutes / 1440}日` : minutes % 60 === 0 ? `${minutes / 60}時間` : `${minutes}分`;
    return `${window} ${Math.round(limit.usedPercent)}%使用`;
  }).join(" | ");
}
