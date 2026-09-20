import {
  Easing,
  withDelay,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { startCyberpunkFlashBlinkTransition } from "./cyberpunkFlashBlinkTransition";

export type PopupTransitionDirection = "open" | "close";

type PopupTransitionOptions = {
  direction: PopupTransitionDirection;
  durationMs: number;
  reduceMotion: boolean;
  progress: SharedValue<number>;
  cardOpacity: SharedValue<number>;
  cardScaleY: SharedValue<number>;
  flashOpacity: SharedValue<number>;
  onFinish: (finished?: boolean) => void;
};

export function startStandardPopupTransition({
  direction,
  durationMs,
  reduceMotion,
  progress,
  cardOpacity,
  cardScaleY,
  flashOpacity,
  onFinish,
}: PopupTransitionOptions) {
  const target = direction === "open" ? 1 : 0;
  const duration = reduceMotion ? 0 : durationMs;
  flashOpacity.value = 0;
  cardScaleY.value = 1;
  cardOpacity.value = withTiming(target, {
    duration,
    easing: Easing.out(Easing.cubic),
  });
  progress.value = withTiming(target, {
    duration,
    easing: Easing.out(Easing.cubic),
  }, onFinish);
}

export function startCyberpunkPopupTransition({
  direction,
  durationMs,
  reduceMotion,
  progress,
  cardOpacity,
  cardScaleY,
  flashOpacity,
  onFinish,
}: PopupTransitionOptions) {
  const target = direction === "open" ? 1 : 0;
  if (reduceMotion) {
    flashOpacity.value = 0;
    cardScaleY.value = 1;
    cardOpacity.value = withTiming(target, { duration: 0 }, onFinish);
    progress.value = 1;
    return;
  }

  // Cyberpunk transitions always use the final popup geometry. Its motion is
  // flashing plus a short vertical-only signal distortion near the end.
  progress.value = 1;
  cardScaleY.value = withDelay(
    Math.max(0, durationMs - 56),
    withSequence(
      withTiming(1.045, { duration: 10, easing: Easing.linear }),
      withTiming(0.955, { duration: 10, easing: Easing.linear }),
      withTiming(1.025, { duration: 10, easing: Easing.linear }),
      withTiming(0.98, { duration: 10, easing: Easing.linear }),
      withTiming(1, { duration: 16, easing: Easing.linear })
    )
  );
  startCyberpunkFlashBlinkTransition({
    direction,
    durationMs,
    contentOpacity: cardOpacity,
    flashOpacity,
    onFinish,
  });
}
