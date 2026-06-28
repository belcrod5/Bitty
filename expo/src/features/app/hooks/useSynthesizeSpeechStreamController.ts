import { useCallback, type MutableRefObject } from "react";
import { isRunnerWsUrl } from "../../runnerWs/llmAdapter";
import {
  encodeRunnerWsTtsStart,
  normalizeRunnerWsIncomingTtsEvent,
} from "../../runnerWs/ttsAdapter";
import { createWebSocketWithOptionalAuth } from "../../ws/webSocketAuth";
import type { TtsDebugStats, TtsPlaybackTarget } from "../types/appTypes";
import { parseStreamSegmentEnvelope } from "../utils/streamPayload";
import { collectStreamWaveformSegments, mergeWaveformBars } from "../utils/waveform";
import { sanitizeTextForTts } from "../utils/statusText";

type TtsUiStatus = "idle" | "queued" | "synthesizing" | "playing" | "error";

type StreamSegmentMeta = {
  chunkChars?: number | null;
  segmentTargetChars?: number | null;
  estimatedDurationMs?: number | null;
};

type UseSynthesizeSpeechStreamControllerOptions = {
  reply: string;
  runnerToken: string;
  ttsProvider: string;
  selectedVoiceId: string;
  ttsSpeed: number;
  ttsWaveformPoints: number;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsSuppressedRef: MutableRefObject<boolean>;
  streamAudioWaveformBarsRef: MutableRefObject<number[][]>;
  ttsPlayingRef: MutableRefObject<boolean>;
  streamAudioQueueRef: MutableRefObject<Array<{ playbackMessageId: string }>>;
  baseUrl: () => string;
  ttsStreamWsUrl: () => string;
  clearStreamAudioQueue: () => void;
  upsertStreamSegment: (seq: number, text: string, status: "queued" | "synthesizing" | "ready", meta?: StreamSegmentMeta) => void;
  enqueueStreamAudio: (
    seq: number,
    uri: string,
    mimeType: string,
    playbackMessageId: string,
    meta?: StreamSegmentMeta
  ) => void;
  patchConversationMessageById: (messageId: string, patch: { ttsWaveform?: number[] }) => void;
  reportError: (raw: unknown, scope?: string) => void;
  setError: (value: string) => void;
  setReplyDebug: (value: string | ((prev: string) => string)) => void;
  setTtsLoading: (value: boolean) => void;
  setTtsUiStatus: (value: TtsUiStatus) => void;
  setTtsPlaybackWanted: (next: boolean, reason: string, payload?: Record<string, unknown>) => void;
  patchTtsDebugStats: (patch: Partial<TtsDebugStats>) => void;
  setStreamWaveformPreview: (value: number[]) => void;
  clearStreamLlmProgress: () => void;
  clearStreamSegments: () => void;
  setStreamMode: (value: string) => void;
  setTtsPlaybackMessageIdWithRef: (value: string) => void;
  setTtsPlaybackProjectionTarget: (target: TtsPlaybackTarget) => void;
  setTtsDebugStats: (updater: (prev: TtsDebugStats) => TtsDebugStats) => void;
  syncTtsPlaybackWantedFromPipeline: (reason: string, payload?: Record<string, unknown>) => boolean;
};

