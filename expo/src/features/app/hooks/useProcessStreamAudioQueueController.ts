import { useCallback, type MutableRefObject } from "react";
import type {
  StreamAudioQueueItem,
  StreamSegment,
  StreamSegmentStatus,
} from "../types/appTypes";

type TtsUiStatus = "idle" | "queued" | "synthesizing" | "playing" | "error";

type UseProcessStreamAudioQueueControllerOptions = {
  streamAudioQueueProcessingRef: MutableRefObject<boolean>;
  streamAudioQueueRef: MutableRefObject<StreamAudioQueueItem[]>;
  streamCurrentChunkStartedAtRef: MutableRefObject<number>;
  streamCurrentChunkEstimatedDurationMsRef: MutableRefObject<number | null>;
  ttsPlaybackMessageIdRef: MutableRefObject<string>;
  setTtsQueueProcessing: (next: boolean) => void;
  syncTtsPlaybackWantedFromPipeline: (reason: string, payload?: Record<string, unknown>) => void;
  prepareTtsPlaybackSession: () => Promise<void>;
  setStreamAudioQueueSize: (value: number) => void;
  setTtsPlaybackMessageIdWithRef: (next: string) => void;
  upsertStreamSegment: (
    seq: number,
    textDelta: string,
    status: StreamSegmentStatus,
    updates?: Partial<StreamSegment>
  ) => void;
  setTtsUiStatus: (value: TtsUiStatus) => void;
  playPreparedStreamAudioAndWait: (item: StreamAudioQueueItem) => Promise<void>;
  setReplyDebug: (value: string | ((prev: string) => string)) => void;
  shouldProjectTtsDebugToActiveSession: () => boolean;
  reportError: (error: unknown, context?: string) => void;
  markTtsPlaybackStopped: () => void;
  clearStreamAudioQueue: (options?: { bumpGeneration?: boolean }) => void;
};

export function useProcessStreamAudioQueueController(
  options: UseProcessStreamAudioQueueControllerOptions
) {
  const {
    streamAudioQueueProcessingRef,
    streamAudioQueueRef,
    streamCurrentChunkStartedAtRef,
    streamCurrentChunkEstimatedDurationMsRef,
    ttsPlaybackMessageIdRef,
    setTtsQueueProcessing,
    syncTtsPlaybackWantedFromPipeline,
    prepareTtsPlaybackSession,
    setStreamAudioQueueSize,
    setTtsPlaybackMessageIdWithRef,
    upsertStreamSegment,
    setTtsUiStatus,
    playPreparedStreamAudioAndWait,
    setReplyDebug,
    shouldProjectTtsDebugToActiveSession,
    reportError,
    markTtsPlaybackStopped,
    clearStreamAudioQueue,
  } = options;

  return useCallback(async () => {
    if (streamAudioQueueProcessingRef.current) return;
    streamAudioQueueProcessingRef.current = true;
    setTtsQueueProcessing(true);
    syncTtsPlaybackWantedFromPipeline("stream_queue_process_start");
    try {
      await prepareTtsPlaybackSession();
      while (streamAudioQueueRef.current.length > 0) {
        const next = streamAudioQueueRef.current.shift();
        setStreamAudioQueueSize(streamAudioQueueRef.current.length);
        if (!next) continue;
        const playbackMessageId = String(next.playbackMessageId || "").trim();
        if (playbackMessageId && playbackMessageId !== ttsPlaybackMessageIdRef.current) {
          setTtsPlaybackMessageIdWithRef(playbackMessageId);
        }
        upsertStreamSegment(next.seq, "", "playing");
        setTtsUiStatus("playing");
        streamCurrentChunkStartedAtRef.current = Date.now();
        streamCurrentChunkEstimatedDurationMsRef.current = (
          Number.isFinite(Number(next.estimatedDurationMs)) && Number(next.estimatedDurationMs) > 0
            ? Number(next.estimatedDurationMs)
            : null
        );
        try {
          await playPreparedStreamAudioAndWait(next);
        } finally {
          streamCurrentChunkStartedAtRef.current = 0;
          streamCurrentChunkEstimatedDurationMsRef.current = null;
        }
        upsertStreamSegment(next.seq, "", "played", {
          chunkChars: Number.isFinite(Number(next.chunkChars)) ? Number(next.chunkChars) : null,
          segmentTargetChars: Number.isFinite(Number(next.segmentTargetChars))
            ? Number(next.segmentTargetChars)
            : null,
          estimatedDurationMs: Number.isFinite(Number(next.estimatedDurationMs))
            ? Number(next.estimatedDurationMs)
            : null,
          actualDurationMs: Number.isFinite(Number(next.actualDurationMs))
            ? Number(next.actualDurationMs)
            : null,
        });
        if (streamAudioQueueRef.current.length > 0) {
          setTtsUiStatus("queued");
        }
      }
    } catch (e) {
      console.error("[stream-audio] playback error", e);
      if (shouldProjectTtsDebugToActiveSession()) {
        setReplyDebug(`route=stream-tts audio_error=${e instanceof Error ? e.message : String(e)}`);
        reportError(e, "stream-audio");
      }
      setTtsUiStatus("error");
      markTtsPlaybackStopped();
      clearStreamAudioQueue();
    } finally {
      streamAudioQueueProcessingRef.current = false;
      setTtsQueueProcessing(false);
      setStreamAudioQueueSize(streamAudioQueueRef.current.length);
      syncTtsPlaybackWantedFromPipeline("stream_queue_process_finally");
    }
  }, [
    clearStreamAudioQueue,
    markTtsPlaybackStopped,
    playPreparedStreamAudioAndWait,
    prepareTtsPlaybackSession,
    reportError,
    setReplyDebug,
    shouldProjectTtsDebugToActiveSession,
    setStreamAudioQueueSize,
    setTtsPlaybackMessageIdWithRef,
    setTtsQueueProcessing,
    setTtsUiStatus,
    streamAudioQueueProcessingRef,
    streamAudioQueueRef,
    streamCurrentChunkEstimatedDurationMsRef,
    streamCurrentChunkStartedAtRef,
    syncTtsPlaybackWantedFromPipeline,
    ttsPlaybackMessageIdRef,
    upsertStreamSegment,
  ]);
}
