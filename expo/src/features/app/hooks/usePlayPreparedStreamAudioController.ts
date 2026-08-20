import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { Audio } from "../audio";
import type { StreamAudioQueueItem, TtsUiStatus } from "../types/appTypes";

type StreamAudioPreload = {
  item: StreamAudioQueueItem;
  sound: Promise<Audio.Sound>;
  claimed: boolean;
};

type UsePlayPreparedStreamAudioControllerOptions = {
  fixedMediaVolume: number;
  ttsStopInFlightRef: MutableRefObject<Promise<void> | null>;
  ttsPlaybackRunIdRef: MutableRefObject<number>;
  ttsPlaybackProgressUiAtRef: MutableRefObject<number>;
  ttsPlaybackTransitionInFlightRef: MutableRefObject<boolean>;
  ttsPlaybackLastPlayingAtRef: MutableRefObject<number>;
  streamAudioQueueRef: MutableRefObject<StreamAudioQueueItem[]>;
  setTtsPlaybackWanted: (next: boolean, reason: string, payload?: Record<string, unknown>) => void;
  setTtsPlayingWithReason: (next: boolean, reason: string, payload?: Record<string, unknown>) => void;
  setTtsUiStatus: (value: TtsUiStatus) => void;
  setTtsUri: (value: string) => void;
  setTtsSoundWithRef: (
    next: Audio.Sound | null | ((current: Audio.Sound | null) => Audio.Sound | null)
  ) => void;
  attachTtsSoundStatusHandler: (
    sound: Audio.Sound,
    runId: number,
    streamChunk?: StreamAudioQueueItem | null
  ) => void;
  waitForPlaybackToFinish: (
    expectedRunId: number,
    timeoutMs?: number
  ) => Promise<void>;
  markTtsPlaybackStopped: () => void;
};

export function usePlayPreparedStreamAudioController(
  options: UsePlayPreparedStreamAudioControllerOptions
) {
  const {
    fixedMediaVolume,
    ttsStopInFlightRef,
    ttsPlaybackRunIdRef,
    ttsPlaybackProgressUiAtRef,
    ttsPlaybackTransitionInFlightRef,
    ttsPlaybackLastPlayingAtRef,
    streamAudioQueueRef,
    setTtsPlaybackWanted,
    setTtsPlayingWithReason,
    setTtsUiStatus,
    setTtsUri,
    setTtsSoundWithRef,
    attachTtsSoundStatusHandler,
    waitForPlaybackToFinish,
    markTtsPlaybackStopped,
  } = options;
  const streamAudioPreloadRef = useRef<StreamAudioPreload | null>(null);

  const clearPreloadedStreamAudio = useCallback((includeClaimed = false) => {
    const preload = streamAudioPreloadRef.current;
    if (!preload || (preload.claimed && !includeClaimed)) return;
    streamAudioPreloadRef.current = null;
    void preload.sound.then((sound) => sound.unloadAsync()).catch(() => {});
  }, [streamAudioPreloadRef]);

  const preloadStreamAudio = useCallback((item: StreamAudioQueueItem) => {
    if (streamAudioPreloadRef.current) return;
    const sound = Audio.Sound.createAsync(
      { uri: item.uri },
      { shouldPlay: false, volume: fixedMediaVolume }
    ).then((playback) => playback.sound);
    void sound.catch(() => {});
    streamAudioPreloadRef.current = {
      item,
      sound,
      claimed: false,
    };
  }, [fixedMediaVolume, streamAudioPreloadRef]);

  useEffect(() => () => {
    clearPreloadedStreamAudio(true);
  }, [clearPreloadedStreamAudio]);

  const playPreparedStreamAudioAndWait = useCallback(async (item: StreamAudioQueueItem) => {
    if (ttsStopInFlightRef.current) {
      await ttsStopInFlightRef.current.catch(() => {});
    }
    const runId = ttsPlaybackRunIdRef.current + 1;
    ttsPlaybackRunIdRef.current = runId;
    setTtsPlaybackWanted(true, "play_stream_audio_start", {
      mode: "stream",
      seq: item.seq,
      runId,
    });
    setTtsPlayingWithReason(true, "play_stream_audio_start", {
      mode: "stream",
      seq: item.seq,
      runId,
    });
    setTtsUiStatus("playing");
    ttsPlaybackProgressUiAtRef.current = 0;
    ttsPlaybackTransitionInFlightRef.current = true;
    try {
      if (streamAudioPreloadRef.current?.item !== item) {
        clearPreloadedStreamAudio();
        preloadStreamAudio(item);
      }
      const preload = streamAudioPreloadRef.current;
      if (!preload) {
        throw new Error("stream audio の先読みを開始できませんでした。");
      }
      preload.claimed = true;
      let sound: Audio.Sound;
      try {
        sound = await preload.sound;
      } catch (error) {
        if (streamAudioPreloadRef.current === preload) {
          streamAudioPreloadRef.current = null;
        }
        throw error;
      }
      if (streamAudioPreloadRef.current !== preload) {
        return false;
      }
      streamAudioPreloadRef.current = null;
      if (runId !== ttsPlaybackRunIdRef.current) {
        await sound.unloadAsync().catch(() => {});
        return false;
      }
      attachTtsSoundStatusHandler(sound, runId, item);
      setTtsUri(item.uri);
      setTtsSoundWithRef(sound);
      await sound.playAsync();
      if (runId !== ttsPlaybackRunIdRef.current) {
        return false;
      }
      const nextItem = streamAudioQueueRef.current[0];
      if (nextItem) preloadStreamAudio(nextItem);
      ttsPlaybackLastPlayingAtRef.current = Date.now();
      ttsPlaybackTransitionInFlightRef.current = false;
      await waitForPlaybackToFinish(runId);
      return runId === ttsPlaybackRunIdRef.current;
    } catch (e) {
      markTtsPlaybackStopped();
      throw e;
    } finally {
      ttsPlaybackTransitionInFlightRef.current = false;
    }
  }, [
    attachTtsSoundStatusHandler,
    clearPreloadedStreamAudio,
    markTtsPlaybackStopped,
    preloadStreamAudio,
    setTtsPlaybackWanted,
    setTtsPlayingWithReason,
    setTtsSoundWithRef,
    setTtsUiStatus,
    setTtsUri,
    streamAudioQueueRef,
    ttsPlaybackLastPlayingAtRef,
    ttsPlaybackProgressUiAtRef,
    ttsPlaybackRunIdRef,
    ttsPlaybackTransitionInFlightRef,
    ttsStopInFlightRef,
    waitForPlaybackToFinish,
  ]);

  return {
    clearPreloadedStreamAudio,
    playPreparedStreamAudioAndWait,
    preloadStreamAudio,
  };
}
