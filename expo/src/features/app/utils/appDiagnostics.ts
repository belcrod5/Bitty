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
