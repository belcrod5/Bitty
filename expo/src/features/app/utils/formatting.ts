export type SttMetaChipInput = {
  sttProvider?: string;
  durationMs?: number;
  speechMs?: number;
  silenceTrimmedMs?: number;
  speechRatio?: number;
  payloadBytes?: number;
  segmentSeq?: number;
  sttRoundtripMs?: number;
};

export function parseContextUsageUsedPct(raw: unknown): number | null {
  const payload = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const value = Number(payload?.usedPct);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function parseOptionalFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value;
}

export function formatElapsedMmSs(rawMs: number): string {
  const ms = Math.max(0, Math.floor(Number(rawMs) || 0));
  const totalSec = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function formatElapsedHhMmSs(rawMs: number): string {
  const ms = Math.max(0, Math.floor(Number(rawMs) || 0));
  const totalSec = Math.floor(ms / 1000);
  const hh = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function toFiniteNumber(raw: unknown): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function formatBytesCompact(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || Number(bytes) <= 0) return "";
  const size = Number(bytes);
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)}MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${Math.round(size)}B`;
}

export function formatMsCompact(ms: number | undefined): string {
  if (!Number.isFinite(ms) || Number(ms) <= 0) return "";
  const value = Number(ms);
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

export function buildSttMetaChips(meta?: SttMetaChipInput): string[] {
  if (!meta) return [];
  const chips: string[] = [];
  chips.push(meta.sttProvider ? `src:${meta.sttProvider}` : "src:file");
  if (Number.isFinite(meta.segmentSeq)) chips.push(`seg:${meta.segmentSeq}`);
  const duration = formatMsCompact(meta.durationMs);
  if (duration) chips.push(`len:${duration}`);
  const speech = formatMsCompact(meta.speechMs);
  if (speech) chips.push(`speech:${speech}`);
  const silenceTrimmed = formatMsCompact(meta.silenceTrimmedMs);
  if (silenceTrimmed) chips.push(`trim:${silenceTrimmed}`);
  if (Number.isFinite(meta.speechRatio)) chips.push(`ratio:${Math.round(Number(meta.speechRatio) * 100)}%`);
  const payload = formatBytesCompact(meta.payloadBytes);
  if (payload) chips.push(`size:${payload}`);
  const rtt = formatMsCompact(meta.sttRoundtripMs);
  if (rtt) chips.push(`stt:${rtt}`);
  return chips;
}

export function formatSessionUpdatedAt(raw: unknown): string {
  const text = String(raw || "").trim();
  if (!text) return "-";
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return text;
  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelativeUpdatedAt(raw: unknown, nowMs = Date.now()): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  const updatedAtMs = new Date(text).getTime();
  if (!Number.isFinite(updatedAtMs)) return "";
  const elapsedMs = Math.max(0, Number(nowMs) - updatedAtMs);
  const elapsedMinutes = Math.max(1, Math.floor(elapsedMs / 60000));
  const format = (value: number, unit: Intl.RelativeTimeFormatUnit, fallbackUnit: string) => {
    if (typeof Intl !== "undefined" && typeof Intl.RelativeTimeFormat === "function") {
      return new Intl.RelativeTimeFormat("ja-JP", {
        numeric: "always",
        style: "long",
      }).format(-value, unit).replace(/\s+/g, "");
    }
    return `${value}${fallbackUnit}前`;
  };
  if (elapsedMinutes < 60) {
    return format(elapsedMinutes, "minute", "分");
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return format(elapsedHours, "hour", "時間");
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  return format(elapsedDays, "day", "日");
}
