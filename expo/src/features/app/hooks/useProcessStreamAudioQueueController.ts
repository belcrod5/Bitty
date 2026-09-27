import { useCallback, type MutableRefObject, type SetStateAction } from "react";
import type {
  StreamAudioQueueItem,
  StreamSegment,
  StreamSegmentStatus,
  StreamTtsControlState,
} from "../types/appTypes";

type TtsUiStatus = "idle" | "queued" | "synthesizing" | "playing" | "error";

type UseProcessStreamAudioQueueControllerOptions = {
  streamAudioQueueProcessingRef: MutableRefObject<boolean>;
  streamAudioQueueRef: MutableRefObject<StreamAudioQueueItem[]>;
  streamCurrentChunkStartedAtRef: MutableRefObject<number>;
  streamCurrentChunkEstimatedDurationMsRef: MutableRefObject<number | null>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  ttsPlayingRef: MutableRefObject<boolean>;
  ttsPlaybackMessageIdRef: MutableRefObject<string>;
  setTtsQueueProcessing: (next: boolean) => void;
  syncTtsPlaybackWantedFromPipeline: (reason: string, payload?: Record<string, unknown>) => void;
  prepareTtsPlaybackSession: () => Promise<void>;
  setStreamAudioQueueSize: (value: number) => void;
  setTtsPlaybackMessageIdWithRef: (next: string) => void;
  upsertStreamSegment: (
    messageId: string,
    seq: number,
    textDelta: string,
    status: StreamSegmentStatus,
    updates?: Partial<StreamSegment>
  ) => void;
  setTtsUiStatus: (value: SetStateAction<TtsUiStatus>) => void;
  playPreparedStreamAudioAndWait: (item: StreamAudioQueueItem) => Promise<boolean>;
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
    streamSocketRef,
    streamTtsControlRef,
    ttsPlayingRef,
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
    let completed = false;
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
        upsertStreamSegment(playbackMessageId, next.seq, "", "playing");
        setTtsUiStatus("playing");
        streamCurrentChunkStartedAtRef.current = Date.now();
        streamCurrentChunkEstimatedDurationMsRef.current = (
          Number.isFinite(Number(next.estimatedDurationMs)) && Number(next.estimatedDurationMs) > 0
            ? Number(next.estimatedDurationMs)
            : null
        );
        try {
          const played = await playPreparedStreamAudioAndWait(next);
          if (!played) continue;
        } finally {
          streamCurrentChunkStartedAtRef.current = 0;
          streamCurrentChunkEstimatedDurationMsRef.current = null;
        }
        upsertStreamSegment(playbackMessageId, next.seq, "", "played", {
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
      completed = true;
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
      if (
        completed &&
        !ttsPlayingRef.current &&
        streamAudioQueueRef.current.length === 0 &&
        streamSocketRef.current === null &&
        streamTtsControlRef.current === null
      ) {
        setTtsUiStatus((current) => current === "playing" ? "idle" : current);
      }
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
    streamSocketRef,
    streamTtsControlRef,
    syncTtsPlaybackWantedFromPipeline,
    ttsPlayingRef,
    ttsPlaybackMessageIdRef,
    upsertStreamSegment,
  ]);
}
