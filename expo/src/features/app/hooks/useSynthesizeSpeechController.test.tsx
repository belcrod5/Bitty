import { getNetworkStateAsync } from "../networkState";
jest.mock("../networkState", () => ({ getNetworkStateAsync: jest.fn() }));

import { act, renderHook } from "@testing-library/react-native";
import { getNetworkUsageSnapshot, resetNetworkUsage } from "../../ws/networkUsageMetrics";
import { useSynthesizeSpeechController } from "./useSynthesizeSpeechController";

function createOptions() {
  return {
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
    setTtsPlaybackProjectionTarget: jest.fn(),
    setTtsLoading: jest.fn(),
    setTtsUiStatus: jest.fn(),
    setError: jest.fn(),
    setTtsDebugStats: jest.fn(),
    setReplyDebug: jest.fn(),
    reportError: jest.fn(),
    playTtsAudio: jest.fn(async () => {}),
    logAuto: jest.fn(),
  };
}

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
  const setTtsPlaybackProjectionTarget = jest.fn();
  const { result } = await renderHook(() => useSynthesizeSpeechController({
    ...createOptions(), playTtsAudio, setTtsPlaybackProjectionTarget,
  }));

  try {
    await act(async () => { await result.current(); });
    expect(playTtsAudio).toHaveBeenCalledTimes(1);
    expect(setTtsPlaybackProjectionTarget).toHaveBeenCalledWith({ scope: "chat", messageId: "" });
    expect(getNetworkUsageSnapshot().httpByCategory["tts-media"].receivedBytes).toBe(4096);
  } finally {
    fetchMock.mockRestore();
  }
});


test.each(["CELLULAR", "WIFI"])("HTTP TTS sends the current %s quality and logs the returned profile", async (type) => {
  jest.mocked(getNetworkStateAsync).mockResolvedValue({ type } as Awaited<ReturnType<typeof getNetworkStateAsync>>);
  const audioQuality = type === "CELLULAR" ? "lightweight" : "standard";
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true,
    json: async () => ({ audioUrl: "https://runner.example/tts-media/audio.mp3", mimeType: "audio/mpeg", audioBytes: 100, audioQuality }),
  } as Response);
  const options = { ...createOptions(), lightweightTtsOnCellular: true };
  const { result } = await renderHook(() => useSynthesizeSpeechController(options));
  try {
    await act(async () => { await result.current(); });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).audioQuality).toBe(audioQuality);
    expect(options.logAuto).toHaveBeenCalledWith("tts_trace", expect.objectContaining({ stage: "http_synthesis_audio_ready", audioQuality }));
  } finally { fetchMock.mockRestore(); }
});

test.each(["cancel", "unmount"])("HTTP TTS does not send after %s while network detection is pending", async (action) => {
  let resolveNetwork!: (state: Awaited<ReturnType<typeof getNetworkStateAsync>>) => void;
  jest.mocked(getNetworkStateAsync).mockReturnValue(new Promise((resolve) => { resolveNetwork = resolve; }));
  const fetchMock = jest.spyOn(global, "fetch");
  const options = { ...createOptions(), lightweightTtsOnCellular: true };
  const { result, unmount } = await renderHook(() => useSynthesizeSpeechController(options));
  let request!: Promise<void>;
  await act(async () => { request = result.current(); });
  if (action === "cancel") options.ttsSynthesisRequestIdRef.current += 1;
  else await unmount();
  try {
    await act(async () => { resolveNetwork({ type: "CELLULAR" } as Awaited<ReturnType<typeof getNetworkStateAsync>>); await request; });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { fetchMock.mockRestore(); }
});
