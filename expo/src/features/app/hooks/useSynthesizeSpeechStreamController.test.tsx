import { act, renderHook } from "@testing-library/react-native";

import { VoiceControl, type VoiceSurface, type VoiceTarget } from "../../appControl/voiceControl";
import { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage, RunnerWsMessageFilter } from "../../runnerWs/types";
import { Audio } from "../audio";
import type { StreamTtsControlState, TtsDebugStats, TtsPlaybackTarget } from "../types/appTypes";
import { useStopTtsPlaybackController } from "./useStopTtsPlaybackController";
import { useSynthesizeSpeechStreamController } from "./useSynthesizeSpeechStreamController";

const mockCreateWebSocketWithOptionalAuth = jest.fn();

jest.mock("../../ws/webSocketAuth", () => ({
  createWebSocketWithOptionalAuth: (...args: unknown[]) => mockCreateWebSocketWithOptionalAuth(...args),
  isWebSocketForCloudflareRunner: jest.requireActual("../../ws/webSocketAuth")
    .isWebSocketForCloudflareRunner,
}));

class FakeRunnerWebSocketManager {
  sent: RunnerWsMessage[] = [];
  generation = 1;
  connected = true;
  connectionState: "idle" | "connecting" | "ready" | "reconnecting" | "stopped" = "ready";
  appState: "active" | "inactive" = "active";
  lastError = "";
  snapshotHandlers = new Set<() => void>();
  subscriptions: Array<{
    filter: RunnerWsMessageFilter;
    handler: (message: RunnerWsMessage) => void;
    unsubscribed: boolean;
  }> = [];

  connect = jest.fn(async () => {});
  request = jest.fn(async () => ({ op: "app.control.register.result", payload: { version: 1, connectionGeneration: "connection-1" } }));

  getSnapshot() { return {
    connected: this.connected,
    connectionState: this.connectionState,
    appState: this.appState,
    generation: this.generation,
    lastError: this.lastError,
  }; }

  subscribeSnapshot(handler: () => void) {
    this.snapshotHandlers.add(handler);
    return () => { this.snapshotHandlers.delete(handler); };
  }

  reconnect() {
    this.generation += 1;
    this.connected = true;
    this.connectionState = "ready";
    for (const handler of this.snapshotHandlers) handler();
  }

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
      stopTtsPlayback: jest.fn(async () => undefined),
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
      logAuto: jest.fn(),
    },
    streamSocketRef,
    streamTtsControlRef,
  };
}

function createStopOptions(options: ReturnType<typeof createOptions>["options"], projectionTargetRef: { current: TtsPlaybackTarget }, sound: Audio.Sound | null) {
  return {
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
    ttsSoundRef: ref(sound),
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
  } satisfies Parameters<typeof useStopTtsPlaybackController>[0];
}

beforeEach(() => {
  mockCreateWebSocketWithOptionalAuth.mockReset();
});

test("voice job attaches, replays once, and resumes from eventSeq", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("", { messageId: "voice-operation", jobId: "voice-job" });
  await flushPromises();
  expect(manager.sent[0]).toMatchObject({
    channel: "tts", op: "attach", operationId: "voice-operation", streamId: "voice-job",
    payload: { jobId: "voice-job", sinceSeq: 0 },
  });
  expect(options.setTtsLoading).toHaveBeenCalledWith(true);
  manager.emit({ channel: "tts", op: "job_snapshot", streamId: "voice-job",
    payload: { type: "job_snapshot", jobId: "voice-job", lastAudioChunkSeq: 0 } });
  const chunk: RunnerWsMessage = { channel: "tts", op: "audio_chunk", streamId: "voice-job", seq: 4,
    payload: { type: "audio_chunk", eventSeq: 4, seq: 0, text: "Hello", audioUrl: "https://example.com/0", audioBytes: 12, mimeType: "audio/mpeg" } };
  manager.emit(chunk);
  manager.emit(chunk);
  expect(options.enqueueStreamAudio).toHaveBeenCalledTimes(1);
  expect(options.setTtsDebugStats).toHaveBeenCalledTimes(1);
  manager.emit({ channel: "tts", op: "attached", streamId: "voice-job",
    payload: { type: "attached", jobId: "voice-job", sinceSeq: 0 } });
  manager.reconnect();
  expect(manager.sent.at(-1)).toMatchObject({
    channel: "tts", op: "attach", streamId: "voice-job", seq: 4,
    payload: { sinceSeq: 4 },
  });
  manager.emit(chunk);
  expect(options.enqueueStreamAudio).toHaveBeenCalledTimes(1);
});

