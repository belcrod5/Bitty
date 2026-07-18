import { useCallback, type MutableRefObject } from "react";
import { shouldAllowAutoCaptureDuringTts } from "../utils/autoAudioPolicy";

type AudioModeSwitchOptions = {
  reason?: string;
  allowsRecordingIOS?: boolean;
};

type UsePrepareTtsPlaybackSessionControllerOptions = {
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  autoBargeInEnabledRef: MutableRefObject<boolean>;
  autoSpeakerPriorityEnabledRef: MutableRefObject<boolean>;
  detectAutoAirPodsInput: () => Promise<boolean>;
  finalizeAutoCapture: (shouldTranscribe: boolean, reason: string) => Promise<void>;
  setAudioModeForPlayback: (options?: AudioModeSwitchOptions) => Promise<void>;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
};

export function usePrepareTtsPlaybackSessionController(
  options: UsePrepareTtsPlaybackSessionControllerOptions
) {
  const {
    autoRecordingEnabledRef,
    autoBargeInEnabledRef,
    autoSpeakerPriorityEnabledRef,
    detectAutoAirPodsInput,
    finalizeAutoCapture,
    setAudioModeForPlayback,
    logAuto,
  } = options;

  return useCallback(async () => {
    const airPodsInputActive = await detectAutoAirPodsInput();
    const captureAllowedDuringTts = shouldAllowAutoCaptureDuringTts({
      autoBargeInEnabled: autoBargeInEnabledRef.current,
      autoSpeakerPriorityEnabled: autoSpeakerPriorityEnabledRef.current,
    });
    if (
      autoRecordingEnabledRef.current &&
      !captureAllowedDuringTts
    ) {
      logAuto("tts_playback_pause_auto_capture", {
        reason: autoSpeakerPriorityEnabledRef.current
          ? "tts_playback_priority"
          : "barge_in_disabled",
        airPodsInputActive,
      });
      try {
        await finalizeAutoCapture(false, "tts_playback");
      } catch (error) {
        logAuto("tts_playback_pause_auto_capture_error", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await setAudioModeForPlayback({
      reason: "prepare_tts_playback",
      allowsRecordingIOS: autoRecordingEnabledRef.current && captureAllowedDuringTts,
    });
  }, [
    autoBargeInEnabledRef,
    autoRecordingEnabledRef,
    autoSpeakerPriorityEnabledRef,
    detectAutoAirPodsInput,
    finalizeAutoCapture,
    logAuto,
    setAudioModeForPlayback,
  ]);
}
