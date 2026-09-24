import { useCallback, type MutableRefObject } from "react";
import { Audio } from "../audio";
import { createTtsSoundAsync } from "../ttsAudio";
import type { VisualThemeTtsEffect } from "../theme/visualThemes";
import type { AudioContainer, TtsDebugStats } from "../types/appTypes";
import { detectAudioContainer, resolveAudioFileExtension } from "../utils/waveform";

type UsePlayTtsAudioControllerOptions = {
  fixedMediaVolume: number;
  ttsEffect: VisualThemeTtsEffect | null;
  ttsProcessingAbortControllersRef: MutableRefObject<Set<AbortController>>;
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
    ttsEffect,
    ttsProcessingAbortControllersRef,
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
    let createdSound: Audio.Sound | null = null;
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

      const processing = new AbortController();
      ttsProcessingAbortControllersRef.current.add(processing);
      let sound: Audio.Sound;
      try {
        sound = await createTtsSoundAsync(
          normalizedAudioUrl,
          { shouldPlay: false, volume: fixedMediaVolume },
          ttsEffect,
          processing.signal
        );
      } finally {
        ttsProcessingAbortControllersRef.current.delete(processing);
      }
      if (runId !== ttsPlaybackRunIdRef.current) {
        await sound.unloadAsync().catch(() => {});
        return;
      }
      createdSound = sound;
      attachTtsSoundStatusHandler(sound, runId);

      setTtsUri(normalizedAudioUrl);
      setTtsSoundWithRef(sound);
      ttsPlaybackLastPlayingAtRef.current = Date.now();
      await sound.playAsync();
    } catch (e) {
      if (createdSound) {
        await createdSound.unloadAsync().catch(() => {});
        setTtsSoundWithRef((current) => (current === createdSound ? null : current));
      }
      if (runId !== ttsPlaybackRunIdRef.current) return;
      markTtsPlaybackStopped();
      throw e;
    } finally {
      ttsPlaybackTransitionInFlightRef.current = false;
    }
  }, [
    attachTtsSoundStatusHandler,
    fixedMediaVolume,
    ttsEffect,
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
    ttsProcessingAbortControllersRef,
    ttsPlaybackTransitionInFlightRef,
    ttsSoundRef,
    ttsStopInFlightRef,
  ]);
}
