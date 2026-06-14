export type RunnerWsChannel = "llm" | "tts" | "relay" | "control";

export type RunnerWsMessage = {
  channel: RunnerWsChannel;
  op: string;
  requestId?: string;
  sessionId?: string;
  threadId?: string;
  streamId?: string;
  seq?: number;
  payload?: unknown;
};

export type RunnerWsMessageFilter = {
  channel?: RunnerWsChannel;
  op?: string;
  requestId?: string;
  sessionId?: string;
  threadId?: string;
  streamId?: string;
};

export type RunnerWsConnectionSnapshot = {
  url: string;
  readyState: number;
  connected: boolean;
  reconnectCount: number;
  lastError?: string;
  openedAtMs?: number;
  lastMessageAtMs?: number;
  lastCloseAtMs?: number;
  sentCount?: number;
  receivedCount?: number;
  sendErrorCount?: number;
  closeCount?: number;
  errorCount?: number;
  missedPingCount?: number;
  consecutiveMissedPingCount?: number;
  lastPingRttMs?: number;
  bufferedAmount?: number;
  serverStatus?: RunnerWsServerStatus;
};

export type RunnerWsServerStatus = {
  runnerWsConnectionCount?: number;
  activeRelayCount?: number;
  relayClientCount?: number;
  upstreamOpen?: boolean;
  upstreamReadyState?: number;
  upstreamQueueCount?: number;
  lastSeq?: number;
  pendingRpcCount?: number;
  pendingApprovalCount?: number;
  codexQueuedTurnCount?: number;
  codexRunningQueuedTurnCount?: number;
  codexCompactRunningCount?: number;
  turnState?: string;
  lastEventAtMs?: number;
};

export function normalizeRunnerWsServerStatus(value: unknown): RunnerWsServerStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const readNumber = (key: string) => {
    if (raw[key] === undefined || raw[key] === null || raw[key] === "") return undefined;
    const numeric = Number(raw[key]);
    return Number.isFinite(numeric) ? numeric : undefined;
  };
  const readBoolean = (key: string) => {
    return typeof raw[key] === "boolean" ? Boolean(raw[key]) : undefined;
  };
  const readString = (key: string) => {
    const text = String(raw[key] || "").trim();
    return text || undefined;
  };
  return {
    runnerWsConnectionCount: readNumber("runnerWsConnectionCount"),
    activeRelayCount: readNumber("activeRelayCount"),
    relayClientCount: readNumber("relayClientCount"),
    upstreamOpen: readBoolean("upstreamOpen"),
    upstreamReadyState: readNumber("upstreamReadyState"),
    upstreamQueueCount: readNumber("upstreamQueueCount"),
    lastSeq: readNumber("lastSeq"),
    pendingRpcCount: readNumber("pendingRpcCount"),
    pendingApprovalCount: readNumber("pendingApprovalCount"),
    codexQueuedTurnCount: readNumber("codexQueuedTurnCount"),
    codexRunningQueuedTurnCount: readNumber("codexRunningQueuedTurnCount"),
    codexCompactRunningCount: readNumber("codexCompactRunningCount"),
    turnState: readString("turnState"),
    lastEventAtMs: readNumber("lastEventAtMs"),
  };
}

export function isRunnerWsChannel(value: unknown): value is RunnerWsChannel {
  return value === "llm" || value === "tts" || value === "relay" || value === "control";
}

export function isRunnerWsMessage(value: unknown): value is RunnerWsMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (!isRunnerWsChannel(message.channel)) return false;
  if (typeof message.op !== "string" || !message.op.trim()) return false;
  for (const key of ["requestId", "sessionId", "threadId", "streamId"] as const) {
    const item = message[key];
    if (item !== undefined && typeof item !== "string") return false;
  }
  if (message.seq !== undefined) {
    if (typeof message.seq !== "number") return false;
    if (!Number.isFinite(message.seq) || message.seq < 0 || Math.floor(message.seq) !== message.seq) {
      return false;
    }
  }
  return true;
}
