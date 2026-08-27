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

  return {
    setTtsSpeedWithSync,
    applyRecordingQualityPreset,
  };
}
