import { renderHook, waitFor } from "@testing-library/react-native";

import { Audio } from "../audio";
import type { StreamAudioQueueItem } from "../types/appTypes";
import { usePlayPreparedStreamAudioController } from "./usePlayPreparedStreamAudioController";

jest.mock("../audio", () => ({
  Audio: {
    Sound: {
      createAsync: jest.fn(),
    },
  },
}));

function ref<T>(current: T) {
  return { current };
}

function queueItem(seq: number): StreamAudioQueueItem {
  return {
    seq,
    mimeType: "audio/mpeg",
    playbackMessageId: "message-1",
    uri: `http://example.com/${seq}.mp3`,
  };
}

function sound() {
  return {
    playAsync: jest.fn(async () => {}),
    unloadAsync: jest.fn(async () => {}),
    setOnPlaybackStatusUpdate: jest.fn(),
  };
}

function createOptions() {
  return {
    fixedMediaVolume: 1,
    ttsStopInFlightRef: ref<Promise<void> | null>(null),
    ttsPlaybackRunIdRef: ref(0),
    ttsPlaybackProgressUiAtRef: ref(0),
    ttsPlaybackTransitionInFlightRef: ref(false),
    ttsPlaybackLastPlayingAtRef: ref(0),
    streamAudioQueueRef: ref<StreamAudioQueueItem[]>([]),
    setTtsPlaybackWanted: jest.fn(),
    setTtsPlayingWithReason: jest.fn(),
    setTtsUiStatus: jest.fn(),
    setTtsUri: jest.fn(),
    setTtsSoundWithRef: jest.fn(),
    attachTtsSoundStatusHandler: jest.fn(),
    waitForPlaybackToFinish: jest.fn(async () => {}),
    markTtsPlaybackStopped: jest.fn(),
  };
}

const createAsync = Audio.Sound.createAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

test("loads one next chunk during current playback and reuses it", async () => {
  const first = queueItem(0);
  const second = queueItem(1);
  const firstSound = sound();
  const secondSound = sound();
  createAsync
    .mockResolvedValueOnce({ sound: firstSound })
    .mockResolvedValueOnce({ sound: secondSound });
  const options = createOptions();
  options.streamAudioQueueRef.current = [second];
  const { result } = await renderHook(() => usePlayPreparedStreamAudioController(options));

  await result.current.playPreparedStreamAudioAndWait(first);

  expect(firstSound.playAsync).toHaveBeenCalledTimes(1);
  expect(createAsync).toHaveBeenNthCalledWith(
    2,
    { uri: second.uri },
    { shouldPlay: false, volume: 1 }
  );
  expect(secondSound.playAsync).not.toHaveBeenCalled();

  options.streamAudioQueueRef.current = [];
  await result.current.playPreparedStreamAudioAndWait(second);

  expect(createAsync).toHaveBeenCalledTimes(2);
  expect(secondSound.playAsync).toHaveBeenCalledTimes(1);
});

test("unloads a pending lookahead chunk when the queue is cleared", async () => {
  const next = queueItem(1);
  const nextSound = sound();
  let resolveLoad: (value: { sound: typeof nextSound }) => void = () => {};
  createAsync.mockImplementationOnce(() => new Promise((resolve) => {
    resolveLoad = resolve;
  }));
  const { result } = await renderHook(() => usePlayPreparedStreamAudioController(createOptions()));

  result.current.preloadStreamAudio(next);
  result.current.clearPreloadedStreamAudio();
  resolveLoad({ sound: nextSound });

  await waitFor(() => expect(nextSound.unloadAsync).toHaveBeenCalledTimes(1));
});

