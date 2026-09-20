import { useCallback, useEffect, useRef } from "react";

import { Audio } from "../audio";
import type {
  VisualThemeSound,
  VisualThemeTransitionEvent,
} from "../theme/visualThemes";

type ThemeSounds = Record<VisualThemeTransitionEvent, VisualThemeSound>;

export function useThemeSfxController(sounds: ThemeSounds, enabled: boolean) {
  const activeSoundsRef = useRef(new Set<Audio.Sound>());
  const generationRef = useRef(0);
  const currentSoundsRef = useRef(sounds);
  const enabledRef = useRef(enabled);
  currentSoundsRef.current = sounds;
  enabledRef.current = enabled;

  const playThemeSfx = useCallback(async (event: VisualThemeTransitionEvent) => {
    if (!enabled) return;

    const generation = generationRef.current;
    let sound: Audio.Sound | null = null;
    try {
      const created = await Audio.Sound.createAsync(sounds[event].asset, {
        shouldPlay: true,
        volume: sounds[event].volume,
      });
      sound = created.sound;
      if (
        generationRef.current !== generation
        || !enabledRef.current
        || currentSoundsRef.current !== sounds
      ) {
        await sound.unloadAsync().catch(() => {});
        return;
      }
      activeSoundsRef.current.add(sound);
      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded || !status.didJustFinish || !sound) return;
        activeSoundsRef.current.delete(sound);
        sound.setOnPlaybackStatusUpdate(null);
        void sound.unloadAsync().catch(() => {});
        sound = null;
      });
    } catch {
      if (sound) {
        activeSoundsRef.current.delete(sound);
        void sound.unloadAsync().catch(() => {});
      }
    }
  }, [enabled, sounds]);

  useEffect(() => () => {
    generationRef.current += 1;
    for (const sound of activeSoundsRef.current) {
      sound.setOnPlaybackStatusUpdate(null);
      void sound.unloadAsync().catch(() => {});
      activeSoundsRef.current.delete(sound);
    }
  }, [enabled, sounds]);

  return { playThemeSfx };
}
