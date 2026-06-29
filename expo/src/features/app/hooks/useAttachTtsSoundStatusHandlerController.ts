import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";
import type { StreamAudioQueueItem, StreamTtsControlState, TtsDebugStats } from "../types/appTypes";

type UseAttachTtsSoundStatusHandlerControllerOptions = {
  ttsPlaybackStatusLogThrottleMs: number;
  ttsPlaybackRunIdRef: MutableRefObject<number>;
  ttsPlaybackWantedRef: MutableRefObject<boolean>;
  ttsPlaybackUnexpectedStopLogAtRef: MutableRefObject<number>;
  ttsPlaybackStatusLogAtRef: MutableRefObject<number>;
  ttsPlaybackProgressUiAtRef: MutableRefObject<number>;
  ttsPlaybackLastPlayingAtRef: MutableRefObject<number>;
  streamAudioQueueRef: MutableRefObject<StreamAudioQueueItem[]>;
  streamAudioQueueProcessingRef: MutableRefObject<boolean>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  streamTtsSuppressedRef: MutableRefObject<boolean>;
  trimForInline: (raw: string, max?: number) => string;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
  setTtsDebugStats: (value: TtsDebugStats | ((prev: TtsDebugStats) => TtsDebugStats)) => void;
  setReplyDebug: (value: string | ((prev: string) => string)) => void;
  shouldProjectTtsDebugToActiveSession: () => boolean;
  setError: (value: string) => void;
  markTtsPlaybackStopped: () => void;
  markTtsChunkPlaybackFinished: () => void;
  syncTtsPlaybackWantedFromPipeline: (reason: string, payload?: Record<string, unknown>) => void;
  setTtsSoundWithRef: (
    next: Audio.Sound | null | ((current: Audio.Sound | null) => Audio.Sound | null)
  ) => void;
};

