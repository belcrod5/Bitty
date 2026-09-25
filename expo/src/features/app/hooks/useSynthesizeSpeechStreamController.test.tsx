import { act, renderHook } from "@testing-library/react-native";

import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage, RunnerWsMessageFilter } from "../../runnerWs/types";
import { Audio } from "../audio";
import type { StreamTtsControlState, TtsDebugStats, TtsPlaybackTarget } from "../types/appTypes";
import { useStopTtsPlaybackController } from "./useStopTtsPlaybackController";
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
      streamAudioQueueRef: ref<Array<{ playbackMessageId: string }>>([]),
      ttsPlaybackMessageIdRef: ref(""),
      baseUrl: () => "http://127.0.0.1:8788",
      ttsStreamWsUrl: () => "ws://127.0.0.1:8788/stream-tts",
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
      resetStreamSegmentsForNewStream: jest.fn(),
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

test("uses RunnerWebSocketManager for stream TTS control traffic when manager is available", async () => {
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

test("idle playback: clears segments for all messages and switches the playback target immediately", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  options.ttsPlayingRef.current = false;
  options.streamAudioQueueRef.current = [];
  options.ttsPlaybackMessageIdRef.current = "old-message";
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("hello", { sessionId: "session-1", messageId: "message-2" });
  await flushPromises();

  expect(options.resetStreamSegmentsForNewStream).toHaveBeenCalledWith("");
  expect(options.setTtsPlaybackMessageIdWithRef).toHaveBeenCalledWith("message-2");
});

test("busy playback: keeps the currently playing message's segments and defers the target switch to the queue processor", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  options.ttsPlayingRef.current = true;
  options.ttsPlaybackMessageIdRef.current = "old-message";
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("hello", { sessionId: "session-1", messageId: "message-2" });
  await flushPromises();

  expect(options.resetStreamSegmentsForNewStream).toHaveBeenCalledWith("old-message");
  expect(options.setTtsPlaybackMessageIdWithRef).not.toHaveBeenCalled();
});

test("busy playback re-synthesizing the same message clears all segments to avoid seq collisions", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  options.ttsPlayingRef.current = true;
  options.ttsPlaybackMessageIdRef.current = "message-2";
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("hello", { sessionId: "session-1", messageId: "message-2" });
  await flushPromises();

  expect(options.resetStreamSegmentsForNewStream).toHaveBeenCalledWith("");
  expect(options.setTtsPlaybackMessageIdWithRef).not.toHaveBeenCalled();
});

test("busy playback via non-empty queue also defers the target switch", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  options.ttsPlayingRef.current = false;
  options.streamAudioQueueRef.current = [{ playbackMessageId: "old-message" }];
  options.ttsPlaybackMessageIdRef.current = "old-message";
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("hello", { sessionId: "session-1", messageId: "message-2" });
  await flushPromises();

  expect(options.resetStreamSegmentsForNewStream).toHaveBeenCalledWith("old-message");
  expect(options.setTtsPlaybackMessageIdWithRef).not.toHaveBeenCalled();
});

