import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";
import type { AppStateStatus } from "react-native";
import type { StreamTtsControlState } from "../types/appTypes";

type RecordingStatusSource = "callback" | "watchdog";
type AutoProgressMode = "idle" | "speech" | "barge";
type BargeInPhase = "probe_fast" | "speech_start" | "ongoing_speech_overlap";
type AutoRecordingStatus = Awaited<ReturnType<Audio.Recording["getStatusAsync"]>> & {
  metering?: number;
  durationMillis?: number;
  isRecording?: boolean;
  canRecord?: boolean;
  isDoneRecording?: boolean;
};

type UseAutoRecordingStatusHandlerOptions = {
  appStateRef: MutableRefObject<AppStateStatus>;
  appStateChangedAtRef: MutableRefObject<number>;
  appStateLastNonActiveAtRef: MutableRefObject<number>;
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  autoRecordingRef: MutableRefObject<Audio.Recording | null>;
  autoFinalizeLockRef: MutableRefObject<boolean>;
  autoRecordingWatchdogLogAtRef: MutableRefObject<number>;
  autoStatusNotRecordingSuppressLogAtRef: MutableRefObject<number>;
  autoLastStatusHandledAtRef: MutableRefObject<number>;
  autoWaveStatusLastAtRef: MutableRefObject<number>;
  autoShadowStatusLastAtRef: MutableRefObject<number>;
  autoShadowStatusLastMeteringRef: MutableRefObject<number | null>;
  autoShadowStatusLastDurationMsRef: MutableRefObject<number | null>;
  autoStatusReadOwnerRef: MutableRefObject<"watchdog" | "">;
  autoStatusReadStartedAtRef: MutableRefObject<number>;
  autoWaitReasonRef: MutableRefObject<string>;
  autoInputDetectAtRef: MutableRefObject<number>;
  autoUiLatestMeteringRef: MutableRefObject<number | null>;
  autoUiLatestSpeechSampleRef: MutableRefObject<boolean>;
  autoWaveformLastSampleAtRef: MutableRefObject<number>;
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
  autoPlaybackBargeGraceUntilRef: MutableRefObject<number>;
  autoBargeInProbeLogAtRef: MutableRefObject<number>;
  autoPendingUserMessageIdRef: MutableRefObject<string>;
  autoInputNameRef: MutableRefObject<string>;
  autoAirPodsInputRef: MutableRefObject<boolean>;
  autoBargeInEnabledRef: MutableRefObject<boolean>;
  autoLastBargeInDetectedAtRef: MutableRefObject<number>;
  autoLastTtsStopRequestedAtRef: MutableRefObject<number>;
  autoLastTtsStoppedAtRef: MutableRefObject<number>;
  faceTrackingFaceDetectedRef: MutableRefObject<boolean>;
  faceTrackingLookingRef: MutableRefObject<boolean>;
  faceTrackingNotLookingSinceRef: MutableRefObject<number>;
  faceTrackingSuppressedRef: MutableRefObject<boolean>;
  faceTrackingSuppressLogAtRef: MutableRefObject<number>;
  ttsPlayingRef: MutableRefObject<boolean>;
  replyLoadingRef: MutableRefObject<boolean>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  ttsLoading: boolean;
  watchdogLogThrottleMs: number;
  statusNotRecordingAppTransitionGraceMs: number;
  statusNotRecordingSuppressLogThrottleMs: number;
  autoInputRoutePollMs: number;
  autoStartThresholdDb: number;
  autoStartHoldMs: number;
  autoStopThresholdDb: number;
  autoStopSilenceMs: number;
  autoMinSpeechMs: number;
  autoMaxSpeechMs: number;
  autoIdleRolloverMs: number;
  autoBargeInThresholdOffsetDb: number;
  autoBargeInAirpodsThresholdOffsetDb: number;
  autoBargeInHoldMs: number;
  autoBargeInAirpodsHoldMs: number;
  autoBargeInHoldGapToleranceMs: number;
  autoBargeInFastStopAirpodsThresholdDb: number;
  autoBargeInFastStopStartOffsetDb: number;
  autoBargeInFastStopHoldMs: number;
  autoBargeInFastStopCooldownMs: number;
  autoBargeInProbeLogThrottleMs: number;
  autoPostTtsHumanHoldMs: number;
  faceTrackingSttSuppressLogThrottleMs: number;
  faceTrackingRecordingStopHoldMs: number;
  setAutoRecordingState: (state: string) => void;
  setAutoLastEvent: (event: string) => void;
  maybeLogWaveformStatusTick: (
    source: "auto" | "manual",
    now: number,
    status: AutoRecordingStatus,
    metering: number,
  ) => void;
  trackWaveformFlatline: (input: {
    source: "auto" | "manual";
    now: number;
    metering: number;
    startThresholdDb?: number | null;
    startHoldMs?: number | null;
    bargeInWindowActive?: boolean;
    playbackBargeInActive?: boolean;
    isPlaybackActive?: boolean;
    status?: AutoRecordingStatus;
  }) => void;
  clearAutoPendingUserTimeoutTimer: () => void;
  resolveAutoPendingUserMessage: (finalTranscript: string) => void;
  faceTrackingAllowsStt: () => boolean;
  detectAutoAirPodsInput: (rec: Audio.Recording) => Promise<boolean>;
  elapsedSinceMs: (startedAtMs: number) => number | null;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
};

