import { createWebSocketWithOptionalAuth } from "../ws/webSocketAuth";
import type { WebSocketCloudflareAccess } from "../ws/webSocketAuth";

export type StreamingSttUsage = {
  usedSeconds: number;
  limitSeconds: number;
  remainingSeconds: number;
  monthUtc: string;
  resetAt: string;
};

export type StreamingSttServerMessage =
  | { type: "ready" }
  | { type: "transcript"; text: string; isFinal: boolean; stability?: number }
  | { type: "speech_activity_begin" | "speech_activity_end" }
  | ({ type: "usage" } & StreamingSttUsage)
  | {
      type: "done";
      reason: "user_stop" | "speech_end_timeout" | "no_speech_timeout" | "limit_reached" | "max_duration";
      hasSpeech: boolean;
      usage?: StreamingSttUsage;
    }
  | { type: "error"; code: string; message: string; retryable: boolean };

export const MAX_STT_WEBSOCKET_BUFFERED_BYTES = 256 * 1024;

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

export function streamSttUrl(runnerUrl: string) {
  const url = new URL(String(runnerUrl || "").trim());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/stream-stt";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function openStreamingSttSocket(
  runnerUrl: string,
  token: string,
  cloudflareAccess?: WebSocketCloudflareAccess
) {
  const socket = createWebSocketWithOptionalAuth(streamSttUrl(runnerUrl), token, cloudflareAccess);
  socket.binaryType = "arraybuffer";
  return socket;
}

export function parseStreamingSttMessage(raw: unknown): StreamingSttServerMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const type = String(value.type || "");
    if (type === "ready" || type === "speech_activity_begin" || type === "speech_activity_end") {
      if (!hasOnlyKeys(value, ["type"])) return null;
      return { type } as StreamingSttServerMessage;
    }
    if (type === "transcript") {
      if (
        !hasOnlyKeys(value, ["type", "text", "isFinal", "stability"])
        || typeof value.text !== "string"
        || typeof value.isFinal !== "boolean"
        || (typeof value.stability !== "undefined" && typeof value.stability !== "number")
      ) return null;
      return {
        type,
        text: value.text,
        isFinal: value.isFinal,
        stability: typeof value.stability === "number" ? value.stability : undefined,
      };
    }
    if (type === "usage") {
      if (!hasOnlyKeys(value, ["type", "usedSeconds", "limitSeconds", "remainingSeconds", "monthUtc", "resetAt"])) return null;
      const usage = parseUsage(value);
      return usage ? { type, ...usage } : null;
    }
    if (type === "done") {
      const reason = String(value.reason || "");
      if (!hasOnlyKeys(value, ["type", "reason", "hasSpeech", "usage"])) return null;
      const usage = value.usage === undefined ? undefined : parseUsage(value.usage);
      if (
        !["user_stop", "speech_end_timeout", "no_speech_timeout", "limit_reached", "max_duration"].includes(reason)
        || typeof value.hasSpeech !== "boolean"
        || usage === null
      ) return null;
      return { type, reason, hasSpeech: value.hasSpeech, ...(usage ? { usage } : {}) } as StreamingSttServerMessage;
    }
    if (type === "error") {
      if (
        !hasOnlyKeys(value, ["type", "code", "message", "retryable"])
        ||
        typeof value.code !== "string"
        || typeof value.message !== "string"
        || typeof value.retryable !== "boolean"
      ) return null;
      return {
        type,
        code: value.code,
        message: value.message,
        retryable: value.retryable,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function parseUsage(raw: unknown): StreamingSttUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!hasOnlyKeys(value, ["usedSeconds", "limitSeconds", "remainingSeconds", "monthUtc", "resetAt", "type"])) return null;
  const { usedSeconds, limitSeconds, remainingSeconds, monthUtc, resetAt } = value;
  if (
    typeof usedSeconds !== "number" || !Number.isFinite(usedSeconds)
    || typeof limitSeconds !== "number" || !Number.isFinite(limitSeconds)
    || typeof remainingSeconds !== "number" || !Number.isFinite(remainingSeconds)
    || typeof monthUtc !== "string" || !/^\d{4}-\d{2}$/.test(monthUtc)
    || typeof resetAt !== "string" || !Number.isFinite(Date.parse(resetAt))
  ) return null;
  return { usedSeconds, limitSeconds, remainingSeconds, monthUtc, resetAt };
}

export function sendPcm(socket: WebSocket, pcm: Uint8Array) {
  if (socket.bufferedAmount + pcm.byteLength > MAX_STT_WEBSOCKET_BUFFERED_BYTES) {
    throw new Error("backpressure_exceeded");
  }
  const exact = pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
    ? pcm.buffer
    : pcm.slice().buffer;
  socket.send(exact as ArrayBuffer);
}

export function pcmRms(pcm: Uint8Array) {
  const sampleCount = Math.floor(pcm.byteLength / 2);
  if (sampleCount === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, sampleCount * 2);
  let squares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true) / 32768;
    squares += sample * sample;
  }
  return Math.min(1, Math.sqrt(squares / sampleCount));
}
