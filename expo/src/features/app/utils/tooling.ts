import { trimForInline } from "./statusText";

export type ToolAutoApprovalMap = Record<string, true>;
export type MediaTarget = "all" | "youtube" | "tts";

export function toolNameToStatusLabel(raw: string): string {
  const name = String(raw || "").trim();
  if (!name) return "unknown_tool";
  if (name === "list_dir") return "search_dir";
  if (name === "find_files") return "find_files";
  if (name === "search_text") return "search_text";
  if (name === "read_file") return "file_open";
  if (name === "write_file") return "file_write";
  if (name === "edit_file") return "file_edit";
  if (name === "restricted_exec") return "restricted_exec";
  return name;
}

export function extractRestrictedExecSubtoolLabel(argsSummary: unknown): string {
  if (!argsSummary || typeof argsSummary !== "object") return "";
  const data = argsSummary as Record<string, unknown>;
  const command = String(data?.command || "").trim().toLowerCase();
  if (!command) return "";
  if (command !== "toolrun") return command;
  const args = Array.isArray(data?.args) ? data.args : [];
  const firstArg = String(args[0] || "").trim();
  if (!firstArg) return "toolrun";
  return `toolrun:${firstArg}`;
}

export function buildToolDisplayLabel(toolName: string, argsSummary: unknown): string {
  const base = toolNameToStatusLabel(toolName);
  if (base !== "restricted_exec") return base;
  const subtool = extractRestrictedExecSubtoolLabel(argsSummary);
  if (!subtool) return base;
  return `${base} (${subtool})`;
}

export function buildApprovalCommandLabel(commandRaw: unknown, argsRaw: unknown): string {
  const command = String(commandRaw || "").trim();
  if (!command) return "(unknown)";
  const args = Array.isArray(argsRaw) ? argsRaw : [];
  const firstArg = String(args[0] || "").trim();
  if (!firstArg) return command;
  return `${command} ${firstArg}`;
}

export function normalizeApprovalKey(raw: unknown): string {
  const text = String(raw || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!text) return "";
  if (text.length > 120) return text.slice(0, 120);
  return text;
}

export function resolveToolApprovalKey(payload: unknown): string {
  const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const fromServer = normalizeApprovalKey(data?.approvalKey);
  if (fromServer) return fromServer;
  const command = normalizeApprovalKey(data?.command);
  if (!command) return "";
  const args = Array.isArray(data?.args) ? data.args : [];
  const firstArg = normalizeApprovalKey(args[0]);
  return firstArg ? `${command}:${firstArg}` : command;
}

export function normalizeMediaTarget(raw: unknown): MediaTarget | "" {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "all" || value === "youtube" || value === "tts") {
    return value;
  }
  return "";
}

function extractPathFromArgsSummary(argsSummary: unknown): string {
  if (!argsSummary || typeof argsSummary !== "object") return "";
  const path = String((argsSummary as Record<string, unknown>)?.path || "").trim();
  return path;
}

export function buildToolStartStatusLine(toolName: string, argsSummary: unknown): string {
  const label = buildToolDisplayLabel(toolName, argsSummary);
  if (label === "file_open") {
    const path = extractPathFromArgsSummary(argsSummary);
    if (path) {
      return `file_open : "${path}"`;
    }
  }
  return `tool : ${label}`;
}

export function buildToolErrorStatusLine(toolName: string, errorMessage: unknown, argsSummary: unknown): string {
  const label = buildToolDisplayLabel(toolName, argsSummary);
  const message = String(errorMessage || "").trim();
  if (!message) return `tool_error : ${label}`;
  return `tool_error : ${label} (${trimForInline(message, 120)})`;
}

export function buildCompactToolDoneStatusLine(
  toolName: string,
  argsSummary: unknown,
  statusRaw: unknown,
  durationMsRaw: unknown
): string {
  const toolLabel = buildToolDisplayLabel(toolName, argsSummary);
  const status = String(statusRaw || "").trim().toLowerCase();
  const phase = status && status !== "ok" ? "start->error" : "start->done";
  const durationMs = Number(durationMsRaw);
  const durationSec = Number.isFinite(durationMs) && durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}sec` : "-";
  return `tool: ${toolLabel} (${phase}) ${durationSec}`;
}

export function buildProgressStatusLine(entry: {
  stage: string;
  message?: string;
  round?: number | null;
  maxToolRounds?: number | null;
  toolCalls?: number | null;
  pendingToolCalls?: number | null;
  toolName?: string;
  status?: string;
  durationMs?: number | null;
}): string {
  const stage = String(entry.stage || "").trim();
  const message = trimForInline(String(entry.message || "").trim(), 120);
  const round = Number(entry.round);
  const maxToolRounds = Number(entry.maxToolRounds);
  const toolCalls = Number(entry.toolCalls);
  const pendingToolCalls = Number(entry.pendingToolCalls);
  const toolName = String(entry.toolName || "").trim();
  const status = String(entry.status || "").trim();
  const durationMs = Number(entry.durationMs);
  const parts: string[] = [];
  if (Number.isFinite(round) && Number.isFinite(maxToolRounds) && maxToolRounds > 0) {
    parts.push(`r${round}/${maxToolRounds}`);
  } else if (Number.isFinite(round)) {
    parts.push(`r${round}`);
  }
  if (Number.isFinite(toolCalls)) {
    parts.push(`tools=${toolCalls}`);
  }
  if (Number.isFinite(pendingToolCalls)) {
    parts.push(`pending=${pendingToolCalls}`);
  }
  if (toolName) {
    parts.push(`tool=${toolNameToStatusLabel(toolName)}`);
  }
  if (status) {
    parts.push(`status=${status}`);
  }
  if (Number.isFinite(durationMs) && durationMs > 0) {
    parts.push(`${Math.round(durationMs)}ms`);
  }
  const detail = [parts.join(" "), message].filter(Boolean).join(" | ");
  return detail ? `progress : ${stage} ${detail}` : `progress : ${stage}`;
}