test("voice replay stops when a retained audio segment is missing", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));
  await result.current("", { messageId: "voice-operation", jobId: "voice-job" });
  await flushPromises();
  manager.emit({ channel: "tts", op: "job_snapshot", streamId: "voice-job",
    payload: { type: "job_snapshot", jobId: "voice-job", lastAudioChunkSeq: 2 } });
  manager.emit({ channel: "tts", op: "audio_chunk", streamId: "voice-job", seq: 8,
    payload: { type: "audio_chunk", eventSeq: 8, seq: 2, text: "Later", audioUrl: "https://example.com/2" } });
  expect(options.enqueueStreamAudio).not.toHaveBeenCalled();
  expect(options.setTtsUiStatus).toHaveBeenCalledWith("error");
  expect(options.stopTtsPlayback).toHaveBeenCalledWith({
    interruptStream: true, expectedMessageId: "voice-operation",
  });
});

test("terminal voice snapshot settles playback when its terminal event was pruned", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));
  await result.current("", { messageId: "voice-operation", jobId: "voice-job" });
  await flushPromises();
  manager.emit({ channel: "tts", op: "job_snapshot", streamId: "voice-job",
    payload: { type: "job_snapshot", jobId: "voice-job", status: "completed", lastAudioChunkSeq: -1 } });
  manager.emit({ channel: "tts", op: "attached", streamId: "voice-job",
    payload: { type: "attached", jobId: "voice-job", sinceSeq: 0 } });
  expect(options.setTtsLoading).toHaveBeenLastCalledWith(false);
  expect(options.streamTtsControlRef.current).toBeNull();
  expect(options.setTtsUiStatus).toHaveBeenLastCalledWith("idle");
});

test("returns to idle when stream completion follows the final audio chunk", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));
  await result.current("", { messageId: "voice-operation", jobId: "voice-job" });
  await flushPromises();

  manager.emit({ channel: "tts", op: "audio_chunk", streamId: "voice-job", seq: 1,
    payload: { type: "audio_chunk", eventSeq: 1, seq: 0, text: "Hello", audioUrl: "https://example.com/0", mimeType: "audio/mpeg" } });
  expect(options.enqueueStreamAudio).toHaveBeenCalledTimes(1);
  options.setTtsUiStatus.mockClear();

  manager.emit({ channel: "tts", op: "done", streamId: "voice-job", seq: 2,
    payload: { type: "done", eventSeq: 2 } });

  expect(options.setTtsUiStatus).toHaveBeenLastCalledWith("idle");
});

test("keeps playing status across later queued and synthesizing segments", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  let status: "idle" | "queued" | "synthesizing" | "playing" | "error" = "idle";
  options.setTtsUiStatus.mockImplementation((next: typeof status | ((current: typeof status) => typeof status)) => {
    status = typeof next === "function" ? next(status) : next;
  });
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));
  await result.current("", { messageId: "voice-operation", jobId: "voice-job" });
  await flushPromises();
  expect(status).toBe("queued");

  manager.emit({ channel: "tts", op: "segment_tts_started", operationId: "voice-operation", streamId: "voice-job",
    payload: { type: "segment_tts_started", seq: 0, text: "first" } });
  expect(status).toBe("synthesizing");

  status = "playing";
  manager.emit({ channel: "tts", op: "segment_queued", operationId: "voice-operation", streamId: "voice-job",
    payload: { type: "segment_queued", seq: 1, text: "next" } });
  manager.emit({ channel: "tts", op: "segment_tts_started", operationId: "voice-operation", streamId: "voice-job",
    payload: { type: "segment_tts_started", seq: 1, text: "next" } });
  expect(status).toBe("playing");
});

