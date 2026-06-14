import { parseOptionalFiniteNumber } from "./formatting";

export type LlmSessionSource = "acp" | "cli" | "all" | "appserver" | "vscode" | "exec" | "unknown";
export type LlmSessionMessageRole = "user" | "assistant";

export type LlmRuntimeLimitsSnapshot = {
  llmTimeoutMs: number | null;
  toolMaxRounds: number | null;
  approvalTimeoutMs: number | null;
  sttTimeoutMs: number | null;
  fetchedAt: string;
};

export type LlmSessionHistoryEntryLike = {
  sessionId: string;
  source: LlmSessionSource;
  updatedAt: string;
  lastReadAt?: string;
  firstUserMessage: string;
  contextUsedPct: number | null;
};

export function parseOptionalSessionId(raw: unknown): string {
  return String(raw || "").trim();
}

export function llmStreamSessionKey(raw: unknown, fallback: string): string {
  const sessionId = parseOptionalSessionId(raw);
  if (sessionId) return sessionId;
  return fallback;
}

export function createLlmClientRequestId(): string {
  const ms = Math.max(0, Math.floor(Date.now()));
  const randomHex = `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`
    .padEnd(16, "0")
    .slice(0, 16);
  return `req_${ms.toString(36)}_${randomHex}`;
}

export function createLlmSessionId(): string {
  const ms = Math.max(0, Math.floor(Date.now()));
  const tsHex = ms.toString(16).padStart(12, "0").slice(-12);
  const randomHex = `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`
    .padEnd(20, "0")
    .slice(0, 20);
  const variantBase = Number.parseInt(randomHex.slice(3, 7), 16);
  const variant = ((Number.isFinite(variantBase) ? variantBase : 0) & 0x3fff) | 0x8000;
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-7${randomHex.slice(0, 3)}-${variant
    .toString(16)
    .padStart(4, "0")}-${randomHex.slice(7, 19)}`;
}

export function parseLlmSessionSource(raw: unknown, fallback: LlmSessionSource = "unknown"): LlmSessionSource {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "all") return "all";
  if (value === "cli") return "cli";
  if (value === "acp") return "acp";
  if (value === "appserver" || value === "app_server") return "appserver";
  if (value === "vscode") return "vscode";
  if (value === "exec") return "exec";
  if (value === "unknown") return "unknown";
  return fallback;
}

export function parseLlmSessionMessageRole(raw: unknown): LlmSessionMessageRole | "" {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "user" || value === "assistant") return value;
  return "";
}

function parseSessionUpdatedAtMs(raw: unknown): number {
  const text = String(raw || "").trim();
  if (!text) return 0;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function isLlmSessionUnread(session: { updatedAt?: unknown; lastReadAt?: unknown }): boolean {
  const updatedAtMs = Date.parse(String(session.updatedAt || ""));
  const lastReadAtMs = Date.parse(String(session.lastReadAt || ""));
  return (
    Number.isFinite(updatedAtMs) &&
    (!Number.isFinite(lastReadAtMs) || updatedAtMs > lastReadAtMs)
  );
}

function sessionHistoryEntryPriority(entry: LlmSessionHistoryEntryLike): number {
  let score = 0;
  if (entry.source === "cli") score += 100;
  if (entry.source === "appserver") score += 95;
  if (entry.source === "vscode") score += 90;
  if (entry.source === "exec") score += 80;
  if (String(entry.firstUserMessage || "").trim()) score += 10;
  if (entry.contextUsedPct !== null) score += 5;
  return score;
}

function pickPreferredSessionHistoryEntry(
  current: LlmSessionHistoryEntryLike,
  candidate: LlmSessionHistoryEntryLike
): LlmSessionHistoryEntryLike {
  const currentPriority = sessionHistoryEntryPriority(current);
  const candidatePriority = sessionHistoryEntryPriority(candidate);
  if (candidatePriority > currentPriority) return candidate;
  if (candidatePriority < currentPriority) return current;
  const currentUpdatedAt = parseSessionUpdatedAtMs(current.updatedAt);
  const candidateUpdatedAt = parseSessionUpdatedAtMs(candidate.updatedAt);
  if (candidateUpdatedAt > currentUpdatedAt) return candidate;
  return current;
}

export function dedupeSessionHistoryEntries<T extends LlmSessionHistoryEntryLike>(entries: T[]): T[] {
  const bestBySessionId = new Map<string, T>();
  for (const entry of entries) {
    const sessionId = String(entry.sessionId || "").trim();
    if (!sessionId) continue;
    const existing = bestBySessionId.get(sessionId);
    if (!existing) {
      bestBySessionId.set(sessionId, entry);
      continue;
    }
    bestBySessionId.set(sessionId, pickPreferredSessionHistoryEntry(existing, entry) as T);
  }
  const out: T[] = [];
  const emitted = new Set<string>();
  for (const entry of entries) {
    const sessionId = String(entry.sessionId || "").trim();
    if (!sessionId || emitted.has(sessionId)) continue;
    const best = bestBySessionId.get(sessionId);
    if (best === entry) {
      out.push(entry);
      emitted.add(sessionId);
    }
  }
  return out;
}

export function parseLlmRuntimeLimitsSnapshot(raw: unknown): LlmRuntimeLimitsSnapshot {
  const payload = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const llm = payload.llm && typeof payload.llm === "object" ? payload.llm : {};
  const approval = payload.approval && typeof payload.approval === "object" ? payload.approval : {};
  const stt = payload.stt && typeof payload.stt === "object" ? payload.stt : {};
  return {
    llmTimeoutMs: parseOptionalFiniteNumber((llm as { timeoutMs?: unknown }).timeoutMs),
    toolMaxRounds: parseOptionalFiniteNumber((llm as { toolMaxRounds?: unknown }).toolMaxRounds),
    approvalTimeoutMs: parseOptionalFiniteNumber((approval as { timeoutMs?: unknown }).timeoutMs),
    sttTimeoutMs: parseOptionalFiniteNumber((stt as { groqTimeoutMs?: unknown }).groqTimeoutMs),
    fetchedAt: new Date().toISOString(),
  };
}
