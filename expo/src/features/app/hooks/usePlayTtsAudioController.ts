import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";
import type { AudioContainer, TtsDebugStats } from "../types/appTypes";
import { detectAudioContainer, resolveAudioFileExtension } from "../utils/waveform";

type UsePlayTtsAudioControllerOptions = {
  fixedMediaVolume: number;
  ttsStopInFlightRef: MutableRefObject<Promise<void> | null>;
  ttsPlaybackRunIdRef: MutableRefObject<number>;
  ttsPlaybackProgressUiAtRef: MutableRefObject<number>;
  ttsPlaybackTransitionInFlightRef: MutableRefObject<boolean>;
  ttsPlaybackLastPlayingAtRef: MutableRefObject<number>;
  ttsSoundRef: MutableRefObject<Audio.Sound | null>;
  setTtsPlaybackWanted: (next: boolean, reason: string, payload?: Record<string, unknown>) => void;
  setTtsPlayingWithReason: (next: boolean, reason: string, payload?: Record<string, unknown>) => void;
  setTtsUiStatus: (value: "idle" | "queued" | "synthesizing" | "playing" | "error") => void;
  setTtsDebugStats: (value: TtsDebugStats | ((prev: TtsDebugStats) => TtsDebugStats)) => void;
  setTtsUri: (value: string) => void;
  setTtsSoundWithRef: (
    next: Audio.Sound | null | ((current: Audio.Sound | null) => Audio.Sound | null)
  ) => void;
  prepareTtsPlaybackSession: () => Promise<void>;
  attachTtsSoundStatusHandler: (sound: Audio.Sound, runId: number) => void;
  markTtsPlaybackStopped: () => void;
};

export function usePlayTtsAudioController(options: UsePlayTtsAudioControllerOptions) {
  const {
    fixedMediaVolume,
    ttsStopInFlightRef,
    ttsPlaybackRunIdRef,
    ttsPlaybackProgressUiAtRef,
    ttsPlaybackTransitionInFlightRef,
    ttsPlaybackLastPlayingAtRef,
    ttsSoundRef,
    setTtsPlaybackWanted,
    setTtsPlayingWithReason,
    setTtsUiStatus,
    setTtsDebugStats,
    setTtsUri,
    setTtsSoundWithRef,
    prepareTtsPlaybackSession,
    attachTtsSoundStatusHandler,
    markTtsPlaybackStopped,
  } = options;

  return useCallback(async (
    audioUrl: string,
    mimeType: string,
    playOptions?: {
      detectedAudioContainer?: AudioContainer;
      audioBytes?: number | null;
    }
  ) => {
    if (ttsStopInFlightRef.current) {
      await ttsStopInFlightRef.current.catch(() => {});
    }
    const runId = ttsPlaybackRunIdRef.current + 1;
    ttsPlaybackRunIdRef.current = runId;
    setTtsPlaybackWanted(true, "play_tts_audio_start", {
      mode: "single",
      runId,
    });
    setTtsPlayingWithReason(true, "play_tts_audio_start", {
      mode: "single",
      runId,
    });
    setTtsUiStatus("playing");
    ttsPlaybackProgressUiAtRef.current = 0;
    ttsPlaybackTransitionInFlightRef.current = true;
    try {
      const normalizedAudioUrl = String(audioUrl || "").trim();
      const normalizedMimeType = String(mimeType || "").trim().toLowerCase();
      if (!normalizedAudioUrl) {
        throw new Error("TTS audio URL が空です。");
      }
      const detectedAudioContainer = (
        playOptions?.detectedAudioContainer ||
        detectAudioContainer(new Uint8Array(0), normalizedMimeType)
      );
      const audioBytes = Number(playOptions?.audioBytes);
      console.log("[tts] play", {
        audioUrl: normalizedAudioUrl,
        mimeType: normalizedMimeType || "-",
        detectedAudioContainer,
        audioBytes: Number.isFinite(audioBytes) ? audioBytes : null,
      });

      await prepareTtsPlaybackSession();

      const ext = resolveAudioFileExtension(detectedAudioContainer, normalizedMimeType);
      setTtsDebugStats((prev) => ({
        ...prev,
        playAttempts: prev.playAttempts + 1,
        playExt: ext,
        playDetected: detectedAudioContainer,
        playAudioBytes: Number.isFinite(audioBytes) && audioBytes > 0 ? audioBytes : 0,
        playLastStatusError: "",
      }));

      const activeTtsSound = ttsSoundRef.current;
      if (activeTtsSound) {
        try {
          await activeTtsSound.unloadAsync();
        } catch {}
        setTtsSoundWithRef((current) => (current === activeTtsSound ? null : current));
      }

      const { sound } = await Audio.Sound.createAsync(
        { uri: normalizedAudioUrl },
        { shouldPlay: true, volume: fixedMediaVolume }
      );
      attachTtsSoundStatusHandler(sound, runId);

      setTtsUri(normalizedAudioUrl);
      setTtsSoundWithRef(sound);
      ttsPlaybackLastPlayingAtRef.current = Date.now();
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
    prepareTtsPlaybackSession,
    setTtsDebugStats,
    setTtsPlaybackWanted,
    setTtsPlayingWithReason,
    setTtsSoundWithRef,
    setTtsUiStatus,
    setTtsUri,
    ttsPlaybackLastPlayingAtRef,
    ttsPlaybackProgressUiAtRef,
    ttsPlaybackRunIdRef,
    ttsPlaybackTransitionInFlightRef,
    ttsSoundRef,
    ttsStopInFlightRef,
  ]);
}
