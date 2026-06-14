import { useCallback, type MutableRefObject } from "react";

type UseAutoWaveformStateControllerOptions = {
  autoWaveformDataPipelineEnabled: boolean;
  autoWaveformPoints: number;
  autoWaveformUpdateMs: number;
  autoWaveformDecayMinSignal: number;
  autoWaveformDecayFactor: number;
  autoWaveformSkipLogThrottleMs: number;
  autoStartThresholdDb: number;
  ttsLoading: boolean;
  autoRecordingState: string;
  autoLastEvent: string;
  ttsPlayingRef: MutableRefObject<boolean>;
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  autoBargeInEnabledRef: MutableRefObject<boolean>;
  autoWaveformSkipLogAtRef: MutableRefObject<number>;
  autoWaveformUiAtRef: MutableRefObject<number>;
  autoWaveformLastSampleAtRef: MutableRefObject<number>;
  autoUiLatestMeteringRef: MutableRefObject<number | null>;
  autoUiLatestSpeechSampleRef: MutableRefObject<boolean>;
  autoWaveFlatlineSinceRef: MutableRefObject<number>;
  autoWaveFlatlineLogAtRef: MutableRefObject<number>;
  autoWaveFlatlineActiveRef: MutableRefObject<boolean>;
  autoWaveFlatlineSourceRef: MutableRefObject<string>;
  maybeLogWaveformSamplePath: (now: number, payload: Record<string, unknown>) => void;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
  normalizeMetering: (meteringDb: number) => number;
  buildEmptyWaveformBars: (enabled: boolean, points: number) => number[];
  setAutoWaveform: (updater: (prev: number[]) => number[]) => void;
  setAutoWaveformSpeechMask: (updater: (prev: number[]) => number[]) => void;
};

