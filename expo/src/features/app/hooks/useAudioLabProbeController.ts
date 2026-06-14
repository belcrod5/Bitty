import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";
import type { RecordingTuning } from "../utils/audioConfig";

type AudioModeSwitchOptions = {
  reason?: string;
  allowsRecordingIOS?: boolean;
};

type UseAudioLabProbeControllerOptions = {
  audioLabLoopAsset: number;
  audioLabFlatlineDb: number;
  audioLabMeterLogThrottleMs: number;
  audioLabRunning: boolean;
  manualRecording: Audio.Recording | null;
  ttsLoading: boolean;
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  ttsPlayingRef: MutableRefObject<boolean>;
  audioLabActionInFlightRef: MutableRefObject<boolean>;
  audioLabRecordingRef: MutableRefObject<Audio.Recording | null>;
  audioLabSoundRef: MutableRefObject<Audio.Sound | null>;
  audioLabRunIdRef: MutableRefObject<number>;
  audioLabStartedAtRef: MutableRefObject<number>;
  audioLabLastStatusAtRef: MutableRefObject<number>;
  audioLabFlatlineSinceRef: MutableRefObject<number>;
  audioLabMeterLogAtRef: MutableRefObject<number>;
  audioLabPlaybackWantedRef: MutableRefObject<boolean>;
  audioLabPlaybackLastPlayingAtRef: MutableRefObject<number>;
  audioLabPlaybackStatusLogAtRef: MutableRefObject<number>;
  audioLabPlaybackRecoverAtRef: MutableRefObject<number>;
  audioLabPlaybackWatchdogErrorLogAtRef: MutableRefObject<number>;
  audioLabInputNameRef: MutableRefObject<string>;
  audioLabAirPodsInputRef: MutableRefObject<boolean>;
  audioLabRecordingInactiveLoggedRef: MutableRefObject<boolean>;
  recordingTuning: RecordingTuning;
  clearAudioLabInputPollTimer: () => void;
  clearAudioLabPlaybackWatchdogTimer: () => void;
  detectAudioLabInputRoute: (rec: Audio.Recording, reason: string) => Promise<void>;
  startAudioLabInputRoutePolling: () => void;
  bindAudioLabPlaybackStatus: (sound: Audio.Sound, runId: number) => void;
  startAudioLabPlaybackWatchdog: (runId: number) => void;
  stopAudioLabPlaybackOnly: (reason?: string) => Promise<void>;
  stopWaveformPlayback: () => Promise<void>;
  ensureMicReady: () => Promise<void>;
  releaseRecording: (rec: Audio.Recording) => Promise<Audio.RecordingStatus | null>;
  setAudioModeForPlayback: (options?: AudioModeSwitchOptions) => Promise<void>;
  setError: (value: string) => void;
  setAudioLabLastDb: (value: number | null) => void;
  setAudioLabMinDb: (value: number | ((prev: number | null) => number | null) | null) => void;
  setAudioLabMaxDb: (value: number | ((prev: number | null) => number | null) | null) => void;
  setAudioLabFlatlineMs: (value: number) => void;
  setAudioLabCallbackIntervalMs: (value: number | null) => void;
  setAudioLabPlaybackPositionMs: (value: number) => void;
  setAudioLabPlaybackStallMs: (value: number) => void;
  setAudioLabLoopCount: (value: number) => void;
  setAudioLabUnexpectedStopCount: (value: number) => void;
  setAudioLabPlaybackRecoverCount: (value: number) => void;
  setAudioLabInputName: (value: string) => void;
  setAudioLabAirPodsInput: (value: boolean) => void;
  setAudioLabNowMs: (value: number) => void;
  setAudioLabRecordingActive: (value: boolean) => void;
  setAudioLabPlaybackActive: (value: boolean) => void;
  setAudioLabRunning: (value: boolean) => void;
  logAudioLab: (event: string, payload?: Record<string, unknown>) => void;
  reportError: (raw: unknown, scope?: string) => void;
  isRecordingNotAllowedError: (error: unknown) => boolean;
  isRecorderNotPreparedError: (error: unknown) => boolean;
  buildRecordingOptions: (tuning: RecordingTuning) => Audio.RecordingOptions;
  clampRecordingProgressUpdateIntervalMs: (valueRaw: number) => number;
};

