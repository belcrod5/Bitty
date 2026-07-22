import { useAutoRecordingStatusHandler } from "./useAutoRecordingStatusHandler";

jest.mock("react", () => ({
  useCallback: <T,>(callback: T) => callback,
}));

jest.mock("expo-av", () => ({
  Audio: {},
}));

type HandlerOptions = Parameters<typeof useAutoRecordingStatusHandler>[0];
type HandlerResult = ReturnType<typeof useAutoRecordingStatusHandler>;
type CreateHandlerParams = Parameters<HandlerResult["createAutoRecordingStatusHandler"]>[0];
type RecordingStatusHandler = ReturnType<HandlerResult["createAutoRecordingStatusHandler"]>;
type RecordingStatus = Parameters<RecordingStatusHandler>[0];

function ref<T>(current: T) {
  return { current };
}

function recordingStatus(metering: number): RecordingStatus {
  return {
    isRecording: true,
    canRecord: true,
    isDoneRecording: false,
    durationMillis: 0,
    metering,
  } as RecordingStatus;
}

function createHarness(config: {
  ttsPlaying?: boolean;
  airPodsInput?: boolean;
  playbackPriority?: boolean;
} = {}) {
  const rec = {} as CreateHandlerParams["rec"];
  const setAutoRecordingState = jest.fn();
  const finalizeAutoCapture = jest.fn(async () => {});
  const autoSpeechStartedAtRef = ref(0);
  const autoAboveSinceRef = ref(0);
  const autoAboveGapSinceRef = ref(0);
  const requestBargeInStop = jest.fn(() => false);

  const options: HandlerOptions = {
    appStateRef: ref("active"),
    appStateChangedAtRef: ref(0),
    appStateLastNonActiveAtRef: ref(0),
    autoRecordingEnabledRef: ref(true),
    autoRecordingRef: ref(rec),
    autoFinalizeLockRef: ref(false),
    autoRecordingWatchdogLogAtRef: ref(0),
    autoStatusNotRecordingSuppressLogAtRef: ref(0),
    autoLastStatusHandledAtRef: ref(0),
    autoWaveStatusLastAtRef: ref(0),
    autoShadowStatusLastAtRef: ref(0),
    autoShadowStatusLastMeteringRef: ref<number | null>(null),
    autoShadowStatusLastDurationMsRef: ref<number | null>(null),
    autoStatusReadOwnerRef: ref<"watchdog" | "">(""),
    autoStatusReadStartedAtRef: ref(0),
    autoWaitReasonRef: ref(""),
    autoInputDetectAtRef: ref(1_000),
    autoUiLatestMeteringRef: ref<number | null>(null),
    autoUiLatestSpeechSampleRef: ref(false),
    autoWaveformLastSampleAtRef: ref(0),
    autoClipStartedAtRef: ref(1_000),
    autoSpeechStartedAtRef,
    autoAboveSinceRef,
    autoAboveGapSinceRef,
    autoBelowSinceRef: ref(0),
    autoSilenceDeadlineAtRef: ref(0),
    autoBargeInStoppingRef: ref(false),
    autoBargeInDetectedForClipRef: ref(false),
    autoBargeInFastStopAtRef: ref(0),
    autoBargeInFastProbeAboveSinceRef: ref(0),
    autoSpeechStartedDuringTtsRef: ref(false),
    autoPostTtsAboveSinceRef: ref(0),
    autoPostTtsHumanDetectedRef: ref(false),
    autoPlaybackBargeGraceUntilRef: ref(0),
    autoBargeInProbeLogAtRef: ref(0),
    autoInputNameRef: ref(""),
    autoAirPodsInputRef: ref(config.airPodsInput ?? false),
    autoBargeInEnabledRef: ref(true),
    autoSpeakerPriorityEnabledRef: ref(config.playbackPriority ?? true),
    autoLastBargeInDetectedAtRef: ref(0),
    autoLastTtsStopRequestedAtRef: ref(0),
    autoLastTtsStoppedAtRef: ref(0),
    faceTrackingFaceDetectedRef: ref(true),
    faceTrackingLookingRef: ref(true),
    faceTrackingNotLookingSinceRef: ref(0),
    faceTrackingSuppressedRef: ref(false),
    faceTrackingSuppressLogAtRef: ref(0),
    ttsPlayingRef: ref(config.ttsPlaying ?? false),
    replyLoadingRef: ref(false),
    streamSocketRef: ref<WebSocket | null>(null),
    streamTtsControlRef: ref(null),
    ttsLoading: false,
    watchdogLogThrottleMs: 1_000,
    statusNotRecordingAppTransitionGraceMs: 1_000,
    statusNotRecordingSuppressLogThrottleMs: 1_000,
    autoInputRoutePollMs: 100_000,
    autoStopSilenceMs: 850,
    autoMinSpeechMs: 700,
    autoMaxSpeechMs: 20_000,
    autoIdleRolloverMs: 10_000,
    autoBargeInFastStopAirpodsThresholdDb: -40,
    autoBargeInFastStopStartOffsetDb: 8,
    autoBargeInFastStopHoldMs: 140,
    autoBargeInFastStopCooldownMs: 220,
    autoBargeInProbeLogThrottleMs: 500,
    autoPostTtsHumanHoldMs: 180,
    faceTrackingSttSuppressLogThrottleMs: 1_000,
    faceTrackingRecordingStopHoldMs: 1_000,
    setAutoRecordingState,
    setAutoLastEvent: jest.fn(),
    maybeLogWaveformStatusTick: jest.fn(),
    trackWaveformFlatline: jest.fn(),
    faceTrackingAllowsStt: () => true,
    detectAutoAirPodsInput: jest.fn(async () => false),
    elapsedSinceMs: () => null,
    logAuto: jest.fn(),
  };

  const { createAutoRecordingStatusHandler } = useAutoRecordingStatusHandler(options);
  const handler = createAutoRecordingStatusHandler({
    rec,
    captureCycleId: 1,
    applyAutoProgressInterval: jest.fn(),
    requestBargeInStop,
    finalizeAutoCapture,
    resetSpeechWindowWithoutFinalize: jest.fn(),
  });

  return {
    handler,
    setAutoRecordingState,
    finalizeAutoCapture,
    autoSpeechStartedAtRef,
    autoAboveSinceRef,
    autoAboveGapSinceRef,
    requestBargeInStop,
  };
}

