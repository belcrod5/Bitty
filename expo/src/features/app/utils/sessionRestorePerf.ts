import type { LlmSessionSource } from "../hooks/useLlmSessionExplorer";

type SessionDiagLogger = (
  event: string,
  payload?: Record<string, unknown>,
  options?: {
    detailed?: boolean;
    throttleMs?: number;
    throttleKey?: string;
  }
) => void;

type MarkSessionReadAsyncArgs = {
  sessionId: string;
  directory: string;
  source?: LlmSessionSource;
  perfTraceId: string;
  restoreRequestSeq: number;
};

export type SessionRestorePerfContext = {
  traceId: string;
  clickedAtMs: number;
  entrypoint: string;
  enabled: boolean;
  threadReadStartedAt: number;
  threadReadDoneAt: number;
  messageHydratedAt: number;
  stateApplyQueuedAt: number;
  markReadDoneAt: number;
};

type LogSessionRestoreBaseArgs = {
  logSessionDiag: SessionDiagLogger;
  restoreRequestSeq: number;
  source: string;
  directory: string;
  targetSessionId: string;
  restoreStartedAt: number;
  perf: SessionRestorePerfContext;
};

type LogSessionRestoreDoneArgs = LogSessionRestoreBaseArgs & {
  resolvedSessionId: string;
  restoredMessageCount: number;
  hasRunningTurn: boolean;
  hasPendingAssistant: boolean;
  codexRelayAttached: boolean;
  restoredInFlight: boolean;
};

type LogSessionRestoreErrorArgs = LogSessionRestoreBaseArgs & {
  message: string;
};

export function createSessionRestorePerfContext(): SessionRestorePerfContext {
  return {
    traceId: "",
    clickedAtMs: 0,
    entrypoint: "",
    enabled: false,
    threadReadStartedAt: 0,
    threadReadDoneAt: 0,
    messageHydratedAt: 0,
    stateApplyQueuedAt: 0,
    markReadDoneAt: 0,
  };
}

export function logSessionRestoreStart({
  logSessionDiag,
  restoreRequestSeq,
  source,
  directory,
  targetSessionId,
  restoreStartedAt,
  fromSessionId,
  perf,
}: LogSessionRestoreBaseArgs & { fromSessionId?: string }) {
  logSessionDiag("session_restore_start", {
    restoreRequestSeq,
    source,
    directory,
    fromSessionId: fromSessionId || undefined,
    targetSessionId,
  }, {
    throttleMs: 0,
    throttleKey: `session_restore_start:${targetSessionId}`,
  });
  if (!perf.enabled) return;
  logSessionDiag("session_open_perf_restore_start", {
    traceId: perf.traceId,
    entrypoint: perf.entrypoint || undefined,
    restoreRequestSeq,
    source,
    directory,
    targetSessionId,
    elapsedMsFromClick: Math.max(0, restoreStartedAt - perf.clickedAtMs),
  }, {
    throttleMs: 0,
    throttleKey: `session_open_perf_restore_start:${perf.traceId}`,
  });
}

export function markSessionRestoreThreadReadStarted(perf: SessionRestorePerfContext) {
  perf.threadReadStartedAt = Date.now();
}

export function logSessionRestoreThreadReadDone({
  logSessionDiag,
  perf,
  restoreStartedAt,
  targetSessionId,
}: {
  logSessionDiag: SessionDiagLogger;
  perf: SessionRestorePerfContext;
  restoreStartedAt: number;
  targetSessionId: string;
}) {
  perf.threadReadDoneAt = Date.now();
  if (!perf.enabled) return;
  logSessionDiag("session_open_perf_thread_read_done", {
    traceId: perf.traceId,
    targetSessionId,
    elapsedMsFromClick: Math.max(0, perf.threadReadDoneAt - perf.clickedAtMs),
    elapsedMsFromRestoreStart: Math.max(0, perf.threadReadDoneAt - restoreStartedAt),
    threadReadElapsedMs: Math.max(0, perf.threadReadDoneAt - perf.threadReadStartedAt),
  }, {
    detailed: true,
    throttleMs: 0,
    throttleKey: `session_open_perf_thread_read_done:${perf.traceId}`,
  });
}

