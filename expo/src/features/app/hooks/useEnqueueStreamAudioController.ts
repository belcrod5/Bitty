import { useCallback, type MutableRefObject } from "react";
import type { StreamAudioQueueItem, StreamTtsControlState } from "../types/appTypes";

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
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  setTtsPlaybackWanted: (next: boolean, reason: string, payload?: Record<string, unknown>) => void;
  setTtsUiStatus: (value: "idle" | "queued" | "synthesizing" | "playing" | "error") => void;
  setStreamAudioQueueSize: (value: number) => void;
  processStreamAudioQueue: () => Promise<void>;
  setReplyDebug: (value: string | ((prev: string) => string)) => void;
  shouldProjectTtsDebugToActiveSession: () => boolean;
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
    streamSocketRef,
    streamTtsControlRef,
    setTtsPlaybackWanted,
    setTtsUiStatus,
    setStreamAudioQueueSize,
    processStreamAudioQueue,
    setReplyDebug,
    shouldProjectTtsDebugToActiveSession,
  } = options;

  return useCallback((
    seq: number,
    audioUrl: string,
    mimeType: string,
    playbackMessageId: string,
    enqueueOptions?: EnqueueMeta
  ) => {
    if (!audioUrl) return;
    const generation = streamAudioQueueGenerationRef.current;
    streamAudioEnqueueChainRef.current = streamAudioEnqueueChainRef.current
      .then(async () => {
        if (generation !== streamAudioQueueGenerationRef.current) return;
        if (streamTtsSuppressedRef.current) return;
        const prepared = buildStreamAudioQueueItem(
          seq,
          audioUrl,
          mimeType,
          playbackMessageId,
          enqueueOptions
        );
        if (generation !== streamAudioQueueGenerationRef.current || streamTtsSuppressedRef.current) {
          return;
        }
        streamAudioQueueRef.current.push(prepared);
        setTtsPlaybackWanted(true, "stream_chunk_enqueued", {
          seq,
          streamQueueSize: streamAudioQueueRef.current.length,
          streamSocketAlive: streamSocketRef.current !== null,
          streamTtsControlAlive: streamTtsControlRef.current !== null,
        });
        setTtsUiStatus("queued");
        setStreamAudioQueueSize(streamAudioQueueRef.current.length);
        void processStreamAudioQueue();
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        if (shouldProjectTtsDebugToActiveSession()) {
          setReplyDebug((prev) => (
            prev ? `${prev} | stream_prepare_error=${message}` : `stream_prepare_error=${message}`
          ));
        }
      });
  }, [
    processStreamAudioQueue,
    setReplyDebug,
    shouldProjectTtsDebugToActiveSession,
    setStreamAudioQueueSize,
    setTtsPlaybackWanted,
    setTtsUiStatus,
    streamAudioEnqueueChainRef,
    streamAudioQueueGenerationRef,
    streamAudioQueueRef,
    streamSocketRef,
    streamTtsControlRef,
    streamTtsSuppressedRef,
  ]);
}
