import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";
import type { StreamAudioQueueItem, StreamTtsControlState } from "../types/appTypes";

type TtsUiStatus = "idle" | "queued" | "synthesizing" | "playing" | "error";

type UseTtsPlaybackStateControllerOptions = {
  nearUnlimitedTimeoutMs: number;
  autoBargeInTtsGapGraceMs: number;
  autoLastTtsStoppedAtRef: MutableRefObject<number>;
  autoLastTtsStopRequestedAtRef: MutableRefObject<number>;
  autoPlaybackBargeGraceUntilRef: MutableRefObject<number>;
  replyLoadingRef: MutableRefObject<boolean>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  streamAudioQueueRef: MutableRefObject<StreamAudioQueueItem[]>;
  streamAudioQueueProcessingRef: MutableRefObject<boolean>;
  streamCurrentChunkStartedAtRef: MutableRefObject<number>;
  streamCurrentChunkEstimatedDurationMsRef: MutableRefObject<number | null>;
  streamAudioQueueGenerationRef: MutableRefObject<number>;
  streamAudioEnqueueChainRef: MutableRefObject<Promise<void>>;
  ttsPlayingRef: MutableRefObject<boolean>;
  ttsPlaybackWantedRef: MutableRefObject<boolean>;
  ttsPlaybackRunIdRef: MutableRefObject<number>;
  ttsPlaybackProgressUiAtRef: MutableRefObject<number>;
  ttsSoundRef: MutableRefObject<Audio.Sound | null>;
  setTtsPlaying: (next: boolean) => void;
  setTtsUiStatus: (next: TtsUiStatus) => void;
  setStreamAudioQueueSize: (next: number) => void;
  setTtsPlaybackWanted: (next: boolean, reason: string, payload?: Record<string, unknown>) => void;
  setTtsPlaybackMessageIdWithRef: (next: string) => void;
  clearTtsPlaybackWatchdogTimer: () => void;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
  elapsedSinceMs: (startedAtMs: number) => number | null;
};

