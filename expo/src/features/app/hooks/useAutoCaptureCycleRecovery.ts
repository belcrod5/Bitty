import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { Audio } from "expo-av";
import type { StreamTtsControlState } from "../types/appTypes";
import { shouldAllowAutoCaptureDuringTts } from "../utils/autoAudioPolicy";

type BargeInPhase = "probe_fast" | "speech_start" | "ongoing_speech_overlap";
type AutoProgressMode = "idle" | "speech" | "barge";
const BARGE_IN_FAST_PROBE_TIMEOUT_MS = 1200;

type CreateRequestBargeInStopParams = {
  stopTtsPlayback: (options?: { interruptStream?: boolean; reason?: string }) => Promise<void>;
  setAutoLastEvent: (event: string) => void;
};

type CreateResetSpeechWindowParams = {
  applyAutoProgressInterval: (
    mode: AutoProgressMode,
    reason: string,
    payload?: Record<string, unknown>,
  ) => void;
  setAutoRecordingState: (state: string) => void;
  setAutoLastEvent: (event: string) => void;
};

type CreateRestartCaptureForWatchdogParams = {
  rec: Audio.Recording;
  captureCycleId: number;
  startAutoCaptureCycle: () => Promise<void>;
  setAutoRecordingState: (state: string) => void;
  setAutoLastEvent: (event: string) => void;
  setAutoMeteringDb: (value: number | null) => void;
  releaseRecording: (rec: Audio.Recording) => Promise<Audio.RecordingStatus | null>;
  clearAutoRecordingWatchdogTimer: () => void;
};

type StartAutoRecordingWithRetryParams = {
  rec: Audio.Recording;
  prepareRecorder: () => Promise<unknown>;
  applyAutoProgressInterval: (
    mode: AutoProgressMode,
    reason: string,
    payload?: Record<string, unknown>,
  ) => void;
};

type ScheduleAutoCaptureRetryParams = {
  delayMs: number;
  lastEvent: string;
  reason: string;
  message: string;
  startAutoCaptureCycle: () => Promise<void>;
};

type UseAutoCaptureCycleRecoveryOptions = {
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  autoBargeInEnabledRef: MutableRefObject<boolean>;
  autoSpeakerPriorityEnabledRef: MutableRefObject<boolean>;
  autoRecordingRef: MutableRefObject<Audio.Recording | null>;
  autoFinalizeLockRef: MutableRefObject<boolean>;
  autoRestartTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  autoClipStartedAtRef: MutableRefObject<number>;
  autoSpeechStartedAtRef: MutableRefObject<number>;
  autoAboveSinceRef: MutableRefObject<number>;
  autoAboveGapSinceRef: MutableRefObject<number>;
  autoBelowSinceRef: MutableRefObject<number>;
  autoSilenceDeadlineAtRef: MutableRefObject<number>;
  autoBargeInStoppingRef: MutableRefObject<boolean>;
  autoBargeInDetectedForClipRef: MutableRefObject<boolean>;
  autoBargeInFastStopAtRef: MutableRefObject<number>;
  autoBargeInFastProbeAboveSinceRef: MutableRefObject<number>;
  autoSpeechStartedDuringTtsRef: MutableRefObject<boolean>;
  autoPostTtsAboveSinceRef: MutableRefObject<number>;
  autoPostTtsHumanDetectedRef: MutableRefObject<boolean>;
  autoUiLatestMeteringRef: MutableRefObject<number | null>;
  autoUiLatestSpeechSampleRef: MutableRefObject<boolean>;
  autoLastBargeInDetectedAtRef: MutableRefObject<number>;
  autoLastTtsStopRequestedAtRef: MutableRefObject<number>;
  autoInputNameRef: MutableRefObject<string>;
  autoAirPodsInputRef: MutableRefObject<boolean>;
  ttsPlayingRef: MutableRefObject<boolean>;
  replyLoadingRef: MutableRefObject<boolean>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  ttsPlaybackMessageIdRef: MutableRefObject<string>;
  ttsLoading: boolean;
  isRecordingNotAllowedError: (raw: unknown) => boolean;
  isRecorderNotPreparedError: (raw: unknown) => boolean;
  ensureMicReady: () => Promise<void>;
  setAutoLastEvent: (event: string) => void;
  elapsedSinceMs: (startedAtMs: number) => number | null;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
};

