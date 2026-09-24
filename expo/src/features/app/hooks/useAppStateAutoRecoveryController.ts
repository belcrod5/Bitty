import { useEffect, useRef, type MutableRefObject } from "react";
import { AppState, type AppStateStatus } from "react-native";
import type { StreamTtsControlState } from "../types/appTypes";

type Args = {
  appStateRef: MutableRefObject<AppStateStatus>;
  appStateChangedAtRef: MutableRefObject<number>;
  appStateLastNonActiveAtRef: MutableRefObject<number>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  replyLoadingRef: MutableRefObject<boolean>;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
  logSessionDiag: (event: string, payload?: Record<string, unknown>, options?: {
    throttleMs?: number;
    throttleKey?: string;
    detailed?: boolean;
  }) => void;
  recoverTtsStreamAfterResume: (reason: string) => void;
  flushAutoClientLogs: () => void;
  flushSessionDiagClientLogs: () => void;
  appResumeStreamRecoveryNonActiveMinMs: number;
};

export function useAppStateAutoRecoveryController({
  appStateRef,
  appStateChangedAtRef,
  appStateLastNonActiveAtRef,
  streamSocketRef,
  streamTtsControlRef,
  replyLoadingRef,
  logAuto,
  logSessionDiag,
  recoverTtsStreamAfterResume,
  flushAutoClientLogs,
  flushSessionDiagClientLogs,
  appResumeStreamRecoveryNonActiveMinMs,
}: Args) {
  const callbacksRef = useRef({
    logAuto,
    logSessionDiag,
    recoverTtsStreamAfterResume,
    flushAutoClientLogs,
    flushSessionDiagClientLogs,
  });
  callbacksRef.current = {
    logAuto,
    logSessionDiag,
    recoverTtsStreamAfterResume,
    flushAutoClientLogs,
    flushSessionDiagClientLogs,
  };
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      const now = Date.now();
      const prevState = appStateRef.current;
      const sinceLastNonActiveMs = appStateLastNonActiveAtRef.current > 0
        ? Math.max(0, now - appStateLastNonActiveAtRef.current)
        : null;
      appStateRef.current = nextState;
      appStateChangedAtRef.current = now;
      appStateLastNonActiveAtRef.current = nextState === "active" ? 0 : now;
      const callbacks = callbacksRef.current;
      callbacks.logAuto("app_state_changed", { from: prevState, to: nextState, sinceLastNonActiveMs });
      callbacks.logSessionDiag("app_state_changed", { from: prevState, to: nextState, sinceLastNonActiveMs }, {
        throttleMs: 0,
        throttleKey: `app_state_changed:${prevState}->${nextState}`,
      });
      if (nextState !== "active") {
        callbacks.flushAutoClientLogs();
        callbacks.flushSessionDiagClientLogs();
        return;
      }
      const ws = streamSocketRef.current;
      if (!ws && !streamTtsControlRef.current) return;
      const readyState = typeof ws?.readyState === "number" ? ws.readyState : -1;
      const stale = sinceLastNonActiveMs !== null
        && sinceLastNonActiveMs >= appResumeStreamRecoveryNonActiveMinMs;
      const closed = Boolean(ws)
        && (readyState === WebSocket.CLOSING || readyState === WebSocket.CLOSED);
      if (!stale && !closed) return;
      callbacks.logAuto("stream_tts_resume_recover_trigger", {
        sinceLastNonActiveMs,
        readyState,
        replyLoading: replyLoadingRef.current,
      });
      callbacks.recoverTtsStreamAfterResume(stale ? "resume_stale_tts_stream" : "resume_socket_not_open");
    });
    return () => sub.remove();
  }, [
    appResumeStreamRecoveryNonActiveMinMs,
    appStateChangedAtRef,
    appStateLastNonActiveAtRef,
    appStateRef,
    replyLoadingRef,
    streamSocketRef,
    streamTtsControlRef,
  ]);
}