export function useSynthesizeSpeechStreamController(
  options: UseSynthesizeSpeechStreamControllerOptions
) {
  const {
    reply,
    runnerToken,
    ttsProvider,
    selectedVoiceId,
    ttsSpeed,
    ttsWaveformPoints,
    streamSocketRef,
    streamTtsSuppressedRef,
    streamAudioWaveformBarsRef,
    ttsPlayingRef,
    streamAudioQueueRef,
    baseUrl,
    ttsStreamWsUrl,
    clearStreamAudioQueue,
    upsertStreamSegment,
    enqueueStreamAudio,
    patchConversationMessageById,
    reportError,
    setError,
    setReplyDebug,
    setTtsLoading,
    setTtsUiStatus,
    setTtsPlaybackWanted,
    patchTtsDebugStats,
    setStreamWaveformPreview,
    clearStreamLlmProgress,
    clearStreamSegments,
    setStreamMode,
    setTtsPlaybackMessageIdWithRef,
    setTtsPlaybackProjectionTarget,
    setTtsDebugStats,
    syncTtsPlaybackWantedFromPipeline,
  } = options;

  return useCallback(async (textOverride?: string, streamOptions?: TtsPlaybackTarget) => {
    const sourceText = (textOverride ?? reply).trim();
    const text = sanitizeTextForTts(sourceText);
    const targetRunnerUrl = baseUrl();
    if (!targetRunnerUrl || !runnerToken.trim() || !text) return;
    const targetMessageId = String(streamOptions?.messageId || "").trim();
    const shouldProjectDebugToActiveSession = false;
    const reportErrorToActiveSession = (raw: unknown, scope?: string) => {
      if (shouldProjectDebugToActiveSession) reportError(raw, scope);
    };
    setTtsPlaybackProjectionTarget({
      panelId: streamOptions?.panelId,
      sessionId: streamOptions?.sessionId,
      messageId: targetMessageId,
    });
    if (shouldProjectDebugToActiveSession) {
      setError("");
    }
    if (shouldProjectDebugToActiveSession) {
      setReplyDebug("route=stream-tts status=connecting mode=text");
    }
    setTtsLoading(true);
    setTtsUiStatus("queued");
    setTtsPlaybackWanted(true, "stream_tts_connecting", {
      mode: "text",
    });
    patchTtsDebugStats({
      streamChunkCount: 0,
      streamLastSeq: -1,
      streamLastMimeType: "",
      streamLastAudioBytes: 0,
      streamLastWaveformBars: 0,
      streamMergedWaveformBars: 0,
    });
    streamTtsSuppressedRef.current = false;
    clearStreamAudioQueue();
    streamAudioWaveformBarsRef.current = [];
    setStreamWaveformPreview([]);
    clearStreamLlmProgress();
    clearStreamSegments();
    setStreamMode("direct_text");
    setTtsPlaybackMessageIdWithRef(targetMessageId);

    const currentWs = streamSocketRef.current;
    if (currentWs) {
      currentWs.close();
      streamSocketRef.current = null;
    }

    const wsUrl = ttsStreamWsUrl();
    const useRunnerWsEnvelope = isRunnerWsUrl(wsUrl);
    const ws = createWebSocketWithOptionalAuth(wsUrl, runnerToken);
    streamSocketRef.current = ws;
    let done = false;

    ws.onopen = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        const startPayload = {
          type: "start",
          mode: "text",
          text,
          ttsProvider,
          voiceId: selectedVoiceId.trim() || undefined,
          speedScale: ttsSpeed,
        };
        ws.send(useRunnerWsEnvelope
          ? encodeRunnerWsTtsStart(startPayload)
          : JSON.stringify(startPayload));
      } catch (err) {
        done = true;
        setTtsLoading(false);
        setTtsUiStatus("error");
        syncTtsPlaybackWantedFromPipeline("stream_tts_text_ws_send_failed");
        const message = err instanceof Error ? err.message : String(err);
        reportErrorToActiveSession(`stream-tts WebSocket send failed: ${message}`, "stream-tts:text");
        if (shouldProjectDebugToActiveSession) {
          setReplyDebug(`route=stream-tts error=ws_send_failed url=${wsUrl}`);
        }
        ws.close();
      }
    };

    ws.onmessage = (event) => {
      const raw = String(event?.data || "");
      if (!raw) return;
      let data: Record<string, unknown> = {};
      if (useRunnerWsEnvelope) {
        const normalized = normalizeRunnerWsIncomingTtsEvent(raw);
        if (normalized.type === "ignore") return;
        if (normalized.type === "error") {
          data = normalized.event || {
            type: "error",
            error: "stream_tts_failed",
            message: normalized.message,
          };
        } else {
          data = normalized.event;
        }
      } else {
        try {
          data = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return;
        }
      }
      const type = String(data?.type || "");
      if (type === "started") return;

      if (type === "stream_mode") {
        const mode = String(data?.mode || "");
        setStreamMode(mode);
        return;
      }

      if (type === "segment_queued") {
        const segment = parseStreamSegmentEnvelope(data);
        if (segment.seq === null) return;
        upsertStreamSegment(segment.seq, segment.text, "queued", {
          chunkChars: segment.chunkChars,
          segmentTargetChars: segment.segmentTargetChars,
          estimatedDurationMs: segment.estimatedDurationMs,
        });
        setTtsUiStatus("queued");
        return;
      }

      if (type === "segment_tts_started") {
        const seq = Number(data?.seq);
        if (!Number.isInteger(seq)) return;
        upsertStreamSegment(seq, String(data?.text || ""), "synthesizing");
        setTtsUiStatus("synthesizing");
        return;
      }

      if (type === "segment_tts_done") {
        const seq = Number(data?.seq);
        if (!Number.isInteger(seq)) return;
        upsertStreamSegment(seq, String(data?.text || ""), "ready");
        return;
      }

      if (type === "audio_chunk") {
        const segment = parseStreamSegmentEnvelope(data);
        const seq = segment.seq;
        if (seq === null) return;
        upsertStreamSegment(seq, segment.text, "ready", {
          chunkChars: segment.chunkChars,
          segmentTargetChars: segment.segmentTargetChars,
          estimatedDurationMs: segment.estimatedDurationMs,
        });
        setTtsLoading(false);
        setTtsDebugStats((prev) => ({
          ...prev,
          streamChunkCount: prev.streamChunkCount + 1,
          streamLastSeq: seq,
          streamLastMimeType: segment.mimeType || "-",
          streamLastAudioBytes: segment.audioBytes,
          streamLastWaveformBars: 0,
        }));
        if (!segment.audioUrl) {
          setTtsUiStatus("error");
          if (shouldProjectDebugToActiveSession) {
            setReplyDebug((prev) => (
              prev
                ? `${prev} | route=stream-tts error=missing_audio_url`
                : "route=stream-tts error=missing_audio_url"
            ));
          }
          reportErrorToActiveSession("stream-tts audio_chunk missing audioUrl", "stream-tts:text");
          return;
        }
        if (streamTtsSuppressedRef.current) return;
        enqueueStreamAudio(seq, segment.audioUrl, segment.mimeType, targetMessageId, {
          chunkChars: segment.chunkChars,
          segmentTargetChars: segment.segmentTargetChars,
          estimatedDurationMs: segment.estimatedDurationMs,
        });
        return;
      }

      if (type === "error") {
        done = true;
        setTtsLoading(false);
        setTtsUiStatus("error");
        syncTtsPlaybackWantedFromPipeline("stream_tts_text_error");
        const errorMessage = String(data?.message || data?.error || "stream_tts_failed");
        if (shouldProjectDebugToActiveSession) {
          setReplyDebug(`route=stream-tts error=${String(data?.error || "stream_tts_failed")}`);
        }
        reportErrorToActiveSession(errorMessage, "stream-tts:text");
        ws.close();
        return;
      }

      if (type === "done") {
        done = true;
        setTtsLoading(false);
        const mergedWaveform = mergeWaveformBars(
          collectStreamWaveformSegments(streamAudioWaveformBarsRef.current),
          ttsWaveformPoints
        );
        patchTtsDebugStats({
          streamMergedWaveformBars: mergedWaveform.length,
        });
        streamAudioWaveformBarsRef.current = [];
        setStreamWaveformPreview([]);
        if (targetMessageId && mergedWaveform.length > 0) {
          patchConversationMessageById(targetMessageId, { ttsWaveform: mergedWaveform });
        }
        if (!ttsPlayingRef.current && streamAudioQueueRef.current.length <= 0) {
          setTtsUiStatus("idle");
        }
        syncTtsPlaybackWantedFromPipeline("stream_tts_text_done");
        ws.close();
      }
    };

    ws.onerror = (event: unknown) => {
      if (done) return;
      done = true;
      setTtsLoading(false);
      setTtsUiStatus("error");
      syncTtsPlaybackWantedFromPipeline("stream_tts_text_ws_error");
      const eventRecord = event && typeof event === "object" ? event as Record<string, unknown> : {};
      const detail = String(eventRecord.message || eventRecord.type || "websocket_error");
      reportErrorToActiveSession(`stream-tts WebSocket error: ${detail}`, "stream-tts:text");
      if (shouldProjectDebugToActiveSession) {
        setReplyDebug(`route=stream-tts error=websocket detail=${detail} url=${wsUrl}`);
      }
    };

    ws.onclose = (event: unknown) => {
      if (streamSocketRef.current === ws) {
        streamSocketRef.current = null;
      }
      if (done) return;
      done = true;
      setTtsLoading(false);
      setTtsUiStatus("error");
      syncTtsPlaybackWantedFromPipeline("stream_tts_text_ws_close");
      const eventRecord = event && typeof event === "object" ? event as Record<string, unknown> : {};
      const code = Number(eventRecord.code);
      const reason = String(eventRecord.reason || "").trim();
      const closeDetail = `code=${Number.isFinite(code) ? code : "unknown"} reason=${reason || "-"}`;
      reportErrorToActiveSession(`stream-tts WebSocket closed: ${closeDetail}`, "stream-tts:text");
      if (shouldProjectDebugToActiveSession) {
        setReplyDebug(`route=stream-tts error=websocket_closed ${closeDetail} url=${wsUrl}`);
      }
    };
  }, [
    baseUrl,
    clearStreamAudioQueue,
    enqueueStreamAudio,
    patchConversationMessageById,
    patchTtsDebugStats,
    reply,
    reportError,
    runnerToken,
    selectedVoiceId,
    setError,
    setReplyDebug,
    setStreamMode,
    setStreamWaveformPreview,
    clearStreamLlmProgress,
    clearStreamSegments,
    setTtsDebugStats,
    setTtsLoading,
    setTtsPlaybackMessageIdWithRef,
    setTtsPlaybackProjectionTarget,
    setTtsPlaybackWanted,
    setTtsUiStatus,
    streamAudioQueueRef,
    streamAudioWaveformBarsRef,
    streamSocketRef,
    streamTtsSuppressedRef,
    syncTtsPlaybackWantedFromPipeline,
    ttsPlayingRef,
    ttsProvider,
    ttsSpeed,
    ttsStreamWsUrl,
    ttsWaveformPoints,
    upsertStreamSegment,
  ]);
}
