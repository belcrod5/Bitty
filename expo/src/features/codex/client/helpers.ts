import type { ApprovalAction, ApprovalRequest } from "../approvalFlow";
import { createWebSocketWithOptionalAuth } from "../../ws/webSocketAuth";
import type {
  CodexContextUsage,
  CodexSessionState,
  CodexThreadListEntry,
  CodexThreadMessage,
  CodexThreadReadResult,
  CodexThreadStatusType,
} from "./types";

export { createWebSocketWithOptionalAuth };

export function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "unknown_error");
}

export function normalizeCodexWsInputs(wsUrlRaw: unknown, wsTokenRaw: unknown) {
  const compactUrl = String(wsUrlRaw || "").replace(/\s+/g, "").trim();
  let wsUrl = compactUrl;
  let wsToken = String(wsTokenRaw || "").trim();
  try {
    const parsed = new URL(compactUrl);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (key.toLowerCase() !== "token") continue;
      if (!wsToken) {
        wsToken = String(parsed.searchParams.get(key) || "").trim();
      }
      parsed.searchParams.delete(key);
    }
    wsUrl = parsed.toString();
  } catch {
    // keep compactUrl as-is
  }
  return { wsUrl, wsToken };
}

export function deriveReadyzUrlFromWsUrl(wsUrl: string): string | null {
  try {
    const parsed = new URL(wsUrl);
    if (parsed.protocol !== "ws:") return null;
    return `http://${parsed.host}/readyz`;
  } catch {
    return null;
  }
}

