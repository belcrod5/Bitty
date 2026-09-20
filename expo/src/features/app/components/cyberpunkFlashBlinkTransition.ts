import { Animated, Easing } from "react-native";

type FlashBlinkTransitionOptions = {
  direction: "open" | "close";
  durationMs: number;
  contentOpacity: Animated.Value;
  flashOpacity: Animated.Value;
};

const timing = (value: Animated.Value, toValue: number, duration: number) => Animated.timing(value, {
  toValue,
  duration,
  easing: Easing.linear,
  useNativeDriver: false,
});

export function createCyberpunkFlashBlinkTransition({
  direction,
  durationMs,
  contentOpacity,
  flashOpacity,
}: FlashBlinkTransitionOptions): Animated.CompositeAnimation {
  if (direction === "open") {
    const blinkDurationMs = 164;
    return Animated.parallel([
      Animated.sequence([
        timing(contentOpacity, 1, 36),
        timing(contentOpacity, 0.08, 24),
        timing(contentOpacity, 1, 28),
        timing(contentOpacity, 0.15, 24),
        timing(contentOpacity, 1, 28),
        timing(contentOpacity, 0.22, 24),
        timing(contentOpacity, 1, Math.max(0, durationMs - blinkDurationMs)),
      ]),
      Animated.sequence([
        timing(flashOpacity, 0.95, 24),
        timing(flashOpacity, 0, 42),
      ]),
    ]);
  }

  const blinkDurationMs = 80;
  const flashOutDurationMs = 34;
  const flashOutDelayMs = Math.max(0, durationMs - blinkDurationMs - flashOutDurationMs);
  return Animated.parallel([
    Animated.sequence([
      timing(contentOpacity, 0.16, 20),
      timing(contentOpacity, 1, 20),
      timing(contentOpacity, 0.1, 20),
      timing(contentOpacity, 1, 20),
      Animated.delay(flashOutDelayMs),
      timing(contentOpacity, 0, flashOutDurationMs),
    ]),
    Animated.sequence([
      Animated.delay(blinkDurationMs + flashOutDelayMs),
      timing(flashOpacity, 0.95, 16),
      timing(flashOpacity, 0, 18),
    ]),
  ]);
}
