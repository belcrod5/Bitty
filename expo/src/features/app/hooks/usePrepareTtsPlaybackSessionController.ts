import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";

type AudioModeSwitchOptions = {
  reason?: string;
  allowsRecordingIOS?: boolean;
};

type UsePrepareTtsPlaybackSessionControllerOptions = {
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  autoSpeakerPriorityEnabledRef: MutableRefObject<boolean>;
  autoBargeInEnabledRef: MutableRefObject<boolean>;
  autoRecordingRef: MutableRefObject<Audio.Recording | null>;
  detectAutoAirPodsInput: () => Promise<boolean>;
  stopAutoRecordingMode: () => Promise<void>;
  setAudioModeForPlayback: (options?: AudioModeSwitchOptions) => Promise<void>;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
};

export function usePrepareTtsPlaybackSessionController(
  options: UsePrepareTtsPlaybackSessionControllerOptions
) {
  const {
    autoRecordingEnabledRef,
    autoSpeakerPriorityEnabledRef,
    autoBargeInEnabledRef,
    autoRecordingRef,
    detectAutoAirPodsInput,
    stopAutoRecordingMode,
    setAudioModeForPlayback,
    logAuto,
  } = options;

  return useCallback(async () => {
    const airPodsInputActive = await detectAutoAirPodsInput();
    if (
      autoRecordingEnabledRef.current &&
      autoSpeakerPriorityEnabledRef.current &&
      !airPodsInputActive
    ) {
      logAuto("tts_playback_stop_auto_recording", {
        reason: "speaker_priority_non_airpods",
        airPodsInputActive,
        autoBargeInEnabled: autoBargeInEnabledRef.current,
        autoRecordingActive: Boolean(autoRecordingRef.current),
      });
      try {
        await stopAutoRecordingMode();
      } catch (error) {
        logAuto("tts_playback_stop_auto_recording_error", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await setAudioModeForPlayback({
      reason: "prepare_tts_playback",
      allowsRecordingIOS: airPodsInputActive,
    });
  }, [
    autoBargeInEnabledRef,
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoSpeakerPriorityEnabledRef,
    detectAutoAirPodsInput,
    logAuto,
    setAudioModeForPlayback,
    stopAutoRecordingMode,
  ]);
}