test("queue clearing does not cancel the chunk already being loaded for playback", async () => {
  const current = queueItem(0);
  const currentSound = sound();
  let resolveLoad: (value: { sound: typeof currentSound }) => void = () => {};
  createAsync.mockImplementationOnce(() => new Promise((resolve) => {
    resolveLoad = resolve;
  }));
  const { result } = await renderHook(() => usePlayPreparedStreamAudioController(createOptions()));

  const playback = result.current.playPreparedStreamAudioAndWait(current);
  result.current.clearPreloadedStreamAudio();
  resolveLoad({ sound: currentSound });

  await expect(playback).resolves.toBe(true);
  expect(currentSound.playAsync).toHaveBeenCalledTimes(1);
  expect(currentSound.unloadAsync).not.toHaveBeenCalled();
});

test("unloads the current chunk if playback was stopped while it was loading", async () => {
  const current = queueItem(0);
  const currentSound = sound();
  let resolveLoad: (value: { sound: typeof currentSound }) => void = () => {};
  createAsync.mockImplementationOnce(() => new Promise((resolve) => {
    resolveLoad = resolve;
  }));
  const options = createOptions();
  const { result } = await renderHook(() => usePlayPreparedStreamAudioController(options));

  const playback = result.current.playPreparedStreamAudioAndWait(current);
  options.ttsPlaybackRunIdRef.current += 1;
  result.current.clearPreloadedStreamAudio();
  resolveLoad({ sound: currentSound });

  await expect(playback).resolves.toBe(false);
  expect(currentSound.playAsync).not.toHaveBeenCalled();
  expect(currentSound.unloadAsync).toHaveBeenCalledTimes(1);
});

test("keeps only the first requested lookahead chunk", async () => {
  const first = queueItem(1);
  const second = queueItem(2);
  const firstSound = sound();
  createAsync.mockResolvedValueOnce({ sound: firstSound });
  const { result } = await renderHook(() => usePlayPreparedStreamAudioController(createOptions()));

  result.current.preloadStreamAudio(first);
  result.current.preloadStreamAudio(second);

  expect(createAsync).toHaveBeenCalledTimes(1);
  expect(createAsync).toHaveBeenCalledWith(
    { uri: first.uri },
    { shouldPlay: false, volume: 1 }
  );
});

test("does not preload another chunk after playback was stopped", async () => {
  const first = queueItem(0);
  const second = queueItem(1);
  const firstSound = sound();
  let finishPlay: () => void = () => {};
  firstSound.playAsync.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishPlay = resolve;
  }));
  createAsync.mockResolvedValueOnce({ sound: firstSound });
  const options = createOptions();
  options.streamAudioQueueRef.current = [second];
  const { result } = await renderHook(() => usePlayPreparedStreamAudioController(options));

  const playback = result.current.playPreparedStreamAudioAndWait(first);
  await waitFor(() => expect(firstSound.playAsync).toHaveBeenCalledTimes(1));
  options.ttsPlaybackRunIdRef.current += 1;
  finishPlay();

  await expect(playback).resolves.toBe(false);
  expect(createAsync).toHaveBeenCalledTimes(1);
});

test("does not preload a next chunk that was removed from the queue", async () => {
  const first = queueItem(0);
  const firstSound = sound();
  createAsync.mockResolvedValueOnce({ sound: firstSound });
  const options = createOptions();
  const { result } = await renderHook(() => usePlayPreparedStreamAudioController(options));

  await result.current.playPreparedStreamAudioAndWait(first);

  expect(createAsync).toHaveBeenCalledTimes(1);
});

test("can load a later chunk after a preload error", async () => {
  const failed = queueItem(0);
  const next = queueItem(1);
  const nextSound = sound();
  createAsync
    .mockRejectedValueOnce(new Error("load failed"))
    .mockResolvedValueOnce({ sound: nextSound });
  const options = createOptions();
  const { result } = await renderHook(() => usePlayPreparedStreamAudioController(options));

  await expect(result.current.playPreparedStreamAudioAndWait(failed)).rejects.toThrow("load failed");
  await expect(result.current.playPreparedStreamAudioAndWait(next)).resolves.toBe(true);

  expect(createAsync).toHaveBeenCalledTimes(2);
  expect(nextSound.playAsync).toHaveBeenCalledTimes(1);
});