export function useAudioLabProbeController(options: UseAudioLabProbeControllerOptions) {
  const {
    audioLabLoopAsset,
    audioLabFlatlineDb,
    audioLabMeterLogThrottleMs,
    audioLabRunning,
    manualRecording,
    ttsLoading,
    autoRecordingEnabledRef,
    ttsPlayingRef,
    audioLabActionInFlightRef,
    audioLabRecordingRef,
    audioLabSoundRef,
    audioLabRunIdRef,
    audioLabStartedAtRef,
    audioLabLastStatusAtRef,
    audioLabFlatlineSinceRef,
    audioLabMeterLogAtRef,
    audioLabPlaybackWantedRef,
    audioLabPlaybackLastPlayingAtRef,
    audioLabPlaybackStatusLogAtRef,
    audioLabPlaybackRecoverAtRef,
    audioLabPlaybackWatchdogErrorLogAtRef,
    audioLabInputNameRef,
    audioLabAirPodsInputRef,
    audioLabRecordingInactiveLoggedRef,
    recordingTuning,
    clearAudioLabInputPollTimer,
    clearAudioLabPlaybackWatchdogTimer,
    detectAudioLabInputRoute,
    startAudioLabInputRoutePolling,
    bindAudioLabPlaybackStatus,
    startAudioLabPlaybackWatchdog,
    stopAudioLabPlaybackOnly,
    stopWaveformPlayback,
    ensureMicReady,
    releaseRecording,
    setAudioModeForPlayback,
    setError,
    setAudioLabLastDb,
    setAudioLabMinDb,
    setAudioLabMaxDb,
    setAudioLabFlatlineMs,
    setAudioLabCallbackIntervalMs,
    setAudioLabPlaybackPositionMs,
    setAudioLabPlaybackStallMs,
    setAudioLabLoopCount,
    setAudioLabUnexpectedStopCount,
    setAudioLabPlaybackRecoverCount,
    setAudioLabInputName,
    setAudioLabAirPodsInput,
    setAudioLabNowMs,
    setAudioLabRecordingActive,
    setAudioLabPlaybackActive,
    setAudioLabRunning,
    logAudioLab,
    reportError,
    isRecordingNotAllowedError,
    isRecorderNotPreparedError,
    buildRecordingOptions,
    clampRecordingProgressUpdateIntervalMs,
  } = options;

  const stopAudioLabProbe = useCallback(async (reason = "manual") => {
    if (audioLabActionInFlightRef.current) return;
    audioLabActionInFlightRef.current = true;
    clearAudioLabInputPollTimer();
    clearAudioLabPlaybackWatchdogTimer();
    audioLabPlaybackWantedRef.current = false;
    logAudioLab("lab_stop_requested", {
      reason,
      running: audioLabRunning,
      recordingActive: Boolean(audioLabRecordingRef.current),
      playbackActive: Boolean(audioLabSoundRef.current),
    });
    try {
      await stopAudioLabPlaybackOnly(`${reason}:playback`);
      const rec = audioLabRecordingRef.current;
      audioLabRecordingRef.current = null;
      if (rec) {
        rec.setOnRecordingStatusUpdate(null);
        let status: Audio.RecordingStatus | null = null;
        try {
          status = await releaseRecording(rec);
        } catch {}
        setAudioLabRecordingActive(false);
        logAudioLab("lab_recording_stopped", {
          reason,
          durationMillis: Number(status?.durationMillis || 0),
        });
      } else {
        setAudioLabRecordingActive(false);
      }
      setAudioLabRunning(false);
      audioLabStartedAtRef.current = 0;
      audioLabLastStatusAtRef.current = 0;
      audioLabFlatlineSinceRef.current = 0;
      audioLabRecordingInactiveLoggedRef.current = false;
      setAudioLabFlatlineMs(0);
      setAudioLabPlaybackStallMs(0);
      await setAudioModeForPlayback({ reason: `audio_lab_stop:${reason}` }).catch(() => {});
      logAudioLab("lab_stop_completed", {
        reason,
        runId: audioLabRunIdRef.current,
      });
    } catch (e) {
      logAudioLab("lab_stop_error", {
        reason,
        runId: audioLabRunIdRef.current,
        message: e instanceof Error ? e.message : String(e),
      });
      reportError(e, "audio-lab:stop");
    } finally {
      audioLabActionInFlightRef.current = false;
    }
  }, [
    audioLabActionInFlightRef,
    clearAudioLabInputPollTimer,
    clearAudioLabPlaybackWatchdogTimer,
    audioLabPlaybackWantedRef,
    logAudioLab,
    audioLabRunning,
    audioLabRecordingRef,
    audioLabSoundRef,
    stopAudioLabPlaybackOnly,
    releaseRecording,
    setAudioLabRecordingActive,
    setAudioLabRunning,
    audioLabStartedAtRef,
    audioLabLastStatusAtRef,
    audioLabFlatlineSinceRef,
    audioLabRecordingInactiveLoggedRef,
    setAudioLabFlatlineMs,
    setAudioLabPlaybackStallMs,
    setAudioModeForPlayback,
    audioLabRunIdRef,
    reportError,
  ]);

  const startAudioLabProbe = useCallback(async () => {
    if (audioLabActionInFlightRef.current) return;
    if (audioLabRecordingRef.current || audioLabSoundRef.current || audioLabRunning) return;
    if (manualRecording) {
      reportError("Audio Lab実行中は手動録音と同時実行できません。", "audio-lab:start");
      return;
    }
    if (autoRecordingEnabledRef.current) {
      reportError("Audio Lab実行前にAuto Recordingを停止してください。", "audio-lab:start");
      return;
    }
    audioLabActionInFlightRef.current = true;
    const startedAt = Date.now();
    const runId = audioLabRunIdRef.current + 1;
    audioLabRunIdRef.current = runId;
    setError("");
    setAudioLabLastDb(null);
    setAudioLabMinDb(null);
    setAudioLabMaxDb(null);
    setAudioLabFlatlineMs(0);
    setAudioLabCallbackIntervalMs(null);
    setAudioLabPlaybackPositionMs(0);
    setAudioLabPlaybackStallMs(0);
    setAudioLabLoopCount(0);
    setAudioLabUnexpectedStopCount(0);
    setAudioLabPlaybackRecoverCount(0);
    setAudioLabInputName("");
    setAudioLabAirPodsInput(false);
    audioLabInputNameRef.current = "";
    audioLabAirPodsInputRef.current = false;
    audioLabLastStatusAtRef.current = 0;
    audioLabFlatlineSinceRef.current = 0;
    audioLabMeterLogAtRef.current = 0;
    audioLabRecordingInactiveLoggedRef.current = false;
    audioLabPlaybackLastPlayingAtRef.current = 0;
    audioLabPlaybackStatusLogAtRef.current = 0;
    audioLabPlaybackRecoverAtRef.current = 0;
    audioLabPlaybackWatchdogErrorLogAtRef.current = 0;
    audioLabPlaybackWantedRef.current = true;
    clearAudioLabInputPollTimer();
    clearAudioLabPlaybackWatchdogTimer();
    let nextRec: Audio.Recording | null = null;
    let nextSound: Audio.Sound | null = null;
    try {
      logAudioLab("lab_start_requested", {
        runId,
        ttsPlaying: ttsPlayingRef.current,
        ttsLoading,
      });
      if (ttsPlayingRef.current || ttsLoading) {
        await stopWaveformPlayback();
        logAudioLab("lab_tts_stopped_for_probe", {});
      }
      await ensureMicReady();
      logAudioLab("lab_audio_mode_set", { allowsRecordingIOS: true });
      nextRec = new Audio.Recording();
      await nextRec.prepareToRecordAsync(buildRecordingOptions(recordingTuning));
      nextRec.setProgressUpdateInterval(clampRecordingProgressUpdateIntervalMs(recordingTuning.progressUpdateIntervalMs));
      nextRec.setOnRecordingStatusUpdate((status: Audio.RecordingStatus) => {
        if (runId !== audioLabRunIdRef.current) return;
        const now = Date.now();
        const metering = typeof status?.metering === "number" ? status.metering : -160;
        const lastAt = audioLabLastStatusAtRef.current;
        const callbackIntervalMs = lastAt > 0 ? Math.max(0, now - lastAt) : null;
        audioLabLastStatusAtRef.current = now;
        setAudioLabNowMs(now);
        setAudioLabLastDb(metering);
        setAudioLabMinDb((prev) => (prev === null ? metering : Math.min(prev, metering)));
        setAudioLabMaxDb((prev) => (prev === null ? metering : Math.max(prev, metering)));
        setAudioLabCallbackIntervalMs(callbackIntervalMs);
        if (metering <= audioLabFlatlineDb) {
          if (audioLabFlatlineSinceRef.current <= 0) {
            audioLabFlatlineSinceRef.current = now;
            setAudioLabFlatlineMs(0);
          } else {
            setAudioLabFlatlineMs(Math.max(0, now - audioLabFlatlineSinceRef.current));
          }
        } else if (audioLabFlatlineSinceRef.current > 0) {
          audioLabFlatlineSinceRef.current = 0;
          setAudioLabFlatlineMs(0);
        }
        if (now - audioLabMeterLogAtRef.current >= audioLabMeterLogThrottleMs) {
          audioLabMeterLogAtRef.current = now;
          logAudioLab("lab_meter_tick", {
            metering,
            durationMillis: Number(status?.durationMillis || 0),
            callbackIntervalMs,
            isRecording: Boolean(status?.isRecording),
          });
        }
        if (status?.isRecording) {
          if (audioLabRecordingInactiveLoggedRef.current) {
            audioLabRecordingInactiveLoggedRef.current = false;
          }
        } else if (!audioLabRecordingInactiveLoggedRef.current) {
          audioLabRecordingInactiveLoggedRef.current = true;
          logAudioLab("lab_recording_inactive_tick", {
            canRecord: Boolean(status?.canRecord),
            durationMillis: Number(status?.durationMillis || 0),
          });
        }
      });
      try {
        await nextRec.startAsync();
      } catch (startError) {
        const retryForNotAllowed = isRecordingNotAllowedError(startError);
        const retryForNotPrepared = isRecorderNotPreparedError(startError);
        if (!retryForNotAllowed && !retryForNotPrepared) {
          throw startError;
        }
        logAudioLab("lab_record_start_retry", {
          reason: retryForNotPrepared ? "recorder_not_prepared" : "recording_not_allowed",
          message: startError instanceof Error ? startError.message : String(startError),
        });
        await ensureMicReady();
        await nextRec.prepareToRecordAsync(buildRecordingOptions(recordingTuning));
        nextRec.setProgressUpdateInterval(clampRecordingProgressUpdateIntervalMs(recordingTuning.progressUpdateIntervalMs));
        await nextRec.startAsync();
      }
      await detectAudioLabInputRoute(nextRec, "start");
      const playback = await Audio.Sound.createAsync(audioLabLoopAsset, {
        shouldPlay: true,
        isLooping: true,
        volume: 0.14,
      });
      nextSound = playback.sound;
      bindAudioLabPlaybackStatus(nextSound, runId);
      audioLabRecordingRef.current = nextRec;
      audioLabSoundRef.current = nextSound;
      nextRec = null;
      nextSound = null;
      audioLabStartedAtRef.current = Date.now();
      setAudioLabNowMs(audioLabStartedAtRef.current);
      audioLabPlaybackLastPlayingAtRef.current = audioLabStartedAtRef.current;
      setAudioLabRecordingActive(true);
      setAudioLabPlaybackActive(true);
      setAudioLabRunning(true);
      startAudioLabInputRoutePolling();
      startAudioLabPlaybackWatchdog(runId);
      logAudioLab("lab_started", {
        runId,
        elapsedPrepareMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (e) {
      audioLabPlaybackWantedRef.current = false;
      clearAudioLabPlaybackWatchdogTimer();
      logAudioLab("lab_start_error", {
        runId,
        message: e instanceof Error ? e.message : String(e),
      });
      if (nextSound) {
        nextSound.setOnPlaybackStatusUpdate(null);
        await nextSound.unloadAsync().catch(() => {});
      }
      if (nextRec) {
        nextRec.setOnRecordingStatusUpdate(null);
        await releaseRecording(nextRec).catch(() => {});
      }
      audioLabRecordingRef.current = null;
      audioLabSoundRef.current = null;
      setAudioLabRunning(false);
      setAudioLabRecordingActive(false);
      setAudioLabPlaybackActive(false);
      audioLabStartedAtRef.current = 0;
      setAudioLabNowMs(0);
      setAudioLabPlaybackStallMs(0);
      await setAudioModeForPlayback({ reason: "audio_lab_start_error_cleanup" }).catch(() => {});
      reportError(e, "audio-lab:start");
    } finally {
      audioLabActionInFlightRef.current = false;
    }
  }, [
    audioLabActionInFlightRef,
    audioLabRecordingRef,
    audioLabSoundRef,
    audioLabRunning,
    manualRecording,
    reportError,
    autoRecordingEnabledRef,
    audioLabRunIdRef,
    setError,
    setAudioLabLastDb,
    setAudioLabMinDb,
    setAudioLabMaxDb,
    setAudioLabFlatlineMs,
    setAudioLabCallbackIntervalMs,
    setAudioLabPlaybackPositionMs,
    setAudioLabPlaybackStallMs,
    setAudioLabLoopCount,
    setAudioLabUnexpectedStopCount,
    setAudioLabPlaybackRecoverCount,
    setAudioLabInputName,
    setAudioLabAirPodsInput,
    audioLabInputNameRef,
    audioLabAirPodsInputRef,
    audioLabLastStatusAtRef,
    audioLabFlatlineSinceRef,
    audioLabMeterLogAtRef,
    audioLabRecordingInactiveLoggedRef,
    audioLabPlaybackLastPlayingAtRef,
    audioLabPlaybackStatusLogAtRef,
    audioLabPlaybackRecoverAtRef,
    audioLabPlaybackWatchdogErrorLogAtRef,
    audioLabPlaybackWantedRef,
    clearAudioLabInputPollTimer,
    clearAudioLabPlaybackWatchdogTimer,
    logAudioLab,
    ttsPlayingRef,
    ttsLoading,
    stopWaveformPlayback,
    ensureMicReady,
    buildRecordingOptions,
    recordingTuning,
    clampRecordingProgressUpdateIntervalMs,
    audioLabFlatlineDb,
    audioLabMeterLogThrottleMs,
    setAudioLabNowMs,
    isRecordingNotAllowedError,
    isRecorderNotPreparedError,
    detectAudioLabInputRoute,
    audioLabLoopAsset,
    bindAudioLabPlaybackStatus,
    audioLabStartedAtRef,
    setAudioLabRecordingActive,
    setAudioLabPlaybackActive,
    setAudioLabRunning,
    startAudioLabInputRoutePolling,
    startAudioLabPlaybackWatchdog,
    releaseRecording,
    setAudioModeForPlayback,
  ]);

  return {
    startAudioLabProbe,
    stopAudioLabProbe,
  };
}