test("direct WebSocket releases its active ref at done before the close event", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options, streamSocketRef } = createOptions(manager);
  const directOptions = { ...options, runnerWebSocketManager: undefined, runnerToken: "token" };
  const ws = {
    close: jest.fn(),
    send: jest.fn(),
    onmessage: null as null | ((event: { data: string }) => void),
    onclose: null as null | ((event: unknown) => void),
  };
  mockCreateWebSocketWithOptionalAuth.mockReturnValue(ws);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(directOptions));
  await result.current("hello", { messageId: "message-1" });
  expect(streamSocketRef.current).toBe(ws);

  options.ttsPlayingRef.current = true;
  ws.onmessage?.({ data: JSON.stringify({ type: "audio_chunk", jobId: "job-1", seq: 0,
    text: "Hello", audioUrl: "https://example.com/0", mimeType: "audio/mpeg",
    queueWaitMs: 42, synthesisMs: 550, mediaRegistrationMs: 3,
    at: "2026-10-15T00:00:00.000Z" }) });
  expect(options.logAuto).toHaveBeenCalledWith("tts_trace", {
    stage: "chunk_received", messageId: "message-1", jobId: "job-1", seq: 0, audioBytes: 0,
    queueWaitMs: 42, synthesisMs: 550, mediaRegistrationMs: 3,
    serverEmittedAtMs: Date.parse("2026-10-15T00:00:00.000Z"),
  });
  ws.onmessage?.({ data: JSON.stringify({ type: "done" }) });

  expect(ws.close).toHaveBeenCalledTimes(1);
  expect(streamSocketRef.current).toBeNull();
  options.setTtsUiStatus.mockClear();
  ws.onclose?.({ code: 1000 });
  expect(options.setTtsUiStatus).not.toHaveBeenCalledWith("error");
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

test("text playback uses the target voice while ordinary chat keeps its own voice", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));
  await result.current("orchestrator reply", { messageId: "voice-1",
    ttsProvider: "google", voiceId: "ja-JP-Neural2-B" });
  expect(manager.sent.at(-1)?.payload).toMatchObject({
    ttsProvider: "google", voiceId: "ja-JP-Neural2-B",
  });
  await result.current("ordinary reply", { messageId: "chat-1" });
  expect(manager.sent.at(-1)?.payload).toMatchObject({
    ttsProvider: "mock", voiceId: "voice-1",
  });
});

test("text TTS resumes missed audio after the shared runner socket reconnects", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("hello", { sessionId: "session-1", messageId: "message-1" });
  await flushPromises();
  const start = manager.sent[0];
  manager.emit({ channel: "tts", op: "job_started", operationId: start.operationId,
    streamId: "tts-job-1", payload: { type: "job_started", jobId: "tts-job-1" } });
  manager.emit({ channel: "tts", op: "audio_chunk", streamId: "tts-job-1", seq: 4,
    payload: { type: "audio_chunk", eventSeq: 4, seq: 0, text: "first",
      audioUrl: "https://example.com/0", mimeType: "audio/mpeg" } });

  expect(options.logAuto).toHaveBeenCalledWith("tts_trace", expect.objectContaining({
    stage: "chunk_received", queueWaitMs: null, synthesisMs: null,
    mediaRegistrationMs: null, serverEmittedAtMs: null,
  }));
  manager.reconnect();
  expect(manager.sent.at(-1)).toMatchObject({
    channel: "tts", op: "attach", operationId: start.operationId,
    streamId: "tts-job-1", seq: 4,
  });
  manager.emit({ channel: "tts", op: "audio_chunk", streamId: "tts-job-1", seq: 4,
    payload: { type: "audio_chunk", eventSeq: 4, seq: 0, text: "first",
      audioUrl: "https://example.com/0", mimeType: "audio/mpeg" } });
  manager.emit({ channel: "tts", op: "audio_chunk", streamId: "tts-job-1", seq: 5,
    payload: { type: "audio_chunk", eventSeq: 5, seq: 1, text: "second",
      audioUrl: "https://example.com/1", mimeType: "audio/mpeg" } });
  expect(options.enqueueStreamAudio).toHaveBeenCalledTimes(2);
});

