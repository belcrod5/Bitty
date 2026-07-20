import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";

type RecordingStatusSource = "callback" | "watchdog";
type AutoRecordingStatus = Awaited<ReturnType<Audio.Recording["getStatusAsync"]>>;

type UseAutoRecordingWatchdogOptions = {
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  autoRecordingRef: MutableRefObject<Audio.Recording | null>;
  autoFinalizeLockRef: MutableRefObject<boolean>;
  autoRecordingWatchdogTimerRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  autoRecordingWatchdogInFlightRef: MutableRefObject<boolean>;
  autoRecordingWatchdogInFlightTokenRef: MutableRefObject<number>;
  autoRecordingWatchdogKickAtRef: MutableRefObject<number>;
  autoRecordingWatchdogRestartAtRef: MutableRefObject<number>;
  autoRecordingWatchdogErrorLogAtRef: MutableRefObject<number>;
  autoWaveStatusLastAtRef: MutableRefObject<number>;
  autoSpeechStartedAtRef: MutableRefObject<number>;
  autoSilenceDeadlineAtRef: MutableRefObject<number>;
  autoBelowSinceRef: MutableRefObject<number>;
  autoNoCallbackFinalizeAtRef: MutableRefObject<number>;
  autoLastStatusHandledAtRef: MutableRefObject<number>;
  autoShadowStatusLastAtRef: MutableRefObject<number>;
  autoShadowStatusLastMeteringRef: MutableRefObject<number | null>;
  autoShadowStatusLastDurationMsRef: MutableRefObject<number | null>;
  autoMinSpeechMs: number;
  watchdogIntervalMs: number;
  watchdogStaleMs: number;
  watchdogLogThrottleMs: number;
  watchdogStatusTimeoutMs: number;
  watchdogInFlightForceReleaseMs: number;
  noCallbackStatusReadMs: number;
  noCallbackForceFinalizeMs: number;
  noCallbackFinalizeCooldownMs: number;
  watchdogRestartStaleMs: number;
  watchdogRestartCooldownMs: number;
  watchdogKickGuardMs: number;
  clearAutoRecordingWatchdogTimer: () => void;
  readAutoRecordingStatus: (
    rec: Audio.Recording,
    owner: "watchdog",
    timeoutMs: number,
  ) => Promise<AutoRecordingStatus> | null;
  elapsedSinceMs: (startedAtMs: number) => number | null;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
};

type StartAutoRecordingWatchdogParams = {
  rec: Audio.Recording;
  handleAutoRecordingStatus: (status: AutoRecordingStatus, statusSource: RecordingStatusSource) => void;
  finalizeAutoCapture: (shouldTranscribe: boolean, reason: string) => Promise<void>;
  resetSpeechWindowWithoutFinalize: (
    now: number,
    reason: string,
    payload?: Record<string, unknown>,
  ) => void;
  restartCaptureForWatchdog: (staleForMs: number) => void;
};

