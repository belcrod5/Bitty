import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";
import {
  buildRecordingOptions,
  resolveAutoRecordingProgressUpdateIntervalMs,
  type RecordingTuning,
} from "../utils/audioConfig";

type AutoProgressMode = "idle" | "speech" | "barge";
type BargeInPhase = "probe_fast" | "speech_start" | "ongoing_speech_overlap";
type RecordingStatusSource = "callback" | "watchdog";
type AutoRecordingStatus = Awaited<ReturnType<Audio.Recording["getStatusAsync"]>>;

type RunAutoCaptureCycleCoreParams = {
  captureCycleId: number;
  startAutoCaptureCycle: () => Promise<void>;
  finalizeAutoCapture: (shouldTranscribe: boolean, reason: string) => Promise<void>;
};

type UseAutoCaptureCycleCoreOptions = {
  recordingTuning: RecordingTuning;
  autoInputDetectAtRef: MutableRefObject<number>;
  autoProgressIntervalMsRef: MutableRefObject<number>;
  autoProgressIntervalModeRef: MutableRefObject<AutoProgressMode>;
  autoRecordingRef: MutableRefObject<Audio.Recording | null>;
  autoClipStartedAtRef: MutableRefObject<number>;
  autoFinalizeResolvedAtRef: MutableRefObject<number>;
  autoBargeInStoppingRef: MutableRefObject<boolean>;
  autoBargeInDetectedForClipRef: MutableRefObject<boolean>;
  autoInputNameRef: MutableRefObject<string>;
  autoAirPodsInputRef: MutableRefObject<boolean>;
  ttsPlayingRef: MutableRefObject<boolean>;
  replyLoadingRef: MutableRefObject<boolean>;
  setAutoRecordingState: (state: string) => void;
  setAutoLastEvent: (event: string) => void;
  setAutoMeteringDb: (value: number | null) => void;
  startAutoPendingUserMessage: (options?: { source?: string; timeoutMs?: number }) => void;
  stopTtsPlayback: (options?: { interruptStream?: boolean }) => Promise<void>;
  ensureMicReady: () => Promise<void>;
  detectAutoAirPodsInput: (rec?: Audio.Recording | null) => Promise<boolean>;
  releaseRecording: (rec: Audio.Recording) => Promise<Audio.RecordingStatus | null>;
  clearAutoRecordingWatchdogTimer: () => void;
  isBackgroundAudioSessionError: (raw: unknown) => boolean;
  isRecordingNotAllowedError: (raw: unknown) => boolean;
  createRequestBargeInStop: (params: {
    startAutoPendingUserMessage: (options?: { source?: string; timeoutMs?: number }) => void;
    stopTtsPlayback: (options?: { interruptStream?: boolean }) => Promise<void>;
    setAutoLastEvent: (event: string) => void;
  }) => (now: number, metering: number, phase: BargeInPhase) => boolean;
  createResetSpeechWindowWithoutFinalize: (params: {
    applyAutoProgressInterval: (
      mode: AutoProgressMode,
      reason: string,
      payload?: Record<string, unknown>,
    ) => void;
    setAutoRecordingState: (state: string) => void;
    setAutoLastEvent: (event: string) => void;
  }) => (
    now: number,
    reason: string,
    payload?: Record<string, unknown>,
  ) => void;
  createRestartCaptureForWatchdog: (params: {
    rec: Audio.Recording;
    captureCycleId: number;
    startAutoCaptureCycle: () => Promise<void>;
    setAutoRecordingState: (state: string) => void;
    setAutoLastEvent: (event: string) => void;
    setAutoMeteringDb: (value: number | null) => void;
    releaseRecording: (rec: Audio.Recording) => Promise<Audio.RecordingStatus | null>;
    clearAutoRecordingWatchdogTimer: () => void;
  }) => (staleForMs: number) => void;
  createAutoRecordingStatusHandler: (params: {
    rec: Audio.Recording;
    captureCycleId: number;
    applyAutoProgressInterval: (
      mode: AutoProgressMode,
      reason: string,
      payload?: Record<string, unknown>,
    ) => void;
    requestBargeInStop: (now: number, metering: number, phase: BargeInPhase) => boolean;
    finalizeAutoCapture: (shouldTranscribe: boolean, reason: string) => Promise<void>;
    resetSpeechWindowWithoutFinalize: (
      now: number,
      reason: string,
      payload?: Record<string, unknown>,
    ) => void;
  }) => (status: AutoRecordingStatus, statusSource: RecordingStatusSource) => void;
  startAutoRecordingWithRetry: (params: {
    rec: Audio.Recording;
    prepareRecorder: () => Promise<unknown>;
    applyAutoProgressInterval: (
      mode: AutoProgressMode,
      reason: string,
      payload?: Record<string, unknown>,
    ) => void;
  }) => Promise<void>;
  startAutoRecordingWatchdog: (params: {
    rec: Audio.Recording;
    handleAutoRecordingStatus: (status: AutoRecordingStatus, statusSource: RecordingStatusSource) => void;
    finalizeAutoCapture: (shouldTranscribe: boolean, reason: string) => Promise<void>;
    resetSpeechWindowWithoutFinalize: (
      now: number,
      reason: string,
      payload?: Record<string, unknown>,
    ) => void;
    restartCaptureForWatchdog: (staleForMs: number) => void;
  }) => void;
  scheduleAutoCaptureCycleRetry: (params: {
    delayMs: number;
    lastEvent: string;
    reason: string;
    message: string;
    startAutoCaptureCycle: () => Promise<void>;
  }) => void;
  resetAutoSpeechTracking: () => void;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
  reportError: (raw: unknown, scope?: string) => void;
};