export function useAutoCaptureCycleRecovery(options: UseAutoCaptureCycleRecoveryOptions) {
  const {
    autoRecordingEnabledRef,
    autoBargeInEnabledRef,
    autoSpeakerPriorityEnabledRef,
    autoRecordingRef,
    autoFinalizeLockRef,
    autoRestartTimerRef,
    autoClipStartedAtRef,
    autoSpeechStartedAtRef,
    autoAboveSinceRef,
    autoAboveGapSinceRef,
    autoBelowSinceRef,
    autoSilenceDeadlineAtRef,
    autoBargeInStoppingRef,
    autoBargeInDetectedForClipRef,
    autoBargeInFastStopAtRef,
    autoBargeInFastProbeAboveSinceRef,
    autoSpeechStartedDuringTtsRef,
    autoPostTtsAboveSinceRef,
    autoPostTtsHumanDetectedRef,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoInputNameRef,
    autoAirPodsInputRef,
    ttsPlayingRef,
    replyLoadingRef,
    streamSocketRef,
    streamTtsControlRef,
    ttsPlaybackMessageIdRef,
    ttsLoading,
    isRecordingNotAllowedError,
    isRecorderNotPreparedError,
    ensureMicReady,
    setAutoLastEvent,
    elapsedSinceMs,
    logAuto,
  } = options;

  const bargeInFastProbeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearBargeInFastProbeTimeout = useCallback(() => {
    if (!bargeInFastProbeTimeoutRef.current) return;
    clearTimeout(bargeInFastProbeTimeoutRef.current);
    bargeInFastProbeTimeoutRef.current = null;
  }, []);

  const resetAutoSpeechTracking = useCallback(() => {
    clearBargeInFastProbeTimeout();
    autoClipStartedAtRef.current = 0;
    autoSpeechStartedAtRef.current = 0;
    autoAboveSinceRef.current = 0;
    autoAboveGapSinceRef.current = 0;
    autoBelowSinceRef.current = 0;
    autoSilenceDeadlineAtRef.current = 0;
    autoBargeInStoppingRef.current = false;
    autoBargeInDetectedForClipRef.current = false;
    autoBargeInFastStopAtRef.current = 0;
    autoBargeInFastProbeAboveSinceRef.current = 0;
    autoSpeechStartedDuringTtsRef.current = false;
    autoPostTtsAboveSinceRef.current = 0;
    autoPostTtsHumanDetectedRef.current = false;
  }, [
    autoAboveGapSinceRef,
    autoAboveSinceRef,
    autoBargeInDetectedForClipRef,
    autoBargeInFastProbeAboveSinceRef,
    autoBargeInFastStopAtRef,
    autoBargeInStoppingRef,
    autoBelowSinceRef,
    autoClipStartedAtRef,
    autoPostTtsAboveSinceRef,
    autoPostTtsHumanDetectedRef,
    autoSilenceDeadlineAtRef,
    autoSpeechStartedAtRef,
    autoSpeechStartedDuringTtsRef,
    clearBargeInFastProbeTimeout,
  ]);

  const createRequestBargeInStop = useCallback((params: CreateRequestBargeInStopParams) => {
    const {
      stopTtsPlayback,
      setAutoLastEvent,
    } = params;

    return (now: number, metering: number, phase: BargeInPhase) => {
      if (phase !== "probe_fast") {
        clearBargeInFastProbeTimeout();
      }
      const captureAllowedDuringTts = shouldAllowAutoCaptureDuringTts({
        autoBargeInEnabled: autoBargeInEnabledRef.current,
        autoSpeakerPriorityEnabled: autoSpeakerPriorityEnabledRef.current,
      });
      if (!captureAllowedDuringTts) {
        logAuto("barge_in_stop_blocked", {
          phase,
          metering,
          autoBargeInEnabled: autoBargeInEnabledRef.current,
          autoSpeakerPriorityEnabled: autoSpeakerPriorityEnabledRef.current,
          autoInputName: autoInputNameRef.current,
          autoAirPodsInput: autoAirPodsInputRef.current,
        });
        return false;
      }
      const playbackStillActive = (
        ttsPlayingRef.current ||
        ttsLoading ||
        streamTtsControlRef.current !== null ||
        streamSocketRef.current !== null ||
        ttsPlaybackMessageIdRef.current === "__stream__"
      );
      if (!playbackStillActive) return false;
      const sinceStopRequestedMs = elapsedSinceMs(autoLastTtsStopRequestedAtRef.current);
      const recentStopRequest = sinceStopRequestedMs !== null && sinceStopRequestedMs < 250;
      const wasStopping = autoBargeInStoppingRef.current;
      if (autoBargeInStoppingRef.current && recentStopRequest) {
        logAuto("barge_in_stop_waiting", {
          phase,
          metering,
          sinceTtsStopRequestedMs: sinceStopRequestedMs,
          streamSocketAlive: streamSocketRef.current !== null,
          streamTtsControlAlive: streamTtsControlRef.current !== null,
          ttsPlaying: ttsPlayingRef.current,
          ttsLoading,
        });
        return false;
      }
      autoBargeInDetectedForClipRef.current = true;
      autoBargeInStoppingRef.current = true;
      autoLastBargeInDetectedAtRef.current = now;
      setAutoLastEvent("barge_in_detected");
      logAuto("barge_in_detected", {
        metering,
        phase,
        retriedStop: Boolean(wasStopping && !recentStopRequest),
        sinceTtsStopRequestedMs: sinceStopRequestedMs,
        autoInputName: autoInputNameRef.current,
        autoAirPodsInput: autoAirPodsInputRef.current,
        autoBargeInEnabled: autoBargeInEnabledRef.current,
        autoSpeakerPriorityEnabled: autoSpeakerPriorityEnabledRef.current,
      });
      if (phase === "probe_fast") {
        clearBargeInFastProbeTimeout();
        bargeInFastProbeTimeoutRef.current = setTimeout(() => {
          bargeInFastProbeTimeoutRef.current = null;
          if (!autoRecordingEnabledRef.current || autoSpeechStartedAtRef.current > 0) return;
          autoBargeInStoppingRef.current = false;
          autoBargeInDetectedForClipRef.current = false;
          autoBargeInFastStopAtRef.current = 0;
          autoBargeInFastProbeAboveSinceRef.current = 0;
          autoAboveSinceRef.current = 0;
          autoAboveGapSinceRef.current = 0;
          autoBelowSinceRef.current = 0;
          if (!autoFinalizeLockRef.current) {
            autoClipStartedAtRef.current = Date.now();
            setAutoLastEvent("barge_in_probe_timeout");
          }
          logAuto("barge_in_flags_reset", {
            phase: "probe_timeout",
            autoBargeInStopping: autoBargeInStoppingRef.current,
            detectedForClip: autoBargeInDetectedForClipRef.current,
          });
        }, BARGE_IN_FAST_PROBE_TIMEOUT_MS);
      }
      void stopTtsPlayback({ interruptStream: true, reason: "auto_barge_in" }).finally(() => {
        autoBargeInStoppingRef.current = false;
      });
      return true;
    };
  }, [
    autoBargeInEnabledRef,
    autoBargeInDetectedForClipRef,
    autoBargeInFastProbeAboveSinceRef,
    autoBargeInFastStopAtRef,
    autoBargeInStoppingRef,
    autoBelowSinceRef,
    autoClipStartedAtRef,
    autoFinalizeLockRef,
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoRecordingEnabledRef,
    autoSpeakerPriorityEnabledRef,
    autoSpeechStartedAtRef,
    autoAboveGapSinceRef,
    autoAboveSinceRef,
    clearBargeInFastProbeTimeout,
    elapsedSinceMs,
    logAuto,
    autoAirPodsInputRef,
    autoInputNameRef,
    streamSocketRef,
    streamTtsControlRef,
    ttsLoading,
    ttsPlaybackMessageIdRef,
    ttsPlayingRef,
  ]);

  useEffect(() => clearBargeInFastProbeTimeout, [clearBargeInFastProbeTimeout]);

  const createResetSpeechWindowWithoutFinalize = useCallback((params: CreateResetSpeechWindowParams) => {
    const {
      applyAutoProgressInterval,
      setAutoRecordingState,
      setAutoLastEvent,
    } = params;

    return (now: number, reason: string, payload: Record<string, unknown> = {}) => {
      autoClipStartedAtRef.current = now;
      autoSpeechStartedAtRef.current = 0;
      autoAboveSinceRef.current = 0;
      autoAboveGapSinceRef.current = 0;
      autoBelowSinceRef.current = 0;
      autoSilenceDeadlineAtRef.current = 0;
      autoBargeInStoppingRef.current = false;
      autoBargeInDetectedForClipRef.current = false;
      autoBargeInFastStopAtRef.current = 0;
      autoBargeInFastProbeAboveSinceRef.current = 0;
      autoSpeechStartedDuringTtsRef.current = false;
      autoPostTtsAboveSinceRef.current = 0;
      autoPostTtsHumanDetectedRef.current = false;
      applyAutoProgressInterval("idle", "speech_window_reset", {
        resetReason: reason,
      });
      setAutoRecordingState("listening");
      setAutoLastEvent(reason);
      logAuto("speech_window_reset_keep_recording", {
        reason,
        ...payload,
      });
    };
  }, [
    autoAboveGapSinceRef,
    autoAboveSinceRef,
    autoBargeInDetectedForClipRef,
    autoBargeInFastProbeAboveSinceRef,
    autoBargeInFastStopAtRef,
    autoBargeInStoppingRef,
    autoBelowSinceRef,
    autoClipStartedAtRef,
    autoPostTtsAboveSinceRef,
    autoPostTtsHumanDetectedRef,
    autoSilenceDeadlineAtRef,
    autoSpeechStartedAtRef,
    autoSpeechStartedDuringTtsRef,
    logAuto,
  ]);

  const createRestartCaptureForWatchdog = useCallback((params: CreateRestartCaptureForWatchdogParams) => {
    const {
      rec,
      captureCycleId,
      startAutoCaptureCycle,
      setAutoRecordingState,
      setAutoLastEvent,
      setAutoMeteringDb,
      releaseRecording,
      clearAutoRecordingWatchdogTimer,
    } = params;

    return (staleForMs: number) => {
      if (!autoRecordingEnabledRef.current) return;
      if (autoRecordingRef.current !== rec || autoFinalizeLockRef.current) return;
      autoFinalizeLockRef.current = true;
      clearAutoRecordingWatchdogTimer();
      logAuto("recording_watchdog_restart_begin", {
        captureCycleId,
        staleForMs,
        ttsPlaying: ttsPlayingRef.current,
        ttsLoading,
        replyLoading: replyLoadingRef.current,
        autoInputName: autoInputNameRef.current,
        autoAirPodsInput: autoAirPodsInputRef.current,
      });
      void (async () => {
        try {
          rec.setOnRecordingStatusUpdate(null);
          await releaseRecording(rec).catch(() => {});
        } catch (err) {
          logAuto("recording_watchdog_restart_error", {
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (autoRecordingRef.current === rec) {
            autoRecordingRef.current = null;
          }
          autoFinalizeLockRef.current = false;
          resetAutoSpeechTracking();
          autoUiLatestMeteringRef.current = null;
          autoUiLatestSpeechSampleRef.current = false;
          setAutoMeteringDb(null);
          if (autoRecordingEnabledRef.current) {
            setAutoRecordingState("starting");
            setAutoLastEvent("watchdog_restart");
            logAuto("recording_watchdog_restart_done", {
              captureCycleId,
              staleForMs,
              autoEnabled: autoRecordingEnabledRef.current,
            });
            void startAutoCaptureCycle();
          } else {
            setAutoRecordingState("idle");
          }
        }
      })();
    };
  }, [
    autoAirPodsInputRef,
    autoFinalizeLockRef,
    autoInputNameRef,
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    logAuto,
    replyLoadingRef,
    resetAutoSpeechTracking,
    ttsLoading,
    ttsPlayingRef,
  ]);

  const startAutoRecordingWithRetry = useCallback(async (params: StartAutoRecordingWithRetryParams) => {
    const {
      rec,
      prepareRecorder,
      applyAutoProgressInterval,
    } = params;

    try {
      await rec.startAsync();
    } catch (startError) {
      const retryForNotAllowed = isRecordingNotAllowedError(startError);
      const retryForNotPrepared = isRecorderNotPreparedError(startError);
      if (!retryForNotAllowed && !retryForNotPrepared) {
        throw startError;
      }
      logAuto("capture_start_retry", {
        reason: retryForNotPrepared ? "recorder_not_prepared" : "recording_not_allowed",
        message: startError instanceof Error ? startError.message : String(startError),
      });
      await ensureMicReady();
      await prepareRecorder();
      applyAutoProgressInterval("idle", "capture_start_retry");
      await rec.startAsync();
    }
  }, [
    ensureMicReady,
    isRecorderNotPreparedError,
    isRecordingNotAllowedError,
    logAuto,
  ]);

  const scheduleAutoCaptureCycleRetry = useCallback((params: ScheduleAutoCaptureRetryParams) => {
    const {
      delayMs,
      lastEvent,
      reason,
      message,
      startAutoCaptureCycle,
    } = params;

    setAutoLastEvent(lastEvent);
    logAuto("capture_wait", {
      reason,
      message,
    });
    if (autoRestartTimerRef.current) clearTimeout(autoRestartTimerRef.current);
    autoRestartTimerRef.current = setTimeout(() => {
      autoRestartTimerRef.current = null;
      if (autoRecordingEnabledRef.current) {
        void startAutoCaptureCycle();
      }
    }, delayMs);
  }, [
    autoRecordingEnabledRef,
    autoRestartTimerRef,
    logAuto,
    setAutoLastEvent,
  ]);

  return {
    createRequestBargeInStop,
    createResetSpeechWindowWithoutFinalize,
    createRestartCaptureForWatchdog,
    startAutoRecordingWithRetry,
    scheduleAutoCaptureCycleRetry,
    resetAutoSpeechTracking,
  };
}
