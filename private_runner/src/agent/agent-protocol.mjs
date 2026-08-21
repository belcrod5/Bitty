import { createHash } from "node:crypto";

export const AGENT_PROTOCOL_VERSION = 1;
export const AGENT_EVENT_TYPES = new Set([
  "turn.accepted",
  "session.resolved",
  "turn.started",
  "item.started",
  "content.delta",
  "item.completed",
  "tool.started",
  "tool.completed",
  "action.requested",
  "action.resolved",
  "usage.updated",
  "turn.completed",
  "turn.interrupted",
  "turn.failed",
  "provider.event",
]);
export const AGENT_TERMINAL_EVENT_TYPES = new Set([
  "turn.completed",
  "turn.interrupted",
  "turn.failed",
]);

const AGENT_ERROR_CODES = new Set([
  "backend_unavailable",
  "backend_version_unsupported",
  "authentication_required",
  "session_not_found",
  "session_cwd_mismatch",
  "session_busy",
  "turn_rejected",
  "turn_failed",
  "action_expired",
  "action_denied",
  "rate_limited",
  "timeout",
  "capability_unsupported",
  "history_unavailable",
  "history_cursor_invalid",
  "protocol_error",
  "output_limit_exceeded",
  "operation_conflict",
  "operation_status_unknown",
]);

export function agentError(code, message, options = {}) {
  const normalizedCode = AGENT_ERROR_CODES.has(code) ? code : "turn_failed";
  const error = new Error(String(message || normalizedCode));
  error.code = normalizedCode;
  error.backendId = String(options.backendId || "");
  error.retryable = options.retryable === true;
  return error;
}

export function serializeAgentError(error, backendId = "") {
  return {
    code: AGENT_ERROR_CODES.has(error?.code) ? error.code : "turn_failed",
    backendId: String(error?.backendId || backendId || ""),
    retryable: error?.retryable === true,
    message: String(error?.message || "Agent turn failed"),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function hashAgentOperationRequest(request) {
  return createHash("sha256").update(stableJson(request)).digest("hex");
}

function requiredString(value, name, maxLength = 512) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw agentError("turn_rejected", `${name} is required`);
  if (normalized.length > maxLength) throw agentError("turn_rejected", `${name} is too long`);
  return normalized;
}

function optionalString(value, name, maxLength = 512) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw agentError("turn_rejected", `${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw agentError("turn_rejected", `${name} is too long`);
  return normalized;
}

export function normalizeAgentSessionRef(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentError("turn_rejected", "sessionRef must be an object");
  }
  return {
    backendId: requiredString(value.backendId, "sessionRef.backendId", 64),
    nativeSessionId: requiredString(value.nativeSessionId, "sessionRef.nativeSessionId", 1024),
  };
}

export function normalizeAgentInput(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.blocks) || value.blocks.length === 0) {
    throw agentError("turn_rejected", "input.blocks must be a non-empty array");
  }
  if (value.blocks.length > 32) throw agentError("turn_rejected", "input has too many blocks");
  let totalTextLength = 0;
  const blocks = value.blocks.map((block, index) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      throw agentError("turn_rejected", `input.blocks[${index}] must be an object`);
    }
    if (block.type === "text") {
      const text = requiredString(block.text, `input.blocks[${index}].text`, 1024 * 1024);
      totalTextLength += text.length;
      return { type: "text", text };
    }
    if (block.type === "image") {
      return {
        type: "image",
        localRef: requiredString(block.localRef, `input.blocks[${index}].localRef`, 4096),
        ...(optionalString(block.mimeType, `input.blocks[${index}].mimeType`, 128)
          ? { mimeType: block.mimeType.trim() }
          : {}),
      };
    }
    throw agentError("turn_rejected", `input.blocks[${index}].type is unsupported`);
  });
  if (totalTextLength > 2 * 1024 * 1024) throw agentError("turn_rejected", "input text is too large");
  return { blocks };
}

export function normalizeAgentStartRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentError("turn_rejected", "turn.start payload must be an object");
  }
  const sessionRef = normalizeAgentSessionRef(value.sessionRef);
  const requestedBackendId = optionalString(value.backendId, "backendId", 64);
  if (sessionRef && requestedBackendId && requestedBackendId !== sessionRef.backendId) {
    throw agentError("turn_rejected", "backendId must match sessionRef.backendId");
  }
  const backendId = sessionRef?.backendId || requiredString(value.backendId, "backendId", 64);
  const cwd = optionalString(value.cwd, "cwd", 4096);
  if (!sessionRef && !cwd) throw agentError("turn_rejected", "cwd is required for a new session");
  return {
    backendId,
    sessionRef,
    cwd,
    input: normalizeAgentInput(value.input),
    model: optionalString(value.model, "model", 256),
    effort: optionalString(value.effort, "effort", 64),
    policyProfileId: optionalString(value.policyProfileId, "policyProfileId", 128),
    clientOperationId: requiredString(value.clientOperationId, "clientOperationId", 256),
  };
}

export function createAgentEvent({ type, runId, sessionRef, sequence, at, payload = {} }) {
  if (!AGENT_EVENT_TYPES.has(type)) throw agentError("protocol_error", `unknown agent event type: ${type}`);
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type,
    runId,
    ...(sessionRef ? { sessionRef } : {}),
    sequence,
    at,
    payload,
  };
}
