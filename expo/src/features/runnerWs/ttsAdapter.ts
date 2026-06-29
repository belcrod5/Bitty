import { isRunnerWsMessage, type RunnerWsMessage } from "./types";

export type RunnerWsTtsIncoming =
  | { type: "event"; event: Record<string, unknown>; streamId: string; seq?: number }
  | { type: "ignore" }
  | { type: "error"; message: string; event?: Record<string, unknown> };

export function encodeRunnerWsTtsStart(
  payload: Record<string, unknown>,
  options: { requestId?: string; operationId?: string; sessionId?: string; streamId?: string } = {}
): string {
  const envelope: RunnerWsMessage = {
    channel: "tts",
    op: "start",
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.operationId ? { operationId: options.operationId } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.streamId ? { streamId: options.streamId } : {}),
    payload,
  };
  return JSON.stringify(envelope);
}

export function encodeRunnerWsTtsAttach(streamIdRaw: unknown, sinceSeqRaw: unknown): string {
  const streamId = String(streamIdRaw || "").trim();
  const sinceSeq = Number.isFinite(Number(sinceSeqRaw))
    ? Math.max(0, Math.floor(Number(sinceSeqRaw)))
    : 0;
  const envelope: RunnerWsMessage = {
    channel: "tts",
    op: "attach",
    streamId,
    seq: sinceSeq,
    payload: {
      jobId: streamId,
      sinceSeq,
    },
  };
  return JSON.stringify(envelope);
}

export function encodeRunnerWsTtsApprovalDecision(
  streamIdRaw: unknown,
  payload: Record<string, unknown>
): string {
  const streamId = String(streamIdRaw || payload.jobId || "").trim();
  const requestId = String(payload.requestId || "").trim();
  const envelope: RunnerWsMessage = {
    channel: "tts",
    op: "tool_approval_decision",
    ...(requestId ? { requestId } : {}),
    ...(streamId ? { streamId } : {}),
    payload,
  };
  return JSON.stringify(envelope);
}

export function normalizeRunnerWsIncomingTtsEvent(rawData: string): RunnerWsTtsIncoming {
  const raw = String(rawData || "").trim();
  if (!raw) return { type: "ignore" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "ignore" };
  }
  if (!isRunnerWsMessage(parsed)) {
    return { type: "ignore" };
  }
  if (parsed.channel === "control" && parsed.op === "error") {
    const payload = parsed.payload && typeof parsed.payload === "object"
      ? parsed.payload as Record<string, unknown>
      : {};
    const code = String(payload.error || "runner_ws_error").trim();
    const detail = String(payload.message || payload.detail || "").trim();
    return {
      type: "error",
      message: detail ? `${code}: ${detail}` : code,
      event: {
        ...payload,
        type: "error",
      },
    };
  }
  if (parsed.channel !== "tts") {
    return { type: "ignore" };
  }
  const payload = parsed.payload && typeof parsed.payload === "object"
    ? parsed.payload as Record<string, unknown>
    : {};
  if (parsed.op === "error" || payload.type === "error") {
    const code = String(payload.error || "stream_tts_failed").trim();
    const detail = String(payload.message || payload.detail || "").trim();
    return {
      type: "error",
      message: detail ? `${code}: ${detail}` : code,
      event: payload,
    };
  }
  return {
    type: "event",
    event: payload,
    streamId: String(parsed.streamId || payload.jobId || ""),
    seq: typeof parsed.seq === "number" ? parsed.seq : undefined,
  };
}
