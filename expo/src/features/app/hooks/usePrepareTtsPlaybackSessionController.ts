import { useCallback } from "react";

type AudioModeSwitchOptions = {
  reason?: string;
  allowsRecordingIOS?: boolean;
};

type UsePrepareTtsPlaybackSessionControllerOptions = {
  voiceInputDuringTtsAllowed: boolean;
  isVoiceInputArmed: () => boolean;
  isVoiceInputCapturing: () => boolean;
  abortCapturingVoiceInput: () => Promise<void>;
  setAudioModeForPlayback: (options?: AudioModeSwitchOptions) => Promise<void>;
};

export function usePrepareTtsPlaybackSessionController(
  options: UsePrepareTtsPlaybackSessionControllerOptions
) {
  const {
    voiceInputDuringTtsAllowed,
    isVoiceInputArmed,
    isVoiceInputCapturing,
    abortCapturingVoiceInput,
    setAudioModeForPlayback,
  } = options;

  return useCallback(async () => {
    const voiceInputArmed = isVoiceInputArmed();
    if (isVoiceInputCapturing() && !voiceInputDuringTtsAllowed) {
      await abortCapturingVoiceInput();
    }
    await setAudioModeForPlayback({
      reason: "prepare_tts_playback",
      allowsRecordingIOS: voiceInputArmed && voiceInputDuringTtsAllowed,
    });
  }, [
    abortCapturingVoiceInput,
    isVoiceInputArmed,
    isVoiceInputCapturing,
    setAudioModeForPlayback,
    voiceInputDuringTtsAllowed,
  ]);
}
