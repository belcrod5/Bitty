import { useCallback, useState } from "react";
import { Audio } from "expo-av";
import {
  buildRecordingOptions,
  clampRecordingProgressUpdateIntervalMs,
  type RecordingTuning,
} from "../utils/audioConfig";
import { isRecorderNotPreparedError, isRecordingNotAllowedError } from "../utils/audioSession";

type UseManualRecordingControllerOptions = {
  audioLabRunning: boolean;
  audioLabRecordingActive: boolean;
  audioLabPlaybackActive: boolean;
  autoRecordingEnabled: boolean;
  recordingTuning: RecordingTuning;
  autoTranscribeOnStop: boolean;
  ensureMicReady: () => Promise<void>;
  onManualMeteringTick: (status: Audio.RecordingStatus, metering: number, now: number) => void;
  resetAutoWaveform: () => void;
  setAudioModeForPlayback: (options?: { force?: boolean; reason?: string; allowsRecordingIOS?: boolean }) => Promise<void>;
  transcribeRecording: (uriOverride?: string) => Promise<void>;
  setErrorMessage: (message: string) => void;
  playUiSfx: (key: "recordStart" | "recordStop") => void;
  reportError: (raw: unknown, scope?: string) => void;
};

export function useManualRecordingController(options: UseManualRecordingControllerOptions) {
  const {
    audioLabRunning,
    audioLabRecordingActive,
    audioLabPlaybackActive,
    autoRecordingEnabled,
    recordingTuning,
    autoTranscribeOnStop,
    ensureMicReady,
    onManualMeteringTick,
    resetAutoWaveform,
    setAudioModeForPlayback,
    transcribeRecording,
    setErrorMessage,
    playUiSfx,
    reportError,
  } = options;

  const [manualRecording, setManualRecording] = useState<Audio.Recording | null>(null);
  const [recordingUri, setRecordingUri] = useState("");
  const [recordingSec, setRecordingSec] = useState(0);

  const startRecording = useCallback(async () => {
    if (audioLabRecordingActive || audioLabPlaybackActive || audioLabRunning) {
      reportError("Audio Lab実行中は手動録音できません。", "manual:start");
      return;
    }
    if (autoRecordingEnabled) {
      reportError("自動録音モード中は手動録音できません。", "manual:start");
      return;
    }
    setErrorMessage("");
    try {
      await ensureMicReady();

      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(buildRecordingOptions(recordingTuning));
      rec.setProgressUpdateInterval(
        clampRecordingProgressUpdateIntervalMs(recordingTuning.progressUpdateIntervalMs)
      );
      resetAutoWaveform();
      rec.setOnRecordingStatusUpdate((status) => {
        if (!status.isRecording) return;
        const now = Date.now();
        const metering = typeof status.metering === "number" ? status.metering : -160;
        onManualMeteringTick(status, metering, now);
      });
      try {
        await rec.startAsync();
      } catch (startError) {
        const retryForNotAllowed = isRecordingNotAllowedError(startError);
        const retryForNotPrepared = isRecorderNotPreparedError(startError);
        if (!retryForNotAllowed && !retryForNotPrepared) {
          throw startError;
        }
        await ensureMicReady();
        await rec.prepareToRecordAsync(buildRecordingOptions(recordingTuning));
        rec.setProgressUpdateInterval(
          clampRecordingProgressUpdateIntervalMs(recordingTuning.progressUpdateIntervalMs)
        );
        await rec.startAsync();
      }

      setManualRecording(rec);
      setRecordingUri("");
      setRecordingSec(0);
      playUiSfx("recordStart");
    } catch (error) {
      reportError(error, "manual:start");
    }
  }, [
    audioLabPlaybackActive,
    audioLabRecordingActive,
    audioLabRunning,
    autoRecordingEnabled,
    ensureMicReady,
    onManualMeteringTick,
    playUiSfx,
    recordingTuning,
    reportError,
    resetAutoWaveform,
    setErrorMessage,
  ]);

  const stopRecording = useCallback(async () => {
    if (!manualRecording) return;
    setErrorMessage("");
    try {
      const status = await manualRecording.getStatusAsync();
      manualRecording.setOnRecordingStatusUpdate(null);
      if (status.isRecording) {
        await manualRecording.stopAndUnloadAsync();
      }
      const uri = manualRecording.getURI() || "";
      setRecordingUri(uri);
      setRecordingSec(Math.round((status.durationMillis || 0) / 1000));
      setManualRecording(null);
      await setAudioModeForPlayback({ reason: "stop_manual_recording" }).catch(() => {});
      playUiSfx("recordStop");
      if (uri && autoTranscribeOnStop) {
        await transcribeRecording(uri);
      }
      resetAutoWaveform();
    } catch (error) {
      reportError(error, "manual:stop");
    }
  }, [
    autoTranscribeOnStop,
    manualRecording,
    playUiSfx,
    reportError,
    resetAutoWaveform,
    setAudioModeForPlayback,
    setErrorMessage,
    transcribeRecording,
  ]);

  const setRecordedClip = useCallback((uri: string, sec: number) => {
    setRecordingUri(String(uri || ""));
    setRecordingSec(Math.max(0, Math.round(Number(sec) || 0)));
  }, []);

  const clearRecordedClip = useCallback(() => {
    setRecordingUri("");
    setRecordingSec(0);
  }, []);

  return {
    manualRecording,
    recordingUri,
    recordingSec,
    startRecording,
    stopRecording,
    setRecordedClip,
    clearRecordedClip,
  };
}
