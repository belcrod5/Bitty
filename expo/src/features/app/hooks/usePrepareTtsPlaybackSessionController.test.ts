import { usePrepareTtsPlaybackSessionController } from "./usePrepareTtsPlaybackSessionController";

jest.mock("react", () => ({ useCallback: <T,>(callback: T) => callback }));

describe("usePrepareTtsPlaybackSessionController", () => {
  it.each([
    { armed: false, capturing: false, eligible: true, allowsRecording: false, aborts: false },
    { armed: true, capturing: false, eligible: true, allowsRecording: true, aborts: false },
    { armed: true, capturing: true, eligible: false, allowsRecording: false, aborts: true },
    { armed: true, capturing: false, eligible: false, allowsRecording: false, aborts: false },
  ])("arbitrates an armed/capturing voice session %#", async ({
    armed,
    capturing,
    eligible,
    allowsRecording,
    aborts,
  }) => {
    const setAudioModeForPlayback = jest.fn(async () => {});
    const abortCapturingVoiceInput = jest.fn(async () => {});
    const prepare = usePrepareTtsPlaybackSessionController({
      voiceInputDuringTtsAllowed: eligible,
      isVoiceInputArmed: () => armed,
      isVoiceInputCapturing: () => capturing,
      abortCapturingVoiceInput,
      setAudioModeForPlayback,
    });

    await prepare();

    expect(abortCapturingVoiceInput).toHaveBeenCalledTimes(aborts ? 1 : 0);
    expect(setAudioModeForPlayback).toHaveBeenCalledWith({
      reason: "prepare_tts_playback",
      allowsRecordingIOS: allowsRecording,
    });
  });
});
