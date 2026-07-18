import { Audio } from "expo-av";
import { useAudioInputRouteController } from "./useAudioInputRouteController";

jest.mock("react", () => ({
  useCallback: <T,>(callback: T) => callback,
}));

jest.mock("expo-av", () => ({
  Audio: {
    setAudioModeAsync: jest.fn(async () => {}),
  },
}));

function ref<T>(current: T) {
  return { current };
}

function createHarness(recordingActive: boolean) {
  const autoRecordingRef = ref(recordingActive ? ({} as never) : null);
  const controller = useAudioInputRouteController({
    autoRecordingRef,
    autoAirPodsInputRef: ref(false),
    autoInputNameRef: ref("iPhone Microphone"),
    autoInputDetectErrorLogAtRef: ref(0),
    autoAudioModeSkipLogAtRef: ref(0),
    autoRecordingEnabledRef: ref(true),
    ttsPlayingRef: ref(false),
    replyLoadingRef: ref(false),
    ttsLoading: false,
    autoInputErrorLogThrottleMs: 1_000,
    autoAudioModeSkipLogThrottleMs: 1_000,
    setAutoInputName: jest.fn(),
    setAutoAirPodsInput: jest.fn(),
    logAuto: jest.fn(),
  });
  return { autoRecordingRef, controller };
}

describe("useAudioInputRouteController", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("switches to playback mode after capture is released while auto mode stays enabled", async () => {
    const { controller } = createHarness(false);

    await controller.setAudioModeForPlayback({ reason: "prepare_tts_playback" });

    expect(Audio.setAudioModeAsync).toHaveBeenCalledWith({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      playThroughEarpieceAndroid: false,
      shouldDuckAndroid: true,
    });
  });

  it("does not change the audio session while a capture is active", async () => {
    const { controller } = createHarness(true);

    await controller.setAudioModeForPlayback({ reason: "active_capture" });

    expect(Audio.setAudioModeAsync).not.toHaveBeenCalled();
  });
});