export function useAttachTtsSoundStatusHandlerController(
  options: UseAttachTtsSoundStatusHandlerControllerOptions
) {
  const {
    ttsPlaybackStatusLogThrottleMs,
    ttsPlaybackRunIdRef,
    ttsPlaybackWantedRef,
    ttsPlaybackUnexpectedStopLogAtRef,
    ttsPlaybackStatusLogAtRef,
    ttsPlaybackProgressUiAtRef,
    ttsPlaybackLastPlayingAtRef,
    streamAudioQueueRef,
    streamAudioQueueProcessingRef,
    streamSocketRef,
    streamTtsControlRef,
    streamTtsSuppressedRef,
    trimForInline,
    logAuto,
    setTtsDebugStats,
    setReplyDebug,
    shouldProjectTtsDebugToActiveSession,
    setError,
    markTtsPlaybackStopped,
    markTtsChunkPlaybackFinished,
    syncTtsPlaybackWantedFromPipeline,
    setTtsSoundWithRef,
  } = options;

  return useCallback((
    sound: Audio.Sound,
    runId: number,
    streamChunk?: StreamAudioQueueItem | null
  ) => {
    let playbackErrorReported = false;
    let prevIsPlaying: boolean | null = null;
    let firstPlayingAt = 0;
    void sound.setStatusAsync({ progressUpdateIntervalMillis: 16 }).catch(() => {});
    sound.setOnPlaybackStatusUpdate((status) => {
      if (runId !== ttsPlaybackRunIdRef.current) return;
      const now = Date.now();
      if (!status.isLoaded) {
        if (!playbackErrorReported && status.error) {
          playbackErrorReported = true;
          const statusError = String(status.error || "sound_load_failed");
          logAuto("tts_status_error", {
            message: statusError,
            runId,
          });
          logAuto("tts_playback_status_error", {
            message: statusError,
            runId,
          });
          const line = `route=tts audio_error=${trimForInline(statusError, 96)}`;
          setTtsDebugStats((prev) => ({
            ...prev,
            playStatusErrors: prev.playStatusErrors + 1,
            playLastStatusError: statusError,
          }));
          if (shouldProjectTtsDebugToActiveSession()) {
            setReplyDebug((prev) => (prev ? `${prev} | ${line}` : line));
            setError(`音声再生エラー: ${statusError}`);
          }
          markTtsPlaybackStopped();
          sound.setOnPlaybackStatusUpdate(null);
          void sound.unloadAsync().catch(() => {});
          setTtsSoundWithRef((current) => (current === sound ? null : current));
        }
        return;
      }
      const durationMillis = Number(status.durationMillis || 0);
      const positionMillis = Number(status.positionMillis || 0);
      const isPlaying = Boolean(status.isPlaying);
      if (isPlaying && firstPlayingAt <= 0) {
        firstPlayingAt = now;
      }
      if (isPlaying) {
        ttsPlaybackLastPlayingAtRef.current = now;
      }
      if (prevIsPlaying === null || prevIsPlaying !== isPlaying) {
        const before = prevIsPlaying;
        prevIsPlaying = isPlaying;
        logAuto("tts_status_playing", {
          runId,
          seq: Number.isInteger(streamChunk?.seq) ? Number(streamChunk?.seq) : null,
          isPlaying,
          positionMillis,
          durationMillis,
          didJustFinish: Boolean(status.didJustFinish),
        });
        if (
          before === true &&
          !isPlaying &&
          !status.didJustFinish &&
          ttsPlaybackWantedRef.current
        ) {
          if (now - ttsPlaybackUnexpectedStopLogAtRef.current >= ttsPlaybackStatusLogThrottleMs) {
            ttsPlaybackUnexpectedStopLogAtRef.current = now;
            logAuto("tts_playback_unexpected_stop", {
              runId,
              source: "callback_transition",
              positionMillis,
              durationMillis,
              streamQueueSize: streamAudioQueueRef.current.length,
              streamQueueProcessing: streamAudioQueueProcessingRef.current,
              streamSocketAlive: streamSocketRef.current !== null,
              streamTtsControlAlive: streamTtsControlRef.current !== null,
            });
          }
        }
      }
      if (now - ttsPlaybackStatusLogAtRef.current >= ttsPlaybackStatusLogThrottleMs) {
        ttsPlaybackStatusLogAtRef.current = now;
        logAuto("tts_playback_status", {
          runId,
          source: "callback",
          seq: Number.isInteger(streamChunk?.seq) ? Number(streamChunk?.seq) : null,
          isPlaying,
          didJustFinish: Boolean(status.didJustFinish),
          positionMillis,
          durationMillis,
          isBuffering: Boolean(status?.isBuffering),
          shouldPlay: Boolean(status?.shouldPlay),
          streamQueueSize: streamAudioQueueRef.current.length,
          streamQueueProcessing: streamAudioQueueProcessingRef.current,
          streamSocketAlive: streamSocketRef.current !== null,
          streamTtsControlAlive: streamTtsControlRef.current !== null,
        });
      }
      if (durationMillis > 0 && positionMillis >= 0) {
        ttsPlaybackProgressUiAtRef.current = now;
      }
      if (status.didJustFinish) {
        const actualDurationMs = (
          durationMillis > 0
            ? durationMillis
            : firstPlayingAt > 0
              ? Math.max(0, Date.now() - firstPlayingAt)
              : 0
        );
        if (streamChunk) {
          streamChunk.actualDurationMs = actualDurationMs;
        }
        const estimatedDurationMs = Number(streamChunk?.estimatedDurationMs ?? 0);
        const durationDeltaMs = (
          estimatedDurationMs > 0
            ? actualDurationMs - estimatedDurationMs
            : null
        );
        logAuto("tts_status_did_finish", {
          runId,
          seq: Number.isInteger(streamChunk?.seq) ? Number(streamChunk?.seq) : null,
          positionMillis,
          durationMillis,
          actualDurationMs,
          estimatedDurationMs: estimatedDurationMs > 0 ? estimatedDurationMs : null,
          durationDeltaMs,
          chunkChars: Number.isFinite(Number(streamChunk?.chunkChars))
            ? Number(streamChunk?.chunkChars)
            : null,
          segmentTargetChars: Number.isFinite(Number(streamChunk?.segmentTargetChars))
            ? Number(streamChunk?.segmentTargetChars)
            : null,
          streamQueueSize: streamAudioQueueRef.current.length,
          streamSocketAlive: streamSocketRef.current !== null,
          streamTtsControlAlive: streamTtsControlRef.current !== null,
          streamQueueProcessing: streamAudioQueueProcessingRef.current,
        });
        const shouldKeepSession = (
          streamAudioQueueProcessingRef.current ||
          (
            !streamTtsSuppressedRef.current &&
            (
              streamTtsControlRef.current !== null ||
              streamSocketRef.current !== null
            )
          )
        );
        if (shouldKeepSession) {
          markTtsChunkPlaybackFinished();
          syncTtsPlaybackWantedFromPipeline("chunk_finished_keep_session", {
            runId,
            seq: Number.isInteger(streamChunk?.seq) ? Number(streamChunk?.seq) : null,
          });
        } else {
          markTtsPlaybackStopped();
        }
        sound.setOnPlaybackStatusUpdate(null);
        void sound.unloadAsync().catch(() => {});
        setTtsSoundWithRef((current) => (current === sound ? null : current));
      }
    });
  }, [
    logAuto,
    markTtsChunkPlaybackFinished,
    markTtsPlaybackStopped,
    setError,
    setReplyDebug,
    shouldProjectTtsDebugToActiveSession,
    setTtsDebugStats,
    setTtsSoundWithRef,
    streamAudioQueueProcessingRef,
    streamAudioQueueRef,
    streamSocketRef,
    streamTtsControlRef,
    streamTtsSuppressedRef,
    syncTtsPlaybackWantedFromPipeline,
    trimForInline,
    ttsPlaybackLastPlayingAtRef,
    ttsPlaybackProgressUiAtRef,
    ttsPlaybackRunIdRef,
    ttsPlaybackStatusLogAtRef,
    ttsPlaybackStatusLogThrottleMs,
    ttsPlaybackUnexpectedStopLogAtRef,
    ttsPlaybackWantedRef,
  ]);
}
