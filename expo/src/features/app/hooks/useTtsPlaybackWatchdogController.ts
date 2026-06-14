import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { Audio } from "expo-av";
import type { StreamAudioQueueItem } from "../types/appTypes";
import { withPromiseTimeout } from "../utils/asyncTimeout";

type TtsUiStatus = "idle" | "queued" | "synthesizing" | "playing" | "error";

type UseTtsPlaybackWatchdogControllerOptions = {
  enableTtsPlaybackWatchdog: boolean;
  ttsLoading: boolean;
  ttsPlaybackWatchdogStatusTimeoutMs: number;
  ttsPlaybackStatusLogThrottleMs: number;
  ttsPlaybackStallMs: number;
  ttsPlaybackRecoverCooldownMs: number;
  ttsPlaybackWatchdogErrorLogThrottleMs: number;
  ttsPlaybackFinishEpsilonMs: number;
  ttsPlaybackForceStopStallMs: number;
  ttsPlaybackWatchdogIntervalMs: number;
  ttsPlayingRef: MutableRefObject<boolean>;
  ttsSoundRef: MutableRefObject<Audio.Sound | null>;
  ttsPlaybackWantedRef: MutableRefObject<boolean>;
  ttsPlaybackRunIdRef: MutableRefObject<number>;
  ttsPlaybackTransitionInFlightRef: MutableRefObject<boolean>;
  ttsPlaybackWatchdogTimerRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  ttsPlaybackWatchdogInFlightRef: MutableRefObject<boolean>;
  ttsPlaybackLastPlayingAtRef: MutableRefObject<number>;
  ttsPlaybackStatusLogAtRef: MutableRefObject<number>;
  ttsPlaybackRecoverAtRef: MutableRefObject<number>;
  ttsPlaybackUnexpectedStopLogAtRef: MutableRefObject<number>;
  ttsPlaybackWatchdogErrorLogAtRef: MutableRefObject<number>;
  ttsStopInFlightRef: MutableRefObject<Promise<void> | null>;
  ttsPlaybackMessageIdRef: MutableRefObject<string>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamAudioQueueRef: MutableRefObject<StreamAudioQueueItem[]>;
  streamAudioQueueProcessingRef: MutableRefObject<boolean>;
  streamTtsSuppressedRef: MutableRefObject<boolean>;
  setTtsSound: Dispatch<SetStateAction<Audio.Sound | null>>;
  setTtsPlaybackMessageId: (value: string) => void;
  setTtsUiStatus: (value: TtsUiStatus) => void;
  onTtsPlaybackMessageIdChanged?: (messageId: string) => void;
  setTtsPlayingWithReasonRef: MutableRefObject<(
    next: boolean,
    reason: string,
    payload?: Record<string, unknown>
  ) => void>;
  markTtsChunkPlaybackFinishedRef: MutableRefObject<() => void>;
  markTtsPlaybackStoppedRef: MutableRefObject<() => void>;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
};

