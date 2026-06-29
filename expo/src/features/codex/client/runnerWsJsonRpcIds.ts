import type { JsonRpcId } from "./types";

const MAX_SAFE_WIRE_ID = 9_000_000_000_000_000;
let nextRunnerWsJsonRpcWireId = Math.max(1000, Math.floor(Date.now() * 1000));

function nextWireId() {
  nextRunnerWsJsonRpcWireId += 1;
  if (nextRunnerWsJsonRpcWireId >= MAX_SAFE_WIRE_ID) {
    nextRunnerWsJsonRpcWireId = 1000;
  }
  return nextRunnerWsJsonRpcWireId;
}

function readIntegerId(value: unknown): JsonRpcId | null {
  const id = Number(value);
  return Number.isInteger(id) ? id : null;
}

export function createCodexRunnerWsLogicalId(prefix: string, traceIdRaw: string) {
  const traceId = String(traceIdRaw || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const nowPart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 10);
  return [prefix, traceId, nowPart, randomPart].filter(Boolean).join("_");
}

export function buildCodexRunnerWsRequestId(baseRaw: string, sequenceRaw: number, methodRaw: string, idRaw: number) {
  const base = String(baseRaw || "").trim();
  const sequence = Math.max(0, Math.floor(Number(sequenceRaw) || 0));
  const idPart = Number.isFinite(idRaw) ? `id${Math.floor(idRaw)}` : "idn";
  const methodPart = String(methodRaw || "").trim().replace(/[^a-zA-Z0-9/_-]/g, "_") || "method";
  return `${base}:${sequence}:${methodPart}:${idPart}`;
}

export class CodexRunnerWsJsonRpcIdMapper {
  private readonly localIdByWireId = new Map<JsonRpcId, JsonRpcId>();

  rewriteOutbound(payload: Record<string, unknown>): Record<string, unknown> {
    if (typeof payload.method !== "string") return payload;
    if (!Object.prototype.hasOwnProperty.call(payload, "id")) return payload;
    const localId = readIntegerId(payload.id);
    if (localId === null) return payload;
    const wireId = nextWireId();
    this.localIdByWireId.set(wireId, localId);
    return {
      ...payload,
      id: wireId,
    };
  }

  rewriteIncoming(message: Record<string, unknown>): Record<string, unknown> {
    if (typeof message.method === "string") return message;
    if (!Object.prototype.hasOwnProperty.call(message, "id")) return message;
    const wireId = readIntegerId(message.id);
    if (wireId === null) return message;
    const localId = this.localIdByWireId.get(wireId);
    if (typeof localId === "undefined") return message;
    if (
      Object.prototype.hasOwnProperty.call(message, "result") ||
      Object.prototype.hasOwnProperty.call(message, "error")
    ) {
      this.localIdByWireId.delete(wireId);
    }
    return {
      ...message,
      id: localId,
    };
  }

  clear() {
    this.localIdByWireId.clear();
  }
}
