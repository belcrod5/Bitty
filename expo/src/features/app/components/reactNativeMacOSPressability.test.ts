jest.mock("react-native-macos/Libraries/Utilities/Platform", () => ({
  __esModule: true,
  default: { OS: "macos" },
}));
jest.mock("react-native-macos/Libraries/Utilities/Platform.ios", () => ({
  __esModule: true,
  default: { OS: "macos" },
}));
jest.mock("react-native-macos/Libraries/ReactNative/UIManager", () => ({
  __esModule: true,
  default: {
    measure: (_target: number, callback: (...values: number[]) => void) => callback(0, 0, 100, 100, 0, 0),
  },
}));
jest.mock("react-native-macos/Libraries/ReactNative/ReactNativeFeatureFlags", () => ({
  __esModule: true,
  default: { shouldPressibilityUseW3CPointerEventsForHover: () => false },
}));
jest.mock("react-native-macos/Libraries/Components/Sound/SoundManager", () => ({
  __esModule: true,
  default: { playTouchSound: jest.fn() },
}));

const Pressability = require("react-native-macos/Libraries/Pressability/Pressability").default;
const ReactNativeMacOSPlatform = require("react-native-macos/Libraries/Utilities/Platform").default;
const ReactNativeMacOSPlatformIOS = require("react-native-macos/Libraries/Utilities/Platform.ios").default;

afterEach(() => {
  ReactNativeMacOSPlatform.OS = "macos";
  ReactNativeMacOSPlatformIOS.OS = "macos";
});

function mouseEvent(
  button: number,
  target = 1,
  pointerType?: "mouse" | "touch" | "pen"
) {
  const touch = { button, pageX: 10, pageY: 10 };
  return {
    currentTarget: 1,
    target,
    persist: jest.fn(),
    stopPropagation: jest.fn(),
    nativeEvent: {
      ...(pointerType ? { pointerType } : {}),
      button,
      changedTouches: [touch],
      touches: [touch],
    },
  };
}

// FabricのマウスクリックはpayloadにおいてもpointerTypeを持ち、onPressは
// responder経路(touchStart/End)が一度だけ発火する。onClickがpointerイベントに
// 反応すると二重発火する(実測済み)ため、onClickは常に無視するのが正しい。
test.each([2, 1])("react-native-macos leaves a Fabric mouse click on target %s to the responder path", (target) => {
  const onPress = jest.fn();
  const pressability = new Pressability({ onPress });
  const event = mouseEvent(0, target, "mouse");

  pressability.getEventHandlers().onClick(event);

  expect(onPress).not.toHaveBeenCalled();
  expect(event.stopPropagation).not.toHaveBeenCalled();
  pressability.reset();
});

test("react-native-macos keeps other platforms' pointer-click guard unchanged", () => {
  ReactNativeMacOSPlatform.OS = "ios";
  ReactNativeMacOSPlatformIOS.OS = "ios";
  const onPress = jest.fn();
  const pressability = new Pressability({ onPress });
  const event = mouseEvent(0, 1, "mouse");

  pressability.getEventHandlers().onClick(event);

  expect(onPress).not.toHaveBeenCalled();
  expect(event.stopPropagation).not.toHaveBeenCalled();
  pressability.reset();
});

test.each([1, 2])("react-native-macos ignores button %s Fabric mouse clicks", (button) => {
  const onPress = jest.fn();
  const pressability = new Pressability({ onPress });
  const event = mouseEvent(button, 1, "mouse");

  pressability.getEventHandlers().onClick(event);

  expect(onPress).not.toHaveBeenCalled();
  expect(event.stopPropagation).not.toHaveBeenCalled();
  pressability.reset();
});

test.each(["touch", "pen"] as const)("react-native-macos ignores a child %s pointer click", (pointerType) => {
  const onPress = jest.fn();
  const pressability = new Pressability({ onPress });
  const event = mouseEvent(0, 1, pointerType);

  pressability.getEventHandlers().onClick(event);

  expect(onPress).not.toHaveBeenCalled();
  expect(event.stopPropagation).not.toHaveBeenCalled();
  pressability.reset();
});