test("text TTS can resume when the first socket closes before job_started", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("hello", { sessionId: "session-1", messageId: "message-1" });
  await flushPromises();
  const start = manager.sent[0];
  manager.reconnect();

  expect(manager.sent.at(-1)).toMatchObject({
    channel: "tts", op: "start", operationId: start.operationId,
    seq: 0,
  });
  manager.emit({ channel: "tts", op: "job_started", operationId: start.operationId,
    streamId: "tts-job-1", payload: { type: "job_started", jobId: "tts-job-1" } });
  manager.emit({ channel: "tts", op: "audio_chunk", streamId: "tts-job-1", seq: 1,
    payload: { type: "audio_chunk", eventSeq: 1, seq: 0, text: "hello",
      audioUrl: "https://example.com/0", mimeType: "audio/mpeg" } });
  expect(options.enqueueStreamAudio).toHaveBeenCalledTimes(1);
});

test("text TTS starts after a socket that closed before ready reconnects", async () => {
  const manager = new FakeRunnerWebSocketManager();
  manager.connected = false;
  manager.connectionState = "connecting";
  manager.connect.mockImplementation(async () => {
    manager.connectionState = "reconnecting";
    throw new Error("runner_ws_closed_before_ready");
  });
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("hello", { messageId: "message-1" });
  await flushPromises();
  expect(manager.sent).toHaveLength(0);
  expect(options.streamTtsControlRef.current).not.toBeNull();
  expect(options.setTtsUiStatus).not.toHaveBeenCalledWith("error");

  manager.reconnect();
  expect(manager.sent).toHaveLength(1);
  expect(manager.sent[0]).toMatchObject({ channel: "tts", op: "start", seq: 0 });
});

test("text TTS resends the same start when ready closes before connect settles", async () => {
  const manager = new FakeRunnerWebSocketManager();
  manager.connected = false;
  manager.connectionState = "connecting";
  manager.connect.mockImplementation(async () => {
    manager.connected = true;
    manager.connectionState = "ready";
    for (const handler of manager.snapshotHandlers) handler();
    manager.connected = false;
    manager.connectionState = "reconnecting";
    throw new Error("runner_ws_closed_before_ready");
  });
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("hello", { messageId: "message-1" });
  await flushPromises();
  expect(manager.sent).toHaveLength(1);
  manager.reconnect();
  expect(manager.sent).toHaveLength(2);
  expect(manager.sent[1]).toMatchObject({
    channel: "tts", op: "start", operationId: manager.sent[0].operationId, seq: 0,
  });
  expect(options.streamTtsControlRef.current).not.toBeNull();
});

test("text TTS retries when the real manager's ready socket throws on send", async () => {
  const manager = new RunnerWebSocketManager({
    url: "ws://127.0.0.1:8788/runner-ws", token: "token", appState: "active",
  });
  const createSocket = (failSend: boolean) => {
    const socket = {
      readyState: 0,
      bufferedAmount: 0,
      sent: [] as RunnerWsMessage[],
      onopen: null as null | ((event: Event) => void),
      onmessage: null as null | ((event: MessageEvent) => void),
      onclose: null as null | ((event: CloseEvent) => void),
      send: jest.fn((raw: string) => {
        if (failSend) {
          expect(manager.getSnapshot().connectionState).toBe("ready");
          throw new Error("native send failed");
        }
        socket.sent.push(JSON.parse(raw) as RunnerWsMessage);
      }),
      close: jest.fn(() => {
        socket.readyState = 3;
        socket.onclose?.({ reason: "late_close" } as CloseEvent);
      }),
    };
    return socket;
  };
  const first = createSocket(true);
  const second = createSocket(false);
  mockCreateWebSocketWithOptionalAuth
    .mockReturnValueOnce(first as unknown as WebSocket)
    .mockReturnValueOnce(second as unknown as WebSocket);
  const { options } = createOptions(new FakeRunnerWebSocketManager());
  options.runnerWebSocketManager = manager;
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));
  await result.current("hello", { messageId: "message-1" });

  first.readyState = 1;
  first.onopen?.({} as Event);
  first.onmessage?.({ data: JSON.stringify({ channel: "control", op: "ready" }) } as MessageEvent);
  await flushPromises();
  expect(manager.getSnapshot().connectionState).toBe("reconnecting");
  expect(options.streamTtsControlRef.current).not.toBeNull();

  manager.retryConnect();
  second.readyState = 1;
  second.onopen?.({} as Event);
  second.onmessage?.({ data: JSON.stringify({ channel: "control", op: "ready" }) } as MessageEvent);
  expect(second.sent).toHaveLength(1);
  expect(second.sent[0]).toMatchObject({ channel: "tts", op: "start", seq: 0 });
  options.streamTtsControlRef.current?.cleanup();
  manager.disconnect();
});