export async function checkReadyzHttp(readyzUrl: string, timeoutMs: number) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout = setTimeout(() => {
    try {
      controller?.abort();
    } catch {}
  }, timeoutMs);
  try {
    const response = await fetch(readyzUrl, {
      method: "GET",
      cache: "no-store",
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    throw new Error(`readyz preflight failed (${readyzUrl}): ${toErrorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export function parseJsonRpcMessage(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function takeResolvedApprovalRequest(
  pendingRequests: Map<number, { active: boolean; request: ApprovalRequest }>,
  paramsRaw: unknown
) {
  const requestId = Number((paramsRaw as any)?.requestId);
  const pending = pendingRequests.get(requestId);
  if (!pending) return null;
  pending.active = false;
  pendingRequests.delete(requestId);
  return pending.request;
}

export function isNoRolloutForThreadError(error: unknown) {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("no rollout found for thread id");
}

export function isThreadNotLoadedError(error: unknown) {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("thread not loaded:");
}

export function extractNotificationMessage(paramsRaw: unknown) {
  if (!paramsRaw || typeof paramsRaw !== "object") return "";
  const params = paramsRaw as Record<string, unknown>;
  const directMessage = String(params.message || "").trim();
  if (directMessage) return directMessage;
  const errorObject = params.error;
  if (errorObject && typeof errorObject === "object") {
    const nestedMessage = String((errorObject as any).message || "").trim();
    if (nestedMessage) return nestedMessage;
    try {
      return JSON.stringify(errorObject);
    } catch {}
  }
  const detail = String(params.detail || "").trim();
  if (detail) return detail;
  try {
    return JSON.stringify(paramsRaw);
  } catch {
    return "";
  }
}

export function extractAgentMessageText(itemRaw: unknown) {
  if (!itemRaw || typeof itemRaw !== "object") return "";
  const item = itemRaw as Record<string, unknown>;
  const directText = String(item.text || "").trim();
  if (directText) return directText;
  const nestedText = String((item as any)?.message?.text || "").trim();
  if (nestedText) return nestedText;
  const content = (item as any)?.content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const partType = String((part as any)?.type || "").trim();
    if (partType === "localImage") {
      const localPath = String((part as any)?.path || "").trim();
      if (localPath) chunks.push(`[localImage] ${localPath}`);
      continue;
    }
    const text = String((part as any)?.text || "").trim();
    if (text) {
      chunks.push(text);
      continue;
    }
    const value = String((part as any)?.value || "").trim();
    if (value) chunks.push(value);
  }
  return chunks.join("");
}

export function extractUserMessageText(itemRaw: unknown) {
  if (!itemRaw || typeof itemRaw !== "object") return "";
  const item = itemRaw as Record<string, unknown>;
  const directText = String(item.text || "").trim();
  if (directText) return directText;
  const content = (item as any)?.content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const partType = String((part as any)?.type || "").trim();
    if (partType === "localImage") {
      const localPath = String((part as any)?.path || "").trim();
      if (localPath) chunks.push(`[localImage] ${localPath}`);
      continue;
    }
    const text = String((part as any)?.text || "").trim();
    if (text) {
      chunks.push(text);
      continue;
    }
    const value = String((part as any)?.value || "").trim();
    if (value) chunks.push(value);
  }
  return chunks.join("\n").trim();
}

export function extractCommandText(commandRaw: unknown): string {
  if (Array.isArray(commandRaw)) {
    return commandRaw
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ");
  }
  return String(commandRaw || "").trim();
}

export function parseCodexSourceKind(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const normalized = value.toLowerCase();
  if (normalized === "appserver") return "appServer";
  if (normalized === "cli") return "cli";
  if (normalized === "vscode") return "vscode";
  if (normalized === "exec") return "exec";
  return value;
}

export function toIsoTimestamp(raw: unknown) {
  const num = Number(raw);
  if (Number.isFinite(num)) {
    const ms = num > 1000000000000 ? Math.floor(num) : Math.floor(num * 1000);
    const date = new Date(ms);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  const text = String(raw || "").trim();
  if (!text) return "";
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) return text;
  return parsed.toISOString();
}

export function firstString(...values: unknown[]) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

export function parseCodexApprovalPolicy(raw: unknown): "never" | "on-request" {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "never") return "never";
  return "on-request";
}

export function toCodexApprovalDecision(action: ApprovalAction): "accept" | "acceptForSession" | "decline" | "cancel" {
  if (action === "approve_once") return "accept";
  if (action === "approve_for_session") return "acceptForSession";
  if (action === "cancel") return "cancel";
  return "decline";
}

function normalizeApprovalArgs(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  return [];
}

export function normalizeAppServerApprovalRequest(paramsRaw: unknown, options: {
  rpcId: number;
  method: string;
  threadId: string;
  turnId: string;
}): ApprovalRequest {
  const params = paramsRaw && typeof paramsRaw === "object"
    ? (paramsRaw as Record<string, unknown>)
    : {};
  const command = firstString(
    params.command,
    (params as any)?.item?.command,
    (params as any)?.request?.command,
    options.method
  );
  const args = normalizeApprovalArgs(
    params.args ?? (params as any)?.arguments ?? (params as any)?.item?.args ?? (params as any)?.request?.args
  );
  const approvalKey = firstString(
    params.approvalKey,
    params.approval_key,
    (params as any)?.request?.approvalKey
  );
  const reason = firstString(
    params.reason,
    params.detail,
    (params as any)?.request?.reason
  );
  const message = firstString(
    params.message,
    (params as any)?.request?.message
  );
  const requestId = firstString(
    params.requestId,
    params.request_id,
    params.approvalRequestId,
    params.approval_request_id
  ) || `${options.method}:${options.rpcId}`;
  const threadId = firstString(
    params.threadId,
    params.thread_id,
    (params as any)?.thread?.id,
    options.threadId
  );
  const turnId = firstString(
    params.turnId,
    params.turn_id,
    (params as any)?.turn?.id,
    options.turnId
  );
  const derivedApprovalKey = (
    approvalKey ||
    [command, firstString(args[0])].filter(Boolean).join(":")
  ).slice(0, 160);
  return {
    requestId,
    source: "codex-app-server",
    command,
    args,
    reason,
    approvalKey: derivedApprovalKey,
    message,
    threadId,
    turnId,
  };
}

function normalizeTokenCount(raw: unknown) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeContextWindowTokens(raw: unknown) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function normalizeContextUsageSnapshot(rawUsage: unknown, modelNameRaw?: unknown): CodexContextUsage | null {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const usage = rawUsage as Record<string, unknown>;
  const inputTokens = normalizeTokenCount(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = normalizeTokenCount(usage.outputTokens ?? usage.output_tokens);
  const totalTokens = normalizeTokenCount(usage.totalTokens ?? usage.total_tokens) || Math.max(0, inputTokens + outputTokens);
  const cachedInputTokens = normalizeTokenCount(usage.cachedInputTokens ?? usage.cached_input_tokens);
  const reasoningOutputTokens = normalizeTokenCount(usage.reasoningOutputTokens ?? usage.reasoning_output_tokens);
  const contextWindowTokens = normalizeContextWindowTokens(
    usage.contextWindowTokens
    ?? usage.context_window_tokens
    ?? usage.context_window
    ?? usage.modelContextWindow
    ?? usage.model_context_window
  );
  const rawUsedRatio = Number(usage.usedRatio ?? usage.used_ratio);
  const rawUsedPct = Number(usage.usedPct ?? usage.used_pct);
  const usedRatio = Number.isFinite(rawUsedRatio)
    ? Math.max(0, Math.min(1, rawUsedRatio))
    : (
      Number.isFinite(rawUsedPct)
        ? Math.max(0, Math.min(1, rawUsedPct / 100))
        : (contextWindowTokens > 0 ? Math.max(0, Math.min(1, totalTokens / contextWindowTokens)) : NaN)
    );
  const usedPct = Number.isFinite(rawUsedPct)
    ? Math.max(0, Math.min(100, Math.round(rawUsedPct)))
    : (Number.isFinite(usedRatio) ? Math.max(0, Math.min(100, Math.round(usedRatio * 100))) : NaN);
  if (!Number.isFinite(usedPct)) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    contextWindowTokens,
    usedRatio: Number.isFinite(usedRatio) ? usedRatio : usedPct / 100,
    usedPct,
    model: String(modelNameRaw || usage.model || usage.model_name || "").trim(),
  };
}

function extractContextWindowTokens(raw: unknown) {
  if (!raw || typeof raw !== "object") return 0;
  const payload = raw as Record<string, unknown>;
  return normalizeContextWindowTokens(
    payload.contextWindowTokens
    ?? payload.context_window_tokens
    ?? payload.context_window
    ?? payload.modelContextWindow
    ?? payload.model_context_window
  );
}

function withContextWindow(rawUsage: unknown, fallbackContextWindowTokens: number) {
  if (!rawUsage || typeof rawUsage !== "object" || fallbackContextWindowTokens <= 0) {
    return rawUsage;
  }
  const usage = rawUsage as Record<string, unknown>;
  const hasContextWindow = (
    usage.contextWindowTokens != null ||
    usage.context_window_tokens != null ||
    usage.context_window != null ||
    usage.modelContextWindow != null ||
    usage.model_context_window != null
  );
  if (hasContextWindow) return usage;
  return {
    ...usage,
    contextWindowTokens: fallbackContextWindowTokens,
  };
}

export function extractContextUsageFromTurnCompletedParams(paramsRaw: unknown, modelNameRaw?: unknown): CodexContextUsage | null {
  const params = paramsRaw && typeof paramsRaw === "object"
    ? (paramsRaw as Record<string, unknown>)
    : {};
  const turn = params.turn && typeof params.turn === "object"
    ? (params.turn as Record<string, unknown>)
    : {};
  const fallbackContextWindowTokens = (
    extractContextWindowTokens(params) ||
    extractContextWindowTokens(turn) ||
    extractContextWindowTokens(params.usage) ||
    extractContextWindowTokens(turn.usage)
  );
  const usageCandidates: unknown[] = [
    params.contextUsage,
    params.context_usage,
    params.lastContextUsage,
    params.last_context_usage,
    params.usage,
    params.lastUsage,
    params.last_usage,
    params.tokenUsage,
    params.token_usage,
    turn.contextUsage,
    turn.context_usage,
    turn.lastContextUsage,
    turn.last_context_usage,
    turn.usage,
    turn.lastUsage,
    turn.last_usage,
    turn.tokenUsage,
    turn.token_usage,
  ];
  for (const candidate of usageCandidates) {
    const normalized = normalizeContextUsageSnapshot(
      withContextWindow(candidate, fallbackContextWindowTokens),
      modelNameRaw
    );
    if (normalized) return normalized;
  }
  return null;
}

function parseContextUsedPct(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function extractContextUsedPctFromUnknown(raw: unknown, modelNameRaw?: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;
  const directCandidates: unknown[] = [
    payload.contextUsedPct,
    payload.context_used_pct,
    payload.usedPct,
    payload.used_pct,
  ];
  for (const candidate of directCandidates) {
    const parsed = parseContextUsedPct(candidate);
    if (parsed !== null) return parsed;
  }

  const usageCandidates: unknown[] = [
    payload.contextUsage,
    payload.context_usage,
    payload.usage,
    payload.lastUsage,
    payload.last_usage,
    payload.tokenUsage,
    payload.token_usage,
  ];
  for (const candidate of usageCandidates) {
    const normalized = normalizeContextUsageSnapshot(candidate, modelNameRaw);
    if (normalized) return normalized.usedPct;
  }
  return null;
}

export function normalizeThreadListEntry(raw: unknown): CodexThreadListEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const source = item.source && typeof item.source === "object"
    ? item.source as Record<string, unknown>
    : {};
  const subAgent = source.subAgent && typeof source.subAgent === "object"
    ? source.subAgent as Record<string, unknown>
    : {};
  const threadSpawn = subAgent.thread_spawn && typeof subAgent.thread_spawn === "object"
    ? subAgent.thread_spawn as Record<string, unknown>
    : {};
  const explicitSourceKind = firstString(
    item.sourceKind,
    item.sessionStartSource,
    (item as any)?.thread?.sourceKind
  );
  const subAgentSourceKind = source.subAgent && typeof source.subAgent === "object"
    ? (threadSpawn.parent_thread_id ? "subAgentThreadSpawn" : "subAgentOther")
    : source.subAgent === "review"
      ? "subAgentReview"
      : source.subAgent === "compact"
        ? "subAgentCompact"
        : source.subAgent
          ? "subAgentOther"
          : "";
  const threadId = firstString(item.id, item.threadId, (item as any)?.thread?.id);
  if (!threadId) return null;
  return {
    threadId,
    parentThreadId: firstString(
      item.parentThreadId,
      item.parent_thread_id,
      (item as any)?.thread?.parentThreadId,
      (item as any)?.thread?.parent_thread_id,
      threadSpawn.parent_thread_id
    ),
    agentRole: firstString(
      item.agentRole,
      item.agent_role,
      (item as any)?.thread?.agentRole,
      threadSpawn.agent_role
    ),
    agentDisplayName: firstString(
      item.agentDisplayName,
      item.agent_display_name,
      item.agentNickname,
      item.agent_nickname,
      (item as any)?.thread?.agentDisplayName,
      (item as any)?.thread?.agentNickname,
      threadSpawn.agent_nickname
    ),
    preview: firstString(item.preview, item.title, item.summary),
    modelProvider: firstString(item.modelProvider, item.provider),
    sourceKind: parseCodexSourceKind(explicitSourceKind || subAgentSourceKind || item.source),
    cwd: firstString(item.cwd, item.path, (item as any)?.thread?.cwd),
    createdAt: toIsoTimestamp(item.createdAt),
    updatedAt: toIsoTimestamp(item.updatedAt || item.createdAt),
    contextUsedPct: (
      extractContextUsedPctFromUnknown(item, firstString(item.modelProvider, item.provider)) ??
      extractContextUsedPctFromUnknown((item as any)?.thread, firstString(item.modelProvider, item.provider))
    ),
  };
}

function isTerminalTurnStatus(statusRaw: unknown) {
  const turnStatus = normalizeCodexTurnStatus(statusRaw);
  return turnStatus === "completed" || turnStatus === "failed" || turnStatus === "interrupted";
}

function parseIsoTimestampMs(raw: unknown): number {
  const text = String(raw || "").trim();
  if (!text) return 0;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function summarizeRunningTurn(statusRaw: unknown, lastItemTypeRaw: unknown): string {
  const status = String(statusRaw || "").trim().toLowerCase();
  const lastItemType = String(lastItemTypeRaw || "").trim().toLowerCase();
  if (status.includes("approval") || lastItemType.includes("approval")) {
    return "承認待ち";
  }
  if (status.includes("tool") || lastItemType.includes("tool")) {
    return "ツール実行中";
  }
  if (
    status.includes("generat") ||
    status.includes("respond") ||
    status.includes("model") ||
    status.includes("running") ||
    lastItemType.includes("agent")
  ) {
    return "応答生成中";
  }
  return status ? `実行中(status:${status})` : "実行中";
}

function collectStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  if (raw && typeof raw === "object") {
    const out: string[] = [];
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === true) out.push(key);
      if (typeof value === "string" && value.trim()) out.push(`${key}:${value.trim()}`);
    }
    return out;
  }
  const value = String(raw || "").trim();
  return value ? [value] : [];
}

function extractThreadActiveFlags(thread: Record<string, unknown>): string[] {
  const statusRaw = thread.status;
  const statusObject = statusRaw && typeof statusRaw === "object"
    ? (statusRaw as Record<string, unknown>)
    : {};
  return [
    ...collectStringList(thread.activeFlags),
    ...collectStringList(typeof statusRaw === "object" ? "" : statusRaw),
    ...collectStringList(statusObject.type),
    ...collectStringList(statusObject.status),
    ...collectStringList(statusObject.activeFlags),
    ...collectStringList(statusObject.flags),
  ];
}

function hasWaitingApprovalFlag(flags: string[]): boolean {
  return flags.some((flagRaw) => {
    const flag = String(flagRaw || "").trim().toLowerCase();
    return flag.includes("approval") && flag.includes("waiting");
  });
}

export function normalizeCodexThreadStatusType(rawStatus: unknown): CodexThreadStatusType {
  const statusObject = rawStatus && typeof rawStatus === "object"
    ? (rawStatus as Record<string, unknown>)
    : {};
  const value = String(
    (typeof rawStatus === "string" ? rawStatus : "") ||
    statusObject.type ||
    statusObject.status ||
    statusObject.state ||
    ""
  ).trim();
  if (value === "active" || value === "idle" || value === "notLoaded" || value === "systemError") {
    return value;
  }
  return "unknown";
}

export function normalizeCodexTurnStatus(rawStatus: unknown): string {
  return String(rawStatus || "").trim();
}

function getTurnStatus(turnRaw: unknown): string {
  const turn = turnRaw && typeof turnRaw === "object" ? (turnRaw as Record<string, unknown>) : {};
  return normalizeCodexTurnStatus(turn.status);
}

function getLatestTurnFromThread(thread: Record<string, unknown>): unknown | null {
  const turnsRaw = Array.isArray((thread as any)?.turns) ? (thread as any).turns : [];
  if (turnsRaw.length <= 0) return null;
  return turnsRaw[turnsRaw.length - 1] || null;
}

export function deriveCodexSessionStateFromSnapshot(
  threadRaw: unknown,
  latestTurnRaw?: unknown
): {
  sessionState: CodexSessionState;
  threadStatusType: CodexThreadStatusType;
  waitingOnApproval: boolean;
  latestTurnStatus: string;
} {
  const thread = threadRaw && typeof threadRaw === "object"
    ? (threadRaw as Record<string, unknown>)
    : {};
  const threadStatusType = normalizeCodexThreadStatusType(thread.status);
  const activeFlags = extractThreadActiveFlags(thread);
  const waitingOnApproval = hasWaitingApprovalFlag(activeFlags);
  const latestTurn = latestTurnRaw ?? getLatestTurnFromThread(thread);
  const latestTurnStatus = getTurnStatus(latestTurn);
  if (threadStatusType === "active") {
    return {
      sessionState: waitingOnApproval ? "waiting_on_approval" : "running",
      threadStatusType,
      waitingOnApproval,
      latestTurnStatus,
    };
  }
  if (threadStatusType === "systemError") {
    return {
      sessionState: "system_error",
      threadStatusType,
      waitingOnApproval,
      latestTurnStatus,
    };
  }
  if (threadStatusType === "idle" || threadStatusType === "notLoaded") {
    if (!latestTurn) {
      return {
        sessionState: "empty",
        threadStatusType,
        waitingOnApproval,
        latestTurnStatus,
      };
    }
    if (
      latestTurnStatus === "completed" ||
      latestTurnStatus === "interrupted" ||
      latestTurnStatus === "failed"
    ) {
      return {
        sessionState: latestTurnStatus,
        threadStatusType,
        waitingOnApproval,
        latestTurnStatus,
      };
    }
    return {
      sessionState: latestTurnStatus === "inProgress" || latestTurnStatus === "in_progress" ? "idle" : "unknown",
      threadStatusType,
      waitingOnApproval,
      latestTurnStatus,
    };
  }
  if (
    latestTurnStatus === "completed" ||
    latestTurnStatus === "interrupted" ||
    latestTurnStatus === "failed"
  ) {
    return {
      sessionState: latestTurnStatus,
      threadStatusType,
      waitingOnApproval,
      latestTurnStatus,
    };
  }
  return {
    sessionState: "unknown",
    threadStatusType,
    waitingOnApproval,
    latestTurnStatus,
  };
}

function formatRunningTurnStatus(turnStatus: string, activeFlags: string[]): string {
  const waitingApproval = hasWaitingApprovalFlag(activeFlags);
  const flagStatus = activeFlags.find((flag) => {
    const normalized = String(flag || "").trim().toLowerCase();
    return normalized.includes("approval") && normalized.includes("waiting");
  });
  if (!waitingApproval) return turnStatus;
  const approvalStatus = String(flagStatus || "waitingOnApproval").trim();
  return turnStatus ? `${turnStatus}:${approvalStatus}` : approvalStatus;
}

export function normalizeThreadReadEntry(
  rawThread: unknown,
  options?: { latestTurn?: unknown }
): CodexThreadReadResult {
  const thread = rawThread && typeof rawThread === "object"
    ? (rawThread as Record<string, unknown>)
    : {};
  const threadId = firstString(thread.id, thread.threadId);
  const sessionStatus = deriveCodexSessionStateFromSnapshot(thread, options?.latestTurn);
  const activeFlags = extractThreadActiveFlags(thread);
  const waitingApproval = hasWaitingApprovalFlag(activeFlags);
  const messages: CodexThreadMessage[] = [];
  let hasRunningTurn = false;
  let runningTurn: {
    status: string;
    summary: string;
    startedAt: string;
    updatedAt: string;
    updatedAtMs: number;
  } | null = null;
  const turnsRaw = Array.isArray((thread as any)?.turns) ? (thread as any).turns : [];
  for (const turn of turnsRaw) {
    const turnObject = turn && typeof turn === "object" ? (turn as Record<string, unknown>) : {};
    const turnStatus = String(turnObject.status || "").trim().toLowerCase();
    const startedAt = firstString(turnObject.startedAt, turnObject.createdAt);
    const completedAt = firstString(
      turnObject.completedAt,
      turnObject.updatedAt,
      turnObject.endedAt,
      turnObject.finishedAt
    );
    const terminalTurnStatus = isTerminalTurnStatus(turnStatus);
    const runningTurnDetected = sessionStatus.threadStatusType === "active" && (
      (turnStatus && !terminalTurnStatus) ||
      (!turnStatus && !!startedAt && !completedAt)
    );
    if (
      runningTurnDetected
    ) {
      hasRunningTurn = true;
    }
    const turnAt = toIsoTimestamp(
      firstString(
        turnObject.updatedAt,
        turnObject.createdAt,
        turnObject.completedAt,
        turnObject.startedAt,
        turnObject.at
      )
    );
    const items = (
      Array.isArray((turnObject as any)?.items)
        ? (turnObject as any).items
        : Array.isArray((turnObject as any)?.output)
          ? (turnObject as any).output
          : []
    ) as unknown[];
    let lastItemType = "";
    for (const itemRaw of items) {
      if (!itemRaw || typeof itemRaw !== "object") continue;
      const itemType = String((itemRaw as any)?.type || "").trim();
      if (itemType) lastItemType = itemType;
      const itemId = String((itemRaw as any)?.id || "").trim() || undefined;
      if (itemType === "userMessage") {
        const text = extractUserMessageText(itemRaw);
        if (!text) continue;
        messages.push({
          role: "user",
          content: text,
          at: turnAt,
          itemId,
        });
        continue;
      }
      if (itemType === "agentMessage") {
        const text = extractAgentMessageText(itemRaw);
        if (!text) continue;
        messages.push({
          role: "assistant",
          content: text,
          at: turnAt,
          itemId,
        });
        continue;
      }
      if (itemType === "commandExecution") {
        const command = extractCommandText((itemRaw as any)?.command);
        if (!command) continue;
        const status = String((itemRaw as any)?.status || "").trim().toLowerCase();
        const exitCodeRaw = Number((itemRaw as any)?.exitCode ?? (itemRaw as any)?.exit_code);
        messages.push({
          role: "assistant",
          content: "",
          at: turnAt,
          itemId,
          commandExecution: {
            command,
            status: status === "failed" || status === "declined" ? "failed" : "completed",
            exitCode: Number.isFinite(exitCodeRaw) ? exitCodeRaw : null,
          },
        });
      }
    }
    if (runningTurnDetected) {
      const runningUpdatedAt = turnAt || toIsoTimestamp(firstString(turnObject.updatedAt, turnObject.at));
      const runningUpdatedAtMs = parseIsoTimestampMs(runningUpdatedAt);
      const runningStatus = formatRunningTurnStatus(turnStatus, activeFlags);
      const runningCandidate = {
        status: runningStatus,
        summary: waitingApproval ? "承認待ちで停止中" : summarizeRunningTurn(turnStatus, lastItemType),
        startedAt: toIsoTimestamp(firstString(turnObject.startedAt, turnObject.createdAt)),
        updatedAt: runningUpdatedAt,
        updatedAtMs: runningUpdatedAtMs,
      };
      if (!runningTurn || runningCandidate.updatedAtMs >= runningTurn.updatedAtMs) {
        runningTurn = runningCandidate;
      }
    }
  }
  if (sessionStatus.waitingOnApproval && !runningTurn) {
    const runningUpdatedAt = toIsoTimestamp(thread.updatedAt || thread.createdAt);
    runningTurn = {
      status: formatRunningTurnStatus("", activeFlags),
      summary: "承認待ちで停止中",
      startedAt: toIsoTimestamp(thread.createdAt),
      updatedAt: runningUpdatedAt,
      updatedAtMs: parseIsoTimestampMs(runningUpdatedAt),
    };
  }
  if (sessionStatus.waitingOnApproval) {
    hasRunningTurn = true;
  }
  if (sessionStatus.sessionState !== "running" && sessionStatus.sessionState !== "waiting_on_approval") {
    hasRunningTurn = false;
    runningTurn = null;
  }

  let contextUsedPct = extractContextUsedPctFromUnknown(thread, firstString(thread.modelProvider, thread.provider));
  if (contextUsedPct === null) {
    for (let i = turnsRaw.length - 1; i >= 0; i -= 1) {
      const turnObject = turnsRaw[i] && typeof turnsRaw[i] === "object"
        ? (turnsRaw[i] as Record<string, unknown>)
        : null;
      if (!turnObject) continue;
      const next = extractContextUsedPctFromUnknown(
        turnObject,
        firstString(thread.modelProvider, thread.provider)
      );
      if (next !== null) {
        contextUsedPct = next;
        break;
      }
    }
  }

  return {
    threadId,
    preview: firstString(thread.preview, thread.title, thread.summary),
    modelProvider: firstString(thread.modelProvider, thread.provider),
    sourceKind: parseCodexSourceKind(
      firstString(thread.sourceKind, thread.source, thread.sessionStartSource)
    ),
    cwd: firstString(thread.cwd, thread.path),
    createdAt: toIsoTimestamp(thread.createdAt),
    updatedAt: toIsoTimestamp(thread.updatedAt || thread.createdAt),
    messages,
    contextUsedPct,
    sessionState: sessionStatus.sessionState,
    threadStatusType: sessionStatus.threadStatusType,
    waitingOnApproval: sessionStatus.waitingOnApproval,
    latestTurnStatus: sessionStatus.latestTurnStatus,
    hasRunningTurn,
    runningTurn: runningTurn
      ? {
        status: runningTurn.status,
        summary: runningTurn.summary,
        startedAt: runningTurn.startedAt,
        updatedAt: runningTurn.updatedAt,
      }
      : null,
  };
}

export function parseNotificationThreadId(paramsRaw: unknown): string {
  if (!paramsRaw || typeof paramsRaw !== "object") return "";
  const params = paramsRaw as Record<string, unknown>;
  return firstString(
    params.threadId,
    params.thread_id,
    params.sessionId,
    params.session_id,
    (params as any)?.thread?.id,
    (params as any)?.thread?.threadId,
    (params as any)?.thread?.thread_id,
    (params as any)?.turn?.threadId,
    (params as any)?.turn?.thread_id,
    (params as any)?.turn?.thread?.id
  );
}

export function isRpcMethodNotFoundError(error: unknown) {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("method not found") ||
    message.includes("unknown method") ||
    message.includes("not supported")
  );
}

export function isThreadNotFoundError(error: unknown) {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("thread not found");
}