export function logSessionRestoreMessagesHydrated({
  logSessionDiag,
  perf,
  restoreStartedAt,
  targetSessionId,
  restoredMessageCount,
}: {
  logSessionDiag: SessionDiagLogger;
  perf: SessionRestorePerfContext;
  restoreStartedAt: number;
  targetSessionId: string;
  restoredMessageCount: number;
}) {
  perf.messageHydratedAt = Date.now();
  if (!perf.enabled) return;
  logSessionDiag("session_open_perf_messages_hydrated", {
    traceId: perf.traceId,
    targetSessionId,
    restoredMessageCount,
    elapsedMsFromClick: Math.max(0, perf.messageHydratedAt - perf.clickedAtMs),
    elapsedMsFromRestoreStart: Math.max(0, perf.messageHydratedAt - restoreStartedAt),
    hydrateElapsedMs: Math.max(0, perf.messageHydratedAt - perf.threadReadDoneAt),
  }, {
    detailed: true,
    throttleMs: 0,
    throttleKey: `session_open_perf_messages_hydrated:${perf.traceId}`,
  });
}

export function logSessionRestoreStateApplyQueued({
  logSessionDiag,
  perf,
  restoreStartedAt,
  targetSessionId,
}: {
  logSessionDiag: SessionDiagLogger;
  perf: SessionRestorePerfContext;
  restoreStartedAt: number;
  targetSessionId: string;
}) {
  perf.stateApplyQueuedAt = Date.now();
  if (!perf.enabled) return;
  logSessionDiag("session_open_perf_state_apply_queued", {
    traceId: perf.traceId,
    targetSessionId,
    elapsedMsFromClick: Math.max(0, perf.stateApplyQueuedAt - perf.clickedAtMs),
    elapsedMsFromRestoreStart: Math.max(0, perf.stateApplyQueuedAt - restoreStartedAt),
    stateApplyQueueElapsedMs: Math.max(0, perf.stateApplyQueuedAt - perf.messageHydratedAt),
  }, {
    detailed: true,
    throttleMs: 0,
    throttleKey: `session_open_perf_state_apply_queued:${perf.traceId}`,
  });
}

export function markSessionRestoreReadDone(perf: SessionRestorePerfContext) {
  perf.markReadDoneAt = Date.now();
}

export function logSessionRestoreDone({
  logSessionDiag,
  restoreRequestSeq,
  source,
  directory,
  targetSessionId,
  restoreStartedAt,
  resolvedSessionId,
  restoredMessageCount,
  hasRunningTurn,
  hasPendingAssistant,
  codexRelayAttached,
  restoredInFlight,
  perf,
}: LogSessionRestoreDoneArgs) {
  logSessionDiag("session_restore_done", {
    restoreRequestSeq,
    directory,
    elapsedMs: Math.max(0, Date.now() - restoreStartedAt),
    targetSessionId,
    resolvedThreadId: resolvedSessionId,
    restoredMessageCount,
    hasRunningTurn,
    hasPendingAssistant,
    codexRelayAttached,
    restoredInFlight,
  }, {
    throttleMs: 0,
    throttleKey: `session_restore_done:${resolvedSessionId}`,
  });
  if (!perf.enabled) return;
  const doneAt = Date.now();
  const threadReadStartedAt = perf.threadReadStartedAt || restoreStartedAt;
  const threadReadDoneAt = perf.threadReadDoneAt || threadReadStartedAt;
  const messageHydratedAt = perf.messageHydratedAt || threadReadDoneAt;
  const stateApplyQueuedAt = perf.stateApplyQueuedAt || messageHydratedAt;
  const markReadDoneAt = perf.markReadDoneAt || doneAt;
  logSessionDiag("session_open_perf_restore_done", {
    traceId: perf.traceId,
    entrypoint: perf.entrypoint || undefined,
    source,
    directory,
    targetSessionId,
    resolvedSessionId,
    elapsedMsFromClick: Math.max(0, doneAt - perf.clickedAtMs),
    elapsedMsFromRestoreStart: Math.max(0, doneAt - restoreStartedAt),
    threadReadElapsedMs: Math.max(0, threadReadDoneAt - threadReadStartedAt),
    hydrateElapsedMs: Math.max(0, messageHydratedAt - threadReadDoneAt),
    stateApplyQueueElapsedMs: Math.max(0, stateApplyQueuedAt - messageHydratedAt),
    markReadElapsedMs: Math.max(0, markReadDoneAt - stateApplyQueuedAt),
    postMarkReadElapsedMs: Math.max(0, doneAt - markReadDoneAt),
    markReadAsyncPending: true,
    restoredMessageCount,
    hasRunningTurn,
    hasPendingAssistant,
  }, {
    throttleMs: 0,
    throttleKey: `session_open_perf_restore_done:${perf.traceId}`,
  });
}