test("text TTS reports a permanent connection configuration error", async () => {
  const manager = new FakeRunnerWebSocketManager();
  manager.connected = false;
  manager.connectionState = "idle";
  manager.lastError = "runner_token_required";
  manager.connect.mockRejectedValue(new Error("runner_token_required"));
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("hello", { messageId: "message-1" });
  await flushPromises();
  expect(manager.sent).not.toContainEqual(expect.objectContaining({ op: "start" }));
  expect(options.streamTtsControlRef.current).toBeNull();
  expect(options.setTtsUiStatus).toHaveBeenCalledWith("error");
  expect(options.logAuto).toHaveBeenCalledWith("tts_trace", expect.objectContaining({
    stage: "transport_error", phase: "connect", messageId: "message-1",
    error: "runner_token_required",
  }));
});

test("missing audio is traced without recording the chunk text or URL", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));
  await result.current("private spoken text", { messageId: "message-1" });
  await flushPromises();
  const operationId = String(manager.sent[0].operationId);
  manager.emit({
    channel: "tts", op: "audio_chunk", operationId, streamId: "tts-job-1",
    payload: { type: "audio_chunk", seq: 0, text: "private spoken text", audioBytes: 0 },
  });
  expect(options.logAuto).toHaveBeenCalledWith("tts_trace", expect.objectContaining({
    stage: "chunk_ignored", reason: "empty_audio", messageId: "message-1", seq: 0,
  }));
  expect(JSON.stringify(options.logAuto.mock.calls)).not.toContain("private spoken text");
});

test("text TTS reports a non-retryable start send error", async () => {
  const manager = new FakeRunnerWebSocketManager();
  manager.send = () => { throw new Error("runner_ws_message_too_large"); };
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("hello", { messageId: "message-1" });
  await flushPromises();
  expect(options.streamTtsControlRef.current).toBeNull();
  expect(options.setTtsUiStatus).toHaveBeenCalledWith("error");
});

