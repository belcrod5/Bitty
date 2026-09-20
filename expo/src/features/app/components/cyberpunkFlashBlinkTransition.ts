import {
  Easing,
  withDelay,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

type FlashBlinkTransitionOptions = {
  direction: "open" | "close";
  durationMs: number;
  contentOpacity: SharedValue<number>;
  contentScaleY: SharedValue<number>;
  flashOpacity: SharedValue<number>;
  onFinish: (finished?: boolean) => void;
};

export function startCyberpunkFlashBlinkTransition({
  direction,
  durationMs,
  contentOpacity,
  contentScaleY,
  flashOpacity,
  onFinish,
}: FlashBlinkTransitionOptions) {
  contentScaleY.value = withDelay(
    Math.max(0, durationMs - 56),
    withSequence(
      withTiming(1.045, { duration: 10, easing: Easing.linear }),
      withTiming(0.955, { duration: 10, easing: Easing.linear }),
      withTiming(1.025, { duration: 10, easing: Easing.linear }),
      withTiming(0.98, { duration: 10, easing: Easing.linear }),
      withTiming(1, { duration: 16, easing: Easing.linear }, onFinish)
    )
  );

  if (direction === "open") {
    const blinkDurationMs = 164;
    contentOpacity.value = withSequence(
      withTiming(1, { duration: 36, easing: Easing.linear }),
      withTiming(0.08, { duration: 24, easing: Easing.linear }),
      withTiming(1, { duration: 28, easing: Easing.linear }),
      withTiming(0.15, { duration: 24, easing: Easing.linear }),
      withTiming(1, { duration: 28, easing: Easing.linear }),
      withTiming(0.22, { duration: 24, easing: Easing.linear }),
      withTiming(1, {
        duration: Math.max(0, durationMs - blinkDurationMs),
        easing: Easing.linear,
      })
    );
    flashOpacity.value = withSequence(
      withTiming(0.95, { duration: 24, easing: Easing.linear }),
      withTiming(0, { duration: 42, easing: Easing.linear })
    );
    return;
  }

  const blinkDurationMs = 80;
  const flashOutDurationMs = 34;
  const flashOutDelayMs = Math.max(0, durationMs - blinkDurationMs - flashOutDurationMs);
  contentOpacity.value = withSequence(
    withTiming(0.16, { duration: 20, easing: Easing.linear }),
    withTiming(1, { duration: 20, easing: Easing.linear }),
    withTiming(0.1, { duration: 20, easing: Easing.linear }),
    withTiming(1, { duration: 20, easing: Easing.linear }),
    withDelay(
      flashOutDelayMs,
      withTiming(0, { duration: flashOutDurationMs, easing: Easing.linear })
    )
  );
  flashOpacity.value = withDelay(
    blinkDurationMs + flashOutDelayMs,
    withSequence(
      withTiming(0.95, { duration: 16, easing: Easing.linear }),
      withTiming(0, { duration: 18, easing: Easing.linear })
    )
  );
}
