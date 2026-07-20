import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";
import type { StreamTtsControlState } from "../types/appTypes";

type TtsUiStatus = "idle" | "queued" | "synthesizing" | "playing" | "error";
type AudioModeSwitchOptions = {
  reason?: string;
  allowsRecordingIOS?: boolean;
};

type UseStopTtsPlaybackControllerOptions = {
  ttsStopInFlightRef: MutableRefObject<Promise<void> | null>;
  ttsPlaybackTransitionInFlightRef: MutableRefObject<boolean>;
  autoLastTtsStopRequestedAtRef: MutableRefObject<number>;
  autoLastBargeInDetectedAtRef: MutableRefObject<number>;
  autoLastTtsStoppedAtRef: MutableRefObject<number>;
  ttsPlaybackRunIdRef: MutableRefObject<number>;
  ttsSynthesisRequestIdRef: MutableRefObject<number>;
  ttsPlayingRef: MutableRefObject<boolean>;
  replyLoadingRef: MutableRefObject<boolean>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamAudioQueueRef: MutableRefObject<Array<unknown>>;
  streamAudioQueueProcessingRef: MutableRefObject<boolean>;
  streamTtsSuppressedRef: MutableRefObject<boolean>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  streamAudioWaveformBarsRef: MutableRefObject<number[][]>;
  ttsPlaybackMessageIdRef: MutableRefObject<string>;
  ttsSoundRef: MutableRefObject<Audio.Sound | null>;
  ttsLoading: boolean;
  ttsUiStatus: TtsUiStatus;
  setTtsPlaybackWanted: (next: boolean, reason: string, payload?: Record<string, unknown>) => void;
  setTtsLoading: (value: boolean) => void;
  setTtsUiStatus: (value: TtsUiStatus) => void;
  setTtsQueueProcessing: (value: boolean) => void;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
  elapsedSinceMs: (startedAtMs: number) => number | null;
  clearStreamAudioQueue: (options?: { bumpGeneration?: boolean }) => void;
  setStreamWaveformPreview: (value: number[]) => void;
  markTtsPlaybackStopped: () => void;
  setAudioModeForPlayback: (options?: AudioModeSwitchOptions) => Promise<void>;
  clearTtsPlaybackWatchdogTimer: () => void;
  setTtsSoundWithRef: (
    next: Audio.Sound | null | ((current: Audio.Sound | null) => Audio.Sound | null)
  ) => void;
};

