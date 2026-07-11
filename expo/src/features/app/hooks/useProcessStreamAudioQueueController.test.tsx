import { renderHook } from "@testing-library/react-native";

import type { StreamAudioQueueItem } from "../types/appTypes";
import { useProcessStreamAudioQueueController } from "./useProcessStreamAudioQueueController";

function ref<T>(current: T) {
  return { current };
}

function createOptions(queue: StreamAudioQueueItem[]) {
  const streamAudioQueueRef = ref<StreamAudioQueueItem[]>(queue);
  const ttsPlaybackMessageIdRef = ref("");
  const options = {
    streamAudioQueueProcessingRef: ref(false),
    streamAudioQueueRef,
    streamCurrentChunkStartedAtRef: ref(0),
    streamCurrentChunkEstimatedDurationMsRef: ref<number | null>(null),
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
    playPreparedStreamAudioAndWait: jest.fn(async () => {}),
    setReplyDebug: jest.fn(),
    shouldProjectTtsDebugToActiveSession: jest.fn(() => false),
    reportError: jest.fn(),
    markTtsPlaybackStopped: jest.fn(),
    clearStreamAudioQueue: jest.fn(),
  };
  return { options, streamAudioQueueRef, ttsPlaybackMessageIdRef };
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
