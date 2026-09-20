import { Animated } from "react-native";

import { startCyberpunkPopupTransition } from "./popupChatTransitions";

function animation(): Animated.CompositeAnimation {
  return {
    start: (callback) => callback?.({ finished: true }),
    stop: jest.fn(),
    reset: jest.fn(),
  };
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(Animated, "timing").mockImplementation(() => animation());
  jest.spyOn(Animated, "delay").mockImplementation(() => animation());
  jest.spyOn(Animated, "sequence").mockImplementation(() => animation());
  jest.spyOn(Animated, "parallel").mockImplementation(() => animation());
});

test.each(["open", "close"] as const)(
  "keeps cyberpunk %s geometry at the popup rect and animates vertical scale",
  (direction) => {
    const progress = new Animated.Value(direction === "open" ? 0 : 2);
    const setProgress = jest.spyOn(progress, "setValue");
    const onFinish = jest.fn();

    startCyberpunkPopupTransition({
      direction,
      durationMs: 220,
      reduceMotion: false,
      progress,
      cardOpacity: new Animated.Value(direction === "open" ? 0 : 1),
      cardScaleY: new Animated.Value(1),
      flashOpacity: new Animated.Value(0),
      onFinish,
    });

    expect(setProgress).toHaveBeenCalledWith(1);
    const timingTargets = (Animated.timing as jest.Mock).mock.calls.map(([, config]) => config.toValue);
    expect(timingTargets.slice(0, 5)).toEqual([1.045, 0.955, 1.025, 0.98, 1]);
    expect((Animated.timing as jest.Mock).mock.calls.every(([, config]) => config.useNativeDriver === false)).toBe(true);
    expect(Animated.sequence).toHaveBeenCalledTimes(3);
    expect(onFinish).toHaveBeenCalledWith(true);
  }
);

test("suppresses cyberpunk blink and vertical stretch with Reduce Motion", () => {
  const progress = new Animated.Value(0);
  const cardScaleY = new Animated.Value(0.8);
  const flashOpacity = new Animated.Value(0.5);
  const setProgress = jest.spyOn(progress, "setValue");
  const setCardScaleY = jest.spyOn(cardScaleY, "setValue");
  const setFlashOpacity = jest.spyOn(flashOpacity, "setValue");
  const onFinish = jest.fn();

  startCyberpunkPopupTransition({
    direction: "open",
    durationMs: 260,
    reduceMotion: true,
    progress,
    cardOpacity: new Animated.Value(0),
    cardScaleY,
    flashOpacity,
    onFinish,
  });

  expect(setProgress).toHaveBeenCalledWith(1);
  expect(setCardScaleY).toHaveBeenCalledWith(1);
  expect(setFlashOpacity).toHaveBeenCalledWith(0);
  expect(Animated.sequence).not.toHaveBeenCalled();
  expect(Animated.timing).toHaveBeenCalledTimes(1);
  expect(onFinish).toHaveBeenCalledWith(true);
});