export function useStopTtsPlaybackController(options: UseStopTtsPlaybackControllerOptions) {
  const {
    ttsStopInFlightRef,
    ttsPlaybackTransitionInFlightRef,
    autoLastTtsStopRequestedAtRef,
    autoLastBargeInDetectedAtRef,
    autoLastTtsStoppedAtRef,
    ttsPlaybackRunIdRef,
    ttsSynthesisRequestIdRef,
    ttsPlayingRef,
    replyLoadingRef,
    streamSocketRef,
    streamAudioQueueRef,
    streamAudioQueueProcessingRef,
    streamTtsSuppressedRef,
    streamTtsControlRef,
    streamAudioWaveformBarsRef,
    ttsPlaybackMessageIdRef,
    ttsSoundRef,
    ttsLoading,
    ttsUiStatus,
    setTtsPlaybackWanted,
    setTtsLoading,
    setTtsUiStatus,
    setTtsQueueProcessing,
    logAuto,
    elapsedSinceMs,
    clearStreamAudioQueue,
    setStreamWaveformPreview,
    markTtsPlaybackStopped,
    setAudioModeForPlayback,
    clearTtsPlaybackWatchdogTimer,
    setTtsSoundWithRef,
  } = options;

  const stopTtsPlayback = useCallback(async (
    stopOptions?: { interruptStream?: boolean; reason?: string }
  ) => {
    if (ttsStopInFlightRef.current) {
      await ttsStopInFlightRef.current;
      return;
    }
    const stopTask = (async () => {
      const interruptStream = stopOptions?.interruptStream ?? false;
      const reason = String(stopOptions?.reason || "unspecified");
      const stopRequestedAt = Date.now();
      ttsPlaybackTransitionInFlightRef.current = true;
      autoLastTtsStopRequestedAtRef.current = stopRequestedAt;
      logAuto("tts_stop_requested", {
        reason,
        interruptStream,
        ttsPlaying: ttsPlayingRef.current,
        ttsLoading,
        ttsUiStatus,
        streamSocketAlive: streamSocketRef.current !== null,
        streamTtsControlAlive: streamTtsControlRef.current !== null,
        streamQueueSize: streamAudioQueueRef.current.length,
        replyLoading: replyLoadingRef.current,
        sinceBargeInDetectedMs: elapsedSinceMs(autoLastBargeInDetectedAtRef.current),
        sinceTtsStoppedMs: elapsedSinceMs(autoLastTtsStoppedAtRef.current),
      });
      setTtsPlaybackWanted(false, "stop_requested", {
        reason,
        interruptStream,
        runId: ttsPlaybackRunIdRef.current,
        streamQueueSize: streamAudioQueueRef.current.length,
        streamQueueProcessing: streamAudioQueueProcessingRef.current,
        streamSocketAlive: streamSocketRef.current !== null,
        streamTtsControlAlive: streamTtsControlRef.current !== null,
      });
      ttsPlaybackRunIdRef.current += 1;
      ttsSynthesisRequestIdRef.current += 1;
      setTtsLoading(false);
      setTtsUiStatus("idle");
      setTtsQueueProcessing(false);
      if (interruptStream) {
        streamTtsSuppressedRef.current = true;
        const ws = streamSocketRef.current;
        if (ws) {
          ws.close();
          streamSocketRef.current = null;
        }
        const streamTtsControl = streamTtsControlRef.current;
        if (streamTtsControl) {
          streamTtsControl.cleanup();
          streamTtsControlRef.current = null;
        }
        logAuto("tts_stream_interrupt_cleanup", {
          hadSocket: Boolean(ws),
          hadControl: Boolean(streamTtsControl),
          sinceBargeInDetectedMs: elapsedSinceMs(autoLastBargeInDetectedAtRef.current),
          sinceTtsStopRequestedMs: elapsedSinceMs(autoLastTtsStopRequestedAtRef.current),
          sinceTtsStoppedMs: elapsedSinceMs(autoLastTtsStoppedAtRef.current),
        });
      } else if (replyLoadingRef.current) {
        streamTtsSuppressedRef.current = true;
      }
      clearStreamAudioQueue();
      streamAudioWaveformBarsRef.current = [];
      setStreamWaveformPreview([]);
      markTtsPlaybackStopped();
      const activeTtsSound = ttsSoundRef.current;
      if (!activeTtsSound) {
        await setAudioModeForPlayback({ reason: "tts_stop_without_sound" }).catch(() => {});
        clearTtsPlaybackWatchdogTimer();
        logAuto("tts_stop_completed", {
          interruptStream,
          hadSound: false,
          elapsedMs: Math.max(0, Date.now() - stopRequestedAt),
        });
        return;
      }
      activeTtsSound.setOnPlaybackStatusUpdate(null);
      try {
        await activeTtsSound.stopAsync();
      } catch {}
      try {
        await activeTtsSound.unloadAsync();
      } catch {}
      setTtsSoundWithRef((current) => (current === activeTtsSound ? null : current));
      await setAudioModeForPlayback({ reason: "tts_stop_with_sound" }).catch(() => {});
      clearTtsPlaybackWatchdogTimer();
      logAuto("tts_stop_completed", {
        interruptStream,
        hadSound: true,
        elapsedMs: Math.max(0, Date.now() - stopRequestedAt),
      });
    })();
    ttsStopInFlightRef.current = stopTask;
    try {
      await stopTask;
    } finally {
      if (ttsStopInFlightRef.current === stopTask) {
        ttsStopInFlightRef.current = null;
      }
      ttsPlaybackTransitionInFlightRef.current = false;
    }
  }, [
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoLastTtsStoppedAtRef,
    clearStreamAudioQueue,
    clearTtsPlaybackWatchdogTimer,
    elapsedSinceMs,
    logAuto,
    markTtsPlaybackStopped,
    replyLoadingRef,
    setAudioModeForPlayback,
    setStreamWaveformPreview,
    setTtsLoading,
    setTtsPlaybackWanted,
    setTtsQueueProcessing,
    setTtsSoundWithRef,
    setTtsUiStatus,
    streamAudioQueueProcessingRef,
    streamAudioQueueRef,
    streamAudioWaveformBarsRef,
    streamSocketRef,
    streamTtsControlRef,
    streamTtsSuppressedRef,
    ttsLoading,
    ttsPlaybackRunIdRef,
    ttsPlaybackTransitionInFlightRef,
    ttsPlayingRef,
    ttsSoundRef,
    ttsStopInFlightRef,
    ttsSynthesisRequestIdRef,
    ttsUiStatus,
  ]);

  const stopWaveformPlayback = useCallback(async () => {
    const shouldInterruptStream = (
      replyLoadingRef.current ||
      ttsPlaybackMessageIdRef.current === "__stream__" ||
      streamTtsControlRef.current !== null ||
      streamSocketRef.current !== null
    );
    await stopTtsPlayback({ interruptStream: shouldInterruptStream });
  }, [
    replyLoadingRef,
    stopTtsPlayback,
    streamSocketRef,
    streamTtsControlRef,
    ttsPlaybackMessageIdRef,
  ]);

  return {
    stopTtsPlayback,
    stopWaveformPlayback,
  };
}
