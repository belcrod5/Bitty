import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";
import type { StreamAudioQueueItem, TtsUiStatus } from "../types/appTypes";

type UsePlayPreparedStreamAudioControllerOptions = {
  fixedMediaVolume: number;
  ttsStopInFlightRef: MutableRefObject<Promise<void> | null>;
  ttsPlaybackRunIdRef: MutableRefObject<number>;
  ttsPlaybackProgressUiAtRef: MutableRefObject<number>;
  ttsPlaybackTransitionInFlightRef: MutableRefObject<boolean>;
  ttsPlaybackLastPlayingAtRef: MutableRefObject<number>;
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
    setTtsPlaybackWanted,
    setTtsPlayingWithReason,
    setTtsUiStatus,
    setTtsUri,
    setTtsSoundWithRef,
    attachTtsSoundStatusHandler,
    waitForPlaybackToFinish,
    markTtsPlaybackStopped,
  } = options;

  return useCallback(async (item: StreamAudioQueueItem) => {
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
      const sound = (
        await Audio.Sound.createAsync(
          { uri: item.uri },
          { shouldPlay: false, volume: fixedMediaVolume }
        )
      ).sound;
      attachTtsSoundStatusHandler(sound, runId, item);
      setTtsUri(item.uri);
      setTtsSoundWithRef(sound);
      await sound.playAsync();
      ttsPlaybackLastPlayingAtRef.current = Date.now();
      ttsPlaybackTransitionInFlightRef.current = false;
      await waitForPlaybackToFinish(runId);
    } catch (e) {
      markTtsPlaybackStopped();
      throw e;
    } finally {
      ttsPlaybackTransitionInFlightRef.current = false;
    }
  }, [
    attachTtsSoundStatusHandler,
    fixedMediaVolume,
    markTtsPlaybackStopped,
    setTtsPlaybackWanted,
    setTtsPlayingWithReason,
    setTtsSoundWithRef,
    setTtsUiStatus,
    setTtsUri,
    ttsPlaybackLastPlayingAtRef,
    ttsPlaybackProgressUiAtRef,
    ttsPlaybackRunIdRef,
    ttsPlaybackTransitionInFlightRef,
    ttsStopInFlightRef,
    waitForPlaybackToFinish,
  ]);
}
