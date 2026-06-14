import { useCallback, type MutableRefObject } from "react";
import type { AudioContainer, TtsDebugStats } from "../types/appTypes";
import { trimForInline } from "../utils/statusText";
import { detectAudioContainer } from "../utils/waveform";
import { sanitizeTextForTts } from "../utils/statusText";

type TtsUiStatus = "idle" | "queued" | "synthesizing" | "playing" | "error";

type UseSynthesizeSpeechControllerOptions = {
  reply: string;
  runnerUrl: string;
  runnerToken: string;
  ttsProvider: string;
  selectedVoiceId: string;
  ttsSpeed: number;
  ttsLoading: boolean;
  ttsSynthesisRequestIdRef: MutableRefObject<number>;
  baseUrl: () => string;
  setTtsPlaybackMessageIdWithRef: (value: string) => void;
  setTtsLoading: (value: boolean) => void;
  setTtsUiStatus: (value: TtsUiStatus) => void;
  setError: (value: string) => void;
  setTtsDebugStats: (value: TtsDebugStats | ((prev: TtsDebugStats) => TtsDebugStats)) => void;
  setReplyDebug: (value: string | ((prev: string) => string)) => void;
  reportError: (raw: unknown, scope?: string) => void;
  playTtsAudio: (
    audioUrl: string,
    mimeType: string,
    options?: {
      detectedAudioContainer?: AudioContainer;
      audioBytes?: number | null;
    }
  ) => Promise<void>;
};

export function useSynthesizeSpeechController(options: UseSynthesizeSpeechControllerOptions) {
  const {
    reply,
    runnerUrl,
    runnerToken,
    ttsProvider,
    selectedVoiceId,
    ttsSpeed,
    ttsLoading,
    ttsSynthesisRequestIdRef,
    baseUrl,
    setTtsPlaybackMessageIdWithRef,
    setTtsLoading,
    setTtsUiStatus,
    setError,
    setTtsDebugStats,
    setReplyDebug,
    reportError,
    playTtsAudio,
  } = options;

  return useCallback(async (textOverride?: string, synthOptions?: { messageId?: string }) => {
    const sourceText = (textOverride ?? reply).trim();
    const text = sanitizeTextForTts(sourceText);
    if (!runnerUrl.trim() || !runnerToken.trim() || !text || ttsLoading) return;
    const targetMessageId = String(synthOptions?.messageId || "").trim();
    const requestId = ttsSynthesisRequestIdRef.current + 1;
    ttsSynthesisRequestIdRef.current = requestId;
    setTtsPlaybackMessageIdWithRef(targetMessageId);
    setTtsLoading(true);
    setTtsUiStatus("synthesizing");
    setError("");

    try {
      console.log("[tts] start", { url: `${baseUrl()}/tts` });
      const res = await fetch(`${baseUrl()}/tts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${runnerToken.trim()}`,
        },
        body: JSON.stringify({
          ttsProvider,
          text,
          voiceId: selectedVoiceId.trim() || undefined,
          speedScale: ttsSpeed,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.log("[tts] failed response", { status: res.status, data });
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }
      if (ttsSynthesisRequestIdRef.current !== requestId) return;

      const audioUrl = String(data?.audioUrl || "").trim();
      const mimeType = String(data?.mimeType || "audio/wav").trim();
      const audioBytesRaw = Number(data?.audioBytes);
      const audioBytes = Number.isFinite(audioBytesRaw) ? Math.max(0, Math.floor(audioBytesRaw)) : 0;
      if (!audioUrl) {
        throw new Error("TTS audio URL が空でした。");
      }
      if (ttsSynthesisRequestIdRef.current !== requestId) return;
      const detectedAudioContainer = detectAudioContainer(new Uint8Array(0), mimeType);
      setTtsDebugStats((prev) => ({
        ...prev,
        synthRequests: prev.synthRequests + 1,
        synthMimeType: mimeType || "-",
        synthDetected: detectedAudioContainer,
        synthAudioBytes: audioBytes,
        synthWaveformBars: 0,
        synthTargetMessageId: targetMessageId || "-",
      }));
      const synthMeta = `route=tts mime=${mimeType || "-"} detected=${detectedAudioContainer} bytes=${audioBytes}`;
      setReplyDebug((prev) => (prev ? `${prev} | ${synthMeta}` : synthMeta));
      console.log("[tts] synth_meta", {
        mimeType: mimeType || "-",
        detectedAudioContainer,
        audioBytes,
        audioUrl,
      });
      await playTtsAudio(audioUrl, mimeType, {
        detectedAudioContainer,
        audioBytes,
      });
      console.log("[tts] success", { audioBytes, audioUrl });
    } catch (e) {
      if (ttsSynthesisRequestIdRef.current !== requestId) return;
      console.error("[tts] error", e);
      setTtsUiStatus("error");
      setReplyDebug((prev) => {
        const errorMessage = trimForInline(e instanceof Error ? e.message : String(e), 96) || "tts_failed";
        const line = `route=tts audio_error=${errorMessage}`;
        return prev ? `${prev} | ${line}` : line;
      });
      setTtsPlaybackMessageIdWithRef("");
      reportError(e, "tts");
    } finally {
      if (ttsSynthesisRequestIdRef.current === requestId) {
        setTtsLoading(false);
      }
    }
  }, [
    baseUrl,
    playTtsAudio,
    reply,
    reportError,
    runnerToken,
    runnerUrl,
    selectedVoiceId,
    setError,
    setReplyDebug,
    setTtsDebugStats,
    setTtsLoading,
    setTtsPlaybackMessageIdWithRef,
    setTtsUiStatus,
    ttsLoading,
    ttsProvider,
    ttsSpeed,
    ttsSynthesisRequestIdRef,
  ]);
}