test.each([
  ["disabled", { disabled: true, onPress: jest.fn() }],
  ["without an onPress handler", {}],
])("react-native-macos ignores primary Fabric mouse clicks at a pressable that is %s", (_label, config) => {
  const pressability = new Pressability(config);
  const event = mouseEvent(0, 1, "mouse");

  pressability.getEventHandlers().onClick(event);

  expect(event.stopPropagation).not.toHaveBeenCalled();
  if ("onPress" in config) expect(config.onPress).not.toHaveBeenCalled();
  pressability.reset();
});

test("react-native-macos ignores nested Fabric mouse clicks everywhere (responder path owns them)", () => {
  const childOnPress = jest.fn();
  const parentOnPress = jest.fn();
  const childPressability = new Pressability({ onPress: childOnPress });
  const parentPressability = new Pressability({ onPress: parentOnPress });
  let stopped = false;
  const event = {
    ...mouseEvent(0, 1, "mouse"),
    stopPropagation: jest.fn(() => { stopped = true; }),
  };

  childPressability.getEventHandlers().onClick(event);
  if (!stopped) parentPressability.getEventHandlers().onClick(event);

  expect(event.stopPropagation).not.toHaveBeenCalled();
  expect(childOnPress).not.toHaveBeenCalled();
  expect(parentOnPress).not.toHaveBeenCalled();
  childPressability.reset();
  parentPressability.reset();
});

test("react-native-macos keeps non-pointer child clicks behind the nested-pressable guard", () => {
  const onPress = jest.fn();
  const pressability = new Pressability({ onPress });
  const event = mouseEvent(0, 2);

  pressability.getEventHandlers().onClick(event);

  expect(onPress).not.toHaveBeenCalled();
  expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  pressability.reset();
});

test("react-native-macos preserves direct non-pointer click handling", () => {
  const onPress = jest.fn();
  const pressability = new Pressability({ onPress });
  const event = mouseEvent(0);

  pressability.getEventHandlers().onClick(event);

  expect(onPress).toHaveBeenCalledTimes(1);
  expect(event.stopPropagation).not.toHaveBeenCalled();
  pressability.reset();
});

test("react-native-macos maps a secondary click to an immediate long press", () => {
  jest.useFakeTimers();
  const onLongPress = jest.fn();
  const onPress = jest.fn();
  const onPressIn = jest.fn();
  const onPressOut = jest.fn();
  const pressability = new Pressability({
    delayPressIn: 1_000,
    delayLongPress: 1_000,
    onLongPress,
    onPress,
    onPressIn,
    onPressOut,
  });
  const handlers = pressability.getEventHandlers();
  const event = mouseEvent(2);

  handlers.onResponderGrant(event);

  expect(onLongPress).toHaveBeenCalledTimes(1);
  expect(onPress).not.toHaveBeenCalled();
  expect(onPressIn).not.toHaveBeenCalled();
  expect(onPressOut).not.toHaveBeenCalled();

  handlers.onResponderRelease(event);
  jest.runAllTimers();
  expect(onLongPress).toHaveBeenCalledTimes(1);
  expect(onPress).not.toHaveBeenCalled();
  expect(onPressIn).not.toHaveBeenCalled();
  expect(onPressOut).not.toHaveBeenCalled();
  pressability.reset();
  jest.useRealTimers();
});

test("react-native-macos preserves the primary-button long-press delay", () => {
  jest.useFakeTimers();
  const onLongPress = jest.fn();
  const pressability = new Pressability({ delayLongPress: 500, onLongPress });
  const handlers = pressability.getEventHandlers();
  const event = mouseEvent(0);

  handlers.onResponderGrant(event);
  expect(onLongPress).not.toHaveBeenCalled();

  jest.advanceTimersByTime(499);
  expect(onLongPress).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(onLongPress).toHaveBeenCalledTimes(1);

  handlers.onResponderRelease(event);
  pressability.reset();
  jest.useRealTimers();
});
