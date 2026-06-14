import { useCallback, useEffect, useRef } from "react";
import { Audio } from "expo-av";
import type { UiSfxKey } from "../types/appTypes";

type UseUiSfxControllerOptions = {
  uiSfxAssets: Record<UiSfxKey, number>;
  uiSfxVolumes: Record<UiSfxKey, number>;
  uiSfxMinIntervalMs: Partial<Record<UiSfxKey, number>>;
};

export function useUiSfxController(options: UseUiSfxControllerOptions) {
  const {
    uiSfxAssets,
    uiSfxVolumes,
    uiSfxMinIntervalMs,
  } = options;

  const uiSfxSoundsRef = useRef<Partial<Record<UiSfxKey, Audio.Sound>>>({});
  const uiSfxLastPlayedAtRef = useRef<Partial<Record<UiSfxKey, number>>>({});

  const playUiSfx = useCallback((key: UiSfxKey, playOptions?: { minIntervalMs?: number }) => {
    const sound = uiSfxSoundsRef.current[key];
    if (!sound) return;
    const now = Date.now();
    const minIntervalMs = Number(playOptions?.minIntervalMs ?? uiSfxMinIntervalMs[key] ?? 0);
    const lastPlayedAt = Number(uiSfxLastPlayedAtRef.current[key] || 0);
    if (minIntervalMs > 0 && now - lastPlayedAt < minIntervalMs) return;
    uiSfxLastPlayedAtRef.current[key] = now;
    void sound.replayAsync().catch(() => {});
  }, [uiSfxMinIntervalMs]);

  useEffect(() => {
    let disposed = false;
    const loadedSounds: Partial<Record<UiSfxKey, Audio.Sound>> = {};

    async function loadUiSfx() {
      for (const key of Object.keys(uiSfxAssets) as UiSfxKey[]) {
        try {
          const { sound } = await Audio.Sound.createAsync(uiSfxAssets[key], {
            shouldPlay: false,
            volume: uiSfxVolumes[key],
          });
          if (disposed) {
            await sound.unloadAsync().catch(() => {});
            continue;
          }
          loadedSounds[key] = sound;
          uiSfxSoundsRef.current[key] = sound;
        } catch {}
      }
    }

    void loadUiSfx();

    return () => {
      disposed = true;
      uiSfxSoundsRef.current = {};
      uiSfxLastPlayedAtRef.current = {};
      for (const sound of Object.values(loadedSounds)) {
        if (!sound) continue;
        void sound.unloadAsync().catch(() => {});
      }
    };
  }, [uiSfxAssets, uiSfxVolumes]);

  return {
    playUiSfx,
  };
}
