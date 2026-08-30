import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import {
  mutatePersistedSettings,
  readPersistedSettingsField,
  SKIA_BOARD_VIEWPORT_FIELD,
} from "../utils/persistedSettingsFile";

export const SKIA_BOARD_MIN_SCALE = 0.25;
export const SKIA_BOARD_MAX_SCALE = 2.5;
const MAX_ABS_TRANSLATION = 1_000_000;

export type SkiaBoardViewport = { x: number; y: number; scale: number };

export function normalizeSkiaBoardViewport(value: unknown): SkiaBoardViewport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const x = typeof raw.x === "number" ? raw.x : Number.NaN;
  const y = typeof raw.y === "number" ? raw.y : Number.NaN;
  const scale = typeof raw.scale === "number" ? raw.scale : Number.NaN;
  if (![x, y, scale].every(Number.isFinite)) return null;
  return {
    x: Math.max(-MAX_ABS_TRANSLATION, Math.min(MAX_ABS_TRANSLATION, x)),
    y: Math.max(-MAX_ABS_TRANSLATION, Math.min(MAX_ABS_TRANSLATION, y)),
    scale: Math.max(SKIA_BOARD_MIN_SCALE, Math.min(SKIA_BOARD_MAX_SCALE, scale)),
  };
}

export function useSkiaBoardViewportPersistence(values: {
  x: SharedValue<number>;
  y: SharedValue<number>;
  scale: SharedValue<number>;
}) {
  const interactedRef = useRef(false);
  const loadedRef = useRef(false);
  const lastSavedRef = useRef("");

  const persistViewport = useCallback((x: number, y: number, scale: number) => {
    const viewport = normalizeSkiaBoardViewport({ x, y, scale });
    if (!viewport) return;
    const serialized = JSON.stringify(viewport);
    if (serialized === lastSavedRef.current) return;
    lastSavedRef.current = serialized;
    void mutatePersistedSettings((current) => ({
      ...current,
      [SKIA_BOARD_VIEWPORT_FIELD]: viewport,
    })).catch((error) => {
      lastSavedRef.current = "";
      console.warn("[skia_board] failed to save viewport", error);
    });
  }, []);

  const persistCurrentViewport = useCallback(() => {
    if (!loadedRef.current && !interactedRef.current) return;
    persistViewport(values.x.value, values.y.value, values.scale.value);
  }, [persistViewport, values.scale, values.x, values.y]);

  useEffect(() => {
    let active = true;
    void readPersistedSettingsField(SKIA_BOARD_VIEWPORT_FIELD)
      .then((raw) => {
        if (!active) return;
        const viewport = normalizeSkiaBoardViewport(raw);
        if (viewport && !interactedRef.current) {
          values.x.value = viewport.x;
          values.y.value = viewport.y;
          values.scale.value = viewport.scale;
          lastSavedRef.current = JSON.stringify(viewport);
        }
        loadedRef.current = true;
      })
      .catch((error) => {
        loadedRef.current = true;
        console.warn("[skia_board] failed to load viewport", error);
      });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") persistCurrentViewport();
    });
    return () => {
      active = false;
      subscription.remove();
      persistCurrentViewport();
    };
  }, [persistCurrentViewport, values.scale, values.x, values.y]);

  const markViewportInteraction = useCallback(() => {
    interactedRef.current = true;
  }, []);

  return { markViewportInteraction, persistViewport };
}