export function useTtsPlaybackWatchdogController(options: UseTtsPlaybackWatchdogControllerOptions) {
  const {
    enableTtsPlaybackWatchdog,
    ttsLoading,
    ttsPlaybackWatchdogStatusTimeoutMs,
    ttsPlaybackStatusLogThrottleMs,
    ttsPlaybackStallMs,
    ttsPlaybackRecoverCooldownMs,
    ttsPlaybackWatchdogErrorLogThrottleMs,
    ttsPlaybackFinishEpsilonMs,
    ttsPlaybackForceStopStallMs,
    ttsPlaybackWatchdogIntervalMs,
    ttsPlayingRef,
    ttsSoundRef,
    ttsPlaybackWantedRef,
    ttsPlaybackRunIdRef,
    ttsPlaybackTransitionInFlightRef,
    ttsPlaybackWatchdogTimerRef,
    ttsPlaybackWatchdogInFlightRef,
    ttsPlaybackLastPlayingAtRef,
    ttsPlaybackStatusLogAtRef,
    ttsPlaybackRecoverAtRef,
    ttsPlaybackUnexpectedStopLogAtRef,
    ttsPlaybackWatchdogErrorLogAtRef,
    ttsStopInFlightRef,
    ttsPlaybackMessageIdRef,
    streamSocketRef,
    streamAudioQueueRef,
    streamAudioQueueProcessingRef,
    streamTtsSuppressedRef,
    setTtsSound,
    setTtsPlaybackMessageId,
    setTtsUiStatus,
    onTtsPlaybackMessageIdChanged,
    setTtsPlayingWithReasonRef,
    markTtsChunkPlaybackFinishedRef,
    markTtsPlaybackStoppedRef,
    logAuto,
  } = options;

  const clearTtsPlaybackWatchdogTimer = useCallback(() => {
    if (ttsPlaybackWatchdogTimerRef.current) {
      clearInterval(ttsPlaybackWatchdogTimerRef.current);
    }
    ttsPlaybackWatchdogTimerRef.current = null;
    ttsPlaybackWatchdogInFlightRef.current = false;
    ttsPlaybackStatusLogAtRef.current = 0;
    ttsPlaybackRecoverAtRef.current = 0;
    ttsPlaybackUnexpectedStopLogAtRef.current = 0;
    ttsPlaybackWatchdogErrorLogAtRef.current = 0;
    ttsPlaybackLastPlayingAtRef.current = 0;
  }, [
    ttsPlaybackLastPlayingAtRef,
    ttsPlaybackRecoverAtRef,
    ttsPlaybackStatusLogAtRef,
    ttsPlaybackUnexpectedStopLogAtRef,
    ttsPlaybackWatchdogErrorLogAtRef,
    ttsPlaybackWatchdogInFlightRef,
    ttsPlaybackWatchdogTimerRef,
  ]);

  const setTtsSoundWithRef = useCallback((
    next: Audio.Sound | null | ((current: Audio.Sound | null) => Audio.Sound | null)
  ) => {
    if (typeof next !== "function") {
      ttsSoundRef.current = next;
      setTtsSound(next);
      if (!next && !ttsPlaybackWantedRef.current) {
        clearTtsPlaybackWatchdogTimer();
      }
      return;
    }
    setTtsSound((current) => {
      const resolved = (next as (value: Audio.Sound | null) => Audio.Sound | null)(current);
      ttsSoundRef.current = resolved;
      if (!resolved && !ttsPlaybackWantedRef.current) {
        clearTtsPlaybackWatchdogTimer();
      }
      return resolved;
    });
  }, [
    clearTtsPlaybackWatchdogTimer,
    setTtsSound,
    ttsPlaybackWantedRef,
    ttsSoundRef,
  ]);

  const setTtsPlaybackMessageIdWithRef = useCallback((next: string) => {
    const value = String(next || "");
    ttsPlaybackMessageIdRef.current = value;
    setTtsPlaybackMessageId(value);
    onTtsPlaybackMessageIdChanged?.(value);
  }, [
    onTtsPlaybackMessageIdChanged,
    setTtsPlaybackMessageId,
    ttsPlaybackMessageIdRef,
  ]);

  const readTtsPlaybackStatusWithTimeout = useCallback(async (
    sound: Audio.Sound,
    timeoutMs: number
  ) => {
    return await withPromiseTimeout(
      () => sound.getStatusAsync(),
      timeoutMs,
      "tts_playback_status_timeout"
    );
  }, []);

  const startTtsPlaybackWatchdog = useCallback(() => {
    if (!enableTtsPlaybackWatchdog) return;
    if (ttsPlaybackWatchdogTimerRef.current) return;
    ttsPlaybackWatchdogTimerRef.current = setInterval(() => {
      if (ttsPlaybackWatchdogInFlightRef.current) return;
      if (!ttsPlaybackWantedRef.current) return;
      if (ttsPlaybackTransitionInFlightRef.current) return;
      if (ttsStopInFlightRef.current) return;
      const sound = ttsSoundRef.current;
      if (!sound) return;
      const runId = ttsPlaybackRunIdRef.current;
      ttsPlaybackWatchdogInFlightRef.current = true;
      void readTtsPlaybackStatusWithTimeout(sound, ttsPlaybackWatchdogStatusTimeoutMs)
        .then(async (status) => {
          if (runId !== ttsPlaybackRunIdRef.current) return;
          if (!ttsPlaybackWantedRef.current) return;
          if (!status?.isLoaded) {
            const now = Date.now();
            if (now - ttsPlaybackUnexpectedStopLogAtRef.current >= ttsPlaybackStatusLogThrottleMs) {
              ttsPlaybackUnexpectedStopLogAtRef.current = now;
              logAuto("tts_playback_unexpected_stop", {
                runId,
                source: "watchdog_unloaded",
                streamQueueSize: streamAudioQueueRef.current.length,
                streamQueueProcessing: streamAudioQueueProcessingRef.current,
                streamSocketAlive: streamSocketRef.current !== null,
              });
            }
            return;
          }

          const now = Date.now();
          const isPlaying = Boolean(status.isPlaying);
          const didJustFinish = Boolean(status.didJustFinish);
          const positionMillis = Number(status.positionMillis || 0);
          const durationMillis = Number(status.durationMillis || 0);
          const isBuffering = Boolean(status?.isBuffering);
          const shouldPlay = Boolean(status?.shouldPlay);

          if (now - ttsPlaybackStatusLogAtRef.current >= ttsPlaybackStatusLogThrottleMs) {
            ttsPlaybackStatusLogAtRef.current = now;
            logAuto("tts_playback_status", {
              runId,
              source: "watchdog",
              isPlaying,
              didJustFinish,
              positionMillis,
              durationMillis,
              isBuffering,
              shouldPlay,
              streamQueueSize: streamAudioQueueRef.current.length,
              streamQueueProcessing: streamAudioQueueProcessingRef.current,
              streamSocketAlive: streamSocketRef.current !== null,
            });
          }

          if (isPlaying) {
            ttsPlaybackLastPlayingAtRef.current = now;
            return;
          }

          const hasPipelineContinuation = (
            streamAudioQueueProcessingRef.current ||
            streamAudioQueueRef.current.length > 0 ||
            (!streamTtsSuppressedRef.current && streamSocketRef.current !== null) ||
            ttsLoading
          );

          if (
            durationMillis > 0 &&
            positionMillis >= Math.max(0, durationMillis - ttsPlaybackFinishEpsilonMs)
          ) {
            logAuto("tts_playback_watchdog_finish_assumed", {
              runId,
              positionMillis,
              durationMillis,
              hasPipelineContinuation,
            });
            if (hasPipelineContinuation) {
              markTtsChunkPlaybackFinishedRef.current();
            } else {
              markTtsPlaybackStoppedRef.current();
            }
            sound.setOnPlaybackStatusUpdate(null);
            void sound.unloadAsync().catch(() => {});
            setTtsSoundWithRef((current) => (current === sound ? null : current));
            return;
          }

          const base = ttsPlaybackLastPlayingAtRef.current || now;
          const stallForMs = Math.max(0, now - base);
          if (stallForMs < ttsPlaybackStallMs) return;
          if (now - ttsPlaybackRecoverAtRef.current < ttsPlaybackRecoverCooldownMs) return;
          ttsPlaybackRecoverAtRef.current = now;
          logAuto("tts_playback_watchdog_recover", {
            runId,
            stallForMs,
            positionMillis,
            durationMillis,
            isBuffering,
            shouldPlay,
            streamQueueSize: streamAudioQueueRef.current.length,
            streamQueueProcessing: streamAudioQueueProcessingRef.current,
            streamSocketAlive: streamSocketRef.current !== null,
            ttsLoading,
            ttsPlaying: ttsPlayingRef.current,
          });

          try {
            const resumePosition = Math.max(0, positionMillis);
            if (resumePosition > 0) {
              await sound.playFromPositionAsync(resumePosition);
            } else {
              await sound.playAsync();
            }
            const recoveredAt = Date.now();
            ttsPlaybackLastPlayingAtRef.current = recoveredAt;
            setTtsUiStatus("playing");
            setTtsPlayingWithReasonRef.current(true, "watchdog_recovered", {
              runId,
              stallForMs,
              resumePosition,
            });
            logAuto("tts_playback_recovered", {
              runId,
              stallForMs,
              resumePosition,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logAuto("tts_playback_watchdog_error", {
              runId,
              message,
              stallForMs,
            });
            if (stallForMs < ttsPlaybackForceStopStallMs) return;
            logAuto("tts_playback_watchdog_force_stop", {
              runId,
              stallForMs,
              hasPipelineContinuation,
            });
            if (hasPipelineContinuation) {
              markTtsChunkPlaybackFinishedRef.current();
            } else {
              markTtsPlaybackStoppedRef.current();
            }
            sound.setOnPlaybackStatusUpdate(null);
            void sound.unloadAsync().catch(() => {});
            setTtsSoundWithRef((current) => (current === sound ? null : current));
          }
        })
        .catch((error) => {
          const now = Date.now();
          if (now - ttsPlaybackWatchdogErrorLogAtRef.current < ttsPlaybackWatchdogErrorLogThrottleMs) {
            return;
          }
          ttsPlaybackWatchdogErrorLogAtRef.current = now;
          logAuto("tts_playback_watchdog_error", {
            runId,
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          ttsPlaybackWatchdogInFlightRef.current = false;
        });
    }, ttsPlaybackWatchdogIntervalMs);
  }, [
    enableTtsPlaybackWatchdog,
    logAuto,
    markTtsChunkPlaybackFinishedRef,
    markTtsPlaybackStoppedRef,
    readTtsPlaybackStatusWithTimeout,
    setTtsPlayingWithReasonRef,
    setTtsSoundWithRef,
    setTtsUiStatus,
    streamAudioQueueProcessingRef,
    streamAudioQueueRef,
    streamSocketRef,
    streamTtsSuppressedRef,
    ttsLoading,
    ttsPlaybackFinishEpsilonMs,
    ttsPlaybackForceStopStallMs,
    ttsPlaybackRecoverAtRef,
    ttsPlaybackRecoverCooldownMs,
    ttsPlaybackRunIdRef,
    ttsPlaybackStallMs,
    ttsPlaybackStatusLogAtRef,
    ttsPlaybackStatusLogThrottleMs,
    ttsPlaybackTransitionInFlightRef,
    ttsPlaybackUnexpectedStopLogAtRef,
    ttsPlaybackWantedRef,
    ttsPlaybackWatchdogErrorLogAtRef,
    ttsPlaybackWatchdogErrorLogThrottleMs,
    ttsPlaybackWatchdogInFlightRef,
    ttsPlaybackWatchdogIntervalMs,
    ttsPlaybackWatchdogStatusTimeoutMs,
    ttsPlaybackWatchdogTimerRef,
    ttsPlaybackLastPlayingAtRef,
    ttsPlayingRef,
    ttsSoundRef,
    ttsStopInFlightRef,
  ]);

  const setTtsPlaybackWanted = useCallback((
    next: boolean,
    reason: string,
    payload: Record<string, unknown> = {}
  ) => {
    const prev = ttsPlaybackWantedRef.current;
    ttsPlaybackWantedRef.current = next;
    if (prev !== next) {
      logAuto("tts_playback_wanted_changed", {
        from: prev,
        to: next,
        reason,
        runId: ttsPlaybackRunIdRef.current,
        ...payload,
      });
    }
    if (!enableTtsPlaybackWatchdog) return;
    if (next) {
      if (!ttsPlaybackWatchdogTimerRef.current) {
        startTtsPlaybackWatchdog();
      }
      return;
    }
    if (!ttsSoundRef.current && !ttsPlayingRef.current) {
      clearTtsPlaybackWatchdogTimer();
    }
  }, [
    clearTtsPlaybackWatchdogTimer,
    enableTtsPlaybackWatchdog,
    logAuto,
    startTtsPlaybackWatchdog,
    ttsPlaybackRunIdRef,
    ttsPlaybackWantedRef,
    ttsPlaybackWatchdogTimerRef,
    ttsPlayingRef,
    ttsSoundRef,
  ]);

  const syncTtsPlaybackWantedFromPipeline = useCallback((
    reason: string,
    payload: Record<string, unknown> = {}
  ) => {
    const shouldWant = (
      ttsPlayingRef.current ||
      ttsLoading ||
      streamAudioQueueProcessingRef.current ||
      streamAudioQueueRef.current.length > 0 ||
      (!streamTtsSuppressedRef.current && streamSocketRef.current !== null)
    );
    setTtsPlaybackWanted(shouldWant, reason, {
      streamQueueSize: streamAudioQueueRef.current.length,
      streamQueueProcessing: streamAudioQueueProcessingRef.current,
      streamSocketAlive: streamSocketRef.current !== null,
      ttsLoading,
      ttsPlaying: ttsPlayingRef.current,
      ...payload,
    });
    return shouldWant;
  }, [
    setTtsPlaybackWanted,
    streamAudioQueueProcessingRef,
    streamAudioQueueRef,
    streamSocketRef,
    streamTtsSuppressedRef,
    ttsLoading,
    ttsPlayingRef,
  ]);

  return {
    setTtsSoundWithRef,
    setTtsPlaybackMessageIdWithRef,
    clearTtsPlaybackWatchdogTimer,
    setTtsPlaybackWanted,
    syncTtsPlaybackWantedFromPipeline,
  };
}