describe("useAutoRecordingStatusHandler", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("starts normal speech below -30 dB and finalizes it once after silence", () => {
    const harness = createHarness();
    const samples = [
      { now: 1_000, metering: -55 },
      { now: 1_100, metering: -45 },
      { now: 1_200, metering: -36 },
      { now: 1_300, metering: -34 },
      { now: 1_400, metering: -33 },
      { now: 1_500, metering: -32 },
      { now: 1_600, metering: -50 },
      { now: 2_500, metering: -50 },
    ];
    const now = jest.spyOn(Date, "now");

    samples.forEach((sample) => {
      now.mockReturnValueOnce(sample.now);
      harness.handler(recordingStatus(sample.metering), "callback");
    });

    expect(harness.setAutoRecordingState).toHaveBeenCalledWith("speaking");
    expect(harness.finalizeAutoCapture).toHaveBeenCalledTimes(1);
    expect(harness.finalizeAutoCapture).toHaveBeenCalledWith(true, "silence");
  });

  it("keeps listening and does not finalize non-speech", () => {
    const harness = createHarness();
    const now = jest.spyOn(Date, "now");

    [-70, -32, -70, -70, -70].forEach((metering, index) => {
      now.mockReturnValueOnce(1_000 + index * 100);
      harness.handler(recordingStatus(metering), "callback");
    });

    expect(harness.autoSpeechStartedAtRef.current).toBe(0);
    expect(harness.setAutoRecordingState).not.toHaveBeenCalledWith("speaking");
    expect(harness.finalizeAutoCapture).not.toHaveBeenCalled();
  });

  it("ignores AirPods metering during TTS when playback priority is enabled", () => {
    const harness = createHarness({
      ttsPlaying: true,
      airPodsInput: true,
      playbackPriority: true,
    });
    const now = jest.spyOn(Date, "now");

    [-50, -45, -40, -35, -30].forEach((metering, index) => {
      now.mockReturnValueOnce(1_000 + index * 100);
      harness.handler(recordingStatus(metering), "callback");
    });

    expect(harness.requestBargeInStop).not.toHaveBeenCalled();
    expect(harness.autoSpeechStartedAtRef.current).toBe(0);
    expect(harness.setAutoRecordingState).not.toHaveBeenCalledWith("speaking");
  });
});
