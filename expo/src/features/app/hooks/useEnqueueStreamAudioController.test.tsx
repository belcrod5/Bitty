import { renderHook } from "@testing-library/react-native";

import type { StreamAudioQueueItem } from "../types/appTypes";
import { useEnqueueStreamAudioController } from "./useEnqueueStreamAudioController";

function ref<T>(current: T) {
  return { current };
}

function createOptions(processing: boolean, queue: StreamAudioQueueItem[] = []) {
  const streamAudioEnqueueChainRef = ref<Promise<void>>(Promise.resolve());
  const streamAudioQueueRef = ref(queue);
  const options = {
    streamAudioQueueGenerationRef: ref(0),
    streamAudioEnqueueChainRef,
    streamTtsSuppressedRef: ref(false),
    streamAudioQueueRef,
    streamAudioQueueProcessingRef: ref(processing),
    streamSocketRef: ref<WebSocket | null>(null),
    streamTtsControlRef: ref(null),
    setTtsPlaybackWanted: jest.fn(),
    setTtsUiStatus: jest.fn(),
    setStreamAudioQueueSize: jest.fn(),
    preloadStreamAudio: jest.fn(),
    processStreamAudioQueue: jest.fn(async () => {}),
    setReplyDebug: jest.fn(),
    shouldProjectTtsDebugToActiveSession: jest.fn(() => false),
  };
  return { options, streamAudioEnqueueChainRef, streamAudioQueueRef };
}

test("preloads a chunk that arrives while the previous chunk is playing", async () => {
  const { options, streamAudioEnqueueChainRef, streamAudioQueueRef } = createOptions(true);
  const { result } = await renderHook(() => useEnqueueStreamAudioController(options));

  result.current(1, "http://example.com/1.mp3", "audio/mpeg", "message-1");
  await streamAudioEnqueueChainRef.current;

  expect(streamAudioQueueRef.current).toHaveLength(1);
  expect(options.preloadStreamAudio).toHaveBeenCalledWith(streamAudioQueueRef.current[0]);
});

test("does not preload beyond the first queued lookahead chunk", async () => {
  const queued: StreamAudioQueueItem = {
    seq: 1,
    mimeType: "audio/mpeg",
    playbackMessageId: "message-1",
    uri: "http://example.com/1.mp3",
  };
  const { options, streamAudioEnqueueChainRef } = createOptions(true, [queued]);
  const { result } = await renderHook(() => useEnqueueStreamAudioController(options));

  result.current(2, "http://example.com/2.mp3", "audio/mpeg", "message-1");
  await streamAudioEnqueueChainRef.current;

  expect(options.preloadStreamAudio).not.toHaveBeenCalled();
});
