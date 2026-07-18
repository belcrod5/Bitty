import { useAutoRecordingEngine } from "./useAutoRecordingEngine";

jest.mock("react", () => ({
  useCallback: <T,>(callback: T) => callback,
}));

jest.mock("expo-av", () => ({
  Audio: {},
}));

type EngineOptions = Parameters<typeof useAutoRecordingEngine>[0];

function ref<T>(current: T) {
  return { current };
}

function createRecording(uri = "file:///voice.m4a") {
  return {
    getURI: jest.fn(() => uri),
    setOnRecordingStatusUpdate: jest.fn(),
  } as unknown as NonNullable<EngineOptions["autoRecordingRef"]["current"]>;
}

function createHarness() {
  const autoRecordingEnabledRef = ref(false);
  const autoRecordingPanelIdRef = ref("");
  const autoRecordingRef = ref<EngineOptions["autoRecordingRef"]["current"]>(null);
  const autoSpeechStartedAtRef = ref(0);
  const enqueueAutoTranscribe = jest.fn();
  const transcribeRecording = jest.fn(async () => {});
  const runAutoCaptureCycleCore = jest.fn(async () => {});
  const logAuto = jest.fn();

  const options: EngineOptions = {
    appStateRef: ref("active"),
    autoRecordingEnabledRef,
    autoRecordingPanelIdRef,
    autoRecordingRef,
    autoFinalizeLockRef: ref(false),
    autoRestartTimerRef: ref(null),
    autoAppStateNonActiveTimerRef: ref(null),
    autoWaitReasonRef: ref(""),
    autoWaitReasonLogAtRef: ref(0),
    autoClipStartedAtRef: ref(0),
    autoSpeechStartedAtRef,
    autoAboveSinceRef: ref(0),
    autoAboveGapSinceRef: ref(0),
    autoBelowSinceRef: ref(0),
    autoInputDetectAtRef: ref(0),
    autoProgressIntervalMsRef: ref(0),
    autoProgressIntervalModeRef: ref("idle"),
    autoUiLatestMeteringRef: ref<number | null>(null),
    autoUiLatestSpeechSampleRef: ref(false),
    autoWaveformSkipLogAtRef: ref(0),
    autoBargeInProbeLogAtRef: ref(0),
    autoBargeInFastStopAtRef: ref(0),
    autoBargeInFastProbeAboveSinceRef: ref(0),
    autoFinalizeResolvedAtRef: ref(0),
    autoLastBargeInDetectedAtRef: ref(0),
    autoLastTtsStopRequestedAtRef: ref(0),
    autoLastTtsStoppedAtRef: ref(0),
    autoPlaybackBargeGraceUntilRef: ref(0),
    autoInputNameRef: ref(""),
    autoAirPodsInputRef: ref(false),
    autoSilenceDeadlineAtRef: ref(0),
    autoNoCallbackFinalizeAtRef: ref(0),
    autoLastStatusHandledAtRef: ref(0),
    autoBargeInStoppingRef: ref(false),
    autoBargeInDetectedForClipRef: ref(false),
    autoSpeechStartedDuringTtsRef: ref(false),
    autoPostTtsAboveSinceRef: ref(0),
    autoPostTtsHumanDetectedRef: ref(false),
    faceTrackingSuppressLogAtRef: ref(0),
    faceTrackingSuppressedRef: ref(false),
    faceTrackingNotLookingSinceRef: ref(0),
    autoCaptureCycleSeqRef: ref(0),
    audioLabRecordingRef: ref(null),
    audioLabSoundRef: ref(null),
    faceTrackingFaceDetectedRef: ref(true),
    faceTrackingLookingRef: ref(true),
    autoSpeakerPriorityEnabledRef: ref(true),
    autoBargeInEnabledRef: ref(true),
    replyLoadingRef: ref(false),
    ttsPlaybackWantedRef: ref(false),
    ttsPlayingRef: ref(false),
    youtubePlayerIsPlayingRef: ref(false),
    autoSegments: 0,
    autoRecordingState: "idle",
    autoLastEvent: "",
    autoSpeakerPriorityEnabled: true,
    autoBargeInEnabled: true,
    autoReplyAfterStt: true,
    autoSpeakAfterReply: true,
    ttsLoading: false,
    audioLabRunning: false,
    manualRecordingActive: false,
    autoWaitReasonLogThrottleMs: 1_000,
    autoRestartDelayMs: 400,
    autoCooldownMs: 500,
    autoMinSpeechMs: 700,
    setErrorMessage: jest.fn(),
    setAutoRecordingEnabled: jest.fn(),
    setAutoRecordingState: jest.fn(),
    setAutoLastEvent: jest.fn(),
    setAutoInputName: jest.fn(),
    setAutoAirPodsInput: jest.fn(),
    setAutoMeteringDb: jest.fn(),
    setAutoSegments: jest.fn(),
    clearAutoRecordingWatchdogTimer: jest.fn(),
    faceTrackingAllowsStt: () => true,
    transcribeRecording,
    enqueueAutoTranscribe,
    setRecordedClip: jest.fn(),
    runAutoCaptureCycleCore,
    resetAutoWaveform: jest.fn(),
    playUiSfx: jest.fn(),
    releaseRecording: jest.fn(async () => ({ durationMillis: 1_000 } as never)),
    setAudioModeForPlayback: jest.fn(async () => {}),
    elapsedSinceMs: () => null,
    logAuto,
    reportError: jest.fn(),
  };

  return {
    options,
    autoRecordingEnabledRef,
    autoRecordingPanelIdRef,
    autoRecordingRef,
    autoSpeechStartedAtRef,
    enqueueAutoTranscribe,
    transcribeRecording,
    runAutoCaptureCycleCore,
    logAuto,
  };
}

