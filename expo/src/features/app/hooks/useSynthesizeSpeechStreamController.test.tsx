import { renderHook } from "@testing-library/react-native";

import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage, RunnerWsMessageFilter } from "../../runnerWs/types";
import type { StreamTtsControlState, TtsDebugStats } from "../types/appTypes";
import { useSynthesizeSpeechStreamController } from "./useSynthesizeSpeechStreamController";

const mockCreateWebSocketWithOptionalAuth = jest.fn();

jest.mock("../../ws/webSocketAuth", () => ({
  createWebSocketWithOptionalAuth: (...args: unknown[]) => mockCreateWebSocketWithOptionalAuth(...args),
}));

class FakeRunnerWebSocketManager {
  sent: RunnerWsMessage[] = [];
  subscriptions: Array<{
    filter: RunnerWsMessageFilter;
    handler: (message: RunnerWsMessage) => void;
    unsubscribed: boolean;
  }> = [];

  connect = jest.fn(async () => {});

  send(message: RunnerWsMessage) {
    this.sent.push(message);
  }

  subscribe(filter: RunnerWsMessageFilter, handler: (message: RunnerWsMessage) => void) {
    const subscription = { filter, handler, unsubscribed: false };
    this.subscriptions.push(subscription);
    return () => {
      subscription.unsubscribed = true;
    };
  }

  emit(message: RunnerWsMessage) {
    for (const subscription of this.subscriptions) {
      if (subscription.unsubscribed) continue;
      if (subscription.filter.channel && subscription.filter.channel !== message.channel) continue;
      if (subscription.filter.op && subscription.filter.op !== message.op) continue;
      subscription.handler(message);
    }
  }
}

function ref<T>(current: T) {
  return { current };
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createOptions(manager: FakeRunnerWebSocketManager) {
  const streamTtsControlRef = ref<StreamTtsControlState | null>(null);
  const streamSocketRef = ref<WebSocket | null>(null);
  const ttsDebugStats: TtsDebugStats = {
    synthRequests: 0,
    synthMimeType: "",
    synthDetected: "unknown",
    synthAudioBytes: 0,
    synthWaveformBars: 0,
    synthTargetMessageId: "",
    playAttempts: 0,
    playExt: "",
    playDetected: "unknown",
    playAudioBytes: 0,
    playStatusErrors: 0,
    playLastStatusError: "",
    streamChunkCount: 0,
    streamLastSeq: -1,
    streamLastMimeType: "",
    streamLastAudioBytes: 0,
    streamLastWaveformBars: 0,
    streamMergedWaveformBars: 0,
  };

  return {
    options: {
      reply: "hello",
      runnerToken: "",
      ttsProvider: "mock",
      selectedVoiceId: "voice-1",
      ttsSpeed: 1,
      ttsWaveformPoints: 8,
      runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
      streamTtsControlRef,
      streamSocketRef,
      streamTtsSuppressedRef: ref(false),
      streamAudioWaveformBarsRef: ref<number[][]>([]),
      ttsPlayingRef: ref(false),
      streamAudioQueueRef: ref([]),
      baseUrl: () => "http://127.0.0.1:8788",
      ttsStreamWsUrl: () => "ws://127.0.0.1:8788/runner-ws",
      clearStreamAudioQueue: jest.fn(),
      upsertStreamSegment: jest.fn(),
      enqueueStreamAudio: jest.fn(),
      patchConversationMessageById: jest.fn(),
      reportError: jest.fn(),
      setError: jest.fn(),
      setReplyDebug: jest.fn(),
      setTtsLoading: jest.fn(),
      setTtsUiStatus: jest.fn(),
      setTtsPlaybackWanted: jest.fn(),
      patchTtsDebugStats: jest.fn(),
      setStreamWaveformPreview: jest.fn(),
      clearStreamLlmProgress: jest.fn(),
      clearStreamSegments: jest.fn(),
      setStreamMode: jest.fn(),
      setTtsPlaybackMessageIdWithRef: jest.fn(),
      setTtsPlaybackProjectionTarget: jest.fn(),
      setTtsDebugStats: jest.fn((updater: (prev: TtsDebugStats) => TtsDebugStats) => updater(ttsDebugStats)),
      syncTtsPlaybackWantedFromPipeline: jest.fn(() => true),
    },
    streamSocketRef,
    streamTtsControlRef,
  };
}

beforeEach(() => {
  mockCreateWebSocketWithOptionalAuth.mockReset();
});

test("uses RunnerWebSocketManager for runner-ws stream TTS control traffic", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options, streamSocketRef, streamTtsControlRef } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("hello", { sessionId: "session-1", messageId: "message-1" });
  await flushPromises();

  expect(mockCreateWebSocketWithOptionalAuth).not.toHaveBeenCalled();
  expect(streamSocketRef.current).toBeNull();
  expect(manager.subscriptions.map((subscription) => subscription.filter)).toEqual([
    { channel: "tts" },
    { channel: "control", op: "error" },
  ]);
  expect(manager.sent).toHaveLength(1);
  expect(manager.sent[0]).toMatchObject({
    channel: "tts",
    op: "start",
    requestId: expect.stringMatching(/^stream-tts-.+-start$/),
    operationId: expect.stringMatching(/^stream-tts-/),
    sessionId: "session-1",
    payload: {
      type: "start",
      mode: "text",
      text: "hello",
      ttsProvider: "mock",
      voiceId: "voice-1",
      speedScale: 1,
    },
  });
  expect(streamTtsControlRef.current?.operationId).toBe(manager.sent[0].operationId);

  manager.emit({
    channel: "tts",
    op: "event",
    operationId: String(manager.sent[0].operationId),
    streamId: "tts-job-1",
    payload: { type: "done" },
  });

  expect(manager.sent[1]).toMatchObject({
    channel: "tts",
    op: "detach",
    operationId: manager.sent[0].operationId,
    streamId: "tts-job-1",
    payload: {
      operationId: manager.sent[0].operationId,
      jobId: "tts-job-1",
    },
  });
  expect(manager.subscriptions.every((subscription) => subscription.unsubscribed)).toBe(true);
  expect(streamTtsControlRef.current).toBeNull();
  expect(streamSocketRef.current).toBeNull();
});
