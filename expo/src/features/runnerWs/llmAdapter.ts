import { isRunnerWsMessage, type RunnerWsMessage } from "./types";

const RUNNER_WS_ENVELOPE_MAX_CHARS = 32 * 1024 * 1024; // 32MB

export type RunnerRelayControlMessage = {
  type: string;
  seq?: number;
  replayed?: number;
  latestSeq?: number;
  reason?: string;
};

export type RunnerWsIncomingCodexRpc =
  | { type: "rpc"; rawData: string }
  | { type: "ignore" }
  | { type: "error"; message: string };

export type RunnerWsLlmRpcAck = {
  phase: "received" | "forwarded" | "upstream_response";
  requestId: string;
  relayId: string;
  method: string;
  id: number | null;
  threadId: string;
  state: string;
};

export function isRunnerWsUrl(rawUrl: unknown): boolean {
  try {
    const url = new URL(String(rawUrl || "").trim());
    return url.pathname === "/runner-ws";
  } catch {
    return false;
  }
}

export function encodeRunnerWsLlmRpc(
  payload: Record<string, unknown>,
  threadIdRaw: unknown,
  options?: { requestId?: unknown; sessionId?: unknown }
): string {
  const threadId = String(threadIdRaw || "").trim();
  const requestId = String(options?.requestId || "").trim();
  const sessionId = String(options?.sessionId || "").trim();
  const envelope: RunnerWsMessage = {
    channel: "llm",
    op: "rpc",
    ...(requestId ? { requestId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(threadId ? { threadId } : {}),
    payload,
  };
  return JSON.stringify(envelope);
}

export function encodeRunnerWsRelayResume(threadIdRaw: unknown, lastSeqRaw: unknown): string {
  const threadId = String(threadIdRaw || "").trim();
  const lastSeq = Number.isFinite(Number(lastSeqRaw))
    ? Math.max(0, Math.floor(Number(lastSeqRaw)))
    : 0;
  const envelope: RunnerWsMessage = {
    channel: "relay",
    op: "resume",
    threadId,
    seq: lastSeq,
  };
  return JSON.stringify(envelope);
}

export function parseRunnerWsEnvelope(rawData: string): RunnerWsMessage | null {
  const raw = String(rawData || "").trim();
  if (!raw || raw.length > RUNNER_WS_ENVELOPE_MAX_CHARS) return null;
  try {
    const payload = JSON.parse(raw);
    return isRunnerWsMessage(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function parseRunnerWsRelayControlMessage(rawData: string): RunnerRelayControlMessage | null {
  const message = parseRunnerWsEnvelope(rawData);
  if (!message || message.channel !== "relay") return null;
  const payload = message.payload && typeof message.payload === "object"
    ? message.payload as Record<string, unknown>
    : {};
  const seq = Number(message.seq);
  const replayed = Number(payload.replayed);
  const latestSeq = Number(payload.latestSeq ?? message.seq);
  if (message.op === "seq") {
    return {
      type: "runner_relay_seq",
      seq: Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : undefined,
    };
  }
  if (message.op === "attached") {
    return {
      type: "runner_relay_attached",
      seq: Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : undefined,
      replayed: Number.isFinite(replayed) ? Math.max(0, Math.floor(replayed)) : undefined,
      latestSeq: Number.isFinite(latestSeq) ? Math.max(0, Math.floor(latestSeq)) : undefined,
    };
  }
  if (message.op === "resume_miss") {
    const reason = String(payload.reason || payload.message || "").trim();
    return {
      type: "runner_relay_resume_miss",
      seq: Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : undefined,
      reason: reason || undefined,
    };
  }
  if (message.op === "closed") {
    const reason = String(payload.reason || "").trim();
    return {
      type: "runner_relay_closed",
      reason: reason || undefined,
    };
  }
  return null;
}

export function normalizeRunnerWsIncomingCodexRpc(rawData: string): RunnerWsIncomingCodexRpc {
  const message = parseRunnerWsEnvelope(rawData);
  if (!message) return { type: "rpc", rawData };
  if (message.channel === "llm" && message.op === "rpc") {
    const payload = message.payload;
    if (typeof payload === "string") {
      const trimmed = payload.trim();
      return trimmed ? { type: "rpc", rawData: trimmed } : { type: "ignore" };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { type: "error", message: "runner-ws llm:rpc payload is not a JSON-RPC object" };
    }
    try {
      return { type: "rpc", rawData: JSON.stringify(payload) };
    } catch {
      return { type: "error", message: "runner-ws llm:rpc payload is not serializable" };
    }
  }
  if (message.channel === "control" && message.op === "error") {
    const payload = message.payload && typeof message.payload === "object"
      ? message.payload as Record<string, unknown>
      : {};
    const code = String(payload.error || "runner_ws_error").trim();
    const detail = String(payload.message || payload.detail || "").trim();
    return { type: "error", message: detail ? `${code}: ${detail}` : code };
  }
  return { type: "ignore" };
}

export function parseRunnerWsLlmRpcAck(rawData: string): RunnerWsLlmRpcAck | null {
  const message = parseRunnerWsEnvelope(rawData);
  if (!message || message.channel !== "control") return null;
  const phase = (
    message.op === "llm_rpc_received"
      ? "received"
      : message.op === "llm_rpc_forwarded"
        ? "forwarded"
        : message.op === "llm_rpc_upstream_response"
          ? "upstream_response"
          : ""
  ) as RunnerWsLlmRpcAck["phase"] | "";
  if (!phase) return null;
  const payload = message.payload && typeof message.payload === "object"
    ? message.payload as Record<string, unknown>
    : {};
  const requestId = String(message.requestId || payload.requestId || "").trim();
  if (!requestId) return null;
  const idRaw = Number(payload.id);
  return {
    phase,
    requestId,
    relayId: String(payload.relayId || "").trim(),
    method: String(payload.method || "").trim(),
    id: Number.isFinite(idRaw) ? Math.floor(idRaw) : null,
    threadId: String(message.threadId || payload.threadId || "").trim(),
    state: String(payload.state || "").trim(),
  };
}
