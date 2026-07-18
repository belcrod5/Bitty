import { usePrepareTtsPlaybackSessionController } from "./usePrepareTtsPlaybackSessionController";

jest.mock("react", () => ({
  useCallback: <T,>(callback: T) => callback,
}));

function ref<T>(current: T) {
  return { current };
}

describe("usePrepareTtsPlaybackSessionController", () => {
  it("pauses only the active capture before device-speaker playback", async () => {
    const autoRecordingEnabledRef = ref(true);
    const finalizeAutoCapture = jest.fn(async () => {});
    const setAudioModeForPlayback = jest.fn(async () => {});
    const prepareTtsPlaybackSession = usePrepareTtsPlaybackSessionController({
      autoRecordingEnabledRef,
      autoBargeInEnabledRef: ref(true),
      autoSpeakerPriorityEnabledRef: ref(true),
      detectAutoAirPodsInput: jest.fn(async () => false),
      finalizeAutoCapture,
      setAudioModeForPlayback,
      logAuto: jest.fn(),
    });

    await prepareTtsPlaybackSession();

    expect(finalizeAutoCapture).toHaveBeenCalledWith(false, "tts_playback");
    expect(autoRecordingEnabledRef.current).toBe(true);
    expect(setAudioModeForPlayback).toHaveBeenCalledWith({
      reason: "prepare_tts_playback",
      allowsRecordingIOS: false,
    });
  });

  it("pauses AirPods capture when TTS playback has priority", async () => {
    const finalizeAutoCapture = jest.fn(async () => {});
    const setAudioModeForPlayback = jest.fn(async () => {});
    const prepareTtsPlaybackSession = usePrepareTtsPlaybackSessionController({
      autoRecordingEnabledRef: ref(true),
      autoBargeInEnabledRef: ref(true),
      autoSpeakerPriorityEnabledRef: ref(true),
      detectAutoAirPodsInput: jest.fn(async () => true),
      finalizeAutoCapture,
      setAudioModeForPlayback,
      logAuto: jest.fn(),
    });

    await prepareTtsPlaybackSession();

    expect(finalizeAutoCapture).toHaveBeenCalledWith(false, "tts_playback");
    expect(setAudioModeForPlayback).toHaveBeenCalledWith({
      reason: "prepare_tts_playback",
      allowsRecordingIOS: false,
    });
  });

  it("keeps capture available only when barge-in is on and playback priority is off", async () => {
    const finalizeAutoCapture = jest.fn(async () => {});
    const setAudioModeForPlayback = jest.fn(async () => {});
    const prepareTtsPlaybackSession = usePrepareTtsPlaybackSessionController({
      autoRecordingEnabledRef: ref(true),
      autoBargeInEnabledRef: ref(true),
      autoSpeakerPriorityEnabledRef: ref(false),
      detectAutoAirPodsInput: jest.fn(async () => true),
      finalizeAutoCapture,
      setAudioModeForPlayback,
      logAuto: jest.fn(),
    });

    await prepareTtsPlaybackSession();

    expect(finalizeAutoCapture).not.toHaveBeenCalled();
    expect(setAudioModeForPlayback).toHaveBeenCalledWith({
      reason: "prepare_tts_playback",
      allowsRecordingIOS: true,
    });
  });
});
