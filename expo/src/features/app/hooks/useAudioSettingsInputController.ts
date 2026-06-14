import { useCallback } from "react";
import type {
  RecordingQualityPreset,
  RecordingTuning,
} from "../utils/audioConfig";

type UseAudioSettingsInputControllerOptions = {
  setTtsSpeed: (value: number) => void;
  setTtsSpeedInput: (value: string) => void;
  clampTtsSpeed: (valueRaw: number) => number;
  setRecordingQualityPreset: (value: RecordingQualityPreset) => void;
  setRecordingTuning: (value: RecordingTuning | ((prev: RecordingTuning) => RecordingTuning)) => void;
  parseRecordingQualityPreset: (valueRaw: unknown) => RecordingQualityPreset;
  recordingTuningFromPreset: (preset: RecordingQualityPreset) => RecordingTuning;
  clampRecordingChannels: (raw: number) => number;
};

export function useAudioSettingsInputController(options: UseAudioSettingsInputControllerOptions) {
  const {
    setTtsSpeed,
    setTtsSpeedInput,
    clampTtsSpeed,
    setRecordingQualityPreset,
    setRecordingTuning,
    parseRecordingQualityPreset,
    recordingTuningFromPreset,
    clampRecordingChannels,
  } = options;

  const setTtsSpeedWithSync = useCallback((value: number) => {
    const next = clampTtsSpeed(value);
    setTtsSpeed(next);
    setTtsSpeedInput(next.toFixed(1));
  }, [
    clampTtsSpeed,
    setTtsSpeed,
    setTtsSpeedInput,
  ]);

  const applyRecordingQualityPreset = useCallback((nextPreset: RecordingQualityPreset) => {
    const normalized = parseRecordingQualityPreset(nextPreset);
    setRecordingQualityPreset(normalized);
    setRecordingTuning(recordingTuningFromPreset(normalized));
  }, [
    parseRecordingQualityPreset,
    setRecordingQualityPreset,
    setRecordingTuning,
    recordingTuningFromPreset,
  ]);

  const setRecordingSampleRateFromInput = useCallback((raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    const normalized = Math.round(value);
    if (normalized <= 0) return;
    setRecordingTuning((prev) => ({
      ...prev,
      sampleRate: normalized,
    }));
  }, [setRecordingTuning]);

  const setRecordingChannelsFromInput = useCallback((raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    setRecordingTuning((prev) => ({
      ...prev,
      numberOfChannels: clampRecordingChannels(value),
    }));
  }, [
    clampRecordingChannels,
    setRecordingTuning,
  ]);

  const setRecordingBitRateFromInput = useCallback((raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    const normalized = Math.round(value);
    if (normalized <= 0) return;
    setRecordingTuning((prev) => ({
      ...prev,
      bitRate: normalized,
    }));
  }, [setRecordingTuning]);

  const setRecordingProgressUpdateIntervalFromInput = useCallback((raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    const normalized = Math.round(value);
    if (normalized <= 0) return;
    setRecordingTuning((prev) => ({
      ...prev,
      progressUpdateIntervalMs: normalized,
    }));
  }, [setRecordingTuning]);

  return {
    setTtsSpeedWithSync,
    applyRecordingQualityPreset,
    setRecordingSampleRateFromInput,
    setRecordingChannelsFromInput,
    setRecordingBitRateFromInput,
    setRecordingProgressUpdateIntervalFromInput,
  };
}
