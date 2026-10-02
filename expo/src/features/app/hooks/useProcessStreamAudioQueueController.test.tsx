import { renderHook } from "@testing-library/react-native";

import type { StreamAudioQueueItem, StreamTtsControlState } from "../types/appTypes";
import { useProcessStreamAudioQueueController } from "./useProcessStreamAudioQueueController";

function ref<T>(current: T) {
  return { current };
}

function createOptions(queue: StreamAudioQueueItem[]) {
  const streamAudioQueueRef = ref<StreamAudioQueueItem[]>(queue);
  const ttsPlaybackMessageIdRef = ref("");
  const streamTtsControlRef = ref<StreamTtsControlState | null>(null);
  const options = {
    streamAudioQueueProcessingRef: ref(false),
    streamAudioQueueRef,
    streamCurrentChunkStartedAtRef: ref(0),
    streamCurrentChunkEstimatedDurationMsRef: ref<number | null>(null),
    streamSocketRef: ref<WebSocket | null>(null),
    streamTtsControlRef,
    ttsPlayingRef: ref(false),
    ttsPlaybackMessageIdRef,
    setTtsQueueProcessing: jest.fn(),
    syncTtsPlaybackWantedFromPipeline: jest.fn(),
    prepareTtsPlaybackSession: jest.fn(async () => {}),
    setStreamAudioQueueSize: jest.fn(),
    setTtsPlaybackMessageIdWithRef: jest.fn((next: string) => {
      ttsPlaybackMessageIdRef.current = next;
    }),
    upsertStreamSegment: jest.fn(),
    setTtsUiStatus: jest.fn(),
    playPreparedStreamAudioAndWait: jest.fn(async () => true),
    setReplyDebug: jest.fn(),
    shouldProjectTtsDebugToActiveSession: jest.fn(() => false),
    reportError: jest.fn(),
    markTtsPlaybackStopped: jest.fn(),
    clearStreamAudioQueue: jest.fn(),
    logAuto: jest.fn(),
  };
  return { options, streamAudioQueueRef, streamTtsControlRef, ttsPlaybackMessageIdRef };
}

function audioItem(): StreamAudioQueueItem {
  return {
    seq: 0,
    mimeType: "audio/mpeg",
    playbackMessageId: "message-1",
    uri: "http://example.com/a.mp3",
  };
}

test("chunk playback switches the playback target and tags segment upserts with the chunk's messageId", async () => {
  const item: StreamAudioQueueItem = {
    seq: 0,
    mimeType: "audio/mpeg",
    playbackMessageId: "message-2",
    uri: "http://example.com/a.mp3",
  };
  const { options, ttsPlaybackMessageIdRef } = createOptions([item]);
  ttsPlaybackMessageIdRef.current = "message-1";
  const { result } = await renderHook(() => useProcessStreamAudioQueueController(options));

  await result.current();

  expect(options.setTtsPlaybackMessageIdWithRef).toHaveBeenCalledWith("message-2");
  expect(options.upsertStreamSegment).toHaveBeenCalledWith("message-2", 0, "", "playing");
  expect(options.upsertStreamSegment).toHaveBeenCalledWith(
    "message-2",
    0,
    "",
    "played",
    expect.any(Object)
  );
});

test("chunk playback for the already-active message does not re-trigger a target switch", async () => {
  const item: StreamAudioQueueItem = {
    seq: 1,
    mimeType: "audio/mpeg",
    playbackMessageId: "message-1",
    uri: "http://example.com/b.mp3",
  };
  const { options, ttsPlaybackMessageIdRef } = createOptions([item]);
  ttsPlaybackMessageIdRef.current = "message-1";
  const { result } = await renderHook(() => useProcessStreamAudioQueueController(options));

  await result.current();

  expect(options.setTtsPlaybackMessageIdWithRef).not.toHaveBeenCalled();
  expect(options.upsertStreamSegment).toHaveBeenCalledWith("message-1", 1, "", "playing");
});

test("returns to idle when the stream completes before the final audio chunk finishes", async () => {
  const { options, streamTtsControlRef } = createOptions([audioItem()]);
  streamTtsControlRef.current = { operationId: "stream-1", requestId: "request-1", cleanup: jest.fn() };
  let finishPlayback: (value: boolean) => void = () => {};
  options.playPreparedStreamAudioAndWait.mockImplementation(() => new Promise<boolean>((resolve) => {
    options.ttsPlayingRef.current = true;
    finishPlayback = resolve;
  }));
  const { result } = await renderHook(() => useProcessStreamAudioQueueController(options));

  const processing = result.current();
  await Promise.resolve();
  streamTtsControlRef.current = null;
  expect(options.setTtsUiStatus).not.toHaveBeenCalledWith("idle");
  options.ttsPlayingRef.current = false;
  finishPlayback(true);
  await processing;

  const settleStatus = options.setTtsUiStatus.mock.calls.at(-1)?.[0] as (current: string) => string;
  expect(settleStatus("playing")).toBe("idle");
  expect(settleStatus("synthesizing")).toBe("synthesizing");
  expect(settleStatus("error")).toBe("error");
});

test("keeps the session active when the final audio chunk finishes before stream completion", async () => {
  const { options, streamTtsControlRef } = createOptions([audioItem()]);
  streamTtsControlRef.current = { operationId: "stream-1", requestId: "request-1", cleanup: jest.fn() };
  const { result } = await renderHook(() => useProcessStreamAudioQueueController(options));

  await result.current();

  expect(options.setTtsUiStatus).not.toHaveBeenCalledWith("idle");
  expect(options.setTtsUiStatus).toHaveBeenCalledTimes(1);
  expect(options.setTtsUiStatus).toHaveBeenCalledWith("playing");
});
