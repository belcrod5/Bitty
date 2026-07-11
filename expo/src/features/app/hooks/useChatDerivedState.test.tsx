import { renderHook } from "@testing-library/react-native";

import { useChatDerivedState } from "./useChatDerivedState";

function baseParams(overrides: Partial<Parameters<typeof useChatDerivedState>[0]> = {}) {
  return {
    codexWsUrl: "ws://localhost",
    transcript: "",
    replyLoading: false,
    llmSessionRestoreLoading: false,
    sttProvider: "none",
    directNativeSttEnabled: false,
    autoRecordingEnabled: false,
    manualRecording: false,
    directNativeSttInterimText: "",
    composerInputFocused: false,
    modelOptions: [],
    modelRef: "",
    reasoningEffort: "",
    normalizedLlmDirectoryForRequest: () => "",
    selectedLlmSessionId: "",
    youtubePlayerVideoId: "",
    youtubePlayerSession: 0,
    conversationMessages: [],
    youtubeVideoMetaById: {},
    streamReplyYouTubeVideoIds: [],
    streamSegments: [],
    ttsPlaybackMessageId: "",
    acpContextUsedPct: null,
    ttsLoading: false,
    ttsPlaying: false,
    ttsQueueProcessing: false,
    llmUiStatus: "idle" as const,
    llmUiStatusDetail: "",
    llmUiStatusDetailBase: "",
    streamLlmProgress: [],
    replyDebug: "",
    chatThinkingLogExpanded: false,
    autoWaveform: [],
    autoWaveformSpeechMask: [],
    autoWaveformDataPipelineEnabled: false,
    autoWaveformDebugOverlayEnabled: false,
    autoSpectrumBarsCount: 8,
    autoSpectrumEmptyBars: [],
    autoMeteringDb: null,
    autoWaveDebugNowMs: 0,
    autoWaveStatusLastAt: 0,
    autoShadowStatusLastAt: 0,
    autoShadowStatusLastMetering: null,
    autoWaveformLastSampleAt: 0,
    autoWaveformUiAt: 0,
    streamAudioQueueSize: 0,
    audioLabRunning: false,
    audioLabNowMs: 0,
    audioLabStartedAt: 0,
    ...overrides,
  };
}

describe("useChatDerivedState ttsSegmentProgress", () => {
  it("only aggregates segments belonging to the active playback target", async () => {
    const { result } = await renderHook(() => useChatDerivedState(baseParams({
      ttsPlaybackMessageId: "message-2",
      streamSegments: [
        { messageId: "message-1", status: "played" },
        { messageId: "message-1", status: "played" },
        { messageId: "message-2", status: "played" },
        { messageId: "message-2", status: "ready" },
      ],
    })));

    expect(result.current.ttsSegmentProgress).toEqual({
      total: 2,
      playedNow: 1,
      generated: 2,
      playbackRatio: 0.5,
      generationRatio: 1,
    });
  });

  it("reports zero progress when no segments match the active playback target", async () => {
    const { result } = await renderHook(() => useChatDerivedState(baseParams({
      ttsPlaybackMessageId: "message-3",
      streamSegments: [
        { messageId: "message-1", status: "played" },
      ],
    })));

    expect(result.current.ttsSegmentProgress).toEqual({
      total: 0,
      playedNow: 0,
      generated: 0,
      playbackRatio: 0,
      generationRatio: 0,
    });
  });
});