export function useAutoRecordingWatchdog(options: UseAutoRecordingWatchdogOptions) {
  const {
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoFinalizeLockRef,
    autoRecordingWatchdogTimerRef,
    autoRecordingWatchdogInFlightRef,
    autoRecordingWatchdogInFlightTokenRef,
    autoRecordingWatchdogKickAtRef,
    autoRecordingWatchdogRestartAtRef,
    autoRecordingWatchdogErrorLogAtRef,
    autoWaveStatusLastAtRef,
    autoSpeechStartedAtRef,
    autoSilenceDeadlineAtRef,
    autoBelowSinceRef,
    autoNoCallbackFinalizeAtRef,
    autoLastStatusHandledAtRef,
    autoShadowStatusLastAtRef,
    autoShadowStatusLastMeteringRef,
    autoShadowStatusLastDurationMsRef,
    autoMinSpeechMs,
    watchdogIntervalMs,
    watchdogStaleMs,
    watchdogLogThrottleMs,
    watchdogStatusTimeoutMs,
    watchdogInFlightForceReleaseMs,
    noCallbackStatusReadMs,
    noCallbackForceFinalizeMs,
    noCallbackFinalizeCooldownMs,
    watchdogRestartStaleMs,
    watchdogRestartCooldownMs,
    watchdogKickGuardMs,
    clearAutoRecordingWatchdogTimer,
    readAutoRecordingStatus,
    elapsedSinceMs,
    logAuto,
  } = options;

  const startAutoRecordingWatchdog = useCallback((params: StartAutoRecordingWatchdogParams) => {
    const {
      rec,
      handleAutoRecordingStatus,
      finalizeAutoCapture,
      resetSpeechWindowWithoutFinalize,
      restartCaptureForWatchdog,
    } = params;

    clearAutoRecordingWatchdogTimer();
    autoRecordingWatchdogTimerRef.current = setInterval(() => {
      if (!autoRecordingEnabledRef.current) return;
      if (autoRecordingRef.current !== rec || autoFinalizeLockRef.current) return;
      const now = Date.now();
      if (autoRecordingWatchdogInFlightRef.current) {
        const inFlightForMs = autoRecordingWatchdogInFlightTokenRef.current > 0
          ? Math.max(0, now - autoRecordingWatchdogInFlightTokenRef.current)
          : 0;
        if (inFlightForMs < watchdogInFlightForceReleaseMs) return;
        autoRecordingWatchdogInFlightRef.current = false;
        autoRecordingWatchdogInFlightTokenRef.current = 0;
        if (now - autoRecordingWatchdogErrorLogAtRef.current >= watchdogLogThrottleMs) {
          autoRecordingWatchdogErrorLogAtRef.current = now;
          logAuto("recording_status_watchdog_force_release", {
            inFlightForMs,
          });
        }
      }
      const staleForMs = (
        autoWaveStatusLastAtRef.current > 0
          ? Math.max(0, now - autoWaveStatusLastAtRef.current)
          : watchdogStaleMs
      );
      const speechStartedAt = autoSpeechStartedAtRef.current;
      const speechMsForFallback = speechStartedAt > 0 ? Math.max(0, now - speechStartedAt) : 0;
      const shouldTranscribeForFallback = speechMsForFallback >= autoMinSpeechMs;
      const silenceDeadlineAt = autoSilenceDeadlineAtRef.current;
      if (speechStartedAt > 0 && silenceDeadlineAt > 0 && now >= silenceDeadlineAt) {
        logAuto("finalize_trigger", {
          reason: "silence_deadline_watchdog",
          speechMs: speechMsForFallback,
          shouldTranscribe: shouldTranscribeForFallback,
          silenceDeadlineAt,
          staleForMs,
          sinceLastStatusHandledMs: elapsedSinceMs(autoLastStatusHandledAtRef.current),
        });
        if (shouldTranscribeForFallback) {
          void finalizeAutoCapture(true, "silence_watchdog");
        } else {
          resetSpeechWindowWithoutFinalize(now, "short_speech_discarded_watchdog", {
            speechMs: speechMsForFallback,
            staleForMs,
          });
        }
        return;
      }
      if (
        speechStartedAt > 0 &&
        staleForMs >= noCallbackForceFinalizeMs &&
        autoBelowSinceRef.current > 0 &&
        now - autoNoCallbackFinalizeAtRef.current >= noCallbackFinalizeCooldownMs
      ) {
        autoNoCallbackFinalizeAtRef.current = now;
        logAuto("finalize_trigger", {
          reason: "no_callback_timeout",
          speechMs: speechMsForFallback,
          shouldTranscribe: shouldTranscribeForFallback,
          staleForMs,
          staleThresholdMs: noCallbackForceFinalizeMs,
          sinceLastStatusHandledMs: elapsedSinceMs(autoLastStatusHandledAtRef.current),
        });
        if (shouldTranscribeForFallback) {
          void finalizeAutoCapture(true, "no_callback_timeout");
        } else {
          resetSpeechWindowWithoutFinalize(now, "short_speech_discarded_no_callback", {
            speechMs: speechMsForFallback,
            staleForMs,
          });
        }
        return;
      }
      if (
        speechStartedAt > 0 &&
        staleForMs >= noCallbackStatusReadMs
      ) {
        const forcedRead = readAutoRecordingStatus(
          rec,
          "watchdog",
          watchdogStatusTimeoutMs,
        );
        if (forcedRead) {
          autoRecordingWatchdogInFlightRef.current = true;
          const kickToken = now;
          autoRecordingWatchdogInFlightTokenRef.current = kickToken;
          void forcedRead
            .then((status) => {
              if (autoRecordingRef.current !== rec) return;
              const nowForStatus = Date.now();
              autoShadowStatusLastAtRef.current = nowForStatus;
              autoShadowStatusLastDurationMsRef.current = Number(status?.durationMillis || 0);
              autoShadowStatusLastMeteringRef.current = (
                typeof status?.metering === "number" ? status.metering : null
              );
              handleAutoRecordingStatus(status, "watchdog");
            })
            .catch(() => {})
            .finally(() => {
              if (autoRecordingWatchdogInFlightTokenRef.current === kickToken) {
                autoRecordingWatchdogInFlightRef.current = false;
                autoRecordingWatchdogInFlightTokenRef.current = 0;
              }
            });
          return;
        }
      }
      if (staleForMs < watchdogStaleMs) return;
      if (
        staleForMs >= watchdogRestartStaleMs &&
        now - autoRecordingWatchdogRestartAtRef.current >= watchdogRestartCooldownMs
      ) {
        autoRecordingWatchdogRestartAtRef.current = now;
        restartCaptureForWatchdog(staleForMs);
        return;
      }
      if (now - autoRecordingWatchdogKickAtRef.current < watchdogKickGuardMs) return;
      autoRecordingWatchdogKickAtRef.current = now;
      autoRecordingWatchdogInFlightRef.current = true;
      const kickToken = now;
      autoRecordingWatchdogInFlightTokenRef.current = kickToken;
      const statusRead = readAutoRecordingStatus(
        rec,
        "watchdog",
        watchdogStatusTimeoutMs,
      );
      if (!statusRead) {
        autoRecordingWatchdogInFlightRef.current = false;
        autoRecordingWatchdogInFlightTokenRef.current = 0;
        return;
      }
      void statusRead
        .then((status) => {
          if (autoRecordingRef.current !== rec) return;
          const nowForStatus = Date.now();
          autoShadowStatusLastAtRef.current = nowForStatus;
          autoShadowStatusLastDurationMsRef.current = Number(status?.durationMillis || 0);
          autoShadowStatusLastMeteringRef.current = (
            typeof status?.metering === "number" ? status.metering : null
          );
          handleAutoRecordingStatus(status, "watchdog");
        })
        .catch((err) => {
          const nowForError = Date.now();
          const message = err instanceof Error ? err.message : String(err);
          if (nowForError - autoRecordingWatchdogErrorLogAtRef.current >= watchdogLogThrottleMs) {
            autoRecordingWatchdogErrorLogAtRef.current = nowForError;
            logAuto("recording_status_watchdog_error", {
              message,
              staleForMs,
            });
          }
        })
        .finally(() => {
          if (autoRecordingWatchdogInFlightTokenRef.current === kickToken) {
            autoRecordingWatchdogInFlightRef.current = false;
            autoRecordingWatchdogInFlightTokenRef.current = 0;
          }
        });
    }, watchdogIntervalMs);
  }, [
    autoBelowSinceRef,
    autoFinalizeLockRef,
    autoLastStatusHandledAtRef,
    autoNoCallbackFinalizeAtRef,
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoRecordingWatchdogErrorLogAtRef,
    autoRecordingWatchdogInFlightRef,
    autoRecordingWatchdogInFlightTokenRef,
    autoRecordingWatchdogKickAtRef,
    autoRecordingWatchdogRestartAtRef,
    autoRecordingWatchdogTimerRef,
    autoShadowStatusLastAtRef,
    autoShadowStatusLastDurationMsRef,
    autoShadowStatusLastMeteringRef,
    autoSilenceDeadlineAtRef,
    autoSpeechStartedAtRef,
    autoWaveStatusLastAtRef,
    autoMinSpeechMs,
    clearAutoRecordingWatchdogTimer,
    elapsedSinceMs,
    logAuto,
    noCallbackFinalizeCooldownMs,
    noCallbackForceFinalizeMs,
    noCallbackStatusReadMs,
    readAutoRecordingStatus,
    watchdogInFlightForceReleaseMs,
    watchdogKickGuardMs,
    watchdogLogThrottleMs,
    watchdogRestartCooldownMs,
    watchdogRestartStaleMs,
    watchdogStaleMs,
    watchdogStatusTimeoutMs,
    watchdogIntervalMs,
  ]);

  return {
    startAutoRecordingWatchdog,
  };
}