export function useAutoWaveformStateController(options: UseAutoWaveformStateControllerOptions) {
  const {
    autoWaveformDataPipelineEnabled,
    autoWaveformPoints,
    autoWaveformUpdateMs,
    autoWaveformDecayMinSignal,
    autoWaveformDecayFactor,
    autoWaveformSkipLogThrottleMs,
    autoStartThresholdDb,
    ttsLoading,
    autoRecordingState,
    autoLastEvent,
    ttsPlayingRef,
    autoRecordingEnabledRef,
    autoBargeInEnabledRef,
    autoWaveformSkipLogAtRef,
    autoWaveformUiAtRef,
    autoWaveformLastSampleAtRef,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    autoWaveFlatlineSinceRef,
    autoWaveFlatlineLogAtRef,
    autoWaveFlatlineActiveRef,
    autoWaveFlatlineSourceRef,
    maybeLogWaveformSamplePath,
    logAuto,
    normalizeMetering,
    buildEmptyWaveformBars,
    setAutoWaveform,
    setAutoWaveformSpeechMask,
  } = options;

  const appendAutoWaveformSample = useCallback((meteringDb: number, isSpeechSample?: boolean) => {
    const now = Date.now();
    const shouldSkipDuringTts = (
      (ttsPlayingRef.current || ttsLoading) &&
      !(autoRecordingEnabledRef.current && autoBargeInEnabledRef.current)
    );
    if (shouldSkipDuringTts) {
      if (now - autoWaveformSkipLogAtRef.current >= autoWaveformSkipLogThrottleMs) {
        autoWaveformSkipLogAtRef.current = now;
        logAuto("waveform_skip_tts", {
          ttsPlaying: ttsPlayingRef.current,
          ttsLoading,
          autoState: autoRecordingState,
          autoEvent: autoLastEvent,
        });
      }
      maybeLogWaveformSamplePath(now, {
        path: "skip_tts",
        meteringDb,
        ttsPlaying: ttsPlayingRef.current,
        ttsLoading,
      });
      return;
    }

    autoWaveformLastSampleAtRef.current = now;
    if (!autoWaveformDataPipelineEnabled) return;
    const sinceWaveformUiMs = now - autoWaveformUiAtRef.current;
    if (sinceWaveformUiMs < autoWaveformUpdateMs) {
      maybeLogWaveformSamplePath(now, {
        path: "skip_throttle",
        meteringDb,
        sinceWaveformUiMs,
        waveformUpdateMs: autoWaveformUpdateMs,
      });
      return;
    }
    autoWaveformUiAtRef.current = now;
    const sample = normalizeMetering(meteringDb);
    const resolvedSpeechSample = (
      typeof isSpeechSample === "boolean"
        ? isSpeechSample
        : meteringDb >= autoStartThresholdDb
    );
    maybeLogWaveformSamplePath(now, {
      path: "updated",
      meteringDb,
      sample,
      speechSample: resolvedSpeechSample,
      sinceWaveformUiMs,
      waveformUpdateMs: autoWaveformUpdateMs,
    });
    setAutoWaveform((prev) => {
      const trimmed = prev.length >= autoWaveformPoints ? prev.slice(1) : [...prev];
      trimmed.push(sample);
      while (trimmed.length < autoWaveformPoints) trimmed.unshift(0);
      return trimmed;
    });
    setAutoWaveformSpeechMask((prev) => {
      const trimmed = prev.length >= autoWaveformPoints ? prev.slice(1) : [...prev];
      trimmed.push(resolvedSpeechSample ? 1 : 0);
      while (trimmed.length < autoWaveformPoints) trimmed.unshift(0);
      return trimmed;
    });
  }, [
    ttsPlayingRef,
    ttsLoading,
    autoRecordingEnabledRef,
    autoBargeInEnabledRef,
    autoWaveformSkipLogAtRef,
    autoWaveformSkipLogThrottleMs,
    logAuto,
    autoRecordingState,
    autoLastEvent,
    maybeLogWaveformSamplePath,
    autoWaveformLastSampleAtRef,
    autoWaveformDataPipelineEnabled,
    autoWaveformUiAtRef,
    autoWaveformUpdateMs,
    normalizeMetering,
    autoStartThresholdDb,
    setAutoWaveform,
    autoWaveformPoints,
    setAutoWaveformSpeechMask,
  ]);

  const decayAutoWaveformFrame = useCallback((now: number) => {
    if (!autoWaveformDataPipelineEnabled) return;
    if (now - autoWaveformUiAtRef.current < autoWaveformUpdateMs) return;
    autoWaveformUiAtRef.current = now;
    setAutoWaveform((prev) => {
      if (!Array.isArray(prev) || prev.length <= 0) return prev;
      let hasSignal = false;
      for (let i = 0; i < prev.length; i += 1) {
        if (Number(prev[i] || 0) >= autoWaveformDecayMinSignal) {
          hasSignal = true;
          break;
        }
      }
      if (!hasSignal) return prev;

      const shifted = prev.length >= autoWaveformPoints ? prev.slice(1) : [...prev];
      for (let i = 0; i < shifted.length; i += 1) {
        const next = Number(shifted[i] || 0) * autoWaveformDecayFactor;
        shifted[i] = next >= 0.004 ? next : 0;
      }
      shifted.push(0);
      while (shifted.length < autoWaveformPoints) shifted.unshift(0);
      return shifted;
    });
    setAutoWaveformSpeechMask((prev) => {
      if (!Array.isArray(prev) || prev.length <= 0) return prev;
      const shifted = prev.length >= autoWaveformPoints ? prev.slice(1) : [...prev];
      shifted.push(0);
      while (shifted.length < autoWaveformPoints) shifted.unshift(0);
      return shifted;
    });
  }, [
    autoWaveformDataPipelineEnabled,
    autoWaveformUiAtRef,
    autoWaveformUpdateMs,
    setAutoWaveform,
    autoWaveformDecayMinSignal,
    autoWaveformPoints,
    autoWaveformDecayFactor,
    setAutoWaveformSpeechMask,
  ]);

  const resetAutoWaveform = useCallback(() => {
    if (autoWaveformDataPipelineEnabled) {
      setAutoWaveform(() => buildEmptyWaveformBars(autoWaveformDataPipelineEnabled, autoWaveformPoints));
      setAutoWaveformSpeechMask(() => buildEmptyWaveformBars(autoWaveformDataPipelineEnabled, autoWaveformPoints));
    }
    autoUiLatestMeteringRef.current = null;
    autoUiLatestSpeechSampleRef.current = false;
    autoWaveformUiAtRef.current = 0;
    autoWaveformLastSampleAtRef.current = 0;
    autoWaveFlatlineSinceRef.current = 0;
    autoWaveFlatlineLogAtRef.current = 0;
    autoWaveFlatlineActiveRef.current = false;
    autoWaveFlatlineSourceRef.current = "";
  }, [
    autoWaveformDataPipelineEnabled,
    setAutoWaveform,
    buildEmptyWaveformBars,
    autoWaveformPoints,
    setAutoWaveformSpeechMask,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    autoWaveformUiAtRef,
    autoWaveformLastSampleAtRef,
    autoWaveFlatlineSinceRef,
    autoWaveFlatlineLogAtRef,
    autoWaveFlatlineActiveRef,
    autoWaveFlatlineSourceRef,
  ]);

  return {
    appendAutoWaveformSample,
    decayAutoWaveformFrame,
    resetAutoWaveform,
  };
}