export function useAutoCaptureCycleCore(options: UseAutoCaptureCycleCoreOptions) {
  const {
    recordingTuning,
    autoInputDetectAtRef,
    autoProgressIntervalMsRef,
    autoProgressIntervalModeRef,
    autoRecordingRef,
    autoClipStartedAtRef,
    autoFinalizeResolvedAtRef,
    autoBargeInStoppingRef,
    autoBargeInDetectedForClipRef,
    autoInputNameRef,
    autoAirPodsInputRef,
    ttsPlayingRef,
    replyLoadingRef,
    setAutoRecordingState,
    setAutoLastEvent,
    setAutoMeteringDb,
    startAutoPendingUserMessage,
    stopTtsPlayback,
    ensureMicReady,
    detectAutoAirPodsInput,
    releaseRecording,
    clearAutoRecordingWatchdogTimer,
    isBackgroundAudioSessionError,
    isRecordingNotAllowedError,
    createRequestBargeInStop,
    createResetSpeechWindowWithoutFinalize,
    createRestartCaptureForWatchdog,
    createAutoRecordingStatusHandler,
    startAutoRecordingWithRetry,
    startAutoRecordingWatchdog,
    scheduleAutoCaptureCycleRetry,
    resetAutoSpeechTracking,
    logAuto,
    reportError,
  } = options;

  const runAutoCaptureCycleCore = useCallback(async (params: RunAutoCaptureCycleCoreParams) => {
    const {
      captureCycleId,
      startAutoCaptureCycle,
      finalizeAutoCapture,
    } = params;
    let pendingRec: Audio.Recording | null = null;
    try {
      const requestBargeInStop = createRequestBargeInStop({
        startAutoPendingUserMessage,
        stopTtsPlayback,
        setAutoLastEvent,
      });

      await ensureMicReady();
      const rec = new Audio.Recording();
      pendingRec = rec;
      const applyAutoProgressInterval = (
        mode: AutoProgressMode,
        reason: string,
        payload: Record<string, unknown> = {},
      ) => {
        const nextIntervalMs = resolveAutoRecordingProgressUpdateIntervalMs(recordingTuning, mode);
        if (
          autoProgressIntervalMsRef.current === nextIntervalMs &&
          autoProgressIntervalModeRef.current === mode
        ) {
          return;
        }
        autoProgressIntervalMsRef.current = nextIntervalMs;
        autoProgressIntervalModeRef.current = mode;
        rec.setProgressUpdateInterval(nextIntervalMs);
        logAuto("capture_interval_update", {
          mode,
          reason,
          nextIntervalMs,
          ...payload,
        });
      };
      await rec.prepareToRecordAsync(buildRecordingOptions(recordingTuning));
      await detectAutoAirPodsInput(rec);
      autoInputDetectAtRef.current = Date.now();
      applyAutoProgressInterval("idle", "capture_started");
      const resetSpeechWindowWithoutFinalize = createResetSpeechWindowWithoutFinalize({
        applyAutoProgressInterval,
        setAutoRecordingState,
        setAutoLastEvent,
      });
      const restartCaptureForWatchdog = createRestartCaptureForWatchdog({
        rec,
        captureCycleId,
        startAutoCaptureCycle,
        setAutoRecordingState,
        setAutoLastEvent,
        setAutoMeteringDb,
        releaseRecording,
        clearAutoRecordingWatchdogTimer,
      });

      const handleAutoRecordingStatus = createAutoRecordingStatusHandler({
        rec,
        captureCycleId,
        applyAutoProgressInterval,
        requestBargeInStop,
        finalizeAutoCapture,
        resetSpeechWindowWithoutFinalize,
      });
      rec.setOnRecordingStatusUpdate((status) => {
        handleAutoRecordingStatus(status, "callback");
      });

      await startAutoRecordingWithRetry({
        rec,
        prepareRecorder: () => rec.prepareToRecordAsync(buildRecordingOptions(recordingTuning)),
        applyAutoProgressInterval,
      });

      autoRecordingRef.current = rec;
      pendingRec = null;
      startAutoRecordingWatchdog({
        rec,
        handleAutoRecordingStatus,
        finalizeAutoCapture,
        resetSpeechWindowWithoutFinalize,
        restartCaptureForWatchdog,
      });
      const captureStartedAt = Date.now();
      autoClipStartedAtRef.current = captureStartedAt;
      resetAutoSpeechTracking();
      if (autoFinalizeResolvedAtRef.current > 0) {
        logAuto("capture_resume_gap", {
          gapMs: Math.max(0, captureStartedAt - autoFinalizeResolvedAtRef.current),
          ttsPlaying: ttsPlayingRef.current,
          replyLoading: replyLoadingRef.current,
        });
        autoFinalizeResolvedAtRef.current = 0;
      }
      logAuto("barge_in_flags_reset", {
        phase: "capture_started",
        autoBargeInStopping: autoBargeInStoppingRef.current,
        detectedForClip: autoBargeInDetectedForClipRef.current,
      });
      setAutoRecordingState("listening");
      setAutoLastEvent("listening");
      logAuto("capture_started", {
        captureCycleId,
        inputName: autoInputNameRef.current,
        isAirPods: autoAirPodsInputRef.current,
      });
    } catch (error) {
      if (pendingRec) {
        pendingRec.setOnRecordingStatusUpdate(null);
        await releaseRecording(pendingRec).catch(() => {});
      }
      if (isBackgroundAudioSessionError(error)) {
        setAutoRecordingState("starting");
        setAutoLastEvent("waiting_foreground");
        logAuto("capture_wait", {
          reason: "background_audio_session",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (isRecordingNotAllowedError(error)) {
        setAutoRecordingState("starting");
        scheduleAutoCaptureCycleRetry({
          delayMs: 250,
          lastEvent: "retry_record_mode",
          reason: "retry_record_mode",
          message: error instanceof Error ? error.message : String(error),
          startAutoCaptureCycle,
        });
        return;
      }
      logAuto("capture_cycle_fatal", {
        message: error instanceof Error ? error.message : String(error),
      });
      setAutoRecordingState("starting");
      scheduleAutoCaptureCycleRetry({
        delayMs: 500,
        lastEvent: "retry_after_fatal",
        reason: "retry_after_fatal",
        message: error instanceof Error ? error.message : String(error),
        startAutoCaptureCycle,
      });
      reportError(error, "auto:start-cycle");
    }
  }, [
    autoBargeInDetectedForClipRef,
    autoBargeInStoppingRef,
    autoAirPodsInputRef,
    autoClipStartedAtRef,
    autoFinalizeResolvedAtRef,
    autoInputDetectAtRef,
    autoInputNameRef,
    autoProgressIntervalModeRef,
    autoProgressIntervalMsRef,
    autoRecordingRef,
    clearAutoRecordingWatchdogTimer,
    createAutoRecordingStatusHandler,
    createRequestBargeInStop,
    createResetSpeechWindowWithoutFinalize,
    createRestartCaptureForWatchdog,
    detectAutoAirPodsInput,
    ensureMicReady,
    isBackgroundAudioSessionError,
    isRecordingNotAllowedError,
    logAuto,
    recordingTuning,
    releaseRecording,
    replyLoadingRef,
    reportError,
    resetAutoSpeechTracking,
    scheduleAutoCaptureCycleRetry,
    setAutoLastEvent,
    setAutoMeteringDb,
    setAutoRecordingState,
    startAutoPendingUserMessage,
    startAutoRecordingWatchdog,
    startAutoRecordingWithRetry,
    stopTtsPlayback,
    ttsPlayingRef,
  ]);

  return {
    runAutoCaptureCycleCore,
  };
}
