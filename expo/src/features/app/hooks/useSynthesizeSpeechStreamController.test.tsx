import { act, renderHook } from "@testing-library/react-native";

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
    },
    streamSocketRef,
    streamTtsControlRef,
  };
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
    text: "Hello", audioUrl: "https://example.com/0", mimeType: "audio/mpeg" }) });
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
