type SessionDiagLogOptions = {
  detailed?: boolean;
  throttleMs?: number;
  throttleKey?: string;
};

type SessionDiagLogger = (
  event: string,
  payload?: Record<string, unknown>,
  options?: SessionDiagLogOptions
) => void;

const TTS_DIAGNOSTIC_ERROR_CODES = new Set([
  "audio_history_missing", "job_id_missing", "missing_audio_url", "stream_tts_failed",
  "runner_token_required", "runner_ws_stopped", "runner_ws_auth_failed",
  "runner_ws_closed_before_ready", "runner_ws_message_too_large",
  "tts_key_missing", "tts_provider_invalid", "tts_failed",
]);

export function ttsDiagnosticError(error: unknown) {
  const record = error && typeof error === "object" ? error as { code?: unknown; name?: unknown } : null;
  const code = String(record?.code || "");
  if (TTS_DIAGNOSTIC_ERROR_CODES.has(code)) return code;
  const message = (error instanceof Error ? error.message : String(error)).trim();
  if (TTS_DIAGNOSTIC_ERROR_CODES.has(message)) return message;
  const httpStatus = message.match(/^HTTP\s+([1-5][0-9]{2})$/);
  if (httpStatus) return `HTTP_${httpStatus[1]}`;
  const name = String(record?.name || "");
  return /^(?:Error|TypeError|RangeError|AbortError|TimeoutError|NetworkError)$/.test(name)
    ? name
    : "unknown_error";
}

export function elapsedSinceMsValue(startedAtMs: number) {
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  return Math.max(0, Date.now() - startedAtMs);
}

export function logSessionDiagEvent(args: {
  event: string;
  payload?: Record<string, unknown>;
  options?: SessionDiagLogOptions;
  sessionDiagDetailEventsEnabled: boolean;
  sessionDiagEventThrottleDefaultMs: number;
  sessionDiagEventLastAtByKey: Record<string, number>;
  enqueueLog: (event: string, payload: Record<string, unknown>) => void;
}) {
  const {
    event,
    payload = {},
    options,
    sessionDiagDetailEventsEnabled,
    sessionDiagEventThrottleDefaultMs,
    sessionDiagEventLastAtByKey,
    enqueueLog,
  } = args;
  const eventName = String(event || "").trim();
  if (!eventName) return;
  if (options?.detailed && !sessionDiagDetailEventsEnabled) return;
  const throttleMsRaw = Number(options?.throttleMs);
  const throttleMs = Number.isFinite(throttleMsRaw)
    ? Math.max(0, Math.floor(throttleMsRaw))
    : sessionDiagEventThrottleDefaultMs;
  const throttleKeyRaw = String(options?.throttleKey || eventName).trim() || eventName;
  if (throttleMs > 0) {
    const now = Date.now();
    const lastAt = Number(sessionDiagEventLastAtByKey[throttleKeyRaw] || 0);
    if (lastAt > 0 && now - lastAt < throttleMs) return;
    sessionDiagEventLastAtByKey[throttleKeyRaw] = now;
  }
  enqueueLog(eventName, payload);
}

export function logChatScrollDiagEvent(args: {
  chatScrollDiagEnabled: boolean;
  event: string;
  payload?: Record<string, unknown>;
  options?: { throttleMs?: number; throttleKey?: string };
  logSessionDiag: SessionDiagLogger;
}) {
  const {
    chatScrollDiagEnabled,
    event,
    payload = {},
    options,
    logSessionDiag,
  } = args;
  if (!chatScrollDiagEnabled) return;
  const eventName = String(event || "").trim();
  if (!eventName) return;
  logSessionDiag(`chat_scroll_${eventName}`, payload, {
    throttleMs: Number.isFinite(Number(options?.throttleMs))
      ? Math.max(0, Math.floor(Number(options?.throttleMs)))
      : 0,
    throttleKey: options?.throttleKey || `chat_scroll_${eventName}`,
  });
}

export function logAutoEvent(args: {
  event: string;
  payload?: Record<string, unknown>;
  autoDiagnosticsEnabled: boolean;
  autoDiagnosticCriticalEvents: Set<string>;
  enqueueLog: (event: string, payload: Record<string, unknown>) => void;
}) {
  const {
    event,
    payload = {},
    autoDiagnosticsEnabled,
    autoDiagnosticCriticalEvents,
    enqueueLog,
  } = args;
  const eventName = String(event || "").trim() || "unknown";
  if (!autoDiagnosticsEnabled && !autoDiagnosticCriticalEvents.has(eventName)) return;
  console.log("[auto]", eventName, payload);
  enqueueLog(eventName, payload);
}