export function logSessionRestoreError({
  logSessionDiag,
  restoreRequestSeq,
  source,
  directory,
  targetSessionId,
  restoreStartedAt,
  message,
  perf,
}: LogSessionRestoreErrorArgs) {
  logSessionDiag("session_restore_error", {
    restoreRequestSeq,
    directory,
    elapsedMs: Math.max(0, Date.now() - restoreStartedAt),
    targetSessionId,
    message,
  }, {
    throttleMs: 0,
    throttleKey: `session_restore_error:${targetSessionId}`,
  });
  if (!perf.enabled) return;
  logSessionDiag("session_open_perf_restore_error", {
    traceId: perf.traceId,
    entrypoint: perf.entrypoint || undefined,
    source,
    directory,
    targetSessionId,
    message,
    elapsedMsFromClick: Math.max(0, Date.now() - perf.clickedAtMs),
    elapsedMsFromRestoreStart: Math.max(0, Date.now() - restoreStartedAt),
  }, {
    throttleMs: 0,
    throttleKey: `session_open_perf_restore_error:${perf.traceId}`,
  });
}

export function finalizeSessionRestoreReadAndLog({
  markSessionReadAsync,
  resolvedSessionId,
  directory,
  source,
  perf,
  restoreRequestSeq,
  logSessionDiag,
  targetSessionId,
  restoreStartedAt,
  restoredMessageCount,
  hasRunningTurn,
  hasPendingAssistant,
  codexRelayAttached,
  restoredInFlight,
}: {
  markSessionReadAsync: (args: MarkSessionReadAsyncArgs) => void;
  resolvedSessionId: string;
  directory: string;
  source?: LlmSessionSource;
  perf: SessionRestorePerfContext;
  restoreRequestSeq: number;
  logSessionDiag: SessionDiagLogger;
  targetSessionId: string;
  restoreStartedAt: number;
  restoredMessageCount: number;
  hasRunningTurn: boolean;
  hasPendingAssistant: boolean;
  codexRelayAttached: boolean;
  restoredInFlight: boolean;
}) {
  markSessionReadAsync({
    sessionId: resolvedSessionId,
    directory,
    source,
    perfTraceId: perf.traceId,
    restoreRequestSeq,
  });
  markSessionRestoreReadDone(perf);
  logSessionRestoreDone({
    logSessionDiag,
    restoreRequestSeq,
    source: String(source || "unknown"),
    directory,
    targetSessionId,
    restoreStartedAt,
    resolvedSessionId,
    restoredMessageCount,
    hasRunningTurn,
    hasPendingAssistant,
    codexRelayAttached,
    restoredInFlight,
    perf,
  });
}