export function useTtsPlaybackStateController(options: UseTtsPlaybackStateControllerOptions) {
  const {
    nearUnlimitedTimeoutMs,
    autoBargeInTtsGapGraceMs,
    autoLastTtsStoppedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoPlaybackBargeGraceUntilRef,
    replyLoadingRef,
    streamSocketRef,
    streamTtsControlRef,
    streamAudioQueueRef,
    streamAudioQueueProcessingRef,
    streamCurrentChunkStartedAtRef,
    streamCurrentChunkEstimatedDurationMsRef,
    streamAudioQueueGenerationRef,
    streamAudioEnqueueChainRef,
    ttsPlayingRef,
    ttsPlaybackWantedRef,
    ttsPlaybackRunIdRef,
    ttsPlaybackProgressUiAtRef,
    ttsSoundRef,
    setTtsPlaying,
    setTtsUiStatus,
    setStreamAudioQueueSize,
    setTtsPlaybackWanted,
    setTtsPlaybackMessageIdWithRef,
    clearTtsPlaybackWatchdogTimer,
    logAuto,
    elapsedSinceMs,
  } = options;

  const setTtsPlayingWithReason = useCallback((
    next: boolean,
    reason: string,
    payload: Record<string, unknown> = {}
  ) => {
    const now = Date.now();
    const prev = ttsPlayingRef.current;
    if (prev !== next) {
      logAuto("tts_playing_changed", {
        from: prev,
        to: next,
        reason,
        ...payload,
      });
    }
    if (prev && !next) {
      autoLastTtsStoppedAtRef.current = now;
      logAuto("tts_stop_effective", {
        reason,
        sinceTtsStopRequestedMs: elapsedSinceMs(autoLastTtsStopRequestedAtRef.current),
        streamSocketAlive: streamSocketRef.current !== null,
        streamTtsControlAlive: streamTtsControlRef.current !== null,
        streamQueueSize: streamAudioQueueRef.current.length,
        replyLoading: replyLoadingRef.current,
      });
    }
    if (next) {
      autoPlaybackBargeGraceUntilRef.current = now + autoBargeInTtsGapGraceMs;
    } else if (
      replyLoadingRef.current ||
      streamTtsControlRef.current !== null ||
      streamSocketRef.current !== null
    ) {
      autoPlaybackBargeGraceUntilRef.current = Math.max(
        autoPlaybackBargeGraceUntilRef.current,
        now + autoBargeInTtsGapGraceMs
      );
    }
    ttsPlayingRef.current = next;
    setTtsPlaying(next);
  }, [
    autoBargeInTtsGapGraceMs,
    autoLastTtsStoppedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoPlaybackBargeGraceUntilRef,
    elapsedSinceMs,
    logAuto,
    replyLoadingRef,
    setTtsPlaying,
    streamAudioQueueRef,
    streamSocketRef,
    streamTtsControlRef,
    ttsPlayingRef,
  ]);

  const markTtsChunkPlaybackFinished = useCallback(() => {
    setTtsPlayingWithReason(false, "chunk_finished");
    ttsPlaybackProgressUiAtRef.current = 0;
  }, [
    setTtsPlayingWithReason,
    ttsPlaybackProgressUiAtRef,
  ]);

  const markTtsPlaybackStopped = useCallback(() => {
    setTtsPlaybackWanted(false, "playback_stopped", {
      streamQueueSize: streamAudioQueueRef.current.length,
      streamQueueProcessing: streamAudioQueueProcessingRef.current,
      streamSocketAlive: streamSocketRef.current !== null,
      streamTtsControlAlive: streamTtsControlRef.current !== null,
    });
    markTtsChunkPlaybackFinished();
    streamCurrentChunkStartedAtRef.current = 0;
    streamCurrentChunkEstimatedDurationMsRef.current = null;
    setTtsUiStatus("idle");
    setTtsPlaybackMessageIdWithRef("");
    if (!ttsSoundRef.current) {
      clearTtsPlaybackWatchdogTimer();
    }
  }, [
    clearTtsPlaybackWatchdogTimer,
    markTtsChunkPlaybackFinished,
    setTtsPlaybackMessageIdWithRef,
    setTtsPlaybackWanted,
    setTtsUiStatus,
    streamAudioQueueProcessingRef,
    streamAudioQueueRef,
    streamCurrentChunkEstimatedDurationMsRef,
    streamCurrentChunkStartedAtRef,
    streamSocketRef,
    streamTtsControlRef,
    ttsSoundRef,
  ]);

  const clearStreamAudioQueue = useCallback((clearOptions?: { bumpGeneration?: boolean }) => {
    const bumpGeneration = clearOptions?.bumpGeneration ?? true;
    streamAudioQueueRef.current = [];
    streamCurrentChunkStartedAtRef.current = 0;
    streamCurrentChunkEstimatedDurationMsRef.current = null;
    setStreamAudioQueueSize(0);
    if (bumpGeneration) {
      streamAudioQueueGenerationRef.current += 1;
      streamAudioEnqueueChainRef.current = Promise.resolve();
    }
  }, [
    setStreamAudioQueueSize,
    streamAudioEnqueueChainRef,
    streamAudioQueueGenerationRef,
    streamAudioQueueRef,
    streamCurrentChunkEstimatedDurationMsRef,
    streamCurrentChunkStartedAtRef,
  ]);

  const waitForPlaybackToFinish = useCallback(async (
    expectedRunId: number,
    timeoutMs = nearUnlimitedTimeoutMs
  ) => {
    const startedAt = Date.now();
    while (ttsPlayingRef.current && ttsPlaybackWantedRef.current) {
      if (expectedRunId !== ttsPlaybackRunIdRef.current) {
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("音声再生タイムアウト");
      }
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }, [
    nearUnlimitedTimeoutMs,
    ttsPlaybackRunIdRef,
    ttsPlaybackWantedRef,
    ttsPlayingRef,
  ]);

  return {
    setTtsPlayingWithReason,
    markTtsChunkPlaybackFinished,
    markTtsPlaybackStopped,
    clearStreamAudioQueue,
    waitForPlaybackToFinish,
  };
}
