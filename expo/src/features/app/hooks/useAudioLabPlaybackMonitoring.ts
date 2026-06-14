import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { Audio } from "expo-av";
import type { AVPlaybackStatus } from "expo-av";
import { withPromiseTimeout } from "../utils/asyncTimeout";

type UseAudioLabPlaybackMonitoringOptions = {
  audioLabRecordingRef: MutableRefObject<Audio.Recording | null>;
  audioLabSoundRef: MutableRefObject<Audio.Sound | null>;
  audioLabInputPollTimerRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  audioLabPlaybackWatchdogTimerRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  audioLabRunIdRef: MutableRefObject<number>;
  audioLabPlaybackWantedRef: MutableRefObject<boolean>;
  audioLabPlaybackLastPlayingAtRef: MutableRefObject<number>;
  audioLabPlaybackStatusLogAtRef: MutableRefObject<number>;
  audioLabPlaybackRecoverAtRef: MutableRefObject<number>;
  audioLabPlaybackWatchdogInFlightRef: MutableRefObject<boolean>;
  audioLabPlaybackWatchdogErrorLogAtRef: MutableRefObject<number>;
  audioLabInputNameRef: MutableRefObject<string>;
  audioLabAirPodsInputRef: MutableRefObject<boolean>;
  audioLabRouteErrorLogAtRef: MutableRefObject<number>;
  audioLabInputPollMs: number;
  playbackStatusLogThrottleMs: number;
  playbackWatchdogIntervalMs: number;
  playbackWatchdogStatusTimeoutMs: number;
  playbackRecoverCooldownMs: number;
  playbackStallMs: number;
  playbackWatchdogErrorLogThrottleMs: number;
  routeErrorLogThrottleMs: number;
  setAudioLabPlaybackActive: (value: boolean) => void;
  setAudioLabPlaybackPositionMs: (value: number) => void;
  setAudioLabPlaybackStallMs: (value: number) => void;
  setAudioLabLoopCount: Dispatch<SetStateAction<number>>;
  setAudioLabUnexpectedStopCount: Dispatch<SetStateAction<number>>;
  setAudioLabPlaybackRecoverCount: Dispatch<SetStateAction<number>>;
  setAudioLabInputName: (value: string) => void;
  setAudioLabAirPodsInput: (value: boolean) => void;
  logAudioLab: (event: string, payload?: Record<string, unknown>) => void;
  isAirPodsInputName: (name: string) => boolean;
};

