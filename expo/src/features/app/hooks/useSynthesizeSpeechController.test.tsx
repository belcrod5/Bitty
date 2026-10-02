import { act, renderHook } from "@testing-library/react-native";
import { getNetworkUsageSnapshot, resetNetworkUsage } from "../../ws/networkUsageMetrics";
import { useSynthesizeSpeechController } from "./useSynthesizeSpeechController";

test("counts the server-reported TTS audio size after playback loads", async () => {
  resetNetworkUsage();
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      audioUrl: "https://runner.example/tts-media/audio.wav",
      mimeType: "audio/wav",
      audioBytes: 4096,
    }),
  } as Response);
  const playTtsAudio = jest.fn(async () => {});
  const { result } = await renderHook(() => useSynthesizeSpeechController({
    reply: "hello",
    runnerUrl: "https://runner.example",
    runnerToken: "token",
    ttsProvider: "mock",
    selectedVoiceId: "voice",
    ttsSpeed: 1,
    ttsLoading: false,
    ttsSynthesisRequestIdRef: { current: 0 },
    baseUrl: () => "https://runner.example",
    setTtsPlaybackMessageIdWithRef: jest.fn(),
    setTtsLoading: jest.fn(),
    setTtsUiStatus: jest.fn(),
    setError: jest.fn(),
    setTtsDebugStats: jest.fn(),
    setReplyDebug: jest.fn(),
    reportError: jest.fn(),
    playTtsAudio,
    logAuto: jest.fn(),
  }));

  try {
    await act(async () => { await result.current(); });
    expect(playTtsAudio).toHaveBeenCalledTimes(1);
    expect(getNetworkUsageSnapshot().httpByCategory["tts-media"].receivedBytes).toBe(4096);
  } finally {
    fetchMock.mockRestore();
  }
});