test("text TTS stops waiting when reconnect attempts become terminal", async () => {
  const manager = new FakeRunnerWebSocketManager();
  manager.connected = false;
  manager.connectionState = "connecting";
  manager.connect.mockImplementation(async () => {
    manager.connectionState = "reconnecting";
    throw new Error("runner_ws_closed_before_ready");
  });
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await result.current("hello", { messageId: "message-1" });
  await flushPromises();
  expect(options.streamTtsControlRef.current).not.toBeNull();
  manager.connectionState = "stopped";
  manager.lastError = "runner_ws_auth_failed";
  for (const handler of manager.snapshotHandlers) handler();

  expect(options.streamTtsControlRef.current).toBeNull();
  expect(options.setTtsUiStatus).toHaveBeenCalledWith("error");
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

test("playback ownership follows each synthesis and defaults back to chat", async () => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  const { result } = await renderHook(() => useSynthesizeSpeechStreamController(options));

  await act(async () => {
    await result.current("メインで開始しました", { scope: "voice", messageId: "voice-start-announcement" });
  });
  expect(options.setTtsPlaybackProjectionTarget).toHaveBeenLastCalledWith(expect.objectContaining({
    scope: "voice", messageId: "voice-start-announcement",
  }));

  await act(async () => {
    await result.current("chat reply", { sessionId: "chat-session", messageId: "chat-message" });
  });
  expect(options.setTtsPlaybackProjectionTarget).toHaveBeenLastCalledWith(expect.objectContaining({
    scope: "chat", sessionId: "chat-session", messageId: "chat-message",
  }));
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
  const stopOptions = createStopOptions(options, projectionTargetRef, chatSound as unknown as Audio.Sound);
  const { result } = await renderHook(() => ({
    synthesize: useSynthesizeSpeechStreamController(options),
    stop: useStopTtsPlaybackController(stopOptions).stopTtsPlayback,
  }));

  await act(async () => { await result.current.synthesize("voice reply", { scope: "voice", messageId: "voice-operation" }); });
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

  await act(async () => { await result.current.synthesize("another voice reply", { scope: "voice", messageId: "voice-operation-2" }); });
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


test.each([
  ["orchestrator", "handoff"], ["session", "handoff"],
  ["orchestrator", "self"], ["session", "self"],
  ["orchestrator", "stop"], ["session", "stop"], ["orchestrator", "manual"],
  ["orchestrator", "release_failure"], ["orchestrator", "mode_failure"],
] as const)("%s caller: %s preserves ownership while coordinating its live TTS stream", async (kind, mode) => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  const projection = ref<TtsPlaybackTarget>({});
  let playbackActive = false;
  options.setTtsLoading.mockImplementation((active: boolean) => { playbackActive = active; });
  options.setTtsUiStatus.mockImplementation((status: string) => { playbackActive = status !== "idle" && status !== "error"; });
  options.setTtsPlaybackMessageIdWithRef.mockImplementation((id: string) => { options.ttsPlaybackMessageIdRef.current = id; });
  options.setTtsPlaybackProjectionTarget.mockImplementation((target: TtsPlaybackTarget) => { projection.current = target; });
  options.clearStreamAudioQueue.mockImplementation(() => { options.streamAudioQueueRef.current = []; });
  let finishNativeStop!: () => void;
  const nativeSound = mode === "release_failure" ? {
    setOnPlaybackStatusUpdate: jest.fn(), stopAsync: jest.fn(async () => { throw new Error("native stop failed"); }),
    unloadAsync: jest.fn(async () => { throw new Error("native unload failed"); }),
  } : mode === "manual" ? {
    setOnPlaybackStatusUpdate: jest.fn(),
    stopAsync: jest.fn(() => new Promise<void>((resolve) => { finishNativeStop = resolve; })),
    unloadAsync: jest.fn(async () => {}),
  } : null;
  const stopOptions = createStopOptions(options, projection, nativeSound as unknown as Audio.Sound | null);
  const audioOrder: string[] = [];
  stopOptions.setAudioModeForPlayback.mockImplementation(async () => {
    if (mode === "mode_failure") throw new Error("audio mode failed");
    audioOrder.push("old_stop_audio_mode");
  });
  const { result } = await renderHook(() => ({
    synthesize: useSynthesizeSpeechStreamController(options),
    stop: useStopTtsPlaybackController(stopOptions).stopTtsPlayback,
  }));
  const control = new VoiceControl(manager as unknown as RunnerWebSocketManager);
  const sourceTarget: VoiceTarget = kind === "orchestrator" ? { kind, orchestratorId: "caller" }
    : { kind, sessionRef: { backendId: "codex", nativeSessionId: "caller" }, cwd: "/work" };
  const destinationTarget: VoiceTarget = kind === "session" ? { kind: "orchestrator", orchestratorId: "destination" }
    : { kind: "session", sessionRef: { backendId: "codex", nativeSessionId: "destination" }, cwd: "/work" };
  const surface = (id: string, target: VoiceTarget): VoiceSurface => {
    let recording = false;
    return { id, target: () => target, snapshot: () => ({ desired: recording ? "listening" : "stopped", observed: recording ? "recording" : "stopped" }),
      draft: () => "", busy: () => false, canStart: () => !playbackActive, controlVersion: () => 1,
      hasPermission: async () => true, disarm: async () => { recording = false; },
      start: jest.fn(async () => { recording = true; }), announce: async () => {}, readyCue: async () => {}, notice: jest.fn() };
  };
  const source = surface("source", sourceTarget), destination = surface("destination", destinationTarget);
  const releaseSpeech = jest.fn(async (target: VoiceTarget, panelId?: string) => {
    // The source's eager onJob attachment must already be disabled while native stop awaits.
    expect(control.allowsSpeech("source", sourceTarget)).toBe(false);
    await result.current.stop({ interruptStream: true, reason: "voice_handoff", expectedTarget: target.kind === "orchestrator"
      ? { scope: "voice", orchestratorId: target.orchestratorId }
      : { scope: "chat", sessionId: target.sessionRef.nativeSessionId || "", panelId } });
  });
  control.configure({ preflight: async () => null, open: async () => ({}), announce: async () => {}, readyCue: async () => {}, releaseSpeech });
  const stopControl = control.start();
  const unregisterSource = control.register(source), unregisterDestination = control.register(destination);
  try {
    await flushPromises();
    const origin = control.origin(undefined, sourceTarget)!;
    await act(async () => { await result.current.synthesize("", { scope: kind === "orchestrator" ? "voice" : "chat", ...(sourceTarget.kind === "orchestrator" ? { orchestratorId: sourceTarget.orchestratorId } : { sessionId: sourceTarget.sessionRef.nativeSessionId || "" }), messageId: "caller-operation", jobId: "caller-job" }); });
    expect(playbackActive).toBe(true);
    expect(options.streamTtsControlRef.current).not.toBeNull();
    const sourcePlayback = sourceTarget.kind === "orchestrator" ? { scope: "voice" as const, orchestratorId: sourceTarget.orchestratorId }
      : { scope: "chat" as const, sessionId: sourceTarget.sessionRef.nativeSessionId! };
    await result.current.stop({ interruptStream: true, expectedTarget: sourceTarget.kind === "orchestrator"
      ? { scope: "voice", orchestratorId: "other" } : { scope: "chat", sessionId: "other" } });
    await result.current.stop({ interruptStream: true, expectedTarget: sourcePlayback, expectedMessageId: "different-message" });
    if (kind === "session") await result.current.stop({ interruptStream: true, expectedTarget: { scope: "chat", sessionId: "caller", panelId: "other-panel" } });
    expect(playbackActive).toBe(true);
    expect(options.streamTtsControlRef.current).not.toBeNull();
    // Source LLM cannot complete text_done while waiting for this command's ACK.
    manager.emit({ channel: "control", op: "app.control.execute", operationId: "epoch.handoff", payload: {
      ...origin, action: mode === "stop" ? "stop" : "handoff", expectedGeneration: origin.ownerGeneration,
      target: mode === "self" ? sourceTarget : destinationTarget, expiresAt: new Date(Date.now() + 1000).toISOString(),
    } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (mode === "release_failure" || mode === "mode_failure") {
      expect(manager.sent).toContainEqual(expect.objectContaining({ op: "app.control.result", payload: expect.objectContaining({ status: "failed", observed: "unknown" }) }));
      await expect(control.acquire("destination")).rejects.toThrow();
      expect(destination.start).not.toHaveBeenCalled();
      return;
    }
    if (mode === "manual") {
      expect(nativeSound!.stopAsync).toHaveBeenCalledTimes(1);
      const startNewOwner = control.acquire("destination").then(async (acquired) => {
        if (acquired) { audioOrder.push("new_owner_capture"); await destination.start(); }
      });
      await flushPromises();
      expect(destination.start).not.toHaveBeenCalled();
      finishNativeStop(); await startNewOwner; await flushPromises();
      expect(audioOrder).toEqual(["old_stop_audio_mode", "new_owner_capture"]);
      expect(destination.snapshot().observed).toBe("recording");
      expect(destination.start).toHaveBeenCalledTimes(1);
      expect(manager.sent).toContainEqual(expect.objectContaining({ op: "app.control.result", payload: expect.objectContaining({ status: "failed" }) }));
      return;
    }
    if (mode !== "handoff") {
      expect(releaseSpeech).not.toHaveBeenCalled();
      expect(playbackActive).toBe(true);
      expect(options.streamTtsControlRef.current).not.toBeNull();
      expect(control.allowsSpeech("source", sourceTarget)).toBe(true);
      expect(destination.start).not.toHaveBeenCalled();
      if (mode === "self") {
        expect(manager.sent).toContainEqual(expect.objectContaining({ op: "app.control.result", payload: expect.objectContaining({ status: "pending", reason: "waiting_for_caller_reply" }) }));
        expect(source.start).not.toHaveBeenCalled();
        manager.emit({ channel: "tts", op: "done", streamId: "caller-job", seq: 1, payload: { type: "done", eventSeq: 1 } });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(source.start).toHaveBeenCalledTimes(1);
      }
      expect(manager.sent).toContainEqual(expect.objectContaining({ op: "app.control.result", payload: expect.objectContaining({ status: "applied", target: sourceTarget }) }));
      return;
    }
    expect(releaseSpeech).toHaveBeenCalledTimes(1);
    expect(manager.sent).toContainEqual(expect.objectContaining({ channel: "tts", op: "detach" }));
    expect(options.streamTtsControlRef.current).toBeNull();
    expect(destination.start).toHaveBeenCalledTimes(1);
    expect(manager.sent).toContainEqual(expect.objectContaining({ op: "app.control.result", payload: expect.objectContaining({ status: "applied", target: destinationTarget }) }));
    manager.emit({ channel: "tts", op: "audio_chunk", streamId: "caller-job", seq: 1, payload: { type: "audio_chunk", seq: 0, text: "late", audioUrl: "https://example.com/late" } });
    expect(options.enqueueStreamAudio).not.toHaveBeenCalled();
  } finally { stopControl(); unregisterSource(); unregisterDestination(); }
});

test.each([false, true])("scoped release joining an older native stop rechecks ownership (new owner: %s)", async (newOwner) => {
  const manager = new FakeRunnerWebSocketManager();
  const { options } = createOptions(manager);
  const projection = ref<TtsPlaybackTarget>({ scope: "chat", sessionId: "old-chat", messageId: "old-message" });
  options.ttsPlaybackMessageIdRef.current = "old-message";
  options.setTtsPlaybackMessageIdWithRef.mockImplementation((id: string) => { options.ttsPlaybackMessageIdRef.current = id; });
  options.setTtsPlaybackProjectionTarget.mockImplementation((target: TtsPlaybackTarget) => { projection.current = target; });
  let finishOldStop!: () => void;
  const sound = { setOnPlaybackStatusUpdate: jest.fn(),
    stopAsync: jest.fn(() => new Promise<void>((resolve) => { finishOldStop = resolve; })), unloadAsync: jest.fn(async () => {}) };
  const stopOptions = createStopOptions(options, projection, sound as unknown as Audio.Sound);
  stopOptions.setTtsSoundWithRef.mockImplementation(() => { stopOptions.ttsSoundRef.current = null; });
  const { result } = await renderHook(() => ({ synthesize: useSynthesizeSpeechStreamController(options), stop: useStopTtsPlaybackController(stopOptions).stopTtsPlayback }));
  const oldStop = result.current.stop({ interruptStream: true, expectedMessageId: "old-message" });
  await result.current.synthesize("", { scope: "voice", orchestratorId: "caller", messageId: "caller-operation", jobId: "caller-job" });
  expect(options.streamTtsControlRef.current).not.toBeNull();
  const callerStop = result.current.stop({ interruptStream: true, expectedTarget: { scope: "voice", orchestratorId: "caller" } });
  if (newOwner) await result.current.synthesize("", { scope: "voice", orchestratorId: "new-owner", messageId: "new-operation", jobId: "new-job" });
  finishOldStop(); await Promise.all([oldStop, callerStop]);
  if (newOwner) expect(options.streamTtsControlRef.current?.operationId).toBe("new-operation");
  else expect(options.streamTtsControlRef.current).toBeNull();
  expect(manager.sent).toContainEqual(expect.objectContaining({ channel: "tts", op: "detach", streamId: "caller-job" }));
});
