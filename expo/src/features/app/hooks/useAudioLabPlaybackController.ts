import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";

type UseAudioLabPlaybackControllerOptions = {
  audioLabLoopAsset: number;
  audioLabRunning: boolean;
  audioLabActionInFlightRef: MutableRefObject<boolean>;
  audioLabRecordingRef: MutableRefObject<Audio.Recording | null>;
  audioLabSoundRef: MutableRefObject<Audio.Sound | null>;
  audioLabPlaybackWantedRef: MutableRefObject<boolean>;
  audioLabRunIdRef: MutableRefObject<number>;
  audioLabStartedAtRef: MutableRefObject<number>;
  audioLabPlaybackLastPlayingAtRef: MutableRefObject<number>;
  clearAudioLabPlaybackWatchdogTimer: () => void;
  startAudioLabPlaybackWatchdog: (runId: number) => void;
  bindAudioLabPlaybackStatus: (sound: Audio.Sound, runId: number) => void;
  setAudioLabRunning: (next: boolean) => void;
  setAudioLabNowMs: (next: number) => void;
  setAudioLabPlaybackActive: (next: boolean) => void;
  setAudioLabPlaybackPositionMs: (next: number) => void;
  setAudioLabPlaybackStallMs: (next: number) => void;
  logAudioLab: (event: string, payload?: Record<string, unknown>) => void;
  reportError: (raw: unknown, scope?: string) => void;
};

export function useAudioLabPlaybackController(options: UseAudioLabPlaybackControllerOptions) {
  const {
    audioLabLoopAsset,
    audioLabRunning,
    audioLabActionInFlightRef,
    audioLabRecordingRef,
    audioLabSoundRef,
    audioLabPlaybackWantedRef,
    audioLabRunIdRef,
    audioLabStartedAtRef,
    audioLabPlaybackLastPlayingAtRef,
    clearAudioLabPlaybackWatchdogTimer,
    startAudioLabPlaybackWatchdog,
    bindAudioLabPlaybackStatus,
    setAudioLabRunning,
    setAudioLabNowMs,
    setAudioLabPlaybackActive,
    setAudioLabPlaybackPositionMs,
    setAudioLabPlaybackStallMs,
    logAudioLab,
    reportError,
  } = options;

  const stopAudioLabPlaybackOnly = useCallback(async (reason = "manual") => {
    audioLabPlaybackWantedRef.current = false;
    clearAudioLabPlaybackWatchdogTimer();
    const sound = audioLabSoundRef.current;
    audioLabSoundRef.current = null;
    if (sound) {
      sound.setOnPlaybackStatusUpdate(null);
      try {
        await sound.stopAsync();
      } catch {}
      try {
        await sound.unloadAsync();
      } catch {}
    }
    setAudioLabPlaybackActive(false);
    setAudioLabPlaybackPositionMs(0);
    setAudioLabPlaybackStallMs(0);
    if (!audioLabRecordingRef.current) {
      setAudioLabRunning(false);
      audioLabStartedAtRef.current = 0;
      setAudioLabNowMs(0);
    }
    logAudioLab("lab_playback_stopped", {
      reason,
      recordingActive: Boolean(audioLabRecordingRef.current),
      runId: audioLabRunIdRef.current,
    });
  }, [
    audioLabPlaybackWantedRef,
    clearAudioLabPlaybackWatchdogTimer,
    audioLabSoundRef,
    setAudioLabPlaybackActive,
    setAudioLabPlaybackPositionMs,
    setAudioLabPlaybackStallMs,
    audioLabRecordingRef,
    setAudioLabRunning,
    audioLabStartedAtRef,
    setAudioLabNowMs,
    logAudioLab,
    audioLabRunIdRef,
  ]);

  const startAudioLabPlaybackOnly = useCallback(async (reason = "manual_resume") => {
    if (audioLabActionInFlightRef.current) return;
    if (!audioLabRecordingRef.current || !audioLabRunning) {
      reportError("Audio Labの録音セッションが停止中です。先に同時テストを開始してください。", "audio-lab:resume");
      return;
    }
    audioLabActionInFlightRef.current = true;
    try {
      const runId = audioLabRunIdRef.current;
      const existingSound = audioLabSoundRef.current;
      audioLabPlaybackWantedRef.current = true;
      if (existingSound) {
        const status = await existingSound.getStatusAsync().catch(() => null);
        const statusLike = (
          status && typeof status === "object"
            ? status as { isLoaded?: boolean; isPlaying?: boolean }
            : null
        );
        const loaded = Boolean(statusLike?.isLoaded);
        if (loaded && Boolean(statusLike?.isPlaying)) {
          setAudioLabPlaybackActive(true);
          startAudioLabPlaybackWatchdog(runId);
          logAudioLab("lab_playback_resume_skip_already_playing", {
            reason,
            runId,
          });
          return;
        }
        if (loaded) {
          await existingSound.setIsLoopingAsync(true).catch(() => {});
          await existingSound.playFromPositionAsync(0);
          audioLabPlaybackLastPlayingAtRef.current = Date.now();
          setAudioLabPlaybackActive(true);
          setAudioLabPlaybackStallMs(0);
          startAudioLabPlaybackWatchdog(runId);
          logAudioLab("lab_playback_resumed", {
            reason,
            runId,
            path: "existing_sound",
          });
          return;
        }
      }
      const playback = await Audio.Sound.createAsync(audioLabLoopAsset, {
        shouldPlay: true,
        isLooping: true,
        volume: 0.14,
      });
      const nextSound = playback.sound;
      bindAudioLabPlaybackStatus(nextSound, runId);
      audioLabSoundRef.current = nextSound;
      audioLabPlaybackLastPlayingAtRef.current = Date.now();
      setAudioLabPlaybackActive(true);
      setAudioLabPlaybackStallMs(0);
      startAudioLabPlaybackWatchdog(runId);
      logAudioLab("lab_playback_resumed", {
        reason,
        runId,
        path: "new_sound",
      });
    } catch (e) {
      audioLabPlaybackWantedRef.current = false;
      logAudioLab("lab_playback_resume_error", {
        reason,
        runId: audioLabRunIdRef.current,
        message: e instanceof Error ? e.message : String(e),
      });
      reportError(e, "audio-lab:resume");
    } finally {
      audioLabActionInFlightRef.current = false;
    }
  }, [
    audioLabActionInFlightRef,
    audioLabRecordingRef,
    audioLabRunning,
    reportError,
    audioLabRunIdRef,
    audioLabSoundRef,
    audioLabPlaybackWantedRef,
    setAudioLabPlaybackActive,
    startAudioLabPlaybackWatchdog,
    logAudioLab,
    audioLabPlaybackLastPlayingAtRef,
    setAudioLabPlaybackStallMs,
    audioLabLoopAsset,
    bindAudioLabPlaybackStatus,
  ]);

  return {
    stopAudioLabPlaybackOnly,
    startAudioLabPlaybackOnly,
  };
}
