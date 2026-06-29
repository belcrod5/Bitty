import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";
import type { StreamTtsControlState } from "../types/appTypes";

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
  autoRecordingWatchdogTtsInterruptAtRef: MutableRefObject<number>;
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
  ttsPlayingRef: MutableRefObject<boolean>;
  replyLoadingRef: MutableRefObject<boolean>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  streamAudioQueueProcessingRef: MutableRefObject<boolean>;
  streamAudioQueueRef: MutableRefObject<unknown[]>;
  streamCurrentChunkStartedAtRef: MutableRefObject<number>;
  streamCurrentChunkEstimatedDurationMsRef: MutableRefObject<number | null>;
  ttsLoading: boolean;
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
  watchdogTtsInterruptStaleMs: number;
  watchdogTtsInterruptCooldownMs: number;
  watchdogTtsInterruptStreamMinMs: number;
  watchdogTtsInterruptStreamMarginMs: number;
  watchdogTtsInterruptStreamMaxMs: number;
  watchdogRestartAfterTtsInterruptGapMs: number;
  clearAutoRecordingWatchdogTimer: () => void;
  readAutoRecordingStatus: (
    rec: Audio.Recording,
    owner: "watchdog",
    timeoutMs: number,
  ) => Promise<AutoRecordingStatus> | null;
  stopTtsPlayback: (options?: { interruptStream?: boolean }) => Promise<void>;
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
    autoRecordingWatchdogTtsInterruptAtRef,
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
    ttsPlayingRef,
    replyLoadingRef,
    streamSocketRef,
    streamTtsControlRef,
    streamAudioQueueProcessingRef,
    streamAudioQueueRef,
    streamCurrentChunkStartedAtRef,
    streamCurrentChunkEstimatedDurationMsRef,
    ttsLoading,
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
    watchdogTtsInterruptStaleMs,
    watchdogTtsInterruptCooldownMs,
    watchdogTtsInterruptStreamMinMs,
    watchdogTtsInterruptStreamMarginMs,
    watchdogTtsInterruptStreamMaxMs,
    watchdogRestartAfterTtsInterruptGapMs,
    clearAutoRecordingWatchdogTimer,
    readAutoRecordingStatus,
    stopTtsPlayback,
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
      const shadowStaleForMs = (
        autoShadowStatusLastAtRef.current > 0
          ? Math.max(0, now - autoShadowStatusLastAtRef.current)
          : staleForMs
      );
      if (staleForMs < watchdogStaleMs) return;
      const streamPlaybackActive = (
        streamAudioQueueProcessingRef.current ||
        streamAudioQueueRef.current.length > 0 ||
        streamTtsControlRef.current !== null ||
        streamSocketRef.current !== null ||
        streamCurrentChunkStartedAtRef.current > 0
      );
      const streamChunkEstimatedMs = Number(streamCurrentChunkEstimatedDurationMsRef.current || 0);
      const streamChunkElapsedMs = streamCurrentChunkStartedAtRef.current > 0
        ? Math.max(0, now - streamCurrentChunkStartedAtRef.current)
        : null;
      const streamTtsInterruptStaleMs = (() => {
        if (!streamPlaybackActive) return watchdogTtsInterruptStaleMs;
        const estimatedWithMargin = (
          streamChunkEstimatedMs > 0
            ? Math.max(
              watchdogTtsInterruptStreamMinMs,
              streamChunkEstimatedMs + watchdogTtsInterruptStreamMarginMs,
            )
            : watchdogTtsInterruptStreamMinMs
        );
        return Math.max(
          watchdogTtsInterruptStaleMs,
          Math.min(watchdogTtsInterruptStreamMaxMs, estimatedWithMargin),
        );
      })();
      const streamChunkJustStarted = (
        streamPlaybackActive &&
        streamChunkElapsedMs !== null &&
        streamChunkElapsedMs < 900
      );
      const watchdogRestartStaleMsResolved = (
        streamPlaybackActive
          ? Math.max(
            watchdogRestartStaleMs,
            streamTtsInterruptStaleMs + watchdogRestartAfterTtsInterruptGapMs,
          )
          : watchdogRestartStaleMs
      );
      const ttsInterruptEligible = (
        ttsPlayingRef.current &&
        (
          replyLoadingRef.current ||
          streamTtsControlRef.current !== null ||
          streamSocketRef.current !== null ||
          !streamPlaybackActive
        )
      );
      if (
        ttsInterruptEligible &&
        !streamChunkJustStarted &&
        staleForMs >= streamTtsInterruptStaleMs &&
        shadowStaleForMs >= streamTtsInterruptStaleMs &&
        now - autoRecordingWatchdogTtsInterruptAtRef.current >= watchdogTtsInterruptCooldownMs
      ) {
        autoRecordingWatchdogTtsInterruptAtRef.current = now;
        logAuto("recording_watchdog_tts_interrupt", {
          staleForMs,
          shadowStaleForMs,
          staleThresholdMs: streamTtsInterruptStaleMs,
          streamPlaybackActive,
          streamChunkEstimatedMs: streamChunkEstimatedMs > 0 ? streamChunkEstimatedMs : null,
          streamChunkElapsedMs,
          streamChunkJustStarted,
          ttsInterruptEligible,
          ttsPlaying: ttsPlayingRef.current,
          ttsLoading,
          streamSocketAlive: streamSocketRef.current !== null,
          streamTtsControlAlive: streamTtsControlRef.current !== null,
          replyLoading: replyLoadingRef.current,
        });
        void stopTtsPlayback({ interruptStream: true }).catch(() => {});
      }
      if (
        staleForMs >= watchdogRestartStaleMsResolved &&
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
    autoRecordingWatchdogTtsInterruptAtRef,
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
    replyLoadingRef,
    stopTtsPlayback,
    streamAudioQueueProcessingRef,
    streamAudioQueueRef,
    streamCurrentChunkEstimatedDurationMsRef,
    streamCurrentChunkStartedAtRef,
    streamSocketRef,
    streamTtsControlRef,
    ttsLoading,
    ttsPlayingRef,
    watchdogInFlightForceReleaseMs,
    watchdogKickGuardMs,
    watchdogLogThrottleMs,
    watchdogRestartAfterTtsInterruptGapMs,
    watchdogRestartCooldownMs,
    watchdogRestartStaleMs,
    watchdogStaleMs,
    watchdogStatusTimeoutMs,
    watchdogTtsInterruptCooldownMs,
    watchdogTtsInterruptStaleMs,
    watchdogTtsInterruptStreamMarginMs,
    watchdogTtsInterruptStreamMaxMs,
    watchdogTtsInterruptStreamMinMs,
    watchdogIntervalMs,
  ]);

  return {
    startAutoRecordingWatchdog,
  };
}
