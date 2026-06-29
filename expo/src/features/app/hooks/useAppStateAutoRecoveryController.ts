import { useEffect, type MutableRefObject } from "react";
import { Audio } from "expo-av";
import { AppState, type AppStateStatus } from "react-native";
import type { StreamTtsControlState } from "../types/appTypes";

type SessionDiagLogOptions = {
  throttleMs?: number;
  throttleKey?: string;
  detailed?: boolean;
};

type UseAppStateAutoRecoveryControllerArgs = {
  appStateRef: MutableRefObject<AppStateStatus>;
  appStateChangedAtRef: MutableRefObject<number>;
  appStateLastNonActiveAtRef: MutableRefObject<number>;
  autoWaveStatusLastAtRef: MutableRefObject<number>;
  autoShadowStatusLastAtRef: MutableRefObject<number>;
  autoShadowStatusLastMeteringRef: MutableRefObject<number | null>;
  autoShadowStatusLastDurationMsRef: MutableRefObject<number | null>;
  autoStatusReadOwnerRef: MutableRefObject<string>;
  autoStatusReadStartedAtRef: MutableRefObject<number>;
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  autoRecordingRef: MutableRefObject<Audio.Recording | null>;
  autoFinalizeLockRef: MutableRefObject<boolean>;
  autoResumeStatusProbeInFlightRef: MutableRefObject<boolean>;
  autoAppStateNonActiveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  autoRestartTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  replyLoadingRef: MutableRefObject<boolean>;
  elapsedSinceMs: (startedAtMs: number) => number | null;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
  logSessionDiag: (
    event: string,
    payload?: Record<string, unknown>,
    options?: SessionDiagLogOptions
  ) => void;
  recoverTtsStreamAfterResume: (reason: string) => void;
  flushAutoClientLogs: () => void;
  flushSessionDiagClientLogs: () => void;
  setAutoRecordingState: (state: string) => void;
  setAutoLastEvent: (event: string) => void;
  readRecordingStatusWithTimeout: (
    rec: Audio.Recording,
    timeoutMs: number,
    tag: string
  ) => Promise<Audio.RecordingStatus>;
  clearAutoRecordingWatchdogTimer: () => void;
  releaseRecording: (rec: Audio.Recording) => Promise<Audio.RecordingStatus | null>;
  startAutoCaptureCycle: () => Promise<void>;
  autoAppStateNonActiveApplyDelayMs: number;
  appResumeStreamRecoveryNonActiveMinMs: number;
  autoResumeStatusProbeTimeoutMs: number;
};