test("closing a voice stream before its first chunk preserves the chat sound already playing", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  const projectionTargetRef = ref<TtsPlaybackTarget>({});
  const chatSound = {
    setOnPlaybackStatusUpdate: jest.fn(),
    stopAsync: jest.fn(async () => undefined),
    unloadAsync: jest.fn(async () => undefined),
  };
  options.ttsPlayingRef.current = true;
  options.ttsPlaybackMessageIdRef.current = "chat-message";
  options.setTtsPlaybackProjectionTarget.mockImplementation((target: TtsPlaybackTarget) => {
    projectionTargetRef.current = target;
  });
  options.clearStreamAudioQueue.mockImplementation(() => {
    options.streamAudioQueueRef.current = [];
  });
  const stopOptions: Parameters<typeof useStopTtsPlaybackController>[0] = {
    ttsStopInFlightRef: ref(null),
    ttsProcessingAbortControllersRef: ref(new Set<AbortController>()),
    ttsPlaybackTransitionInFlightRef: ref(false),
    lastTtsStopRequestedAtRef: ref(0),
    lastTtsStoppedAtRef: ref(0),
    ttsPlaybackRunIdRef: ref(0),
    ttsSynthesisRequestIdRef: ref(0),
    ttsPlayingRef: options.ttsPlayingRef,
    replyLoadingRef: ref(false),
    streamSocketRef: options.streamSocketRef,
    streamAudioQueueRef: options.streamAudioQueueRef,
    streamAudioQueueProcessingRef: ref(true),
    streamTtsSuppressedRef: options.streamTtsSuppressedRef,
    streamTtsControlRef: options.streamTtsControlRef,
    streamAudioWaveformBarsRef: options.streamAudioWaveformBarsRef,
    ttsPlaybackMessageIdRef: options.ttsPlaybackMessageIdRef,
    ttsPlaybackProjectionTargetRef: projectionTargetRef,
    ttsSoundRef: ref(chatSound as unknown as Audio.Sound),
    ttsLoading: true,
    ttsUiStatus: "playing",
    setTtsPlaybackWanted: options.setTtsPlaybackWanted,
    setTtsLoading: options.setTtsLoading,
    setTtsUiStatus: options.setTtsUiStatus,
    setTtsQueueProcessing: jest.fn(),
    logAuto: jest.fn(),
    elapsedSinceMs: jest.fn(() => null),
    clearStreamAudioQueue: options.clearStreamAudioQueue,
    setStreamWaveformPreview: options.setStreamWaveformPreview,
    markTtsPlaybackStopped: jest.fn(),
    setAudioModeForPlayback: jest.fn(async () => undefined),
    clearTtsPlaybackWatchdogTimer: jest.fn(),
    setTtsSoundWithRef: jest.fn(),
  };
  const { result } = await renderHook(() => ({
    synthesize: useSynthesizeSpeechStreamController(options),
    stop: useStopTtsPlaybackController(stopOptions).stopTtsPlayback,
  }));

  await act(async () => { await result.current.synthesize("voice reply", { messageId: "voice-operation" }); });
  await flushPromises();
  expect(options.ttsPlaybackMessageIdRef.current).toBe("chat-message");
  expect(options.setTtsPlaybackMessageIdWithRef).not.toHaveBeenCalled();
  const operationId = String(manager.sent[0].operationId);

  await act(async () => {
    await result.current.stop({ interruptStream: true, expectedMessageId: "voice-operation" });
  });

  expect(manager.sent).toContainEqual(expect.objectContaining({ channel: "tts", op: "detach", operationId }));
  expect(options.streamTtsControlRef.current).toBeNull();
  expect(options.streamTtsSuppressedRef.current).toBe(true);
  expect(options.clearStreamAudioQueue).toHaveBeenCalledTimes(2);
  expect(chatSound.stopAsync).not.toHaveBeenCalled();
  expect(chatSound.unloadAsync).not.toHaveBeenCalled();
  expect(stopOptions.markTtsPlaybackStopped).not.toHaveBeenCalled();
  expect(options.ttsPlaybackMessageIdRef.current).toBe("chat-message");
  expect(options.setTtsPlaybackWanted).toHaveBeenLastCalledWith(true, "voice_stream_cancelled");

  manager.emit({
    channel: "tts", op: "event", operationId,
    payload: { type: "audio_chunk", seq: 0, text: "late", audioUrl: "http://example.com/late.mp3", mimeType: "audio/mpeg" },
  });
  expect(options.enqueueStreamAudio).not.toHaveBeenCalled();

  await act(async () => { await result.current.synthesize("another voice reply", { messageId: "voice-operation-2" }); });
  await act(async () => { await result.current.synthesize("chat reply", { messageId: "chat-message-2" }); });
  await flushPromises();
  const chatControl = options.streamTtsControlRef.current;
  expect(chatControl).not.toBeNull();
  const sentBeforeClosingVoice = manager.sent.length;
  await act(async () => {
    await result.current.stop({ interruptStream: true, expectedMessageId: "voice-operation-2" });
  });
  expect(options.streamTtsControlRef.current).toBe(chatControl);
  expect(manager.sent).toHaveLength(sentBeforeClosingVoice);
  expect(chatSound.stopAsync).not.toHaveBeenCalled();
});

test("segment_queued and audio_chunk events tag upsertStreamSegment with the target messageId", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("hello", { sessionId: "session-1", messageId: "message-3" });
  await flushPromises();

  const operationId = String(manager.sent[0].operationId);
  manager.emit({
    channel: "tts",
    op: "event",
    operationId,
    streamId: "tts-job-2",
    payload: { type: "segment_queued", seq: 0, text: "hi" },
  });
  manager.emit({
    channel: "tts",
    op: "event",
    operationId,
    streamId: "tts-job-2",
    payload: {
      type: "audio_chunk",
      seq: 0,
      text: "hi",
      audioUrl: "http://example.com/a.mp3",
      mimeType: "audio/mpeg",
    },
  });

  expect(options.upsertStreamSegment).toHaveBeenCalledWith(
    "message-3",
    0,
    "hi",
    "queued",
    expect.any(Object)
  );
  expect(options.upsertStreamSegment).toHaveBeenCalledWith(
    "message-3",
    0,
    "hi",
    "ready",
    expect.any(Object)
  );
});
