import type { MutableRefObject } from "react";
import { Audio } from "expo-av";
import type { AppStateStatus } from "react-native";
import type { StreamTtsControlState } from "../types/appTypes";

type UseAutoWaveformDiagnosticsOptions = {
  appStateRef: MutableRefObject<AppStateStatus>;
  autoFinalizeLockRef: MutableRefObject<boolean>;
  autoRecordingRef: MutableRefObject<Audio.Recording | null>;
  autoWaveStatusTickLogAtRef: MutableRefObject<number>;
  autoWaveStatusLastAtRef: MutableRefObject<number>;
  manualWaveStatusTickLogAtRef: MutableRefObject<number>;
  manualWaveStatusLastAtRef: MutableRefObject<number>;
  autoWavePathLogAtRef: MutableRefObject<number>;
  autoWaveFlatlineSinceRef: MutableRefObject<number>;
  autoWaveFlatlineLogAtRef: MutableRefObject<number>;
  autoWaveFlatlineActiveRef: MutableRefObject<boolean>;
  autoWaveFlatlineSourceRef: MutableRefObject<"auto" | "manual" | "">;
  autoInputNameRef: MutableRefObject<string>;
  autoAirPodsInputRef: MutableRefObject<boolean>;
  ttsPlayingRef: MutableRefObject<boolean>;
  replyLoadingRef: MutableRefObject<boolean>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  autoStatusReadInFlightRef: MutableRefObject<Promise<Audio.RecordingStatus> | null>;
  autoStatusReadOwnerRef: MutableRefObject<"watchdog" | "">;
  autoStatusReadStartedAtRef: MutableRefObject<number>;
  autoStatusReadSkipLogAtRef: MutableRefObject<number>;
  manualRecordingActive: boolean;
  ttsLoading: boolean;
  diagnosticsEnabled: boolean;
  waveformStatusLogThrottleMs: number;
  waveformPathLogThrottleMs: number;
  waveformFlatlineDb: number;
  waveformFlatlineHoldMs: number;
  waveformFlatlineLogThrottleMs: number;
  statusReadSkipLogThrottleMs: number;
  elapsedSinceMs: (startedAtMs: number) => number | null;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
};

