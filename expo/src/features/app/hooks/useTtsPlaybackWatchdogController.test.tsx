import { act, renderHook } from "@testing-library/react-native";
import type { Audio } from "../audio";
import { useTtsPlaybackWatchdogController } from "./useTtsPlaybackWatchdogController";

function ref<T>(current: T) {
  return { current };
}

test("traces a stalled sound when recovery fails and the watchdog stops playback", async () => {
  jest.useFakeTimers();
  const sound = {
    getStatusAsync: jest.fn(async () => ({
      isLoaded: true, isPlaying: false, positionMillis: 10, durationMillis: 1000,
    })),
    playFromPositionAsync: jest.fn(async () => { throw new Error("private text at https://secret.example/audio"); }),
    setOnPlaybackStatusUpdate: jest.fn(),
    unloadAsync: jest.fn(async () => {}),
  } as unknown as Audio.Sound;
  const logAuto = jest.fn();
  const markTtsPlaybackStopped = jest.fn();
  const options = {
    enableTtsPlaybackWatchdog: true,
    ttsLoading: false,
    ttsPlaybackWatchdogStatusTimeoutMs: 100,
    ttsPlaybackStatusLogThrottleMs: 1000,
    ttsPlaybackStallMs: 10,
    ttsPlaybackRecoverCooldownMs: 0,
    ttsPlaybackWatchdogErrorLogThrottleMs: 1000,
    ttsPlaybackFinishEpsilonMs: 20,
    ttsPlaybackForceStopStallMs: 20,
    ttsPlaybackWatchdogIntervalMs: 10,
    ttsPlayingRef: ref(true),
    ttsSoundRef: ref<Audio.Sound | null>(sound),
    ttsPlaybackWantedRef: ref(false),
    ttsPlaybackRunIdRef: ref(4),
    ttsPlaybackTransitionInFlightRef: ref(false),
    ttsPlaybackWatchdogTimerRef: ref<ReturnType<typeof setInterval> | null>(null),
    ttsPlaybackWatchdogInFlightRef: ref(false),
    ttsPlaybackLastPlayingAtRef: ref(Date.now() - 100),
    ttsPlaybackStatusLogAtRef: ref(0),
    ttsPlaybackRecoverAtRef: ref(0),
    ttsPlaybackUnexpectedStopLogAtRef: ref(0),
    ttsPlaybackWatchdogErrorLogAtRef: ref(0),
    ttsStopInFlightRef: ref<Promise<void> | null>(null),
    ttsPlaybackMessageIdRef: ref("message-1"),
    streamSocketRef: ref<WebSocket | null>(null),
    streamTtsControlRef: ref(null),
    streamAudioQueueRef: ref([]),
    streamAudioQueueProcessingRef: ref(false),
    streamTtsSuppressedRef: ref(false),
    setTtsSound: jest.fn(),
    setTtsPlaybackMessageId: jest.fn(),
    setTtsUiStatus: jest.fn(),
    setTtsPlayingWithReasonRef: ref(jest.fn()),
    markTtsChunkPlaybackFinishedRef: ref(jest.fn()),
    markTtsPlaybackStoppedRef: ref(markTtsPlaybackStopped),
    logAuto,
  };
  const { result } = await renderHook(() => useTtsPlaybackWatchdogController(options));
  try {
    result.current.setTtsPlaybackWanted(true, "test");
    await act(async () => { await jest.advanceTimersByTimeAsync(10); });
    expect(logAuto).toHaveBeenCalledWith("tts_trace", expect.objectContaining({
      stage: "watchdog_force_stop", runId: 4,
    }));
    expect(markTtsPlaybackStopped).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logAuto.mock.calls.filter(([event]) => event === "tts_trace")))
      .not.toContain("secret.example");
  } finally {
    result.current.clearTtsPlaybackWatchdogTimer();
    jest.useRealTimers();
  }
});
