import { useAutoCaptureCycleRecovery } from "./useAutoCaptureCycleRecovery";

jest.mock("react", () => ({
  useCallback: <T,>(callback: T) => callback,
  useEffect: () => undefined,
  useRef: <T,>(current: T) => ({ current }),
}));

jest.mock("expo-av", () => ({
  Audio: {},
}));

type RecoveryOptions = Parameters<typeof useAutoCaptureCycleRecovery>[0];

function ref<T>(current: T) {
  return { current };
}

function createHarness() {
  const autoRecordingEnabledRef = ref(true);
  const autoSpeechStartedAtRef = ref(0);
  const autoBargeInStoppingRef = ref(false);
  const autoBargeInDetectedForClipRef = ref(false);
  const setAutoLastEvent = jest.fn();
  const logAuto = jest.fn();
  const stopTtsPlayback = jest.fn(async () => {});
  const options: RecoveryOptions = {
    autoRecordingEnabledRef,
    autoBargeInEnabledRef: ref(true),
    autoSpeakerPriorityEnabledRef: ref(false),
    autoRecordingRef: ref(null),
    autoFinalizeLockRef: ref(false),
    autoRestartTimerRef: ref(null),
    autoClipStartedAtRef: ref(0),
    autoSpeechStartedAtRef,
    autoAboveSinceRef: ref(0),
    autoAboveGapSinceRef: ref(0),
    autoBelowSinceRef: ref(0),
    autoSilenceDeadlineAtRef: ref(0),
    autoBargeInStoppingRef,
    autoBargeInDetectedForClipRef,
    autoBargeInFastStopAtRef: ref(0),
    autoBargeInFastProbeAboveSinceRef: ref(0),
    autoSpeechStartedDuringTtsRef: ref(false),
    autoPostTtsAboveSinceRef: ref(0),
    autoPostTtsHumanDetectedRef: ref(false),
    autoUiLatestMeteringRef: ref<number | null>(null),
    autoUiLatestSpeechSampleRef: ref(false),
    autoLastBargeInDetectedAtRef: ref(0),
    autoLastTtsStopRequestedAtRef: ref(0),
    autoInputNameRef: ref(""),
    autoAirPodsInputRef: ref(true),
    ttsPlayingRef: ref(true),
    replyLoadingRef: ref(false),
    streamSocketRef: ref<WebSocket | null>(null),
    streamTtsControlRef: ref(null),
    ttsPlaybackMessageIdRef: ref(""),
    ttsLoading: false,
    isRecordingNotAllowedError: () => false,
    isRecorderNotPreparedError: () => false,
    ensureMicReady: jest.fn(async () => {}),
    setAutoLastEvent,
    elapsedSinceMs: () => null,
    logAuto,
  };

  const recovery = useAutoCaptureCycleRecovery(options);
  const requestBargeInStop = recovery.createRequestBargeInStop({
    stopTtsPlayback,
    setAutoLastEvent,
  });

  return {
    options,
    autoSpeechStartedAtRef,
    autoBargeInDetectedForClipRef,
    logAuto,
    requestBargeInStop,
    stopTtsPlayback,
  };
}

describe("useAutoCaptureCycleRecovery", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("stops TTS directly and resets a false fast probe without a UI message", () => {
    const harness = createHarness();

    expect(harness.requestBargeInStop(1_000, -30, "probe_fast")).toBe(true);
    expect(harness.stopTtsPlayback).toHaveBeenCalledWith({
      interruptStream: true,
      reason: "auto_barge_in",
    });
    expect(harness.autoBargeInDetectedForClipRef.current).toBe(true);

    jest.advanceTimersByTime(1_200);

    expect(harness.autoBargeInDetectedForClipRef.current).toBe(false);
    expect(harness.logAuto).toHaveBeenCalledWith("barge_in_flags_reset", {
      phase: "probe_timeout",
      autoBargeInStopping: false,
      detectedForClip: false,
    });
  });

  it("keeps the barge-in flag when the fast probe becomes real speech", () => {
    const harness = createHarness();

    harness.requestBargeInStop(1_000, -30, "probe_fast");
    harness.autoSpeechStartedAtRef.current = 1_100;
    jest.advanceTimersByTime(1_200);

    expect(harness.autoBargeInDetectedForClipRef.current).toBe(true);
  });

  it("does not stop TTS when playback priority is enabled", () => {
    const harness = createHarness();
    harness.options.autoSpeakerPriorityEnabledRef.current = true;

    expect(harness.requestBargeInStop(1_000, -30, "speech_start")).toBe(false);
    expect(harness.stopTtsPlayback).not.toHaveBeenCalled();
    expect(harness.logAuto).toHaveBeenCalledWith(
      "barge_in_stop_blocked",
      expect.objectContaining({
        autoBargeInEnabled: true,
        autoSpeakerPriorityEnabled: true,
        autoAirPodsInput: true,
      }),
    );
  });
});
