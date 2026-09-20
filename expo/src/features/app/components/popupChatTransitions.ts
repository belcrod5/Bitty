import { Animated, Easing } from "react-native";
import { createCyberpunkFlashBlinkTransition } from "./cyberpunkFlashBlinkTransition";

export type PopupTransitionDirection = "open" | "close";

type PopupTransitionOptions = {
  direction: PopupTransitionDirection;
  durationMs: number;
  reduceMotion: boolean;
  progress: Animated.Value;
  cardOpacity: Animated.Value;
  cardScaleY: Animated.Value;
  flashOpacity: Animated.Value;
  onFinish: (finished?: boolean) => void;
};

const timing = (
  value: Animated.Value,
  toValue: number,
  duration: number,
  easing = Easing.linear
) => Animated.timing(value, {
  toValue,
  duration,
  easing,
  useNativeDriver: false,
});

export function startStandardPopupTransition({
  direction,
  durationMs,
  reduceMotion,
  progress,
  cardOpacity,
  cardScaleY,
  flashOpacity,
  onFinish,
}: PopupTransitionOptions): Animated.CompositeAnimation {
  const target = direction === "open" ? 1 : 0;
  const duration = reduceMotion ? 0 : durationMs;
  flashOpacity.setValue(0);
  cardScaleY.setValue(1);
  const animation = Animated.parallel([
    timing(cardOpacity, target, duration, Easing.out(Easing.cubic)),
    timing(progress, target, duration, Easing.out(Easing.cubic)),
  ]);
  animation.start(({ finished }) => onFinish(finished));
  return animation;
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
}: PopupTransitionOptions): Animated.CompositeAnimation {
  const target = direction === "open" ? 1 : 0;
  if (reduceMotion) {
    flashOpacity.setValue(0);
    cardScaleY.setValue(1);
    progress.setValue(1);
    const animation = timing(cardOpacity, target, 0);
    animation.start(({ finished }) => onFinish(finished));
    return animation;
  }

  // Cyberpunk transitions always use the final popup geometry. Its motion is
  // flashing plus a short vertical-only signal distortion near the end.
  progress.setValue(1);
  const animation = Animated.parallel([
    Animated.sequence([
      Animated.delay(Math.max(0, durationMs - 56)),
      timing(cardScaleY, 1.045, 10),
      timing(cardScaleY, 0.955, 10),
      timing(cardScaleY, 1.025, 10),
      timing(cardScaleY, 0.98, 10),
      timing(cardScaleY, 1, 16),
    ]),
    createCyberpunkFlashBlinkTransition({
      direction,
      durationMs,
      contentOpacity: cardOpacity,
      flashOpacity,
    }),
  ]);
  animation.start(({ finished }) => onFinish(finished));
  return animation;
}
