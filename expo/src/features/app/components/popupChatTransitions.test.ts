import { withSequence, withTiming, type SharedValue } from "react-native-reanimated";

import { startCyberpunkPopupTransition } from "./popupChatTransitions";

jest.mock("react-native-worklets", () => require("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => {
  const mock = require("react-native-reanimated/mock");
  return {
    ...mock,
    withDelay: jest.fn((_delay, animation) => animation),
    withSequence: jest.fn(mock.withSequence),
    withTiming: jest.fn(mock.withTiming),
  };
});

function shared(value: number): SharedValue<number> {
  return { value } as SharedValue<number>;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test.each(["open", "close"] as const)(
  "keeps cyberpunk %s geometry at the popup rect and animates vertical scale",
  (direction) => {
    const progress = shared(direction === "open" ? 0 : 2);
    const cardScaleY = shared(1);

    startCyberpunkPopupTransition({
      direction,
      durationMs: 220,
      reduceMotion: false,
      progress,
      cardOpacity: shared(direction === "open" ? 0 : 1),
      cardScaleY,
      flashOpacity: shared(0),
      onFinish: jest.fn(),
    });

    expect(progress.value).toBe(1);
    expect(cardScaleY.value).toBe((withSequence as jest.Mock).mock.results[0]?.value);
    expect((withTiming as jest.Mock).mock.calls.slice(0, 5).map(([target]) => target)).toEqual([
      1.045,
      0.955,
      1.025,
      0.98,
      1,
    ]);
    expect(withSequence).toHaveBeenCalledTimes(3);
  }
);

test("suppresses cyberpunk blink and vertical stretch with Reduce Motion", () => {
  const progress = shared(0);
  const cardScaleY = shared(0.8);

  startCyberpunkPopupTransition({
    direction: "open",
    durationMs: 260,
    reduceMotion: true,
    progress,
    cardOpacity: shared(0),
    cardScaleY,
    flashOpacity: shared(0.5),
    onFinish: jest.fn(),
  });

  expect(progress.value).toBe(1);
  expect(cardScaleY.value).toBe(1);
  expect(withSequence).not.toHaveBeenCalled();
  expect(withTiming).toHaveBeenCalledTimes(1);
});