export function useAutoWaveformDiagnostics(options: UseAutoWaveformDiagnosticsOptions) {
  const {
    appStateRef,
    autoFinalizeLockRef,
    autoRecordingRef,
    autoWaveStatusTickLogAtRef,
    autoWaveStatusLastAtRef,
    manualWaveStatusTickLogAtRef,
    manualWaveStatusLastAtRef,
    autoWavePathLogAtRef,
    autoWaveFlatlineSinceRef,
    autoWaveFlatlineLogAtRef,
    autoWaveFlatlineActiveRef,
    autoWaveFlatlineSourceRef,
    autoInputNameRef,
    autoAirPodsInputRef,
    ttsPlayingRef,
    replyLoadingRef,
    streamSocketRef,
    streamTtsControlRef,
    autoStatusReadInFlightRef,
    autoStatusReadOwnerRef,
    autoStatusReadStartedAtRef,
    autoStatusReadSkipLogAtRef,
    manualRecordingActive,
    ttsLoading,
    diagnosticsEnabled,
    waveformStatusLogThrottleMs,
    waveformPathLogThrottleMs,
    waveformFlatlineDb,
    waveformFlatlineHoldMs,
    waveformFlatlineLogThrottleMs,
    statusReadSkipLogThrottleMs,
    elapsedSinceMs,
    logAuto,
  } = options;

  function maybeLogWaveformStatusTick(
    source: "auto" | "manual",
    now: number,
    status: Audio.RecordingStatus,
    metering: number
  ) {
    const isAuto = source === "auto";
    const tickLogAtRef = isAuto ? autoWaveStatusTickLogAtRef : manualWaveStatusTickLogAtRef;
    const lastAtRef = isAuto ? autoWaveStatusLastAtRef : manualWaveStatusLastAtRef;
    const callbackIntervalMs = lastAtRef.current > 0 ? Math.max(0, now - lastAtRef.current) : null;
    lastAtRef.current = now;
    if (!diagnosticsEnabled) return;
    if (now - tickLogAtRef.current < waveformStatusLogThrottleMs) return;
    tickLogAtRef.current = now;
    logAuto("waveform_status_tick", {
      source,
      isRecording: Boolean(status?.isRecording),
      canRecord: Boolean(status?.canRecord),
      isDoneRecording: Boolean(status?.isDoneRecording),
      durationMillis: Number(status?.durationMillis || 0),
      metering,
      callbackIntervalMs,
      autoFinalizeLock: autoFinalizeLockRef.current,
      autoRecordingRefActive: Boolean(autoRecordingRef.current),
      manualRecordingActive,
    });
  }

  function maybeLogWaveformSamplePath(now: number, payload: Record<string, unknown>) {
    if (!diagnosticsEnabled) return;
    if (now - autoWavePathLogAtRef.current < waveformPathLogThrottleMs) return;
    autoWavePathLogAtRef.current = now;
    logAuto("waveform_sample_path", payload);
  }

  function trackWaveformFlatline(input: {
    source: "auto" | "manual";
    now: number;
    metering: number;
    startThresholdDb?: number | null;
    startHoldMs?: number | null;
    bargeInWindowActive?: boolean;
    playbackBargeInActive?: boolean;
    isPlaybackActive?: boolean;
    status?: Audio.RecordingStatus;
  }) {
    if (!diagnosticsEnabled) return;
    const {
      source,
      now,
      metering,
      startThresholdDb = null,
      startHoldMs = null,
      bargeInWindowActive = false,
      playbackBargeInActive = false,
      isPlaybackActive = false,
      status = null,
    } = input;

    if (autoWaveFlatlineSourceRef.current && autoWaveFlatlineSourceRef.current !== source) {
      autoWaveFlatlineSourceRef.current = source;
      autoWaveFlatlineSinceRef.current = 0;
      autoWaveFlatlineLogAtRef.current = 0;
      autoWaveFlatlineActiveRef.current = false;
    } else if (!autoWaveFlatlineSourceRef.current) {
      autoWaveFlatlineSourceRef.current = source;
    }

    const isFlatline = metering <= waveformFlatlineDb;
    if (!isFlatline) {
      if (autoWaveFlatlineActiveRef.current && autoWaveFlatlineSinceRef.current > 0) {
        logAuto("waveform_flatline_recovered", {
          source,
          metering,
          flatForMs: Math.max(0, now - autoWaveFlatlineSinceRef.current),
          startThresholdDb,
          startHoldMs,
          bargeInWindowActive,
          playbackBargeInActive,
          isPlaybackActive,
          appState: appStateRef.current,
          autoInputName: autoInputNameRef.current,
          autoAirPodsInput: autoAirPodsInputRef.current,
          ttsPlaying: ttsPlayingRef.current,
          ttsLoading,
          replyLoading: replyLoadingRef.current,
          streamSocketAlive: streamSocketRef.current !== null,
          streamTtsControlAlive: streamTtsControlRef.current !== null,
          isRecording: Boolean(status?.isRecording),
          durationMillis: Number(status?.durationMillis || 0),
        });
      }
      autoWaveFlatlineSinceRef.current = 0;
      autoWaveFlatlineActiveRef.current = false;
      return;
    }

    if (!autoWaveFlatlineSinceRef.current) {
      autoWaveFlatlineSinceRef.current = now;
    }
    const flatForMs = Math.max(0, now - autoWaveFlatlineSinceRef.current);
    if (flatForMs < waveformFlatlineHoldMs) return;
    if (
      autoWaveFlatlineActiveRef.current &&
      now - autoWaveFlatlineLogAtRef.current < waveformFlatlineLogThrottleMs
    ) {
      return;
    }

    autoWaveFlatlineActiveRef.current = true;
    autoWaveFlatlineLogAtRef.current = now;
    logAuto("waveform_flatline_detected", {
      source,
      metering,
      flatThresholdDb: waveformFlatlineDb,
      flatForMs,
      startThresholdDb,
      startHoldMs,
      bargeInWindowActive,
      playbackBargeInActive,
      isPlaybackActive,
      appState: appStateRef.current,
      autoInputName: autoInputNameRef.current,
      autoAirPodsInput: autoAirPodsInputRef.current,
      ttsPlaying: ttsPlayingRef.current,
      ttsLoading,
      replyLoading: replyLoadingRef.current,
      streamSocketAlive: streamSocketRef.current !== null,
      streamTtsControlAlive: streamTtsControlRef.current !== null,
      isRecording: Boolean(status?.isRecording),
      durationMillis: Number(status?.durationMillis || 0),
    });
  }

  function readAutoRecordingStatus(
    rec: Audio.Recording,
    source: "watchdog",
    timeoutMs: number
  ) {
    if (autoStatusReadInFlightRef.current) {
      const now = Date.now();
      if (now - autoStatusReadSkipLogAtRef.current >= statusReadSkipLogThrottleMs) {
        autoStatusReadSkipLogAtRef.current = now;
        logAuto("status_read_skip_inflight", {
          source,
          owner: autoStatusReadOwnerRef.current,
          inFlightForMs: elapsedSinceMs(autoStatusReadStartedAtRef.current),
        });
      }
      return null;
    }
    autoStatusReadOwnerRef.current = source;
    autoStatusReadStartedAtRef.current = Date.now();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`status_read_timeout:${source}:${timeoutMs}`));
      }, Math.max(80, timeoutMs));
    });
    const statusPromise = Promise.race([rec.getStatusAsync(), timeoutPromise]).finally(() => {
      if (autoStatusReadInFlightRef.current === statusPromise) {
        autoStatusReadInFlightRef.current = null;
        autoStatusReadOwnerRef.current = "";
        autoStatusReadStartedAtRef.current = 0;
      }
    });
    autoStatusReadInFlightRef.current = statusPromise;
    return statusPromise;
  }

  async function readRecordingStatusWithTimeout(
    rec: Audio.Recording,
    timeoutMs: number,
    source: string
  ) {
    return await new Promise<Audio.RecordingStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`status_read_timeout:${source}:${Math.max(0, timeoutMs)}`));
      }, Math.max(80, timeoutMs));
      void rec.getStatusAsync()
        .then((status) => {
          clearTimeout(timer);
          resolve(status);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  return {
    maybeLogWaveformStatusTick,
    maybeLogWaveformSamplePath,
    trackWaveformFlatline,
    readAutoRecordingStatus,
    readRecordingStatusWithTimeout,
  };
}