export function useAudioLabPlaybackMonitoring(options: UseAudioLabPlaybackMonitoringOptions) {
  const {
    audioLabRecordingRef,
    audioLabSoundRef,
    audioLabInputPollTimerRef,
    audioLabPlaybackWatchdogTimerRef,
    audioLabRunIdRef,
    audioLabPlaybackWantedRef,
    audioLabPlaybackLastPlayingAtRef,
    audioLabPlaybackStatusLogAtRef,
    audioLabPlaybackRecoverAtRef,
    audioLabPlaybackWatchdogInFlightRef,
    audioLabPlaybackWatchdogErrorLogAtRef,
    audioLabInputNameRef,
    audioLabAirPodsInputRef,
    audioLabRouteErrorLogAtRef,
    audioLabInputPollMs,
    playbackStatusLogThrottleMs,
    playbackWatchdogIntervalMs,
    playbackWatchdogStatusTimeoutMs,
    playbackRecoverCooldownMs,
    playbackStallMs,
    playbackWatchdogErrorLogThrottleMs,
    routeErrorLogThrottleMs,
    setAudioLabPlaybackActive,
    setAudioLabPlaybackPositionMs,
    setAudioLabPlaybackStallMs,
    setAudioLabLoopCount,
    setAudioLabUnexpectedStopCount,
    setAudioLabPlaybackRecoverCount,
    setAudioLabInputName,
    setAudioLabAirPodsInput,
    logAudioLab,
    isAirPodsInputName,
  } = options;

  const clearAudioLabInputPollTimer = useCallback(() => {
    if (!audioLabInputPollTimerRef.current) return;
    clearInterval(audioLabInputPollTimerRef.current);
    audioLabInputPollTimerRef.current = null;
  }, [audioLabInputPollTimerRef]);

  const clearAudioLabPlaybackWatchdogTimer = useCallback(() => {
    if (audioLabPlaybackWatchdogTimerRef.current) {
      clearInterval(audioLabPlaybackWatchdogTimerRef.current);
    }
    audioLabPlaybackWatchdogTimerRef.current = null;
    audioLabPlaybackWatchdogInFlightRef.current = false;
  }, [audioLabPlaybackWatchdogInFlightRef, audioLabPlaybackWatchdogTimerRef]);

  const readAudioLabPlaybackStatusWithTimeout = useCallback(async (
    sound: Audio.Sound,
    timeoutMs: number
  ) => {
    return await withPromiseTimeout(
      () => sound.getStatusAsync(),
      timeoutMs,
      "audio_lab_playback_status_timeout"
    );
  }, []);

  const bindAudioLabPlaybackStatus = useCallback((sound: Audio.Sound, runId: number) => {
    sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
      if (runId !== audioLabRunIdRef.current) return;
      const now = Date.now();
      if (!status?.isLoaded) {
        setAudioLabPlaybackActive(false);
        if (status?.error) {
          logAudioLab("lab_playback_status_error", {
            message: String(status.error),
            runId,
          });
        }
        return;
      }
      const isPlaying = Boolean(status.isPlaying);
      const didJustFinish = Boolean(status.didJustFinish);
      const positionMillis = Number(status.positionMillis || 0);
      const durationMillis = Number(status.durationMillis || 0);
      setAudioLabPlaybackActive(isPlaying);
      setAudioLabPlaybackPositionMs(positionMillis);
      if (isPlaying) {
        audioLabPlaybackLastPlayingAtRef.current = now;
        setAudioLabPlaybackStallMs(0);
      } else if (audioLabPlaybackWantedRef.current) {
        const base = audioLabPlaybackLastPlayingAtRef.current || now;
        setAudioLabPlaybackStallMs(Math.max(0, now - base));
      }
      if (didJustFinish) {
        setAudioLabLoopCount((prev) => prev + 1);
        logAudioLab("lab_playback_loop", {
          runId,
          positionMillis,
          durationMillis,
        });
      }
      if (now - audioLabPlaybackStatusLogAtRef.current >= playbackStatusLogThrottleMs) {
        audioLabPlaybackStatusLogAtRef.current = now;
        logAudioLab("lab_playback_status", {
          runId,
          isPlaying,
          didJustFinish,
          positionMillis,
          durationMillis,
          isBuffering: Boolean(status?.isBuffering),
          shouldPlay: Boolean(status?.shouldPlay),
        });
      }
    });
  }, [
    audioLabPlaybackLastPlayingAtRef,
    audioLabPlaybackStatusLogAtRef,
    audioLabPlaybackWantedRef,
    audioLabRunIdRef,
    logAudioLab,
    playbackStatusLogThrottleMs,
    setAudioLabLoopCount,
    setAudioLabPlaybackActive,
    setAudioLabPlaybackPositionMs,
    setAudioLabPlaybackStallMs,
  ]);

  const startAudioLabPlaybackWatchdog = useCallback((runId: number) => {
    clearAudioLabPlaybackWatchdogTimer();
    audioLabPlaybackWatchdogTimerRef.current = setInterval(() => {
      if (runId !== audioLabRunIdRef.current) return;
      if (audioLabPlaybackWatchdogInFlightRef.current) return;
      if (!audioLabPlaybackWantedRef.current) return;
      const sound = audioLabSoundRef.current;
      if (!sound) return;
      audioLabPlaybackWatchdogInFlightRef.current = true;
      void readAudioLabPlaybackStatusWithTimeout(sound, playbackWatchdogStatusTimeoutMs)
        .then(async (status) => {
          if (runId !== audioLabRunIdRef.current) return;
          if (!audioLabPlaybackWantedRef.current) return;
          if (!status?.isLoaded) {
            setAudioLabPlaybackActive(false);
            const now = Date.now();
            if (now - audioLabPlaybackRecoverAtRef.current < playbackRecoverCooldownMs) {
              return;
            }
            audioLabPlaybackRecoverAtRef.current = now;
            setAudioLabUnexpectedStopCount((prev) => prev + 1);
            logAudioLab("lab_playback_watchdog_unloaded", {
              runId,
            });
            return;
          }
          const now = Date.now();
          const isPlaying = Boolean(status.isPlaying);
          const positionMillis = Number(status.positionMillis || 0);
          const durationMillis = Number(status.durationMillis || 0);
          setAudioLabPlaybackPositionMs(positionMillis);
          if (isPlaying) {
            audioLabPlaybackLastPlayingAtRef.current = now;
            setAudioLabPlaybackStallMs(0);
            return;
          }
          const base = audioLabPlaybackLastPlayingAtRef.current || now;
          const stallForMs = Math.max(0, now - base);
          setAudioLabPlaybackStallMs(stallForMs);
          if (stallForMs < playbackStallMs) return;
          if (now - audioLabPlaybackRecoverAtRef.current < playbackRecoverCooldownMs) return;
          audioLabPlaybackRecoverAtRef.current = now;
          setAudioLabUnexpectedStopCount((prev) => prev + 1);
          logAudioLab("lab_playback_watchdog_recover", {
            runId,
            stallForMs,
            positionMillis,
            durationMillis,
          });
          await sound.setIsLoopingAsync(true).catch(() => {});
          await sound.playFromPositionAsync(0);
          audioLabPlaybackLastPlayingAtRef.current = Date.now();
          setAudioLabPlaybackRecoverCount((prev) => prev + 1);
          logAudioLab("lab_playback_recovered", {
            runId,
            stallForMs,
          });
        })
        .catch((error) => {
          const now = Date.now();
          if (now - audioLabPlaybackWatchdogErrorLogAtRef.current >= playbackWatchdogErrorLogThrottleMs) {
            audioLabPlaybackWatchdogErrorLogAtRef.current = now;
            logAudioLab("lab_playback_watchdog_error", {
              runId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(() => {
          audioLabPlaybackWatchdogInFlightRef.current = false;
        });
    }, playbackWatchdogIntervalMs);
  }, [
    audioLabPlaybackLastPlayingAtRef,
    audioLabPlaybackRecoverAtRef,
    audioLabPlaybackWantedRef,
    audioLabPlaybackWatchdogErrorLogAtRef,
    audioLabPlaybackWatchdogInFlightRef,
    audioLabPlaybackWatchdogTimerRef,
    audioLabRunIdRef,
    audioLabSoundRef,
    clearAudioLabPlaybackWatchdogTimer,
    logAudioLab,
    playbackRecoverCooldownMs,
    playbackStallMs,
    playbackWatchdogErrorLogThrottleMs,
    playbackWatchdogIntervalMs,
    playbackWatchdogStatusTimeoutMs,
    readAudioLabPlaybackStatusWithTimeout,
    setAudioLabPlaybackActive,
    setAudioLabPlaybackPositionMs,
    setAudioLabPlaybackRecoverCount,
    setAudioLabPlaybackStallMs,
    setAudioLabUnexpectedStopCount,
  ]);

  const detectAudioLabInputRoute = useCallback(async (
    rec?: Audio.Recording | null,
    source = "unknown"
  ) => {
    const target = rec || audioLabRecordingRef.current;
    if (!target) return;
    try {
      const input = await target.getCurrentInput();
      const inputName = String(input?.name || "").trim();
      const isAirPods = isAirPodsInputName(inputName);
      const prevInputName = audioLabInputNameRef.current;
      const prevAirPods = audioLabAirPodsInputRef.current;
      if (prevInputName !== inputName || prevAirPods !== isAirPods) {
        logAudioLab("lab_route_changed", {
          source,
          inputName,
          isAirPods,
          prevInputName,
          prevAirPods,
        });
      }
      audioLabInputNameRef.current = inputName;
      audioLabAirPodsInputRef.current = isAirPods;
      setAudioLabInputName(inputName);
      setAudioLabAirPodsInput(isAirPods);
    } catch (error) {
      const now = Date.now();
      if (now - audioLabRouteErrorLogAtRef.current >= routeErrorLogThrottleMs) {
        audioLabRouteErrorLogAtRef.current = now;
        logAudioLab("lab_route_detect_error", {
          source,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, [
    audioLabAirPodsInputRef,
    audioLabInputNameRef,
    audioLabRecordingRef,
    audioLabRouteErrorLogAtRef,
    isAirPodsInputName,
    logAudioLab,
    routeErrorLogThrottleMs,
    setAudioLabAirPodsInput,
    setAudioLabInputName,
  ]);

  const startAudioLabInputRoutePolling = useCallback(() => {
    clearAudioLabInputPollTimer();
    audioLabInputPollTimerRef.current = setInterval(() => {
      void detectAudioLabInputRoute(audioLabRecordingRef.current, "poll");
    }, audioLabInputPollMs);
  }, [
    audioLabInputPollMs,
    audioLabInputPollTimerRef,
    audioLabRecordingRef,
    clearAudioLabInputPollTimer,
    detectAudioLabInputRoute,
  ]);

  return {
    clearAudioLabInputPollTimer,
    clearAudioLabPlaybackWatchdogTimer,
    bindAudioLabPlaybackStatus,
    startAudioLabPlaybackWatchdog,
    detectAudioLabInputRoute,
    startAudioLabInputRoutePolling,
  };
}