describe("useAutoRecordingEngine panel target", () => {
  it("pauses AirPods capture from the live TTS intent when playback has priority", async () => {
    const harness = createHarness();
    const engine = useAutoRecordingEngine(harness.options);

    await engine.startAutoRecordingMode("panel-a");
    harness.runAutoCaptureCycleCore.mockClear();
    harness.options.autoAirPodsInputRef.current = true;
    harness.options.ttsPlaybackWantedRef.current = true;
    await engine.startAutoCaptureCycle();

    expect(harness.autoRecordingEnabledRef.current).toBe(true);
    expect(harness.runAutoCaptureCycleCore).not.toHaveBeenCalled();
    expect(harness.logAuto).toHaveBeenCalledWith(
      "capture_wait",
      expect.objectContaining({
        reason: "playback_blocked",
        speakerPriority: true,
        autoBargeInEnabled: true,
        ttsPlaybackWanted: true,
      }),
    );

    await engine.stopAutoRecordingMode();
  });

  it("does not let a pre-TTS restart timer resume speaker capture after TTS begins", async () => {
    jest.useFakeTimers();
    try {
      const harness = createHarness();
      const engine = useAutoRecordingEngine(harness.options);
      await engine.startAutoRecordingMode("panel-a");
      expect(harness.runAutoCaptureCycleCore).toHaveBeenCalledTimes(1);

      harness.autoRecordingRef.current = createRecording();
      await engine.finalizeAutoCapture(false, "tts_playback");
      harness.options.autoAirPodsInputRef.current = true;
      harness.options.ttsPlaybackWantedRef.current = true;

      jest.advanceTimersByTime(500);
      await Promise.resolve();

      expect(harness.runAutoCaptureCycleCore).toHaveBeenCalledTimes(1);
      expect(harness.logAuto).toHaveBeenCalledWith(
        "capture_wait",
        expect.objectContaining({
          reason: "playback_blocked",
          ttsPlaybackWanted: true,
        }),
      );

      await engine.stopAutoRecordingMode();
    } finally {
      jest.useRealTimers();
    }
  });

  it("allows TTS barge-in only when playback priority is disabled", async () => {
    const harness = createHarness();
    const engine = useAutoRecordingEngine(harness.options);
    await engine.startAutoRecordingMode("panel-a");
    harness.runAutoCaptureCycleCore.mockClear();
    harness.options.autoAirPodsInputRef.current = true;
    harness.options.autoSpeakerPriorityEnabledRef.current = false;
    harness.options.ttsPlaybackWantedRef.current = true;

    await engine.startAutoCaptureCycle();

    expect(harness.runAutoCaptureCycleCore).toHaveBeenCalledTimes(1);
  });

  it("retains the starting panel through manual stop, then clears it", async () => {
    const harness = createHarness();
    const engine = useAutoRecordingEngine(harness.options);

    await engine.startAutoRecordingMode("  panel-a  ");

    expect(harness.autoRecordingPanelIdRef.current).toBe("panel-a");
    expect(harness.runAutoCaptureCycleCore).toHaveBeenCalledTimes(1);
    expect(harness.logAuto).toHaveBeenCalledWith(
      "mode_start_requested",
      expect.objectContaining({ panelId: "panel-a" }),
    );
    await engine.startAutoRecordingMode("panel-b");
    expect(harness.autoRecordingPanelIdRef.current).toBe("panel-a");
    expect(harness.runAutoCaptureCycleCore).toHaveBeenCalledTimes(1);

    harness.autoRecordingRef.current = createRecording();
    harness.autoSpeechStartedAtRef.current = Date.now() - 1_000;
    await engine.stopAutoRecordingMode();

    expect(harness.transcribeRecording).toHaveBeenCalledWith(
      "file:///voice.m4a",
      "panel-a",
    );
    expect(harness.autoRecordingPanelIdRef.current).toBe("");
  });

  it("passes the retained panel to the finalize transcription queue", async () => {
    const harness = createHarness();
    harness.autoRecordingPanelIdRef.current = "panel-finalize";
    harness.autoRecordingRef.current = createRecording("file:///finalized.m4a");
    const engine = useAutoRecordingEngine(harness.options);

    await engine.finalizeAutoCapture(true, "silence");

    expect(harness.enqueueAutoTranscribe).toHaveBeenCalledWith(
      "file:///finalized.m4a",
      "silence",
      "panel-finalize",
    );
  });
});
