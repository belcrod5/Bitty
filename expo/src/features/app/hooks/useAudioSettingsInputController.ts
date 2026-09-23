import { useCallback } from "react";

type UseAudioSettingsInputControllerOptions = {
  setTtsSpeed: (value: number) => void;
  setTtsSpeedInput: (value: string) => void;
  clampTtsSpeed: (valueRaw: number) => number;
};

export function useAudioSettingsInputController(options: UseAudioSettingsInputControllerOptions) {
  const {
    setTtsSpeed,
    setTtsSpeedInput,
    clampTtsSpeed,
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

  return { setTtsSpeedWithSync };
}