export function useAppStateAutoRecoveryController({
  appStateRef,
  appStateChangedAtRef,
  appStateLastNonActiveAtRef,
  autoWaveStatusLastAtRef,
  autoShadowStatusLastAtRef,
  autoShadowStatusLastMeteringRef,
  autoShadowStatusLastDurationMsRef,
  autoStatusReadOwnerRef,
  autoStatusReadStartedAtRef,
  autoRecordingEnabledRef,
  autoRecordingRef,
  autoFinalizeLockRef,
  autoResumeStatusProbeInFlightRef,
  autoAppStateNonActiveTimerRef,
  autoRestartTimerRef,
  streamSocketRef,
  streamTtsControlRef,
  replyLoadingRef,
  elapsedSinceMs,
  logAuto,
  logSessionDiag,
  recoverTtsStreamAfterResume,
  flushAutoClientLogs,
  flushSessionDiagClientLogs,
  setAutoRecordingState,
  setAutoLastEvent,
  readRecordingStatusWithTimeout,
  clearAutoRecordingWatchdogTimer,
  releaseRecording,
  startAutoCaptureCycle,
  autoAppStateNonActiveApplyDelayMs,
  appResumeStreamRecoveryNonActiveMinMs,
  autoResumeStatusProbeTimeoutMs,
}: UseAppStateAutoRecoveryControllerArgs) {
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      const now = Date.now();
      const prevState = appStateRef.current;
      const sinceLastNonActiveMs = (
        appStateLastNonActiveAtRef.current > 0
          ? Math.max(0, now - appStateLastNonActiveAtRef.current)
          : null
      );
      appStateRef.current = nextState;
      appStateChangedAtRef.current = now;
      if (nextState !== "active") {
        appStateLastNonActiveAtRef.current = appStateChangedAtRef.current;
      } else {
        appStateLastNonActiveAtRef.current = 0;
      }
      const callbackGapMs = (
        autoWaveStatusLastAtRef.current > 0
          ? Math.max(0, now - autoWaveStatusLastAtRef.current)
          : null
      );
      const shadowGapMs = (
        autoShadowStatusLastAtRef.current > 0
          ? Math.max(0, now - autoShadowStatusLastAtRef.current)
          : null
      );
      logAuto("app_state_changed", {
        from: prevState,
        to: nextState,
        sinceLastNonActiveMs,
        autoEnabled: autoRecordingEnabledRef.current,
        autoRecordingActive: Boolean(autoRecordingRef.current),
        autoFinalizeLock: autoFinalizeLockRef.current,
        callbackGapMs,
        shadowGapMs,
        shadowMetering: autoShadowStatusLastMeteringRef.current,
        shadowDurationMs: autoShadowStatusLastDurationMsRef.current,
        statusReadOwner: autoStatusReadOwnerRef.current || null,
        statusReadInFlightForMs: elapsedSinceMs(autoStatusReadStartedAtRef.current),
      });
      logSessionDiag("app_state_changed", {
        from: prevState,
        to: nextState,
        sinceLastNonActiveMs,
        callbackGapMs,
        shadowGapMs,
      }, {
        throttleMs: 0,
        throttleKey: `app_state_changed:${prevState}->${nextState}`,
      });
      const hasLiveAutoRecording = () => (
        autoRecordingEnabledRef.current &&
        Boolean(autoRecordingRef.current) &&
        !autoFinalizeLockRef.current
      );
      const hasInFlightTtsStream = () => (
        streamTtsControlRef.current !== null ||
        streamSocketRef.current !== null
      );
      if (nextState !== "active") {
        autoResumeStatusProbeInFlightRef.current = false;
        if (autoAppStateNonActiveTimerRef.current) {
          clearTimeout(autoAppStateNonActiveTimerRef.current);
          autoAppStateNonActiveTimerRef.current = null;
        }
        if (autoRestartTimerRef.current) {
          clearTimeout(autoRestartTimerRef.current);
          autoRestartTimerRef.current = null;
        }
        flushAutoClientLogs();
        flushSessionDiagClientLogs();
        if (!autoRecordingEnabledRef.current) return;
        if (hasLiveAutoRecording()) {
          logAuto("app_inactive_keep_recording", {
            appState: nextState,
            autoRecordingActive: Boolean(autoRecordingRef.current),
            mode: "immediate_skip_waiting_foreground",
          });
          return;
        }
        logAuto("app_inactive_debounce_start", {
          appState: nextState,
          delayMs: autoAppStateNonActiveApplyDelayMs,
          autoRecordingActive: Boolean(autoRecordingRef.current),
        });
        autoAppStateNonActiveTimerRef.current = setTimeout(() => {
          autoAppStateNonActiveTimerRef.current = null;
          if (!autoRecordingEnabledRef.current) return;
          if (appStateRef.current === "active") {
            logAuto("app_inactive_debounce_cancelled", {
              reason: "active_restored",
            });
            return;
          }
          if (hasLiveAutoRecording()) {
            logAuto("app_inactive_keep_recording", {
              appState: appStateRef.current,
              autoRecordingActive: Boolean(autoRecordingRef.current),
              mode: "debounced_skip_waiting_foreground",
            });
            return;
          }
          setAutoRecordingState("starting");
          setAutoLastEvent("waiting_foreground");
          logAuto("waiting_foreground", {
            reason: "app_inactive",
            appState: appStateRef.current,
            debounced: true,
          });
        }, autoAppStateNonActiveApplyDelayMs);
        return;
      }
      if (hasInFlightTtsStream()) {
        const ws = streamSocketRef.current;
        const readyState = typeof ws?.readyState === "number" ? ws.readyState : -1;
        const recoverForStaleResume = (
          sinceLastNonActiveMs !== null &&
          sinceLastNonActiveMs >= appResumeStreamRecoveryNonActiveMinMs
        );
        const recoverForSocketState = (
          Boolean(ws) &&
          (
            readyState === WebSocket.CLOSING ||
            readyState === WebSocket.CLOSED
          )
        );
        if (recoverForStaleResume || recoverForSocketState) {
          logAuto("stream_tts_resume_recover_trigger", {
            sinceLastNonActiveMs,
            readyState,
            replyLoading: replyLoadingRef.current,
            hasSocket: Boolean(ws),
            streamTtsControlAlive: streamTtsControlRef.current !== null,
            recoverForStaleResume,
            recoverForSocketState,
          });
          logSessionDiag("stream_tts_resume_recover_trigger", {
            sinceLastNonActiveMs,
            readyState,
            replyLoading: replyLoadingRef.current,
            hasSocket: Boolean(ws),
            streamTtsControlAlive: streamTtsControlRef.current !== null,
            recoverForStaleResume,
            recoverForSocketState,
          }, {
            throttleMs: 0,
            throttleKey: "stream_tts_resume_recover_trigger",
          });
          recoverTtsStreamAfterResume(
            recoverForStaleResume ? "resume_stale_tts_stream" : "resume_socket_not_open"
          );
        }
      }
      if (autoAppStateNonActiveTimerRef.current) {
        clearTimeout(autoAppStateNonActiveTimerRef.current);
        autoAppStateNonActiveTimerRef.current = null;
        logAuto("app_inactive_debounce_cancelled", {
          reason: "app_active",
        });
      }
      if (
        autoRecordingEnabledRef.current &&
        autoRecordingRef.current &&
        !autoFinalizeLockRef.current &&
        !autoResumeStatusProbeInFlightRef.current
      ) {
        const rec = autoRecordingRef.current;
        autoResumeStatusProbeInFlightRef.current = true;
        void (async () => {
          let status: Audio.RecordingStatus | null = null;
          let message = "";
          const probeStartedAt = Date.now();
          try {
            status = await readRecordingStatusWithTimeout(
              rec,
              autoResumeStatusProbeTimeoutMs,
              "resume_probe"
            );
          } catch (err) {
            message = err instanceof Error ? err.message : String(err);
          } finally {
            autoResumeStatusProbeInFlightRef.current = false;
          }
          logAuto("resume_recording_probe", {
            elapsedMs: Math.max(0, Date.now() - probeStartedAt),
            message: message || undefined,
            isRecording: Boolean(status?.isRecording),
            canRecord: Boolean(status?.canRecord),
            isDoneRecording: Boolean(status?.isDoneRecording),
            durationMillis: Number(status?.durationMillis || 0),
            appState: appStateRef.current,
          });
          if (!autoRecordingEnabledRef.current || autoFinalizeLockRef.current) return;
          if (autoRecordingRef.current !== rec) return;
          const shouldRestart = Boolean(message) || !Boolean(status?.isRecording);
          if (!shouldRestart) {
            setAutoRecordingState("listening");
            setAutoLastEvent("resumed_active");
            logAuto("resume_recording_probe_ok", {
              appState: appStateRef.current,
              isRecording: Boolean(status?.isRecording),
            });
            return;
          }
          logAuto("resume_recording_probe_restart", {
            reason: message ? "probe_error" : "not_recording",
            message: message || undefined,
            appState: appStateRef.current,
          });
          rec.setOnRecordingStatusUpdate(null);
          autoRecordingRef.current = null;
          clearAutoRecordingWatchdogTimer();
          await releaseRecording(rec).catch(() => {});
          if (
            autoRecordingEnabledRef.current &&
            appStateRef.current === "active" &&
            !autoFinalizeLockRef.current
          ) {
            setAutoRecordingState("starting");
            setAutoLastEvent("resume_probe_restart");
            void startAutoCaptureCycle();
          }
        })();
      }
      if (
        autoRecordingEnabledRef.current &&
        !autoRecordingRef.current &&
        !autoFinalizeLockRef.current
      ) {
        logAuto("resume_capture_cycle", { reason: "app_active" });
        void startAutoCaptureCycle();
      }
    });
    return () => {
      sub.remove();
    };
  }, []);
}
