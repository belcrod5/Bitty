import { useCallback, type MutableRefObject } from "react";
import type { StreamAudioQueueItem, StreamTtsControlState } from "../types/appTypes";
import { ttsDiagnosticError } from "../utils/appDiagnostics";

type EnqueueMeta = {
  chunkChars?: number | null;
  segmentTargetChars?: number | null;
  estimatedDurationMs?: number | null;
};

type UseEnqueueStreamAudioControllerOptions = {
  streamAudioQueueGenerationRef: MutableRefObject<number>;
  streamAudioEnqueueChainRef: MutableRefObject<Promise<void>>;
  streamTtsSuppressedRef: MutableRefObject<boolean>;
  streamAudioQueueRef: MutableRefObject<StreamAudioQueueItem[]>;
  streamAudioQueueProcessingRef: MutableRefObject<boolean>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  setTtsPlaybackWanted: (next: boolean, reason: string, payload?: Record<string, unknown>) => void;
  setStreamAudioQueueSize: (value: number) => void;
  preloadStreamAudio: (item: StreamAudioQueueItem) => void;
  processStreamAudioQueue: () => Promise<void>;
  setReplyDebug: (value: string | ((prev: string) => string)) => void;
  shouldProjectTtsDebugToActiveSession: () => boolean;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
};

function buildStreamAudioQueueItem(
  seq: number,
  audioUrl: string,
  mimeType: string,
  playbackMessageId: string,
  options?: EnqueueMeta
): StreamAudioQueueItem {
  const normalizedAudioUrl = String(audioUrl || "").trim();
  if (!normalizedAudioUrl) {
    throw new Error("stream audio が空です。");
  }
  const normalizedMimeType = String(mimeType || "").trim().toLowerCase();
  return {
    seq,
    mimeType: normalizedMimeType || mimeType,
    playbackMessageId: String(playbackMessageId || "").trim(),
    uri: normalizedAudioUrl,
    chunkChars: options?.chunkChars ?? null,
    segmentTargetChars: options?.segmentTargetChars ?? null,
    estimatedDurationMs: options?.estimatedDurationMs ?? null,
    actualDurationMs: null,
  };
}

export function useEnqueueStreamAudioController(options: UseEnqueueStreamAudioControllerOptions) {
  const {
    streamAudioQueueGenerationRef,
    streamAudioEnqueueChainRef,
    streamTtsSuppressedRef,
    streamAudioQueueRef,
    streamAudioQueueProcessingRef,
    streamSocketRef,
    streamTtsControlRef,
    setTtsPlaybackWanted,
    setStreamAudioQueueSize,
    preloadStreamAudio,
    processStreamAudioQueue,
    setReplyDebug,
    shouldProjectTtsDebugToActiveSession,
    logAuto,
  } = options;

  return useCallback((
    seq: number,
    audioUrl: string,
    mimeType: string,
    playbackMessageId: string,
    enqueueOptions?: EnqueueMeta
  ) => {
    if (!audioUrl) {
      logAuto("tts_trace", { stage: "enqueue_dropped", reason: "empty_audio", messageId: playbackMessageId, seq });
      return;
    }
    const generation = streamAudioQueueGenerationRef.current;
    streamAudioEnqueueChainRef.current = streamAudioEnqueueChainRef.current
      .then(async () => {
        if (generation !== streamAudioQueueGenerationRef.current) {
          logAuto("tts_trace", { stage: "enqueue_dropped", reason: "generation", messageId: playbackMessageId, seq });
          return;
        }
        if (streamTtsSuppressedRef.current) {
          logAuto("tts_trace", { stage: "enqueue_dropped", reason: "suppressed", messageId: playbackMessageId, seq });
          return;
        }
        const prepared = buildStreamAudioQueueItem(
          seq,
          audioUrl,
          mimeType,
          playbackMessageId,
          enqueueOptions
        );
        if (generation !== streamAudioQueueGenerationRef.current || streamTtsSuppressedRef.current) {
          logAuto("tts_trace", {
            stage: "enqueue_dropped",
            reason: generation !== streamAudioQueueGenerationRef.current ? "generation" : "suppressed",
            messageId: playbackMessageId,
            seq,
          });
          return;
        }
        streamAudioQueueRef.current.push(prepared);
        logAuto("tts_trace", {
          stage: "enqueued",
          messageId: playbackMessageId,
          seq,
          queueSize: streamAudioQueueRef.current.length,
        });
        setTtsPlaybackWanted(true, "stream_chunk_enqueued", {
          seq,
          streamQueueSize: streamAudioQueueRef.current.length,
          streamSocketAlive: streamSocketRef.current !== null,
          streamTtsControlAlive: streamTtsControlRef.current !== null,
        });
        setStreamAudioQueueSize(streamAudioQueueRef.current.length);
        if (
          streamAudioQueueProcessingRef.current &&
          streamAudioQueueRef.current.length === 1
        ) {
          preloadStreamAudio(prepared);
        }
        void processStreamAudioQueue();
      })
      .catch((e) => {
        logAuto("tts_trace", { stage: "enqueue_error", messageId: playbackMessageId, seq, error: ttsDiagnosticError(e) });
        const message = e instanceof Error ? e.message : String(e);
        if (shouldProjectTtsDebugToActiveSession()) {
          setReplyDebug((prev) => (
            prev ? `${prev} | stream_prepare_error=${message}` : `stream_prepare_error=${message}`
          ));
        }
      });
  }, [
    logAuto,
    processStreamAudioQueue,
    preloadStreamAudio,
    setReplyDebug,
    shouldProjectTtsDebugToActiveSession,
    setStreamAudioQueueSize,
    setTtsPlaybackWanted,
    streamAudioEnqueueChainRef,
    streamAudioQueueGenerationRef,
    streamAudioQueueProcessingRef,
    streamAudioQueueRef,
    streamSocketRef,
    streamTtsControlRef,
    streamTtsSuppressedRef,
  ]);
}