type CreateAutoRecordingStatusHandlerParams = {
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
};

export function useAutoRecordingStatusHandler(options: UseAutoRecordingStatusHandlerOptions) {
  const {
    appStateRef,
    appStateChangedAtRef,
    appStateLastNonActiveAtRef,
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoFinalizeLockRef,
    autoRecordingWatchdogLogAtRef,
    autoStatusNotRecordingSuppressLogAtRef,
    autoLastStatusHandledAtRef,
    autoWaveStatusLastAtRef,
    autoShadowStatusLastAtRef,
    autoShadowStatusLastMeteringRef,
    autoShadowStatusLastDurationMsRef,
    autoStatusReadOwnerRef,
    autoStatusReadStartedAtRef,
    autoWaitReasonRef,
    autoInputDetectAtRef,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    autoWaveformLastSampleAtRef,
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
    autoPlaybackBargeGraceUntilRef,
    autoBargeInProbeLogAtRef,
    autoPendingUserMessageIdRef,
    autoInputNameRef,
    autoAirPodsInputRef,
    autoBargeInEnabledRef,
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoLastTtsStoppedAtRef,
    faceTrackingFaceDetectedRef,
    faceTrackingLookingRef,
    faceTrackingNotLookingSinceRef,
    faceTrackingSuppressedRef,
    faceTrackingSuppressLogAtRef,
    ttsPlayingRef,
    replyLoadingRef,
    streamSocketRef,
    streamTtsControlRef,
    ttsLoading,
    watchdogLogThrottleMs,
    statusNotRecordingAppTransitionGraceMs,
    statusNotRecordingSuppressLogThrottleMs,
    autoInputRoutePollMs,
    autoStartThresholdDb,
    autoStartHoldMs,
    autoStopThresholdDb,
    autoStopSilenceMs,
    autoMinSpeechMs,
    autoMaxSpeechMs,
    autoIdleRolloverMs,
    autoBargeInThresholdOffsetDb,
    autoBargeInAirpodsThresholdOffsetDb,
    autoBargeInHoldMs,
    autoBargeInAirpodsHoldMs,
    autoBargeInHoldGapToleranceMs,
    autoBargeInFastStopAirpodsThresholdDb,
    autoBargeInFastStopStartOffsetDb,
    autoBargeInFastStopHoldMs,
    autoBargeInFastStopCooldownMs,
    autoBargeInProbeLogThrottleMs,
    autoPostTtsHumanHoldMs,
    faceTrackingSttSuppressLogThrottleMs,
    faceTrackingRecordingStopHoldMs,
    setAutoRecordingState,
    setAutoLastEvent,
    maybeLogWaveformStatusTick,
    trackWaveformFlatline,
    clearAutoPendingUserTimeoutTimer,
    resolveAutoPendingUserMessage,
    faceTrackingAllowsStt,
    detectAutoAirPodsInput,
    elapsedSinceMs,
    logAuto,
  } = options;

  const createAutoRecordingStatusHandler = useCallback((params: CreateAutoRecordingStatusHandlerParams) => {
    const {
      rec,
      captureCycleId,
      applyAutoProgressInterval,
      requestBargeInStop,
      finalizeAutoCapture,
      resetSpeechWindowWithoutFinalize,
    } = params;

    return (status: AutoRecordingStatus, statusSource: RecordingStatusSource) => {
      if (!autoRecordingEnabledRef.current) return;
      if (autoRecordingRef.current !== rec || autoFinalizeLockRef.current) return;
      const now = Date.now();
      autoLastStatusHandledAtRef.current = now;
      const callbackGapBeforeMs = (
        autoWaveStatusLastAtRef.current > 0
          ? Math.max(0, now - autoWaveStatusLastAtRef.current)
          : null
      );
      if (
        statusSource === "watchdog" &&
        now - autoRecordingWatchdogLogAtRef.current >= watchdogLogThrottleMs
      ) {
        autoRecordingWatchdogLogAtRef.current = now;
        logAuto("recording_status_watchdog_poll", {
          captureCycleId,
          callbackGapBeforeMs,
          isRecording: Boolean(status?.isRecording),
          canRecord: Boolean(status?.canRecord),
          isDoneRecording: Boolean(status?.isDoneRecording),
          durationMillis: Number(status?.durationMillis || 0),
        });
      }
      if (!status?.isRecording) {
        const sinceAppStateNonActiveMs = elapsedSinceMs(appStateLastNonActiveAtRef.current);
        const suppressForAppStateTransition = (
          appStateRef.current !== "active" ||
          (
            sinceAppStateNonActiveMs !== null &&
            sinceAppStateNonActiveMs < statusNotRecordingAppTransitionGraceMs
          )
        );
        if (suppressForAppStateTransition) {
          if (
            now - autoStatusNotRecordingSuppressLogAtRef.current >=
            statusNotRecordingSuppressLogThrottleMs
          ) {
            autoStatusNotRecordingSuppressLogAtRef.current = now;
            logAuto("status_not_recording_suppressed", {
              captureCycleId,
              statusSource,
              appState: appStateRef.current,
              sinceAppStateChangedMs: elapsedSinceMs(appStateChangedAtRef.current),
              sinceAppStateNonActiveMs,
              graceMs: statusNotRecordingAppTransitionGraceMs,
              canRecord: Boolean(status?.canRecord),
              isDoneRecording: Boolean(status?.isDoneRecording),
              durationMillis: Number(status?.durationMillis || 0),
            });
          }
          return;
        }
        const shadowGapMs = (
          autoShadowStatusLastAtRef.current > 0
            ? Math.max(0, now - autoShadowStatusLastAtRef.current)
            : null
        );
        const callbackGapMs = (
          autoWaveStatusLastAtRef.current > 0
            ? Math.max(0, now - autoWaveStatusLastAtRef.current)
            : null
        );
        logAuto("status_not_recording_diagnostic", {
          captureCycleId,
          statusSource,
          appState: appStateRef.current,
          sinceAppStateChangedMs: elapsedSinceMs(appStateChangedAtRef.current),
          sinceAppStateNonActiveMs,
          callbackGapMs,
          shadowGapMs,
          shadowMetering: autoShadowStatusLastMeteringRef.current,
          shadowDurationMs: autoShadowStatusLastDurationMsRef.current,
          statusReadOwner: autoStatusReadOwnerRef.current || null,
          statusReadInFlightForMs: elapsedSinceMs(autoStatusReadStartedAtRef.current),
          autoRecordingRefMatches: autoRecordingRef.current === rec,
          autoFinalizeLock: autoFinalizeLockRef.current,
          autoWaitReason: autoWaitReasonRef.current || null,
          ttsPlaying: ttsPlayingRef.current,
          ttsLoading,
          replyLoading: replyLoadingRef.current,
          streamSocketAlive: streamSocketRef.current !== null,
          streamTtsControlAlive: streamTtsControlRef.current !== null,
        });
        logAuto("finalize_trigger", {
          reason: "status_not_recording",
          captureCycleId,
          statusSource,
          canRecord: Boolean(status?.canRecord),
          isDoneRecording: Boolean(status?.isDoneRecording),
          durationMillis: Number(status?.durationMillis || 0),
          appState: appStateRef.current,
          sinceAppStateChangedMs: elapsedSinceMs(appStateChangedAtRef.current),
          sinceAppStateNonActiveMs,
          callbackGapMs,
          shadowGapMs,
          statusReadOwner: autoStatusReadOwnerRef.current || null,
          statusReadInFlightForMs: elapsedSinceMs(autoStatusReadStartedAtRef.current),
        });
        void finalizeAutoCapture(false, "status_not_recording");
        return;
      }
      if (now - autoInputDetectAtRef.current >= autoInputRoutePollMs) {
        autoInputDetectAtRef.current = now;
        void detectAutoAirPodsInput(rec);
      }
      const metering = typeof status?.metering === "number" ? status.metering : -160;
      maybeLogWaveformStatusTick("auto", now, status, metering);
      autoUiLatestMeteringRef.current = metering;
      autoUiLatestSpeechSampleRef.current = metering >= autoStartThresholdDb;
      autoWaveformLastSampleAtRef.current = now;

      if (!faceTrackingAllowsStt()) {
        if (!faceTrackingNotLookingSinceRef.current) {
          faceTrackingNotLookingSinceRef.current = now;
        }
        const notLookingForMs = Math.max(0, now - faceTrackingNotLookingSinceRef.current);
        if (
          !faceTrackingSuppressedRef.current ||
          now - faceTrackingSuppressLogAtRef.current >= faceTrackingSttSuppressLogThrottleMs
        ) {
          faceTrackingSuppressedRef.current = true;
          faceTrackingSuppressLogAtRef.current = now;
          logAuto("face_tracking_stt_suppressed", {
            statusSource,
            faceDetected: faceTrackingFaceDetectedRef.current,
            lookState: faceTrackingLookingRef.current,
            metering,
            notLookingForMs,
          });
        }
        autoAboveSinceRef.current = 0;
        autoAboveGapSinceRef.current = 0;
        autoBelowSinceRef.current = 0;
        autoSilenceDeadlineAtRef.current = 0;
        autoClipStartedAtRef.current = now;
        if (autoPendingUserMessageIdRef.current) {
          resolveAutoPendingUserMessage("");
        }
        applyAutoProgressInterval("idle", "face_not_looking");
        setAutoRecordingState("listening");
        setAutoLastEvent("face_not_looking");
        if (notLookingForMs < faceTrackingRecordingStopHoldMs) return;
        logAuto("face_tracking_recording_stop", {
          statusSource,
          faceDetected: faceTrackingFaceDetectedRef.current,
          lookState: faceTrackingLookingRef.current,
          metering,
          notLookingForMs,
          holdMs: faceTrackingRecordingStopHoldMs,
        });
        void finalizeAutoCapture(false, "face_not_looking");
        return;
      }
      faceTrackingNotLookingSinceRef.current = 0;
      if (faceTrackingSuppressedRef.current) {
        faceTrackingSuppressedRef.current = false;
        faceTrackingSuppressLogAtRef.current = now;
        setAutoLastEvent("face_looking_resume");
        logAuto("face_tracking_stt_resumed", {
          statusSource,
          faceDetected: faceTrackingFaceDetectedRef.current,
          lookState: faceTrackingLookingRef.current,
        });
      }

      const playbackGraceActive = (
        autoBargeInEnabledRef.current &&
        now < autoPlaybackBargeGraceUntilRef.current
      );
      const isPlaybackActive = ttsPlayingRef.current || playbackGraceActive;
      const playbackBargeInActive = isPlaybackActive && autoBargeInEnabledRef.current;
      const airPodsRelaxedBargeIn = playbackBargeInActive && autoAirPodsInputRef.current;
      const startThresholdDb = (
        airPodsRelaxedBargeIn
          ? autoStartThresholdDb + autoBargeInAirpodsThresholdOffsetDb
          : playbackBargeInActive
            ? autoStartThresholdDb + autoBargeInThresholdOffsetDb
            : autoStartThresholdDb
      );
      const startHoldMs = (
        airPodsRelaxedBargeIn
          ? autoBargeInAirpodsHoldMs
          : playbackBargeInActive
            ? autoBargeInHoldMs
            : autoStartHoldMs
      );
      const bargeInWindowActive = (
        autoBargeInEnabledRef.current &&
        (
          playbackBargeInActive ||
          replyLoadingRef.current ||
          ttsLoading ||
          streamTtsControlRef.current !== null ||
          streamSocketRef.current !== null
        )
      );
      const nearStartThreshold = metering >= autoStartThresholdDb - 4;
      const nextProgressMode: AutoProgressMode = bargeInWindowActive
        ? "barge"
        : (autoSpeechStartedAtRef.current > 0 || nearStartThreshold ? "speech" : "idle");
      applyAutoProgressInterval(nextProgressMode, "status_tick", {
        statusSource,
        metering,
        bargeInWindowActive,
        nearStartThreshold,
      });
      trackWaveformFlatline({
        source: "auto",
        now,
        metering,
        startThresholdDb,
        startHoldMs,
        bargeInWindowActive,
        playbackBargeInActive,
        isPlaybackActive,
        status,
      });
      const fastStopThresholdDb = Math.max(
        autoBargeInFastStopAirpodsThresholdDb,
        startThresholdDb + autoBargeInFastStopStartOffsetDb,
      );
      const fastStopEligible = (
        ttsPlayingRef.current &&
        autoAirPodsInputRef.current &&
        !autoSpeechStartedAtRef.current &&
        !autoBargeInStoppingRef.current &&
        !autoBargeInDetectedForClipRef.current
      );
      if (fastStopEligible && metering >= fastStopThresholdDb) {
        if (!autoBargeInFastProbeAboveSinceRef.current) {
          autoBargeInFastProbeAboveSinceRef.current = now;
        }
      } else {
        autoBargeInFastProbeAboveSinceRef.current = 0;
      }
      const fastStopAboveForMs = autoBargeInFastProbeAboveSinceRef.current
        ? Math.max(0, now - autoBargeInFastProbeAboveSinceRef.current)
        : 0;
      if (
        fastStopEligible &&
        fastStopAboveForMs >= autoBargeInFastStopHoldMs &&
        now - autoBargeInFastStopAtRef.current >= autoBargeInFastStopCooldownMs
      ) {
        autoBargeInFastStopAtRef.current = now;
        autoBargeInFastProbeAboveSinceRef.current = 0;
        const requested = requestBargeInStop(now, metering, "probe_fast");
        logAuto("barge_in_fast_stop_probe", {
          metering,
          requested,
          thresholdDb: fastStopThresholdDb,
          dynamicHeadroomDb: autoBargeInFastStopStartOffsetDb,
          holdMs: autoBargeInFastStopHoldMs,
          aboveForMs: fastStopAboveForMs,
          cooldownMs: autoBargeInFastStopCooldownMs,
          autoInputName: autoInputNameRef.current,
          autoAirPodsInput: autoAirPodsInputRef.current,
          ttsPlaying: ttsPlayingRef.current,
          ttsLoading,
          streamSocketAlive: streamSocketRef.current !== null,
          streamTtsControlAlive: streamTtsControlRef.current !== null,
        });
      }
      if (!autoSpeechStartedAtRef.current) {
        const meetsStartThreshold = metering >= startThresholdDb;
        const holdGapToleranceMs = playbackBargeInActive
          ? autoBargeInHoldGapToleranceMs
          : 0;
        if (meetsStartThreshold) {
          if (!autoAboveSinceRef.current) autoAboveSinceRef.current = now;
          autoAboveGapSinceRef.current = 0;
        } else if (autoAboveSinceRef.current && holdGapToleranceMs > 0) {
          if (!autoAboveGapSinceRef.current) autoAboveGapSinceRef.current = now;
          if (now - autoAboveGapSinceRef.current > holdGapToleranceMs) {
            autoAboveSinceRef.current = 0;
            autoAboveGapSinceRef.current = 0;
          }
        } else {
          autoAboveSinceRef.current = 0;
          autoAboveGapSinceRef.current = 0;
        }

        const holdWithinTolerance = (
          autoAboveGapSinceRef.current > 0 &&
          now - autoAboveGapSinceRef.current <= holdGapToleranceMs
        );
        const holdCandidate = meetsStartThreshold || holdWithinTolerance;
        if (
          holdCandidate &&
          autoAboveSinceRef.current > 0 &&
          now - autoAboveSinceRef.current >= startHoldMs
        ) {
          autoSpeechStartedAtRef.current = now;
          autoBelowSinceRef.current = 0;
          autoSilenceDeadlineAtRef.current = 0;
          autoAboveGapSinceRef.current = 0;
          autoSpeechStartedDuringTtsRef.current = isPlaybackActive;
          autoPostTtsAboveSinceRef.current = 0;
          autoPostTtsHumanDetectedRef.current = false;
          setAutoRecordingState("speaking");
          clearAutoPendingUserTimeoutTimer();
          logAuto("speech_started", {
            metering,
            statusSource,
            startThresholdDb,
            startHoldMs,
            holdGapToleranceMs,
            isPlaybackActive,
            playbackGraceActive,
            autoBargeInEnabled: autoBargeInEnabledRef.current,
            airPodsRelaxedBargeIn,
          });
          if (isPlaybackActive && autoBargeInEnabledRef.current) {
            const requested = requestBargeInStop(now, metering, "speech_start");
            if (!requested) {
              logAuto("barge_in_skip_on_speech_start", {
                metering,
                statusSource,
                autoBargeInStopping: autoBargeInStoppingRef.current,
                detectedForClip: autoBargeInDetectedForClipRef.current,
                sinceTtsStopRequestedMs: elapsedSinceMs(autoLastTtsStopRequestedAtRef.current),
              });
            }
          } else {
            setAutoLastEvent("speech_detected");
          }
        }

        if (playbackBargeInActive) {
          const aboveForMs = autoAboveSinceRef.current
            ? Math.max(0, now - autoAboveSinceRef.current)
            : 0;
          if (now - autoBargeInProbeLogAtRef.current >= autoBargeInProbeLogThrottleMs) {
            autoBargeInProbeLogAtRef.current = now;
            logAuto("barge_in_probe", {
              metering,
              statusSource,
              meetsStartThreshold,
              aboveForMs,
              startThresholdDb,
              startHoldMs,
              holdGapToleranceMs,
              playbackGraceActive,
              bargeInWindowActive,
              autoAboveSinceMs: autoAboveSinceRef.current,
              autoAboveGapSinceMs: autoAboveGapSinceRef.current,
              autoBargeInStopping: autoBargeInStoppingRef.current,
              detectedForClip: autoBargeInDetectedForClipRef.current,
              autoInputName: autoInputNameRef.current,
              autoAirPodsInput: autoAirPodsInputRef.current,
              ttsPlaying: ttsPlayingRef.current,
              ttsLoading,
            });
          }
        }

        if (bargeInWindowActive) {
          autoClipStartedAtRef.current = now;
        } else if (now - autoClipStartedAtRef.current >= autoIdleRolloverMs) {
          logAuto("idle_rollover_keep_recording", {
            elapsedMs: now - autoClipStartedAtRef.current,
          });
          autoClipStartedAtRef.current = now;
        }
        return;
      }

      const speechMs = now - autoSpeechStartedAtRef.current;
      if (playbackBargeInActive && metering >= autoStopThresholdDb) {
        void requestBargeInStop(now, metering, "ongoing_speech_overlap");
      }
      if (autoSpeechStartedDuringTtsRef.current && !ttsPlayingRef.current) {
        if (metering >= autoStartThresholdDb) {
          if (!autoPostTtsAboveSinceRef.current) autoPostTtsAboveSinceRef.current = now;
          if (now - autoPostTtsAboveSinceRef.current >= autoPostTtsHumanHoldMs) {
            autoPostTtsHumanDetectedRef.current = true;
          }
        } else {
          autoPostTtsAboveSinceRef.current = 0;
        }
      }

      if (metering <= autoStopThresholdDb) {
        if (!autoBelowSinceRef.current) autoBelowSinceRef.current = now;
        autoSilenceDeadlineAtRef.current = autoBelowSinceRef.current + autoStopSilenceMs;
      } else {
        autoBelowSinceRef.current = 0;
        autoSilenceDeadlineAtRef.current = 0;
      }

      if (speechMs >= autoMaxSpeechMs) {
        logAuto("finalize_trigger", {
          reason: "max_speech",
          statusSource,
          speechMs,
          autoMaxSpeechMs: autoMaxSpeechMs,
        });
        void finalizeAutoCapture(true, "max_speech");
        return;
      }

      const silenceDeadlineAt = autoSilenceDeadlineAtRef.current;
      if (silenceDeadlineAt > 0 && now >= silenceDeadlineAt) {
        const shouldTranscribe = speechMs >= autoMinSpeechMs;
        logAuto("finalize_trigger", {
          reason: "silence",
          statusSource,
          speechMs,
          shouldTranscribe,
          silenceMs: autoBelowSinceRef.current > 0 ? now - autoBelowSinceRef.current : autoStopSilenceMs,
          metering,
          sinceBargeInDetectedMs: elapsedSinceMs(autoLastBargeInDetectedAtRef.current),
          sinceTtsStopRequestedMs: elapsedSinceMs(autoLastTtsStopRequestedAtRef.current),
          sinceTtsStoppedMs: elapsedSinceMs(autoLastTtsStoppedAtRef.current),
        });
        if (shouldTranscribe) {
          void finalizeAutoCapture(true, "silence");
        } else {
          resetSpeechWindowWithoutFinalize(now, "short_speech_discarded", {
            speechMs,
            silenceMs: now - autoBelowSinceRef.current,
            metering,
            statusSource,
          });
        }
      }
    };
  }, [
    appStateRef,
    appStateChangedAtRef,
    appStateLastNonActiveAtRef,
    autoAboveGapSinceRef,
    autoAboveSinceRef,
    autoAirPodsInputRef,
    autoBargeInDetectedForClipRef,
    autoBargeInEnabledRef,
    autoBargeInFastProbeAboveSinceRef,
    autoBargeInFastStopAtRef,
    autoBargeInHoldGapToleranceMs,
    autoBargeInHoldMs,
    autoBargeInProbeLogAtRef,
    autoBargeInProbeLogThrottleMs,
    autoBargeInStoppingRef,
    autoBargeInThresholdOffsetDb,
    autoBelowSinceRef,
    autoClipStartedAtRef,
    autoFinalizeLockRef,
    autoIdleRolloverMs,
    autoInputDetectAtRef,
    autoInputNameRef,
    autoInputRoutePollMs,
    autoLastBargeInDetectedAtRef,
    autoLastStatusHandledAtRef,
    autoLastTtsStopRequestedAtRef,
    autoLastTtsStoppedAtRef,
    autoMaxSpeechMs,
    autoMinSpeechMs,
    autoPendingUserMessageIdRef,
    autoPlaybackBargeGraceUntilRef,
    autoPostTtsAboveSinceRef,
    autoPostTtsHumanDetectedRef,
    autoPostTtsHumanHoldMs,
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoRecordingWatchdogLogAtRef,
    autoShadowStatusLastAtRef,
    autoShadowStatusLastDurationMsRef,
    autoShadowStatusLastMeteringRef,
    autoSilenceDeadlineAtRef,
    autoSpeechStartedAtRef,
    autoSpeechStartedDuringTtsRef,
    autoStartHoldMs,
    autoStartThresholdDb,
    autoStatusNotRecordingSuppressLogAtRef,
    autoStatusReadOwnerRef,
    autoStatusReadStartedAtRef,
    autoStopSilenceMs,
    autoStopThresholdDb,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    autoWaitReasonRef,
    autoWaveStatusLastAtRef,
    autoWaveformLastSampleAtRef,
    clearAutoPendingUserTimeoutTimer,
    detectAutoAirPodsInput,
    elapsedSinceMs,
    faceTrackingAllowsStt,
    faceTrackingFaceDetectedRef,
    faceTrackingLookingRef,
    faceTrackingNotLookingSinceRef,
    faceTrackingRecordingStopHoldMs,
    faceTrackingSttSuppressLogThrottleMs,
    faceTrackingSuppressLogAtRef,
    faceTrackingSuppressedRef,
    logAuto,
    maybeLogWaveformStatusTick,
    replyLoadingRef,
    resolveAutoPendingUserMessage,
    setAutoLastEvent,
    setAutoRecordingState,
    statusNotRecordingAppTransitionGraceMs,
    statusNotRecordingSuppressLogThrottleMs,
    streamSocketRef,
    streamTtsControlRef,
    ttsLoading,
    ttsPlayingRef,
    trackWaveformFlatline,
    watchdogLogThrottleMs,
    autoBargeInAirpodsHoldMs,
    autoBargeInAirpodsThresholdOffsetDb,
    autoBargeInFastStopAirpodsThresholdDb,
    autoBargeInFastStopCooldownMs,
    autoBargeInFastStopHoldMs,
    autoBargeInFastStopStartOffsetDb,
  ]);

  return {
    createAutoRecordingStatusHandler,
  };
}
